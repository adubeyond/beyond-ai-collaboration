import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CliTaskStore, atomicJson, digest, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { launchCliRequest } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { readInteractiveEndpoint } from '../模板交付包/scripts/cli/interactive-client.mjs';
import { currentProcessIdentity, processStart } from '../模板交付包/scripts/cli/process-identity.mjs';

const initial = { goal: 'review the isolated function', boundaries: 'model-only review; do not write files', acceptance: 'report findings', factEntries: ['facts-original'], skillEntries: [] };
const revised = { goal: 'repair the reviewed isolated function', boundaries: 'only fixture source may be edited; do not edit tests or publish', acceptance: 'unchanged tests pass', factEntries: ['facts-current'], skillEntries: ['task-dev'] };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-contract-'));
  t.after(() => {
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith('beyond-cli-contract-'));
    fs.rmSync(actual, { recursive: true });
  });
  const binding = { projectId: 'contract-project', taskId: 'contract-goal', ownerThreadId: 'owner', ownerTurnId: 'original-turn', taskMode: 'assist', executionRoot: root, profilePath: path.join(root, 'profile.json'), contract: structuredClone(initial) };
  const store = new CliTaskStore({ controlRoot: root }); store.create(binding);
  const first = store.beginRun(binding, { requestId: 'first', prompt: 'review only', expectedRunNumber: 0, expectedSessionId: null });
  store.bindSession(first, 'same-session');
  function finish(run = first) { store.finishRun(run, { status: 'completed', sessionId: 'same-session', finalText: 'isolated result' }); }
  function review(run = first, decision = 'continue') { return store.recordReview({ projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: binding.ownerThreadId, runNumber: run.runNumber, resultSha256: sha256File(run.resultPath), decision, evidenceLocator: 'fixture:review', conclusion: 'owner checked result', reviewedAt: '2026-10-16T00:00:00.000Z' }); }
  const options = { requestId: 'second', prompt: 'implement the approved repair', expectedRunNumber: 1, expectedSessionId: 'same-session', ownerTurnId: 'authorized-turn', contract: structuredClone(revised), authorizationLocator: 'thread:owner/user-explicit-repair' };
  return { root, binding, store, first, finish, review, options };
}
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).filter(name => fs.statSync(path.join(directory, name)).isFile()).sort().map(name => [name, sha256File(path.join(directory, name))]));
}
function rejectedWithoutWrites(f, options, pattern, identity = f.binding) {
  const before = snapshot(f.store.taskDir(f.binding));
  assert.throws(() => f.store.beginRun(identity, options), pattern);
  assert.deepEqual(snapshot(f.store.taskDir(f.binding)), before);
}
async function exitedProcess() {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const proof = { pid: child.pid, startedAt: processStart(child.pid), token: crypto.randomUUID() };
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdin.end(); await closed;
  return proof;
}

test('explicit reviewed same-session contract update preserves initial contract and all old run bytes', t => {
  const f = fixture(t); f.finish(); const review = f.review();
  const before = snapshot(f.store.runDir(f.binding, 1));
  const run = f.store.beginRun(f.binding, f.options), state = f.store.read(f.binding);
  assert.deepEqual(state.contract, initial);
  assert.deepEqual(state.effectiveContract, revised);
  assert.deepEqual(run.effectiveContract, revised);
  assert.equal(run.sessionId, 'same-session');
  assert.deepEqual(run.contractUpdate, { authorizationLocator: f.options.authorizationLocator, previousRunNumber: 1, previousContractSha256: digest(initial), reviewSha256: digest(review) });
  assert.equal(run.ownerThreadId, 'owner'); assert.equal(run.ownerTurnId, 'authorized-turn');
  assert.deepEqual(snapshot(f.store.runDir(f.binding, 1)), before);
  f.finish(run); f.review(run);
  const inherited = f.store.beginRun(f.binding, { requestId: 'third', prompt: 'verify only', expectedRunNumber: 2, expectedSessionId: 'same-session' });
  assert.deepEqual(inherited.effectiveContract, revised);
  assert.equal(inherited.contractUpdate, undefined);
  assert.deepEqual(f.store.read(f.binding).contract, initial);
});

