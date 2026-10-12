import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { CliTaskStore, atomicJson, digest, sha256File } from './cli-task-store.mjs';
import { currentProcessIdentity, processStart } from './process-identity.mjs';

async function endedProcess() {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const proof = { pid: child.pid, startedAt: processStart(child.pid) };
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdin.end(); await closed;
  return proof;
}

function cleanTestRoot(root) {
  const actual = fs.realpathSync(root), temporary = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(actual).toLowerCase(), temporary.toLowerCase());
  assert.ok(path.basename(actual).startsWith('wst-unbound-recovery-test-'));
  fs.rmSync(actual, { recursive: true });
}

test('explicit first unbound registration recovery preserves task and rejects unsafe retries', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-unbound-recovery-test-'));
  t.after(() => cleanTestRoot(root));
  const dead = await endedProcess();
  let sequence = 0;
  function fixture() {
    const controlRoot = path.join(root, `case-${++sequence}`); fs.mkdirSync(controlRoot);
    const store = new CliTaskStore({ controlRoot });
    const identity = { projectId: 'project-test', taskId: 'first-start', ownerThreadId: 'original-owner' };
    const profile = { schemaVersion: 1, provider: 'claude', mode: 'interactive', ui: 'window', runner: { command: process.execPath, args: [] }, model: 'unchanged-model', effort: 'max', permissionMode: 'bypassPermissions' };
    const binding = { ...identity, taskMode: 'formal', ownerTurnId: 'initial-turn', executionRoot: controlRoot, profilePath: path.join(controlRoot, 'profile.json'), contract: { goal: 'original task', boundaries: 'exact scope', acceptance: 'original acceptance', factEntries: [], skillEntries: [] } };
    store.create(binding);
    const first = store.beginRun(identity, { requestId: 'first-request', prompt: 'Exact original business instruction.\nSecond line.', expectedRunNumber: 0, expectedSessionId: null, ownerTurnId: 'initial-turn', profile });
    const directory = store.runDir(identity, 1);
    const manager = { ...dead, token: 'test-manager-proof' };
    store.setProcess(first, manager); store.setChildProcess(first, { ...dead, token: 'test-child-proof' });
    store.finishRun(first, { status: 'unknown', sessionId: null, finalText: '', error: 'Claude did not register its native session; inspect the visible window' });
    const endpoint = { ...identity, provider: 'claude', status: 'closed', sessionId: null, executionRoot: binding.executionRoot, profileSha256: digest(profile), launchId: 'test-launch', manager, server: manager, view: { windowPid: dead.pid } };
    atomicJson(path.join(store.taskDir(identity), 'interactive.json'), endpoint);
    atomicJson(path.join(directory, 'claude-view-exit.json'), { launchId: endpoint.launchId, exitCode: 1, error: 'Claude did not register its native session; inspect the visible window' });
    store.recordReview({ ...identity, runNumber: 1, decision: 'continue', resultSha256: sha256File(path.join(directory, 'result.json')), evidenceLocator: 'local-diagnosis', conclusion: 'Original workspace trust confirmed; retry initial registration', reviewedAt: '2026-10-08T17:00:00.000Z' });
    const options = { requestId: 'explicit-retry', prompt: 'Exact original business instruction.\nSecond line.', expectedRunNumber: 1, expectedSessionId: null, ownerTurnId: 'current-owner-turn', profile, initialSessionRecovery: { stateSha256: digest(store.read(identity)), resultSha256: sha256File(path.join(directory, 'result.json')), reason: 'First startup ended before session registration; retry the unchanged instruction' } };
    const edit = (leaf, mutate) => { const file = path.join(directory, leaf), value = store.readJson(file); mutate(value); atomicJson(file, value); };
    const editState = mutate => { const value = store.read(identity); mutate(value); atomicJson(store.locator(identity), value); options.initialSessionRecovery.stateSha256 = digest(value); };
    const editEndpoint = mutate => { const file = path.join(store.taskDir(identity), 'interactive.json'), value = store.readJson(file); mutate(value); atomicJson(file, value); };
    const run = () => store.beginRun(identity, options);
    return { store, identity, profile, binding, first, directory, options, edit, editState, editEndpoint, run };
  }
  function reject(f, pattern) {
    assert.throws(f.run, pattern);
    assert.equal(f.store.read(f.identity).runNumber, 1);
    assert.equal(fs.existsSync(f.store.runDir(f.identity, 2)), false);
  }
  await t.test('only r2 is created, still unbound; original contract and every r1 byte survive', () => {
    const f = fixture();
    const original = f.store.read(f.identity);
    const before = Object.fromEntries(fs.readdirSync(f.directory).map(name => [name, sha256File(path.join(f.directory, name))]));
    const run = f.run(), state = f.store.read(f.identity);
    assert.equal(run.runNumber, 2); assert.equal(run.sessionId, null); assert.equal(state.sessionId, null);
    assert.equal(run.initialSessionRecovery.previousRunNumber, 1);
    assert.equal(run.initialSessionRecovery.resultSha256, f.options.initialSessionRecovery.resultSha256);
    for (const key of ['projectId', 'taskId', 'ownerThreadId', 'contract', 'executionRoot', 'profilePath']) assert.deepEqual(state[key], original[key]);
    assert.deepEqual(Object.fromEntries(fs.readdirSync(f.directory).map(name => [name, sha256File(path.join(f.directory, name))])), before);
    assert.equal(state.ownerTurnId, 'current-owner-turn');
  });
  await t.test('same request is idempotent and changed recovery intent cannot reuse its ID', () => {
    const f = fixture(), run = f.run(), before = digest(f.store.read(f.identity));
    assert.deepEqual(f.run(), run); assert.equal(digest(f.store.read(f.identity)), before);
    f.options.initialSessionRecovery.reason += ' changed';
    assert.throws(f.run, /request conflict/); assert.equal(fs.existsSync(f.store.runDir(f.identity, 3)), false);
  });
  for (const faultAt of ['afterRequest', 'afterRun', 'afterInput']) await t.test(`interrupted ${faultAt} resumes the same r2 intent`, () => {
    const f = fixture();
    assert.throws(() => f.store.beginRun(f.identity, { ...f.options, faultAt }), /injected fault/);
    assert.equal(f.store.read(f.identity).runNumber, 1);
    assert.equal(f.run().runNumber, 2); assert.equal(f.run().runNumber, 2);
  });
  await t.test('ordinary unbound resume remains rejected', () => {
    const f = fixture(); delete f.options.initialSessionRecovery;
    reject(f, /session missing; explicit recovery/);
  });
  await t.test('ordinary bound-session resume retains its session', () => {
    const f = fixture();
    f.editState(value => { value.sessionId = 'existing-session'; });
    f.edit('result.json', value => { value.sessionId = 'existing-session'; });
    f.options.expectedSessionId = 'existing-session'; delete f.options.initialSessionRecovery;
    assert.equal(f.run().sessionId, 'existing-session');
  });
  await t.test('opt-in cannot recover a bound session', () => {
    const f = fixture(); f.editState(value => { value.sessionId = 'existing-session'; });
    f.options.expectedSessionId = 'existing-session'; reject(f, /unbound first failed/);
  });
  await t.test('a different request cannot race a committed r2 or create r3', () => {
    const f = fixture(); f.run(); f.options.requestId = 'second-retry';
    assert.throws(f.run, /stale run conflict/); assert.equal(fs.existsSync(f.store.runDir(f.identity, 3)), false);
  });
  await t.test('there is no second unbound exception after r2 fails', () => {
    const f = fixture(), run = f.run();
    f.store.finishRun(run, { status: 'unknown', sessionId: null, error: 'second failure' });
    f.options.requestId = 'third-attempt'; f.options.expectedRunNumber = 2;
    f.options.initialSessionRecovery.stateSha256 = digest(f.store.read(f.identity));
    assert.throws(f.run, /unbound first failed/); assert.equal(fs.existsSync(f.store.runDir(f.identity, 3)), false);
  });
  await t.test('concurrent/reentrant lock ownership is rejected', () => {
    const f = fixture(); f.store.withLock(f.identity, () => assert.throws(f.run, /lock conflict/));
    assert.equal(f.store.read(f.identity).runNumber, 1); assert.equal(f.run().runNumber, 2);
  });
  for (const which of ['stateSha256', 'resultSha256']) await t.test(`stale ${which} is rejected`, () => {
    const f = fixture(); f.options.initialSessionRecovery[which] = '0'.repeat(64);
    reject(f, /fingerprint mismatch/);
  });
  await t.test('raw task-file hash does not substitute for digest(state)', () => {
    const f = fixture(); f.options.initialSessionRecovery.stateSha256 = sha256File(f.store.locator(f.identity));
    reject(f, /state fingerprint mismatch/);
  });
  await t.test('result bytes changed after review are rejected', () => {
    const f = fixture(); fs.appendFileSync(path.join(f.directory, 'result.json'), '\n');
    reject(f, /result fingerprint mismatch/);
  });
  for (const decision of [null, 'pause', 'accept', 'close']) await t.test(`review ${decision ?? 'missing'} cannot authorize retry`, () => {
    const f = fixture();
    if (decision === null) fs.unlinkSync(path.join(f.directory, 'review.json'));
    else f.edit('review.json', value => { value.decision = decision; });
    reject(f, /exact continue review/);
  });
  await t.test('continue review must refer to exact result bytes', () => {
    const f = fixture(); f.edit('review.json', value => { value.resultSha256 = '0'.repeat(64); }); reject(f, /exact continue review/);
  });
  for (const change of [p => { p.model = 'other'; }, p => { p.effort = 'low'; }, p => { p.permissionMode = 'dontAsk'; }, p => { p.runner.command += '.other'; }, p => { p.runner.args.push('--other'); }]) await t.test('every saved profile field remains immutable for this retry', () => {
    const f = fixture(); f.options.profile = structuredClone(f.profile); change(f.options.profile); reject(f, /profile changed/);
  });
  await t.test('original prompt must be byte-for-byte equal', () => {
    const f = fixture(); f.options.prompt += '\n'; reject(f, /prompt changed/);
  });
  await t.test('tampering with saved prompt and retry prompt together does not rewrite the original instruction', () => {
    const f = fixture(); f.edit('input.json', value => { value.prompt = 'changed instruction'; });
    f.options.prompt = 'changed instruction'; reject(f, /original request evidence changed/);
  });
  await t.test('the explicit exception is limited to the observed unknown first-run state', () => {
    const f = fixture(); f.editState(value => { value.status = 'failed'; }); reject(f, /unbound first failed/);
  });
  await t.test('wrong owner and stale run identity cannot use the exception', () => {
    const f = fixture(); assert.throws(() => f.store.beginRun({ ...f.identity, ownerThreadId: 'other-owner' }, f.options), /identity mismatch/);
    f.options.expectedRunNumber = 0; reject(f, /stale run conflict/);
  });
  for (const leaf of ['claude-session-start.json', 'events.jsonl']) await t.test(`${leaf} evidence prevents replaying any potentially dispatched work`, () => {
    const f = fixture(); fs.writeFileSync(path.join(f.directory, leaf), '{}\n'); reject(f, /session or dispatch evidence/);
  });
  await t.test('saved run/result/endpoint bound-session evidence is rejected independently', () => {
    for (const target of ['run', 'result', 'endpoint']) {
      const f = fixture();
      if (target === 'endpoint') f.editEndpoint(value => { value.sessionId = 'observed-session'; });
      else f.edit(`${target}.json`, value => { value.sessionId = 'observed-session'; });
      reject(f, /bound or unstable|launch proof mismatch|original request evidence changed/);
    }
  });
  await t.test('stable result cannot contain business output', () => {
    const f = fixture(); f.edit('result.json', value => { value.finalText = 'business work'; }); reject(f, /bound or unstable/);
  });
  await t.test('missing or mismatched old launch evidence is rejected', () => {
    for (const leaf of ['cli-process.json', 'manager-process.json', 'claude-view-exit.json']) {
      const f = fixture(); fs.unlinkSync(path.join(f.directory, leaf)); reject(f, /record not found/);
    }
    const f = fixture(); f.edit('claude-view-exit.json', value => { value.launchId = 'different-launch'; }); reject(f, /launch proof mismatch/);
  });
  await t.test('manager and native child must have really exited', () => {
    for (const kind of ['manager', 'cli']) {
      const f = fixture(), live = { ...currentProcessIdentity(), token: `test-${kind}` };
      f.edit(`${kind}-process.json`, value => { Object.assign(value, live); });
      if (kind === 'manager') f.editEndpoint(value => { value.manager = live; value.server = live; });
      reject(f, /still exists/);
    }
  });
  await t.test('a distinct recorded server object cannot be omitted from process ownership checks', () => {
    const f = fixture(); f.editEndpoint(value => { value.server = { ...currentProcessIdentity(), token: 'other-server' }; }); reject(f, /launch proof mismatch/);
  });
  await t.test('a live legacy window or missing window proof blocks retry on each platform', () => {
    const f = fixture(); f.editEndpoint(value => { value.view.windowPid = process.pid; });
    // PID-only legacy proof can be inspected on Windows; other hosts must reject it as unavailable.
    const legacyFailure = { message: process.platform === 'win32'
      ? 'CLI window still exists; initial session recovery cannot restart it'
      : 'CLI legacy window identity is unavailable' };
    reject(f, legacyFailure);
    const missing = fixture(); missing.editEndpoint(value => { delete value.view.windowPid; }); reject(missing, /window proof unavailable/);
  });
  await t.test('a saved window start identity rejects its live original process', () => {
    const f = fixture(), live = currentProcessIdentity();
    f.editEndpoint(value => { value.view = { windowPid: live.pid, windowStartedAt: live.startedAt }; });
    reject(f, /window still exists/);
  });
  await t.test('legacy active PID cannot infer reuse for another unknown error or a mismatched view exit', () => {
    for (const target of ['result.json', 'claude-view-exit.json']) {
      const f = fixture(); f.editEndpoint(value => { value.view.windowPid = process.pid; });
      f.edit(target, value => { value.error = 'fetch failed'; });
      if (target === 'result.json') {
        const resultSha256 = sha256File(path.join(f.directory, target));
        f.options.initialSessionRecovery.resultSha256 = resultSha256;
        f.edit('review.json', value => { value.resultSha256 = resultSha256; });
      }
      reject(f, /not authorized for this failure/);
    }
  });
  await t.test('a saved exited window identity permits recovery without the legacy heuristic', () => {
    const f = fixture(); f.editEndpoint(value => { value.view = { windowPid: dead.pid, windowStartedAt: dead.startedAt }; });
    assert.equal(f.run().runNumber, 2);
  });
  await t.test('unknown process liveness fails closed without signaling termination', () => {
    const f = fixture(), original = process.kill;
    process.kill = (pid, signal) => { assert.equal(signal, 0); const error = new Error('test access denied'); error.code = 'EPERM'; throw error; };
    try { reject(f, /liveness is unknown/); } finally { process.kill = original; }
  });
  await t.test('unknown window liveness fails closed', () => {
    const f = fixture(), original = process.kill, unknownPid = 2147483000;
    f.editEndpoint(value => { value.view.windowPid = unknownPid; });
    process.kill = (pid, signal) => { if (pid !== unknownPid) return original(pid, signal); assert.equal(signal, 0); const error = new Error('test access denied'); error.code = 'EPERM'; throw error; };
    try { reject(f, /window liveness is unknown/); } finally { process.kill = original; }
  });
});
