import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliTaskStore, atomicJson, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { readProfile } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { processIsGone, processStart } from '../模板交付包/scripts/cli/process-identity.mjs';

test('Windows process start proof stays stable and distinguishes PID reuse', { skip: process.platform !== 'win32' }, () => {
  const startedAt = processStart(process.pid);
  assert.match(startedAt, /^[1-9]\d*$/);
  assert.equal(processStart(process.pid), startedAt);
  assert.equal(processIsGone({ pid: process.pid, startedAt }), false);
  assert.equal(processIsGone({ pid: process.pid, startedAt: String(BigInt(startedAt) + 1n) }), true);
});

test('Windows process start proof rejects invalid or absent PIDs', { skip: process.platform !== 'win32' }, () => {
  for (const pid of [0, -1, 1.5, NaN]) assert.throws(() => processStart(pid), /invalid process PID/);
  assert.throws(() => processStart(2147483647), /process start identity unavailable/);
});

const bridgeUrl = new URL('../模板交付包/scripts/cli/cli-bridge.mjs', import.meta.url).href;
const launcherUrl = new URL('../模板交付包/scripts/cli/manager-launch.mjs', import.meta.url).href;
const storeUrl = new URL('../模板交付包/scripts/cli/cli-task-store.mjs', import.meta.url).href;
const runnerUrl = new URL('../模板交付包/scripts/cli/native-cli-runner.mjs', import.meta.url).href;
const unicodeEnvironmentValue = '中文环境 e\u0301 🚀 空格=路径\\尾';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const answer = await check();
    if (answer) return answer;
    if (Date.now() >= deadline) throw new Error(`Isolated manager fixture timed out: ${label}`);
    await wait(40);
  }
}
const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-manager-中文 空格-'));
  const controlRoot = path.join(root, 'control'), executionRoot = path.join(root, 'project');
  const codexHome = path.join(root, 'isolated-cli-home'), profilePath = path.join(root, 'profile.json');
  for (const directory of [path.join(controlRoot, 'local/projects'), executionRoot, codexHome]) fs.mkdirSync(directory, { recursive: true });
  const binding = {
    projectId: 'manager-project', taskId: 'manager-task', ownerThreadId: 'manager-owner', ownerTurnId: 'initial-dispatch-turn',
    executionRoot, profilePath, taskMode: 'assist',
    contract: { goal: 'Keep the isolated CLI task running beyond its caller lifetime', boundaries: 'Only the temporary fake CLI; no callbacks, network or production data', acceptance: 'Reconnect and continue the original session while preserving evidence', factEntries: ['fixture-facts'], skillEntries: [] },
  };
  fs.writeFileSync(path.join(controlRoot, 'local/projects', binding.projectId + '.md'),
    `---\nid: ${binding.projectId}\npath: ${executionRoot}\nhost_id: local\ncodex_project_id: isolated-manager-project\n---\n`);
  fs.writeFileSync(path.join(executionRoot, 'AGENTS.md'),
    `<!-- BEYOND-CONTROL-ROOT: ../control -->\n<!-- BEYOND-PROJECT-ID: ${binding.projectId} -->\n`);
  const fake = path.join(root, 'fake CLI 脚本.cjs');
  // The product builds argv, delivers stdin, owns the child and persists results.
  // Only the paid model executable is replaced; an explicit gate proves ordering.
  fs.writeFileSync(fake, `
const fs = require('node:fs'), path = require('node:path');
const root = ${JSON.stringify(root)}, args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1], runNumber = Number(path.basename(path.dirname(final)));
const session = args.includes('resume') ? args[args.indexOf('resume') + 1] : 'original-manager-session';
const write = (name, data) => { const file = path.join(root, name); fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); };
fs.appendFileSync(path.join(root, 'native-launches.jsonl'), JSON.stringify({ pid: process.pid, runNumber, session }) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: session }));
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  write('capture-' + runNumber + '.json', { pid: process.pid, runNumber, session, args, prompt, unicodeEnvironmentEqual: process.env.BEYOND_MANAGER_FIXTURE_UNICODE === ${JSON.stringify(unicodeEnvironmentValue)} });
  const deadline = setTimeout(() => { clearInterval(poll); process.exitCode = 75; }, 45000);
  const poll = setInterval(() => {
    if (!fs.existsSync(path.join(root, 'release-' + runNumber)) && !fs.existsSync(path.join(root, 'release-all'))) return;
    clearInterval(poll);
    setTimeout(() => {
      fs.writeFileSync(final, 'stable manager result ' + runNumber);
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
      clearTimeout(deadline);
    }, 150);
  }, 20);
});
`);
  atomicJson(profilePath, { schemaVersion: 1, runner: { command: process.execPath, args: [fake] }, codexHome, model: 'isolated-manager-model', effort: 'high' });
  const caller = path.join(root, 'caller 空格.mjs');
  fs.writeFileSync(caller, `
import fs from 'node:fs';
import { launchCliRequest } from ${JSON.stringify(bridgeUrl)};
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const results = [];
for (const request of spec.requests) results.push(await launchCliRequest(request, spec.context));
process.stdout.write(JSON.stringify({ callerPid: process.pid, results }) + '\\n');
// No forced process.exit: bridge handles must allow the caller to finish naturally.
`);
  const store = new CliTaskStore({ controlRoot });
  const identity = Object.fromEntries(['projectId', 'taskId', 'ownerThreadId'].map(key => [key, binding[key]]));
  const context = { controlRoot, executionRoot, ownerThreadId: binding.ownerThreadId, ownerTurnId: binding.ownerTurnId };
  const request = (action, requestId, input = {}) => ({ schemaVersion: 1, requestId, action, input: { ...identity, ...input } });
  const start = request('cli.start', 'original-start', { ...binding, prompt: 'First bounded round after the caller exits' });
  const prepareRun = () => {
    const profile = readProfile(profilePath), savedBinding = store.create(binding), prompt = start.input.prompt;
    const run = store.beginRun(savedBinding, {
      requestId: start.requestId, prompt, expectedRunNumber: 0, expectedSessionId: null, ownerTurnId: binding.ownerTurnId,
      profile, configuration: { model: profile.model, effort: profile.effort },
    });
    return { binding: savedBinding, run, profile, prompt, controlRoot, hostSpec: null };
  };
  let sequence = 0, complete = false;
  const cleanupActions = [];
  const bootstrapProofs = [];
  async function invoke(requests, turn = binding.ownerTurnId) {
    const spec = path.join(root, `request-${++sequence}.json`);
    atomicJson(spec, { requests, context: { ...context, ownerTurnId: turn } });
    const outcome = await runCaller(caller, [spec], executionRoot);
    assert.equal(outcome.code, 0, `Caller failed: ${outcome.stderr}`);
    assert.equal(outcome.timedOut, false, 'The caller must exit without waiting for its business CLI');
    const answer = JSON.parse(outcome.stdout.trim());
    assert.equal(answer.callerPid, outcome.pid);
    return answer;
  }
  const runFile = (number, name) => path.join(store.runDir(binding, number), name);
  const result = number => readJson(runFile(number, 'result.json'));
  const capture = number => readJson(path.join(root, `capture-${number}.json`));
  const launches = () => fs.existsSync(path.join(root, 'native-launches.jsonl'))
    ? fs.readFileSync(path.join(root, 'native-launches.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const proofs = () => {
    const state = fs.existsSync(store.locator(binding)) ? store.read(binding) : null;
    const answer = [...bootstrapProofs];
    for (let number = 1; number <= (state?.runNumber ?? 0); number++) {
      for (const name of ['manager-process.json', 'cli-process.json']) {
        const proof = readJson(runFile(number, name));
        if (proof) answer.push(proof);
      }
    }
    return answer;
  };
  t.after(async () => {
    for (const action of cleanupActions) await action();
    fs.writeFileSync(path.join(root, 'release-all'), 'release only this fixture');
    try {
      await until(() => proofs().every(proof => processIsGone(proof)), 'all fixture-owned manager and CLI processes exit', 20000);
    } catch (error) {
      t.diagnostic(`Fixture retained for exact-process inspection: ${root}`);
      throw error;
    }
    if (!complete) { t.diagnostic(`Failed-test evidence retained: ${root}`); return; }
    const physical = fs.realpathSync(root);
    assert.equal(path.dirname(physical).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(physical), /^beyond-cli-manager-/);
    fs.rmSync(physical, { recursive: true, force: false, maxRetries: 10, retryDelay: 50 });
  });
  return { root, binding, store, request, start, prepareRun, invoke, runFile, result, capture, launches, bootstrapProofs, cleanupActions, markComplete: () => { complete = true; } };
}

