import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { CliTaskStore, atomicJson } from './cli-task-store.mjs';
import { currentProcessIdentity, processStart, nativeViewIsGone } from './process-identity.mjs';
import { runVisibleCli } from './visible-cli-runner.mjs';
import { callInteractive, readInteractiveEndpoint } from './interactive-client.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(25);
  }
}
function cleanup(root) {
  const actual = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
  assert.ok(path.basename(actual).startsWith('beyond-orphan-retirement-'));
  fs.rmSync(actual, { recursive: true });
}
async function processFixture() {
  // Real process lifetime, no CLI, API, user profile, visible window or business work.
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
    { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  const identity = { pid: child.pid, startedAt: processStart(child.pid), token: crypto.randomUUID() };
  let stopping;
  const stop = () => stopping ??= (async () => { child.stdin.end(); await exited; })();
  return { child, identity, stop };
}
async function fixture(t, { interval = 50, notifications = false, separateManager = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-orphan-retirement-'));
  const children = [];
  let lifetime, settled = false, endpointPath, cleanupEndpoint, releaseForeground = () => {};
  t.after(async () => {
    releaseForeground();
    await Promise.all(children.map(child => child.stop()));
    // Failure cleanup is explicit and separate from the no-receipt behavior under test.
    if (lifetime && !settled && fs.existsSync(endpointPath)) {
      const endpoint = cleanupEndpoint ?? JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
      atomicJson(endpointPath, endpoint);
      atomicJson(endpoint.viewExitPath, { launchId: endpoint.launchId, exitCode: 0 });
    }
    if (lifetime) await lifetime;
    cleanup(root);
  });
  const native = await processFixture(); children.push(native);
  const window = await processFixture(); children.push(window);
  const store = new CliTaskStore({ controlRoot: root });
  const profile = { provider: 'claude', model: 'isolated-model', mode: 'interactive', ui: 'window', permissionMode: 'dontAsk' };
  const binding = { projectId: 'project-test', taskId: 'orphan-test', ownerThreadId: 'owner-test', ownerTurnId: 'foreground-test',
    taskMode: 'assist', executionRoot: root, profilePath: path.join(root, 'profile.json'),
    contract: { goal: 'preserve original result', boundaries: 'temporary fixture only', acceptance: 'exact result and session retained', factEntries: [], skillEntries: [] } };
  atomicJson(binding.profilePath, profile); store.create(binding);
  const run = store.beginRun(binding, { requestId: 'original-request', prompt: 'one approved task', expectedRunNumber: 0, expectedSessionId: null, profile });
  let manager;
  const sessionId = crypto.randomUUID(), callbacks = [];
  const foreground = new Promise(resolve => { releaseForeground = resolve; });
  const host = notifications ? {
    currentSource: () => ({ ownerThreadId: binding.ownerThreadId, ownerTurnId: binding.ownerTurnId }),
    waitForSourceTurnEnd: () => foreground,
    checkCapability: async () => ({ available: true }),
    send: async value => { assert.equal(value.beforeSend(), true); callbacks.push(value); return { status: 'delivered' }; },
  } : undefined;
  endpointPath = path.join(store.taskDir(binding), 'interactive.json');
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let managerChild;
  if (separateManager) {
    assert.equal(notifications, false, 'native process-exit fixture does not simulate desktop notification transport');
    const script = `
      import crypto from 'node:crypto';
      import { CliTaskStore } from ${JSON.stringify(new URL('./cli-task-store.mjs', import.meta.url).href)};
      import { currentProcessIdentity } from ${JSON.stringify(new URL('./process-identity.mjs', import.meta.url).href)};
      import { runVisibleCli } from ${JSON.stringify(new URL('./visible-cli-runner.mjs', import.meta.url).href)};
      const { root, binding, run, profile, native, window, interval } = JSON.parse(process.argv[1]);
      const store = new CliTaskStore({ controlRoot: root });
      const managerIdentity = { ...currentProcessIdentity(), token: crypto.randomUUID() };
      store.setProcess(run, managerIdentity);
      await runVisibleCli({ binding, run, profile, store, managerIdentity, prompt: 'one approved task', nativeExitCheckMs: interval,
        openWindow() { store.setChildProcess(run, native); return { windowPid: window.pid, windowStartedAt: window.startedAt }; },
        ready(value, error) { if (error) throw error; process.stdout.write('ready\\n'); } });
      process.stdout.write('retired\\n');
    `;
    managerChild = spawn(process.execPath, ['--input-type=module', '-e', script,
      JSON.stringify({ root, binding, run, profile, native: native.identity, window: window.identity, interval })],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '', errors = '';
    managerChild.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) readyResolve(); });
    managerChild.stderr.on('data', chunk => { errors += chunk; });
    lifetime = once(managerChild, 'close').then(([code]) => {
      assert.equal(code, 0, errors); assert.match(output, /retired/);
    });
  } else {
    manager = { ...currentProcessIdentity(), token: crypto.randomUUID() };
    store.setProcess(run, manager);
    lifetime = runVisibleCli({ binding, run, profile, store, managerIdentity: manager, prompt: 'one approved task', host,
      nativeExitCheckMs: interval,
      openWindow() { store.setChildProcess(run, native.identity); return { windowPid: window.identity.pid, windowStartedAt: window.identity.startedAt }; },
      ready(_value, error) { if (error) readyReject(error); else readyResolve(); },
    });
  }
  lifetime.then(() => { settled = true; }, readyReject);
  await ready;
  manager ??= store.readJson(path.join(store.runDir(run, 1), 'manager-process.json'));
  const connection = store.readJson(path.join(store.runDir(run, 1), 'claude-connection.json'));
  const endpoint = () => store.readJson(endpointPath);
  async function post(route, body) {
    const response = await fetch(new URL(route, connection.url), { method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const value = await response.json(); assert.equal(response.status, 200, value.error); return value;
  }
  await post('register', { cwd: root, model: profile.model, sessionId, pid: native.identity.pid });
  cleanupEndpoint = endpoint();
  const command = await fetch(new URL('command', connection.url), { headers: { authorization: `Bearer ${connection.token}` } });
  assert.equal((await command.json()).action, 'submit');
  const finish = () => post('event', { sessionId, runNumber: 1, status: 'completed', finalText: 'original stable result' });
  const stopped = () => settled;
  const assertSingleRun = () => {
    assert.equal(store.read(binding).runNumber, 1); assert.equal(store.read(binding).sessionId, sessionId);
    assert.deepEqual(fs.readdirSync(path.join(store.taskDir(binding), 'runs')), ['1']);
  };
  return { root, store, binding, profile, run, sessionId, native, window, manager, managerChild, endpointPath, endpoint, lifetime,
    finish, stopped, callbacks, releaseForeground, assertSingleRun };
}

test('lost Claude exit receipt naturally exits an actual manager process without altering stable result, session or history', { timeout: 25000 }, async t => {
  const f = await fixture(t, { separateManager: true }); await f.finish();
  const resultBefore = fs.readFileSync(f.run.resultPath), taskBefore = fs.readFileSync(f.store.locator(f.binding));
  const runBefore = fs.readFileSync(path.join(f.store.runDir(f.run, 1), 'run.json'));
  assert.equal(f.endpoint().status, 'idle');
  await Promise.all([f.native.stop(), f.window.stop()]);
  await until(f.stopped, 'manager did not retire after both original processes exited without a receipt');
  assert.equal(f.managerChild.exitCode, 0); assert.equal(f.managerChild.signalCode, null);
  assert.equal(f.endpoint().status, 'closed');
  assert.equal(fs.existsSync(f.endpoint().viewExitPath), false, 'test must not manufacture an exit receipt');
  assert.deepEqual(fs.readFileSync(f.run.resultPath), resultBefore);
  assert.deepEqual(fs.readFileSync(f.store.locator(f.binding)), taskBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.store.runDir(f.run, 1), 'run.json')), runBefore);
  assert.equal(fs.existsSync(f.endpoint().tokenPath), false);
  assert.equal(fs.existsSync(f.endpoint().connectionPath), false);
  f.assertSingleRun();
});

