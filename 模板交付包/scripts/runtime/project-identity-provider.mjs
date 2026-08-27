import crypto from 'node:crypto';
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
      const record = {
        beyondProjectId: facts.id || null,
        codexProjectId: facts.codex_project_id || null,
        path: facts.path || null,
        hostId: facts.host_id || null,
        remote: normalizeRemote(facts.remote),
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
      issues: safeSnapshot.registrationIssues,
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
      result: decision,
    });
    return {
      ...decision,
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
  insideOrEqual,
  normalizeRemote,
  parseFrontmatter,
  samePath,
};
