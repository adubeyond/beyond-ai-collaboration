import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeRuntimeRequest } from '../模板交付包/scripts/runtime/control-runtime.mjs';

const scratchRoots = [];

function scratchRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

test.after(() => {
  for (const root of scratchRoots.reverse()) fs.rmSync(root, { recursive: true, force: true });
});

function runGit(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initializeRepository(root, file = 'README.md') {
  fs.mkdirSync(root, { recursive: true });
  runGit(root, ['init']);
  runGit(root, ['config', 'user.name', 'BEYOND Test']);
  runGit(root, ['config', 'user.email', 'beyond-test@example.invalid']);
  fs.writeFileSync(path.join(root, file), '# route fixture\n', 'utf8');
  runGit(root, ['add', '--', file]);
  runGit(root, ['commit', '-m', 'route fixture']);
}

function fixture(name, options = {}) {
  const root = scratchRoot(`beyond-project-route-${name}-`);
  const projectRoot = path.join(root, 'project');
  const controlRoot = path.join(root, 'control');
  const projectId = options.projectId ?? 'local-route-project';
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.join(controlRoot, 'local', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(controlRoot, 'shared', 'projects'), { recursive: true });
  const repositories = options.repositories ?? [{ path: projectRoot, remote: null, role: 'project-root' }];
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), [
    '<!-- BEYOND-RUNTIME-VERSION: 3.2.5 -->',
    `<!-- BEYOND-CONTROL-ROOT: ${path.relative(projectRoot, controlRoot).replaceAll('\\', '/')} -->`,
    `<!-- BEYOND-PROJECT-ID: ${projectId} -->`,
    '# Project', '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(controlRoot, 'local', 'projects', `${projectId}.md`), [
    '---', `id: ${projectId}`, `path: ${projectRoot}`, 'host_id: local', 'codex_project_id: codex-route-project',
    `repositories_json: ${JSON.stringify(repositories)}`, '---', '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(controlRoot, 'shared', 'projects', `${projectId}.md`), [
    '---', `id: ${projectId}`, '---', '',
  ].join('\n'), 'utf8');
  return { root, projectRoot, controlRoot, projectId };
}

function projectRoute(f, repositoryRoot, executionRoot, overrides = {}) {
  return {
    projectId: f.projectId,
    canonicalProjectRoot: f.projectRoot,
    controlRoot: f.controlRoot,
    repositoryRoot,
    executionRoot,
    hostId: 'local',
    codexProjectId: 'codex-route-project',
    ...overrides,
  };
}

function enqueue(f, route, taskId = 'route-task', context = {}) {
  const runtimeContext = { controlRoot: f.controlRoot };
  if (context.omitExecutionRoot !== true) runtimeContext.executionRoot = context.executionRoot ?? route.executionRoot;
  return executeRuntimeRequest({
    schemaVersion: 1,
    action: 'worker-result.enqueue',
    input: {
      projectId: f.projectId,
      taskId,
      sourceThreadId: '01a00000-0000-7000-8000-000000000099',
      businessState: '已完成',
      finalText: `已完成\n${taskId}`,
      projectRoute: route,
    },
  }, runtimeContext);
}

function enqueueWithoutRoute(f, executionRoot, taskId = 'same-root-task') {
  return executeRuntimeRequest({
    schemaVersion: 1,
    action: 'worker-result.enqueue',
    input: {
      projectId: f.projectId,
      taskId,
      sourceThreadId: '01a00000-0000-7000-8000-000000000099',
      businessState: '已完成',
      finalText: `已完成\n${taskId}`,
    },
  }, { controlRoot: f.controlRoot, executionRoot });
}

