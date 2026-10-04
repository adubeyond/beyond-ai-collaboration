import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliTaskStore, digest, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { currentProcessIdentity } from '../模板交付包/scripts/cli/process-identity.mjs';
import { runInteractiveCli, classifyInteractiveTurn, checkInteractiveCapability } from '../模板交付包/scripts/cli/interactive-cli-runner.mjs';
import { callInteractive, readInteractiveEndpoint, projectTrustOverride } from '../模板交付包/scripts/cli/interactive-client.mjs';
import { cliEnvironment } from '../模板交付包/scripts/cli/native-cli-runner.mjs';
import { connectAppServer } from '../模板交付包/scripts/cli/app-server-rpc.mjs';
import { readProfile } from '../模板交付包/scripts/cli/cli-bridge.mjs';

async function until(check) { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error('Fixture timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-native-unit-')); fs.mkdirSync(path.join(root, 'home'));
  const script = path.join(root, 'fake.cjs');
  fs.writeFileSync(script, `if(process.argv.includes('--help'))console.log('--ws-auth --ws-token-file --listen');else {const a=process.argv,u=new URL(a[a.indexOf('--listen')+1]);require('http').createServer((q,r)=>r.end('ready')).listen(+u.port,'127.0.0.1');}`);
  const profile = { schemaVersion: 1, runner: { command: process.execPath, args: [script] }, codexHome: path.join(root, 'home'), model: 'third-party', mode: 'interactive', effort: 'high', ui: 'attach' };
  const profilePath = path.join(root, 'profile.json'); fs.writeFileSync(profilePath, JSON.stringify(profile));
  const binding = { projectId: 'local-test', taskId: 'native-goal', ownerThreadId: 'owner', ownerTurnId: 'foreground-one', taskMode: 'assist', executionRoot: root, profilePath, contract: { goal: 'one goal', boundaries: 'temporary only', acceptance: 'two rounds', factEntries: [], skillEntries: [] } };
  const store = new CliTaskStore({ controlRoot: root }); store.create(binding);
  const run = store.beginRun(binding, { requestId: 'start', prompt: 'first', expectedRunNumber: 0, expectedSessionId: null });
  const managerIdentity = { ...currentProcessIdentity(), token: crypto.randomUUID() }; store.setProcess(run, managerIdentity);
  const requests = [], notifications = [], callbacks = [];
  let sendNotification, foreground = 'foreground-one', foregroundDone = false, releaseForeground;
  const pendingForeground = new Promise(resolve => { releaseForeground = () => { foregroundDone = true; resolve(); }; });
  const host = { currentSource: () => ({ ownerThreadId: 'owner', ownerTurnId: foreground }), waitForSourceTurnEnd: async () => { if (!foregroundDone) await pendingForeground; }, checkCapability: async () => ({ available: true }), send: async value => { callbacks.push(value); return { status: 'delivered' }; } };
  let n = 0;
  const connect = async (_url, _token, options) => {
    sendNotification = value => { notifications.push(value); options.onNotification(value); };
    return { initialized() {}, close() {}, async request(method, params) {
      requests.push({ method, params });
      if (method === 'initialize') return {};
      if (method.startsWith('thread/')) return { thread: { id: 'same-session' } };
      if (method === 'turn/start') { const turn = { id: `turn-${++n}`, status: 'inProgress' }; setImmediate(() => sendNotification({ method: 'turn/started', params: { threadId: 'same-session', turn } })); return { turn }; }
      if (method === 'turn/interrupt') { finish(params.turnId, 'interrupted', ''); return {}; }
      throw new Error('Unexpected RPC');
    } };
  };
  function finish(id, status = 'completed', text = 'stable result', error = null) {
    sendNotification({ method: 'item/completed', params: { threadId: 'same-session', turnId: id, item: { type: 'agentMessage', phase: null, text } } });
    sendNotification({ method: 'turn/completed', params: { threadId: 'same-session', turn: { id, status, items: [], error } } });
  }
  let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
  const lifetime = runInteractiveCli({ binding, run, profile, prompt: 'first', store, managerIdentity, host, connect, ready: (value, error) => { assert.ifError(error); readyResolve(value); } });
  t.after(async () => { releaseForeground(); await callInteractive(store, binding, 'detach').catch(() => {}); if (!fs.existsSync(run.resultPath) && sendNotification) finish('turn-1'); await lifetime; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, profilePath, profile, binding, store, run, requests, callbacks, ready, lifetime, finish, emit: value => sendNotification(value), releaseForeground, setForeground: value => { foreground = value; } };
}
test('profile supports explicit native view; legacy defaults remain compatible; no credentials in profile', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-native-profile-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(path.join(root, 'home'));
  const file = path.join(root, 'profile.json'), profile = { schemaVersion: 1, runner: { command: process.execPath, args: [] }, codexHome: path.join(root, 'home'), model: 'x' };
  fs.writeFileSync(file, JSON.stringify(profile)); assert.equal(readProfile(file).mode, undefined);
  fs.writeFileSync(file, JSON.stringify({ ...profile, mode: 'interactive', ui: 'attach', effort: 'medium' })); assert.equal(readProfile(file).mode, 'interactive');
  for (const extra of [{ mode: 'other' }, { effort: 'fast' }, { ui: 'window' }, { api_key: 'secret' }]) { fs.writeFileSync(file, JSON.stringify({ ...profile, ...extra })); assert.throws(() => readProfile(file), /invalid|credential/); }
  assert.equal(cliEnvironment('separate-home').CODEX_APP_TOOLS_PIPE_PATH, undefined);
  assert.equal(cliEnvironment('separate-home').CODEX_THREAD_ID, undefined);
});
test('completed alone is insufficient; interrupted and missing final never become completed', () => {
  assert.equal(classifyInteractiveTurn({ status: 'completed' }, 'actual final'), 'completed');
  for (const [status, text, error] of [['completed', '', null], ['inProgress', 'partial', null], ['failed', 'partial', { message: 'failure' }], ['completed', 'final', { message: 'failure' }]]) assert.equal(classifyInteractiveTurn({ status, error }, text), 'failed');
  assert.equal(classifyInteractiveTurn({ status: 'interrupted' }, 'partial'), 'stopped');
});

