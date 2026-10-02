import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliTaskStore, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { WorkbenchTransactionStore } from '../模板交付包/scripts/runtime/workbench-transaction.mjs';
import { executeRuntimeRequest } from '../模板交付包/scripts/runtime/control-runtime.mjs';

const time = '2026-10-02T01:00:00.000Z';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-workbench-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'local/projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'local/projects/local-cli.md'), `---\nid: local-cli\npath: ${root}\nhost_id: local\ncodex_project_id: desktop-project\n---\n`);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: local-cli -->\n');
  const store = new WorkbenchTransactionStore({ runtimeRoot: path.join(root, 'local/runtime/workbench'), viewPath: path.join(root, 'local/当前工作台.md'), historyRoot: path.join(root, 'local/history/workbench') });
  const cli = new CliTaskStore({ controlRoot: root }), context = { controlRoot: root, executionRoot: root, ownerThreadId: 'pm-owner' };
  const binding = taskId => ({ projectId: 'local-cli', taskId, ownerThreadId: 'pm-owner', ownerTurnId: 'turn-one', executionRoot: root, profilePath: path.join(root, 'profile.json'), taskMode: 'formal', contract: { goal: taskId, boundaries: 'temporary only', acceptance: 'tests', factEntries: [], skillEntries: [] } });
  const register = taskId => executeRuntimeRequest({ schemaVersion: 1, requestId: `register-${taskId}`, action: 'workbench.register', input: { projectId: 'local-cli', taskId, task: `goal ${taskId}`, execution: { kind: 'cli', ownerThreadId: 'pm-owner', stateLocator: cli.locator(binding(taskId)) }, status: '进行中', progress: 'pending CLI', pause: '无', updatedAt: time } }, context);
  const call = (action, input) => executeRuntimeRequest({ schemaVersion: 1, requestId: `request-${input.operationId ?? input.taskId}`, action, input }, context);
  function ready(taskId, decision = 'accept') {
    cli.create(binding(taskId)); const run = cli.beginRun(binding(taskId), { requestId: 'first', prompt: 'work', expectedRunNumber: 0, expectedSessionId: null });
    cli.bindSession(run, 'session-one'); cli.finishRun(run, { status: 'completed', exitCode: 0, finalText: 'real result' });
    cli.recordReview({ projectId: 'local-cli', taskId, ownerThreadId: 'pm-owner', runNumber: 1, resultSha256: sha256File(run.resultPath), decision, evidenceLocator: 'file:tested-artifact', conclusion: 'goal checked', reviewedAt: time });
    return { projectId: 'local-cli', taskId, ownerThreadId: 'pm-owner', operationId: `accept-${taskId}`, expectedStatus: '进行中', runNumber: 1, resultSha256: sha256File(run.resultPath), businessState: '已完成', acceptance: 'accepted', acceptedBy: 'pm-owner', acceptedAt: time, completedAt: time, finalLocator: run.resultPath, evidenceLocator: 'file:tested-artifact', conclusion: 'goal checked' };
  }
  return { root, store, cli, context, binding, register, call, ready };
}
test('PM can own two distinct CLI goals without inventing Worker identities', t => {
  const f = fixture(t); f.register('goal-a'); f.register('goal-b');
  const records = Object.values(f.store.snapshot().tasks); assert.equal(records.length, 2);
  assert.equal(records.every(r => r.execution.ownerThreadId === 'pm-owner' && !Object.hasOwn(r, 'worker')), true);
  assert.match(f.store.view(), /CLI/); assert.match(f.store.view(), /pm-owner/);
});