function runCaller(entry, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BEYOND_MANAGER_FIXTURE_UNICODE: unicodeEnvironmentValue },
    });
    let stdout = '', stderr = '', timedOut = false;
    // This handle is only the child created here, never an enumerated process PID.
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 25000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ pid: child.pid, code, stdout, stderr, timedOut }); });
  });
}

function preservedRun(f, number) {
  return Object.fromEntries(['run.json', 'input.json', 'manager-claim.json', 'manager-process.json', 'cli-process.json', 'cli-launch-intent.json', 'events.jsonl', 'stderr.log', 'final.txt', 'result.json']
    .map(name => [name, fs.readFileSync(f.runFile(number, name), 'utf8')]));
}

test('public CLI start survives caller exit; new callers read and resume the same session without duplicate launch or overwritten evidence', { timeout: 90000 }, async t => {
  const f = fixture(t);
  const initial = await f.invoke([f.start]);
  assert.equal(initial.results[0].status, 'running');
  assert.equal(initial.results[0].runNumber, 1);
  const capture1 = await until(() => f.capture(1), 'first native CLI input');
  assert.equal(capture1.unicodeEnvironmentEqual, true, 'non-ASCII environment survives the independent launcher exactly');
  const manager1 = readJson(f.runFile(1, 'manager-process.json'));
  const cli1 = readJson(f.runFile(1, 'cli-process.json'));
  assert.notEqual(initial.callerPid, manager1.pid);
  assert.equal(capture1.pid, cli1.pid);
  assert.equal(processIsGone(manager1), false, 'the independent manager outlives the completed caller');
  assert.equal(processIsGone(cli1), false, 'the business CLI outlives the completed caller');
  assert.equal(f.result(1), null, 'the first caller exited before the gated CLI could finish');
  const firstIntent = Object.fromEntries(['run.json', 'input.json', 'manager-claim.json', 'manager-process.json', 'cli-process.json']
    .map(name => [name, fs.readFileSync(f.runFile(1, name), 'utf8')]));

  const reconnect = await f.invoke([f.request('cli.status', 'reconnected-running-status'), f.start]);
  assert.notEqual(reconnect.callerPid, initial.callerPid);
  assert.equal(reconnect.results[0].sessionId, 'original-manager-session');
  assert.equal(reconnect.results[0].status, 'running');
  assert.deepEqual(reconnect.results[0].processIdentity, manager1);
  assert.equal(reconnect.results[1].runNumber, 1);
  assert.equal(reconnect.results[1].status, 'running');
  assert.equal(f.launches().length, 1, 'idempotent running start does not launch a second CLI');
  for (const [name, bytes] of Object.entries(firstIntent)) assert.equal(fs.readFileSync(f.runFile(1, name), 'utf8'), bytes, `${name} was replaced by idempotent start`);

  fs.writeFileSync(path.join(f.root, 'release-1'), 'caller already exited');
  const result1 = await until(() => f.result(1), 'first stable result');
  assert.equal(result1.status, 'completed');
  assert.equal(result1.finalText, 'stable manager result 1');
  await until(() => processIsGone(manager1) && processIsGone(cli1), 'first manager and CLI exit');
  const historical = preservedRun(f, 1);
  const observed = await f.invoke([f.request('cli.status', 'reopened-completed-status'), f.request('cli.result', 'reopened-first-result', { runNumber: 1 }), f.start]);
  assert.equal(observed.results[0].status, 'completed');
  assert.equal(observed.results[0].sessionId, 'original-manager-session');
  assert.deepEqual(observed.results[1], result1);
  assert.equal(observed.results[2].runNumber, 1);
  assert.equal(f.launches().length, 1, 'idempotent completed start does not relaunch a manager or CLI');
  assert.deepEqual(preservedRun(f, 1), historical);

  const resume = f.request('cli.resume', 'same-session-second-round', {
    expectedRunNumber: 1, expectedSessionId: 'original-manager-session', prompt: 'Second bounded round after reopening',
  });
  const resumed = await f.invoke([
    f.request('cli.review', 'review-first-before-resume', { runNumber: 1, resultSha256: sha256File(f.runFile(1, 'result.json')), decision: 'continue', evidenceLocator: 'fixture:first-stable-result', conclusion: 'Owner verified the persisted result after reconnecting', reviewedAt: new Date().toISOString() }),
    resume,
  ], 'reopened-resume-turn');
  assert.equal(resumed.results[1].runNumber, 2);
  assert.equal(resumed.results[1].sessionId, 'original-manager-session');
  const capture2 = await until(() => f.capture(2), 'second native CLI input');
  assert.equal(capture2.unicodeEnvironmentEqual, true, 'same-session resume preserves the non-ASCII environment exactly');
  const manager2 = readJson(f.runFile(2, 'manager-process.json'));
  const cli2 = readJson(f.runFile(2, 'cli-process.json'));
  assert.deepEqual(capture2.args.slice(0, 3), ['exec', 'resume', 'original-manager-session']);
  assert.ok(capture2.prompt.includes('Second bounded round after reopening'));
  assert.ok(capture2.prompt.includes(f.binding.contract.goal));
  assert.equal(capture2.args[capture2.args.indexOf('--model') + 1], 'isolated-manager-model');
  assert.equal(readJson(f.runFile(2, 'run.json')).ownerTurnId, 'reopened-resume-turn');
  assert.equal(processIsGone(manager2), false);
  assert.equal(processIsGone(cli2), false);
  assert.equal(f.result(2), null, 'resuming caller exits before the next CLI result');
  const resumedReplay = await f.invoke([resume], 'later-replay-turn');
  assert.equal(resumedReplay.results[0].runNumber, 2);
  assert.deepEqual(readJson(f.runFile(2, 'manager-process.json')), manager2);
  assert.deepEqual(readJson(f.runFile(2, 'cli-process.json')), cli2);
  assert.equal(f.launches().length, 2, 'idempotent resume cannot launch a third CLI');
  assert.deepEqual(preservedRun(f, 1), historical, 'resume preserves every original evidence artifact');

  fs.writeFileSync(path.join(f.root, 'release-2'), 'resuming caller already exited');
  const result2 = await until(() => f.result(2), 'second stable result');
  await until(() => processIsGone(manager2) && processIsGone(cli2), 'second manager and CLI exit');
  const final = await f.invoke([f.request('cli.status', 'final-status'), f.request('cli.result', 'final-result', { runNumber: 2 }), f.request('cli.result', 'first-history-after-resume', { runNumber: 1 })]);
  assert.equal(final.results[0].status, 'completed');
  assert.equal(final.results[0].runNumber, 2);
  assert.equal(final.results[0].sessionId, 'original-manager-session');
  assert.equal(final.results[0].managerPid, null);
  assert.equal(result2.status, 'completed');
  assert.equal(result2.finalText, 'stable manager result 2');
  assert.deepEqual(final.results[1], result2);
  assert.deepEqual(final.results[2], result1);
  assert.deepEqual(preservedRun(f, 1), historical);
  assert.deepEqual(f.launches().map(item => item.runNumber), [1, 2]);
  t.diagnostic(JSON.stringify({ publicActions: ['cli.start', 'cli.status', 'cli.result', 'cli.review', 'cli.resume'], initialCallerPid: initial.callerPid, resumedCallerPid: resumed.callerPid, managers: [manager1.pid, manager2.pid], nativeClis: [cli1.pid, cli2.pid], sessionId: result2.sessionId, completedRuns: 2, historyPreserved: true, unicodeEnvironmentEqual: true, scriptPathsContainSpaces: true, fixtureProcessesExited: true }));
  f.markComplete();
});

