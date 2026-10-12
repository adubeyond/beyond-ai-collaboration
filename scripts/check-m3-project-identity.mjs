import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  evaluateProjectIdentity,
  ProjectIdentityProvider,
  projectIdentityInternals,
} from '../模板交付包/scripts/runtime/project-identity-provider.mjs';

function temporary(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `beyond-m3-identity-${name}-`));
}

function fixture(name = 'base') {
  const root = temporary(name);
  const projectRoot = path.join(root, 'project');
  const controlRoot = path.join(root, 'control');
  const runtimeRoot = path.join(controlRoot, 'local', 'runtime', 'project-identity');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(controlRoot, 'local', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(controlRoot, 'shared', 'projects'), { recursive: true });
  return { root, projectRoot, cwd: path.join(projectRoot, 'src'), controlRoot, runtimeRoot };
}

function snapshot(f, overrides = {}) {
  return {
    cwd: f.cwd,
    projectRoot: f.projectRoot,
    hostId: 'host-a',
    projectEntryTrusted: true,
    repository: { remote: 'git@example.test:team/app.git' },
    platform: {
      available: true,
      selectedProjectId: 'codex-1',
      projects: [{ projectId: 'codex-1', name: 'app', path: f.projectRoot, hostId: 'host-a' }],
    },
    localMappings: [{ beyondProjectId: 'project-1', codexProjectId: 'codex-1', path: f.projectRoot, hostId: 'host-a' }],
    sharedRegistrations: [{ beyondProjectId: 'project-1', remote: 'https://example.test/team/app' }],
    hostRoutes: [{ beyondProjectId: 'project-1', codexProjectId: 'codex-1', path: f.projectRoot, hostId: 'host-a' }],
    ...overrides,
  };
}

function writeRegistrations(f, options = {}) {
  const projectId = options.projectId ?? 'project-1';
  const localRemote = options.localRemote ?? 'git@example.test:team/app.git';
  if (options.git !== false) {
    const initialized = spawnSync('git', ['init'], { cwd: f.projectRoot, encoding: 'utf8', windowsHide: true });
    assert.equal(initialized.status, 0, initialized.stderr);
    const currentRemote = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: f.projectRoot, encoding: 'utf8', windowsHide: true,
    });
    if (currentRemote.status !== 0) {
      const added = spawnSync('git', ['remote', 'add', 'origin', localRemote], {
        cwd: f.projectRoot, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(added.status, 0, added.stderr);
    }
  }
  const repositories = options.repositoryRoots?.map((repositoryPath, index) => ({
    path: repositoryPath, remote: null, role: index === 0 ? 'project-root' : 'component',
  }));
  const local = [
    '---', `id: ${projectId}`, 'name: app', `path: ${f.projectRoot}`,
    `remote: ${localRemote}`,
    `host_id: ${options.hostId ?? 'host-a'}`, `codex_project_id: ${options.codexProjectId ?? 'codex-1'}`,
    ...(repositories ? [`repositories_json: ${JSON.stringify(repositories)}`] : []),
    '---', '', '# app 本机登记', '',
  ].join('\n');
  const shared = [
    '---', `id: ${projectId}`, 'name: app', `remote: ${options.sharedRemote ?? 'https://example.test/team/app'}`,
    '---', '', '# app', '',
  ].join('\n');
  fs.writeFileSync(path.join(f.controlRoot, 'local', 'projects', `${projectId}.md`), local, 'utf8');
  fs.writeFileSync(path.join(f.controlRoot, 'shared', 'projects', `${projectId}.md`), shared, 'utf8');
  fs.writeFileSync(path.join(f.projectRoot, 'AGENTS.md'), [
    '<!-- BEYOND-RUNTIME-VERSION: 3.2.5 -->',
    `<!-- BEYOND-CONTROL-ROOT: ${path.relative(f.projectRoot, f.controlRoot).replaceAll('\\', '/')} -->`,
    `<!-- BEYOND-PROJECT-ID: ${projectId} -->`, '',
  ].join('\n'), 'utf8');
}

