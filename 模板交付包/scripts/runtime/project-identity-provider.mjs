import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function canonicalPath(value) {
  if (!value) return null;
  const absolute = path.resolve(String(value));
  try { return fs.realpathSync.native(absolute); } catch { return absolute; }
}

function pathKey(value) {
  const canonical = canonicalPath(value);
  if (!canonical) return null;
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function samePath(left, right) {
  return Boolean(left && right && pathKey(left) === pathKey(right));
}

function insideOrEqual(parent, child) {
  if (!parent || !child) return false;
  if (samePath(parent, child)) return true;
  const nested = path.relative(canonicalPath(parent), canonicalPath(child));
  return Boolean(nested) && nested !== '..' && !nested.startsWith(`..${path.sep}`) && !path.isAbsolute(nested);
}

function normalizeRemote(value) {
  let remote = String(value ?? '').trim();
  if (!remote) return null;
  remote = remote.replace(/^([^@\s]+)@([^:\s]+):(.+)$/, 'https://$2/$3');
  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    if (['ssh:', 'git:'].includes(url.protocol)) url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase();
    remote = url.toString();
  } catch {
    // Local and provider-specific remote spellings are compared as normalized opaque values.
  }
  return remote.replace(/\.git\/?$/i, '').replace(/\/$/, '').toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
}

function allowedActions(status) {
  return {
    verified: {
      createWorker: true, resumeWorker: true, controlWrite: true,
      safeDirectWork: true, unrelatedWork: true, unrelatedReadOnly: true,
    },
    degraded: {
      createWorker: false, resumeWorker: false, controlWrite: false,
      safeDirectWork: true, unrelatedWork: true, unrelatedReadOnly: true,
    },
    conflict: {
      createWorker: false, resumeWorker: false, controlWrite: false,
      safeDirectWork: false, unrelatedWork: true, unrelatedReadOnly: true,
    },
    unavailable: {
      createWorker: false, resumeWorker: false, controlWrite: false,
      safeDirectWork: false, unrelatedWork: true, unrelatedReadOnly: true,
    },
  }[status];
}

function result(status, reasons, normalized, identities = {}) {
  return {
    status,
    reasons: unique(reasons),
    identities: {
      beyondProjectId: identities.beyondProjectId ?? null,
      codexProjectId: identities.codexProjectId ?? null,
    },
    normalized,
    allowed: allowedActions(status),
  };
}

