import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WorkbenchTransactionStore } from './workbench-transaction.mjs';
import { executeRuntimeRequest } from './control-runtime.mjs';
import { CliTaskStore, digest, sha256File } from '../cli/cli-task-store.mjs';
import { launchCliRequest } from '../cli/cli-bridge.mjs';
import { currentProcessIdentity } from '../cli/process-identity.mjs';

const now = '2026-10-20T13:00:00.000Z';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-delivery-test-'));
  const controlRoot = path.join(root, 'beyond-control');
  const store = new WorkbenchTransactionStore({
    runtimeRoot: path.join(controlRoot, 'local/runtime/workbench'),
    viewPath: path.join(controlRoot, 'local/当前工作台.md'),
    historyRoot: path.join(controlRoot, 'local/history/workbench'),
  });
  fs.mkdirSync(path.join(controlRoot, 'local/projects'), { recursive: true });
  fs.writeFileSync(path.join(controlRoot, 'local/projects/test.md'), `---\nid: project-test\npath: ${root.replaceAll('\\', '/')}\n---\n`);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '<!-- BEYOND-CONTROL-ROOT: ./beyond-control -->\n<!-- BEYOND-PROJECT-ID: project-test -->\n');
  const original = path.join(root, 'existing-session-and-result.json');
  fs.writeFileSync(original, '{"sessionId":"original","result":"keep"}');
  t.after(() => {
    assert.equal(fs.readFileSync(original, 'utf8'), '{"sessionId":"original","result":"keep"}');
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith('beyond-delivery-test-'));
    fs.rmSync(actual, { recursive: true });
  });
  const runtime = (action, input, ownerThreadId = 'owner-test') => executeRuntimeRequest({
    schemaVersion: 1, requestId: `${action}-${input.operationId ?? input.taskId ?? 'read'}`, action, input,
  }, { controlRoot, executionRoot: root, ownerThreadId }).result;
  return { store, root, controlRoot, runtime };
}
function task(taskId = 'goal-a', override = {}) {
  return {
    taskId, projectId: 'project-test', task: `${taskId} 独立业务结果`,
    worker: `worker-${taskId}`, status: '进行中', progress: '开发与真实联调', pause: '无', updatedAt: now,
    deliveryContract: {
      schemaVersion: 1, outcome: `${taskId} 用户能完成当前约定业务流程`,
      scope: ['当前用户流程'], outOfScope: ['其他模块'],
      requirementsLocator: 'project/docs/requirements.md#current',
      designLocator: 'project/docs/design.md#current',
      resultOwnerThreadId: `worker-${taskId}`, acceptanceOwnerThreadId: 'owner-test',
      authorization: { source: 'user-message', locator: 'source-thread/message-original' },
      criteria: [{ id: 'business-path', expected: '真实输入经真实接口得到约定结果' }],
      consumes: [],
    },
    ...override,
  };
}
function acceptance(registered, override = {}) {
  return {
    operationId: `accept-${registered.taskId}`, taskId: registered.taskId, worker: registered.worker,
    expectedStatus: registered.status, acceptance: 'accepted', acceptedBy: registered.deliveryContract?.acceptanceOwnerThreadId ?? 'owner-test',
    acceptedAt: now, completedAt: now, businessState: '已完成',
    finalLocator: `results/${registered.taskId}.md`, evidenceLocator: `evidence/${registered.taskId}.md`,
    conclusion: '当前约定结果已实际验证', affectsMainline: true,
    ...(registered.deliveryContract ? { expectedDeliveryContract: structuredClone(registered.deliveryContract) } : {}),
    deliveryEvidence: { criteria: [{ id: 'business-path', observed: '输入A得到B且页面实际可消费', evidenceLocator: 'evidence/real-path.json' }], consumedResults: [] },
    ...override,
  };
}
function readPlan(previous = 'goal-a', nextTaskId = 'goal-b') {
  return { projectId: 'project-test', previousTaskId: previous, previousOperationId: `accept-${previous}`, nextTaskId };
}
function accept(store, record) {
  store.registerTask(record);
  return store.consumeAcceptedResult(acceptance(record));
}

test('formal result uses its named executor and separate acceptance owner without requiring an assistant or CLI', t => {
  const { store, runtime } = fixture(t), record = task();
  runtime('workbench.register', record);
  const output = runtime('workbench.accept', acceptance(record));
  assert.equal(output.status, '已完成');
  const history = store.history('2026-10').records[0];
  assert.deepEqual(history.deliveryContract, record.deliveryContract);
  assert.deepEqual(history.deliveryEvidence, acceptance(record).deliveryEvidence);
  assert.match(output.deliveryRecordSha256, /^[a-f0-9]{64}$/);
});

test('historical tasks without delivery metadata retain existing acceptance behavior', t => {
  const { store } = fixture(t), record = task();
  delete record.deliveryContract;
  store.registerTask(record);
  const input = acceptance(record); delete input.deliveryEvidence;
  store.consumeAcceptedResult(input);
  assert.equal(store.history('2026-10').records[0].deliveryContract, undefined);
});

for (const [name, mutate, error] of [
  ['missing criteria', r => { r.deliveryContract.criteria = []; }, /criteria/],
  ['duplicate criteria', r => { r.deliveryContract.criteria.push(r.deliveryContract.criteria[0]); }, /criteria/],
  ['missing result scope', r => { r.deliveryContract.scope = []; }, /contract/],
  ['unrelated result owner', r => { r.deliveryContract.resultOwnerThreadId = 'other'; }, /owner/],
  ['formal executor self-acceptance', r => { r.deliveryContract.acceptanceOwnerThreadId = r.worker; }, /executor as acceptance/],
  ['assistant opinion as authority', r => { r.deliveryContract.authorization.source = 'assistant-opinion'; }, /authorization/],
  ['authorized boolean without source', r => { r.deliveryContract.authorization = { authorized: true }; }, /authorization/],
  ['self dependency', r => { r.deliveryContract.consumes = [{ taskId: r.taskId, contractLocator: 'contract/a' }]; }, /consumer/],
]) {
  test(`reject ${name} without mutating workbench`, t => {
    const { store } = fixture(t), record = task(), before = store.snapshot();
    mutate(record); assert.throws(() => store.registerTask(record), error);
    assert.deepEqual(store.snapshot(), before);
  });
}

for (const [name, mutate, error] of [
  ['build-only delivery without criteria', i => { i.deliveryEvidence.criteria = []; }, /every agreed/],
  ['different criterion', i => { i.deliveryEvidence.criteria[0].id = 'build'; }, /every agreed/],
  ['empty observed behavior', i => { i.deliveryEvidence.criteria[0].observed = ''; }, /every agreed/],
  ['wrong acceptance owner', i => { i.acceptedBy = 'unrelated-pm'; }, /owner mismatch/],
]) {
  test(`reject ${name} and preserve the active goal`, t => {
    const { store } = fixture(t), record = task(); store.registerTask(record);
    const input = acceptance(record), before = store.snapshot();
    mutate(input); assert.throws(() => store.consumeAcceptedResult(input), error);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(store.history('2026-10').records.length, 0);
  });
}

test('frontend/backend accepted inputs require combined-path evidence and exact consumed result identity', t => {
  const { store } = fixture(t);
  const backend = task('backend'), frontend = task('frontend');
  backend.deliveryContract.designLocator = 'contracts/api-v2';
  accept(store, backend);
  frontend.deliveryContract.consumes = [{ taskId: backend.taskId, contractLocator: 'contracts/api-v2' }];
  store.registerTask(frontend);
  const input = acceptance(frontend);
  assert.throws(() => store.consumeAcceptedResult(input), /exact consumed/);
  input.deliveryEvidence.consumedResults = [{
    taskId: backend.taskId, operationId: 'accept-backend', contractLocator: 'contracts/api-v2', resultLocator: 'results/backend.md',
  }];
  assert.throws(() => store.consumeAcceptedResult(input), /integration evidence/);
  input.deliveryEvidence.integrationEvidenceLocator = 'evidence/browser-api-database-chain.json';
  const wrong = structuredClone(input); wrong.deliveryEvidence.consumedResults[0].resultLocator = 'mock-only';
  assert.throws(() => store.consumeAcceptedResult(wrong), /committed accepted/);
  const wrongContract = structuredClone(input); wrongContract.deliveryEvidence.consumedResults[0].contractLocator = 'contracts/old';
  assert.throws(() => store.consumeAcceptedResult(wrongContract), /contract or result/);
  store.consumeAcceptedResult(input);
  assert.equal(store.history('2026-10').records.length, 2);
});

function composedInput(store, producerContract = {}, consumedContract = {}) {
  const backend = task('backend'), frontend = task('frontend');
  Object.assign(backend.deliveryContract, { designLocator: 'contracts/api', ...producerContract });
  accept(store, backend);
  frontend.deliveryContract.consumes = [{ taskId: backend.taskId, contractLocator: 'contracts/api', ...consumedContract }];
  store.registerTask(frontend);
  const input = acceptance(frontend);
  input.deliveryEvidence.integrationEvidenceLocator = 'evidence/browser-api-database-chain.json';
  input.deliveryEvidence.consumedResults = [{
    ...frontend.deliveryContract.consumes[0], operationId: 'accept-backend', resultLocator: 'results/backend.md',
  }];
  return { backend, frontend, input };
}

