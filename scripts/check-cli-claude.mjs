import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { CliTaskStore, atomicJson, digest, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { currentProcessIdentity } from '../模板交付包/scripts/cli/process-identity.mjs';
import { runVisibleCli } from '../模板交付包/scripts/cli/visible-cli-runner.mjs';
import { createClaudeSession, sendClaudePrompt } from '../模板交付包/scripts/cli/claude-client.mjs';
import { readClaudeProfile, claudeArguments } from '../模板交付包/scripts/cli/claude-profile.mjs';
import { forwardClaudeHook } from '../模板交付包/scripts/cli/claude-hook.mjs';
import { callInteractive } from '../模板交付包/scripts/cli/interactive-client.mjs';

async function until(check) { const end = Date.now() + 12000; while (!check()) { if (Date.now() > end) throw new Error('Claude fixture timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } }
const transport = { pipe: '\\\\.\\pipe\\fixture-claude', token: crypto.randomUUID() };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-claude-unit-'));
  const profile = { schemaVersion: 1, provider: 'claude', mode: 'interactive', ui: 'window', model: 'test-model', permissionMode: 'dontAsk', runner: { command: process.execPath, args: [] } };
  const profilePath = path.join(root, 'profile.json'); atomicJson(profilePath, profile);
  const binding = { projectId: 'local-test', taskId: 'claude-goal', ownerThreadId: 'owner', ownerTurnId: 'foreground', taskMode: 'assist', executionRoot: root, profilePath, contract: { goal: 'review then fix', boundaries: 'fixture only', acceptance: 'tests pass', factEntries: [], skillEntries: [] } };
  const store = new CliTaskStore({ controlRoot: root }); store.create(binding);
  const run = store.beginRun(binding, { requestId: 'start', prompt: 'review', expectedRunNumber: 0, expectedSessionId: null });
  const identity = { ...currentProcessIdentity(), token: crypto.randomUUID() }; store.setProcess(run, identity);
  const sessionId = crypto.randomUUID(), calls = [], callbacks = [], abort = new AbortController();
  let releaseForeground, native, attached, commands, closing, deliveryError;
  const foreground = new Promise(resolve => { releaseForeground = resolve; });
  const host = { currentSource: () => ({ ownerThreadId: 'owner', ownerTurnId: 'foreground' }), waitForSourceTurnEnd: () => foreground, checkCapability: async () => ({ available: true }), send: async value => { callbacks.push(value); return { status: 'delivered' }; } };
  const endpoint = () => store.readJson(path.join(store.taskDir(binding), 'interactive.json'));
  const hook = (event, extra = {}) => native.hook({ session_id: sessionId, hook_event_name: event, ...extra }, transport);
  async function post(route, data) {
    const ep = endpoint(), response = await fetch(new URL(route, ep.controlUrl), { method: 'POST', headers: { authorization: 'Bearer ' + fs.readFileSync(ep.tokenPath, 'utf8'), 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error); return body;
  }
  function close() {
    closing ??= (async () => { await attached; await native.nativeEnded(); const ep = endpoint(); atomicJson(ep.viewExitPath, { launchId: ep.launchId, exitCode: 0 }); abort.abort(); })();
    return closing;
  }
  const lifetime = runVisibleCli({ binding, run, profile, prompt: 'review', store, managerIdentity: identity, host, openWindow() {
    // The real launcher records child identity before SessionStart, including failed startup.
    store.setChildProcess(run, identity);
    native = createClaudeSession({ sessionId, model: profile.model, cwd: root, pid: process.pid, post, terminate: () => { void close(); }, deliver: async (_pipe, prompt) => { calls.push(prompt); assert.deepEqual(await hook('UserPromptSubmit', { prompt }), {}); } });
    attached = hook('SessionStart', { cwd: root, model: profile.model });
    commands = (async () => { await attached; while (!abort.signal.aborted) { const ep = endpoint(), response = await fetch(ep.controlUrl + 'command', { headers: { authorization: 'Bearer ' + fs.readFileSync(ep.tokenPath, 'utf8') }, signal: abort.signal }); if (!response.ok) break; await native.command(await response.json()); } })().catch(error => { if (!abort.signal.aborted) deliveryError = error; });
    return { windowPid: process.pid, transport: 'isolated-native-fixture' };
  } });
  t.after(async () => { releaseForeground(); await close(); await lifetime; await commands; fs.rmSync(root, { recursive: true, force: true }); });
  async function start() { await attached; await until(() => calls.length === 1); assert.ifError(deliveryError); }
  function review(decision = 'continue') { const state = store.read(binding); return store.recordReview({ ...binding, runNumber: state.runNumber, resultSha256: sha256File(path.join(store.runDir(binding, state.runNumber), 'result.json')), decision, evidenceLocator: 'file:fixture', conclusion: 'independent verification', reviewedAt: new Date().toISOString() }); }
  async function finish(text = 'answer', extra = {}) { await hook('Stop', { last_assistant_message: text, background_tasks: [], session_crons: [], ...extra }); }
  return { root, binding, profile, store, run, sessionId, callbacks, calls, start, hook, finish, review, releaseForeground, close, lifetime, endpoint };
}

test('Claude review, repair and verification use one session; notification waits for owner foreground', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start();
  for (let round = 1; round <= 3; round++) {
    if (round > 1) {
      f.review(); const next = f.store.beginRun(f.binding, { requestId: 'round-' + round, prompt: 'continue', expectedRunNumber: round - 1, expectedSessionId: f.sessionId });
      await callInteractive(f.store, f.binding, 'resume', { run: next, profile: f.profile, prompt: 'continue' }); await until(() => f.calls.length === round);
    }
    await f.finish('round ' + round); assert.equal(f.store.readResult(f.binding, round).finalText, 'round ' + round);
    assert.equal(f.store.read(f.binding).sessionId, f.sessionId); assert.equal(f.store.readReview(f.binding, round), null);
    if (round === 1) { assert.equal(f.callbacks.length, 0); f.releaseForeground(); }
    await until(() => f.callbacks.length === round);
  }
  f.review('accept'); await f.lifetime;
  assert.equal(f.endpoint().status, 'closed');
  assert.equal(fs.existsSync(path.join(f.root, 'local/runtime/worker-results/pending')), false);
});

test('background work and scheduled activity do not prematurely complete Claude turn', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start();
  await f.finish('waiting', { background_tasks: [{ id: 'task', status: 'running' }] });
  await f.finish('waiting', { session_crons: [{ id: 'cron' }] });
  assert.equal(fs.existsSync(f.run.resultPath), false);
  await f.finish('real final'); assert.equal(f.store.readResult(f.binding, 1).status, 'completed');
});

test('manual continuation is tracked while competing input and model switching are blocked', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start();
  assert.equal((await f.hook('UserPromptSubmit', { prompt: 'unrelated second task' })).decision, 'block');
  assert.equal((await f.hook('PreModelSwitch')).decision, 'block');
  await f.finish(); assert.deepEqual(await f.hook('UserPromptSubmit', { prompt: 'fix previous result' }), {});
  await f.finish('fixed'); assert.equal(f.store.read(f.binding).runNumber, 2);
  assert.equal(f.store.readResult(f.binding, 2).finalText, 'fixed');
});

test('empty answer fails and repeated Stop cannot overwrite its result', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start(); await f.finish(''); await f.finish('late overwrite');
  assert.equal(f.store.readResult(f.binding, 1).status, 'failed'); assert.equal(f.store.readResult(f.binding, 1).finalText, '');
});

test('API failure is not successful completion and does not expose provider secret diagnostics', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start(); await f.hook('StopFailure', { error: 'authentication_failed', last_assistant_message: 'api_key=provider-secret' });
  const result = f.store.readResult(f.binding, 1); assert.equal(result.status, 'failed'); assert.doesNotMatch(JSON.stringify(result), /provider-secret/);
});

