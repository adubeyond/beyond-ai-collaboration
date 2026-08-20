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
  const local = [
    '---', `id: ${projectId}`, 'name: app', `path: ${f.projectRoot}`,
    `remote: ${options.localRemote ?? 'git@example.test:team/app.git'}`,
    `host_id: ${options.hostId ?? 'host-a'}`, `codex_project_id: ${options.codexProjectId ?? 'codex-1'}`,
    '---', '', '# app 本机登记', '',
  ].join('\n');
  const shared = [
    '---', `id: ${projectId}`, 'name: app', `remote: ${options.sharedRemote ?? 'https://example.test/team/app'}`,
    '---', '', '# app', '',
  ].join('\n');
  fs.writeFileSync(path.join(f.controlRoot, 'local', 'projects', `${projectId}.md`), local, 'utf8');
  fs.writeFileSync(path.join(f.controlRoot, 'shared', 'projects', `${projectId}.md`), shared, 'utf8');
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
  assert.equal(result.status, 'verified');
  assert.equal(result.sourceCounts.localMappings, 1);
  assert.equal(result.sourceCounts.sharedRegistrations, 1);
  assert.ok(fs.existsSync(result.cacheFile));
  const cached = JSON.parse(fs.readFileSync(result.cacheFile, 'utf8'));
  assert.equal(cached.derived, true);
  assert.equal(cached.result.status, 'verified');
  assert.equal(JSON.stringify(cached).includes('secret'), false);
});

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
  assert.equal(result.status, 'verified');
  assert.equal(result.sourceCounts.hostRouteFilesRead, 1);
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
    controlScript, 'register-project', '--project-root', f.projectRoot,
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
      beyondProjectId: registration.project.projectId, codexProjectId: 'codex-generated',
      path: f.projectRoot, hostId: 'host-a',
    }],
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.identities.beyondProjectId, registration.project.projectId);
});