export function evaluateProjectIdentity(snapshot) {
  const reasons = [];
  const cwd = canonicalPath(snapshot.cwd);
  const projectRoot = canonicalPath(snapshot.projectRoot ?? snapshot.cwd);
  const hostId = String(snapshot.hostId ?? '').trim() || null;
  const remote = normalizeRemote(snapshot.repository?.remote);
  const normalized = { cwd, projectRoot, hostId, remote };

  if (!cwd || !projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return result('unavailable', ['project_root_unavailable'], normalized);
  }
  if (!insideOrEqual(projectRoot, cwd)) return result('conflict', ['cwd_outside_project_root'], normalized);
  if (!hostId) return result('unavailable', ['host_id_unavailable'], normalized);

  const platform = snapshot.platform;
  const platformAvailable = Array.isArray(platform?.projects) && platform.available !== false;
  const platformProjects = platformAvailable ? platform.projects : [];
  const atPath = platformProjects.filter((item) => samePath(item.path, projectRoot));
  const currentPlatform = atPath.filter((item) => !item.hostId || item.hostId === hostId);
  const otherHostPlatform = atPath.filter((item) => item.hostId && item.hostId !== hostId);
  if (currentPlatform.length > 1) reasons.push('multiple_platform_projects_for_path');
  if (currentPlatform.length === 0 && otherHostPlatform.length > 0) reasons.push('platform_host_mismatch');

  const selectedId = platform?.selectedProjectId ?? null;
  const selected = selectedId ? platformProjects.find((item) => item.projectId === selectedId) : null;
  if (selectedId && !selected) reasons.push('selected_platform_project_missing');
  if (selected && (!samePath(selected.path, projectRoot) || selected.hostId && selected.hostId !== hostId)) {
    reasons.push('selected_platform_project_conflict');
  }

  const localMappings = Array.isArray(snapshot.localMappings) ? snapshot.localMappings : [];
  const localAtPath = localMappings.filter((item) => samePath(item.path, projectRoot));
  const currentLocal = localAtPath.filter((item) => !item.hostId || item.hostId === hostId);
  const otherHostLocal = localAtPath.filter((item) => item.hostId && item.hostId !== hostId);
  if (currentLocal.length === 0 && otherHostLocal.length > 0) reasons.push('local_mapping_host_mismatch');
  const localBeyondIds = unique(currentLocal.map((item) => item.beyondProjectId));
  const localCodexIds = unique(currentLocal.map((item) => item.codexProjectId));
  if (currentLocal.length > 1) reasons.push('duplicate_local_registration_for_path');
  if (localBeyondIds.length > 1) reasons.push('multiple_beyond_ids_for_local_path');
  if (localCodexIds.length > 1) reasons.push('multiple_codex_ids_for_local_path');
  const currentHostLocalForProject = localMappings.filter((item) => (!item.hostId || item.hostId === hostId)
    && localBeyondIds.length === 1 && item.beyondProjectId === localBeyondIds[0]);
  if (currentHostLocalForProject.length > 1) reasons.push('duplicate_local_registration_for_project');

  const routes = Array.isArray(snapshot.hostRoutes) ? snapshot.hostRoutes : [];
  const routeAtPath = routes.filter((item) => samePath(item.path, projectRoot));
  const currentRoutes = routeAtPath.filter((item) => !item.hostId || item.hostId === hostId);
  const otherHostRoutes = routeAtPath.filter((item) => item.hostId && item.hostId !== hostId);
  if (currentRoutes.length === 0 && otherHostRoutes.length > 0) reasons.push('host_route_host_mismatch');
  const routeBeyondIds = unique(currentRoutes.map((item) => item.beyondProjectId));
  const routeCodexIds = unique(currentRoutes.map((item) => item.codexProjectId));
  if (currentRoutes.length > 1) reasons.push('multiple_host_routes_for_path');
  if (routeBeyondIds.length > 1) reasons.push('multiple_beyond_ids_for_host_route');
  if (routeCodexIds.length > 1) reasons.push('multiple_codex_ids_for_host_route');

  const registrations = Array.isArray(snapshot.sharedRegistrations) ? snapshot.sharedRegistrations : [];
  const remoteRegistrations = remote
    ? registrations.filter((item) => normalizeRemote(item.remote) === remote)
    : [];
  const remoteBeyondIds = unique(remoteRegistrations.map((item) => item.beyondProjectId));
  if (remoteBeyondIds.length > 1) reasons.push('multiple_beyond_ids_for_remote');

  const localBeyondId = localBeyondIds[0] ?? null;
  const routeBeyondId = routeBeyondIds[0] ?? null;
  const platformProjectId = currentPlatform[0]?.projectId ?? null;
  if (currentPlatform.length === 1 && !platformProjectId) reasons.push('platform_project_id_missing');
  const registeredForLocal = localBeyondId
    ? registrations.filter((item) => item.beyondProjectId === localBeyondId)
    : [];
  if (localBeyondId && registeredForLocal.length > 1) reasons.push('duplicate_shared_registration');
  if (localBeyondId && remote && registeredForLocal.length === 1 && registeredForLocal[0].remote
    && normalizeRemote(registeredForLocal[0].remote) !== remote) {
    reasons.push('local_and_shared_remote_conflict');
  }
  const sharedBeyondId = remote
    ? remoteBeyondIds[0] ?? null
    : (registeredForLocal.length === 1 ? registeredForLocal[0].beyondProjectId : null);

  if (localBeyondId && sharedBeyondId && localBeyondId !== sharedBeyondId) {
    reasons.push('local_and_shared_project_conflict');
  }
  if (routeBeyondId && unique([localBeyondId, sharedBeyondId]).some((item) => item !== routeBeyondId)) {
    reasons.push('host_route_project_conflict');
  }
  if (platformProjectId && localCodexIds[0] && platformProjectId !== localCodexIds[0]) {
    reasons.push('platform_and_local_codex_id_conflict');
  }
  if (platformProjectId && routeCodexIds[0] && platformProjectId !== routeCodexIds[0]) {
    reasons.push('platform_and_host_route_codex_id_conflict');
  }

  for (const issue of snapshot.registrationIssues ?? []) {
    if (issue.kind === 'local' && samePath(issue.path, projectRoot)) reasons.push('invalid_local_registration_for_path');
  }

  const conflictReasons = reasons.filter((reason) => (
    reason.includes('conflict') || reason.includes('mismatch') || reason.startsWith('multiple_')
    || reason.startsWith('duplicate_') || reason === 'invalid_local_registration_for_path'
    || reason === 'selected_platform_project_missing'
  ));
  const identities = {
    beyondProjectId: localBeyondId ?? sharedBeyondId ?? routeBeyondId,
    codexProjectId: platformProjectId ?? localCodexIds[0] ?? routeCodexIds[0] ?? null,
  };
  if (conflictReasons.length > 0) return result('conflict', reasons, normalized, identities);

  const platformConfirmed = platformAvailable && currentPlatform.length === 1 && Boolean(platformProjectId);
  const localConfirmed = localBeyondIds.length === 1;
  const sharedConfirmed = Boolean(sharedBeyondId && sharedBeyondId === localBeyondId);
  const routeConfirmed = currentRoutes.length === 1 && routeBeyondId === localBeyondId
    && (!platformProjectId || !routeCodexIds[0] || routeCodexIds[0] === platformProjectId);
  const codexMappingConsistent = localCodexIds.length === 0 || localCodexIds[0] === platformProjectId;
  if (platformConfirmed && localConfirmed && sharedConfirmed && routeConfirmed && codexMappingConsistent) {
    return result('verified', ['all_identity_sources_agree'], normalized, identities);
  }

  const trusted = snapshot.projectEntryTrusted === true;
  if (localConfirmed || sharedBeyondId || routeBeyondId || trusted || platformConfirmed) {
    if (!platformAvailable) reasons.push('platform_interface_unavailable');
    else if (!platformConfirmed) reasons.push('platform_registration_missing');
    if (!localConfirmed) reasons.push('local_mapping_missing');
    if (!sharedConfirmed) reasons.push('shared_registration_missing');
    if (!routeConfirmed) reasons.push('host_route_missing');
    return result('degraded', reasons, normalized, identities);
  }
  return result('unavailable', ['insufficient_identity_sources'], normalized, identities);
}