for (const [name, producerContract, consumedContract] of [
  ['both consumer references agree on the wrong design locator', {}, { contractLocator: 'contracts/other-api' }],
  ['consumer requires a revision absent from producer evidence', {}, { contractRevision: 'rev2' }],
  ['consumer omits the producer revision', { designRevision: 'rev2' }, {}],
  ['same locator but different producer revision', { designRevision: 'rev2' }, { contractRevision: 'rev1' }],
]) {
  test(`reject composition when ${name}`, t => {
    const { store } = fixture(t);
    const { input } = composedInput(store, producerContract, consumedContract);
    const before = store.snapshot();
    assert.throws(() => store.consumeAcceptedResult(input), /accepted producer contract identity/);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(store.history('2026-10').records.length, 1);
  });
}

test('accepted producer revision composes without consulting a later active task revision', t => {
  const { store } = fixture(t);
  const { backend, input } = composedInput(store, { designRevision: 'rev2' }, { contractRevision: 'rev2' });
  const nextBackend = task('backend-next', { worker: backend.worker });
  nextBackend.deliveryContract.resultOwnerThreadId = backend.worker;
  nextBackend.deliveryContract.designLocator = 'contracts/api';
  nextBackend.deliveryContract.designRevision = 'rev3';
  store.registerTask(nextBackend);
  store.consumeAcceptedResult(input);
  assert.equal(store.snapshot().tasks['backend-next'].status, '进行中');
  const original = store.committedDeliveryResult('accept-backend');
  assert.equal(original.deliveryContract.designRevision, 'rev2');
  assert.equal(store.history('2026-10').records.length, 2);
});

test('evidence cannot silently change the agreed consumed revision', t => {
  const { store } = fixture(t);
  const { input } = composedInput(store, { designRevision: 'rev2' }, { contractRevision: 'rev2' });
  input.deliveryEvidence.consumedResults[0].contractRevision = 'rev3';
  assert.throws(() => store.consumeAcceptedResult(input), /contract or result identity/);
  assert.equal(store.snapshot().tasks.frontend.status, '进行中');
});

for (const [name, mutate] of [
  ['blank design revision', r => { r.deliveryContract.designRevision = ' '; }],
  ['non-text design revision', r => { r.deliveryContract.designRevision = 2; }],
  ['blank consumed revision', r => { r.deliveryContract.consumes = [{ taskId: 'backend', contractLocator: 'contracts/api', contractRevision: '' }]; }],
]) {
  test(`reject ${name} before registration`, t => {
    const { store } = fixture(t), record = task(), before = store.snapshot();
    mutate(record);
    assert.throws(() => store.registerTask(record), /contract|consumer/);
    assert.deepEqual(store.snapshot(), before);
  });
}

test('verified partial artifacts can be used while producer remains active; consumes is not every technical dependency', t => {
  const { store } = fixture(t), backend = task('backend'), frontend = task('frontend');
  store.registerTask(backend);
  // This goal uses an already verified stable interface, not producer-task completion.
  frontend.deliveryContract.designLocator = 'contracts/stable-api-v2';
  frontend.deliveryContract.criteria = [{ id: 'business-path', expected: '使用稳定接口与已验证部分制品完成真实联调' }];
  store.registerTask(frontend);
  const input = acceptance(frontend);
  input.deliveryEvidence.criteria[0].evidenceLocator = 'evidence/partial-artifact-and-real-integration.json';
  store.consumeAcceptedResult(input);
  assert.equal(store.snapshot().tasks.backend.status, '进行中');
});

test('declared final dependency cannot consume still-active or merely closed upstream task', t => {
  const { store } = fixture(t), backend = task('backend'), frontend = task('frontend');
  store.registerTask(backend);
  frontend.deliveryContract.consumes = [{ taskId: 'backend', contractLocator: 'contract/api' }];
  store.registerTask(frontend);
  const input = acceptance(frontend);
  input.deliveryEvidence.consumedResults = [{ taskId: 'backend', operationId: 'close-backend', resultLocator: 'results/backend.md', contractLocator: 'contract/api' }];
  input.deliveryEvidence.integrationEvidenceLocator = 'evidence/integration';
  assert.throws(() => store.consumeAcceptedResult(input), /committed accepted/);
  store.closeTask({ operationId: 'close-backend', taskId: 'backend', worker: backend.worker, expectedStatus: '进行中',
    businessState: '已关闭', ownerDirective: 'explicit-owner-instruction', workerStopped: true, closedBy: 'owner-test',
    closedAt: now, closureReason: '老板取消本目标', taskLocator: 'tasks/backend', authorizationLocator: 'user/cancel' });
  assert.throws(() => store.consumeAcceptedResult(input), /committed accepted/);
});

test('declared dependency cannot consume accepted result from another project', t => {
  const { store } = fixture(t), backend = task('backend', { projectId: 'project-other' }), frontend = task('frontend');
  accept(store, backend);
  frontend.deliveryContract.consumes = [{ taskId: 'backend', contractLocator: 'contract/api' }];
  store.registerTask(frontend);
  const input = acceptance(frontend);
  input.deliveryEvidence = { ...input.deliveryEvidence, integrationEvidenceLocator: 'evidence/integration',
    consumedResults: [{ taskId: 'backend', operationId: 'accept-backend', resultLocator: 'results/backend.md', contractLocator: 'contract/api' }] };
  assert.throws(() => store.consumeAcceptedResult(input), /in this project/);
});

test('ordinary stages and progress reuse the same task, worker and contract', t => {
  const { store } = fixture(t), record = task(); store.registerTask(record);
  for (const stage of ['design', 'implement', 'integrate', 'test']) {
    store.updateTask({ operationId: stage, taskId: record.taskId, expectedStatus: '进行中', status: '进行中',
      progress: stage, pause: '无', updatedAt: now });
  }
  assert.equal(Object.keys(store.snapshot().tasks).length, 1);
  assert.deepEqual(store.snapshot().tasks[record.taskId].deliveryContract, record.deliveryContract);
  assert.throws(() => store.updateTask({ operationId: 'change', taskId: record.taskId,
    deliveryContract: { ...record.deliveryContract, outcome: '偷偷扩大范围' } }), /cannot replace/);
});

test('accepted goal plus separately registered authorized next goal gives read-only owner review, never dispatch', t => {
  const { store, runtime } = fixture(t), a = task(), b = task('goal-b');
  accept(store, a); store.registerTask(b);
  const before = store.snapshot(), result = runtime('workbench.delivery-plan', readPlan());
  assert.equal(result.disposition, 'ready-for-owner-review');
  assert.equal(result.dispatch, false); assert.equal(result.requiresAuthorityCheck, true);
  assert.deepEqual(result.authorizationSource, b.deliveryContract.authorization);
  assert.deepEqual(store.snapshot(), before);
});

test('no inferred next goal or boolean authorization can trigger dispatch', t => {
  const { store } = fixture(t); accept(store, task());
  const result = store.deliveryPlan({ ...readPlan(), authorized: true });
  assert.equal(result.disposition, 'held');
  assert.ok(result.reasons.includes('next-goal-not-registered-with-contract'));
  assert.equal(result.dispatch, false);
});

test('accepted legacy goals report missing machine evidence, not a false unaccepted status', t => {
  const { store } = fixture(t), legacy = task(); delete legacy.deliveryContract;
  accept(store, legacy); store.registerTask(task('goal-b'));
  const before = store.snapshot(), output = store.deliveryPlan(readPlan());
  assert.equal(output.disposition, 'held');
  assert.ok(output.reasons.includes('previous-goal-machine-evidence-missing'));
  assert.ok(!output.reasons.includes('previous-goal-not-accepted'));
  assert.ok(!output.reasons.includes('project-mismatch'));
  assert.equal(output.dispatch, false);
  assert.deepEqual(store.snapshot(), before);
});

test('project pause, task pause and project completion each prevent continuation readiness', t => {
  const { store } = fixture(t); accept(store, task()); store.registerTask(task('goal-b'));
  for (const [index, status] of ['已暂停', '已完成'].entries()) {
    store.updateProjectSnapshot({ operationId: `project-${index}`, status, expectedSnapshot: store.snapshot().projectSnapshot,
      mainline: 'approved goals', problem: 'none', evidence: 'source', next: 'no resume', updatedAt: now });
    assert.equal(store.deliveryPlan(readPlan()).disposition, 'held');
  }
  store.updateProjectSnapshot({ operationId: 'project-running', status: '进行中', expectedSnapshot: store.snapshot().projectSnapshot,
    mainline: 'approved goals', problem: 'none', evidence: 'source', next: 'owner review', updatedAt: now });
  store.updateTask({ operationId: 'pause-b', taskId: 'goal-b', expectedStatus: '进行中', status: '已暂停',
    progress: '暂停', pause: '老板明确暂停', updatedAt: now });
  assert.ok(store.deliveryPlan(readPlan()).reasons.includes('next-goal-paused'));
});