test('legacy initial contract carried without authorization preserves old request fingerprint and current effective contract', t => {
  const f = fixture(t); f.finish(); f.review();
  const legacyOptions = { requestId: 'legacy-second', prompt: 'continue review', expectedRunNumber: 1, expectedSessionId: 'same-session' };
  const legacy = f.store.beginRun(f.binding, { ...legacyOptions, contract: structuredClone(initial) });
  assert.deepEqual(legacy.effectiveContract, initial);
  assert.equal(legacy.contractUpdate, undefined);
  assert.equal(f.store.readJson(path.join(f.store.taskDir(f.binding), 'requests/legacy-second.json')).fingerprint, digest(legacyOptions));
  assert.deepEqual(f.store.beginRun(f.binding, legacyOptions), legacy);
  f.finish(legacy); f.review(legacy);
  const updated = f.store.beginRun(f.binding, { ...f.options, requestId: 'authorized-third', expectedRunNumber: 2 });
  f.finish(updated); f.review(updated);
  const ordinary = { requestId: 'legacy-fourth', prompt: 'verify approved repair', expectedRunNumber: 3, expectedSessionId: 'same-session' };
  // JSON object key order is not a changed contract; arrays and all values still match exactly.
  const carriedInitial = Object.fromEntries(Object.entries(initial).reverse());
  const inherited = f.store.beginRun(f.binding, { ...ordinary, contract: carriedInitial });
  assert.deepEqual(inherited.effectiveContract, revised);
  assert.deepEqual(f.store.read(f.binding).effectiveContract, revised);
  assert.equal(inherited.contractUpdate, undefined);
  assert.equal(f.store.readJson(path.join(f.store.taskDir(f.binding), 'requests/legacy-fourth.json')).fingerprint, digest(ordinary));
  assert.deepEqual(f.store.beginRun(f.binding, ordinary), inherited);
  rejectedWithoutWrites(f, { ...ordinary, contract: { ...initial, boundaries: 'different scope' } }, /authorization/);
  rejectedWithoutWrites(f, { ...ordinary, contract: structuredClone(revised) }, /authorization/);
});

test('contract update requires a complete explicit contract, authorization and current owner turn', t => {
  const f = fixture(t); f.finish(); f.review();
  for (const patch of [
    { authorizationLocator: undefined }, { authorizationLocator: '' }, { authorizationLocator: '  ' },
    { contract: undefined }, { contract: null }, { contract: { boundaries: 'allow changes' } },
    { contract: { ...revised, goal: '' } }, { contract: { ...revised, factEntries: 'facts' } },
    { contract: { ...revised, skillEntries: [false] } }, { ownerTurnId: undefined },
  ]) rejectedWithoutWrites(f, { ...f.options, ...patch }, /contract|authorization|owner turn/);
});

test('busy, wrong owner, stale run and wrong session cannot mutate the contract', t => {
  const f = fixture(t);
  rejectedWithoutWrites(f, f.options, /active run/);
  f.finish(); f.review();
  rejectedWithoutWrites(f, f.options, /identity/, { ...f.binding, ownerThreadId: 'other-owner' });
  rejectedWithoutWrites(f, { ...f.options, expectedRunNumber: 0 }, /stale run/);
  rejectedWithoutWrites(f, { ...f.options, expectedSessionId: 'another-session' }, /session mismatch/);
});

test('contract update rejects a still-busy native endpoint before writing a new run', t => {
  const f = fixture(t); f.finish(); f.review();
  for (const status of ['running', 'starting', 'closing', 'shutdown-unconfirmed']) {
    atomicJson(path.join(f.store.taskDir(f.binding), 'interactive.json'), { ...f.binding, status, sessionId: 'same-session' });
    rejectedWithoutWrites(f, f.options, /idle native session/);
  }
});