function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return {};
  const values = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

function parseRepositories(value, fallbackPath, fallbackRemote = null) {
  if (value === undefined || value === null) {
    return fallbackPath ? [{ path: canonicalPath(fallbackPath), remote: normalizeRemote(fallbackRemote), role: 'project-root' }] : [];
  }
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('repositories_json must be a JSON array'); }
  if (!Array.isArray(parsed)) throw new Error('repositories_json must be a JSON array');
  const repositories = parsed.map((item) => {
    if (typeof item === 'string' && item.trim()) {
      const repositoryPath = canonicalPath(item);
      const role = samePath(repositoryPath, fallbackPath) ? 'project-root' : 'component';
      return { path: repositoryPath, remote: null, role, kind: role === 'component' ? 'git' : null };
    }
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.path !== 'string' || !item.path.trim()) {
      throw new Error('repositories_json entries require a path');
    }
    const repositoryPath = canonicalPath(item.path);
    const role = samePath(repositoryPath, fallbackPath) ? 'project-root' : 'component';
    if (item.role !== undefined && !['project-root', 'component'].includes(item.role)) {
      throw new Error('repositories_json entry role must be project-root or component');
    }
    if (item.role !== undefined && item.role !== role) throw new Error('repositories_json entry role does not match its path');
    if (item.kind !== undefined && item.kind !== 'git') throw new Error('repositories_json entry kind must be git');
    return {
      path: repositoryPath,
      remote: normalizeRemote(item.remote),
      role,
      kind: item.kind === 'git' || role === 'component' ? 'git' : null,
    };
  });
  const paths = repositories.map((item) => pathKey(item.path));
  if (new Set(paths).size !== paths.length) throw new Error('repositories_json contains duplicate paths');
  return repositories;
}

function runGit(repositoryRoot, args) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

function gitRepositoryFacts(repositoryRoot) {
  const topLevel = runGit(repositoryRoot, ['rev-parse', '--show-toplevel']);
  const commonDirectory = runGit(repositoryRoot, ['rev-parse', '--git-common-dir']);
  if (topLevel.status !== 0 || commonDirectory.status !== 0) return null;
  const common = path.isAbsolute(commonDirectory.stdout)
    ? commonDirectory.stdout
    : path.resolve(repositoryRoot, commonDirectory.stdout);
  return {
    topLevel: canonicalPath(topLevel.stdout),
    commonDirectory: canonicalPath(common),
    remote: normalizeRemote(runGit(repositoryRoot, ['remote', 'get-url', 'origin']).stdout),
  };
}