test('trust override uses a TOML value table, not a literally quoted dotted path', () => {
  const physical = fs.realpathSync(os.tmpdir());
  const key = process.platform === 'win32' ? physical.toLowerCase() : physical;
  assert.equal(projectTrustOverride(physical), `projects={${JSON.stringify(key)}={trust_level="trusted"}}`);
});
test('remote hosts and unauthenticated WebSocket are rejected before connection', async () => {
  for (const [url, token] of [['ws://example.com:4500', 'token'], ['ws://127.0.0.1:4500', ''], ['wss://127.0.0.1:4500', 'token']]) await assert.rejects(() => connectAppServer(url, token), /loopback/);
});
test('native lifecycle retains one session and forces no-approval/full-access on start and continuation', async t => {
  const f = fixture(t); await f.ready; checkInteractiveCapability(f.profile);
  f.finish('turn-1'); await until(() => fs.existsSync(f.run.resultPath));
  assert.equal(f.callbacks.length, 0, 'foreground must finish first');
  f.releaseForeground(); await until(() => f.callbacks.length === 1);
  f.store.recordReview({ projectId: f.binding.projectId, taskId: f.binding.taskId, ownerThreadId: 'owner', runNumber: 1, resultSha256: sha256File(f.run.resultPath), decision: 'continue', evidenceLocator: 'file:first', conclusion: 'need next part', reviewedAt: new Date().toISOString() });
  const next = f.store.beginRun(f.binding, { requestId: 'second', prompt: 'next', expectedRunNumber: 1, expectedSessionId: 'same-session', ownerTurnId: 'foreground-two' });
  await callInteractive(f.store, f.binding, 'resume', { run: next, profile: f.profile, prompt: 'next' });
  f.finish('turn-2'); await until(() => fs.existsSync(next.resultPath)); await until(() => f.callbacks.length === 2);
  assert.equal(f.store.read(f.binding).sessionId, 'same-session');
  for (const call of f.requests.filter(x => x.method === 'turn/start')) { assert.equal(call.params.approvalPolicy, 'never'); assert.deepEqual(call.params.sandboxPolicy, { type: 'dangerFullAccess' }); assert.equal(call.params.effort, 'high'); }
  assert.equal(f.requests.filter(x => x.method === 'thread/start').length, 1);
  const endpoint = readInteractiveEndpoint(f.store, f.binding);
  const forbidden = await fetch(endpoint.controlUrl + 'open', { method: 'POST', headers: { Origin: 'https://untrusted.invalid', Authorization: 'Bearer wrong' } }); assert.equal(forbidden.status, 403);
  const leaked = fs.readFileSync(next.resultPath, 'utf8'); assert.equal(leaked.includes(fs.readFileSync(endpoint.tokenPath, 'utf8')), false);
});
test('native UI typed continuation enters the same goal; duplicate/foreign terminal events ignored', async t => {
  const f = fixture(t); await f.ready; f.finish('turn-1'); await until(() => fs.existsSync(f.run.resultPath)); f.releaseForeground(); await until(() => f.callbacks.length === 1);
  f.emit({ method: 'turn/started', params: { threadId: 'same-session', turn: { id: 'typed-turn', status: 'inProgress' } } });
  await until(() => f.store.read(f.binding).runNumber === 2);
  f.finish('typed-turn'); await until(() => f.store.read(f.binding).status === 'completed'); await until(() => f.callbacks.length === 2);
  f.finish('typed-turn'); f.emit({ method: 'turn/completed', params: { threadId: 'foreign', turn: { id: 'foreign', status: 'completed', items: [] } } });
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(f.callbacks.length, 2); assert.equal(f.store.read(f.binding).runNumber, 2);
});
test('stop interrupts only the saved active turn and retires its endpoint/token', async t => {
  const f = fixture(t); await f.ready; const state = f.store.read(f.binding), endpoint = readInteractiveEndpoint(f.store, f.binding);
  f.store.requestStop(f.binding, { stateSha256: digest(state), expectedSessionId: state.sessionId, reason: 'explicit test stop', requestId: 'stop' });
  f.releaseForeground();
  await f.lifetime; assert.equal(f.store.read(f.binding).status, 'stopped'); assert.equal(fs.existsSync(endpoint.tokenPath), false); assert.equal(readInteractiveEndpoint(f.store, f.binding), null);
  assert.equal(f.requests.filter(x => x.method === 'turn/interrupt').length, 1);
});
test('accept review shuts idle helper without inventing another run or destroying session', async t => {
  const f = fixture(t); await f.ready; f.finish('turn-1'); await until(() => fs.existsSync(f.run.resultPath)); f.releaseForeground(); await until(() => f.callbacks.length === 1);
  f.store.recordReview({ projectId: f.binding.projectId, taskId: f.binding.taskId, ownerThreadId: 'owner', runNumber: 1, resultSha256: sha256File(f.run.resultPath), decision: 'accept', evidenceLocator: 'file:verified', conclusion: 'goal met', reviewedAt: new Date().toISOString() });
  await f.lifetime; assert.equal(f.store.read(f.binding).runNumber, 1); assert.equal(f.store.read(f.binding).sessionId, 'same-session'); assert.equal(readInteractiveEndpoint(f.store, f.binding), null);
});
test('failed turn remains failed with partial evidence, not accepted because it produced text', async t => {
  const f = fixture(t); await f.ready; f.releaseForeground(); f.finish('turn-1', 'failed', 'partial output', { message: 'API failed' });
  await until(() => fs.existsSync(f.run.resultPath)); await until(() => f.callbacks.length === 1);
  assert.equal(f.store.readResult(f.binding, 1).status, 'failed'); assert.match(f.store.readResult(f.binding, 1).error, /API failed/);
  assert.equal(f.store.readReview(f.binding, 1), null);
});
test('changed live profile and second active dispatch are rejected without starting another turn', async t => {
  const f = fixture(t); await f.ready;
  await assert.rejects(() => callInteractive(f.store, f.binding, 'resume', { run: f.run, profile: f.profile, prompt: 'duplicate' }), /active|duplicate/);
  f.finish('turn-1'); await until(() => fs.existsSync(f.run.resultPath)); f.releaseForeground(); await until(() => f.callbacks.length === 1);
  await assert.rejects(() => callInteractive(f.store, f.binding, 'resume', { run: f.run, profile: { ...f.profile, model: 'changed' }, prompt: 'changed' }), /profile changed/);
  assert.equal(f.requests.filter(x => x.method === 'turn/start').length, 1);
});