function pendingCount(controlRoot) {
  const pending = path.join(controlRoot, 'local', 'runtime', 'worker-results', 'pending');
  return fs.existsSync(pending)
    ? fs.readdirSync(pending, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length
    : 0;
}

test('canonical project route accepts a single-repository or non-Git project root', () => {
  const f = fixture('canonical');
  const result = enqueue(f, projectRoute(f, f.projectRoot, f.projectRoot));
  assert.equal(result.ok, true);
  assert.equal(result.result.mode, 'created');
  assert.equal(enqueueWithoutRoute(f, f.projectRoot, 'same-root-task').result.mode, 'created');
  assert.equal(pendingCount(f.controlRoot), 2);
  assert.throws(() => enqueueWithoutRoute(f, f.root, 'missing-route-task'), /requires projectRoute/);
  assert.equal(pendingCount(f.controlRoot), 2);
});

test('workbench.close rejects pending results and archives only an explicitly authorized stopped task', () => {
  const f = fixture('close');
  const context = { controlRoot: f.controlRoot, executionRoot: f.projectRoot };
  executeRuntimeRequest({
    schemaVersion: 1,
    requestId: 'register-close-task',
    action: 'workbench.register',
    input: {
      taskId: 'close-task', task: '老板决定关闭的任务', worker: 'worker-close', status: '进行中',
      progress: '处理中', pause: '无', result: 'thread://worker-close', updatedAt: '2026-08-31T10:00:00+08:00',
    },
  }, context);
  enqueue(f, projectRoute(f, f.projectRoot, f.projectRoot), 'close-task');
  const blockedCloseRequest = {
    schemaVersion: 1,
    requestId: 'close-task-with-pending',
    action: 'workbench.close',
    input: {
      projectId: f.projectId,
      operationId: 'close-task-with-pending',
      taskId: 'close-task',
      worker: 'worker-close',
      expectedStatus: '进行中',
      businessState: '已关闭',
      ownerDirective: 'explicit-owner-instruction',
      workerStopped: true,
      closedBy: 'pm-main',
      closureReason: '老板明确取消该任务',
      taskLocator: 'thread://worker-close',
      authorizationLocator: 'thread://pm-main/turn/close-task',
      closedAt: '2026-08-31T10:05:00+08:00',
    },
  };
  assert.throws(() => executeRuntimeRequest(blockedCloseRequest, context), /zero pending/);
  executeRuntimeRequest({
    schemaVersion: 1,
    requestId: 'register-clean-close-task',
    action: 'workbench.register',
    input: {
      taskId: 'clean-close-task', task: '没有待处理结果的关闭任务', worker: 'worker-clean-close', status: '已暂停',
      progress: '等待老板决定', pause: '老板决定是否继续', result: 'thread://worker-clean-close', updatedAt: '2026-08-31T10:01:00+08:00',
    },
  }, context);
  const closeRequest = structuredClone(blockedCloseRequest);
  closeRequest.requestId = 'close-owner-authorized-task';
  closeRequest.input.operationId = 'close-owner-authorized-task';
  closeRequest.input.taskId = 'clean-close-task';
  closeRequest.input.worker = 'worker-clean-close';
  closeRequest.input.expectedStatus = '已暂停';
  closeRequest.input.taskLocator = 'thread://worker-clean-close';
  const closed = executeRuntimeRequest(closeRequest, context).result;
  assert.equal(closed.status, '已关闭');
  assert.equal(closed.archived, true);
  const state = JSON.parse(fs.readFileSync(path.join(f.controlRoot, 'local', 'runtime', 'workbench', 'workbench-state.json'), 'utf8'));
  assert.equal(state.tasks['close-task'].status, '进行中');
  assert.equal(state.tasks['clean-close-task'], undefined);
  const history = JSON.parse(fs.readFileSync(path.join(f.controlRoot, 'local', 'history', 'workbench', '2026-08.json'), 'utf8'));
  assert.equal(history.records[0].status, '已关闭');
});

test('project.resolve trusts the runtime working directory instead of a JSON cwd claim', () => {
  const f = fixture('resolve-cwd');
  const request = {
    schemaVersion: 1,
    requestId: 'resolve-cwd-proof',
    action: 'project.resolve',
    input: {
      cwd: f.projectRoot,
      projectRoot: f.projectRoot,
      hostId: 'local',
      projectEntryTrusted: true,
      platform: {
        available: true,
        selectedProjectId: 'codex-route-project',
        projects: [{ projectId: 'codex-route-project', path: f.projectRoot, hostId: 'local' }],
      },
      hostRoutes: [{
        beyondProjectId: f.projectId, codexProjectId: 'codex-route-project',
        path: f.projectRoot, hostId: 'local',
      }],
    },
  };
  const result = executeRuntimeRequest(request, { controlRoot: f.controlRoot, executionRoot: f.root }).result;
  assert.equal(result.status, 'conflict');
  assert.ok(result.reasons.includes('cwd_outside_project_root'));
  assert.throws(() => executeRuntimeRequest(request, { controlRoot: f.controlRoot }), /runtime executionRoot is required/);
});

test('same-root fallback cannot bypass a canonical Git root excluded by repository selection', () => {
  const root = scratchRoot('beyond-project-route-selected-child-source-');
  const projectRoot = path.join(root, 'project');
  const component = path.join(projectRoot, 'component');
  initializeRepository(projectRoot);
  initializeRepository(component);
  runGit(projectRoot, ['remote', 'add', 'origin', 'https://example.test/team/duplicate.git']);
  runGit(component, ['remote', 'add', 'origin', 'https://example.test/team/duplicate.git']);
  const f = fixture('selected-child', {
    repositories: [{
      path: component, remote: 'https://example.test/team/duplicate', role: 'component', kind: 'git',
    }],
  });
  fs.cpSync(path.join(f.root, 'control'), path.join(root, 'control'), { recursive: true, force: true });
  f.root = root;
  f.projectRoot = projectRoot;
  f.controlRoot = path.join(root, 'control');
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), [
    '<!-- BEYOND-RUNTIME-VERSION: 3.2.5 -->', '<!-- BEYOND-CONTROL-ROOT: ../control -->',
    `<!-- BEYOND-PROJECT-ID: ${f.projectId} -->`, '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(f.controlRoot, 'local', 'projects', `${f.projectId}.md`), [
    '---', `id: ${f.projectId}`, `path: ${projectRoot}`, 'host_id: local', 'codex_project_id: codex-route-project',
    `repositories_json: ${JSON.stringify([{
      path: component, remote: 'https://example.test/team/duplicate', role: 'component', kind: 'git',
    }])}`, '---', '',
  ].join('\n'), 'utf8');
  assert.throws(() => enqueueWithoutRoute(f, projectRoot, 'excluded-root'), /not an allowed execution repository/);
  assert.equal(enqueue(f, projectRoute(f, component, component), 'selected-component').result.mode, 'created');
  assert.equal(pendingCount(f.controlRoot), 1);
});