test('acceptance replay and injected transaction recovery preserve one receipt and full delivery evidence', t => {
  const { store } = fixture(t), record = task(), input = acceptance(record);
  store.registerTask(record);
  assert.throws(() => store.consumeAcceptedResult(input, { faultAt: 'afterStateCommit' }), /injected fault/);
  assert.equal(store.committedDeliveryResult(input.operationId), null);
  store.recover();
  const once = store.snapshot(), result = store.consumeAcceptedResult(input);
  assert.equal(result.status, '已完成'); assert.deepEqual(store.snapshot(), once);
  assert.equal(store.history('2026-10').records.length, 1);
  assert.deepEqual(store.committedDeliveryResult(input.operationId).deliveryEvidence, input.deliveryEvidence);
});

test('changed durable history is not accepted even after operation-cache eviction', t => {
  const { store } = fixture(t), record = task(); accept(store, record);
  const historyFile = path.join(store.historyRoot, '2026-10.json');
  const history = JSON.parse(fs.readFileSync(historyFile)); history.records[0].result = 'forged-result';
  fs.writeFileSync(historyFile, JSON.stringify(history));
  const state = store.snapshot(); delete state.operations['accept-goal-a'];
  state.operationOrder = state.operationOrder.filter(id => id !== 'accept-goal-a');
  fs.writeFileSync(store.stateFile, JSON.stringify(state));
  assert.equal(store.committedDeliveryResult('accept-goal-a'), null);
});

test('runtime cannot register or accept another owner contract just by supplying its thread id in JSON', t => {
  const { runtime } = fixture(t), record = task();
  assert.throws(() => runtime('workbench.register', record, 'unrelated-pm'), /registration must/);
  assert.throws(() => runtime('workbench.register', record, record.worker), /registration must/);
  runtime('workbench.register', record);
  assert.throws(() => runtime('workbench.accept', acceptance(record), 'unrelated-pm'), /caller identity/);
});

test('a separate provided interface contract composes independently from internal design location and revision', t => {
  const { store } = fixture(t);
  const { input } = composedInput(store, {
    designLocator: 'design/backend-internals', designRevision: 'internal-17',
    providedContracts: [{ contractLocator: 'contracts/api', contractRevision: 'public-2' }],
  }, { contractRevision: 'public-2' });
  store.consumeAcceptedResult(input);
  assert.equal(store.history('2026-10').records.length, 2);
});

test('explicit provided contracts do not silently fall back to an internal design contract', t => {
  const { store } = fixture(t);
  const { input } = composedInput(store, {
    providedContracts: [{ contractLocator: 'contracts/public-other', contractRevision: 'public-2' }],
  });
  assert.throws(() => store.consumeAcceptedResult(input), /accepted producer contract identity/);
});

function multipleInterfaces(store, provided = [
  { contractLocator: 'contracts/query.json', contractRevision: 'v1' },
  { contractLocator: 'contracts/save.json', contractRevision: 'v2' },
]) {
  const api = task('api'), frontend = task('frontend');
  api.deliveryContract.providedContracts = provided;
  accept(store, api);
  frontend.deliveryContract.consumes = [
    { taskId: api.taskId, contractLocator: 'contracts/query.json', contractRevision: 'v1' },
    { taskId: api.taskId, contractLocator: 'contracts/save.json', contractRevision: 'v2' },
  ];
  const input = acceptance(frontend);
  input.deliveryEvidence.integrationEvidenceLocator = 'evidence/query-save-reload-flow';
  input.deliveryEvidence.consumedResults = frontend.deliveryContract.consumes.map(reference => ({
    ...reference, operationId: 'accept-api', resultLocator: 'results/api.md',
  }));
  return { api, frontend, input };
}

test('one accepted producer can provide two distinct interfaces to the same consumer goal', t => {
  const { store } = fixture(t), { frontend, input } = multipleInterfaces(store);
  store.registerTask(frontend);
  // Matching is by producer plus interface, not array position or producer alone.
  input.deliveryEvidence.consumedResults.reverse();
  store.consumeAcceptedResult(input);
  assert.equal(store.history('2026-10').records.length, 2);
});

test('duplicate interface references remain invalid even when the duplicate claims another revision', t => {
  const { store } = fixture(t), { frontend } = multipleInterfaces(store);
  frontend.deliveryContract.consumes[1] = { ...frontend.deliveryContract.consumes[0], contractRevision: 'v3' };
  const before = store.snapshot();
  assert.throws(() => store.registerTask(frontend), /invalid delivery consumer inputs/);
  assert.deepEqual(store.snapshot(), before);
});

for (const [name, mutate, error] of [
  ['duplicate evidence interface', i => { i.deliveryEvidence.consumedResults[1] = { ...i.deliveryEvidence.consumedResults[0] }; }, /exact consumed result set/],
  ['missing second evidence', i => { i.deliveryEvidence.consumedResults.pop(); }, /exact consumed result set/],
  ['wrong revision of second interface', i => { i.deliveryEvidence.consumedResults[1].contractRevision = 'v99'; }, /contract or result identity/],
]) {
  test(`multi-interface composition rejects ${name}`, t => {
    const { store } = fixture(t), { frontend, input } = multipleInterfaces(store);
    store.registerTask(frontend);
    const before = store.snapshot(); mutate(input);
    assert.throws(() => store.consumeAcceptedResult(input), error);
    assert.deepEqual(store.snapshot(), before);
  });
}

test('both interfaces must actually be provided by the accepted producer snapshot', t => {
  const { store } = fixture(t), { frontend, input } = multipleInterfaces(store, [
    { contractLocator: 'contracts/query.json', contractRevision: 'v1' },
  ]);
  store.registerTask(frontend);
  assert.throws(() => store.consumeAcceptedResult(input), /accepted producer contract identity/);
  assert.equal(store.history('2026-10').records.length, 1);
});

test('multiple interfaces from one producer cannot mix different accepted delivery snapshots', t => {
  const { store } = fixture(t), { api, frontend, input } = multipleInterfaces(store);
  // Legacy history can contain reused task IDs. This test does not change that
  // existing registration behavior; it prevents combining their distinct results.
  store.registerTask(api);
  store.consumeAcceptedResult(acceptance(api, { operationId: 'accept-api-another', finalLocator: 'results/api-another.md' }));
  store.registerTask(frontend);
  input.deliveryEvidence.consumedResults[1].operationId = 'accept-api-another';
  input.deliveryEvidence.consumedResults[1].resultLocator = 'results/api-another.md';
  assert.throws(() => store.consumeAcceptedResult(input), /same accepted producer snapshot/);
  assert.equal(store.history('2026-10').records.length, 2);
});

for (const providedContracts of [[], [{ contractLocator: ' ' }], [{ contractLocator: 'a', contractRevision: '' }],
  [{ contractLocator: 'a' }, { contractLocator: 'a', contractRevision: 'two' }]]) {
  test(`reject invalid provided contracts ${JSON.stringify(providedContracts)}`, t => {
    const { store } = fixture(t), record = task();
    record.deliveryContract.providedContracts = providedContracts;
    assert.throws(() => store.registerTask(record), /provided delivery/);
    assert.equal(store.snapshot().revision, 0);
  });
}

function revision(record, overrides = {}) {
  const updated = structuredClone(record.deliveryContract);
  updated.designRevision = 'approved-revision-2';
  updated.criteria[0].expected = '用户已批准的新要求：真实输入A和B均得到正确结果';
  updated.authorization = { source: 'approved-plan', locator: 'source-thread/user-confirmed-design-change' };
  return { operationId: `revise-${record.taskId}`, taskId: record.taskId, projectId: record.projectId,
    expectedDeliveryContract: structuredClone(record.deliveryContract), deliveryContract: updated,
    changedBy: record.deliveryContract.acceptanceOwnerThreadId, changedAt: now,
    changeReason: '已确认设计调整，保持同一业务结果和原负责人', ...overrides };
}

test('authorized contract revision stays on the same task and preserves history through final acceptance', t => {
  const { store, runtime } = fixture(t), record = task();
  runtime('workbench.register', record);
  const input = revision(record), original = store.snapshot().tasks[record.taskId];
  const result = runtime('workbench.revise-delivery', input);
  const updated = store.snapshot().tasks[record.taskId];
  assert.equal(result.contractRevisionCount, 1);
  assert.deepEqual(Object.keys(store.snapshot().tasks), [record.taskId]);
  for (const key of ['taskId', 'worker', 'status', 'projectId', 'progress', 'pause']) assert.equal(updated[key], original[key]);
  assert.deepEqual(updated.deliveryContractHistory[0].previousContract, original.deliveryContract);
  assert.deepEqual(updated.deliveryContractHistory[0].authorization, input.deliveryContract.authorization);
  assert.throws(() => runtime('workbench.accept', acceptance(original)), /acceptance contract changed/);
  runtime('workbench.accept', acceptance(updated));
  const history = store.history('2026-10').records[0];
  assert.deepEqual(history.deliveryContract, input.deliveryContract);
  assert.deepEqual(history.deliveryContractHistory, updated.deliveryContractHistory);
  assert.deepEqual(runtime('workbench.revise-delivery', input), result, 'completed revision replays after task acceptance');
});