test('unexpected exit preserves unknown and cannot invent successful completion', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start(); f.releaseForeground(); await f.close(); await f.lifetime;
  assert.equal(f.store.readResult(f.binding, 1).status, 'unknown'); assert.equal(f.calls.length, 1);
});

test('explicit stop follows the saved process and detaches the native view', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start(); const state = f.store.read(f.binding);
  f.store.requestStop(f.binding, { stateSha256: digest(state), expectedSessionId: state.sessionId, reason: 'fixture stop', requestId: 'stop' });
  f.releaseForeground(); await f.lifetime; assert.equal(f.store.readResult(f.binding, 1).status, 'stopped');
});

test('detach waits for the current response and removes only its connection tokens', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start(); const ep = f.endpoint();
  assert.equal((await callInteractive(f.store, f.binding, 'detach')).status, 'detach-after-turn'); assert.equal(fs.existsSync(f.run.resultPath), false);
  f.releaseForeground(); await f.finish('done'); await f.lifetime;
  assert.equal(f.store.readResult(f.binding, 1).status, 'completed'); assert.equal(fs.existsSync(ep.tokenPath), false);
});

test('wrong session, cwd and model cannot register; completion needs prompt-start evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-claude-events-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [], s = createClaudeSession({ sessionId: 'expected', model: 'model', cwd: root, pid: process.pid, post: async (r,d) => events.push([r,d]), deliver: async () => {}, terminate() {} });
  await assert.rejects(s.hook({ hook_event_name: 'SessionStart', session_id: 'foreign' }, transport), /identity changed/);
  await assert.rejects(s.hook({ hook_event_name: 'SessionStart', session_id: 'expected', cwd: root, model: 'wrong' }, transport), /identity mismatch/);
  await s.hook({ hook_event_name: 'SessionStart', session_id: 'expected', cwd: root, model: 'model' }, transport);
  await s.command({ action: 'submit', runNumber: 1, prompt: 'test' });
  await assert.rejects(s.hook({ hook_event_name: 'Stop', session_id: 'expected', last_assistant_message: 'fake' }), /prompt-start evidence/);
  assert.equal(events.filter(([r]) => r === '/event').length, 0);
});