function registeredWorktrees(repositoryRoot) {
  const result = runGit(repositoryRoot, ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => canonicalPath(line.slice('worktree '.length).trim()));
}

function markerValues(text, name) {
  const expression = new RegExp(`<!-- ${name}: ([^\\n]+) -->`, 'g');
  return [...text.matchAll(expression)].map((match) => match[1].trim());
}

function readRegistrationDirectory(directory, kind) {
  const records = [];
  const issues = [];
  if (!fs.existsSync(directory)) return { records, issues, filesRead: 0 };
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    const facts = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (kind === 'local') {
      let repositories = [];
      try { repositories = parseRepositories(facts.repositories_json ?? facts.repository_roots_json, facts.path, facts.remote); }
      catch (error) {
        issues.push({ kind, file, path: facts.path || null, reason: `invalid_repositories:${error.message}` });
      }
      const record = {
        beyondProjectId: facts.id || null,
        codexProjectId: facts.codex_project_id || null,
        path: facts.path || null,
        hostId: facts.host_id || null,
        remote: normalizeRemote(facts.remote),
        repositories,
        repositoryRoots: repositories.map((item) => item.path),
        sourceFile: file,
      };
      if (!record.beyondProjectId || !record.path) {
        issues.push({ kind, file, path: record.path, reason: 'missing_id_or_path' });
      } else records.push(record);
    } else {
      const record = {
        beyondProjectId: facts.id || null,
        remote: normalizeRemote(facts.remote),
        sourceFile: file,
      };
      if (!record.beyondProjectId) issues.push({ kind, file, path: null, reason: 'missing_id' });
      else records.push(record);
    }
  }
  return { records, issues, filesRead: entries.length };
}

function sanitizedProject(project) {
  return {
    projectId: project.projectId ?? null,
    name: project.name ?? null,
    path: canonicalPath(project.path),
    hostId: project.hostId ?? null,
  };
}

function safeWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(temporary, file); break; }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code) || attempt >= 49) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function readHostRoutes(input) {
  if (Array.isArray(input.hostRoutes)) {
    return { records: input.hostRoutes, issues: [], filesRead: 0, source: 'provided-snapshot' };
  }
  if (!input.hostRouteIndexFile) return { records: [], issues: [], filesRead: 0, source: 'missing' };
  const file = path.resolve(input.hostRouteIndexFile);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const records = Array.isArray(parsed.projects) ? parsed.projects : (Array.isArray(parsed.routes) ? parsed.routes : null);
    if (!records) throw new Error('projects or routes array missing');
    return { records, issues: [], filesRead: 1, source: 'host-index' };
  } catch (error) {
    return {
      records: [], filesRead: fs.existsSync(file) ? 1 : 0, source: 'host-index',
      issues: [{ kind: 'host-route', file, path: null, reason: `unreadable_index:${error.message}` }],
    };
  }
}

export class ProjectIdentityProvider {
  constructor({ controlRoot, runtimeRoot }) {
    this.controlRoot = path.resolve(controlRoot);
    this.runtimeRoot = path.resolve(runtimeRoot ?? path.join(controlRoot, 'local', 'runtime', 'project-identity'));
  }

  registrations() {
    return {
      local: readRegistrationDirectory(path.join(this.controlRoot, 'local', 'projects'), 'local'),
      shared: readRegistrationDirectory(path.join(this.controlRoot, 'shared', 'projects'), 'shared'),
    };
  }

  requireRegisteredProject(projectId) {
    const normalized = typeof projectId === 'string' ? projectId.trim() : '';
    if (!normalized) throw new Error('projectId is required');
    const { local, shared } = this.registrations();
    const localRegistered = local.records.some((item) => item.beyondProjectId === normalized);
    const sharedRegistered = shared.records.some((item) => item.beyondProjectId === normalized);
    if (!localRegistered && !sharedRegistered) {
      throw new Error(`projectId is not registered in this control root: ${normalized}`);
    }
    return { projectId: normalized, localRegistered, sharedRegistered };
  }