test('registered nested and explicit external repositories are valid exact execution roots', () => {
  const root = scratchRoot('beyond-project-route-multi-source-');
  const projectRoot = path.join(root, 'project');
  const nested = path.join(projectRoot, 'backend');
  const external = path.join(root, 'external-crawler');
  fs.mkdirSync(projectRoot, { recursive: true });
  initializeRepository(nested);
  initializeRepository(external);
  const repositories = [
    { path: projectRoot, remote: null, role: 'project-root' },
    { path: nested, remote: null, role: 'component' },
    { path: external, remote: null, role: 'component' },
  ];
  const f = fixture('multi', { repositories });
  fs.cpSync(path.join(f.root, 'control'), path.join(root, 'control'), { recursive: true, force: true });
  f.root = root;
  f.projectRoot = projectRoot;
  f.controlRoot = path.join(root, 'control');
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), [
    '<!-- BEYOND-RUNTIME-VERSION: 3.2.5 -->',
    '<!-- BEYOND-CONTROL-ROOT: ../control -->',
    `<!-- BEYOND-PROJECT-ID: ${f.projectId} -->`, '',
  ].join('\n'), 'utf8');
  const registration = path.join(f.controlRoot, 'local', 'projects', `${f.projectId}.md`);
  fs.writeFileSync(registration, [
    '---', `id: ${f.projectId}`, `path: ${projectRoot}`, 'host_id: local', 'codex_project_id: codex-route-project',
    `repositories_json: ${JSON.stringify(repositories)}`, '---', '',
  ].join('\n'), 'utf8');
  assert.equal(enqueue(f, projectRoute(f, nested, nested), 'nested-task').result.mode, 'created');
  assert.equal(enqueue(f, projectRoute(f, external, external), 'external-task').result.mode, 'created');
  const unregistered = path.join(root, 'unregistered');
  initializeRepository(unregistered);
  assert.throws(() => enqueue(f, projectRoute(f, unregistered, unregistered), 'unregistered-task'), /not registered/);
  assert.equal(pendingCount(f.controlRoot), 2);
});

test('a root-local result must not reuse a valid component route from another task', () => {
  const root = scratchRoot('beyond-project-route-root-local-');
  const projectRoot = path.join(root, 'project');
  const component = path.join(root, 'external-component');
  fs.mkdirSync(projectRoot, { recursive: true });
  initializeRepository(component);
  const repositories = [
    { path: projectRoot, remote: null, role: 'project-root' },
    { path: component, remote: null, role: 'component' },
  ];
  const f = fixture('root-local', { repositories });
  fs.cpSync(path.join(f.root, 'control'), path.join(root, 'control'), { recursive: true, force: true });
  f.root = root;
  f.projectRoot = projectRoot;
  f.controlRoot = path.join(root, 'control');
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), [
    '<!-- BEYOND-RUNTIME-VERSION: 3.2.5 -->',
    '<!-- BEYOND-CONTROL-ROOT: ../control -->',
    `<!-- BEYOND-PROJECT-ID: ${f.projectId} -->`, '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(f.controlRoot, 'local', 'projects', `${f.projectId}.md`), [
    '---', `id: ${f.projectId}`, `path: ${projectRoot}`, 'host_id: local', 'codex_project_id: codex-route-project',
    `repositories_json: ${JSON.stringify(repositories)}`, '---', '',
  ].join('\n'), 'utf8');

  assert.throws(
    () => enqueue(f, projectRoute(f, component, projectRoot), 'wrong-component-route'),
    /not a registered worktree/,
  );
  assert.equal(pendingCount(f.controlRoot), 0);
  assert.equal(enqueueWithoutRoute(f, projectRoot, 'correct-root-route').result.mode, 'created');
  assert.equal(pendingCount(f.controlRoot), 1);
});