function assertIdentityStatus(result, status) {
  assert.equal(result.status, status, JSON.stringify({ reasons: result.reasons, evidence: result.evidence }, null, 2));
}

test('all project identity sources agreeing returns verified', () => {
  const f = fixture('verified');
  const result = evaluateProjectIdentity(snapshot(f));
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.identities, { beyondProjectId: 'project-1', codexProjectId: 'codex-1' });
  assert.equal(result.allowed.createWorker, true);
});

test('a filesystem junction is the same canonical project', () => {
  const f = fixture('alias');
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.projectRoot, alias, 'junction');
  const input = snapshot(f, { cwd: path.join(alias, 'src') });
  input.platform.projects[0].path = alias;
  input.localMappings[0].path = alias;
  input.hostRoutes[0].path = alias;
  assert.equal(evaluateProjectIdentity(input).status, 'verified');
});

test('another host may use another local path for the same shared project', () => {
  const f = fixture('second-host');
  const input = snapshot(f);
  input.localMappings.push({
    beyondProjectId: 'project-1', codexProjectId: 'codex-host-b',
    path: path.join(f.root, 'host-b-copy'), hostId: 'host-b',
  });
  input.hostRoutes.push({
    beyondProjectId: 'project-1', codexProjectId: 'codex-host-b',
    path: path.join(f.root, 'host-b-copy'), hostId: 'host-b',
  });
  assert.equal(evaluateProjectIdentity(input).status, 'verified');
});

test('other projects in the platform list do not contaminate the current identity', () => {
  const f = fixture('other-project');
  const other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  const input = snapshot(f);
  input.platform.projects.push({ projectId: 'codex-other', path: other, hostId: 'host-a' });
  assert.equal(evaluateProjectIdentity(input).status, 'verified');
});

test('raw Codex list_projects shape is accepted without an invented available field', () => {
  const f = fixture('raw-platform');
  const input = snapshot(f, { hostId: 'local' });
  input.platform = {
    schemaVersion: 2,
    projects: [{ projectId: 'codex-1', label: 'app', path: f.projectRoot, hostId: 'local', isGitRepository: true }],
  };
  input.localMappings[0].hostId = 'local';
  input.hostRoutes[0].hostId = 'local';
  assert.equal(evaluateProjectIdentity(input).status, 'verified');
});

test('platform interface loss degrades a trusted registered project without blocking safe direct work', () => {
  const f = fixture('platform-down');
  const result = evaluateProjectIdentity(snapshot(f, { platform: { available: false } }));
  assert.equal(result.status, 'degraded');
  assert.equal(result.allowed.safeDirectWork, true);
  assert.equal(result.allowed.createWorker, false);
  assert.ok(result.reasons.includes('platform_interface_unavailable'));
});

test('a platform record without project id is degraded', () => {
  const f = fixture('platform-null');
  const input = snapshot(f);
  input.platform.projects[0].projectId = null;
  input.platform.selectedProjectId = null;
  const result = evaluateProjectIdentity(input);
  assert.equal(result.status, 'degraded');
  assert.ok(result.reasons.includes('platform_project_id_missing'));
});

test('missing host route is degraded because terminal ownership is not yet routable', () => {
  const f = fixture('route-missing');
  const result = evaluateProjectIdentity(snapshot(f, { hostRoutes: [] }));
  assert.equal(result.status, 'degraded');
  assert.ok(result.reasons.includes('host_route_missing'));
});

test('a host route pointing at another Beyond project is conflict', () => {
  const f = fixture('route-conflict');
  const input = snapshot(f);
  input.hostRoutes[0].beyondProjectId = 'project-other';
  const result = evaluateProjectIdentity(input);
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('host_route_project_conflict'));
});

