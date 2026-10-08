import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliTaskStore, atomicJson, digest, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { currentProcessIdentity } from '../模板交付包/scripts/cli/process-identity.mjs';
import { runZcodeCli } from '../模板交付包/scripts/cli/zcode-cli-runner.mjs';
import { attachZcode } from '../模板交付包/scripts/cli/zcode-tui-hook.mjs';
import { readZcodeProfile, checkZcodeCapability } from '../模板交付包/scripts/cli/zcode-profile.mjs';
import { zcodeArguments } from '../模板交付包/scripts/cli/zcode-client.mjs';
import { callInteractive, readInteractiveEndpoint } from '../模板交付包/scripts/cli/interactive-client.mjs';

async function until(check) { const end = Date.now() + 15000; while (!check()) { if (Date.now() > end) throw new Error('ZCode fixture timed out'); await new Promise(r => setTimeout(r, 10)); } }
function fixture(t, effort, onEvent = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-zcode-unit-'));
  const profile = { schemaVersion: 1, provider: 'zcode', mode: 'interactive', ui: 'window', model: 'test-model', ...(effort ? { effort } : {}), runner: { command: process.execPath, args: [] }, packageRoot: root };
  const profilePath = path.join(root, 'profile.json'); atomicJson(profilePath, profile);
  const binding = { projectId: 'local-test', taskId: 'zcode-goal', ownerThreadId: 'owner', ownerTurnId: 'foreground-one', taskMode: 'assist', executionRoot: root, profilePath, contract: { goal: 'review then fix', boundaries: 'fixture only', acceptance: 'tests pass', factEntries: [], skillEntries: [] } };
  const store = new CliTaskStore({ controlRoot: root }); store.create(binding);
  const run = store.beginRun(binding, { requestId: 'start', prompt: 'review', expectedRunNumber: 0, expectedSessionId: null });
  const managerIdentity = { ...currentProcessIdentity(), token: crypto.randomUUID() }; store.setProcess(run, managerIdentity);
  let releaseForeground, resolveSubmit, rejectSubmit, hook, closePromise, attachError, hookReady;
  const foreground = new Promise(resolve => { releaseForeground = resolve; }), calls = [], callbacks = [], notices = [];
  const host = { currentSource: () => ({ ownerThreadId: 'owner', ownerTurnId: 'foreground-one' }), waitForSourceTurnEnd: () => foreground, checkCapability: async () => ({ available: true }), send: async value => { callbacks.push(value); return { status: 'delivered' }; } };
  const app = {
    sessionId: 'sess_same', primaryTurnActive: false, activeSubmissions: 0,
    async submit(input) { calls.push(input); this.primaryTurnActive = true; this.activeSubmissions++; try { await new Promise((resolve, reject) => { resolveSubmit = resolve; rejectSubmit = reject; }); return true; } finally { this.primaryTurnActive = false; this.activeSubmissions--; } },
    finishTurn() { this.pendingTurnNotification = null; this.turnAssistantText = ''; },
    async handleResult(result) { Object.assign(this, result); },
    onEvent, addNotice(text) { notices.push(text); },
    requestForegroundTurnInterrupt() { finish('', 'interrupted'); },
    stop() { if (!closePromise) closePromise = (async () => { await hookReady; await hook?.close(); const ep = endpoint(); atomicJson(ep.viewExitPath, { launchId: ep.launchId, exitCode: 0 }); })(); return closePromise; }
  };
  function endpoint() { return store.readJson(path.join(store.taskDir(binding), 'interactive.json')); }
  function finish(text = 'review complete', notice = 'completed', unwind = true) { app.turnAssistantText = text; app.pendingTurnNotification = notice; app.finishTurn(); if (unwind) resolveSubmit?.(); }
  let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
  const lifetime = runZcodeCli({ binding, run, profile, prompt: 'review', store, managerIdentity, host, ready: (value, error) => { assert.ifError(error); readyResolve(value); }, openWindow() {
    hookReady = (async () => { const ep = endpoint(); hook = await attachZcode(app, { workspaceDirectory: root, getMainSessionId: () => app.sessionId, setTransientModel: async model => ({ model, thoughtLevel: 'medium', effortOptions: ['medium', 'high'] }), submitPrompt: async (command, options) => { assert.match(options.inputId, /^input_/); assert.match(options.queryId, /^query_/); return { thoughtLevel: command.split(' ')[1] }; } }, store.readJson(ep.connectionPath)); })().catch(error => { attachError = error; throw error; });
    return { windowPid: process.pid, transport: 'test-native-app' };
  } });
  t.after(async () => { releaseForeground(); if (app.primaryTurnActive) finish('', 'interrupted'); await app.stop(); await lifetime; fs.rmSync(root, { recursive: true, force: true }); });
  async function started() { await ready; await hookReady; assert.ifError(attachError); await until(() => calls.length === 1); }
  function review(decision = 'continue') { const state = store.read(binding), resultPath = path.join(store.runDir(binding, state.runNumber), 'result.json'); return store.recordReview({ projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: 'owner', runNumber: state.runNumber, resultSha256: sha256File(resultPath), decision, evidenceLocator: 'file:fixture-proof', conclusion: 'independent fixture verification', reviewedAt: new Date().toISOString() }); }
  async function request(route, body) { const ep = endpoint(); return fetch(ep.controlUrl + route, { method: 'POST', headers: { authorization: 'Bearer ' + fs.readFileSync(ep.tokenPath, 'utf8'), 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  return { root, profile, binding, store, run, app, calls, callbacks, notices, ready, started, lifetime, finish, unwind: () => resolveSubmit(), reject: error => rejectSubmit(error), releaseForeground, endpoint, review, request };
}

test('native renderer exception retains the original model denial without credentials', { timeout: 25000 }, async t => {
  const f = fixture(t, undefined, () => { throw new Error("Cannot read properties of undefined (reading 'reduce')"); });
  await f.started();
  try { f.app.onEvent({ type: 'turn_error', message: 'This token has no access to model test-model; api_key=fixture-secret' }); }
  catch (error) { f.reject(error); }
  f.releaseForeground(); await until(() => f.callbacks.length === 1);
  const result = f.store.readResult(f.binding, 1);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /no access to model test-model/);
  assert.match(result.error, /reading 'reduce'/);
  assert.doesNotMatch(result.error, /fixture-secret/);
  assert.equal(f.store.readReview(f.binding, 1), null);
});

test('model failure survives ordinary finish but is not inherited by a later turn', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.started(); f.releaseForeground();
  f.app.onEvent({ type: 'model_request_failed', message: 'Provider unavailable' });
  f.finish('', 'failed'); await until(() => f.callbacks.length === 1);
  assert.equal(f.store.readResult(f.binding, 1).error, 'Provider unavailable');
  f.review();
  const next = f.store.beginRun(f.binding, { requestId: 'after-failure', prompt: 'try available model', expectedRunNumber: 1, expectedSessionId: 'sess_same' });
  await callInteractive(f.store, f.binding, 'resume', { run: next, profile: f.profile, prompt: 'continue' });
  await until(() => f.calls.length === 2);
  f.app.onEvent({ type: 'tool', kind: 'error', toolName: 'shell', message: 'Recoverable tool error' });
  f.finish('done'); await until(() => f.callbacks.length === 2);
  assert.equal(f.store.readResult(f.binding, 2).status, 'completed');
  assert.equal(f.store.readResult(f.binding, 2).error, null);
});

test('ZCode completion waits for native submit unwind and owner foreground end', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.started(); assert.equal(fs.existsSync(f.run.resultPath), false);
  f.finish('evidence found', 'completed', false);
  await new Promise(r => setTimeout(r, 80)); assert.equal(fs.existsSync(f.run.resultPath), false);
  f.unwind(); await until(() => fs.existsSync(f.run.resultPath));
  assert.equal(f.callbacks.length, 0); f.releaseForeground(); await until(() => f.callbacks.length === 1);
  assert.equal(f.store.readResult(f.binding, 1).finalText, 'evidence found');
  assert.equal(f.store.readReview(f.binding, 1), null, 'native completion is not goal acceptance');
});

test('review, repair and verification keep one native session and three separate results', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.started(); f.releaseForeground();
  for (let number = 1; number <= 3; number++) {
    if (number > 1) { f.review(); const next = f.store.beginRun(f.binding, { requestId: 'round-' + number, prompt: 'continue', expectedRunNumber: number - 1, expectedSessionId: 'sess_same' }); await callInteractive(f.store, f.binding, 'resume', { run: next, profile: f.profile, prompt: number === 2 ? 'repair' : 'verify' }); await until(() => f.calls.length === number); }
    f.finish('round ' + number); await until(() => f.store.read(f.binding).status === 'completed'); await until(() => f.callbacks.length === number);
    assert.equal(f.store.read(f.binding).sessionId, 'sess_same');
  }
  assert.equal(f.calls.length, 3); f.review('accept'); await f.lifetime;
  assert.equal(readInteractiveEndpoint(f.store, f.binding), null);
  assert.equal(f.store.read(f.binding).runNumber, 3);
});