test('contract update cold-resumes a recovered stale running endpoint only after both saved processes exit', async t => {
  const f = fixture(t), [manager, server] = await Promise.all([exitedProcess(), exitedProcess()]);
  fs.mkdirSync(path.join(f.root, 'local/projects'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'local/projects', f.binding.projectId + '.md'), `---\nid: ${f.binding.projectId}\npath: ${f.root}\nhost_id: local\ncodex_project_id: fixture-project\n---\n`);
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), `<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: ${f.binding.projectId} -->\n`);
  f.store.setProcess(f.first, manager); f.store.setChildProcess(f.first, server);
  const endpointFile = path.join(f.store.taskDir(f.binding), 'interactive.json');
  atomicJson(endpointFile, { ...f.binding, status: 'running', sessionId: 'same-session', activeTurnId: 'stale-turn', manager, server });
  assert.equal(readInteractiveEndpoint(f.store, f.binding), null);
  await launchCliRequest({ schemaVersion: 1, requestId: 'recover-first', action: 'cli.recover', input: { ...f.binding, stateSha256: digest(f.store.read(f.binding)), expectedSessionId: 'same-session', reason: 'isolated manager and server have exited' } }, { controlRoot: f.root, executionRoot: f.root, ownerThreadId: f.binding.ownerThreadId });
  assert.equal(f.store.read(f.binding).status, 'unknown'); f.review();
  const before = snapshot(f.store.runDir(f.binding, 1)), endpointBefore = sha256File(endpointFile);
  const second = f.store.beginRun(f.binding, f.options);
  assert.equal(second.sessionId, 'same-session');
  assert.deepEqual(second.effectiveContract, revised);
  assert.deepEqual(snapshot(f.store.runDir(f.binding, 1)), before);
  assert.equal(sha256File(endpointFile), endpointBefore);
});

test('contract update cold-resume rejects either live process, missing proof and unknown liveness without writes', async t => {
  const f = fixture(t); f.finish(); f.review();
  const gone = await exitedProcess(), alive = currentProcessIdentity();
  const endpointFile = path.join(f.store.taskDir(f.binding), 'interactive.json');
  for (const [manager, server] of [[alive, gone], [gone, alive], [null, gone], [gone, null], [{ pid: gone.pid }, gone], [gone, { pid: gone.pid }]]) {
    atomicJson(endpointFile, { ...f.binding, status: 'running', sessionId: 'same-session', activeTurnId: 'stale-turn', manager, server });
    rejectedWithoutWrites(f, f.options, /idle native session|saved process proof unavailable/);
  }
  atomicJson(endpointFile, { ...f.binding, status: 'running', sessionId: 'same-session', manager: gone, server: gone });
  const originalKill = process.kill;
  process.kill = (pid, signal) => { if (pid === gone.pid) { const error = new Error('isolated access denied'); error.code = 'EPERM'; throw error; } return originalKill(pid, signal); };
  try { rejectedWithoutWrites(f, f.options, /liveness is unknown/); }
  finally { process.kill = originalKill; }
});

for (const decision of [null, 'pause', 'accept', 'close']) test(`contract update rejects ${decision ?? 'missing'} continuation review`, t => {
  const f = fixture(t); f.finish(); if (decision) f.review(f.first, decision);
  rejectedWithoutWrites(f, f.options, /review/);
});

test('contract update rejects changed reviewed result, initial run and initial-session recovery', t => {
  const f = fixture(t); f.finish(); f.review();
  const result = f.store.readJson(f.first.resultPath); atomicJson(f.first.resultPath, { ...result, finalText: 'changed after review' });
  rejectedWithoutWrites(f, f.options, /result fingerprint/);
  rejectedWithoutWrites(f, { ...f.options, initialSessionRecovery: {} }, /contract.*recovery|recovery.*contract/);
  const other = { ...f.binding, taskId: 'not-started' }; f.store.create(other);
  assert.throws(() => f.store.beginRun(other, { ...f.options, expectedRunNumber: 0, expectedSessionId: null }), /contract.*resume/);
  assert.equal(f.store.read(other).runNumber, 0);
});

test('same contract update is idempotent; changed contract or authorization cannot reuse request ID', t => {
  const f = fixture(t); f.finish(); f.review();
  const run = f.store.beginRun(f.binding, f.options), before = snapshot(f.store.taskDir(f.binding));
  assert.deepEqual(f.store.beginRun(f.binding, f.options), run);
  assert.deepEqual(f.store.beginRun(f.binding, { ...f.options, ownerTurnId: 'later-owner-turn' }), run);
  assert.deepEqual(snapshot(f.store.taskDir(f.binding)), before);
  rejectedWithoutWrites(f, { ...f.options, contract: { ...revised, boundaries: 'different scope' } }, /request conflict/);
  rejectedWithoutWrites(f, { ...f.options, authorizationLocator: 'thread:other-authorization' }, /request conflict/);
});

