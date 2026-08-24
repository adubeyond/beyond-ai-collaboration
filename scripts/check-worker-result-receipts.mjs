import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeRuntimeRequest } from '../模板交付包/scripts/runtime/control-runtime.mjs';
import { WorkerResultReceiptStore } from '../模板交付包/scripts/runtime/worker-result-receipts.mjs';

function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `beyond-worker-result-${name}-`));
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
  return executeRuntimeRequest({ schemaVersion: 1, requestId, action, input }, { controlRoot });
}

test('worker-result actions derive requestId when the envelope omits it', () => {
  const f = fixture('derived-request-id');
  const created = executeRuntimeRequest({
    schemaVersion: 1,
    action: 'worker-result.enqueue',
    input: receipt(),
  }, { controlRoot: f.root });
  assert.equal(created.requestId, 'worker-result.enqueue:task-a');
  assert.equal(created.result.mode, 'created');
  assert.throws(() => executeRuntimeRequest({
    schemaVersion: 1,
    action: 'workbench.migrate',
    input: {},
  }, { controlRoot: f.root }), /requestId is required/);
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
  assert.equal(f.store.list({ taskId: 'task-a' }).count, 1);
});

test('a newer terminal result replaces the same task without creating history', () => {
  const f = fixture('replace');
  const paused = f.store.enqueue(receipt({ businessState: '已暂停', finalText: '已暂停\n等待目标代号。' }));
  const completed = f.store.enqueue(receipt({ finalText: '已完成\n目标代号已经处理。', createdAt: '2026-08-23T08:02:00.000Z' }));
  assert.equal(completed.mode, 'replaced');
  assert.equal(completed.supersededReceiptId, paused.record.receiptId);
  assert.deepEqual(f.store.list({ taskId: 'task-a' }).records, [completed.record]);
  assert.equal(fs.existsSync(path.join(f.root, 'worker-results', 'history')), false);
});

test('stale acknowledgement cannot remove a newer result', () => {
  const f = fixture('stale-ack');
  const paused = f.store.enqueue(receipt({ businessState: '已暂停', finalText: '已暂停\n等待目标代号。' }));
  const completed = f.store.enqueue(receipt({ finalText: '已完成\n目标代号已经处理。' }));
  assert.throws(() => f.store.acknowledge({
    taskId: 'task-a', receiptId: paused.record.receiptId,
  }), /stale acknowledgement/);
  assert.equal(f.store.list({ taskId: 'task-a' }).records[0].receiptId, completed.record.receiptId);
});

test('acknowledgement deletes the body instead of archiving it', () => {
  const f = fixture('ack');
  const created = f.store.enqueue(receipt());
  const result = f.store.acknowledge({
    taskId: 'task-a', receiptId: created.record.receiptId,
  });
  assert.equal(result.removed, true);
  assert.equal(f.store.list({}).count, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'worker-results', 'history')), false);
});

test('optional Worker identity is checked when both producer and consumer provide it', () => {
  const f = fixture('optional-worker');
  const created = f.store.enqueue(receipt({ workerThreadId: 'worker-a' }));
  assert.equal(f.store.list({ workerThreadId: 'worker-a' }).count, 1);
  assert.throws(() => f.store.acknowledge({
    taskId: 'task-a', receiptId: created.record.receiptId, workerThreadId: 'worker-b',
  }), /owner mismatch/);
  assert.equal(f.store.list({ taskId: 'task-a' }).count, 1);
});

test('invalid state, mismatched final and corrupted pending data fail visibly', () => {
  const f = fixture('invalid');
  assert.throws(() => f.store.enqueue(receipt({ businessState: '进行中' })), /businessState/);
  assert.throws(() => f.store.enqueue(receipt({ businessState: '已暂停' })), /finalText must start/);
  fs.mkdirSync(f.store.pendingRoot, { recursive: true });
  fs.writeFileSync(path.join(f.store.pendingRoot, 'broken.json'), '{', 'utf8');
  assert.throws(() => f.store.list({}), /cannot read Worker result receipt/);
});

test('pending receipt survives process restart until acknowledgement', () => {
  const f = fixture('restart');
  const created = f.store.enqueue(receipt());
  const restarted = new WorkerResultReceiptStore({ runtimeRoot: path.join(f.root, 'worker-results') });
  assert.equal(restarted.list({ taskId: 'task-a' }).records[0].receiptId, created.record.receiptId);
});

test('a crash after workbench acceptance retries the same operation without duplicate history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-crash-'));
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
  assert.equal(runtime(root, 'pending-after-crash', 'worker-result.list', { taskId: 'task-crash' }).result.count, 1);
  const retried = runtime(root, 'accept-crash-retry', 'workbench.accept', acceptance).result;
  assert.deepEqual(retried, first);
  runtime(root, 'ack-crash', 'worker-result.ack', { taskId: 'task-crash', receiptId: pending.receiptId });
  const history = JSON.parse(fs.readFileSync(path.join(root, 'local', 'history', 'workbench', '2026-08.json'), 'utf8'));
  assert.equal(history.records.filter((record) => record.taskId === 'task-crash').length, 1);
});

test('runtime lifecycle keeps one task through pause, resume, completion and receipt deletion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-runtime-'));
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
    taskId: 'task-a', receiptId: pauseReceipt.receiptId,
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
    taskId: 'task-a', receiptId: completedReceipt.receiptId,
  });
  assert.equal(runtime(root, 'list-empty', 'worker-result.list', {}).result.count, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'local', 'runtime', 'workbench', 'workbench-state.json'), 'utf8')).tasks['task-a'], undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'local', 'history', 'workbench', '2026-08.json'), 'utf8')).records.length, 1);
});

test('fixed beyond-control CLI enqueues, lists and acknowledges the same receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-worker-result-cli-'));
  const controlRoot = path.join(root, 'beyond-control');
  fs.mkdirSync(path.join(controlRoot, 'scripts'), { recursive: true });
  fs.cpSync(path.join(import.meta.dirname, '..', '模板交付包', 'scripts', 'runtime'), path.join(controlRoot, 'scripts', 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, '..', '模板交付包', 'scripts', 'beyond-control.mjs'), path.join(controlRoot, 'scripts', 'beyond-control.mjs'));
  const invoke = (name, action, input, includeRequestId = true) => {
    const request = path.join(root, `${name}.json`);
    const envelope = { schemaVersion: 1, action, input };
    if (includeRequestId) envelope.requestId = name;
    fs.writeFileSync(request, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    const result = spawnSync(process.execPath, [path.join(controlRoot, 'scripts', 'beyond-control.mjs'), 'runtime', '--request', request], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    return output.result;
  };
  const created = invoke('cli-enqueue', 'worker-result.enqueue', receipt(), false).record;
  assert.equal(invoke('cli-list', 'worker-result.list', { taskId: 'task-a' }).count, 1);
  assert.equal(invoke('cli-ack', 'worker-result.ack', { taskId: 'task-a', receiptId: created.receiptId }).removed, true);
  assert.equal(invoke('cli-empty', 'worker-result.list', {}).count, 0);
});