test('detach waits for the actual turn; it neither interrupts nor loses the stable result', async t => {
  const f = fixture(t); await f.ready;
  const answer = await callInteractive(f.store, f.binding, 'detach', { viewExitCode: 1 });
  assert.equal(answer.status, 'detach-after-turn');
  assert.equal(f.requests.filter(x => x.method === 'turn/interrupt').length, 0);
  assert.equal(fs.existsSync(f.run.resultPath), false);
  f.releaseForeground(); f.finish('turn-1'); await f.lifetime;
  assert.equal(f.store.readResult(f.binding, 1).status, 'completed');
  const endpoint = JSON.parse(fs.readFileSync(path.join(f.store.taskDir(f.binding), 'interactive.json')));
  assert.equal(endpoint.status, 'closed'); assert.equal(endpoint.viewExitCode, 1);
});

test('unexpected server exit is unknown, not completed or automatically redispatched', async t => {
  const f = fixture(t); await f.ready;
  const endpoint = readInteractiveEndpoint(f.store, f.binding);
  f.releaseForeground(); process.kill(endpoint.server.pid); await f.lifetime;
  assert.equal(f.store.readResult(f.binding, 1).status, 'unknown');
  assert.equal(f.requests.filter(x => x.method === 'turn/start').length, 1);
  assert.equal(readInteractiveEndpoint(f.store, f.binding), null);
});