test('selected platform project pointing elsewhere is conflict', () => {
  const f = fixture('selected-conflict');
  const other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  const input = snapshot(f);
  input.platform.projects.push({ projectId: 'codex-other', path: other, hostId: 'host-a' });
  input.platform.selectedProjectId = 'codex-other';
  const result = evaluateProjectIdentity(input);
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('selected_platform_project_conflict'));
});

test('selected platform project missing from the returned list is conflict', () => {
  const f = fixture('selected-missing');
  const input = snapshot(f);
  input.platform.selectedProjectId = 'codex-missing';
  const result = evaluateProjectIdentity(input);
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('selected_platform_project_missing'));
});

test('duplicate platform projects for one path are conflict', () => {
  const f = fixture('duplicate-platform');
  const input = snapshot(f);
  input.platform.projects.push({ projectId: 'codex-2', path: f.projectRoot, hostId: 'host-a' });
  const result = evaluateProjectIdentity(input);
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('multiple_platform_projects_for_path'));
});

test('local and shared identities disagreeing is conflict', () => {
  const f = fixture('shared-conflict');
  const result = evaluateProjectIdentity(snapshot(f, {
    sharedRegistrations: [{ beyondProjectId: 'project-2', remote: 'https://example.test/team/app' }],
  }));
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('local_and_shared_project_conflict'));
});

test('duplicate local registration files for one path are conflict even when ids match', () => {
  const f = fixture('duplicate-local');
  const input = snapshot(f);
  input.localMappings.push({ ...input.localMappings[0] });
  const result = evaluateProjectIdentity(input);
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('duplicate_local_registration_for_path'));
});

test('the same project id registered twice on one host at different paths is conflict', () => {
  const f = fixture('duplicate-project-id');
  const other = path.join(f.root, 'other-project');
  fs.mkdirSync(other);
  const input = snapshot(f);
  input.localMappings.push({
    beyondProjectId: 'project-1', codexProjectId: 'codex-other', path: other, hostId: 'host-a',
  });
  const result = evaluateProjectIdentity(input);
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('duplicate_local_registration_for_project'));
});

test('local Codex mapping disagreeing with platform is conflict', () => {
  const f = fixture('codex-conflict');
  const input = snapshot(f);
  input.localMappings[0].codexProjectId = 'codex-stale';
  const result = evaluateProjectIdentity(input);
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('platform_and_local_codex_id_conflict'));
});

test('missing host identity is unavailable', () => {
  const f = fixture('host-missing');
  const result = evaluateProjectIdentity(snapshot(f, { hostId: null }));
  assert.equal(result.status, 'unavailable');
  assert.ok(result.reasons.includes('host_id_unavailable'));
});

test('cwd outside declared project root is conflict', () => {
  const f = fixture('cwd-outside');
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  const result = evaluateProjectIdentity(snapshot(f, { cwd: outside }));
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('cwd_outside_project_root'));
});

test('a bare directory without trusted identity evidence is unavailable', () => {
  const f = fixture('bare');
  const result = evaluateProjectIdentity({
    cwd: f.projectRoot, projectRoot: f.projectRoot, hostId: 'host-a', projectEntryTrusted: false,
    platform: { available: false }, localMappings: [], sharedRegistrations: [], hostRoutes: [],
  });
  assert.equal(result.status, 'unavailable');
  assert.ok(result.reasons.includes('insufficient_identity_sources'));
});

test('remote normalization removes credentials query fragments and transport spelling', () => {
  assert.equal(
    projectIdentityInternals.normalizeRemote('https://user:secret@EXAMPLE.test/team/app.git?token=x#frag'),
    'https://example.test/team/app',
  );
  assert.equal(projectIdentityInternals.normalizeRemote('git@EXAMPLE.test:team/app.git'), 'https://example.test/team/app');
});

