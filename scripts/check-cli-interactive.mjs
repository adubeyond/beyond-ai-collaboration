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
import { readProfile, launchCliRequest } from '../模板交付包/scripts/cli/cli-bridge.mjs';

async function until(check) { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error('Fixture timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } }
function fixture(t, stage, { documents = false, retireCommandAfterSpawn = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-native-unit-')); fs.mkdirSync(path.join(root, 'home'));
  const script = path.join(root, 'fake.cjs'), launchesFile = path.join(root, 'launches.jsonl');
  const desktopCommand = () => process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', crypto.randomBytes(32).toString('hex'), 'codex.exe')
    : path.join(root, 'removed-codex.exe');
  const retiredCommand = desktopCommand(), replacementCommand = desktopCommand();
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(launchesFile)},JSON.stringify({pid:process.pid,help:process.argv.includes('--help')})+'\\n');if(process.argv.includes('--help'))console.log('--ws-auth --ws-token-file --listen');else {const a=process.argv,u=new URL(a[a.indexOf('--listen')+1]);require('http').createServer((q,r)=>r.end('ready')).listen(+u.port,'127.0.0.1');}`);
  const profile = { schemaVersion: 1, runner: { command: process.execPath, args: [script] }, codexHome: path.join(root, 'home'), model: 'third-party', mode: 'interactive', effort: 'high', ui: 'attach' };
  const profilePath = path.join(root, 'profile.json'); fs.writeFileSync(profilePath, JSON.stringify(profile));
  const binding = { projectId: 'local-test', taskId: 'native-goal', ownerThreadId: 'owner', ownerTurnId: 'foreground-one', taskMode: 'assist', executionRoot: root, profilePath, contract: { goal: 'one goal', boundaries: 'temporary only', acceptance: 'two rounds', factEntries: [], skillEntries: [] } };
  const contextFiles = documents ? ['requirements', 'design'].map(name => {
    const file = path.join(root, name + '.md'); fs.writeFileSync(file, `${name}: currentR1\n`); return file;
  }) : [];
  if (documents) binding.contract.factEntries = contextFiles;
  const store = new CliTaskStore({ controlRoot: root }); store.create(binding);
  const run = store.beginRun(binding, { requestId: 'start', prompt: 'first', stage, expectedRunNumber: 0, expectedSessionId: null });
  const managerIdentity = { ...currentProcessIdentity(), token: crypto.randomUUID() };
  const requests = [], notifications = [], callbacks = [];
  let sendNotification, foreground = 'foreground-one', foregroundDone = false, releaseForeground;
  const pendingForeground = new Promise(resolve => { releaseForeground = () => { foregroundDone = true; resolve(); }; });
  const host = { currentSource: () => ({ ownerThreadId: 'owner', ownerTurnId: foreground }), waitForSourceTurnEnd: async () => { if (!foregroundDone) await pendingForeground; }, checkCapability: async () => ({ available: true }), send: async value => { callbacks.push(value); return { status: 'delivered' }; } };
  let n = 0;
  const connect = async (_url, _token, options) => {
    // Simulate an uninstalled executable after its process starts, without touching an installed binary.
    if (retireCommandAfterSpawn && requests.length === 0) profile.runner = { command: retiredCommand, args: [] };
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
  const lifetimes = [];
  function restart(nextRun, nextProfile, prompt = 'continue') {
    store.setProcess(nextRun, managerIdentity);
    let readyResolve, readyReject; const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const lifetime = runInteractiveCli({ binding, run: nextRun, profile: nextProfile, prompt, store, managerIdentity, host, connect, ready: (value, error) => error ? readyReject(error) : readyResolve(value) });
    lifetime.catch(() => {}); lifetimes.push(lifetime);
    return { ready, lifetime };
  }
  const { ready, lifetime } = restart(run, profile, 'first');
  t.after(async () => { releaseForeground(); await callInteractive(store, binding, 'detach').catch(() => {}); const state = store.read(binding); if (['starting', 'running'].includes(state.status) && sendNotification) finish(`turn-${n}`); await Promise.all(lifetimes); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, script, replacementCommand, profilePath, profile, binding, store, run, contextFiles, requests, callbacks, ready, lifetime, restart, launches: () => fs.readFileSync(launchesFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)), finish, emit: value => sendNotification(value), releaseForeground, setForeground: value => { foreground = value; } };
}

function registeredContext(f) {
  fs.mkdirSync(path.join(f.root, 'local/projects'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'local/projects/local-test.md'), `---\nid: local-test\npath: ${f.root}\nhost_id: local\ncodex_project_id: desktop-project\n---\n`);
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), '<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: local-test -->\n');
  return { controlRoot: f.root, executionRoot: f.root, ownerThreadId: 'owner', ownerTurnId: 'foreground-two' };
}
test('Codex turn/start receives current document bodies on both rounds of the same session', { timeout: 25000 }, async t => {
  const stage = { goal: 'Check the current sources', acceptance: 'Evidence matches the approved sources' };
  const f = fixture(t, stage, { documents: true }); await f.ready;
  const turns = () => f.requests.filter(item => item.method === 'turn/start');
  const manifestPath = number => path.join(f.store.runDir(f.binding, number), 'document-context.json');
  const verify = (number, marker) => {
    const text = turns()[number - 1].params.input[0].text;
    const sources = text.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.content ? [value] : []; } catch { return []; } });
    const manifest = f.store.readJson(manifestPath(number));
    for (const file of f.contextFiles) {
      assert.equal(sources.find(item => item.path === file)?.content, fs.readFileSync(file, 'utf8'));
      assert.equal(manifest.entries.find(item => item.path === file)?.sha256, sha256File(file));
    }
    assert.ok(text.includes(marker));
    assert.ok(text.includes(`Goal: ${f.binding.contract.goal}`));
    assert.ok(text.includes(`Current round deliverable: ${stage.goal}`));
    assert.equal(turns()[number - 1].params.threadId, 'same-session');
    return text;
  };
  verify(1, 'currentR1');
  const firstManifest = fs.readFileSync(manifestPath(1), 'utf8');
  f.finish('turn-1'); await until(() => f.store.read(f.binding).status === 'completed');
  f.store.recordReview({ ...f.binding, runNumber: 1, resultSha256: sha256File(f.run.resultPath), decision: 'continue', evidenceLocator: 'fixture:document-round-one', conclusion: 'read updated source next', reviewedAt: new Date().toISOString() });
  for (const file of f.contextFiles) fs.writeFileSync(file, `${path.basename(file, '.md')}: currentR2\n`);
  const next = f.store.beginRun(f.binding, { requestId: 'current-documents-2', prompt: 'read current source again', stage, expectedRunNumber: 1, expectedSessionId: 'same-session' });
  await callInteractive(f.store, f.binding, 'resume', { run: next, profile: f.profile, prompt: 'read current source again' });
  await until(() => turns().length === 2);
  assert.doesNotMatch(verify(2, 'currentR2'), /currentR1/);
  assert.equal(fs.readFileSync(manifestPath(1), 'utf8'), firstManifest);
  assert.equal(f.store.read(f.binding).sessionId, 'same-session');
  assert.deepEqual(f.store.read(f.binding).effectiveContract, f.binding.contract);
  f.finish('turn-2'); await until(() => f.store.read(f.binding).status === 'completed');
});
test('Codex native rounds receive stage evidence while retaining the full goal', async t => {
  const stage = { goal: 'review the inputs only', acceptance: 'report verified gaps; do not start later work' };
  const f = fixture(t, stage); await f.ready;
  const text = f.requests.find(x => x.method === 'turn/start').params.input[0].text;
  assert.ok(text.includes(`Goal: ${f.binding.contract.goal}`));
  assert.ok(text.includes(`Current round deliverable: ${stage.goal}`));
  assert.ok(text.includes(`Current round acceptance: ${stage.acceptance}`));
  assert.match(text, /remaining work toward the full goal/);
  f.finish('turn-1'); await until(() => f.store.read(f.binding).status === 'completed');
  assert.equal(f.store.readReview(f.binding, 1), null);
  assert.deepEqual(f.store.read(f.binding).effectiveContract, f.binding.contract);
});
test('warm native queued stage is consumed once by review and preserves foreground protection', async t => {
  const f = fixture(t); await f.ready;
  fs.mkdirSync(path.join(f.root, 'local/projects'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'local/projects/local-test.md'), `---\nid: local-test\npath: ${f.root}\nhost_id: local\ncodex_project_id: desktop-project\n---\n`);
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), '<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: local-test -->\n');
  const identity = { projectId: 'local-test', taskId: 'native-goal', ownerThreadId: 'owner' };
  const context = { controlRoot: f.root, executionRoot: f.root, ownerThreadId: 'owner', ownerTurnId: 'foreground-two' };
  const stage = { goal: 'verify the first artifact', acceptance: 'record real verification and remaining work' };
  await launchCliRequest({ schemaVersion: 1, requestId: 'warm-next', action: 'cli.queue', input: { ...identity, expectedRunNumber: 1, expectedSessionId: 'same-session', prompt: 'verify first artifact', stage } }, context);
  assert.equal(f.requests.filter(x => x.method === 'turn/start').length, 1);
  f.finish('turn-1'); await until(() => f.store.read(f.binding).status === 'completed');
  assert.equal(f.callbacks.length, 0); f.releaseForeground(); await until(() => f.callbacks.length === 1);
  const review = { schemaVersion: 1, requestId: 'warm-review', action: 'cli.review', input: { ...identity, runNumber: 1, resultSha256: sha256File(f.run.resultPath), decision: 'continue', evidenceLocator: 'fixture:first', conclusion: 'next stage remains necessary', reviewedAt: new Date().toISOString() } };
  const result = await launchCliRequest(review, context);
  assert.equal(result.continuation.runNumber, 2);
  await launchCliRequest(review, context);
  const calls = f.requests.filter(x => x.method === 'turn/start');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].params.input[0].text.includes(stage.goal));
  assert.ok(calls[1].params.input[0].text.includes(`Goal: ${f.binding.contract.goal}`));
  assert.equal(calls[1].params.threadId, 'same-session');
  assert.equal(calls[1].params.model, f.profile.model);
  f.finish('turn-2'); await until(() => f.callbacks.length === 2);
  assert.equal(f.store.read(f.binding).continuations[0].status, 'consumed');
});
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

test('warm native resume uses the run contract snapshot and manual continuation inherits it', async t => {
  const f = fixture(t); await f.ready; f.finish('turn-1');
  await until(() => f.store.read(f.binding).status === 'completed');
  const firstRunBytes = fs.readFileSync(path.join(f.store.runDir(f.binding, 1), 'run.json'));
  f.store.recordReview({ projectId: f.binding.projectId, taskId: f.binding.taskId, ownerThreadId: 'owner', runNumber: 1, resultSha256: sha256File(f.run.resultPath), decision: 'continue', evidenceLocator: 'fixture:original-review', conclusion: 'explicit user-authorized repair', reviewedAt: new Date().toISOString() });
  const contract = { goal: 'repair the reviewed function', boundaries: 'edit fixture source only; preserve tests', acceptance: 'unchanged tests pass', factEntries: ['current-facts'], skillEntries: ['task-dev'] };
  const next = f.store.beginRun(f.binding, { requestId: 'contract-update', prompt: 'implement approved repair', expectedRunNumber: 1, expectedSessionId: 'same-session', ownerTurnId: 'authorized-turn', contract, authorizationLocator: 'thread:owner/user-approved-repair' });
  await callInteractive(f.store, f.binding, 'resume', { run: next, profile: f.profile, prompt: 'implement approved repair' });
  const submitted = f.requests.filter(x => x.method === 'turn/start')[1].params.input[0].text;
  assert.ok(submitted.includes(`Boundaries: ${contract.boundaries}`));
  assert.equal(submitted.includes(`Boundaries: ${f.binding.contract.boundaries}`), false);
  assert.match(submitted, /current effective contract/i);
  f.finish('turn-2'); await until(() => f.store.read(f.binding).status === 'completed');
  f.emit({ method: 'turn/started', params: { threadId: 'same-session', turn: { id: 'typed-after-update', status: 'inProgress' } } });
  await until(() => f.store.read(f.binding).runNumber === 3);
  assert.deepEqual(f.store.readJson(path.join(f.store.runDir(f.binding, 3), 'run.json')).effectiveContract, contract);
  assert.deepEqual(fs.readFileSync(path.join(f.store.runDir(f.binding, 1), 'run.json')), firstRunBytes);
  f.finish('typed-after-update'); await until(() => f.store.read(f.binding).status === 'completed');
  assert.equal(f.store.read(f.binding).sessionId, 'same-session');
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

test('warm public resume retains the live program after its executable disappears, without probing or respawning', { timeout: 25000 }, async t => {
  const f = fixture(t, undefined, { retireCommandAfterSpawn: true }); await f.ready;
  const context = registeredContext(f), original = readInteractiveEndpoint(f.store, f.binding);
  const token = fs.readFileSync(original.tokenPath), launches = f.launches();
  assert.equal(fs.existsSync(original.command), false);
  assert.equal(original.profileSha256, digest(f.profile));
  assert.equal(Object.hasOwn(f.store.readJson(path.join(f.store.runDir(f.binding, 1), 'run.json')), 'profile'), false, 'legacy runs need not contain a profile snapshot');
  fs.renameSync(f.script, f.script + '.removed');
  for (const [number, configuredCommand] of [[2, original.command], [3, f.replacementCommand]]) {
    f.finish(`turn-${number - 1}`); await until(() => f.store.read(f.binding).status === 'completed');
    const previousResult = path.join(f.store.runDir(f.binding, number - 1), 'result.json');
    f.store.recordReview({ ...f.binding, runNumber: number - 1, resultSha256: sha256File(previousResult), decision: 'continue', evidenceLocator: 'fixture:program-retained', conclusion: 'same live session continues', reviewedAt: new Date().toISOString() });
    fs.writeFileSync(f.profilePath, JSON.stringify({ ...f.profile, runner: { ...f.profile.runner, command: configuredCommand } }));
    const profileBytes = fs.readFileSync(f.profilePath);
    const next = await launchCliRequest({ schemaVersion: 1, requestId: `retained-program-${number}`, action: 'cli.resume', input: { projectId: f.binding.projectId, taskId: f.binding.taskId, ownerThreadId: f.binding.ownerThreadId, prompt: 'continue original session', expectedRunNumber: number - 1, expectedSessionId: 'same-session' } }, context);
    const current = readInteractiveEndpoint(f.store, f.binding);
    assert.equal(next.sessionId, 'same-session'); assert.equal(next.runNumber, number);
    for (const key of ['manager', 'server', 'command', 'args', 'tokenPath', 'wsUrl', 'controlUrl', 'profileSha256', 'sessionId']) assert.deepEqual(current[key], original[key], key);
    assert.deepEqual(fs.readFileSync(current.tokenPath), token);
    assert.deepEqual(f.launches(), launches, 'warm resume must neither probe nor spawn another native executable');
    assert.deepEqual(fs.readFileSync(f.profilePath), profileBytes, 'discovery must not rewrite shared configuration');
    assert.equal(fs.existsSync(path.join(f.store.runDir(f.binding, number), 'manager-claim.json')), false);
    assert.equal(f.store.readJson(path.join(f.store.runDir(f.binding, number), 'run.json')).profile.runner.command, original.command);
    assert.equal(f.requests.filter(item => item.method === 'thread/start').length, 1);
    assert.equal(f.requests.filter(item => item.method === 'thread/resume').length, 0);
    assert.equal(f.requests.filter(item => item.method === 'turn/start').length, number);
  }
  f.finish('turn-3'); await until(() => f.store.read(f.binding).status === 'completed');
});

test('legacy live endpoint still rejects every non-command profile change before creating a run', { timeout: 25000 }, async t => {
  const f = fixture(t, undefined, { retireCommandAfterSpawn: true }); await f.ready;
  const context = registeredContext(f), original = readInteractiveEndpoint(f.store, f.binding);
  f.finish('turn-1'); await until(() => f.store.read(f.binding).status === 'completed');
  f.store.recordReview({ ...f.binding, runNumber: 1, resultSha256: sha256File(f.run.resultPath), decision: 'continue', evidenceLocator: 'fixture:legacy-profile', conclusion: 'continue only unchanged configuration', reviewedAt: new Date().toISOString() });
  const stateBytes = fs.readFileSync(f.store.locator(f.binding)), firstResult = fs.readFileSync(f.run.resultPath), launches = f.launches();
  const otherHome = path.join(f.root, 'other-home'); fs.mkdirSync(otherHome);
  const changes = [
    ['model', { ...f.profile, model: 'different' }],
    ['effort', { ...f.profile, effort: 'medium' }],
    ['home', { ...f.profile, codexHome: otherHome }],
    ['args', { ...f.profile, runner: { ...f.profile.runner, args: [...f.profile.runner.args, '--verbose'] } }],
    ['ui', { ...f.profile, ui: 'window' }],
    ['mode', { ...f.profile, mode: 'exec', ui: undefined, runner: { command: process.execPath, args: [] } }],
  ];
  for (const [name, profile] of changes) {
    fs.writeFileSync(f.profilePath, JSON.stringify(profile));
    await assert.rejects(() => launchCliRequest({ schemaVersion: 1, requestId: `reject-live-${name}`, action: 'cli.resume', input: { projectId: f.binding.projectId, taskId: f.binding.taskId, ownerThreadId: f.binding.ownerThreadId, prompt: 'do not dispatch changed configuration', expectedRunNumber: 1, expectedSessionId: 'same-session' } }, context), /profile changed|requires ui=attach/, name);
    assert.deepEqual(fs.readFileSync(f.store.locator(f.binding)), stateBytes, name);
    assert.deepEqual(fs.readFileSync(f.run.resultPath), firstResult, name);
    assert.equal(fs.existsSync(f.store.runDir(f.binding, 2)), false, name);
    assert.deepEqual(readInteractiveEndpoint(f.store, f.binding).server, original.server, name);
    assert.deepEqual(f.launches(), launches, name);
    assert.equal(f.requests.filter(item => item.method === 'turn/start').length, 1, name);
  }
});

test('cold restart selects an available program but resumes the exact session and preserves old evidence', { timeout: 25000 }, async t => {
  const f = fixture(t, undefined, { retireCommandAfterSpawn: true }); await f.ready;
  const original = readInteractiveEndpoint(f.store, f.binding);
  f.finish('turn-1'); await until(() => f.store.read(f.binding).status === 'completed');
  f.store.recordReview({ ...f.binding, runNumber: 1, resultSha256: sha256File(f.run.resultPath), decision: 'continue', evidenceLocator: 'fixture:cold-restart', conclusion: 'explicit same-session continuation', reviewedAt: new Date().toISOString() });
  f.releaseForeground(); await callInteractive(f.store, f.binding, 'detach'); await f.lifetime;
  assert.equal(readInteractiveEndpoint(f.store, f.binding), null);
  assert.equal(fs.existsSync(original.tokenPath), false);
  const firstDirectory = f.store.runDir(f.binding, 1);
  const history = new Map(fs.readdirSync(firstDirectory).filter(name => fs.statSync(path.join(firstDirectory, name)).isFile()).map(name => [name, fs.readFileSync(path.join(firstDirectory, name))]));
  const replacementScript = f.script + '.current.cjs'; fs.renameSync(f.script, replacementScript);
  fs.writeFileSync(f.profilePath, JSON.stringify({ ...f.profile, runner: { command: process.execPath, args: [replacementScript] } }));
  const profileBytes = fs.readFileSync(f.profilePath), selected = readProfile(f.profilePath);
  checkInteractiveCapability(selected);
  const next = f.store.beginRun(f.binding, { requestId: 'cold-same-session', prompt: 'continue after explicit close', expectedRunNumber: 1, expectedSessionId: 'same-session', ownerTurnId: 'foreground-two', profile: selected });
  const restarted = f.restart(next, selected); await restarted.ready;
  const endpoint = readInteractiveEndpoint(f.store, f.binding);
  assert.equal(endpoint.command, process.execPath); assert.deepEqual(endpoint.args, [replacementScript]);
  assert.notEqual(endpoint.server.pid, original.server.pid);
  assert.notEqual(endpoint.tokenPath, original.tokenPath);
  assert.equal(endpoint.sessionId, 'same-session');
  assert.equal(f.requests.filter(item => item.method === 'thread/start').length, 1, 'a replacement program must not create a replacement session');
  const resumes = f.requests.filter(item => item.method === 'thread/resume');
  assert.equal(resumes.length, 1); assert.equal(resumes[0].params.threadId, 'same-session');
  assert.equal(f.requests.filter(item => item.method === 'turn/start').length, 2);
  assert.equal(f.launches().filter(item => !item.help).length, 2);
  f.finish('turn-2'); await until(() => f.store.read(f.binding).status === 'completed');
  assert.equal(f.store.readResult(f.binding, 2).sessionId, 'same-session');
  for (const [name, bytes] of history) assert.deepEqual(fs.readFileSync(path.join(firstDirectory, name)), bytes, name);
  assert.deepEqual(fs.readFileSync(f.profilePath), profileBytes);
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
