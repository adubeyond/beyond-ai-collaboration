import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InjectedFault, WorkbenchTransactionStore } from '../模板交付包/scripts/runtime/workbench-transaction.mjs';

function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `beyond-workbench-${name}-`));
  const local = path.join(root, 'local');
  fs.mkdirSync(local, { recursive: true });
  const viewPath = path.join(local, '当前工作台.md');
  fs.writeFileSync(viewPath, '# 我的工作台\n\n用户自由正文。\n', 'utf8');
  return {
    root,
    store: new WorkbenchTransactionStore({
      runtimeRoot: path.join(local, 'runtime', 'workbench'),
      viewPath,
      historyRoot: path.join(local, 'history', 'workbench'),
    }),
  };
}

function seed(f, taskId = 'task-a', worker = 'worker-a') {
  return f.store.registerTask({
    taskId, task: `任务-${taskId}`, worker, status: '进行中', progress: '处理中',
    pause: '无', result: '无', updatedAt: '2026-08-18T12:00:00+08:00',
  });
}

function completion(overrides = {}) {
  return {
    operationId: 'accept-worker-a-final-1',
    taskId: 'task-a',
    worker: 'worker-a',
    expectedStatus: '进行中',
    businessState: '已完成',
    acceptedBy: 'pm-main',
    acceptance: 'accepted',
    acceptedAt: '2026-08-18T12:05:00+08:00',
    finalLocator: 'thread://worker-a/final',
    evidenceLocator: 'file://evidence.md',
    conclusion: '任务A完成并通过验收',
    completedAt: '2026-08-18T12:06:00+08:00',
    affectsMainline: true,
    pendingDependencies: [],
    ...overrides,
  };
}

test('register preserves free text and rejects a second owner', () => {
  const f = fixture('register');
  seed(f);
  assert.match(f.store.view(), /用户自由正文/);
  assert.throws(() => seed(f, 'task-b', 'worker-a'), /worker already owns/);
});

test('pause and resume keep one task', () => {
  const f = fixture('pause');
  seed(f);
  f.store.updateTask({
    operationId: 'pause-a', taskId: 'task-a', expectedStatus: '进行中', status: '已暂停',
    progress: '等待授权', pause: '等待老板确认后恢复', updatedAt: '2026-08-18T12:01:00+08:00',
  });
  f.store.updateTask({
    operationId: 'resume-a', taskId: 'task-a', expectedStatus: '已暂停', status: '进行中',
    progress: '继续处理', pause: '无', updatedAt: '2026-08-18T12:02:00+08:00',
  });
  assert.equal(Object.keys(f.store.snapshot().tasks).length, 1);
});

test('accepted Worker final closes only its task and writes history once', () => {
  const f = fixture('accept');
  seed(f);
  seed(f, 'task-b', 'worker-b');
  const first = f.store.consumeAcceptedResult(completion());
  assert.equal(first.status, '已完成');
  assert.deepEqual(Object.keys(f.store.snapshot().tasks), ['task-b']);
  assert.equal(f.store.history('2026-08').records.length, 1);
  assert.deepEqual(f.store.consumeAcceptedResult(completion()), first);
  assert.equal(f.store.history('2026-08').records.length, 1);
});

test('non-final or rejected input leaves the task active', () => {
  const f = fixture('reject');
  seed(f);
  assert.throws(() => f.store.consumeAcceptedResult(completion({ businessState: '进行中' })), /completed Worker final/);
  assert.throws(() => f.store.consumeAcceptedResult(completion({ acceptance: 'rejected' })), /PM acceptance/);
  assert.equal(f.store.snapshot().tasks['task-a'].status, '进行中');
});

test('changed reuse of an operation id is rejected', () => {
  const f = fixture('reuse');
  seed(f);
  f.store.consumeAcceptedResult(completion());
  assert.throws(() => f.store.consumeAcceptedResult(completion({ conclusion: 'changed' })), /reused with different input/);
});

test('fault after intent keeps active state and recovery completes once', () => {
  const f = fixture('fault-intent');
  seed(f);
  assert.throws(() => f.store.consumeAcceptedResult(completion(), { faultAt: 'afterIntent' }), (e) => e instanceof InjectedFault);
  assert.equal(f.store.snapshot().tasks['task-a'].status, '进行中');
  assert.equal(f.store.recover().recoveredOperations.length, 1);
  assert.equal(f.store.history('2026-08').records.length, 1);
});

test('fault after state commit recovers history and view', () => {
  const f = fixture('fault-state');
  seed(f);
  assert.throws(() => f.store.consumeAcceptedResult(completion(), { faultAt: 'afterStateCommit' }), (e) => e instanceof InjectedFault);
  assert.equal(f.store.snapshot().tasks['task-a'], undefined);
  assert.equal(f.store.history('2026-08').records.length, 0);
  f.store.recover();
  assert.equal(f.store.history('2026-08').records.length, 1);
  assert.match(f.store.view(), /当前无活动正式任务/);
});

test('managed view drift is repaired without deleting free text', () => {
  const f = fixture('drift');
  seed(f);
  const view = path.join(f.root, 'local', '当前工作台.md');
  fs.writeFileSync(view, '# 我的工作台\n\n用户自由正文。\n\n<!-- BEGIN BEYOND MANAGED WORKBENCH -->\nstale\n<!-- END BEYOND MANAGED WORKBENCH -->\n', 'utf8');
  assert.equal(f.store.recoveryStatus().viewMatchesState, false);
  f.store.recover();
  assert.match(f.store.view(), /用户自由正文/);
  assert.match(f.store.view(), /任务-task-a/);
});