test('Windows manager bootstrap exits without dispatch when its caller exits after identity persistence but before the payload', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const f = fixture(t), entry = path.join(f.root, 'pre-payload-caller.mjs'), proofFile = path.join(f.root, 'bootstrap-manager.json');
  const payload = f.prepareRun(), payloadFile = path.join(f.root, 'valid-manager-payload.json');
  atomicJson(payloadFile, payload);
  const startingEvidence = Object.fromEntries([f.store.locator(f.binding), f.runFile(1, 'run.json'), f.runFile(1, 'input.json')]
    .map(file => [file, fs.readFileSync(file, 'utf8')]));
  assert.equal(f.store.read(f.binding).status, 'starting');
  fs.writeFileSync(entry, `
import fs from 'node:fs';
import { startWindowsManager } from ${JSON.stringify(launcherUrl)};
import { atomicJson } from ${JSON.stringify(storeUrl)};
const payload = JSON.parse(fs.readFileSync(${JSON.stringify(payloadFile)}, 'utf8'));
await startWindowsManager(${JSON.stringify(fileURLToPath(new URL(bridgeUrl)))}, payload, identity => {
  atomicJson(${JSON.stringify(f.runFile(1, 'manager-process.json'))}, identity);
  fs.writeFileSync(${JSON.stringify(proofFile)}, JSON.stringify(identity));
  // The real bootstrap calls this before socket.write(payload); only this parent exits.
  process.exit(0);
});
throw new Error('A pre-payload caller cannot return from manager startup');
`);
  const outcome = await runCaller(entry, [], f.binding.executionRoot);
  const proof = readJson(proofFile);
  if (proof) f.bootstrapProofs.push(proof);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.ok(proof, 'independent process identity was persisted before caller exit');
  await until(() => processIsGone(proof), 'undispatched manager exits after pipe closure');
  assert.equal(f.launches().length, 0);
  for (const name of ['cli-launch-intent.json', 'cli-process.json', 'result.json']) assert.equal(fs.existsSync(f.runFile(1, name)), false, `${name} must not exist before payload dispatch`);
  for (const [file, bytes] of Object.entries(startingEvidence)) assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the undispatched starting evidence must remain unchanged');
  assert.equal(f.store.read(f.binding).status, 'starting');
  assert.deepEqual(readJson(f.runFile(1, 'manager-process.json')), proof);
  t.diagnostic(JSON.stringify({ callerPid: outcome.pid, managerPid: proof.pid, validTaskPayloadPrepared: true, callerExitedBeforePayload: true, managerExited: true, nativeCliLaunches: 0, startingEvidencePreserved: true }));
  f.markComplete();
});

