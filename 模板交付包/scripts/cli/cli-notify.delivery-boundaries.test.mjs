import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliTaskStore, atomicJson, digest, sha256File } from './cli-task-store.mjs';
import { notifyWhenReady, notifyOnAttention, attentionPaths } from './cli-notify.mjs';
import { createDesktopHost } from './desktop-host.mjs';
import { currentProcessIdentity } from './process-identity.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(10);
  }
}

// The production Desktop host still performs locking, foreground observation,
// pre-send validation and handoff. Only its platform MCP peer is replaced.
// This peer cannot reach the real Desktop transport or any native model.
const mockMcp = `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const base = process.env.BEYOND_TEST_TRANSPORT_ROOT;
const routes = JSON.parse(fs.readFileSync(path.join(base, 'routes.json'), 'utf8'));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return reply(message.id, { protocolVersion: '2024-11-05', capabilities: {} });
  if (message.method === 'tools/list') return reply(message.id, { tools: [{ name: 'send_message_to_thread',
    inputSchema: { type: 'object', required: ['threadId', 'prompt'], properties: { threadId: { type: 'string' }, prompt: { type: 'string' } } } }] });
  if (message.method !== 'tools/call' || message.params.name !== 'send_message_to_thread') throw new Error('unexpected fixture request');
  const args = message.params.arguments, source = routes[args.threadId];
  if (!source) throw new Error('unknown fixture owner');
  const records = fs.readFileSync(source, 'utf8').trim().split('\\n').map(JSON.parse);
  const current = records.filter(row => row.type === 'event_msg' && row.payload.type === 'task_started').at(-1).payload.turn_id;
  const idle = records.some(row => row.type === 'event_msg' && row.payload.turn_id === current
    && ['task_complete', 'turn_aborted'].includes(row.payload.type));
  const turnId = 'notification-' + require('node:crypto').randomUUID();
  fs.appendFileSync(path.join(base, 'sent.jsonl'), JSON.stringify({ ...args, idleBeforeSend: idle, turnId }) + '\\n');
  fs.appendFileSync(source, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }) + '\\n');
  reply(message.id, { isError: false, content: [{ type: 'text', text: 'fixture accepted' }] });
});
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-notify-boundary-'));
  const controlRoot = path.join(root, 'control'), home = path.join(root, 'home'), transport = path.join(root, 'transport');
  for (const directory of [controlRoot, home, transport]) fs.mkdirSync(directory);
  const pluginRoot = path.join(root, 'plugins'), plugin = path.join(pluginRoot, 'codex-app-tools', '1.0.0');
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
  atomicJson(path.join(plugin, '.codex-plugin/plugin.json'), { name: 'codex-app-tools', version: '1.0.0', mcpServers: 'mcp.json' });
  const mcpPath = path.join(plugin, 'mock.cjs'); fs.writeFileSync(mcpPath, mockMcp);
  atomicJson(path.join(plugin, 'mcp.json'), { mcpServers: { codex_app: { command: process.execPath, args: [mcpPath],
    env: { BEYOND_TEST_TRANSPORT_ROOT: transport }, cwd: plugin } } });
  atomicJson(path.join(transport, 'routes.json'), {});
  fs.writeFileSync(path.join(transport, 'sent.jsonl'), '');
  const store = new CliTaskStore({ controlRoot }), sources = new Map(), ownedLocks = new Set();
  const append = (owner, type, turn) => fs.appendFileSync(sources.get(owner), JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turn } }) + '\n');
  const currentTurn = owner => JSON.parse(fs.readFileSync(sources.get(owner), 'utf8').trim().split('\n').filter(line => JSON.parse(line).payload?.type === 'task_started').at(-1)).payload.turn_id;
  const end = owner => append(owner, 'task_complete', currentTurn(owner));
  const begin = owner => { const turn = 'foreground-' + crypto.randomUUID(); append(owner, 'task_started', turn); return turn; };
  function host(owner, busy = false) {
    if (!sources.has(owner)) {
      const file = path.join(transport, owner + '.jsonl'); sources.set(owner, file);
      fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: owner } }) + '\n');
      begin(owner); if (!busy) end(owner);
      atomicJson(path.join(transport, 'routes.json'), Object.fromEntries(sources));
      const canonical = fs.realpathSync(home);
      const key = crypto.createHash('sha256').update(JSON.stringify([process.platform === 'win32' ? canonical.toLowerCase() : canonical, owner])).digest('hex');
      ownedLocks.add(path.join(os.tmpdir(), `beyond-cli-send-${key}.lock`));
    }
    return createDesktopHost({ env: { ...process.env, CODEX_HOME: home, CODEX_THREAD_ID: owner, CODEX_APP_TOOLS_PIPE_PATH: 'fixture-not-a-live-pipe' },
      pluginRoot, sourceRecordPath: sources.get(owner), handoffTimeoutMs: 10000 });
  }
  function task(taskId, owner = 'module-owner', { running = false } = {}) {
    host(owner);
    const binding = { projectId: 'isolated-team', taskId, ownerThreadId: owner, ownerTurnId: currentTurn(owner), taskMode: 'assist',
      executionRoot: controlRoot, profilePath: path.join(root, 'isolated-profile.json'),
      contract: { goal: 'approved small complete result', boundaries: 'fixture only; no business changes or model launch',
        acceptance: 'real fixture consumer observes the agreed result', factEntries: [], skillEntries: [] } };
    store.create(binding);
    const run = store.beginRun(binding, { requestId: 'request-one', prompt: 'approved fixture instruction', expectedRunNumber: 0,
      expectedSessionId: null, stage: { goal: 'current approved stage', acceptance: 'stage evidence matches the consumer contract' } });
    const sessionId = 'native-' + crypto.randomUUID(); store.bindSession(run, sessionId);
    if (running) store.setProcess(run, { ...currentProcessIdentity(), token: crypto.randomUUID() });
    else store.finishRun(run, { status: 'completed', finalText: 'actual fixture result, not business acceptance' });
    return { binding, run, sessionId };
  }
  const messages = () => fs.readFileSync(path.join(transport, 'sent.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  t.after(() => {
    // Tests only remove their own exact fixture root and empty send gate proofs.
    assert.equal(path.dirname(fs.realpathSync(root)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('beyond-notify-boundary-'));
    for (const lock of ownedLocks) {
      assert.equal(fs.existsSync(lock), false, 'production host must release the owner send lock');
      assert.equal(fs.existsSync(`${lock}.handoff.json`), false, 'production host must close the handoff proof');
    }
    fs.rmSync(root, { recursive: true });
  });
  return { root, store, host, task, begin, end, messages };
}

function attention(f, task, itemId = 'question-one') {
  const spec = { code: 'question-awaiting-answer', itemId }, paths = attentionPaths(f.store, task.run, spec);
  atomicJson(paths.evidencePath, { projectId: task.run.projectId, taskId: task.run.taskId, ownerThreadId: task.run.ownerThreadId,
    runNumber: task.run.runNumber, requestId: task.run.requestId, sessionId: task.sessionId, ...spec });
  return { spec, ...paths };
}
function review(f, task, decision = 'pause') {
  return f.store.recordReview({ projectId: task.run.projectId, taskId: task.run.taskId, ownerThreadId: task.run.ownerThreadId,
    runNumber: task.run.runNumber, resultSha256: sha256File(task.run.resultPath), decision, evidenceLocator: 'fixture:verified-evidence',
    conclusion: decision === 'pause' ? 'user requested pause; no business resume' : 'fixture review', reviewedAt: new Date().toISOString() });
}
function transfer(f, task, targetOwner = 'successor') {
  const state = f.store.read(task.binding);
  return { operationId: 'explicit-owner-transfer', projectId: task.run.projectId, taskId: task.run.taskId, taskMode: 'assist',
    fromOwnerThreadId: task.run.ownerThreadId, toOwnerThreadId: targetOwner, expectedSessionId: task.sessionId, expectedRunNumber: 1,
    expectedStateSha256: digest(state), expectedResultSha256: sha256File(task.run.resultPath), authorizationLocator: 'fixture:human-approved-transfer' };
}

test('simultaneous results for different owners stay direct and do not broadcast', { timeout: 20000 }, async t => {
  const f = fixture(t), a = f.task('frontend-result', 'front-owner'), b = f.task('backend-result', 'back-owner');
  const before = [a, b].map(task => ({ state: f.store.read(task.binding), result: sha256File(task.run.resultPath) }));
  const outcomes = await Promise.all([a, b].map(task => notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host: f.host(task.run.ownerThreadId) })));
  assert.deepEqual(outcomes.map(item => item.status), ['delivered', 'delivered']);
  const sent = f.messages(); assert.equal(sent.length, 2);
  assert.deepEqual(new Set(sent.map(item => item.threadId)), new Set(['front-owner', 'back-owner']));
  for (const [index, task] of [a, b].entries()) {
    const message = sent.find(item => item.threadId === task.run.ownerThreadId);
    assert.ok(message.prompt.includes(`taskId=${task.run.taskId}`)); assert.ok(message.idleBeforeSend);
    assert.deepEqual(f.store.read(task.binding), before[index].state);
    assert.equal(sha256File(task.run.resultPath), before[index].result);
  }
});

test('same-owner simultaneous results are serialized and cannot interrupt the first notification turn', { timeout: 25000 }, async t => {
  const f = fixture(t), a = f.task('result-a'), b = f.task('result-b'), host = f.host('module-owner');
  const jobs = [a, b].map(task => notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host }));
  await until(() => f.messages().length === 1, 'first result not delivered');
  await delay(250); assert.equal(f.messages().length, 1);
  f.end('module-owner');
  const outcomes = await Promise.all(jobs);
  assert.deepEqual(outcomes.map(item => item.status), ['delivered', 'delivered']);
  assert.equal(f.messages().length, 2);
  assert.ok(f.messages().every(item => item.threadId === 'module-owner' && item.idleBeforeSend));
  assert.ok(f.messages().some(item => item.prompt.includes('taskId=result-a')));
  assert.ok(f.messages().some(item => item.prompt.includes('taskId=result-b')));
});

test('a new foreground turn is respected even when the original dispatch turn has ended', { timeout: 20000 }, async t => {
  const f = fixture(t), task = f.task('new-foreground'), host = f.host('module-owner');
  f.begin('module-owner');
  const job = notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host });
  await delay(250); assert.equal(f.messages().length, 0);
  f.end('module-owner');
  assert.equal((await job).status, 'delivered');
  assert.equal(f.messages().length, 1); assert.ok(f.messages()[0].idleBeforeSend);
});

test('duplicate result callbacks deliver only once and preserve the native session and actual result', { timeout: 20000 }, async t => {
  const f = fixture(t), task = f.task('duplicate'), host = f.host('module-owner'), before = sha256File(task.run.resultPath);
  const outcomes = await Promise.all([1, 2, 3].map(() => notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host })));
  assert.equal(outcomes.filter(item => item.status === 'delivered').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'duplicate-suppressed').length, 2);
  assert.equal(f.messages().length, 1); assert.equal(sha256File(task.run.resultPath), before);
  assert.equal(f.store.read(task.binding).sessionId, task.sessionId); assert.equal(f.store.read(task.binding).runNumber, 1);
});

test('a result already reviewed during the foreground wait does not wake its owner again', { timeout: 20000 }, async t => {
  const f = fixture(t), task = f.task('reviewed'), host = f.host('module-owner'); f.begin('module-owner');
  const job = notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host });
  await delay(150); review(f, task, 'accept'); f.end('module-owner');
  assert.equal((await job).status, 'unavailable'); assert.equal(f.messages().length, 0);
  assert.equal(f.store.readReview(task.binding, 1).decision, 'accept');
});

test('a superseded result cannot wake the owner after a new authorized run has started', { timeout: 20000 }, async t => {
  const f = fixture(t), task = f.task('superseded'), host = f.host('module-owner'); f.begin('module-owner');
  const job = notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host });
  await delay(150); review(f, task, 'continue');
  f.store.beginRun(task.binding, { requestId: 'request-two', prompt: 'explicitly approved next fixture stage', expectedRunNumber: 1, expectedSessionId: task.sessionId });
  f.end('module-owner');
  assert.equal((await job).status, 'unavailable'); assert.equal(f.messages().length, 0);
  assert.equal(f.store.read(task.binding).runNumber, 2); assert.equal(f.store.readResult(task.binding, 1).sessionId, task.sessionId);
});

test('authorized owner transfer in progress suppresses late delivery to the outgoing owner', { timeout: 20000 }, async t => {
  const f = fixture(t), task = f.task('transfer-pending'), host = f.host('module-owner'); f.begin('module-owner');
  const job = notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host });
  await delay(150);
  const input = transfer(f, task); f.store.beginTransfer(task.binding, input);
  f.end('module-owner');
  assert.equal((await job).status, 'unavailable');
  assert.equal(f.messages().length, 0, 'the pending transfer must not invite the outgoing owner to continue');
  assert.equal(f.store.read(task.binding).sessionId, task.sessionId);
  assert.equal(f.store.readJson(path.join(f.store.transferDirectory(task.binding, input.operationId), 'transfer.json')).phase, 'authorized');
});

test('completed transfer does not redirect a historical callback to either owner', async t => {
  const f = fixture(t), task = f.task('transfer-completed'), originalResult = sha256File(task.run.resultPath);
  const input = transfer(f, task);
  f.store.beginTransfer(task.binding, input); f.store.applyTransfer(input); f.store.completeTransfer(input);
  await assert.rejects(notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host: f.host('module-owner') }), /identity mismatch/);
  await assert.rejects(notifyWhenReady({ store: f.store, identity: { ...task.run, ownerThreadId: 'successor' }, runNumber: 1, host: f.host('successor') }), /Historical CLI notification/);
  assert.equal(f.messages().length, 0); assert.equal(sha256File(task.run.resultPath), originalResult);
  assert.equal(f.store.read({ ...task.binding, ownerThreadId: 'successor' }).sessionId, task.sessionId);
});

test('recovered attention is suppressed after waiting without consuming the eventual result', { timeout: 20000 }, async t => {
  const f = fixture(t), task = f.task('recovered-question', 'module-owner', { running: true }), host = f.host('module-owner');
  f.begin('module-owner'); const evidence = attention(f, task);
  const job = notifyOnAttention({ store: f.store, run: task.run, host, attention: evidence.spec });
  await tick();
  atomicJson(evidence.evidencePath, { ...f.store.readJson(evidence.evidencePath), recoveredAt: new Date().toISOString() });
  f.end('module-owner');
  assert.equal((await job).status, 'unavailable'); assert.equal(f.messages().length, 0);
  f.store.finishRun(task.run, { status: 'completed', finalText: 'question resolved; actual fixture result' });
  assert.equal((await notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host })).status, 'delivered');
  assert.equal(f.messages().length, 1); assert.match(f.messages()[0].prompt, /CLI_RESULT_READY/);
});

test('an authorized stop suppresses stale attention but retains the stopped result for owner review', { timeout: 20000 }, async t => {
  const f = fixture(t), task = f.task('stopped-question', 'module-owner', { running: true }), host = f.host('module-owner');
  f.begin('module-owner'); const evidence = attention(f, task), before = sha256File(evidence.evidencePath);
  const job = notifyOnAttention({ store: f.store, run: task.run, host, attention: evidence.spec });
  await tick();
  f.store.requestStop(task.binding, { stateSha256: digest(f.store.read(task.binding)), expectedSessionId: task.sessionId, reason: 'human-authorized fixture pause', requestId: 'stop-fixture' });
  f.end('module-owner'); assert.equal((await job).status, 'unavailable'); assert.equal(f.messages().length, 0);
  f.store.finishRun(task.run, { status: 'stopped', finalText: 'preserved progress, not completed business' });
  const state = f.store.read(task.binding);
  assert.equal((await notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host })).status, 'delivered');
  assert.deepEqual(f.store.read(task.binding), state); assert.equal(f.store.readReview(task.binding, 1), null);
  assert.equal(sha256File(evidence.evidencePath), before);
  assert.match(f.messages()[0].prompt, /status=stopped/);
});

test('an unresolved question returns only to its original owner once, without launching or answering anything', { timeout: 20000 }, async t => {
  const f = fixture(t), task = f.task('open-question', 'module-owner', { running: true }), host = f.host('module-owner');
  const evidence = attention(f, task), state = f.store.read(task.binding);
  const outcomes = await Promise.all([1, 2].map(() => notifyOnAttention({ store: f.store, run: task.run, host, attention: evidence.spec })));
  assert.equal(outcomes.filter(item => item.status === 'delivered').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'suppressed').length, 1);
  assert.equal(f.messages().length, 1); assert.equal(f.messages()[0].threadId, task.binding.ownerThreadId);
  assert.match(f.messages()[0].prompt, /CLI_ATTENTION_REQUIRED/);
  assert.deepEqual(f.store.read(task.binding), state); assert.equal(fs.existsSync(task.run.resultPath), false);
  assert.equal(f.store.readJson(evidence.evidencePath).recoveredAt, undefined);
});

test('paused review and latest queued requirements are not replaced or automatically executed by notification', { timeout: 20000 }, async t => {
  const f = fixture(t), paused = f.task('paused'), newer = f.task('new-requirement', 'other-owner');
  review(f, paused, 'pause');
  f.store.queueContinuation(newer.binding, { requestId: 'approved-next', prompt: 'current human-approved changed requirement',
    stage: { goal: 'revised small goal', acceptance: 'current business checkpoint' }, expectedRunNumber: 1,
    expectedSessionId: newer.sessionId, ownerTurnId: newer.binding.ownerTurnId });
  const before = f.store.read(newer.binding);
  const outcomes = await Promise.all([paused, newer].map(task => notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host: f.host(task.run.ownerThreadId) })));
  assert.deepEqual(outcomes.map(value => value.status), ['unavailable', 'delivered']);
  assert.deepEqual(f.store.read(newer.binding), before);
  assert.equal(f.store.readContinuation(newer.binding, 1).status, 'pending');
  assert.equal(f.messages().length, 1); assert.equal(f.messages()[0].threadId, 'other-owner');
  assert.match(f.messages()[0].prompt, /暂停|检查点/);
  assert.doesNotMatch(f.messages()[0].prompt, /目标未满足时纠正并续跑同一会话/);
});

test('unattended unavailable transport preserves final evidence without replaying business or claiming delivery', async t => {
  const f = fixture(t), task = f.task('unavailable'), original = sha256File(task.run.resultPath), before = f.store.read(task.binding);
  const host = { waitForSourceTurnEnd: async () => {}, checkCapability: async () => ({ available: false, reason: 'fixture Desktop closed' }),
    send: async () => { throw new Error('must not attempt unavailable transport'); } };
  const outcome = await notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host });
  assert.equal(outcome.status, 'unavailable'); assert.equal(outcome.sentAt, undefined);
  assert.equal(sha256File(task.run.resultPath), original); assert.deepEqual(f.store.read(task.binding), before);
  assert.equal(f.store.readJson(outcome.markerPath).status, 'unavailable'); assert.equal(f.messages().length, 0);
});

test('failed and unknown results reach only the direct owner without becoming accepted or automatically rerun', { timeout: 20000 }, async t => {
  const f = fixture(t), tasks = ['failed', 'unknown'].map(status => {
    const task = f.task(`${status}-result`, `${status}-owner`, { running: true });
    f.store.finishRun(task.run, { status, finalText: 'preserved partial work', error: `isolated ${status} evidence` });
    return task;
  });
  const before = tasks.map(task => ({ state: f.store.read(task.binding), result: sha256File(task.run.resultPath) }));
  const outcomes = await Promise.all(tasks.map(task => notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host: f.host(task.run.ownerThreadId) })));
  assert.ok(outcomes.every(value => value.status === 'delivered')); assert.equal(f.messages().length, 2);
  for (const [index, task] of tasks.entries()) {
    const message = f.messages().find(value => value.threadId === task.run.ownerThreadId);
    assert.ok(message.prompt.includes(`taskId=${task.run.taskId}`));
    assert.ok(message.prompt.includes(`status=${before[index].state.status}`));
    assert.deepEqual(f.store.read(task.binding), before[index].state);
    assert.equal(sha256File(task.run.resultPath), before[index].result);
    assert.equal(f.store.readReview(task.binding, 1), null);
    assert.equal(f.store.readContinuation(task.binding, 1), null);
  }
});

test('ordinary progress and acknowledgements cannot be promoted to actionable attention', async t => {
  const f = fixture(t), task = f.task('routine-events', 'module-owner', { running: true }), before = f.store.read(task.binding);
  const directory = f.store.runDir(task.run, 1), entries = fs.readdirSync(directory).sort();
  for (const code of ['progress', 'ack', 'acknowledged', 'heartbeat', 'peer-suggestion']) {
    await assert.rejects(notifyOnAttention({ store: f.store, run: task.run, host: f.host('module-owner'), attention: { code, itemId: 'routine-event' } }), /Invalid CLI attention identity/);
  }
  assert.equal(f.messages().length, 0); assert.deepEqual(f.store.read(task.binding), before);
  assert.deepEqual(fs.readdirSync(directory).sort(), entries);
});

test('uncertain transport delivery is not retried or treated as business action', async t => {
  const f = fixture(t), task = f.task('uncertain-delivery'), original = sha256File(task.run.resultPath), before = f.store.read(task.binding);
  let attempts = 0;
  const host = { waitForSourceTurnEnd: async () => {}, checkCapability: async () => ({ available: true }),
    send: async input => { assert.equal(input.ownerThreadId, task.run.ownerThreadId); assert.equal(input.beforeSend(), true); attempts += 1; return { status: 'delivery-unknown', error: 'fixture lost reply after possible submission' }; } };
  const first = await notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host });
  assert.equal(first.status, 'delivery-unknown'); assert.equal(f.store.readJson(first.markerPath).status, 'delivery-unknown');
  const second = await notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host });
  assert.equal(second.status, 'duplicate-suppressed'); assert.equal(attempts, 1);
  assert.equal(sha256File(task.run.resultPath), original); assert.deepEqual(f.store.read(task.binding), before);
  assert.equal(f.store.readReview(task.binding, 1), null);
});

test('transfer completed during an original notification wait closes only that obsolete notification claim', async t => {
  const f = fixture(t), task = f.task('transfer-during-wait'), original = sha256File(task.run.resultPath);
  let release; const sourceEnd = new Promise(resolve => { release = resolve; });
  const job = notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host: f.host('module-owner'), sourceEnd });
  const input = transfer(f, task);
  f.store.beginTransfer(task.binding, input); f.store.applyTransfer(input); f.store.completeTransfer(input);
  const successor = { ...task.binding, ownerThreadId: 'successor' }, state = f.store.read(successor);
  release();
  const outcome = await job;
  assert.equal(outcome.status, 'unavailable'); assert.equal(f.messages().length, 0);
  assert.equal(f.store.readJson(outcome.markerPath).status, 'unavailable');
  assert.equal(outcome.supersededByOwnerTransfer, input.operationId);
  assert.deepEqual(outcome.preservedResult, { ownerThreadId: 'successor', runNumber: 1, resultPath: task.run.resultPath, sha256: original, pendingReview: true });
  assert.deepEqual(f.store.read(successor), state); assert.equal(sha256File(task.run.resultPath), original);
  assert.equal(f.store.readReview(successor, 1), null); assert.equal(f.store.readContinuation(successor, 1), null);
  // The successor can consume the exact preserved result through the existing
  // review path. Finishing the obsolete send claim must not consume acceptance.
  f.store.recordReview({ projectId: successor.projectId, taskId: successor.taskId, ownerThreadId: successor.ownerThreadId,
    runNumber: 1, resultSha256: original, decision: 'pause', evidenceLocator: 'fixture:successor-read-original-result',
    conclusion: 'result inspected; business stays paused', reviewedAt: new Date().toISOString() });
  assert.equal(f.store.readReview(successor, 1).decision, 'pause');
  assert.equal(sha256File(task.run.resultPath), original); assert.equal(f.messages().length, 0);
});

test('transfer-claim finalization rejects a changed original result even when a later transfer recorded its new hash', async t => {
  const f = fixture(t), task = f.task('changed-result');
  let release; const sourceEnd = new Promise(resolve => { release = resolve; });
  const job = notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host: f.host('module-owner'), sourceEnd });
  const markerPath = path.join(f.store.runDir(task.run, 1), 'notification.json'), markerBefore = sha256File(markerPath);
  atomicJson(task.run.resultPath, { ...f.store.readResult(task.binding, 1), finalText: 'externally changed original evidence' });
  const input = transfer(f, task);
  f.store.beginTransfer(task.binding, input); f.store.applyTransfer(input); f.store.completeTransfer(input);
  const successor = { ...task.binding, ownerThreadId: 'successor' }, before = f.store.read(successor), changed = sha256File(task.run.resultPath);
  release();
  await assert.rejects(job, /notification transfer proof mismatch/);
  assert.equal(f.messages().length, 0); assert.equal(sha256File(markerPath), markerBefore);
  assert.deepEqual(f.store.read(successor), before); assert.equal(sha256File(task.run.resultPath), changed);
});

test('transfer-claim finalization rejects an owner changed outside the verified handoff', async t => {
  const f = fixture(t), task = f.task('forged-owner'), original = sha256File(task.run.resultPath);
  let release; const sourceEnd = new Promise(resolve => { release = resolve; });
  const job = notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host: f.host('module-owner'), sourceEnd });
  const markerPath = path.join(f.store.runDir(task.run, 1), 'notification.json'), markerBefore = sha256File(markerPath);
  const input = transfer(f, task);
  f.store.beginTransfer(task.binding, input); f.store.applyTransfer(input); f.store.completeTransfer(input);
  const successor = { ...task.binding, ownerThreadId: 'successor' };
  atomicJson(f.store.locator(successor), { ...f.store.read(successor), ownerThreadId: 'unverified-owner' });
  const changed = sha256File(f.store.locator(successor));
  release();
  await assert.rejects(job, /identity mismatch|ownership conflict/);
  assert.equal(f.messages().length, 0); assert.equal(sha256File(markerPath), markerBefore);
  assert.equal(sha256File(f.store.locator(successor)), changed); assert.equal(sha256File(task.run.resultPath), original);
});

test('transfer-claim finalization rejects changed claim evidence instead of replacing someone else notification state', async t => {
  const f = fixture(t), task = f.task('changed-claim');
  let release; const sourceEnd = new Promise(resolve => { release = resolve; });
  const job = notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host: f.host('module-owner'), sourceEnd });
  const markerPath = path.join(f.store.runDir(task.run, 1), 'notification.json');
  const input = transfer(f, task);
  f.store.beginTransfer(task.binding, input); f.store.applyTransfer(input); f.store.completeTransfer(input);
  atomicJson(markerPath, { ...f.store.readJson(markerPath), observedBy: 'another-recovery-operation' });
  const changed = sha256File(markerPath);
  release();
  await assert.rejects(job, /notification transfer evidence changed/);
  assert.equal(f.messages().length, 0); assert.equal(sha256File(markerPath), changed);
});

test('successor review or authorized resume before the old wait ends does not leave the old claim live or disturb new work', async t => {
  const f = fixture(t);
  for (const decision of ['accept', 'continue']) {
    const task = f.task(`successor-${decision}`, `${decision}-original-owner`), original = sha256File(task.run.resultPath);
    let release; const sourceEnd = new Promise(resolve => { release = resolve; });
    const job = notifyWhenReady({ store: f.store, identity: task.run, runNumber: 1, host: f.host(task.run.ownerThreadId), sourceEnd });
    const input = transfer(f, task, `${decision}-successor`);
    f.store.beginTransfer(task.binding, input); f.store.applyTransfer(input); f.store.completeTransfer(input);
    const successor = { ...task.binding, ownerThreadId: input.toOwnerThreadId };
    f.store.recordReview({ projectId: successor.projectId, taskId: successor.taskId, ownerThreadId: successor.ownerThreadId,
      runNumber: 1, resultSha256: original, decision, evidenceLocator: 'fixture:successor-current-review',
      conclusion: 'explicit fixture successor decision', reviewedAt: new Date().toISOString() });
    if (decision === 'continue') f.store.beginRun(successor, { requestId: 'successor-approved-continuation', prompt: 'authorized fixture correction',
      expectedRunNumber: 1, expectedSessionId: task.sessionId });
    const before = f.store.read(successor), reviewBefore = f.store.readReview(successor, 1);
    release();
    const outcome = await job;
    assert.equal(outcome.status, 'unavailable'); assert.equal(f.store.readJson(outcome.markerPath).status, 'unavailable');
    assert.equal(outcome.preservedResult.pendingReview, false);
    assert.deepEqual(f.store.read(successor), before); assert.deepEqual(f.store.readReview(successor, 1), reviewBefore);
    assert.equal(sha256File(task.run.resultPath), original);
  }
  assert.equal(f.messages().length, 0);
});