test('stop does not report stopped until the actual native process has exited', async () => {
  const results = []; let terminated = false;
  const s = createClaudeSession({ sessionId: 's', model: 'm', cwd: os.tmpdir(), pid: process.pid, post: async (route, body) => { results.push([route, body]); }, deliver: async () => {}, terminate: () => { terminated = true; } });
  await s.hook({ session_id: 's', hook_event_name: 'SessionStart', model: 'm', cwd: os.tmpdir() }, transport);
  await s.command({ action: 'submit', runNumber: 1, prompt: 'test' }); await s.command({ action: 'stop', runNumber: 1 });
  assert.equal(terminated, true); assert.equal(results.length, 1);
  await s.nativeEnded(); assert.equal(results[1][1].status, 'stopped');
});

test('missing model is accepted only on exact saved-session resume, not a new or mismatched session', async () => {
  const options = { sessionId: 'saved', model: 'explicit-model', cwd: os.tmpdir(), pid: process.pid, post: async () => {}, deliver: async () => {}, terminate() {} };
  const resumed = createClaudeSession({ ...options, resuming: true });
  await assert.rejects(resumed.hook({ session_id: 'wrong', hook_event_name: 'SessionStart', cwd: os.tmpdir(), source: 'resume' }, transport), /identity changed/);
  await assert.rejects(resumed.hook({ session_id: 'saved', hook_event_name: 'SessionStart', cwd: os.tmpdir(), source: 'resume', model: 'wrong' }, transport), /identity mismatch/);
  await resumed.hook({ session_id: 'saved', hook_event_name: 'SessionStart', cwd: os.tmpdir(), source: 'resume' }, transport);
  assert.equal(resumed.registered, true);
  const fresh = createClaudeSession(options);
  await assert.rejects(fresh.hook({ session_id: 'saved', hook_event_name: 'SessionStart', cwd: os.tmpdir(), source: 'resume' }, transport), /identity mismatch/);
});

test('Claude native arguments preserve an exact session and explicit permissions, without exec mode', () => {
  const p = { model: 'provider-model', permissionMode: 'dontAsk' }, b = { taskId: 'task' };
  assert.deepEqual(claudeArguments(p, b, 'settings', 'new-id'), ['--model','provider-model','--permission-mode','dontAsk','--settings','settings','--name','BEYOND-task','--session-id','new-id']);
  assert.deepEqual(claudeArguments(p, { ...b, sessionId: 'saved-id' }, 'settings', 'ignored').slice(-2), ['--resume', 'saved-id']);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const args = claudeArguments({ ...p, model: 'new-model', effort, permissionMode: 'bypassPermissions' }, { ...b, sessionId: 'saved-id' }, 'settings', 'ignored');
    assert.equal(args[args.indexOf('--model') + 1], 'new-model');
    assert.equal(args[args.indexOf('--effort') + 1], effort);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.deepEqual(args.slice(-2), ['--resume', 'saved-id']);
  }
});

test('Claude profiles reject embedded credentials and arbitrary launcher arguments', () => {
  const p = { schemaVersion: 1, provider: 'claude', mode: 'interactive', ui: 'window', permissionMode: 'dontAsk', runner: { command: process.execPath, args: [] }, model: 'model' };
  assert.throws(() => readClaudeProfile({ ...p, api_key: 'secret' }), /credentials/);
  // Non-Windows hosts reject the adapter before inspecting native Windows options.
  const expected = pattern => process.platform === 'win32' ? pattern : /requires Windows/;
  assert.throws(() => readClaudeProfile({ ...p, runner: { ...p.runner, args: ['--resume','unowned'] } }), expected(/native executable/));
  assert.throws(() => readClaudeProfile({ ...p, permissionMode: 'typo' }), expected(/permissionMode/));
  for (const effort of ['ultra', '', 3, 'high\n--debug']) assert.throws(() => readClaudeProfile({ ...p, effort }), expected(/effort unsupported/));
  assert.throws(() => readClaudeProfile(p), expected(/revalidation/));
});

test('hook transport requires loopback and matching event identity', async () => {
  const input = { session_id: 's', hook_event_name: 'Stop' };
  await assert.rejects(forwardClaudeHook('SessionStart', input, {}), /identity/);
  await assert.rejects(forwardClaudeHook('Stop', input, { url: 'https://example.com/', token: 'secret' }), /local/);
});

test('native named pipe receives an authenticated user prompt, not a shell command', { timeout: 10000 }, async t => {
  if (process.platform !== 'win32') return t.skip('Windows named pipe adapter');
  const pipe = '\\\\.\\pipe\\beyond-claude-unit-' + crypto.randomUUID(); let received;
  const collected = new Promise(resolve => { received = resolve; });
  const server = net.createServer(socket => { let text = ''; socket.on('data', b => { text += b; }); socket.on('end', () => received(text)); });
  await new Promise(resolve => server.listen(pipe, resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const pipeToken = crypto.randomUUID();
  await sendClaudePrompt({ pipe, token: pipeToken }, 'review file; do not execute this as shell');
  const lines = (await collected).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [{ type: 'auth', token: pipeToken }, { type: 'user', message: { role: 'user', content: 'review file; do not execute this as shell' } }]);
});