test('Windows manager keeps a valid dispatched run after caller EOF before its delayed ready receipt', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const f = fixture(t), payloadFile = path.join(f.root, 'valid delayed payload.json');
  const entry = path.join(f.root, 'before ready caller.mjs'), managerEntry = path.join(f.root, 'delayed ready manager.mjs');
  const receivedFile = path.join(f.root, 'payload-received.json'), readyFile = path.join(f.root, 'ready-attempted.json');
  const continueFile = path.join(f.root, 'continue-after-caller-exit');
  atomicJson(payloadFile, f.prepareRun());
  // This small manager delays only readiness. Bootstrap, identity binding, CLI
  // execution and result persistence all use the actual product implementations.
  fs.writeFileSync(managerEntry, `
import fs from 'node:fs';
import { receiveWindowsManager } from ${JSON.stringify(launcherUrl)};
import { CliTaskStore, atomicJson } from ${JSON.stringify(storeUrl)};
import { runNativeCli } from ${JSON.stringify(runnerUrl)};
const { payload, send } = await receiveWindowsManager(process.argv[3], process.argv[4]);
const store = new CliTaskStore({ controlRoot: payload.controlRoot });
store.setProcess(payload.run, payload.managerIdentity);
atomicJson(${JSON.stringify(receivedFile)}, { pid: process.pid, received: true, unicodeEnvironmentEqual: process.env.BEYOND_MANAGER_FIXTURE_UNICODE === ${JSON.stringify(unicodeEnvironmentValue)} });
const deadline = Date.now() + 20000;
while (!fs.existsSync(${JSON.stringify(continueFile)}) && !fs.existsSync(${JSON.stringify(path.join(f.root, 'release-all'))})) {
  if (Date.now() > deadline) throw new Error('Isolated ready gate timed out');
  await new Promise(resolve => setTimeout(resolve, 20));
}
atomicJson(${JSON.stringify(readyFile)}, { pid: process.pid, attempted: true });
send({ type: 'accepted' });
await runNativeCli({ ...payload, store });
`);
  fs.writeFileSync(entry, `
import fs from 'node:fs';
import { startWindowsManager } from ${JSON.stringify(launcherUrl)};
import { atomicJson } from ${JSON.stringify(storeUrl)};
const payload = JSON.parse(fs.readFileSync(${JSON.stringify(payloadFile)}, 'utf8'));
setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(receivedFile)})) return;
  if (fs.existsSync(${JSON.stringify(readyFile)})) throw new Error('Manager became ready before the caller exited');
  process.exit(0);
}, 20);
await startWindowsManager(${JSON.stringify(managerEntry)}, payload, identity => atomicJson(${JSON.stringify(f.runFile(1, 'manager-process.json'))}, identity));
throw new Error('The caller must exit before startup readiness resolves');
`);
  const outcome = await runCaller(entry, [], f.binding.executionRoot);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.code, 0, outcome.stderr);
  const proof = readJson(f.runFile(1, 'manager-process.json')), received = readJson(receivedFile);
  assert.equal(received?.received, true);
  assert.equal(received.pid, proof.pid);
  assert.equal(received.unicodeEnvironmentEqual, true);
  assert.equal(fs.existsSync(readyFile), false, 'caller exit happens before the readiness receipt');
  assert.equal(f.launches().length, 0, 'business execution is still behind the explicit after-exit gate');
  assert.equal(processIsGone(proof), false, 'a verified dispatched manager survives caller EOF');
  fs.writeFileSync(continueFile, 'caller has exited; readiness may proceed');
  const capture = await until(() => f.capture(1), 'CLI launches after caller EOF and late readiness');
  assert.equal(capture.unicodeEnvironmentEqual, true);
  assert.equal(readJson(readyFile).attempted, true);
  fs.writeFileSync(path.join(f.root, 'release-1'), 'complete valid dispatched run');
  const result = await until(() => f.result(1), 'stable dispatched result after caller EOF');
  assert.equal(result.status, 'completed');
  assert.equal(result.finalText, 'stable manager result 1');
  assert.equal(f.launches().length, 1);
  await until(() => processIsGone(proof), 'dispatched manager exits after completion');
  const observed = await f.invoke([f.request('cli.status', 'late-ready-status'), f.request('cli.result', 'late-ready-result', { runNumber: 1 })]);
  assert.equal(observed.results[0].status, 'completed');
  assert.deepEqual(observed.results[1], result);
  t.diagnostic(JSON.stringify({ callerPid: outcome.pid, managerPid: proof.pid, validPayloadReceived: true, callerExitedBeforeReady: true, runCompletedAfterCallerEOF: true, unicodeEnvironmentEqual: true, scriptPathsContainSpaces: true, nativeCliLaunches: 1 }));
  f.markComplete();
});