test('revision retries are idempotent and cannot overwrite a later approved revision', t => {
  const { store, runtime } = fixture(t), record = task(); runtime('workbench.register', record);
  const first = revision(record), result = runtime('workbench.revise-delivery', first);
  const second = revision(store.snapshot().tasks[record.taskId], { operationId: 'revision-3' });
  second.deliveryContract.designRevision = 'approved-revision-3';
  runtime('workbench.revise-delivery', second);
  const before = store.snapshot();
  assert.deepEqual(runtime('workbench.revise-delivery', first), result);
  assert.deepEqual(store.snapshot(), before);
  assert.throws(() => runtime('workbench.revise-delivery', { ...first, changeReason: 'different replay' }), /reused with different/);
});

test('revision replay repairs a failed view write using current state without reverting later revisions', t => {
  const { store } = fixture(t), record = task(); store.registerTask(record);
  function failView(input) {
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === path.resolve(store.viewPath)) throw new Error('injected view projection failure');
      return rename(source, destination);
    };
    try { assert.throws(() => store.reviseDeliveryContract(input), /injected view projection failure/); }
    finally { fs.renameSync = rename; }
    assert.equal(store.recoveryStatus().viewMatchesState, false);
  }
  const first = revision(record); failView(first);
  const firstBytes = fs.readFileSync(store.stateFile, 'utf8'), receipt = store.snapshot().operations[first.operationId].output;
  assert.deepEqual(store.reviseDeliveryContract(first), receipt);
  assert.equal(fs.readFileSync(store.stateFile, 'utf8'), firstBytes);
  assert.equal(store.recoveryStatus().viewMatchesState, true);
  const second = revision(store.snapshot().tasks[record.taskId], { operationId: 'next-revision' });
  second.deliveryContract.designRevision = 'latest-approved-revision';
  failView(second);
  const latestBytes = fs.readFileSync(store.stateFile, 'utf8');
  assert.deepEqual(store.reviseDeliveryContract(first), receipt);
  assert.equal(fs.readFileSync(store.stateFile, 'utf8'), latestBytes);
  assert.equal(store.snapshot().tasks[record.taskId].deliveryContract.designRevision, 'latest-approved-revision');
  assert.equal(store.recoveryStatus().viewMatchesState, true);
});

test('after operation-cache eviction an old revision request cannot write stale state again', t => {
  const { store } = fixture(t), record = task(); store.registerTask(record);
  const input = revision(record); store.reviseDeliveryContract(input);
  for (let index = 0; index < 100; index += 1) {
    store.updateTask({ operationId: `cache-progress-${index}`, taskId: record.taskId, expectedStatus: '进行中',
      status: '进行中', progress: `verified stage ${index}`, pause: '无', updatedAt: now });
  }
  assert.equal(store.snapshot().operations[input.operationId], undefined);
  const beforeState = fs.readFileSync(store.stateFile, 'utf8'), beforeView = store.view();
  assert.throws(() => store.reviseDeliveryContract(input), /delivery revision contract changed/);
  assert.equal(fs.readFileSync(store.stateFile, 'utf8'), beforeState);
  assert.equal(store.view(), beforeView);
  assert.equal(store.snapshot().tasks[record.taskId].deliveryContractHistory.length, 1);
});

for (const [name, mutate, caller, error] of [
  ['forged caller string', i => {}, 'unrelated-pm', /caller identity/],
  ['result owner without acceptance authority', i => { i.changedBy = 'worker-goal-a'; }, 'worker-goal-a', /acceptance owner/],
  ['stale contract preimage', i => { i.expectedDeliveryContract.designRevision = 'stale'; }, 'owner-test', /contract changed/],
  ['changed result owner', i => { i.deliveryContract.resultOwnerThreadId = 'other'; }, 'owner-test', /cannot change task owners/],
  ['changed acceptance owner', i => { i.deliveryContract.acceptanceOwnerThreadId = 'other'; }, 'owner-test', /cannot change task owners/],
  ['missing authorization', i => { delete i.deliveryContract.authorization; }, 'owner-test', /authorization/],
  ['assistant opinion instead of approval', i => { i.deliveryContract.authorization.source = 'assistant-opinion'; }, 'owner-test', /authorization/],
]) {
  test(`revision rejects ${name} without changing state`, t => {
    const { store, runtime } = fixture(t), record = task(); runtime('workbench.register', record);
    const input = revision(record), before = store.snapshot(); mutate(input);
    assert.throws(() => runtime('workbench.revise-delivery', input, caller), error);
    assert.deepEqual(store.snapshot(), before);
  });
}

test('approved design can be revised while paused without resuming the task or project', t => {
  const { store, runtime } = fixture(t), record = task('goal-a', { status: '已暂停', pause: '老板暂停业务' });
  runtime('workbench.register', record);
  store.updateProjectSnapshot({ operationId: 'pause-project', expectedSnapshot: null, status: '已暂停',
    mainline: '暂停期间讨论设计', problem: '无', evidence: 'user/pause', next: '不恢复业务', updatedAt: now });
  runtime('workbench.revise-delivery', revision(record));
  assert.equal(store.snapshot().tasks[record.taskId].status, '已暂停');
  assert.equal(store.snapshot().projectSnapshot.status, '已暂停');
  assert.equal(store.snapshot().tasks[record.taskId].pause, '老板暂停业务');
});

test('a pending acceptance intent rejects revision and recovers against its original contract', t => {
  const { store } = fixture(t), record = task(); store.registerTask(record);
  assert.throws(() => store.consumeAcceptedResult(acceptance(record), { faultAt: 'afterIntent' }), /injected fault/);
  assert.throws(() => store.reviseDeliveryContract(revision(record)), /pending terminal transaction/);
  store.recover();
  assert.deepEqual(store.history('2026-10').records[0].deliveryContract, record.deliveryContract);
});

test('acceptance intent recovery refuses changed contract state instead of archiving old evidence', t => {
  const { store } = fixture(t), record = task(); store.registerTask(record);
  assert.throws(() => store.consumeAcceptedResult(acceptance(record), { faultAt: 'afterIntent' }), /injected fault/);
  // Explicit corruption fixture, not a supported mutation path.
  const state = store.snapshot();
  state.tasks[record.taskId].deliveryContract.criteria[0].expected = 'different business result';
  fs.writeFileSync(store.stateFile, JSON.stringify(state));
  assert.throws(() => store.recover(), /contract changed after transaction intent/);
  assert.equal(store.history('2026-10').records.length, 0);
  assert.equal(store.snapshot().tasks[record.taskId].status, '进行中');
});