for (const faultAt of ['afterRequest', 'afterRun', 'afterInput']) test(`contract update crash at ${faultAt} replays only the same immutable intent`, t => {
  const f = fixture(t); f.finish(); f.review();
  const old = snapshot(f.store.runDir(f.binding, 1));
  assert.throws(() => f.store.beginRun(f.binding, { ...f.options, faultAt }), /injected fault/);
  assert.equal(f.store.read(f.binding).runNumber, 1);
  assert.deepEqual(f.store.read(f.binding).effectiveContract, initial);
  const second = f.store.beginRun(f.binding, f.options);
  assert.deepEqual(second.effectiveContract, revised);
  assert.deepEqual(f.store.beginRun(f.binding, f.options), second);
  assert.deepEqual(snapshot(f.store.runDir(f.binding, 1)), old);
});

test('legacy task without effective contract retains restrictions on ordinary resume', t => {
  const f = fixture(t); f.finish(); f.review();
  const state = f.store.read(f.binding); delete state.effectiveContract; atomicJson(f.store.locator(f.binding), state);
  const firstFile = path.join(f.store.runDir(f.binding, 1), 'run.json'), savedFirst = f.store.readJson(firstFile);
  delete savedFirst.effectiveContract; atomicJson(firstFile, savedFirst);
  const requestFile = path.join(f.store.taskDir(f.binding), 'requests/first.json'), savedRequest = f.store.readJson(requestFile);
  delete savedRequest.run.effectiveContract; atomicJson(requestFile, savedRequest);
  const before = snapshot(f.store.runDir(f.binding, 1));
  const { contract, authorizationLocator, ...ordinary } = f.options;
  const run = f.store.beginRun(f.binding, ordinary);
  assert.deepEqual(run.effectiveContract, initial);
  assert.equal(run.contractUpdate, undefined);
  assert.deepEqual(snapshot(f.store.runDir(f.binding, 1)), before);
});

test('bridge and cold native runner submit the explicit current contract and keep the same session', { timeout: 15000 }, async t => {
  const f = fixture(t); f.finish(); f.review();
  fs.mkdirSync(path.join(f.root, 'local/projects'), { recursive: true }); fs.mkdirSync(path.join(f.root, 'cli-home'));
  fs.writeFileSync(path.join(f.root, 'local/projects', f.binding.projectId + '.md'), `---\nid: ${f.binding.projectId}\npath: ${f.root}\nhost_id: local\ncodex_project_id: fixture-project\n---\n`);
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), `<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: ${f.binding.projectId} -->\n`);
  const fake = path.join(f.root, 'fake.cjs');
  fs.writeFileSync(fake, `const fs=require('node:fs');const args=process.argv;let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{fs.writeFileSync('submitted.txt',text);console.log(JSON.stringify({type:'thread.started',thread_id:args[args.indexOf('resume')+1]}));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'fixture completed');console.log(JSON.stringify({type:'turn.completed'}));});`);
  atomicJson(f.binding.profilePath, { schemaVersion: 1, runner: { command: process.execPath, args: [fake] }, codexHome: path.join(f.root, 'cli-home'), model: 'fixture-model' });
  const { requestId, ...input } = f.options;
  const run = await launchCliRequest({ schemaVersion: 1, requestId, action: 'cli.resume', input: { ...f.binding, ...input } }, { controlRoot: f.root, executionRoot: f.root, ownerThreadId: f.binding.ownerThreadId, ownerTurnId: 'authorized-turn' });
  const end = Date.now() + 10000;
  while (f.store.read(f.binding).status !== 'completed') { if (Date.now() > end) throw new Error('cold runner timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
  const text = fs.readFileSync(path.join(f.root, 'submitted.txt'), 'utf8');
  assert.ok(text.includes(`Boundaries: ${revised.boundaries}`));
  assert.equal(text.includes(initial.boundaries), false);
  assert.match(text, /current effective contract/i);
  assert.equal(f.store.read(f.binding).sessionId, 'same-session');
  assert.deepEqual(f.store.readJson(path.join(f.store.runDir(run, 2), 'run.json')).effectiveContract, revised);
});
