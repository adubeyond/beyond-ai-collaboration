import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliTaskStore, atomicJson, digest, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { launchCliRequest } from '../模板交付包/scripts/cli/cli-bridge.mjs';

// Synthetic, local records only. No CLI runner, model API, business task, or
// platform messaging is invoked. This protects the existing authorized recovery
// contract; it does not authorize new recovery of a real archived task.
const initial = { goal: 'old isolated foundation', boundaries: 'fixture only', acceptance: 'fixture accepted', factEntries: [], skillEntries: [] };
const revised = { ...initial, goal: 'new explicitly authorized isolated result', acceptance: 'new fixture result' };
const profile = { provider: 'claude', mode: 'interactive', model: 'preserved-model', runner: { command: 'fixture-never-executed' } };
const configuration = { model: profile.model, effort: null };

function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true })
    .filter(name => fs.statSync(path.join(root, name)).isFile()).sort()
    .map(name => [name, sha256File(path.join(root, name))]));
}

function fixture(t, { recovered = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-accepted-preservation-'));
  t.after(() => {
    const physical = fs.realpathSync(root), temporary = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(physical).toLowerCase(), temporary.toLowerCase());
    assert.ok(path.basename(physical).startsWith('beyond-accepted-preservation-'));
    fs.rmSync(physical, { recursive: true });
  });
  const binding = { projectId: 'preserved-project', taskId: 'preserved-task', ownerThreadId: 'original-owner', ownerTurnId: 'old-turn',
    taskMode: 'assist', executionRoot: root, profilePath: path.join(root, 'profile.json'), contract: structuredClone(initial) };
  fs.mkdirSync(path.join(root, 'local/projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'local/projects', binding.projectId + '.md'),
    `---\nid: ${binding.projectId}\npath: ${root}\nhost_id: local\ncodex_project_id: isolated-platform-project\n---\n`);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), `<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: ${binding.projectId} -->\n`);
  const store = new CliTaskStore({ controlRoot: root });
  store.create(binding);
  const first = store.beginRun(binding, { requestId: 'old-request', prompt: 'old fixture only', expectedRunNumber: 0,
    expectedSessionId: null, profile: structuredClone(profile), configuration: structuredClone(configuration) });
  store.bindSession(first, 'preserved-native-session');
  store.finishRun(first, { status: 'completed', sessionId: 'preserved-native-session', finalText: 'old accepted result remains byte-identical' });
  store.recordReview({ projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: binding.ownerThreadId, runNumber: 1,
    resultSha256: sha256File(first.resultPath), decision: 'accept', evidenceLocator: 'fixture:old-result', conclusion: 'isolated acceptance', reviewedAt: '2026-10-18T00:00:00.000Z' });
  const archive = { projectId: binding.projectId, taskId: binding.taskId, worker: binding.ownerThreadId, status: '已完成', result: 'fixture old result' };
  const historyFile = path.join(root, 'local/history/workbench/2026-10.json');
  fs.mkdirSync(path.dirname(historyFile), { recursive: true }); atomicJson(historyFile, [archive]);
  const authorizationLocator = path.join(root, 'explicit-owner-authorization.txt');
  fs.writeFileSync(authorizationLocator, 'Fixture owner explicitly authorizes a new isolated result using the existing session.');
  const proof = { stateSha256: digest(store.read(binding)), resultSha256: sha256File(first.resultPath),
    reviewSha256: sha256File(path.join(store.runDir(binding, 1), 'review.json')), archiveRecordSha256: digest(archive), reason: 'fixture owner explicit authorization' };
  const options = { requestId: 'authorized-recovery', prompt: 'new isolated result only', expectedRunNumber: 1,
    expectedSessionId: 'preserved-native-session', ownerTurnId: 'authorized-turn', profile: structuredClone(profile),
    configuration: structuredClone(configuration), acceptedGoalRecovery: proof, contract: structuredClone(revised), authorizationLocator };
  const oldHistory = snapshot(store.runDir(binding, 1)), oldArchive = sha256File(historyFile);
  let second;
  if (recovered) {
    second = store.beginRun(binding, options);
    store.finishRun(second, { status: 'failed', sessionId: 'preserved-native-session', finalText: 'later result also remains readable' });
  }
  const context = { controlRoot: root, executionRoot: root, ownerThreadId: binding.ownerThreadId, ownerTurnId: 'inspection-turn' };
  const request = (action, input = {}) => ({ schemaVersion: 1, requestId: 'read-' + action.split('.')[1], action,
    input: { projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: binding.ownerThreadId, ...input } });
  return { root, store, binding, first, second, historyFile, archive, options, context, request, oldHistory, oldArchive };
}

async function rejectedReadWithoutWrites(f, pattern, action = 'cli.status', context = f.context, input = {}) {
  const before = snapshot(f.root);
  await assert.rejects(launchCliRequest(f.request(action, input), context), pattern);
  assert.deepEqual(snapshot(f.root), before);
}