test('foreign, duplicate and empty terminal events cannot fabricate completion', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.started();
  assert.equal((await f.request('event', { runNumber: 1, sessionId: 'wrong', status: 'completed', finalText: 'fake' })).status, 409);
  assert.equal(fs.existsSync(f.run.resultPath), false);
  f.finish(''); await until(() => fs.existsSync(f.run.resultPath));
  assert.equal(f.store.readResult(f.binding, 1).status, 'failed');
  assert.equal((await f.request('event', { runNumber: 1, sessionId: 'sess_same', status: 'completed', finalText: 'overwrite' })).status, 409);
  assert.equal(f.store.readResult(f.binding, 1).finalText, '');
});

test('native typed continuation is tracked; parallel input and changed live profile are rejected', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.started();
  assert.equal(await f.app.submit('parallel work'), false); assert.equal(f.calls.length, 1);
  f.finish(); await until(() => fs.existsSync(f.run.resultPath));
  await assert.rejects(() => callInteractive(f.store, f.binding, 'resume', { run: f.run, profile: { ...f.profile, model: 'different' }, prompt: 'next' }), /profile changed/);
  const typing = f.app.submit('fix it'); await until(() => f.calls.length === 2); f.finish('fixed'); await typing;
  await until(() => f.store.read(f.binding).status === 'completed');
  assert.equal(f.store.read(f.binding).runNumber, 2); assert.equal(f.store.read(f.binding).sessionId, 'sess_same');
  assert.equal(await f.app.submit('/new'), false);
});