test('a real Git worktree can use the canonical control route even when its checkout lacks AGENTS', () => {
  const root = scratchRoot('beyond-project-route-worktree-source-');
  const repositoryRoot = path.join(root, 'project');
  initializeRepository(repositoryRoot);
  const executionRoot = path.join(root, 'worker-checkout');
  runGit(repositoryRoot, ['worktree', 'add', '--detach', executionRoot]);
  const f = fixture('worktree', {
    repositories: [{ path: repositoryRoot, remote: null, role: 'project-root' }],
  });
  fs.cpSync(path.join(f.root, 'control'), path.join(root, 'control'), { recursive: true, force: true });
  f.root = root;
  f.projectRoot = repositoryRoot;
  f.controlRoot = path.join(root, 'control');
  fs.writeFileSync(path.join(repositoryRoot, 'AGENTS.md'), [
    '<!-- BEYOND-RUNTIME-VERSION: 3.2.5 -->', '<!-- BEYOND-CONTROL-ROOT: ../control -->',
    `<!-- BEYOND-PROJECT-ID: ${f.projectId} -->`, '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(f.controlRoot, 'local', 'projects', `${f.projectId}.md`), [
    '---', `id: ${f.projectId}`, `path: ${repositoryRoot}`, 'host_id: local', 'codex_project_id: codex-route-project',
    `repositories_json: ${JSON.stringify([{ path: repositoryRoot, remote: null, role: 'project-root' }])}`, '---', '',
  ].join('\n'), 'utf8');
  assert.equal(fs.existsSync(path.join(executionRoot, 'AGENTS.md')), false);
  assert.equal(enqueue(f, projectRoute(f, repositoryRoot, executionRoot), 'worktree-task').result.mode, 'created');
});

test('an independent clone with matching content is not accepted as a worktree', () => {
  const root = scratchRoot('beyond-project-route-clone-source-');
  const repositoryRoot = path.join(root, 'project');
  initializeRepository(repositoryRoot);
  const cloneRoot = path.join(root, 'clone');
  const cloned = spawnSync('git', ['clone', repositoryRoot, cloneRoot], { encoding: 'utf8', windowsHide: true });
  assert.equal(cloned.status, 0, cloned.stderr || cloned.stdout);
  const f = fixture('clone', { repositories: [{ path: repositoryRoot, remote: null, role: 'project-root' }] });
  fs.cpSync(path.join(f.root, 'control'), path.join(root, 'control'), { recursive: true, force: true });
  f.root = root;
  f.projectRoot = repositoryRoot;
  f.controlRoot = path.join(root, 'control');
  fs.writeFileSync(path.join(repositoryRoot, 'AGENTS.md'), [
    '<!-- BEYOND-RUNTIME-VERSION: 3.2.5 -->', '<!-- BEYOND-CONTROL-ROOT: ../control -->',
    `<!-- BEYOND-PROJECT-ID: ${f.projectId} -->`, '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(f.controlRoot, 'local', 'projects', `${f.projectId}.md`), [
    '---', `id: ${f.projectId}`, `path: ${repositoryRoot}`, 'host_id: local', 'codex_project_id: codex-route-project',
    `repositories_json: ${JSON.stringify([{ path: repositoryRoot, remote: null, role: 'project-root' }])}`, '---', '',
  ].join('\n'), 'utf8');
  assert.throws(() => enqueue(f, projectRoute(f, repositoryRoot, cloneRoot), 'clone-task'), /not a registered worktree/);
  assert.equal(pendingCount(f.controlRoot), 0);
});

