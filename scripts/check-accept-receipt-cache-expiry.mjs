import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { executeRuntimeRequest } from '../模板交付包/scripts/runtime/control-runtime.mjs';

// Independent regression: drive normal register/enqueue/accept/update actions,
// then inspect durable evidence after the 100-entry operation cache evicts accept.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-accept-cache-expiry-'));
const projectId = 'local-accept-cache-probe';
const taskId = 'accepted-task';
const completedAt = '2026-09-27T08:00:00.000Z';
const seed = path.join(root, 'seed');
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function paths(directory) {
  const controlRoot = path.join(directory, 'beyond-control');
  return {
    directory, controlRoot, projectRoot: directory,
    state: path.join(controlRoot, 'local', 'runtime', 'workbench', 'workbench-state.json'),
    history: path.join(controlRoot, 'local', 'history', 'workbench', '2026-09.json'),
    transaction: () => path.join(controlRoot, 'local', 'runtime', 'workbench', 'transactions', `${operationId}.json`),
  };
}

function bindProject(f) {
  fs.mkdirSync(path.join(f.controlRoot, 'local', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(f.controlRoot, 'local', 'projects', `${projectId}.md`), [
    '---', `id: ${projectId}`, `path: ${f.projectRoot}`,
    `repositories_json: ${JSON.stringify([{ path: f.projectRoot, remote: null, role: 'project-root' }])}`,
    '---', '',
  ].join('\n'));
  fs.writeFileSync(path.join(f.projectRoot, 'AGENTS.md'), [
    '<!-- BEYOND-RUNTIME-VERSION: 3.2.7 -->',
    '<!-- BEYOND-CONTROL-ROOT: beyond-control -->',
    `<!-- BEYOND-PROJECT-ID: ${projectId} -->`, '',
  ].join('\n'));
}

let requestCount = 0;
function run(f, action, input) {
  return executeRuntimeRequest({ schemaVersion: 1, requestId: `cache-probe-${++requestCount}`, action, input }, {
    controlRoot: f.controlRoot, executionRoot: f.projectRoot,
  }).result;
}

const f = paths(seed);
bindProject(f);
fs.writeFileSync(path.join(f.controlRoot, 'local', '当前工作台.md'), '# 当前工作台\n');
function register(fixture, id, worker) {
  return run(fixture, 'workbench.register', {
    projectId, taskId: id, task: id, worker, status: '进行中', progress: '执行中',
    pause: '无', result: '无', updatedAt: completedAt,
  });
}
register(f, taskId, 'worker-a');
const receipt = run(f, 'worker-result.enqueue', {
  projectId, taskId, workerThreadId: 'worker-a', sourceThreadId: 'pm-a',
  businessState: '已完成', finalText: '已完成\n验收目标已交付。', createdAt: completedAt,
}).record;
const operationId = `accept-${receipt.receiptId}`;
const acceptance = {
  projectId, operationId, taskId, worker: 'worker-a', expectedStatus: '进行中',
  businessState: '已完成', acceptedBy: 'pm-a', acceptance: 'accepted',
  acceptedAt: completedAt, completedAt, finalLocator: 'thread:worker-a#turn:completed-a',
  evidenceLocator: 'evidence:accepted-task', conclusion: '当前一手证据证明目标完成',
  affectsMainline: true, pendingDependencies: [],
};
run(f, 'workbench.accept', acceptance);
const cachedOperation = structuredClone(readJson(f.state).operations[operationId]);
const cachedSeed = path.join(root, 'cached-seed');
fs.cpSync(seed, cachedSeed, { recursive: true });
register(f, 'other-task', 'worker-b');
for (let index = 0; index < 101; index += 1) {
  run(f, 'workbench.update', {
    projectId, operationId: `other-update-${index}`, taskId: 'other-task', expectedStatus: '进行中',
    status: '进行中', progress: `其他任务进度 ${index}`, pause: '无', result: '无', updatedAt: completedAt,
  });
}
const evictedState = readJson(f.state);
assert.equal(Object.hasOwn(evictedState.operations, operationId), false);
assert.equal(evictedState.operationOrder.includes(operationId), false);
assert.equal(evictedState.operationOrder.length, 100);
assert.equal(Object.keys(evictedState.operations).length, 100);

after(() => {
  // Only the exact per-run directory returned by mkdtemp is removed.
  assert.equal(path.dirname(root), os.tmpdir());
  assert.match(path.basename(root), /^beyond-accept-cache-expiry-/);
  fs.rmSync(root, { recursive: true, force: true });
});

let fixtureCount = 0;
function fixture({ cached = false } = {}) {
  const directory = path.join(root, `case-${++fixtureCount}`);
  fs.cpSync(cached ? cachedSeed : seed, directory, { recursive: true });
  const result = paths(directory);
  bindProject(result);
  return result;
}

function fingerprint(directory) {
  const files = {};
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else files[path.relative(directory, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  }
  visit(directory);
  return files;
}

function inspect(fixture) {
  const before = fingerprint(fixture.directory);
  const result = run(fixture, 'workbench.inspect', { projectId, taskId });
  assert.deepEqual(fingerprint(fixture.directory), before, 'inspection must be read-only');
  assert.equal(result.pendingReceiptCount, 1);
  assert.equal(result.records[0].receiptId, receipt.receiptId);
  return result.records[0];
}

function mutate(file, change) {
  const value = readJson(file);
  change(value);
  writeJson(file, value);
}

test('a cached committed acceptance remains eligible for ack', () => {
  assert.equal(inspect(fixture({ cached: true })).disposition, 'ack-committed-receipt');
});

test('101 unrelated updates evict accept but durable evidence permits ack without reaccept', () => {
  const current = fixture();
  const inspected = inspect(current);
  assert.equal(inspected.disposition, 'ack-committed-receipt');
  assert.equal(inspected.expectedOperationId, operationId);
  const stateBeforeAck = fs.readFileSync(current.state, 'utf8');
  const historyBeforeAck = fs.readFileSync(current.history, 'utf8');
  assert.equal(run(current, 'worker-result.ack', { projectId, taskId, receiptId: receipt.receiptId }).removed, true);
  assert.equal(run(current, 'worker-result.list', { projectId, taskId }).count, 0);
  assert.equal(fs.readFileSync(current.state, 'utf8'), stateBeforeAck);
  assert.equal(fs.readFileSync(current.history, 'utf8'), historyBeforeAck);
  assert.equal(readJson(current.history).records.filter((record) => record.taskId === taskId).length, 1);
});

test('legacy completed accept transactions without kind retain compatibility', () => {
  const current = fixture();
  mutate(current.transaction(), (transaction) => { delete transaction.kind; });
  assert.equal(inspect(current).disposition, 'ack-committed-receipt');
});

const corruptions = [
  ['transaction absent', (c) => fs.unlinkSync(c.transaction())],
  ['history absent', (c) => fs.unlinkSync(c.history)],
  ['transaction operationId', (c) => mutate(c.transaction(), (t) => { t.operationId = 'accept-unrelated'; })],
  ['transaction kind', (c) => mutate(c.transaction(), (t) => { t.kind = 'closed'; })],
  ['transaction phase', (c) => mutate(c.transaction(), (t) => { t.phase = 'stateCommitted'; })],
  ['transaction completedAt', (c) => mutate(c.transaction(), (t) => { t.completedAt = '2026-09-27T08:01:00.000Z'; })],
  ['transaction digest missing', (c) => mutate(c.transaction(), (t) => { delete t.inputDigest; })],
  ['output operationId', (c) => mutate(c.transaction(), (t) => { t.output.operationId = 'accept-unrelated'; })],
  ['output taskId', (c) => mutate(c.transaction(), (t) => { t.output.taskId = 'unrelated-task'; })],
  ['output worker', (c) => mutate(c.transaction(), (t) => { t.output.worker = 'unrelated-worker'; })],
  ['output status', (c) => mutate(c.transaction(), (t) => { t.output.status = '已关闭'; })],
  ['output archive flag', (c) => mutate(c.transaction(), (t) => { t.output.archived = false; })],
  ['output future revision', (c) => mutate(c.transaction(), (t) => { t.output.stateRevision = 999999; })],
  ['history operationId', (c) => mutate(c.history, (h) => { h.records[0].operationId = 'accept-unrelated'; })],
  ['history taskId', (c) => mutate(c.history, (h) => { h.records[0].taskId = 'unrelated-task'; })],
  ['history worker', (c) => mutate(c.history, (h) => { h.records[0].worker = 'unrelated-worker'; })],
  ['history status', (c) => mutate(c.history, (h) => { h.records[0].status = '已关闭'; })],
  ['history completedAt', (c) => mutate(c.history, (h) => { h.records[0].completedAt = '2026-09-27T08:02:00.000Z'; })],
  ['duplicate history identity', (c) => mutate(c.history, (h) => { h.records.push(structuredClone(h.records[0])); })],
  ['active task reappears', (c) => mutate(c.state, (s) => {
    s.tasks[taskId] = { taskId, task: taskId, worker: 'worker-a', status: '进行中',
      progress: '重新出现', pause: '无', result: '无', updatedAt: completedAt };
  })],
  ['output and history Worker differ from receipt', (c) => {
    mutate(c.transaction(), (t) => { t.output.worker = 'worker-other'; });
    mutate(c.history, (h) => { h.records[0].worker = 'worker-other'; });
  }],
  ['indexed missing cache is not eviction', (c) => mutate(c.state, (s) => { s.operationOrder.push(operationId); })],
  ['present null cache is not eviction', (c) => mutate(c.state, (s) => { s.operations[operationId] = null; })],
  ['present cache digest conflicts', (c) => mutate(c.state, (s) => {
    s.operations[operationId] = { ...structuredClone(cachedOperation), inputDigest: '0'.repeat(64) };
  })],
  ['present cache output conflicts', (c) => mutate(c.state, (s) => {
    s.operations[operationId] = structuredClone(cachedOperation);
    s.operations[operationId].output.worker = 'worker-other';
  })],
  ['present cache history conflicts', (c) => mutate(c.state, (s) => {
    s.operations[operationId] = structuredClone(cachedOperation);
    s.operations[operationId].historyRecord.evidence = 'evidence:unrelated';
  })],
];

for (const [label, change] of corruptions) {
  test(`expired acceptance preserves pending when ${label}`, () => {
    const current = fixture();
    change(current);
    assert.equal(inspect(current).disposition, 'preserve-conflict');
  });
}