  localProjectRecord(projectId) {
    const registration = this.requireRegisteredProject(projectId);
    if (!registration.localRegistered) throw new Error('Worker result write requires a local project registration');
    const { local } = this.registrations();
    const matches = local.records.filter((item) => item.beyondProjectId === registration.projectId);
    if (matches.length !== 1) throw new Error('Worker result write requires exactly one local project registration');
    const record = matches[0];
    const pathMatches = local.records.filter((item) => samePath(item.path, record.path));
    if (pathMatches.length !== 1) throw new Error('Worker result write requires one project id for the canonical local path');
    if (local.issues.some((issue) => samePath(issue.path, record.path))) {
      throw new Error('local project registration is invalid');
    }
    return record;
  }

  validateCanonicalBinding(record, projectId) {
    const canonicalProjectRoot = canonicalPath(record.path);
    const agentsPath = path.join(canonicalProjectRoot, 'AGENTS.md');
    if (!fs.existsSync(agentsPath) || !fs.statSync(agentsPath).isFile()) {
      throw new Error('canonical project AGENTS.md is missing');
    }
    const agents = fs.readFileSync(agentsPath, 'utf8').replace(/\r\n/g, '\n');
    const controlMarkers = markerValues(agents, 'BEYOND-CONTROL-ROOT');
    const projectMarkers = markerValues(agents, 'BEYOND-PROJECT-ID');
    if (controlMarkers.length !== 1 || projectMarkers.length !== 1) {
      throw new Error('canonical project markers must be unique');
    }
    const mappedControlRoot = canonicalPath(path.resolve(canonicalProjectRoot, controlMarkers[0]));
    if (!samePath(mappedControlRoot, this.controlRoot)) throw new Error('canonical project AGENTS controlRoot mismatch');
    if (projectMarkers[0] !== projectId) throw new Error('canonical project AGENTS projectId mismatch');
    return { canonicalProjectRoot, agentsPath };
  }

  validateControlProject(projectId) {
    const record = this.localProjectRecord(projectId);
    this.validateCanonicalBinding(record, record.beyondProjectId);
    return record;
  }

  validateRegisteredRepository(record, repositoryRoot) {
    const registeredRepository = record.repositories.find((candidate) => samePath(candidate.path, repositoryRoot));
    if (!registeredRepository) throw new Error('projectRoute repositoryRoot is not registered for this project');
    const repositoryFacts = gitRepositoryFacts(repositoryRoot);
    const requiresGit = registeredRepository.kind === 'git' || registeredRepository.role === 'component'
      || Boolean(registeredRepository.remote);
    if (requiresGit && (!repositoryFacts || !samePath(repositoryFacts.topLevel, repositoryRoot))) {
      throw new Error('projectRoute repositoryRoot is not an exact Git repository root');
    }
    if (registeredRepository.remote && repositoryFacts?.remote !== registeredRepository.remote) {
      throw new Error('projectRoute repository remote does not match registration');
    }
    return { registeredRepository, repositoryFacts };
  }

  validateSameRootProject(projectId, context = {}) {
    const record = this.localProjectRecord(projectId);
    const binding = this.validateCanonicalBinding(record, record.beyondProjectId);
    const executionRoot = canonicalPath(context.executionRoot);
    if (!executionRoot || !samePath(executionRoot, binding.canonicalProjectRoot)) {
      throw new Error('Worker result write outside canonical project root requires projectRoute');
    }
    const canonicalRepository = gitRepositoryFacts(binding.canonicalProjectRoot);
    if (canonicalRepository && samePath(canonicalRepository.topLevel, binding.canonicalProjectRoot)) {
      try { this.validateRegisteredRepository(record, binding.canonicalProjectRoot); }
      catch (error) { throw new Error(`canonical Git project root is not an allowed execution repository: ${error.message}`); }
    }
    return {
      projectId: record.beyondProjectId,
      canonicalProjectRoot: binding.canonicalProjectRoot,
      controlRoot: canonicalPath(this.controlRoot),
      executionRoot,
      relation: 'same-root',
    };
  }

