import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeRuntimeRequest } from '../模板交付包/scripts/runtime/control-runtime.mjs';
import { WorkerResultReceiptStore } from '../模板交付包/scripts/runtime/worker-result-receipts.mjs';

const receiptStoreModule = new URL('../模板交付包/scripts/runtime/worker-result-receipts.mjs', import.meta.url).href;

function listInChild(runtimeRoot, projectId) {
  const script = `import { WorkerResultReceiptStore } from ${JSON.stringify(receiptStoreModule)};\n`
    + `const store = new WorkerResultReceiptStore({ runtimeRoot: ${JSON.stringify(runtimeRoot)} });\n`
    + `process.stdout.write(JSON.stringify(store.list({ projectId: ${JSON.stringify(projectId)} })));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8', windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `beyond-worker-result-${name}-`));
  registerProject(root);
  return {
    root,
    store: new WorkerResultReceiptStore({ runtimeRoot: path.join(root, 'worker-results') }),
  };
}

function receipt(overrides = {}) {
  return {
    projectId: 'local-project-a',
    taskId: 'task-a',
    sourceThreadId: '01a00000-0000-7000-8000-000000000002',
    businessState: '已完成',
    finalText: '已完成\n结果A已经交付。',
    createdAt: '2026-08-23T08:00:00.000Z',
    ...overrides,
  };
}

function runtime(controlRoot, requestId, action, input) {
  const executionRoot = action === 'worker-result.enqueue'
    ? projectRootFor(controlRoot, input.projectId)
    : undefined;
  return executeRuntimeRequest({ schemaVersion: 1, requestId, action, input }, { controlRoot, executionRoot });
}

function projectRootFor(controlRoot, projectId = 'local-project-a') {
  return path.join(path.dirname(controlRoot), `${projectId}-project`);
}

function registerProject(controlRoot, projectId = 'local-project-a', options = {}) {
  const local = options.local !== false;
  const shared = options.shared !== false;
  const projectRoot = projectRootFor(controlRoot, projectId);
  fs.mkdirSync(projectRoot, { recursive: true });
  if (local) {
    const directory = path.join(controlRoot, 'local', 'projects');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${projectId}.md`), [
      '---', `id: ${projectId}`, `path: ${projectRoot}`,
      `repositories_json: ${JSON.stringify([{ path: projectRoot, remote: null, role: 'project-root' }])}`,
      '---', '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), [
      '<!-- BEYOND-RUNTIME-VERSION: 3.2.5 -->',
      `<!-- BEYOND-CONTROL-ROOT: ${path.relative(projectRoot, controlRoot).replaceAll('\\', '/')} -->`,
      `<!-- BEYOND-PROJECT-ID: ${projectId} -->`, '',
    ].join('\n'), 'utf8');
  }
  if (shared) {
    const directory = path.join(controlRoot, 'shared', 'projects');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${projectId}.md`), [
      '---', `id: ${projectId}`, '---', '',
    ].join('\n'), 'utf8');
  }
}

function registerActiveTask(controlRoot, overrides = {}) {
  fs.mkdirSync(path.join(controlRoot, 'local'), { recursive: true });
  const view = path.join(controlRoot, 'local', '当前工作台.md');
  if (!fs.existsSync(view)) fs.writeFileSync(view, '# 当前工作台\n', 'utf8');
  return runtime(controlRoot, `register-${overrides.taskId ?? 'task-a'}`, 'workbench.register', {
    taskId: 'task-a', task: '任务A', worker: 'worker-a', status: '进行中', progress: '执行中',
    pause: '无', result: '无', updatedAt: '2026-08-23T16:00:00+08:00',
    ...overrides,
  });
}

test('worker-result actions derive requestId when the envelope omits it', () => {
  const f = fixture('derived-request-id');
  const created = executeRuntimeRequest({
    schemaVersion: 1,
    action: 'worker-result.enqueue',
    input: receipt(),
  }, { controlRoot: f.root, executionRoot: projectRootFor(f.root) });
  assert.equal(created.requestId, 'worker-result.enqueue:local-project-a:task-a');
  assert.equal(created.result.mode, 'created');
  assert.throws(() => executeRuntimeRequest({
    schemaVersion: 1,
    action: 'workbench.migrate',
    input: {},
  }, { controlRoot: f.root }), /requestId is required/);
});

test('runtime write requires a local project registration and exact same-root execution', () => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-local-only-'));
  registerProject(localRoot, 'local-project-a', { shared: false });
  const created = runtime(localRoot, 'local-enqueue', 'worker-result.enqueue', receipt()).result.record;
  assert.equal(runtime(localRoot, 'local-list', 'worker-result.list', { projectId: 'local-project-a' }).result.count, 1);
  runtime(localRoot, 'local-ack', 'worker-result.ack', {
    projectId: 'local-project-a', taskId: 'task-a', receiptId: created.receiptId,
  });

  const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-shared-only-'));
  registerProject(sharedRoot, 'local-project-a', { local: false });
  assert.throws(() => runtime(sharedRoot, 'shared-enqueue', 'worker-result.enqueue', receipt()), /local project registration/);
  assert.throws(() => runtime(sharedRoot, 'shared-list', 'worker-result.list', { projectId: 'local-project-a' }), /local project registration/);
  assert.equal(fs.existsSync(path.join(sharedRoot, 'local', 'runtime', 'worker-results', 'pending')), false);

  const crossRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-cross-root-'));
  registerProject(crossRoot);
  assert.throws(() => executeRuntimeRequest({
    schemaVersion: 1, action: 'worker-result.enqueue', input: receipt(),
  }, { controlRoot: crossRoot, executionRoot: crossRoot }), /requires projectRoute/);
  assert.equal(fs.existsSync(path.join(crossRoot, 'local', 'runtime', 'worker-results', 'pending')), false);
});

test('runtime rejects a project not registered in this control root without writing pending data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-wrong-root-'));
  registerProject(root, 'local-project-b');
  assert.throws(() => runtime(root, 'wrong-enqueue', 'worker-result.enqueue', receipt()), /not registered in this control root/);
  assert.equal(fs.existsSync(path.join(root, 'local', 'runtime', 'worker-results', 'pending')), false);
  assert.throws(() => runtime(root, 'wrong-list', 'worker-result.list', { projectId: 'local-project-a' }), /not registered in this control root/);
  assert.throws(() => runtime(root, 'control-root-audit', 'worker-result.list', {}), /projectId is required/);
});

test('runtime rejects a receipt that names the registered Worker as its source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-self-source-'));
  registerProject(root);
  registerActiveTask(root);
  assert.throws(() => runtime(root, 'self-source-enqueue', 'worker-result.enqueue', receipt({
    sourceThreadId: 'worker-a',
  })), /sourceThreadId cannot equal the registered Worker/);
  assert.equal(runtime(root, 'self-source-empty', 'worker-result.list', {
    projectId: 'local-project-a',
  }).result.count, 0);
});

test('runtime leaves source-PM matching to the PM consumer after rejecting self-source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-non-worker-source-'));
  registerProject(root);
  registerActiveTask(root);
  const created = runtime(root, 'non-worker-source-enqueue', 'worker-result.enqueue', receipt({
    sourceThreadId: 'unrelated-thread',
    workerThreadId: 'worker-a',
  })).result.record;
  assert.equal(created.sourceThreadId, 'unrelated-thread');
  assert.equal(created.workerThreadId, 'worker-a');
});

test('runtime accepts an omitted optional Worker id without claiming owner verification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-optional-worker-'));
  registerProject(root);
  registerActiveTask(root);
  const created = runtime(root, 'optional-worker-enqueue', 'worker-result.enqueue', receipt()).result.record;
  assert.equal(created.workerThreadId, null);
});

test('runtime fails closed when machine state exists without its workbench view', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-missing-view-'));
  registerProject(root);
  registerActiveTask(root);
  fs.unlinkSync(path.join(root, 'local', '当前工作台.md'));
  assert.throws(() => runtime(root, 'missing-view-enqueue', 'worker-result.enqueue', receipt({
    sourceThreadId: 'worker-a',
    workerThreadId: 'worker-a',
  })), /workbench view is missing beside machine state/);
  assert.equal(runtime(root, 'missing-view-empty', 'worker-result.list', {
    projectId: 'local-project-a',
  }).result.count, 0);
});

test('runtime rejects a Worker id that conflicts with the registered task owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-worker-mismatch-'));
  registerProject(root);
  registerActiveTask(root);
  assert.throws(() => runtime(root, 'worker-mismatch-enqueue', 'worker-result.enqueue', receipt({
    workerThreadId: 'worker-b',
  })), /workerThreadId does not match the registered Worker/);
  assert.equal(runtime(root, 'worker-mismatch-empty', 'worker-result.list', {
    projectId: 'local-project-a',
  }).result.count, 0);
});

test('runtime accepts a non-Worker source and Worker that match an active task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-active-match-'));
  registerProject(root);
  registerActiveTask(root);
  const created = runtime(root, 'active-match-enqueue', 'worker-result.enqueue', receipt({
    workerThreadId: 'worker-a',
  })).result.record;
  assert.equal(created.sourceThreadId, '01a00000-0000-7000-8000-000000000002');
  assert.equal(created.workerThreadId, 'worker-a');
});

test('runtime preserves the pre-registration completion race', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-pre-register-'));
  registerProject(root);
  fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'local', '当前工作台.md'), '# 当前工作台\n', 'utf8');
  runtime(root, 'pre-register-workbench', 'workbench.migrate', {});
  const created = runtime(root, 'pre-register-enqueue', 'worker-result.enqueue', receipt({
    workerThreadId: 'worker-before-register',
  })).result.record;
  assert.equal(created.workerThreadId, 'worker-before-register');
});

test('copied local registration cannot make another control root return a fake empty list', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-control-source-'));
  const copied = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-control-copy-'));
  registerProject(source);
  fs.mkdirSync(path.join(copied, 'local', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(copied, 'shared', 'projects'), { recursive: true });
  fs.copyFileSync(
    path.join(source, 'local', 'projects', 'local-project-a.md'),
    path.join(copied, 'local', 'projects', 'local-project-a.md'),
  );
  fs.copyFileSync(
    path.join(source, 'shared', 'projects', 'local-project-a.md'),
    path.join(copied, 'shared', 'projects', 'local-project-a.md'),
  );
  assert.throws(() => runtime(copied, 'copied-control-list', 'worker-result.list', {
    projectId: 'local-project-a',
  }), /AGENTS controlRoot mismatch/);
});

test('two local project ids cannot share one canonical path at runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-duplicate-path-'));
  registerProject(root);
  const projectRoot = projectRootFor(root, 'local-project-a');
  fs.writeFileSync(path.join(root, 'local', 'projects', 'local-project-b.md'), [
    '---', 'id: local-project-b', `path: ${projectRoot}`, 'repositories_json: []', '---', '',
  ].join('\n'), 'utf8');
  assert.throws(() => runtime(root, 'duplicate-path-list', 'worker-result.list', {
    projectId: 'local-project-a',
  }), /one project id for the canonical local path/);
});

test('registered project list distinguishes a legitimate empty result from a wrong-root query', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-empty-'));
  registerProject(root);
  assert.deepEqual(runtime(root, 'registered-empty', 'worker-result.list', { projectId: 'local-project-a' }).result, {
    count: 0,
    records: [],
  });
});

test('ack remains able to remove an existing receipt after source registration disappears', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-cleanup-'));
  registerProject(root);
  const created = runtime(root, 'cleanup-enqueue', 'worker-result.enqueue', receipt()).result.record;
  fs.rmSync(path.join(root, 'local', 'projects'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'shared', 'projects'), { recursive: true, force: true });
  assert.equal(runtime(root, 'cleanup-ack', 'worker-result.ack', {
    projectId: 'local-project-a', taskId: 'task-a', receiptId: created.receiptId,
  }).result.removed, true);
});

test('enqueue creates one project-local pending receipt with a final fingerprint', () => {
  const f = fixture('create');
  const result = f.store.enqueue(receipt());
  assert.equal(result.mode, 'created');
  assert.match(result.record.receiptId, /^worker-result-[0-9a-f]{32}$/);
  assert.match(result.record.finalSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.record.workerThreadId, null);
  assert.deepEqual(f.store.list({ projectId: 'local-project-a' }).records, [result.record]);
});

test('identical enqueue is idempotent', () => {
  const f = fixture('duplicate');
  const first = f.store.enqueue(receipt());
  const second = f.store.enqueue(receipt({ createdAt: '2026-08-23T08:01:00.000Z' }));
  assert.equal(second.mode, 'existing');
  assert.equal(second.record.receiptId, first.record.receiptId);
  assert.equal(f.store.list({ projectId: 'local-project-a', taskId: 'task-a' }).count, 1);
});

test('a newer terminal result replaces the same task without creating history', () => {
  const f = fixture('replace');
  const paused = f.store.enqueue(receipt({ businessState: '已暂停', finalText: '已暂停\n等待目标代号。' }));
  const completed = f.store.enqueue(receipt({ finalText: '已完成\n目标代号已经处理。', createdAt: '2026-08-23T08:02:00.000Z' }));
  assert.equal(completed.mode, 'replaced');
  assert.equal(completed.supersededReceiptId, paused.record.receiptId);
  assert.deepEqual(f.store.list({ projectId: 'local-project-a', taskId: 'task-a' }).records, [completed.record]);
  assert.equal(fs.existsSync(path.join(f.root, 'worker-results', 'history')), false);
});

test('stale acknowledgement cannot remove a newer result', () => {
  const f = fixture('stale-ack');
  const paused = f.store.enqueue(receipt({ businessState: '已暂停', finalText: '已暂停\n等待目标代号。' }));
  const completed = f.store.enqueue(receipt({ finalText: '已完成\n目标代号已经处理。' }));
  assert.throws(() => f.store.acknowledge({
    projectId: 'local-project-a', taskId: 'task-a', receiptId: paused.record.receiptId,
  }), /stale acknowledgement/);
  assert.equal(f.store.list({ projectId: 'local-project-a', taskId: 'task-a' }).records[0].receiptId, completed.record.receiptId);
});

test('acknowledgement deletes the body instead of archiving it', () => {
  const f = fixture('ack');
  const created = f.store.enqueue(receipt());
  const result = f.store.acknowledge({
    projectId: 'local-project-a', taskId: 'task-a', receiptId: created.record.receiptId,
  });
  assert.equal(result.removed, true);
  assert.equal(f.store.list({ projectId: 'local-project-a' }).count, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'worker-results', 'history')), false);
});

test('optional Worker identity is checked when both producer and consumer provide it', () => {
  const f = fixture('optional-worker');
  const created = f.store.enqueue(receipt({ workerThreadId: 'worker-a' }));
  assert.equal(f.store.list({ projectId: 'local-project-a', workerThreadId: 'worker-a' }).count, 1);
  assert.throws(() => f.store.acknowledge({
    projectId: 'local-project-a', taskId: 'task-a', receiptId: created.record.receiptId, workerThreadId: 'worker-b',
  }), /owner mismatch/);
  assert.equal(f.store.list({ projectId: 'local-project-a', taskId: 'task-a' }).count, 1);
});

test('invalid state, mismatched final and corrupted pending data fail visibly', () => {
  const f = fixture('invalid');
  assert.throws(() => f.store.enqueue(receipt({ businessState: '进行中' })), /businessState/);
  assert.throws(() => f.store.enqueue(receipt({ businessState: '已暂停' })), /finalText must start/);
  fs.mkdirSync(f.store.pendingRoot, { recursive: true });
  fs.writeFileSync(path.join(f.store.pendingRoot, 'broken.json'), '{', 'utf8');
  assert.throws(() => f.store.list({ projectId: 'local-project-a' }), /cannot read Worker result receipt/);
});

test('pending receipt survives process restart until acknowledgement', () => {
  const f = fixture('restart');
  const created = f.store.enqueue(receipt());
  const restarted = new WorkerResultReceiptStore({ runtimeRoot: path.join(f.root, 'worker-results') });
  assert.equal(restarted.list({ projectId: 'local-project-a', taskId: 'task-a' }).records[0].receiptId, created.record.receiptId);
});

test('legacy task-only pending files migrate once into the project namespace', () => {
  const f = fixture('legacy-migrate');
  const created = f.store.enqueue(receipt());
  const namespaced = f.store.receiptPath('local-project-a', 'task-a');
  const legacy = f.store.legacyReceiptPath('task-a');
  fs.renameSync(namespaced, legacy);
  assert.equal(f.store.list({ projectId: 'local-project-a' }).records[0].receiptId, created.record.receiptId);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(namespaced), true);
  assert.equal(f.store.acknowledge({
    projectId: 'local-project-a', taskId: 'task-a', receiptId: created.record.receiptId,
  }).removed, true);
});

test('concurrent legacy migration converges on one namespaced receipt without ENOENT', async () => {
  for (let round = 0; round < 5; round += 1) {
    const f = fixture(`legacy-concurrent-${round}`);
    const created = f.store.enqueue(receipt());
    const namespaced = f.store.receiptPath('local-project-a', 'task-a');
    const legacy = f.store.legacyReceiptPath('task-a');
    fs.renameSync(namespaced, legacy);
    const results = await Promise.all(Array.from({ length: 12 }, () => (
      listInChild(path.join(f.root, 'worker-results'), 'local-project-a')
    )));
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).records[0].receiptId, created.record.receiptId);
    }
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(f.store.readPath(namespaced).receiptId, created.record.receiptId);
  }
});

test('duplicate legacy and namespaced copies collapse only when receipt ids match', () => {
  const f = fixture('legacy-duplicate');
  const created = f.store.enqueue(receipt());
  const namespaced = f.store.receiptPath('local-project-a', 'task-a');
  const legacy = f.store.legacyReceiptPath('task-a');
  fs.copyFileSync(namespaced, legacy);
  assert.deepEqual(f.store.list({ projectId: 'local-project-a' }).records, [created.record]);
  assert.equal(fs.existsSync(legacy), false);

  const other = fixture('legacy-conflict-source');
  other.store.enqueue(receipt({ finalText: '已完成\n另一份冲突终态。' }));
  fs.copyFileSync(other.store.receiptPath('local-project-a', 'task-a'), legacy);
  assert.throws(() => f.store.list({ projectId: 'local-project-a' }), /conflicting legacy and namespaced/);
});

test('legacy migration uses the stored project id when another project has the same task id', () => {
  const f = fixture('legacy-cross-project');
  f.store.enqueue(receipt());
  const second = f.store.enqueue(receipt({
    projectId: 'local-project-b', finalText: '已完成\n项目B旧回执。',
  }));
  const secondPath = f.store.receiptPath('local-project-b', 'task-a');
  fs.renameSync(secondPath, f.store.legacyReceiptPath('task-a'));
  assert.equal(f.store.list({ projectId: 'local-project-a' }).count, 1);
  assert.equal(f.store.list({ projectId: 'local-project-b' }).records[0].receiptId, second.record.receiptId);
});

test('same task id in two projects has separate pending files and project-bound acknowledgement', () => {
  const f = fixture('project-namespace');
  const first = f.store.enqueue(receipt());
  const second = f.store.enqueue(receipt({
    projectId: 'local-project-b',
    finalText: '已完成\n项目B结果已经交付。',
  }));
  assert.equal(f.store.list({ projectId: 'local-project-a', taskId: 'task-a' }).count, 1);
  assert.equal(f.store.list({ projectId: 'local-project-b', taskId: 'task-a' }).count, 1);
  assert.equal(fs.readdirSync(f.store.pendingRoot).filter((name) => name.endsWith('.json')).length, 2);
  assert.notEqual(f.store.receiptPath('local-project-a', 'task-a'), f.store.receiptPath('local-project-b', 'task-a'));
  assert.throws(() => f.store.acknowledge({
    projectId: 'local-project-a', taskId: 'task-a', receiptId: second.record.receiptId,
  }), /stale acknowledgement|project mismatch/);
  assert.equal(f.store.list({ projectId: 'local-project-b' }).count, 1);
  assert.equal(f.store.acknowledge({
    projectId: 'local-project-a', taskId: 'task-a', receiptId: first.record.receiptId,
  }).removed, true);
  assert.equal(f.store.list({ projectId: 'local-project-b' }).count, 1);
});

test('runtime keeps the same task id isolated across projects and rejects cross-project ack', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-runtime-namespace-'));
  registerProject(root, 'local-project-a');
  registerProject(root, 'local-project-b');
  const first = runtime(root, 'runtime-namespace-a', 'worker-result.enqueue', receipt()).result.record;
  const second = runtime(root, 'runtime-namespace-b', 'worker-result.enqueue', receipt({
    projectId: 'local-project-b', finalText: '已完成\n项目B结果已经交付。',
  })).result.record;
  assert.equal(runtime(root, 'runtime-list-a', 'worker-result.list', {
    projectId: 'local-project-a', taskId: 'task-a',
  }).result.count, 1);
  assert.equal(runtime(root, 'runtime-list-b', 'worker-result.list', {
    projectId: 'local-project-b', taskId: 'task-a',
  }).result.count, 1);
  assert.throws(() => runtime(root, 'runtime-cross-ack', 'worker-result.ack', {
    projectId: 'local-project-a', taskId: 'task-a', receiptId: second.receiptId,
  }), /stale acknowledgement|project mismatch/);
  runtime(root, 'runtime-ack-a', 'worker-result.ack', {
    projectId: 'local-project-a', taskId: 'task-a', receiptId: first.receiptId,
  });
  assert.equal(runtime(root, 'runtime-list-b-after-a', 'worker-result.list', {
    projectId: 'local-project-b', taskId: 'task-a',
  }).result.count, 1);
});

test('a crash after workbench acceptance retries the same operation without duplicate history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-crash-'));
  registerProject(root);
  fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'local', '当前工作台.md'), '# 当前工作台\n', 'utf8');
  runtime(root, 'register-crash', 'workbench.register', {
    taskId: 'task-crash', task: '中断恢复任务', worker: 'worker-crash', status: '进行中', progress: '执行中',
    pause: '无', result: '无', updatedAt: '2026-08-23T16:00:00+08:00',
  });
  const pending = runtime(root, 'enqueue-crash', 'worker-result.enqueue', receipt({
    taskId: 'task-crash', finalText: '已完成\n中断恢复任务已经交付。',
  })).result.record;
  const acceptance = {
    operationId: `accept-${pending.receiptId}`, taskId: 'task-crash', worker: 'worker-crash', expectedStatus: '进行中',
    businessState: '已完成', acceptedBy: 'pm-main', acceptance: 'accepted',
    acceptedAt: '2026-08-23T16:03:00+08:00', finalLocator: 'thread://worker-crash',
    evidenceLocator: 'git://commit-crash', conclusion: '中断恢复任务完成', completedAt: '2026-08-23T16:03:00+08:00',
    affectsMainline: true, pendingDependencies: [],
  };
  const first = runtime(root, 'accept-crash-first', 'workbench.accept', acceptance).result;
  assert.equal(runtime(root, 'pending-after-crash', 'worker-result.list', {
    projectId: 'local-project-a', taskId: 'task-crash',
  }).result.count, 1);
  const retried = runtime(root, 'accept-crash-retry', 'workbench.accept', acceptance).result;
  assert.deepEqual(retried, first);
  runtime(root, 'ack-crash', 'worker-result.ack', {
    projectId: 'local-project-a', taskId: 'task-crash', receiptId: pending.receiptId,
  });
  const history = JSON.parse(fs.readFileSync(path.join(root, 'local', 'history', 'workbench', '2026-08.json'), 'utf8'));
  assert.equal(history.records.filter((record) => record.taskId === 'task-crash').length, 1);
});

test('runtime lifecycle keeps one task through pause, resume, completion and receipt deletion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-runtime-'));
  registerProject(root);
  fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'local', '当前工作台.md'), '# 当前工作台\n', 'utf8');
  runtime(root, 'register-a', 'workbench.register', {
    taskId: 'task-a', task: '任务A', worker: '01a00000-0000-7000-8000-000000000001', status: '进行中', progress: '执行中',
    pause: '无', result: '无', updatedAt: '2026-08-23T16:00:00+08:00',
  });
  const pauseReceipt = runtime(root, 'receipt-pause-a', 'worker-result.enqueue', receipt({
    businessState: '已暂停', finalText: '已暂停\n等待目标代号。',
  })).result.record;
  runtime(root, 'pause-a', 'workbench.pause', {
    operationId: `pause-${pauseReceipt.receiptId}`, taskId: 'task-a', expectedStatus: '进行中', status: '已暂停', businessState: '已暂停',
    progress: '等待目标代号', pause: '提供目标代号后恢复', result: `worker-result://${pauseReceipt.receiptId}`,
    updatedAt: '2026-08-23T16:01:00+08:00',
  });
  runtime(root, 'ack-pause-a', 'worker-result.ack', {
    projectId: 'local-project-a', taskId: 'task-a', receiptId: pauseReceipt.receiptId,
  });
  runtime(root, 'resume-a', 'workbench.update', {
    operationId: 'resume-a', taskId: 'task-a', expectedStatus: '已暂停', status: '进行中',
    progress: '继续处理', pause: '无', updatedAt: '2026-08-23T16:02:00+08:00',
  });
  const completedReceipt = runtime(root, 'receipt-complete-a', 'worker-result.enqueue', receipt({
    finalText: '已完成\n目标代号已经处理。', createdAt: '2026-08-23T08:03:00.000Z',
  })).result.record;
  runtime(root, 'accept-a', 'workbench.accept', {
    operationId: `accept-${completedReceipt.receiptId}`, taskId: 'task-a', worker: '01a00000-0000-7000-8000-000000000001', expectedStatus: '进行中',
    businessState: '已完成', acceptedBy: 'pm-main', acceptance: 'accepted',
    acceptedAt: '2026-08-23T16:03:00+08:00', finalLocator: `worker-result://${completedReceipt.receiptId}`,
    evidenceLocator: 'git://commit-a', conclusion: '任务A完成', completedAt: '2026-08-23T16:03:00+08:00',
    affectsMainline: true, pendingDependencies: [],
  });
  runtime(root, 'ack-complete-a', 'worker-result.ack', {
    projectId: 'local-project-a', taskId: 'task-a', receiptId: completedReceipt.receiptId,
  });
  assert.equal(runtime(root, 'list-empty', 'worker-result.list', { projectId: 'local-project-a' }).result.count, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'local', 'runtime', 'workbench', 'workbench-state.json'), 'utf8')).tasks['task-a'], undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'local', 'history', 'workbench', '2026-08.json'), 'utf8')).records.length, 1);
});