function rejectedRecoveryWithoutWrites(f, patch, pattern) {
  const before = snapshot(f.root);
  assert.throws(() => f.store.beginRun(f.binding, { ...f.options, ...patch }), pattern);
  assert.deepEqual(snapshot(f.root), before);
}

test('archived authorized recovery remains readable through actual bridge status/result without new runs or writes', async t => {
  const f = fixture(t), before = snapshot(f.root);
  const state = await launchCliRequest(f.request('cli.status'), f.context);
  const current = await launchCliRequest(f.request('cli.result', { runNumber: 2 }), f.context);
  const previous = await launchCliRequest(f.request('cli.result', { runNumber: 1 }), f.context);
  assert.equal(state.taskId, f.binding.taskId); assert.equal(state.ownerThreadId, f.binding.ownerThreadId);
  assert.equal(state.sessionId, 'preserved-native-session'); assert.equal(state.runNumber, 2);
  assert.deepEqual(state.configuration, configuration); assert.deepEqual(state.contract, initial);
  assert.deepEqual(state.effectiveContract, revised); assert.equal(current.status, 'failed'); assert.equal(previous.status, 'completed');
  assert.deepEqual(snapshot(f.root), before);
  assert.deepEqual(snapshot(f.store.runDir(f.binding, 1)), f.oldHistory);
  assert.equal(sha256File(f.historyFile), f.oldArchive);
});

test('an archived task without the exact accepted recovery remains rejected', async t => {
  await rejectedReadWithoutWrites(fixture(t, { recovered: false }), /already archived/);
});

test('another caller cannot read or control the original owner session', async t => {
  const f = fixture(t);
  await rejectedReadWithoutWrites(f, /owner identity/, 'cli.status', { ...f.context, ownerThreadId: 'another-owner' });
  await rejectedReadWithoutWrites(f, /identity mismatch/, 'cli.result', { ...f.context, ownerThreadId: 'another-owner' }, { ownerThreadId: 'another-owner', runNumber: 2 });
});

for (const leaf of ['run.json', 'result.json', 'review.json']) test(`changed historical ${leaf} cannot be accepted as preserved recovery`, async t => {
  const f = fixture(t), number = leaf === 'run.json' ? 2 : 1;
  const file = path.join(f.store.runDir(f.binding, number), leaf), record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (leaf === 'run.json') record.effectiveContract.goal = 'tampered history';
  else record.testMutation = 'tampered historical evidence';
  atomicJson(file, record);
  await rejectedReadWithoutWrites(f, /history mismatch|review.*mismatch|result.*mismatch/);
});

test('archive drift remains a blocker even with otherwise valid original recovery', async t => {
  const f = fixture(t); atomicJson(f.historyFile, [{ ...f.archive, result: 'changed archive' }]);
  await rejectedReadWithoutWrites(f, /already archived/);
});

for (const field of ['stateSha256', 'resultSha256', 'reviewSha256']) test(`initial recovery rejects an incorrect ${field} without writes`, t => {
  const f = fixture(t, { recovered: false });
  rejectedRecoveryWithoutWrites(f, { acceptedGoalRecovery: { ...f.options.acceptedGoalRecovery, [field]: '0'.repeat(64) } }, /mismatch/);
});

test('a missing authorization is not promoted to an authorized new goal', t => {
  const f = fixture(t, { recovered: false });
  rejectedRecoveryWithoutWrites(f, { authorizationLocator: undefined }, /authorization/);
  rejectedRecoveryWithoutWrites(f, { authorizationLocator: '' }, /authorization/);
  rejectedRecoveryWithoutWrites(f, { authorizationLocator: path.join(f.root, 'not-authorized.txt') }, /ENOENT|authorization/);
});

test('initial recovery does not silently change the original model or profile', t => {
  const f = fixture(t, { recovered: false });
  rejectedRecoveryWithoutWrites(f, { configuration: { model: 'different-model', effort: null } }, /preserve.*profile/);
  rejectedRecoveryWithoutWrites(f, { profile: { ...profile, model: 'different-model' } }, /preserve.*profile/);
});

test('the same verified recovery request is idempotent after later result completion', t => {
  const f = fixture(t), before = snapshot(f.root);
  const replay = f.store.beginRun(f.binding, f.options);
  assert.equal(replay.runNumber, 2); assert.equal(replay.sessionId, 'preserved-native-session');
  assert.deepEqual(snapshot(f.root), before);
});

test('candidate retains the approved recovery implementation and excludes successor implementation', () => {
  const bridge = fs.readFileSync(fileURLToPath(new URL('../模板交付包/scripts/cli/cli-bridge.mjs', import.meta.url)), 'utf8');
  assert.match(bridge, /readAcceptedGoalRecovery/);
  assert.doesNotMatch(bridge, /createSuccessor|validateSuccessor|sessionFrom/);
  assert.equal(typeof CliTaskStore.prototype.verifyAcceptedGoalRecovery, 'function');
  assert.equal(typeof CliTaskStore.prototype.readAcceptedGoalRecovery, 'function');
  assert.equal(CliTaskStore.prototype.createSuccessor, undefined);
});