test('two OS processes cannot both revise the same delivery contract preimage', async t => {
  const f = fixture(t), record = task(); f.store.registerTask(record);
  const config = { runtimeRoot: f.store.runtimeRoot, viewPath: f.store.viewPath, historyRoot: f.store.historyRoot };
  const source = `import {WorkbenchTransactionStore} from ${JSON.stringify(new URL('./workbench-transaction.mjs', import.meta.url).href)};
    const [config,input] = JSON.parse(process.argv[1]);
    try { console.log(JSON.stringify(new WorkbenchTransactionStore(config).reviseDeliveryContract(input))); }
    catch(error) { console.log(error.message); process.exitCode=1; }`;
  const results = await Promise.all([1, 2].map(index => new Promise((resolve, reject) => {
    const input = revision(record, { operationId: `parallel-revision-${index}` });
    input.deliveryContract.designRevision = `revision-${index}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify([config, input])],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.on('error', reject); child.on('close', status => resolve({ status, output }));
  })));
  assert.equal(results.filter(r => r.status === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter(r => r.status === 1 && /contract changed/.test(r.output)).length, 1, JSON.stringify(results));
  assert.equal(f.store.snapshot().tasks[record.taskId].deliveryContractHistory.length, 1);
});

function formalCli(f, taskId = 'formal-cli', contract = null, { unstarted = false } = {}) {
  const cli = new CliTaskStore({ controlRoot: f.controlRoot });
  const binding = { projectId: 'project-test', taskId, ownerThreadId: 'owner-test', ownerTurnId: 'turn-test',
    taskMode: 'formal', executionRoot: f.root, profilePath: path.join(f.root, 'fixture-only-profile.json'),
    configuration: { model: 'fixture-model-preserved', effort: 'high' },
    contract: { goal: 'current approved result', boundaries: 'fixture only', acceptance: 'consumer path works', factEntries: [], skillEntries: [] } };
  cli.create(binding);
  let run;
  if (!unstarted) {
    run = cli.beginRun(binding, { requestId: 'fixture-run', prompt: 'fixture approved goal',
      expectedRunNumber: 0, expectedSessionId: null });
    cli.bindSession(run, 'preserved-native-session');
    cli.finishRun(run, { status: 'completed', finalText: 'fixture result with preserved native session' });
  }
  const record = task(taskId);
  delete record.worker;
  record.execution = { kind: 'cli', ownerThreadId: binding.ownerThreadId, stateLocator: cli.locator(binding) };
  if (contract) record.deliveryContract = structuredClone(contract);
  record.deliveryContract.resultOwnerThreadId = binding.ownerThreadId;
  record.deliveryContract.acceptanceOwnerThreadId = binding.ownerThreadId;
  f.runtime('workbench.register', record);
  return { cli, binding, run, record };
}
function reviewCli(c, ownerThreadId = c.binding.ownerThreadId) {
  return c.cli.recordReview({ projectId: c.binding.projectId, taskId: c.binding.taskId, ownerThreadId,
    runNumber: 1, resultSha256: sha256File(c.run.resultPath), decision: 'accept',
    evidenceLocator: 'fixture/actual-consumer-evidence', conclusion: 'fixture result reviewed by actual owner', reviewedAt: now });
}
function acceptCli(c, record = c.record, ownerThreadId = record.execution.ownerThreadId) {
  return { operationId: `accept-${record.taskId}`, projectId: record.projectId, taskId: record.taskId, ownerThreadId,
    runNumber: 1, resultSha256: sha256File(c.run.resultPath), expectedStatus: record.status,
    expectedDeliveryContract: structuredClone(record.deliveryContract),
    deliveryEvidence: acceptance(task()).deliveryEvidence };
}
function revalidateCli(c, record) {
  return { ...acceptCli(c, record), deliveryRevalidation: {
    revisionOperationId: record.deliveryContractHistory.at(-1).operationId,
    cliReviewSha256: digest(c.cli.readReview(c.binding, 1)),
    reviewedAt: now, evidenceLocator: 'fixture/new-revision-real-path',
    conclusion: '按本次修订重新核验当前产物及逐条交付证据，原结果仍满足当前要求',
  } };
}

test('formal CLI contract acceptance preserves its actual session, model, result and evidence', t => {
  const f = fixture(t), c = formalCli(f);
  const before = c.cli.read(c.binding), resultHash = sha256File(c.run.resultPath);
  reviewCli(c);
  const input = acceptCli(c);
  const missing = structuredClone(input); delete missing.expectedDeliveryContract;
  assert.throws(() => f.runtime('workbench.accept-cli', missing), /acceptance contract changed/);
  assert.throws(() => f.runtime('workbench.accept-cli', input, 'unrelated-pm'), /owner identity/);
  const output = f.runtime('workbench.accept-cli', input);
  assert.equal(output.status, '已完成');
  assert.deepEqual(c.cli.read(c.binding), before);
  assert.equal(sha256File(c.run.resultPath), resultHash);
  const [history] = f.store.history('2026-10').records;
  assert.equal(history.sessionId, before.sessionId);
  assert.deepEqual(history.deliveryContract, c.record.deliveryContract);
});

function archivedCli(f, kind = 'accept', { unstarted = false } = {}) {
  const c = formalCli(f, 'formal-cli', null, { unstarted });
  if (kind === 'accept') { reviewCli(c); f.runtime('workbench.accept-cli', acceptCli(c)); }
  else f.runtime('workbench.close', {
    operationId: 'close-formal-cli', projectId: c.record.projectId, taskId: c.record.taskId,
    execution: c.record.execution, ownerThreadId: c.binding.ownerThreadId, expectedStatus: c.record.status,
    businessState: '已关闭', ownerDirective: 'explicit-owner-instruction', closedBy: c.binding.ownerThreadId,
    closedAt: now, closureReason: 'fixture owner closes without restarting', taskLocator: c.cli.locator(c.binding),
    authorizationLocator: 'fixture/user-close', stateSha256: digest(c.cli.read(c.binding)),
  });
  c.request = (action, override = {}, contextOverride = {}) => launchCliRequest({ schemaVersion: 1,
    requestId: `archived-${action}`, action: `cli.${action}`, input: { projectId: c.binding.projectId,
      taskId: c.binding.taskId, ownerThreadId: c.binding.ownerThreadId, runNumber: 1, ...override } },
  { controlRoot: f.controlRoot, executionRoot: f.root, ownerThreadId: c.binding.ownerThreadId,
    ownerTurnId: 'turn-test', ...contextOverride });
  c.historyFile = path.join(f.controlRoot, 'local/history/workbench/2026-10.json');
  c.stateFile = path.join(f.controlRoot, 'local/runtime/workbench/workbench-state.json');
  c.operationId = kind === 'accept' ? 'accept-formal-cli' : 'close-formal-cli';
  c.receiptFile = path.join(f.controlRoot, 'local/runtime/workbench/transactions', `${c.operationId}.json`);
  c.endpointFile = path.join(c.cli.taskDir(c.binding), 'interactive.json');
  return c;
}
function mutateJson(file, mutate) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')); mutate(value); fs.writeFileSync(file, JSON.stringify(value));
}
function archiveBytes(c) {
  return [c.stateFile, c.historyFile, c.receiptFile, c.cli.locator(c.binding), c.run?.resultPath]
    .filter(Boolean).map(file => [file, fs.readFileSync(file, 'utf8')]);
}
function savedEndpoint(c, override = {}) {
  const record = { projectId: c.binding.projectId, taskId: c.binding.taskId, ownerThreadId: c.binding.ownerThreadId,
    sessionId: c.cli.read(c.binding).sessionId, runNumber: 1, status: 'idle', activeTurnId: null, pending: null,
    manager: { pid: 2147483647, startedAt: '1' }, server: { pid: 2147483646, startedAt: '1' }, ...override };
  fs.writeFileSync(c.endpointFile, JSON.stringify(record)); return record;
}

for (const kind of ['accept', 'close']) {
  test(`archived CLI ${kind} allows original-owner status/result and repeated empty detach without changing history`, async t => {
    const f = fixture(t), c = archivedCli(f, kind), before = archiveBytes(c);
    assert.deepEqual(await c.request('status'), c.cli.read(c.binding));
    assert.deepEqual(await c.request('result'), c.cli.readResult(c.binding, 1));
    assert.equal((await c.request('detach')).status, 'already-detached');
    assert.equal((await c.request('detach')).status, 'already-detached');
    assert.deepEqual(archiveBytes(c), before);
  });
  test(`archived CLI ${kind} remains queryable after the bounded operation cache is evicted`, async t => {
    const f = fixture(t), c = archivedCli(f, kind);
    mutateJson(c.stateFile, state => { delete state.operations[c.operationId]; state.operationOrder = []; });
    const before = archiveBytes(c);
    assert.equal((await c.request('status')).sessionId, 'preserved-native-session');
    assert.equal((await c.request('result')).runNumber, 1);
    assert.deepEqual(archiveBytes(c), before);
  });
  for (const action of ['resume', 'review', 'queue', 'open', 'stop', 'recover', 'cancel-next']) {
    test(`archived CLI ${kind} never authorizes ${action}`, async t => {
      const f = fixture(t), c = archivedCli(f, kind), before = archiveBytes(c);
      await assert.rejects(c.request(action), /CLI task is archived; only status\/result\/detach are allowed/);
      assert.deepEqual(archiveBytes(c), before);
    });
  }
  test(`archived CLI ${kind} cannot be started again with a valid profile`, async t => {
    const f = fixture(t), c = archivedCli(f, kind);
    const codexHome = path.join(f.root, 'fixture-cli-home'); fs.mkdirSync(codexHome);
    fs.writeFileSync(c.binding.profilePath, JSON.stringify({ schemaVersion: 1, runner: { command: process.execPath, args: [] },
      codexHome, model: 'fixture-model-preserved', mode: 'exec' }));
    const before = archiveBytes(c);
    await assert.rejects(c.request('start', { ...c.binding, prompt: 'must not start' }), /CLI task is archived; only status\/result\/detach are allowed/);
    assert.deepEqual(archiveBytes(c), before);
  });
}

test('archived CLI close of a created but unstarted task permits inspection and empty cleanup only', async t => {
  const f = fixture(t), c = archivedCli(f, 'close', { unstarted: true }), before = archiveBytes(c);
  assert.equal((await c.request('status')).runNumber, 0);
  assert.equal((await c.request('detach')).status, 'already-detached');
  await assert.rejects(c.request('resume'), /CLI task is archived; only status\/result\/detach are allowed/);
  assert.deepEqual(archiveBytes(c), before);
});

test('an unregistered formal CLI is not mislabeled as an archived task', async t => {
  const f = fixture(t), c = archivedCli(f);
  mutateJson(c.historyFile, h => { h.records = []; });
  const before = archiveBytes(c);
  for (const action of ['status', 'resume']) await assert.rejects(c.request(action), /^Error: CLI formal task registration required$/);
  assert.deepEqual(archiveBytes(c), before);
});

test('archived-action guidance is not disclosed for mismatched archive ownership or receipt', async t => {
  const f = fixture(t), c = archivedCli(f), originalHistory = fs.readFileSync(c.historyFile, 'utf8');
  mutateJson(c.historyFile, h => { h.records[0].execution.ownerThreadId = 'intruder'; });
  let before = archiveBytes(c);
  await assert.rejects(c.request('resume'), /archived registration identity or receipt mismatch/);
  assert.deepEqual(archiveBytes(c), before);
  fs.writeFileSync(c.historyFile, originalHistory);
  mutateJson(c.receiptFile, r => { r.phase = 'viewWritten'; });
  before = archiveBytes(c);
  await assert.rejects(c.request('resume'), /archived registration identity or receipt mismatch/);
  assert.deepEqual(archiveBytes(c), before);
});

for (const [name, view, expected] of [
  ['matching live view', () => { const identity = currentProcessIdentity(); return { windowPid: identity.pid, windowStartedAt: identity.startedAt }; }, { status: 'open' }],
  ['exited fingerprinted view', () => ({ windowPid: 2147483645, windowStartedAt: '1' }), { status: 'gone' }],
  ['reused view PID', () => ({ windowPid: process.pid, windowStartedAt: '1' }), { status: 'gone' }],
  ['legacy view PID still present', () => ({ windowPid: process.pid }), { status: 'unknown', reason: 'saved-view-identity-unavailable' }],
  ['legacy view PID absent', () => ({ windowPid: 2147483645 }), { status: 'unknown', reason: 'saved-view-identity-unavailable' }],
  ['malformed view birth identity', () => ({ windowPid: process.pid, windowStartedAt: 'not-a-birth-fingerprint' }), { status: 'unknown', reason: 'saved-view-identity-unavailable' }],
]) {
  test(`archived status and detach report ${name} independently of retired helpers without closing the view`, async t => {
    const f = fixture(t), c = archivedCli(f);
    savedEndpoint(c, { view: view() });
    const before = archiveBytes(c), endpointBefore = fs.readFileSync(c.endpointFile, 'utf8');
    const status = await c.request('status');
    assert.deepEqual(status, { ...c.cli.read(c.binding), viewStatus: expected });
    assert.deepEqual(await c.request('detach'), { status: 'already-detached', viewStatus: expected });
    assert.equal(process.kill(process.pid, 0), true);
    assert.equal(fs.readFileSync(c.endpointFile, 'utf8'), endpointBefore);
    assert.deepEqual(archiveBytes(c), before);
  });
}

test('archived view access denial is reported as unknown, not open or gone', async t => {
  const f = fixture(t), c = archivedCli(f), viewPid = 2147483645;
  savedEndpoint(c, { view: { windowPid: viewPid, windowStartedAt: '1' } });
  const before = archiveBytes(c), endpointBefore = fs.readFileSync(c.endpointFile, 'utf8'), originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid !== viewPid) return originalKill(pid, signal);
    assert.equal(signal, 0);
    throw Object.assign(new Error('fixture access denied'), { code: 'EPERM' });
  };
  try {
    const expected = { status: 'unknown', reason: 'view-process-identity-unavailable' };
    assert.deepEqual((await c.request('status')).viewStatus, expected);
    assert.deepEqual(await c.request('detach'), { status: 'already-detached', viewStatus: expected });
    assert.equal(fs.readFileSync(c.endpointFile, 'utf8'), endpointBefore);
    assert.deepEqual(archiveBytes(c), before);
  } finally { process.kill = originalKill; }
});

test('archived status does not trust a view belonging to a different native session', async t => {
  const f = fixture(t), c = archivedCli(f), identity = currentProcessIdentity();
  savedEndpoint(c, { sessionId: 'different-session', view: { windowPid: identity.pid, windowStartedAt: identity.startedAt } });
  const before = archiveBytes(c), endpointBefore = fs.readFileSync(c.endpointFile, 'utf8');
  await assert.rejects(c.request('status'), /archived interactive identity mismatch/);
  assert.equal(fs.readFileSync(c.endpointFile, 'utf8'), endpointBefore);
  assert.deepEqual(archiveBytes(c), before);
});

for (const [name, mutate, error = /archived|identity|record not found/] of [
  ['wrong archived owner', c => mutateJson(c.historyFile, h => { h.records[0].execution.ownerThreadId = 'intruder'; })],
  ['wrong archived project', c => mutateJson(c.historyFile, h => { h.records[0].projectId = 'other-project'; })],
  ['wrong archived state locator', c => mutateJson(c.historyFile, h => { h.records[0].execution.stateLocator += '.other'; })],
  ['ambiguous duplicate archive', c => mutateJson(c.historyFile, h => { h.records.push(h.records[0]); })],
  ['history without committed receipt', c => fs.unlinkSync(c.receiptFile)],
  ['unfinished receipt', c => mutateJson(c.receiptFile, r => { r.phase = 'viewWritten'; })],
  ['mismatched cached receipt', c => mutateJson(c.stateFile, s => { s.operations[c.operationId].inputDigest = '0'.repeat(64); })],
  ['result content changed after acceptance', c => mutateJson(c.run.resultPath, r => { r.finalText = 'different result'; }), /fingerprint/],
  ['result session changed', c => mutateJson(c.run.resultPath, r => { r.sessionId = 'different-session'; }), /result identity/],
  ['unconsumed continuation', c => mutateJson(c.cli.locator(c.binding), s => { s.continuations = [{ status: 'pending' }]; }), /terminal and idle/],
  ['unexpected running state', c => mutateJson(c.cli.locator(c.binding), s => { s.status = 'running'; }), /terminal and idle/],
]) {
  test(`archived CLI refuses ${name} without repair or state mutation`, async t => {
    const f = fixture(t), c = archivedCli(f); mutate(c);
    const before = fs.readFileSync(c.cli.locator(c.binding), 'utf8');
    await assert.rejects(c.request('status'), error);
    assert.equal(fs.readFileSync(c.cli.locator(c.binding), 'utf8'), before);
  });
}

test('archived CLI rejects unrelated caller and wrong execution root', async t => {
  const f = fixture(t), c = archivedCli(f), before = archiveBytes(c);
  await assert.rejects(c.request('status', {}, { ownerThreadId: 'intruder' }), /owner identity/);
  await assert.rejects(c.request('status', { ownerThreadId: 'intruder' }, { ownerThreadId: 'intruder' }), /identity/);
  await assert.rejects(c.request('status', {}, { executionRoot: path.dirname(f.root) }), /execution identity/);
  assert.deepEqual(archiveBytes(c), before);
});

for (const status of ['idle', 'closing', 'closed']) {
  test(`archived CLI ${status} endpoint whose exact processes exited is repeatedly detached without changing its label`, async t => {
    const f = fixture(t), c = archivedCli(f); savedEndpoint(c, { status });
    const before = archiveBytes(c), endpointBefore = fs.readFileSync(c.endpointFile, 'utf8');
    assert.equal((await c.request('detach')).status, 'already-detached');
    assert.equal((await c.request('detach')).status, 'already-detached');
    assert.equal(fs.readFileSync(c.endpointFile, 'utf8'), endpointBefore);
    assert.deepEqual(archiveBytes(c), before);
  });
}

for (const [name, override, error] of [
  ['wrong endpoint session', { sessionId: 'different-session' }, /interactive identity/],
  ['wrong endpoint owner', { ownerThreadId: 'intruder' }, /interactive identity/],
  ['active native turn', { status: 'running', activeTurnId: 'active-turn' }, /cannot interrupt/],
  ['pending native command', { pending: { action: 'run' } }, /cannot interrupt/],
  ['closing with an active turn', { status: 'closing', activeTurnId: 'active-turn' }, /cannot interrupt/],
  ['closing with a pending command', { status: 'closing', pending: { action: 'run' } }, /cannot interrupt/],
  ['missing process proof', { manager: null }, /saved process proof/],
]) {
  test(`archived CLI detach refuses ${name}`, async t => {
    const f = fixture(t), c = archivedCli(f); savedEndpoint(c, override);
    const before = archiveBytes(c), endpointBefore = fs.readFileSync(c.endpointFile, 'utf8');
    await assert.rejects(c.request('detach'), error);
    assert.equal(fs.readFileSync(c.endpointFile, 'utf8'), endpointBefore);
    assert.deepEqual(archiveBytes(c), before);
  });
}

test('archived CLI closed label with a still-matching live process is not accepted as exited', async t => {
  const f = fixture(t), c = archivedCli(f), identity = currentProcessIdentity();
  savedEndpoint(c, { status: 'closed', manager: identity, server: identity });
  await assert.rejects(c.request('detach'), /helper exit unconfirmed/);
  assert.equal(process.kill(identity.pid, 0), true);
});

test('archived CLI closing with live processes returns detaching repeatedly without another request or mutation', async t => {
  const f = fixture(t), c = archivedCli(f), identity = currentProcessIdentity(), requests = [];
  const tokenPath = path.join(c.cli.taskDir(c.binding), 'fixture-only-token'); fs.writeFileSync(tokenPath, 'fixture-token');
  const server = createServer((request, response) => {
    requests.push(request.url); response.writeHead(500); response.end('must not call detach twice');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    savedEndpoint(c, { status: 'closing', manager: identity, server: identity, tokenPath,
      controlUrl: `http://127.0.0.1:${server.address().port}/` });
    const before = archiveBytes(c), endpointBefore = fs.readFileSync(c.endpointFile, 'utf8');
    assert.equal((await c.request('detach')).status, 'detaching');
    assert.equal((await c.request('detach')).status, 'detaching');
    assert.deepEqual(requests, []);
    assert.equal(fs.readFileSync(c.endpointFile, 'utf8'), endpointBefore);
    assert.deepEqual(archiveBytes(c), before);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('archived CLI idle cleanup uses the existing authenticated detach endpoint only', async t => {
  const f = fixture(t), c = archivedCli(f), identity = currentProcessIdentity(), requests = [];
  const tokenPath = path.join(c.cli.taskDir(c.binding), 'fixture-only-token'); fs.writeFileSync(tokenPath, 'fixture-token');
  const server = createServer((request, response) => {
    requests.push([request.method, request.url, request.headers.authorization]);
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"status":"detached"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    savedEndpoint(c, { manager: identity, server: identity, tokenPath, controlUrl: `http://127.0.0.1:${server.address().port}/` });
    const before = archiveBytes(c);
    assert.equal((await c.request('detach')).status, 'detached');
    assert.deepEqual(requests, [['POST', '/detach', 'Bearer fixture-token']]);
    assert.deepEqual(archiveBytes(c), before);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('formal CLI contract revision binds acceptance to new requirements without changing native session', t => {
  const f = fixture(t), c = formalCli(f), originalState = c.cli.read(c.binding);
  f.runtime('workbench.revise-delivery', revision(c.record));
  const current = f.store.snapshot().tasks[c.record.taskId];
  reviewCli(c);
  assert.throws(() => f.runtime('workbench.accept-cli', acceptCli(c)), /acceptance contract changed/);
  assert.throws(() => f.runtime('workbench.accept-cli', acceptCli(c, current)), /current revision revalidation/);
  f.runtime('workbench.accept-cli', revalidateCli(c, current));
  assert.deepEqual(c.cli.read(c.binding), originalState);
  assert.equal(f.store.history('2026-10').records[0].deliveryContractHistory.length, 1);
});

test('pre-revision CLI acceptance cannot close changed requirements; revalidation preserves the same run and review', t => {
  const f = fixture(t), c = formalCli(f);
  reviewCli(c);
  const originalState = c.cli.read(c.binding), originalReview = c.cli.readReview(c.binding, 1);
  const originalResultHash = sha256File(c.run.resultPath);
  f.runtime('workbench.revise-delivery', revision(c.record));
  const current = f.store.snapshot().tasks[c.record.taskId], before = f.store.snapshot();
  assert.throws(() => f.runtime('workbench.accept-cli', acceptCli(c, current)), /current revision revalidation/);
  assert.deepEqual(f.store.snapshot(), before);
  const input = revalidateCli(c, current);
  const output = f.runtime('workbench.accept-cli', input);
  assert.equal(output.status, '已完成');
  assert.deepEqual(f.runtime('workbench.accept-cli', input), output);
  assert.deepEqual(c.cli.read(c.binding), originalState);
  assert.deepEqual(c.cli.readReview(c.binding, 1), originalReview);
  assert.equal(sha256File(c.run.resultPath), originalResultHash);
  const [history] = f.store.history('2026-10').records;
  assert.deepEqual(history.deliveryRevalidation, input.deliveryRevalidation);
  assert.equal(history.sourceCliReviewSha256, digest(originalReview));
  assert.equal(history.conclusion, input.deliveryRevalidation.conclusion);
  assert.equal(history.evidence, input.deliveryRevalidation.evidenceLocator);
});

for (const [label, mutate, rejection = /revalidation does not match/] of [
  ['old revision', r => { r.revisionOperationId = 'old-revision'; }],
  ['other review', r => { r.cliReviewSha256 = '0'.repeat(64); }],
  ['old time', r => { r.reviewedAt = '2026-10-19T00:00:00Z'; }],
  ['missing evidence', r => { delete r.evidenceLocator; }],
  ['missing conclusion', r => { r.conclusion = ''; }, /result conclusion or locator is missing/],
]) {
  test(`CLI delivery rejects ${label} revalidation without mutating task or history`, t => {
    const f = fixture(t), c = formalCli(f); reviewCli(c);
    f.runtime('workbench.revise-delivery', revision(c.record));
    const current = f.store.snapshot().tasks[c.record.taskId], before = f.store.snapshot();
    const input = revalidateCli(c, current); mutate(input.deliveryRevalidation);
    assert.throws(() => f.runtime('workbench.accept-cli', input), rejection);
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.store.history('2026-10').records.length, 0);
  });
}

test('changing a contract back to its old text does not revive a previous revision revalidation', t => {
  const f = fixture(t), c = formalCli(f); reviewCli(c);
  f.runtime('workbench.revise-delivery', revision(c.record));
  const revised = f.store.snapshot().tasks[c.record.taskId], input = revalidateCli(c, revised);
  f.runtime('workbench.revise-delivery', revision(revised, {
    operationId: 'revision-back', deliveryContract: c.record.deliveryContract,
  }));
  input.expectedDeliveryContract = c.record.deliveryContract;
  const before = f.store.snapshot();
  assert.throws(() => f.runtime('workbench.accept-cli', input), /revalidation does not match/);
  assert.deepEqual(f.store.snapshot(), before);
});

test('revision revalidation recovers an interrupted acceptance without replaying the CLI', t => {
  const f = fixture(t), c = formalCli(f); reviewCli(c);
  f.runtime('workbench.revise-delivery', revision(c.record));
  const current = f.store.snapshot().tasks[c.record.taskId], input = revalidateCli(c, current);
  const originalState = c.cli.read(c.binding);
  assert.throws(() => f.store.consumeAcceptedCliResult(input, { faultAt: 'afterStateCommit' }), /injected fault/);
  f.store.recover();
  assert.equal(f.runtime('workbench.accept-cli', input).status, '已完成');
  assert.equal(f.store.history('2026-10').records.length, 1);
  assert.deepEqual(c.cli.read(c.binding), originalState);
});

test('an uncommitted legacy CLI intent cannot recover stale review acceptance after a contract revision', t => {
  const f = fixture(t), c = formalCli(f); const review = reviewCli(c);
  f.runtime('workbench.revise-delivery', revision(c.record));
  const current = f.store.snapshot().tasks[c.record.taskId], input = revalidateCli(c, current);
  assert.throws(() => f.store.consumeAcceptedCliResult(input, { faultAt: 'afterIntent' }), /injected fault/);
  const file = path.join(f.store.transactionRoot, `${input.operationId}.json`);
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.input.deliveryRevalidation;
  delete legacy.input.sourceCliReviewSha256;
  legacy.input.conclusion = review.conclusion;
  legacy.input.evidenceLocator = review.evidenceLocator;
  legacy.inputDigest = digest(legacy.input);
  fs.writeFileSync(file, JSON.stringify(legacy));
  const before = f.store.snapshot(), resultHash = sha256File(c.run.resultPath);
  assert.throws(() => f.store.consumeAcceptedCliResult(acceptCli(c, current)), /current revision revalidation/);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.store.history('2026-10').records.length, 0);
  assert.equal(sha256File(c.run.resultPath), resultHash);
  assert.deepEqual(c.cli.readReview(c.binding, 1), review);
});

test('formal CLI accepted transaction recovers once with original contract and session', t => {
  const f = fixture(t), c = formalCli(f); reviewCli(c);
  const input = acceptCli(c);
  assert.throws(() => f.store.consumeAcceptedCliResult(input, { faultAt: 'afterStateCommit' }), /injected fault/);
  f.store.recover();
  const before = f.store.snapshot();
  assert.equal(f.runtime('workbench.accept-cli', input).status, '已完成');
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.store.history('2026-10').records.length, 1);
});

for (const interrupted of [false, true]) {
  test(`formal CLI owner transfer${interrupted ? ' interrupted before workbench commit' : ''} preserves contract and permits only successor acceptance`, async t => {
    const f = fixture(t), c = formalCli(f);
    const originalState = c.cli.read(c.binding), originalResultHash = sha256File(c.run.resultPath);
    const request = { schemaVersion: 1, requestId: 'owner-transfer', action: 'cli.transfer',
      input: { projectId: c.record.projectId, fromOwnerThreadId: 'owner-test', toOwnerThreadId: 'successor',
        expectedWorkbenchStateRevision: f.store.snapshot().revision, authorizationLocator: 'fixture/user-approved-transfer',
        tasks: [{ taskId: c.record.taskId, expectedSessionId: originalState.sessionId, expectedRunNumber: 1,
          expectedStateSha256: digest(originalState), expectedResultSha256: originalResultHash, expectedStatus: '进行中' }] } };
    const context = { controlRoot: f.controlRoot, executionRoot: f.root, ownerThreadId: 'owner-test', ownerTurnId: 'turn-test' };
    if (interrupted) {
      const original = WorkbenchTransactionStore.prototype.transferCliOwners;
      WorkbenchTransactionStore.prototype.transferCliOwners = () => { throw new Error('injected transfer interruption'); };
      try { await assert.rejects(launchCliRequest(request, context), /injected transfer interruption/); }
      finally { WorkbenchTransactionStore.prototype.transferCliOwners = original; }
      assert.throws(() => c.cli.read(c.binding), /identity mismatch/);
      assert.equal(f.store.snapshot().tasks[c.record.taskId].execution.ownerThreadId, 'owner-test');
    }
    await launchCliRequest(request, context);
    const moved = f.store.snapshot().tasks[c.record.taskId];
    assert.equal(moved.deliveryContract.resultOwnerThreadId, 'successor');
    assert.equal(moved.deliveryContract.acceptanceOwnerThreadId, 'successor');
    assert.equal(sha256File(c.run.resultPath), originalResultHash);
    const newBinding = { ...c.binding, ownerThreadId: 'successor' }, transferred = c.cli.read(newBinding);
    assert.equal(transferred.sessionId, originalState.sessionId);
    assert.equal(transferred.runNumber, originalState.runNumber);
    assert.deepEqual(transferred.configuration, originalState.configuration);
    assert.throws(() => f.runtime('workbench.accept-cli', acceptCli(c)), /identity mismatch/);
    reviewCli(c, 'successor');
    f.runtime('workbench.accept-cli', acceptCli(c, moved, 'successor'), 'successor');
    const after = f.store.snapshot();
    await launchCliRequest(request, context);
    assert.deepEqual(f.store.snapshot(), after);
    assert.equal(f.store.history('2026-10').records.length, 1);
    assert.equal(f.store.history('2026-10').records[0].sessionId, originalState.sessionId);
  });
}

test('a prepared formal CLI owner transfer holds contract revisions until the same transfer settles', async t => {
  const f = fixture(t), c = formalCli(f), originalState = c.cli.read(c.binding);
  const operationId = 'cli-transfer-prepared', authorizationLocator = 'fixture/user-approved-owner-transfer';
  const expectedResultSha256 = sha256File(c.run.resultPath), expectedStateSha256 = digest(originalState);
  const beforeWorkbench = f.store.snapshot();
  c.cli.beginTransfer({ ownerThreadId: 'owner-test' }, {
    operationId, projectId: c.record.projectId, taskId: c.record.taskId, fromOwnerThreadId: 'owner-test', toOwnerThreadId: 'successor',
    expectedStateSha256, expectedResultSha256, expectedRunNumber: 1, expectedSessionId: originalState.sessionId,
    authorizationLocator, expectedWorkbenchTaskSha256: digest(beforeWorkbench.tasks[c.record.taskId]), expectedWorkbenchStatus: '进行中',
  });
  const input = revision(c.record);
  assert.throws(() => f.runtime('workbench.revise-delivery', input), /CLI owner transfer pending/);
  assert.deepEqual(f.store.snapshot(), beforeWorkbench);
  const request = { schemaVersion: 1, requestId: 'prepared', action: 'cli.transfer',
    input: { projectId: c.record.projectId, fromOwnerThreadId: 'owner-test', toOwnerThreadId: 'successor',
      expectedWorkbenchStateRevision: beforeWorkbench.revision, authorizationLocator,
      tasks: [{ taskId: c.record.taskId, expectedSessionId: originalState.sessionId, expectedRunNumber: 1,
        expectedStateSha256, expectedResultSha256, expectedStatus: '进行中' }] } };
  await launchCliRequest(request, { controlRoot: f.controlRoot, executionRoot: f.root, ownerThreadId: 'owner-test', ownerTurnId: 'turn-test' });
  const moved = f.store.snapshot().tasks[c.record.taskId];
  const nextRevision = revision(moved, { operationId: 'revision-after-transfer' });
  f.runtime('workbench.revise-delivery', nextRevision, 'successor');
  assert.equal(f.store.snapshot().tasks[c.record.taskId].deliveryContractHistory.length, 1);
  assert.equal(c.cli.read({ ...c.binding, ownerThreadId: 'successor' }).sessionId, originalState.sessionId);
  assert.equal(sha256File(c.run.resultPath), expectedResultSha256);
});

test('a stale formal CLI transfer request cannot take ownership after the original owner starts another round', async t => {
  const f = fixture(t), c = formalCli(f), originalState = c.cli.read(c.binding);
  const request = { schemaVersion: 1, requestId: 'running-transfer', action: 'cli.transfer',
    input: { projectId: c.record.projectId, fromOwnerThreadId: 'owner-test', toOwnerThreadId: 'successor',
      expectedWorkbenchStateRevision: f.store.snapshot().revision, authorizationLocator: 'fixture/user-approved-idle-transfer',
      tasks: [{ taskId: c.record.taskId, expectedSessionId: originalState.sessionId, expectedRunNumber: 1,
        expectedStateSha256: digest(originalState), expectedResultSha256: sha256File(c.run.resultPath), expectedStatus: '进行中' }] } };
  c.cli.recordReview({ projectId: c.binding.projectId, taskId: c.binding.taskId, ownerThreadId: c.binding.ownerThreadId,
    runNumber: 1, resultSha256: sha256File(c.run.resultPath), decision: 'continue', evidenceLocator: 'fixture/approved-next-round',
    conclusion: 'continue the same approved goal', reviewedAt: now });
  const run = c.cli.beginRun(c.binding, { requestId: 'running-round-two', prompt: 'fixture approved next round',
    expectedRunNumber: 1, expectedSessionId: originalState.sessionId });
  c.cli.setProcess(run, { ...currentProcessIdentity(), token: ['fixture', 'running', 'manager'].join('-') });
  const beforeCli = c.cli.read(c.binding), beforeWorkbench = f.store.snapshot(), resultHash = sha256File(c.run.resultPath);
  // The active second round has no terminal result, so the real transfer entry
  // rejects while reading its required result, before any ownership writes.
  await assert.rejects(launchCliRequest(request, { controlRoot: f.controlRoot, executionRoot: f.root,
    ownerThreadId: 'owner-test', ownerTurnId: 'turn-test' }), { message: 'CLI record not found' });
  assert.deepEqual(c.cli.read(c.binding), beforeCli);
  assert.deepEqual(f.store.snapshot(), beforeWorkbench);
  assert.equal(sha256File(c.run.resultPath), resultHash);
  assert.equal(beforeCli.status, 'running');
  assert.equal(fs.existsSync(c.cli.transferDirectory(c.binding, 'cli-transfer-running-transfer')), false);
});

function documentedExamples() {
  const document = fs.readFileSync(new URL('../../docs/AI编程协同机制/机制/03-跨任务协同与共享对象机制.md', import.meta.url), 'utf8');
  const example = name => {
    const marker = `<!-- ${name} -->`;
    const start = document.indexOf(marker);
    assert.ok(start >= 0, `missing documentation marker ${name}`);
    const match = document.slice(start + marker.length).match(/^\s*```json\s+([\s\S]*?)\s*```/);
    assert.ok(match, `missing JSON example ${name}`);
    return JSON.parse(match[1]);
  };
  return { contract: example('delivery-contract-example'), evidence: example('delivery-evidence-example') };
}

for (const kind of ['desktop', 'cli']) {
  test(`documented ${kind} contract/evidence objects work through registration and acceptance without field invention`, t => {
    const f = fixture(t), examples = documentedExamples();
    if (kind === 'desktop') {
      const record = task();
      record.deliveryContract = { ...examples.contract, resultOwnerThreadId: record.worker, acceptanceOwnerThreadId: 'owner-test' };
      f.runtime('workbench.register', record);
      const input = acceptance(record, { deliveryEvidence: examples.evidence });
      for (const field of ['expectedDeliveryContract', 'deliveryEvidence']) {
        const missing = structuredClone(input); delete missing[field];
        assert.throws(() => f.runtime('workbench.accept', missing), /acceptance contract changed|every agreed criterion/);
      }
      assert.equal(f.runtime('workbench.accept', input).status, '已完成');
    } else {
      // Replace only the example's identities. The supplied engineering fields
      // and evidence are consumed verbatim, not reconstructed by this test.
      const c = formalCli(f, 'formal-cli', examples.contract);
      const record = f.store.snapshot().tasks[c.record.taskId];
      reviewCli(c);
      const accepted = { ...acceptCli(c, record), deliveryEvidence: examples.evidence };
      for (const field of ['expectedDeliveryContract', 'deliveryEvidence']) {
        const missing = structuredClone(accepted); delete missing[field];
        assert.throws(() => f.runtime('workbench.accept-cli', missing), /acceptance contract changed|every agreed criterion/);
      }
      assert.equal(f.runtime('workbench.accept-cli', accepted).status, '已完成');
      assert.equal(f.store.history('2026-10').records[0].sessionId, 'preserved-native-session');
    }
  });
}