test('lost receipt during an unfinished run becomes unknown and uses the original foreground-safe notification', { timeout: 25000 }, async t => {
  const f = await fixture(t, { notifications: true });
  assert.equal(fs.existsSync(f.run.resultPath), false);
  await Promise.all([f.native.stop(), f.window.stop()]);
  await until(() => f.endpoint().status === 'closed', 'unfinished orphan did not retire');
  const result = f.store.readResult(f.binding, 1);
  assert.equal(result.status, 'unknown'); assert.equal(result.sessionId, f.sessionId);
  assert.equal(result.finalText, ''); assert.equal(f.callbacks.length, 0);
  const before = fs.readFileSync(f.run.resultPath);
  f.releaseForeground(); await until(f.stopped, 'manager did not settle after original owner turn ended');
  assert.equal(f.callbacks.length, 1); assert.equal(f.callbacks[0].ownerThreadId, f.binding.ownerThreadId);
  assert.match(f.callbacks[0].prompt, /CLI_RESULT_READY/); assert.match(f.callbacks[0].prompt, /status=unknown/);
  assert.deepEqual(fs.readFileSync(f.run.resultPath), before); f.assertSingleRun();
  assert.equal(fs.existsSync(path.join(f.root, 'local/runtime/worker-results/pending')), false);
});