test('stop interrupts the recorded run, preserves evidence and closes only its view', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.started(); const state = f.store.read(f.binding), endpoint = f.endpoint();
  f.store.requestStop(f.binding, { stateSha256: digest(state), expectedSessionId: state.sessionId, reason: 'test stop', requestId: 'stop' }); f.releaseForeground();
  await f.lifetime;
  assert.equal(f.store.readResult(f.binding, 1).status, 'stopped');
  assert.equal(fs.existsSync(endpoint.tokenPath), false);
  assert.equal(f.store.read(f.binding).runNumber, 1);
});

test('detach during work waits for stable result instead of interrupting it', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.started();
  assert.equal((await callInteractive(f.store, f.binding, 'detach')).status, 'detach-after-turn');
  assert.equal(fs.existsSync(f.run.resultPath), false); f.releaseForeground(); f.finish('complete before close'); await f.lifetime;
  assert.equal(f.store.readResult(f.binding, 1).status, 'completed');
});

test('unexpected window exit never becomes successful or starts replacement work', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.started(); f.releaseForeground(); await f.app.stop(); await f.lifetime;
  assert.equal(f.store.readResult(f.binding, 1).status, 'unknown'); assert.equal(f.calls.length, 1);
});

test('loopback endpoint rejects foreign origin and missing authorization', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.started(); const ep = f.endpoint();
  assert.equal((await fetch(ep.controlUrl + 'command')).status, 403);
  assert.equal((await fetch(ep.controlUrl + 'event', { method: 'POST', headers: { origin: 'https://example.com', authorization: 'Bearer ' + fs.readFileSync(ep.tokenPath, 'utf8') } })).status, 403);
});