test('CLI registration accepts an equivalent absolute state locator, rejecting a different or relative path', t => {
  const f = fixture(t);
  const registration = { projectId: 'local-cli', taskId: 'portable', task: 'portable goal', execution: { kind: 'cli', ownerThreadId: 'pm-owner', stateLocator: f.cli.locator(f.binding('portable')).replaceAll('\\', '/').replace('/task.json', '/./task.json') }, status: '进行中', progress: 'pending CLI', pause: '无', updatedAt: time };
  assert.equal(f.call('workbench.register', registration).result.taskId, 'portable');
  const before = fs.readFileSync(f.store.stateFile);
  assert.throws(() => f.call('workbench.register', { ...registration, taskId: 'bad', execution: { ...registration.execution, stateLocator: path.join(f.root, 'other.json') } }), /locator identity/);
  assert.throws(() => f.call('workbench.register', { ...registration, taskId: 'relative', execution: { ...registration.execution, stateLocator: 'local/runtime/cli-tasks/local-cli/relative/task.json' } }), /locator identity/);
  assert.deepEqual(fs.readFileSync(f.store.stateFile), before);
});
test('legacy Worker remains unique and CLI cannot use legacy acceptance', t => {
  const f = fixture(t);
  const worker = { taskId: 'old', task: 'legacy task', worker: 'worker-one', status: '进行中', progress: 'work', pause: '无', updatedAt: time };
  f.store.registerTask(worker); assert.throws(() => f.store.registerTask({ ...worker, taskId: 'old-two', task: 'other' }), /worker already/);
  f.register('cli'); const input = f.ready('cli');
  assert.throws(() => f.call('workbench.accept', { ...input, worker: 'pm-owner' }), /CLI|unique/);
  assert.equal(f.store.snapshot().tasks.cli.status, '进行中');
});
test('CLI acceptance requires current stored result, matching fingerprint and owner review', t => {
  const f = fixture(t); f.register('goal');
  assert.throws(() => f.call('workbench.accept-cli', { ...f.binding('goal'), operationId: 'early', runNumber: 1, expectedStatus: '进行中' }), /not found|result/);
  const input = f.ready('goal', 'continue');
  assert.throws(() => f.call('workbench.accept-cli', input), /review|accept/);
  assert.throws(() => f.call('workbench.accept-cli', { ...input, ownerThreadId: 'other' }), /identity/);
  assert.throws(() => f.call('workbench.accept-cli', { ...input, resultSha256: 'wrong' }), /fingerprint/);
  assert.equal(f.store.history('2026-10').records.length, 0);
});
test('CLI acceptance replay archives once, stores execution not a fake worker, no pending/ack', t => {
  const f = fixture(t); f.register('goal'); const input = f.ready('goal');
  const first = f.call('workbench.accept-cli', input).result, replay = f.call('workbench.accept-cli', input).result;
  assert.deepEqual(first, replay); assert.equal(first.status, '已完成'); assert.equal(first.execution.kind, 'cli'); assert.equal(Object.hasOwn(first, 'worker'), false);
  assert.equal(f.store.history('2026-10').records.length, 1); assert.equal(f.store.history('2026-10').records[0].execution.ownerThreadId, 'pm-owner');
  assert.equal(Object.keys(f.store.snapshot().tasks).length, 0); assert.equal(fs.existsSync(path.join(f.root, 'local/runtime/worker-results')), false);
});
test('CLI fault recovery completes exactly once at each transaction stage', t => {
  for (const faultAt of ['afterIntent', 'afterStateCommit', 'afterHistoryWrite', 'afterViewWrite']) {
    const f = fixture(t); f.register('goal'); const input = f.ready('goal');
    assert.throws(() => f.store.consumeAcceptedCliResult(input, { faultAt }), /injected fault/);
    f.store.recover(); assert.equal(f.store.snapshot().tasks.goal, undefined); assert.equal(f.store.history('2026-10').records.length, 1);
    assert.equal(f.store.history('2026-10').records[0].execution.kind, 'cli');
  }
});
test('closed CLI goal rejects late acceptance and closure needs actual stopped evidence', t => {
  const f = fixture(t); f.register('goal'); const input = f.ready('goal');
  const close = { projectId: 'local-cli', taskId: 'goal', ownerThreadId: 'pm-owner', operationId: 'close-goal', expectedStatus: '进行中', ownerDirective: 'explicit-owner-instruction', businessState: '已关闭', closedBy: 'pm-owner', closedAt: time, closureReason: 'user cancelled', taskLocator: input.finalLocator, authorizationLocator: 'thread:owner/user-stop', stateSha256: 'wrong' };
  assert.throws(() => f.call('workbench.close', close), /fingerprint/);
  const { digest } = fixtureDigest; close.stateSha256 = digest(f.cli.read(f.binding('goal')));
  f.call('workbench.close', close);
  assert.throws(() => f.call('workbench.accept-cli', input), /active|closed|missing/);
  assert.equal(f.store.history('2026-10').records[0].status, '已关闭');
});
import * as fixtureDigest from '../模板交付包/scripts/cli/cli-task-store.mjs';
test('wrong project or owner leaves workbench bytes unchanged', t => {
  const f = fixture(t), before = fs.readFileSync(f.store.stateFile);
  const registration = { projectId: 'wrong-project', taskId: 'bad', task: 'bad', execution: { kind: 'cli', ownerThreadId: 'pm-owner', stateLocator: f.cli.locator(f.binding('bad')) }, status: '进行中', progress: 'work', pause: '无', updatedAt: time };
  assert.throws(() => f.call('workbench.register', registration), /registered/);
  assert.deepEqual(fs.readFileSync(f.store.stateFile), before);
  assert.throws(() => f.call('workbench.register', { ...registration, projectId: 'local-cli', execution: { ...registration.execution, ownerThreadId: 'other' } }), /identity/);
  assert.deepEqual(fs.readFileSync(f.store.stateFile), before);
});