test('an alive native CLI is never an idle-timeout target, even if the old window has exited', { timeout: 25000 }, async t => {
  const f = await fixture(t); await f.finish(); await f.window.stop();
  await delay(900);
  assert.equal(f.stopped(), false); assert.equal(f.endpoint().status, 'idle');
  assert.equal(processStart(f.native.identity.pid), f.native.identity.startedAt);
  await f.native.stop(); await until(f.stopped, 'manager did not retire after native exit'); f.assertSingleRun();
});

test('native exit alone does not retire a manager while its original window remains alive', { timeout: 25000 }, async t => {
  const f = await fixture(t); await f.finish(); await f.native.stop();
  await delay(900);
  assert.equal(f.stopped(), false); assert.equal(f.endpoint().status, 'idle');
  assert.equal(processStart(f.window.identity.pid), f.window.identity.startedAt);
  await f.window.stop(); await until(f.stopped, 'manager did not retire after window exit'); f.assertSingleRun();
});

test('automatic retirement rejects a changed current run instead of closing or overwriting its endpoint', { timeout: 25000 }, async t => {
  const f = await fixture(t); await f.finish();
  const taskPath = f.store.locator(f.binding), before = fs.readFileSync(taskPath), state = f.store.read(f.binding);
  atomicJson(taskPath, { ...state, runNumber: 2, currentResultPath: null });
  await Promise.all([f.native.stop(), f.window.stop()]); await delay(400);
  assert.equal(f.stopped(), false); assert.equal(f.endpoint().status, 'idle');
  const events = fs.readFileSync(path.join(f.store.runDir(f.binding, 1), 'events.jsonl'), 'utf8');
  assert.match(events, /CLI stale run/);
  fs.writeFileSync(taskPath, before);
  await until(f.stopped, 'original unchanged run could not retire after identity restoration');
});

test('automatic retirement rejects changed endpoint identities and a result from another session', { timeout: 25000 }, async t => {
  const f = await fixture(t); await f.finish();
  const original = f.endpoint(), resultBytes = fs.readFileSync(f.run.resultPath), result = f.store.readResult(f.binding, 1);
  const mutations = [
    ['launch', { ...original, launchId: 'another-launch' }],
    ['project', { ...original, projectId: 'another-project' }],
    ['task', { ...original, taskId: 'another-task' }],
    ['owner', { ...original, ownerThreadId: 'another-owner' }],
    ['session', { ...original, sessionId: 'another-session' }],
    ['manager', { ...original, manager: { ...original.manager, token: crypto.randomUUID() } }],
    ['native', { ...original, server: { ...original.server, startedAt: 'different-native-birth' } }],
    ['window', { ...original, view: { ...original.view, windowStartedAt: 'different-window-birth' } }],
  ];
  atomicJson(f.endpointPath, mutations[0][1]);
  await Promise.all([f.native.stop(), f.window.stop()]);
  for (const [name, endpoint] of mutations) {
    atomicJson(f.endpointPath, endpoint); await delay(175);
    assert.equal(f.stopped(), false, `${name} mismatch must not retire the manager`);
    assert.deepEqual(f.endpoint(), endpoint, `${name} mismatch must not overwrite the endpoint`);
    assert.deepEqual(fs.readFileSync(f.run.resultPath), resultBytes);
  }
  atomicJson(f.run.resultPath, { ...result, sessionId: 'another-session' });
  atomicJson(f.endpointPath, original); await delay(175);
  assert.equal(f.stopped(), false, 'result session mismatch must not retire the manager');
  assert.deepEqual(f.endpoint(), original);
  fs.writeFileSync(f.run.resultPath, resultBytes);
  await until(f.stopped, 'original identity could not retire after exact snapshot restoration');
  assert.deepEqual(fs.readFileSync(f.run.resultPath), resultBytes); f.assertSingleRun();
});