test('provider reads existing Markdown registrations and writes only a derived cache', () => {
  const f = fixture('provider');
  writeRegistrations(f);
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve({
    cwd: f.cwd, projectRoot: f.projectRoot, hostId: 'host-a', projectEntryTrusted: true,
    repository: { remote: 'git@example.test:team/app.git' },
    platform: snapshot(f).platform,
    hostRoutes: snapshot(f).hostRoutes,
  });
  assertIdentityStatus(result, 'verified');
  assert.equal(result.sourceCounts.localMappings, 1);
  assert.equal(result.sourceCounts.sharedRegistrations, 1);
  assert.deepEqual(result.projectRoute, {
    projectId: 'project-1',
    canonicalProjectRoot: projectIdentityInternals.canonicalPath(f.projectRoot),
    controlRoot: projectIdentityInternals.canonicalPath(f.controlRoot),
    repositoryRoot: projectIdentityInternals.canonicalPath(f.projectRoot),
    executionRoot: projectIdentityInternals.canonicalPath(f.projectRoot),
    relation: 'canonical',
    hostId: 'host-a',
    codexProjectId: 'codex-1',
  });
  assert.deepEqual(result.registeredRepositoryRoots, [projectIdentityInternals.canonicalPath(f.projectRoot)]);
  assert.ok(fs.existsSync(result.cacheFile));
  const cached = JSON.parse(fs.readFileSync(result.cacheFile, 'utf8'));
  assert.equal(cached.derived, true);
  assert.equal(cached.result.status, 'verified');
  assert.equal(JSON.stringify(cached).includes('secret'), false);
});

test('provider returns a selected registered repository in the verified project route', () => {
  const f = fixture('repository-route');
  const component = path.join(f.projectRoot, 'component');
  fs.mkdirSync(component, { recursive: true });
  const initialized = spawnSync('git', ['init'], { cwd: component, encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  writeRegistrations(f, { repositoryRoots: [f.projectRoot, component] });
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve({
    cwd: f.cwd, projectRoot: f.projectRoot, repositoryRoot: component,
    hostId: 'host-a', projectEntryTrusted: true,
    repository: { remote: 'git@example.test:team/app.git' },
    platform: snapshot(f).platform, hostRoutes: snapshot(f).hostRoutes,
  });
  assertIdentityStatus(result, 'verified');
  assert.equal(projectIdentityInternals.samePath(result.projectRoute.repositoryRoot, component), true);
  assert.equal(projectIdentityInternals.samePath(result.projectRoute.executionRoot, component), true);
  assert.equal(result.projectRoute.relation, 'canonical');
  assert.equal(result.registeredRepositoryRoots.length, 2);
});

test('provider resolves a non-Git project from an ordinary source subdirectory', () => {
  const f = fixture('non-git-subdirectory');
  writeRegistrations(f, { git: false, localRemote: '', sharedRemote: '' });
  assert.equal(spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: f.cwd, encoding: 'utf8', windowsHide: true,
  }).status !== 0, true, 'fixture must have no containing Git repository');
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve(snapshot(f, { repository: { remote: null } }));
  assertIdentityStatus(result, 'verified');
  assert.equal(projectIdentityInternals.samePath(result.projectRoute.executionRoot, f.projectRoot), true);
  assert.equal(result.projectRoute.relation, 'canonical');
});