  validateWorkerRoute(projectId, rawRoute, context = {}) {
    if (!rawRoute || typeof rawRoute !== 'object' || Array.isArray(rawRoute)) {
      throw new Error('projectRoute must be an object');
    }
    const record = this.localProjectRecord(projectId);
    const registration = { projectId: record.beyondProjectId };
    const routeProjectId = String(rawRoute.projectId ?? '').trim();
    if (routeProjectId !== registration.projectId) throw new Error('projectRoute projectId mismatch');
    const canonicalProjectRoot = canonicalPath(rawRoute.canonicalProjectRoot);
    const controlRoot = canonicalPath(rawRoute.controlRoot);
    const repositoryRoot = canonicalPath(rawRoute.repositoryRoot);
    const executionRoot = canonicalPath(rawRoute.executionRoot);
    if (!canonicalProjectRoot || !controlRoot || !repositoryRoot || !executionRoot) {
      throw new Error('projectRoute requires canonicalProjectRoot, controlRoot, repositoryRoot and executionRoot');
    }
    for (const [label, value] of [
      ['canonicalProjectRoot', canonicalProjectRoot], ['controlRoot', controlRoot],
      ['repositoryRoot', repositoryRoot], ['executionRoot', executionRoot],
    ]) {
      if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) throw new Error(`projectRoute ${label} is not a directory`);
    }
    if (!samePath(canonicalProjectRoot, record.path)) throw new Error('projectRoute canonicalProjectRoot mismatch');
    if (!samePath(controlRoot, this.controlRoot)) throw new Error('projectRoute controlRoot mismatch');
    const hostId = String(rawRoute.hostId ?? '').trim();
    const codexProjectId = String(rawRoute.codexProjectId ?? '').trim();
    if (!hostId || !codexProjectId) throw new Error('projectRoute requires hostId and codexProjectId');
    if (!record.hostId || hostId !== record.hostId) throw new Error('projectRoute hostId mismatch');
    if (!record.codexProjectId || codexProjectId !== record.codexProjectId) throw new Error('projectRoute codexProjectId mismatch');

    try { this.validateCanonicalBinding(record, registration.projectId); }
    catch (error) { throw new Error(`projectRoute ${error.message}`); }

    const repositoryValidation = this.validateRegisteredRepository(record, repositoryRoot);
    const callerRoot = canonicalPath(context.executionRoot);
    if (!callerRoot || !samePath(callerRoot, executionRoot)) {
      throw new Error('projectRoute executionRoot does not match runtime working directory');
    }

