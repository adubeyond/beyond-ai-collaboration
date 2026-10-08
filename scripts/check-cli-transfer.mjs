import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { CliTaskStore, atomicJson, digest, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { currentProcessIdentity } from '../模板交付包/scripts/cli/process-identity.mjs';
import { launchCliRequest } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { WorkbenchTransactionStore } from '../模板交付包/scripts/runtime/workbench-transaction.mjs';

const time = '2026-10-08T01:00:00.000Z';
const dead = { pid: spawnSync(process.execPath, ['-e', '']).pid, startedAt: 'exited-test-process' };
function fixture(t, projectId = 'local-neutral') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'local/projects'), { recursive: true });
  fs.writeFileSync(path.join(root, `local/projects/${projectId}.md`), `---\nid: ${projectId}\npath: ${root}\nhost_id: local\ncodex_project_id: desktop-project\n---\n`);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), `<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: ${projectId} -->\n`);
  const cli = new CliTaskStore({ controlRoot: root });
  const bench = new WorkbenchTransactionStore({ runtimeRoot: path.join(root, 'local/runtime/workbench'), viewPath: path.join(root, 'local/当前工作台.md'), historyRoot: path.join(root, 'local/history/workbench') });
  const identity = (taskId, ownerThreadId = 'owner-a') => ({ projectId, taskId, ownerThreadId });
  function ready(taskId, { decision = null, legacy = false } = {}) {
    const id = identity(taskId);
    bench.registerTask({ taskId, projectId, task: taskId, execution: { kind: 'cli', ownerThreadId: id.ownerThreadId, stateLocator: cli.locator(id) }, status: '进行中', progress: 'working', pause: '无', updatedAt: time });
    cli.create({ ...id, taskMode: 'formal', ownerTurnId: 'source-turn', executionRoot: root, profilePath: path.join(root, 'profile.json'), contract: { goal: 'deliver result', boundaries: 'test only', acceptance: 'owner checks evidence', factEntries: ['existing-business-doc'], skillEntries: [], ...(legacy ? { crawlerRepairProcess: { processId: 'OLD-001' }, crawlerRepairDeclared: true } : {}) } });
    const run = cli.beginRun(id, { requestId: 'first', prompt: 'work', expectedRunNumber: 0, expectedSessionId: null });
    cli.bindSession(run, `session-${taskId}`);
    cli.finishRun(run, { status: 'completed', exitCode: 0, finalText: 'partial business result', completedAt: time });
    if (legacy) {
      const dir = cli.runDir(id, 1), input = cli.readJson(path.join(dir, 'input.json'));
      atomicJson(path.join(dir, 'input.json'), { ...input, crawlerRepairProcess: { processId: 'OLD-001' }, crawlerRepairCheckpoint: true });
      atomicJson(run.resultPath, { ...cli.readResult(id, 1), repairProcess: { processId: 'OLD-001', oldEvidence: 'preserved' } });
    }
    if (decision) review(taskId, 'owner-a', decision);
    return id;
  }
  function review(taskId, ownerThreadId, decision, extra = {}) {
    const id = identity(taskId, ownerThreadId), state = cli.read(id);
    return cli.recordReview({ ...id, runNumber: state.runNumber, resultSha256: sha256File(state.currentResultPath), decision, conclusion: decision === 'continue' ? 'business evidence is incomplete; continue original goal' : 'business evidence verified', evidenceLocator: 'file:existing-business-test', reviewedAt: time, ...extra });
  }
  function request(taskIds, owner = 'owner-a', to = 'owner-b', requestId = 'handoff') {
    return { schemaVersion: 1, action: 'cli.transfer', requestId, input: { projectId, fromOwnerThreadId: owner, toOwnerThreadId: to, authorizationLocator: 'thread:user/explicit-handoff', expectedWorkbenchStateRevision: bench.snapshot().revision, tasks: taskIds.map(taskId => { const state = cli.read(identity(taskId, owner)); return { taskId, expectedStateSha256: digest(state), expectedRunNumber: state.runNumber, expectedSessionId: state.sessionId, expectedResultSha256: sha256File(state.currentResultPath) }; }) } };
  }
  const send = (request, ownerThreadId = request.input.fromOwnerThreadId) => launchCliRequest(request, { controlRoot: root, executionRoot: root, ownerThreadId });
  function intent(request, taskId) {
    const { tasks, expectedWorkbenchStateRevision, ...base } = request.input;
    return { ...base, ...tasks.find(item => item.taskId === taskId), operationId: `cli-transfer-${request.requestId}`, expectedWorkbenchTaskSha256: digest(bench.snapshot().tasks[taskId]), expectedWorkbenchStatus: bench.snapshot().tasks[taskId].status };
  }
  return { root, cli, bench, identity, ready, request, send, review, intent };
}
test('generic owner transfer preserves old result, review, notification and the same session', async t => {
  const f = fixture(t); const old = f.ready('goal', { decision: 'continue', legacy: true });
  f.cli.claimNotification(old, 1); f.cli.finishNotification(old, 1, { status: 'delivered' });
  const dir = f.cli.runDir(old, 1), files = ['run.json', 'input.json', 'result.json', 'review.json', 'notification.json'];
  const before = files.map(leaf => sha256File(path.join(dir, leaf)));
  const req = f.request(['goal']); await f.send(req);
  const next = f.identity('goal', 'owner-b');
  assert.equal(f.bench.snapshot().tasks.goal.execution.ownerThreadId, 'owner-b');
  assert.equal(f.cli.read(next).sessionId, 'session-goal');
  assert.deepEqual(files.map(leaf => sha256File(path.join(dir, leaf))), before);
  assert.equal(f.cli.readResult(next, 1).ownerThreadId, 'owner-a');
  assert.equal(f.cli.readReview(next, 1), null);
  assert.throws(() => f.cli.read(old), /identity/);
  assert.throws(() => f.cli.claimNotification(next, 1), /original owner/);
  assert.throws(() => f.cli.beginRun(next, { requestId: 'second', prompt: 'finish goal', expectedRunNumber: 1, expectedSessionId: 'session-goal' }), /review/);
  f.review('goal', 'owner-b', 'continue');
  const run = f.cli.beginRun(next, { requestId: 'second', prompt: 'finish goal', expectedRunNumber: 1, expectedSessionId: 'session-goal', profile: { provider: 'zcode', model: 'model-new', effort: 'high' }, configuration: { model: 'model-new', effort: 'high' } });
  assert.equal(run.ownerThreadId, 'owner-b'); assert.equal(run.sessionId, 'session-goal');
  f.cli.finishRun(run, { status: 'completed', finalText: 'new goal result' });
  assert.equal(f.cli.claimNotification(next, 2).claimed, true);
  assert.equal(f.cli.readResult(next, 2).configuration.model, 'model-new');
  assert.deepEqual(files.map(leaf => sha256File(path.join(dir, leaf))), before);
  await f.send(req); // replay after successor work is a no-op, not a re-transfer
  assert.equal(f.cli.read(next).runNumber, 2);
});
test('successor can accept preserved result exactly once without predecessor approval or crawler packet gates', async t => {
  const f = fixture(t); f.ready('goal', { legacy: true }); await f.send(f.request(['goal']));
  const id = f.identity('goal', 'owner-b'), state = f.cli.read(id);
  const input = { ...id, operationId: 'accept-goal', expectedStatus: '进行中', runNumber: 1, resultSha256: sha256File(state.currentResultPath), businessState: '已完成', acceptance: 'accepted', acceptedBy: 'owner-b', acceptedAt: time, completedAt: time, finalLocator: state.currentResultPath, evidenceLocator: 'file:existing-business-test', conclusion: 'all business evidence checked' };
  assert.throws(() => f.bench.consumeAcceptedCliResult(input), /review/);
  f.review('goal', 'owner-b', 'accept');
  f.bench.consumeAcceptedCliResult(input); f.bench.consumeAcceptedCliResult(input);
  assert.equal(f.bench.history('2026-10').records.length, 1);
  assert.equal(f.cli.readResult(id, 1).repairProcess.oldEvidence, 'preserved');
});
test('legacy extra fields are preserved while same-owner continuation uses only generic review contract', t => {
  const f = fixture(t); const id = f.ready('goal', { legacy: true, decision: 'continue' });
  const oldResult = sha256File(f.cli.read(id).currentResultPath);
  const next = f.cli.beginRun(id, { requestId: 'new-run', prompt: 'continue normal goal', expectedRunNumber: 1, expectedSessionId: 'session-goal' });
  f.cli.finishRun(next, { status: 'failed', error: 'business test failed' });
  assert.equal(sha256File(path.join(f.cli.runDir(id, 1), 'result.json')), oldResult);
  assert.equal(f.cli.read(id).contract.crawlerRepairDeclared, true);
  assert.equal(f.cli.readResult(id, 2).status, 'failed');
});
test('wrong owner, hash, revision or one invalid task rejects the whole set without changing tasks', async t => {
  const f = fixture(t); f.ready('a'); f.ready('b'); const req = f.request(['a', 'b']);
  const before = [f.bench.stateFile, f.cli.locator(f.identity('a')), f.cli.locator(f.identity('b'))].map(sha256File);
  await assert.rejects(() => f.send(req, 'stranger'), /caller/);
  const hash = structuredClone(req); hash.input.tasks[1].expectedResultSha256 = '0'.repeat(64);
  await assert.rejects(() => f.send(hash), /fingerprint/);
  const stale = structuredClone(req); stale.input.expectedWorkbenchStateRevision = 0;
  await assert.rejects(() => f.send(stale), /revision/);
  const auth = structuredClone(req); auth.input.authorizationLocator = '';
  await assert.rejects(() => f.send(auth), /authorization/);
  assert.deepEqual([f.bench.stateFile, f.cli.locator(f.identity('a')), f.cli.locator(f.identity('b'))].map(sha256File), before);
});
test('partial transfer can recover after unrelated workbench progress, and pending transfer prevents resume/review', async t => {
  const f = fixture(t); f.ready('a', { decision: 'continue' }); f.ready('b'); const req = f.request(['a', 'b']);
  const a = f.intent(req, 'a'), b = f.intent(req, 'b');
  f.cli.beginTransfer({ ownerThreadId: 'owner-a' }, a); f.cli.beginTransfer({ ownerThreadId: 'owner-a' }, b);
  f.cli.applyTransfer(a);
  assert.throws(() => f.cli.beginRun(f.identity('a', 'owner-b'), { requestId: 'early', prompt: 'resume', expectedRunNumber: 1, expectedSessionId: 'session-a' }), /transfer pending/);
  assert.throws(() => f.review('b', 'owner-a', 'continue'), /transfer pending/);
  f.ready('unrelated'); // changes global revision, not either task's registered identity
  await f.send(req);
  assert.equal(f.bench.snapshot().tasks.a.execution.ownerThreadId, 'owner-b');
  assert.equal(f.bench.snapshot().tasks.b.execution.ownerThreadId, 'owner-b');
  assert.equal(f.bench.snapshot().tasks.unrelated.execution.ownerThreadId, 'owner-a');
  await f.send(req); assert.equal(f.bench.snapshot().revision, 4);
});
test('changed task during partial transfer is not silently reparented', async t => {
  const f = fixture(t); f.ready('a'); const req = f.request(['a']), intent = f.intent(req, 'a');
  f.cli.beginTransfer({ ownerThreadId: 'owner-a' }, intent); f.cli.applyTransfer(intent);
  const state = f.bench.snapshot(); state.tasks.a.task = 'another goal'; atomicJson(f.bench.stateFile, state);
  await assert.rejects(() => f.send(req), /task changed/);
  assert.equal(f.bench.snapshot().tasks.a.execution.ownerThreadId, 'owner-a');
});
test('second transfer works after new owner review and another completed same-session run', async t => {
  const f = fixture(t); f.ready('goal'); await f.send(f.request(['goal']));
  f.review('goal', 'owner-b', 'continue');
  const run = f.cli.beginRun(f.identity('goal', 'owner-b'), { requestId: 'second', prompt: 'next part', expectedRunNumber: 1, expectedSessionId: 'session-goal' });
  f.cli.finishRun(run, { status: 'completed', finalText: 'still original session' });
  await f.send(f.request(['goal'], 'owner-b', 'owner-c', 'second-handoff'));
  const id = f.identity('goal', 'owner-c'); assert.equal(f.cli.read(id).ownerTransfers.length, 2);
  assert.equal(f.cli.readResult(id, 1).ownerThreadId, 'owner-a'); assert.equal(f.cli.readResult(id, 2).ownerThreadId, 'owner-b');
  assert.equal(f.cli.readReview(id, 2), null);
});
test('live saved CLI process blocks transfer; historical launcher caller does not block an exited manager', async t => {
  const f = fixture(t); const id = f.ready('goal'), dir = f.cli.runDir(id, 1);
  atomicJson(path.join(dir, 'manager-process.json'), dead);
  atomicJson(path.join(dir, 'manager-claim.json'), { caller: currentProcessIdentity() });
  atomicJson(path.join(dir, 'cli-process.json'), currentProcessIdentity());
  const req = f.request(['goal']); await assert.rejects(() => f.send(req), /still alive/);
  atomicJson(path.join(dir, 'cli-process.json'), dead);
  await f.send(req); assert.equal(f.bench.snapshot().tasks.goal.execution.ownerThreadId, 'owner-b');
});
for (const provider of ['codex', 'zcode', 'claude']) test(`${provider}: idle helper is detached once, while native session and old events remain`, async t => {
  const f = fixture(t), id = f.ready('goal'), file = path.join(f.cli.taskDir(id), 'interactive.json');
  let calls = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/detach'); assert.equal(req.headers.authorization, 'Bearer test-token'); calls++;
    atomicJson(file, { ...f.cli.readJson(file), status: 'closed', manager: dead, server: dead });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'detached' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const tokenPath = path.join(f.cli.taskDir(id), 'remote-token'); fs.writeFileSync(tokenPath, 'test-token');
  atomicJson(file, { ...id, provider, status: 'idle', sessionId: 'session-goal', activeTurnId: null, manager: currentProcessIdentity(), server: currentProcessIdentity(), controlUrl: `http://127.0.0.1:${server.address().port}`, tokenPath });
  const req = f.request(['goal']); await f.send(req); await f.send(req);
  assert.equal(calls, 1); assert.equal(f.cli.readJson(file).ownerThreadId, 'owner-b');
  assert.equal(f.cli.read(f.identity('goal', 'owner-b')).sessionId, 'session-goal');
});
test('an active native turn is never detached or transferred', async t => {
  const f = fixture(t), id = f.ready('goal');
  atomicJson(path.join(f.cli.taskDir(id), 'interactive.json'), { ...id, status: 'running', activeTurnId: 'still-working', manager: currentProcessIdentity(), server: currentProcessIdentity(), controlUrl: 'http://127.0.0.1:1' });
  await assert.rejects(() => f.send(f.request(['goal'])), /active business/);
  assert.equal(f.cli.read(id).ownerThreadId, 'owner-a');
});
test('paused workbench task stays paused after owner transfer', async t => {
  const f = fixture(t); f.ready('goal', { decision: 'pause' });
  const snapshot = f.bench.snapshot(); snapshot.tasks.goal.status = '已暂停'; atomicJson(f.bench.stateFile, snapshot);
  await f.send(f.request(['goal'])); assert.equal(f.bench.snapshot().tasks.goal.status, '已暂停');
});
test('returning ownership to a previous owner still requires a fresh review', async t => {
  const f = fixture(t); f.ready('goal', { decision: 'continue' }); await f.send(f.request(['goal']));
  f.review('goal', 'owner-b', 'continue');
  await f.send(f.request(['goal'], 'owner-b', 'owner-a', 'return-owner'));
  assert.equal(f.cli.readReview(f.identity('goal'), 1), null);
  f.review('goal', 'owner-a', 'pause');
  assert.equal(f.cli.readReview(f.identity('goal'), 1).decision, 'pause');
});
for (const phase of ['authorized', 'endpoint-changed', 'task-changed', 'workbench-committed', 'one-completed']) test(`crash recovery: ${phase} resumes the same transaction without changing old results`, async t => {
  const f = fixture(t); f.ready('a'); f.ready('b'); const req = f.request(['a', 'b']);
  const intents = ['a', 'b'].map(taskId => f.intent(req, taskId));
  const endpointFile = path.join(f.cli.taskDir(f.identity('a')), 'interactive.json');
  atomicJson(endpointFile, { ...f.identity('a'), status: 'closed', manager: dead, server: dead });
  const resultHashes = ['a', 'b'].map(taskId => sha256File(f.cli.read(f.identity(taskId)).currentResultPath));
  for (const intent of intents) f.cli.beginTransfer({ ownerThreadId: 'owner-a' }, intent);
  if (phase === 'endpoint-changed') atomicJson(endpointFile, { ...f.cli.readJson(endpointFile), ownerThreadId: 'owner-b', transferOperationId: intents[0].operationId });
  if (phase === 'task-changed') f.cli.applyTransfer(intents[0]);
  if (['workbench-committed', 'one-completed'].includes(phase)) {
    for (const intent of intents) f.cli.applyTransfer(intent);
    f.bench.transferCliOwners({ operationId: intents[0].operationId, projectId: req.input.projectId, fromOwnerThreadId: 'owner-a', toOwnerThreadId: 'owner-b', expectedStateRevision: req.input.expectedWorkbenchStateRevision, tasks: intents.map(item => ({ taskId: item.taskId, expectedStatus: '进行中' })) });
    if (phase === 'one-completed') f.cli.completeTransfer(intents[0], { workbenchStateSha256: sha256File(f.bench.stateFile) });
  }
  await f.send(req);
  assert.deepEqual(['a', 'b'].map(taskId => sha256File(f.cli.read(f.identity(taskId, 'owner-b')).currentResultPath)), resultHashes);
  assert.equal(f.bench.snapshot().revision, 3);
  assert.equal(Object.keys(f.bench.snapshot().tasks).length, 2);
});
test('all saved-process proofs are checked before any task acquires a pending transfer', async t => {
  const f = fixture(t); const a = f.ready('a'); const b = f.ready('b');
  atomicJson(path.join(f.cli.runDir(b, 1), 'cli-process.json'), currentProcessIdentity());
  await assert.rejects(() => f.send(f.request(['a', 'b'])), /still alive/);
  assert.doesNotThrow(() => f.cli.assertTransferSettled(a));
  f.review('a', 'owner-a', 'continue');
});