test('registered component routes reject non-Git roots and live remote drift', () => {
  const root = scratchRoot('beyond-project-route-component-validation-');
  const projectRoot = path.join(root, 'project');
  const nonGit = path.join(projectRoot, 'plain-component');
  const remoteDrift = path.join(projectRoot, 'remote-component');
  fs.mkdirSync(nonGit, { recursive: true });
  initializeRepository(remoteDrift);
  runGit(remoteDrift, ['remote', 'add', 'origin', 'https://example.test/team/original.git']);
  const repositories = [
    { path: nonGit, remote: null, role: 'component', kind: 'git' },
    { path: remoteDrift, remote: 'https://example.test/team/original', role: 'component', kind: 'git' },
  ];
  const f = fixture('component-validation', { repositories });
  fs.cpSync(path.join(f.root, 'control'), path.join(root, 'control'), { recursive: true, force: true });
  f.root = root;
  f.projectRoot = projectRoot;
  f.controlRoot = path.join(root, 'control');
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), [
    '<!-- BEYOND-RUNTIME-VERSION: 3.2.5 -->', '<!-- BEYOND-CONTROL-ROOT: ../control -->',
    `<!-- BEYOND-PROJECT-ID: ${f.projectId} -->`, '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(f.controlRoot, 'local', 'projects', `${f.projectId}.md`), [
    '---', `id: ${f.projectId}`, `path: ${projectRoot}`, 'host_id: local', 'codex_project_id: codex-route-project',
    `repositories_json: ${JSON.stringify(repositories)}`, '---', '',
  ].join('\n'), 'utf8');
  assert.throws(() => enqueue(f, projectRoute(f, nonGit, nonGit), 'non-git-component'), /not an exact Git repository root/);
  runGit(remoteDrift, ['remote', 'set-url', 'origin', 'https://example.test/team/replaced.git']);
  assert.throws(() => enqueue(f, projectRoute(f, remoteDrift, remoteDrift), 'remote-drift'), /remote does not match registration/);
  assert.equal(pendingCount(f.controlRoot), 0);
});

test('wrong control, project marker, host or runtime working directory fail before pending write', () => {
  const f = fixture('wrong-route');
  const otherControl = path.join(f.root, 'other-control');
  fs.mkdirSync(otherControl, { recursive: true });
  for (const [label, route, context, error] of [
    ['control', projectRoute(f, f.projectRoot, f.projectRoot, { controlRoot: otherControl }), {}, /controlRoot mismatch/],
    ['host', projectRoute(f, f.projectRoot, f.projectRoot, { hostId: 'other-host' }), {}, /hostId mismatch/],
    ['codex-project', projectRoute(f, f.projectRoot, f.projectRoot, { codexProjectId: 'other-codex-project' }), {}, /codexProjectId mismatch/],
    ['cwd', projectRoute(f, f.projectRoot, f.projectRoot), { executionRoot: f.root }, /working directory/],
    ['missing-cwd', projectRoute(f, f.projectRoot, f.projectRoot), { omitExecutionRoot: true }, /working directory/],
  ]) {
    assert.throws(() => enqueue(f, route, `wrong-${label}`, context), error);
  }
  const original = fs.readFileSync(path.join(f.projectRoot, 'AGENTS.md'), 'utf8');
  fs.writeFileSync(path.join(f.projectRoot, 'AGENTS.md'), original.replace(f.projectId, 'local-other-project'), 'utf8');
  assert.throws(() => enqueue(f, projectRoute(f, f.projectRoot, f.projectRoot), 'wrong-marker'), /AGENTS projectId mismatch/);
  fs.writeFileSync(path.join(f.projectRoot, 'AGENTS.md'), `${original}\n<!-- BEYOND-PROJECT-ID: ${f.projectId} -->\n`, 'utf8');
  assert.throws(() => enqueue(f, projectRoute(f, f.projectRoot, f.projectRoot), 'duplicate-marker'), /markers must be unique/);
  fs.writeFileSync(path.join(f.projectRoot, 'AGENTS.md'), original, 'utf8');
  fs.writeFileSync(path.join(f.controlRoot, 'local', 'projects', `${f.projectId}.md`), [
    '---', `id: ${f.projectId}`, `path: ${f.projectRoot}`, 'host_id: local', 'codex_project_id: codex-route-project',
    `repositories_json: ${JSON.stringify([{ path: path.join(f.root, 'other-repository'), remote: null, role: 'component' }])}`,
    '---', '',
  ].join('\n'), 'utf8');
  assert.throws(() => enqueue(f, projectRoute(f, f.projectRoot, f.projectRoot), 'unregistered-project-root'), /repositoryRoot is not registered/);
  assert.equal(pendingCount(f.controlRoot), 0);
});