test('owner detach can retire a proven orphan but open/resume and identity mismatches stay blocked', { timeout: 45000 }, async t => {
  // Keep the watchdog out of this case: this verifies the explicit controlled entry.
  const f = await fixture(t, { interval: 100000 }); await f.finish();
  await Promise.all([f.native.stop(), f.window.stop()]);
  const original = f.endpoint(), resultBytes = fs.readFileSync(f.run.resultPath), result = f.store.readResult(f.binding, 1);
  for (const action of ['open', 'resume', 'manual']) await assert.rejects(callInteractive(f.store, f.binding, action), /process state unconfirmed/);
  assert.throws(() => readInteractiveEndpoint(f.store, f.binding), /process state unconfirmed/);
  await assert.rejects(callInteractive(f.store, { ...f.binding, ownerThreadId: 'another-owner' }, 'detach'), /owner mismatch/);
  const rejectedEndpoints = [
    { ...original, sessionId: 'foreign-session' },
    { ...original, status: 'running' },
    { ...original, provider: 'zcode' },
    { ...original, view: { windowPid: original.view.windowPid } },
    { ...original, view: { windowPid: process.pid, windowStartedAt: currentProcessIdentity().startedAt } },
  ];
  for (const endpoint of rejectedEndpoints) {
    atomicJson(f.endpointPath, endpoint);
    await assert.rejects(callInteractive(f.store, f.binding, 'detach'), /mismatch|unconfirmed|proof unavailable/);
    assert.equal(f.stopped(), false);
  }
  atomicJson(f.endpointPath, original);
  for (const changed of [{ ...result, sessionId: 'foreign-session' }, { ...result, runNumber: 99 }, { ...result, status: 'unknown' }]) {
    atomicJson(f.run.resultPath, changed);
    await assert.rejects(callInteractive(f.store, f.binding, 'detach'), /mismatch/);
    assert.equal(f.stopped(), false);
  }
  fs.writeFileSync(f.run.resultPath, resultBytes);
  assert.deepEqual(await callInteractive(f.store, f.binding, 'detach'), { status: 'detached' });
  await until(f.stopped, 'controlled detach did not retire original orphan');
  assert.equal(f.endpoint().status, 'closed'); assert.deepEqual(fs.readFileSync(f.run.resultPath), resultBytes);
  f.assertSingleRun();
});

test('native/window proof treats PID reuse as original exit but never guesses missing or inaccessible identities', () => {
  const record = { server: { pid: 123, startedAt: 'native-start' }, view: { windowPid: 456, windowStartedAt: 'window-start' } };
  const esrch = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  const denied = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  const original = pid => pid === 123 ? 'native-start' : 'window-start';
  assert.equal(nativeViewIsGone(record, { signal: esrch }), true);
  assert.equal(nativeViewIsGone(record, { signal: () => {}, readStart: original }), false);
  const probes = [];
  assert.equal(nativeViewIsGone(record, { signal: pid => { probes.push(pid); }, readStart: () => 'different-birth' }), true);
  assert.deepEqual(probes, [123, 456], 'only liveness probes, no terminate signal');
  assert.throws(() => nativeViewIsGone(record, { signal: denied }), /liveness is unknown/);
  assert.throws(() => nativeViewIsGone(record, { signal: () => {}, readStart: denied }), /denied/);
  for (const changed of [{ ...record, server: null }, { ...record, server: { pid: 123 } }, { ...record, view: null },
    { ...record, view: { windowPid: 456 } }, { ...record, view: { windowPid: 0, windowStartedAt: 'window-start' } }]) {
    assert.throws(() => nativeViewIsGone(changed, { signal: esrch }), /proof unavailable/);
  }
  // Native access is known gone, but unknown window permissions must still fail closed.
  assert.throws(() => nativeViewIsGone(record, { signal: pid => pid === 123 ? esrch() : denied() }), /liveness is unknown/);
});