test('provider keeps a non-Git project inside an outer repository at its own canonical root', () => {
  const f = fixture('non-git-project-inside-outer-repository');
  const initialized = spawnSync('git', ['init'], { cwd: f.root, encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  const committed = spawnSync('git', [
    '-c', 'user.name=BEYOND Test', '-c', 'user.email=test@example.invalid',
    'commit', '--allow-empty', '-m', 'outer repository fixture',
  ], { cwd: f.root, encoding: 'utf8', windowsHide: true });
  assert.equal(committed.status, 0, committed.stderr);
  writeRegistrations(f, { git: false, localRemote: '', sharedRemote: '' });
  assert.equal(fs.existsSync(path.join(f.projectRoot, '.git')), false);
  const containingRepository = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: f.cwd, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(containingRepository.status, 0, containingRepository.stderr);
  assert.equal(projectIdentityInternals.samePath(containingRepository.stdout.trim(), f.root), true);
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve(snapshot(f, { repository: { remote: null } }));
  assertIdentityStatus(result, 'verified');
  assert.equal(projectIdentityInternals.samePath(result.projectRoute.repositoryRoot, f.projectRoot), true);
  assert.equal(projectIdentityInternals.samePath(result.projectRoute.executionRoot, f.projectRoot), true);
  assert.equal(projectIdentityInternals.samePath(result.projectRoute.executionRoot, f.root), false);
  assert.equal(result.projectRoute.relation, 'canonical');
});

test('provider selects a registered component from a non-Git project subdirectory', () => {
  const f = fixture('non-git-component-selection');
  const component = path.join(f.projectRoot, 'component');
  fs.mkdirSync(component);
  const initialized = spawnSync('git', ['init'], { cwd: component, encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  writeRegistrations(f, { git: false, localRemote: '', sharedRemote: '', repositoryRoots: [f.projectRoot, component] });
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve(snapshot(f, { repository: { remote: null }, repositoryRoot: component }));
  assertIdentityStatus(result, 'verified');
  assert.equal(projectIdentityInternals.samePath(result.projectRoute.repositoryRoot, component), true);
  assert.equal(projectIdentityInternals.samePath(result.projectRoute.executionRoot, component), true);
  assert.equal(result.projectRoute.relation, 'canonical');
});

test('provider resolves a registered component from its ordinary source subdirectory', () => {
  const f = fixture('component-subdirectory');
  const component = path.join(f.projectRoot, 'component');
  const componentSource = path.join(component, 'src');
  fs.mkdirSync(componentSource, { recursive: true });
  const initialized = spawnSync('git', ['init'], { cwd: component, encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  writeRegistrations(f, { repositoryRoots: [f.projectRoot, component] });
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve(snapshot(f, { cwd: componentSource, repositoryRoot: component }));
  assertIdentityStatus(result, 'verified');
  assert.equal(projectIdentityInternals.samePath(result.projectRoute.executionRoot, component), true);
  assert.equal(result.projectRoute.relation, 'canonical');
});

test('provider still rejects an explicitly selected source subdirectory as executionRoot', () => {
  const f = fixture('explicit-source-execution');
  writeRegistrations(f);
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve(snapshot(f, { executionRoot: f.cwd }));
  assertIdentityStatus(result, 'conflict');
  assert.equal(result.projectRoute, null);
  assert.equal(result.allowed.createWorker, false);
  assert.ok(result.evidence.issues.some(issue => issue.reason === 'registered_repository_invalid'
    && issue.detail.includes('not an exact Git repository root')));
});

test('provider does not treat a broken nested Git marker as an ordinary non-Git directory', () => {
  const f = fixture('broken-nested-git');
  writeRegistrations(f, { git: false, localRemote: '', sharedRemote: '' });
  fs.writeFileSync(path.join(f.cwd, '.git'), 'gitdir: ../missing-git-directory\n', 'utf8');
  const child = path.join(f.cwd, 'child');
  fs.mkdirSync(child);
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  for (const cwd of [f.cwd, child]) {
    const result = provider.resolve(snapshot(f, { cwd, repository: { remote: null } }));
    assertIdentityStatus(result, 'conflict');
    assert.equal(result.projectRoute, null);
    assert.equal(result.allowed.createWorker, false);
    assert.ok(result.reasons.includes('registered_repository_invalid'));
  }
});

for (const kind of ['unregistered repository', 'undeclared clone']) {
  test(`provider does not turn a nested ${kind} into a canonical route`, () => {
    const f = fixture(kind.replaceAll(' ', '-'));
    writeRegistrations(f);
    const checkout = path.join(f.projectRoot, '.codex-local', 'unregistered-checkout');
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    if (kind === 'undeclared clone') {
      const committed = spawnSync('git', [
        '-c', 'user.name=BEYOND Test', '-c', 'user.email=test@example.invalid',
        'commit', '--allow-empty', '-m', 'fixture baseline',
      ], { cwd: f.projectRoot, encoding: 'utf8', windowsHide: true });
      assert.equal(committed.status, 0, committed.stderr);
      const cloned = spawnSync('git', ['clone', '--no-hardlinks', f.projectRoot, checkout], {
        cwd: f.root, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(cloned.status, 0, cloned.stderr);
    } else {
      fs.mkdirSync(checkout);
      const initialized = spawnSync('git', ['init'], { cwd: checkout, encoding: 'utf8', windowsHide: true });
      assert.equal(initialized.status, 0, initialized.stderr);
    }
    const checkoutSource = path.join(checkout, 'src');
    fs.mkdirSync(checkoutSource);
    const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
    for (const cwd of [checkout, checkoutSource]) {
      const result = provider.resolve(snapshot(f, { cwd }));
      assertIdentityStatus(result, 'conflict');
      assert.equal(result.projectRoute, null);
      assert.equal(result.allowed.createWorker, false);
      assert.ok(result.reasons.includes('registered_repository_invalid'));
    }
  });
}

test('provider can read the user host route index exactly once', () => {
  const f = fixture('host-index');
  writeRegistrations(f);
  const hostIndex = path.join(f.root, 'host-project-routes.json');
  fs.writeFileSync(hostIndex, `${JSON.stringify({
    schemaVersion: 1,
    projects: [{ beyondProjectId: 'project-1', codexProjectId: 'codex-1', path: f.projectRoot, hostId: 'host-a' }],
  }, null, 2)}\n`, 'utf8');
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve({
    cwd: f.cwd, projectRoot: f.projectRoot, hostId: 'host-a', projectEntryTrusted: true,
    repository: { remote: 'git@example.test:team/app.git' }, platform: snapshot(f).platform,
    hostRouteIndexFile: hostIndex,
  });
  assertIdentityStatus(result, 'verified');
  assert.equal(result.sourceCounts.hostRouteFilesRead, 1);
});

test('provider refuses a verified identity when canonical AGENTS maps another control root', () => {
  const f = fixture('wrong-control-binding');
  writeRegistrations(f);
  const agentsPath = path.join(f.projectRoot, 'AGENTS.md');
  fs.writeFileSync(agentsPath, fs.readFileSync(agentsPath, 'utf8').replace(
    /<!-- BEYOND-CONTROL-ROOT: [^\n]+ -->/,
    '<!-- BEYOND-CONTROL-ROOT: ../other-control -->',
  ), 'utf8');
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve({
    cwd: f.cwd, projectRoot: f.projectRoot, hostId: 'host-a', projectEntryTrusted: true,
    repository: { remote: 'git@example.test:team/app.git' },
    platform: snapshot(f).platform, hostRoutes: snapshot(f).hostRoutes,
  });
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('canonical_project_binding_invalid'));
  assert.equal(result.projectRoute, null);
});

test('verified identity without local host routing fields does not mint a Worker route', () => {
  const f = fixture('blank-route-fields');
  writeRegistrations(f, { hostId: '', codexProjectId: '' });
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve({
    cwd: f.cwd, projectRoot: f.projectRoot, hostId: 'host-a', projectEntryTrusted: true,
    repository: { remote: 'git@example.test:team/app.git' },
    platform: snapshot(f).platform, hostRoutes: snapshot(f).hostRoutes,
  });
  assertIdentityStatus(result, 'verified');
  assert.equal(result.projectRoute, null);
});

test('malformed host route index is evidence and leaves a trusted project degraded', () => {
  const f = fixture('host-index-broken');
  writeRegistrations(f);
  const hostIndex = path.join(f.root, 'host-project-routes.json');
  fs.writeFileSync(hostIndex, '{broken', 'utf8');
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve({
    cwd: f.cwd, projectRoot: f.projectRoot, hostId: 'host-a', projectEntryTrusted: true,
    repository: { remote: 'git@example.test:team/app.git' }, platform: snapshot(f).platform,
    hostRouteIndexFile: hostIndex,
  });
  assert.equal(result.status, 'degraded');
  assert.ok(result.reasons.includes('host_route_missing'));
  assert.equal(result.evidence.issues[0].kind, 'host-route');
});

test('derived cache never substitutes for removed source registrations', () => {
  const f = fixture('cache-not-source');
  writeRegistrations(f);
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const input = {
    cwd: f.cwd, projectRoot: f.projectRoot, hostId: 'host-a', projectEntryTrusted: false,
    repository: { remote: 'git@example.test:team/app.git' }, platform: { available: false }, hostRoutes: [],
  };
  assert.equal(provider.resolve(input).status, 'degraded');
  fs.rmSync(path.join(f.controlRoot, 'local', 'projects'), { recursive: true, force: true });
  fs.rmSync(path.join(f.controlRoot, 'shared', 'projects'), { recursive: true, force: true });
  assert.equal(provider.resolve(input).status, 'unavailable');
});

test('malformed registration for the current path produces explicit conflict evidence', () => {
  const f = fixture('malformed');
  fs.writeFileSync(path.join(f.controlRoot, 'local', 'projects', 'broken.md'), [
    '---', 'name: broken', `path: ${f.projectRoot}`, 'host_id: host-a', '---', '',
  ].join('\n'), 'utf8');
  const provider = new ProjectIdentityProvider({ controlRoot: f.controlRoot, runtimeRoot: f.runtimeRoot });
  const result = provider.resolve({
    cwd: f.cwd, projectRoot: f.projectRoot, hostId: 'host-a', projectEntryTrusted: true,
    platform: { available: false }, hostRoutes: [],
  });
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('invalid_local_registration_for_path'));
  assert.equal(result.evidence.issues.length, 1);
});

test('provider consumes registrations produced by the existing beyond-control command', () => {
  const f = fixture('existing-control');
  const template = path.resolve(import.meta.dirname, '../模板交付包');
  fs.cpSync(template, f.controlRoot, { recursive: true, force: true });
  const gitInit = spawnSync('git', ['init'], { cwd: f.projectRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(gitInit.status, 0, gitInit.stderr);
  const gitRemote = spawnSync('git', ['remote', 'add', 'origin', 'https://example.test/team/generated.git'], {
    cwd: f.projectRoot, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(gitRemote.status, 0, gitRemote.stderr);
  const controlScript = path.join(f.controlRoot, 'scripts', 'beyond-control.mjs');
  const initialized = spawnSync(process.execPath, [controlScript, 'init-control'], {
    cwd: f.controlRoot, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const registered = spawnSync(process.execPath, [
    controlScript, 'install-project-entry', '--project-root', f.projectRoot, '--confirm-fusion', 'yes',
    '--host-id', 'host-a', '--codex-project-id', 'codex-generated', '--name', 'generated',
  ], { cwd: f.controlRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(registered.status, 0, registered.stderr);
  const registration = JSON.parse(registered.stdout);
  const provider = new ProjectIdentityProvider({
    controlRoot: f.controlRoot,
    runtimeRoot: path.join(f.controlRoot, 'local', 'runtime', 'project-identity'),
  });
  const result = provider.resolve({
    cwd: f.cwd, projectRoot: f.projectRoot, hostId: 'host-a', projectEntryTrusted: true,
    repository: { remote: 'https://example.test/team/generated.git' },
    platform: {
      available: true, selectedProjectId: 'codex-generated',
      projects: [{ projectId: 'codex-generated', path: f.projectRoot, hostId: 'host-a' }],
    },
    hostRoutes: [{
      beyondProjectId: registration.projectId, codexProjectId: 'codex-generated',
      path: f.projectRoot, hostId: 'host-a',
    }],
  });
  assertIdentityStatus(result, 'verified');
  assert.equal(result.identities.beyondProjectId, registration.projectId);
});