test('Windows manager aborts the real source observer when persisted terminal state rejects process binding', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const f = fixture(t), payload = f.prepareRun();
  const sourceDirectory = path.join(f.root, 'isolated desktop source'), source = path.join(sourceDirectory, 'owner.jsonl');
  const desktopHome = path.join(f.root, 'isolated desktop home'), pluginRoot = path.join(desktopHome, 'no desktop plugin');
  fs.mkdirSync(sourceDirectory, { recursive: true }); fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(source, [
    { type: 'session_meta', payload: { id: f.binding.ownerThreadId } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: f.binding.ownerTurnId } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  f.cleanupActions.push(() => {
    const proof = readJson(f.runFile(1, 'manager-process.json'));
    if (proof && !processIsGone(proof)) {
      // If the regression returns, release only our synthetic source watcher
      // after the exit assertion has failed, retaining all failure evidence.
      fs.appendFileSync(source, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: f.binding.ownerTurnId } }) + '\n');
    }
  });
  payload.hostSpec = {
    env: { CODEX_HOME: desktopHome, CODEX_THREAD_ID: f.binding.ownerThreadId },
    pluginRoot, sourceRecordPath: source,
  };
  // This terminal result predates the manager; binding must fail without changing it.
  f.store.finishRun(payload.run, { status: 'failed', sessionId: null, exitCode: 1, error: 'Fixture terminal state committed before manager binding' });
  const preservedFiles = [f.store.locator(f.binding), f.runFile(1, 'run.json'), f.runFile(1, 'input.json'), f.runFile(1, 'result.json'), source];
  const before = Object.fromEntries(preservedFiles.map(file => [file, fs.readFileSync(file, 'utf8')]));
  const payloadFile = path.join(f.root, 'terminal manager payload.json'), traceFile = path.join(f.root, 'source-observer-trace.jsonl');
  const entry = path.join(f.root, 'rejected binding caller.mjs'), managerEntry = path.join(f.root, 'observed real manager.mjs');
  atomicJson(payloadFile, payload);
  // Observe real fs.watch handles, without substituting the source observer or bridge.
  // No terminal event is appended: only the manager's abort can close this observer.
  fs.writeFileSync(managerEntry, `
import fs from 'node:fs';
import path from 'node:path';
const originalWatch = fs.watch;
fs.watch = function (directory, ...args) {
  const watcher = originalWatch.call(this, directory, ...args);
  if (path.resolve(directory) === ${JSON.stringify(sourceDirectory)}) {
    const trace = event => fs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ event, pid: process.pid }) + '\\n');
    trace('opened');
    const close = watcher.close.bind(watcher);
    watcher.close = function () { trace('closed'); return close(); };
  }
  return watcher;
};
await import(${JSON.stringify(bridgeUrl)});
`);
  fs.writeFileSync(entry, `
import fs from 'node:fs';
import { startWindowsManager } from ${JSON.stringify(launcherUrl)};
import { atomicJson } from ${JSON.stringify(storeUrl)};
const payload = JSON.parse(fs.readFileSync(${JSON.stringify(payloadFile)}, 'utf8'));
try {
  await startWindowsManager(${JSON.stringify(managerEntry)}, payload, identity => atomicJson(${JSON.stringify(f.runFile(1, 'manager-process.json'))}, identity));
  throw new Error('Terminal process binding was unexpectedly accepted');
} catch (error) {
  if (error.message !== 'CLI process binding conflict') throw error;
  process.stdout.write(JSON.stringify({ expectedProcessBindingRejection: true }) + '\\n');
}
`);
  const outcome = await runCaller(entry, [], f.binding.executionRoot);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(JSON.parse(outcome.stdout.trim()).expectedProcessBindingRejection, true);
  const proof = readJson(f.runFile(1, 'manager-process.json'));
  assert.ok(proof, 'the rejected manager still has durable exact-process ownership');
  await until(() => processIsGone(proof), 'rejected manager exits without an abandoned source watcher', 10000);
  const trace = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(trace, [{ event: 'opened', pid: proof.pid }, { event: 'closed', pid: proof.pid }], 'the actual source watcher is opened, then aborted and closed on setProcess rejection');
  assert.equal(f.launches().length, 0);
  for (const name of ['cli-launch-intent.json', 'cli-process.json', 'notification.json']) assert.equal(fs.existsSync(f.runFile(1, name)), false, `${name} must not be created after binding rejection`);
  for (const [file, bytes] of Object.entries(before)) assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'pre-existing terminal evidence and ongoing source record remain unchanged');
  t.diagnostic(JSON.stringify({ managerPid: proof.pid, realSourceObserverOpened: true, processBindingRejected: true, realSourceObserverClosed: true, managerExited: true, nativeCliLaunches: 0, notificationAttempted: false, terminalEvidencePreserved: true }));
  f.markComplete();
});