test('fixed beyond-control CLI enqueues, lists and acknowledges the same receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-cli-'));
  const controlRoot = path.join(root, 'beyond-control');
  fs.mkdirSync(path.join(controlRoot, 'scripts'), { recursive: true });
  registerProject(controlRoot);
  fs.cpSync(path.join(import.meta.dirname, '..', '模板交付包', 'scripts', 'runtime'), path.join(controlRoot, 'scripts', 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, '..', '模板交付包', 'scripts', 'beyond-control.mjs'), path.join(controlRoot, 'scripts', 'beyond-control.mjs'));
  const invoke = (name, action, input, includeRequestId = true) => {
    const request = path.join(root, `${name}.json`);
    const envelope = { schemaVersion: 1, action, input };
    if (includeRequestId) envelope.requestId = name;
    fs.writeFileSync(request, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    const result = spawnSync(process.execPath, [path.join(controlRoot, 'scripts', 'beyond-control.mjs'), 'runtime', '--request', request], {
      cwd: projectRootFor(controlRoot), encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    return output.result;
  };
  const created = invoke('cli-enqueue', 'worker-result.enqueue', receipt(), false).record;
  assert.equal(invoke('cli-list', 'worker-result.list', { projectId: 'local-project-a', taskId: 'task-a' }).count, 1);
  assert.equal(invoke('cli-ack', 'worker-result.ack', {
    projectId: 'local-project-a', taskId: 'task-a', receiptId: created.receiptId,
  }).removed, true);
  assert.equal(invoke('cli-empty', 'worker-result.list', { projectId: 'local-project-a' }).count, 0);
});