    let relation = 'canonical';
    if (!samePath(executionRoot, repositoryRoot)) {
      const canonicalRepository = repositoryValidation.repositoryFacts;
      const executionRepository = gitRepositoryFacts(executionRoot);
      if (!canonicalRepository || !executionRepository
        || !samePath(canonicalRepository.topLevel, repositoryRoot)
        || !samePath(executionRepository.topLevel, executionRoot)
        || !samePath(canonicalRepository.commonDirectory, executionRepository.commonDirectory)
        || !registeredWorktrees(repositoryRoot).some((candidate) => samePath(candidate, executionRoot))) {
        throw new Error('projectRoute executionRoot is not a registered worktree of repositoryRoot');
      }
      relation = 'worktree';
    }
    return {
      projectId: registration.projectId,
      canonicalProjectRoot,
      controlRoot,
      repositoryRoot,
      executionRoot,
      hostId,
      codexProjectId,
      relation,
    };
  }

  resolve(input) {
    const { local, shared } = this.registrations();
    const hostRoutes = readHostRoutes(input);
    const registrationIssues = [...local.issues, ...shared.issues, ...hostRoutes.issues];
    const decisionInput = {
      ...input,
      localMappings: local.records,
      sharedRegistrations: shared.records,
      hostRoutes: hostRoutes.records,
      registrationIssues,
    };
    const decision = evaluateProjectIdentity(decisionInput);
    const matchingLocal = local.records.filter((item) => item.beyondProjectId === decision.identities.beyondProjectId
      && samePath(item.path, decision.normalized.projectRoot)
      && (!item.hostId || item.hostId === decision.normalized.hostId));
    const requestedRepositoryRoot = canonicalPath(input.repositoryRoot ?? decision.normalized.projectRoot);
    const allowedRepositoryRoots = matchingLocal.length === 1
      ? unique(matchingLocal[0].repositoryRoots.map(canonicalPath))
      : [];
    const routingIssues = [];
    if (decision.status === 'verified' && matchingLocal.length === 1) {
      try { this.validateCanonicalBinding(matchingLocal[0], decision.identities.beyondProjectId); }
      catch (error) { routingIssues.push({ reason: 'canonical_project_binding_invalid', detail: error.message }); }
      if (allowedRepositoryRoots.some((candidate) => samePath(candidate, requestedRepositoryRoot))) {
        try { this.validateRegisteredRepository(matchingLocal[0], requestedRepositoryRoot); }
        catch (error) { routingIssues.push({ reason: 'registered_repository_invalid', detail: error.message }); }
      }
    }
    const effectiveDecision = routingIssues.length > 0
      ? result('conflict', [...decision.reasons, ...routingIssues.map((issue) => issue.reason)], decision.normalized, decision.identities)
      : decision;
    const safeSnapshot = {
      cwd: decision.normalized.cwd,
      projectRoot: decision.normalized.projectRoot,
      hostId: decision.normalized.hostId,
      repository: { remote: decision.normalized.remote },
      projectEntryTrusted: input.projectEntryTrusted === true,
      platform: {
        available: Array.isArray(input.platform?.projects) && input.platform.available !== false,
        selectedProjectId: input.platform?.selectedProjectId ?? null,
        projects: Array.isArray(input.platform?.projects) ? input.platform.projects.map(sanitizedProject) : [],
      },
      localMappings: local.records.map((item) => ({
        beyondProjectId: item.beyondProjectId, codexProjectId: item.codexProjectId,
        path: canonicalPath(item.path), hostId: item.hostId, remote: item.remote,
      })),
      sharedRegistrations: shared.records.map((item) => ({
        beyondProjectId: item.beyondProjectId, remote: item.remote,
      })),
      hostRoutes: hostRoutes.records.map((item) => ({
        beyondProjectId: item.beyondProjectId ?? null, codexProjectId: item.codexProjectId ?? null,
        path: canonicalPath(item.path), hostId: item.hostId ?? null,
      })),
      registrationIssues: registrationIssues.map((issue) => ({
        kind: issue.kind, file: path.basename(issue.file), path: canonicalPath(issue.path), reason: issue.reason,
      })),
    };
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(safeSnapshot)).digest('hex');
    const cacheKey = crypto.createHash('sha256')
      .update(`${decision.normalized.hostId ?? 'no-host'}:${decision.normalized.projectRoot ?? 'no-project'}`)
      .digest('hex').slice(0, 20);
    const cacheFile = path.join(this.runtimeRoot, `resolution-${cacheKey}.json`);
    const evidence = {
      fingerprint,
      issues: [...safeSnapshot.registrationIssues, ...routingIssues],
      resolvedAt: new Date().toISOString(),
    };
    safeWriteJson(cacheFile, {
      schemaVersion: 1,
      derived: true,
      sourceOfTruth: false,
      evidence,
      sourceCounts: {
        localMappings: local.records.length,
        sharedRegistrations: shared.records.length,
        localFilesRead: local.filesRead,
        sharedFilesRead: shared.filesRead,
        hostRouteFilesRead: hostRoutes.filesRead,
      },
      snapshot: safeSnapshot,
      result: effectiveDecision,
    });
    const routeHostId = matchingLocal[0]?.hostId ?? null;
    const routeCodexProjectId = matchingLocal[0]?.codexProjectId ?? null;
    const projectRoute = effectiveDecision.status === 'verified' && matchingLocal.length === 1
      && routeHostId === effectiveDecision.normalized.hostId
      && routeCodexProjectId === effectiveDecision.identities.codexProjectId
      && allowedRepositoryRoots.some((candidate) => samePath(candidate, requestedRepositoryRoot))
      ? {
          projectId: effectiveDecision.identities.beyondProjectId,
          canonicalProjectRoot: canonicalPath(matchingLocal[0].path),
          controlRoot: canonicalPath(this.controlRoot),
          repositoryRoot: requestedRepositoryRoot,
          hostId: routeHostId,
          codexProjectId: routeCodexProjectId,
        }
      : null;
    return {
      ...effectiveDecision,
      projectRoute,
      registeredRepositoryRoots: allowedRepositoryRoots,
      evidence,
      sourceCounts: {
        localMappings: local.records.length,
        sharedRegistrations: shared.records.length,
        localFilesRead: local.filesRead,
        sharedFilesRead: shared.filesRead,
        hostRouteFilesRead: hostRoutes.filesRead,
      },
      cacheFile,
    };
  }
}

export const projectIdentityInternals = {
  canonicalPath,
  gitRepositoryFacts,
  insideOrEqual,
  normalizeRemote,
  parseFrontmatter,
  parseRepositories,
  registeredWorktrees,
  samePath,
};