test('unsupported provider builds and profiles fail before a window launches', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-zcode-profile-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  atomicJson(path.join(root, 'package.json'), { name: 'zcode-app-cli', version: 'future' });
  assert.throws(() => checkZcodeCapability({ packageRoot: root }), /revalidation/);
  const p = { schemaVersion: 1, provider: 'zcode', mode: 'interactive', ui: 'window', runner: { command: process.execPath, args: [] }, packageRoot: root, model: 'test' };
  assert.throws(() => readZcodeProfile({ ...p, api_key: 'secret' }), /credentials/);
  assert.throws(() => readZcodeProfile({ ...p, mode: 'exec' }), /interactive/);
  assert.throws(() => readZcodeProfile({ ...p, runner: { ...p.runner, args: ['--resume', 'unowned'] } }), /invalid/);
});

test('native arguments use yolo and exact session resume, never unsupported --model or --last', () => {
  const profile = { runner: { args: ['configured-launcher.cjs'] }, model: 'provider/model' };
  assert.deepEqual(zcodeArguments(profile, { executionRoot: 'fixture' }), ['configured-launcher.cjs', '--cwd', 'fixture', '--mode', 'yolo']);
  assert.deepEqual(zcodeArguments(profile, { executionRoot: 'fixture', sessionId: 'sess_exact' }), ['configured-launcher.cjs', '--cwd', 'fixture', '--mode', 'yolo', '--resume', 'sess_exact']);
});

test('failed native answer is retained as failure, not accepted because it contains text', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.started(); f.finish('partial findings before failure', 'failed'); f.releaseForeground();
  await until(() => f.callbacks.length === 1);
  assert.equal(f.store.readResult(f.binding, 1).status, 'failed');
  assert.equal(f.store.readResult(f.binding, 1).finalText, 'partial findings before failure');
  assert.equal(f.store.readReview(f.binding, 1), null);
});

test('native session model is selected before registration; unavailable selection fails before dispatch', async () => {
  let selections = 0, requests = 0;
  const app = { model: 'other', handleResult: async () => {}, submit: () => { requests++; } };
  await assert.rejects(() => attachZcode(app, { setTransientModel: async () => { selections++; return {}; } }, { url: 'http://127.0.0.1:1/', token: 'fixture', model: 'desired' }), /did not select/);
  assert.equal(selections, 1); assert.equal(requests, 0);
});

test('ZCode applies the native session effort before executing and reports it to the owner', async t => {
  const f = fixture(t, 'high'); await f.started();
  assert.equal(f.app.thoughtLevel, 'high');
  const events = fs.readFileSync(path.join(f.store.runDir(f.binding, 1), 'events.jsonl'), 'utf8');
  assert.match(events, /"reportedEffort":"high"/);
  assert.equal(f.calls.length, 1, 'effort command is not a second business turn');
  f.finish('done'); await until(() => fs.existsSync(f.run.resultPath));
});

test('unsupported or unapplied ZCode effort fails before registration and business submission', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-zcode-effort-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const effort of ['ultra', 'high']) {
    let commands = 0, submissions = 0;
    const app = { model: 'desired', effortOptions: ['medium', { id: 'high', label: 'High' }], thoughtLevel: 'medium', handleResult: async () => {}, submit: () => { submissions++; } };
    const startupErrorPath = path.join(root, effort + '.json');
    await assert.rejects(() => attachZcode(app, { setTransientModel: async () => ({}), submitPrompt: async () => { commands++; return {}; } }, { url: 'http://127.0.0.1:1/', token: 'fixture', model: 'desired', effort, startupErrorPath }), /does not support|did not apply/);
    assert.match(JSON.parse(fs.readFileSync(startupErrorPath, 'utf8')).error, /does not support|did not apply/);
    assert.equal(commands, effort === 'high' ? 1 : 0); assert.equal(submissions, 0);
  }
});
