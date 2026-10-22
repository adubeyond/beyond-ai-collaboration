import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliTaskStore, atomicJson, digest } from './cli-task-store.mjs';
import { currentProcessIdentity } from './process-identity.mjs';
import { createClaudeSession, watchClaudeFailures } from './claude-client.mjs';
import { runVisibleCli } from './visible-cli-runner.mjs';
import { attentionPaths, notifyOnAttention } from './cli-notify.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'isolated waiting-attention condition', timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(10);
  }
}
function cleanup(root) {
  const actual = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
  assert.ok(path.basename(actual).startsWith('beyond-claude-waiting-'));
  fs.rmSync(actual, { recursive: true });
}

// Real production transcript watcher, local HTTP manager, task store and notifier.
// Only the native model and desktop-message destination are fixtures: no API,
// live user session, approval choice or business operation is used by this test.
function fixture(t, { loseBlockedReply = false, failBlockedPost = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-claude-waiting-'));
  const profile = { schemaVersion: 1, provider: 'claude', mode: 'interactive', ui: 'window', model: 'isolated-model', permissionMode: 'auto', runner: { command: process.execPath, args: [] } };
  const profilePath = path.join(root, 'profile.json'); atomicJson(profilePath, profile);
  const binding = { projectId: 'local-waiting', taskId: 'waiting-owner-review', ownerThreadId: 'original-owner', ownerTurnId: 'foreground', taskMode: 'assist', executionRoot: root, profilePath,
    contract: { goal: 'report explicit native waiting to original owner', boundaries: 'fixture only; do not answer or approve', acceptance: 'original session resumes after an explicit fixture answer', factEntries: [], skillEntries: [] } };
  const store = new CliTaskStore({ controlRoot: root }); store.create(binding);
  const run = store.beginRun(binding, { requestId: 'original-request', prompt: 'approved isolated instruction', expectedRunNumber: 0, expectedSessionId: null });
  const managerIdentity = { ...currentProcessIdentity(), token: crypto.randomUUID() }; store.setProcess(run, managerIdentity);
  const sessionId = crypto.randomUUID(), transcriptPath = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, '');
  const transport = { pipe: '\\\\.\\pipe\\isolated-waiting', token: crypto.randomUUID() };
  const callbacks = [], submissions = [], commandsSeen = [], posted = [], observers = [], diagnostics = [];
  const abort = new AbortController();
  let releaseForeground, native, attached, commands, closing, deliveryError, blockedReplyLost = false, blockedPostFailed = false;
  const foreground = new Promise(resolve => { releaseForeground = resolve; });
  const host = {
    currentSource: () => ({ ownerThreadId: binding.ownerThreadId, ownerTurnId: binding.ownerTurnId }),
    waitForSourceTurnEnd: () => foreground,
    checkCapability: async () => ({ available: true }),
    send: async value => {
      if (value.beforeSend && !value.beforeSend()) return { status: 'unavailable' };
      callbacks.push(value); return { status: 'delivered' };
    },
  };
  const endpoint = () => store.readJson(path.join(store.taskDir(binding), 'interactive.json'));
  const hook = (event, extra = {}) => native.hook({ session_id: sessionId, hook_event_name: event, ...extra }, transport);
  async function post(route, data) {
    posted.push({ route, data });
    if (route === '/attention' && data.status === 'blocked' && failBlockedPost && !blockedPostFailed) {
      blockedPostFailed = true; throw new Error('fixture transport unavailable before manager persistence');
    }
    const ep = endpoint();
    const response = await fetch(new URL(route, ep.controlUrl), { method: 'POST', headers: { authorization: 'Bearer ' + fs.readFileSync(ep.tokenPath, 'utf8'), 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error);
    if (route === '/attention' && data.status === 'blocked' && loseBlockedReply && !blockedReplyLost) {
      blockedReplyLost = true; throw new Error('fixture lost HTTP response after manager persistence');
    }
    return body;
  }
  function close() {
    return closing ??= (async () => {
      await attached; await native.nativeEnded();
      const ep = endpoint(); atomicJson(ep.viewExitPath, { launchId: ep.launchId, exitCode: 0 }); abort.abort();
    })();
  }
  const lifetime = runVisibleCli({ binding, run, profile, prompt: 'approved isolated instruction', store, managerIdentity, host, openWindow() {
    store.setChildProcess(run, managerIdentity);
    native = createClaudeSession({ sessionId, model: profile.model, cwd: root, pid: process.pid, post, terminate: () => { void close(); }, diagnose: item => diagnostics.push(item),
      observeFailures(options) { const observer = watchClaudeFailures(options); observers.push(observer); return observer; },
      deliver: async (_pipe, prompt) => { assert.deepEqual(await hook('UserPromptSubmit', { prompt }), {}); submissions.push(prompt); },
    });
    attached = hook('SessionStart', { cwd: root, model: profile.model, transcript_path: transcriptPath });
    commands = (async () => {
      await attached;
      while (!abort.signal.aborted) {
        const ep = endpoint(), response = await fetch(ep.controlUrl + 'command', { headers: { authorization: 'Bearer ' + fs.readFileSync(ep.tokenPath, 'utf8') }, signal: abort.signal });
        if (!response.ok) break;
        const command = await response.json(); commandsSeen.push(command); await native.command(command);
      }
    })().catch(error => { if (!abort.signal.aborted) deliveryError = error; });
    return { windowPid: process.pid, transport: 'isolated-native-fixture' };
  } });
  t.after(async () => { releaseForeground(); await close(); await lifetime; await commands; cleanup(root); });
  const row = value => ({ sessionId, cwd: root, isSidechain: false, ...value });
  const append = values => fs.appendFileSync(transcriptPath, values.map(value => JSON.stringify(row(value))).join('\n') + '\n');
  const flush = async () => { await observers.at(-1)?.flush(); };
  const paths = (itemId, code = 'question-awaiting-answer') => attentionPaths(store, run, { itemId, code });
  const evidence = (itemId, code) => store.readJson(paths(itemId, code).evidencePath);
  const marker = (itemId, code) => store.readJson(paths(itemId, code).markerPath);
  const finish = (text = 'same original native session completed') => hook('Stop', { last_assistant_message: text, background_tasks: [], session_crons: [] });
  const start = async () => { await attached; await until(() => submissions.length === 1 || deliveryError); assert.ifError(deliveryError); };
  return { root, profile, binding, store, run, sessionId, transcriptPath, host, endpoint, callbacks, submissions, commandsSeen, posted, diagnostics, row, append, flush, paths, evidence, marker, start, finish, releaseForeground, post };
}

// Sanitized shape of the native records observed in the affected run. Business
// hosts, certificate decisions and credentials are intentionally absent.
const question = (id, text = 'Which already-approved fixture option applies?') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: text, header: 'Fixture', options: [{ label: 'Inspect', description: 'Read-only investigation' }, { label: 'Report', description: 'Report facts only' }], multiSelect: false }] } }] } });
const answer = (id, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: is_error ? 'Question dismissed by fixture owner' : 'Fixture owner supplied a verified answer' }] } });
function toolRows(id, { tool = 'PowerShell', command = 'fixture read-only operation', success = false, kind = 'automode-blocked' } = {}) {
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input: { command } }] } },
    { type: 'user', classifierBoundary: !success, toolDenialKind: kind, permissionDecision: { decision: 'reject', source: 'config', reasonType: 'classifier' },
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !success, content: success ? 'fixture succeeded' : 'Permission denied for this operation' }] } },
  ];
}
function assertUnchangedRun(f, before) {
  assert.deepEqual(f.store.read(f.binding), before);
  assert.equal(f.endpoint().status, 'running');
  assert.equal(fs.existsSync(f.run.resultPath), false);
  assert.equal(fs.existsSync(path.join(f.store.runDir(f.binding, 1), 'review.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'local/runtime/worker-results')), false);
  assert.equal(f.commandsSeen.length, 1); assert.equal(f.commandsSeen[0].action, 'submit');
  assert.equal(f.submissions.length, 1);
  assert.equal(f.store.readJson(f.binding.profilePath).permissionMode, 'auto');
}

test('one question alerts its original owner after foreground, and a second question in the same run is not lost', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start(); const before = f.store.read(f.binding);
  f.append([question('question-one')]); await f.flush();
  assert.equal(f.evidence('question-one').itemId, 'question-one'); assert.equal(f.callbacks.length, 0);
  f.append([answer('different-question'), { ...answer('question-one'), sessionId: 'other-session' }, { ...answer('question-one'), isSidechain: true }]); await f.flush();
  assert.equal(f.evidence('question-one').recoveredAt, undefined);
  assertUnchangedRun(f, before);
  f.releaseForeground(); await until(() => f.callbacks.length === 1);
  assert.equal(f.callbacks[0].ownerThreadId, f.binding.ownerThreadId); assert.match(f.callbacks[0].prompt, /CLI_ATTENTION_REQUIRED/);
  f.append([question('question-one'), question('question-one')]); await f.flush(); assert.equal(f.callbacks.length, 1);
  const duplicate = await notifyOnAttention({ store: f.store, run: f.run, host: f.host, attention: { code: 'question-awaiting-answer', itemId: 'question-one' } });
  assert.equal(duplicate.status, 'suppressed');
  f.append([answer('question-one'), question('question-two')]); await f.flush(); await until(() => f.callbacks.length === 2);
  assert.ok(f.evidence('question-one').recoveredAt); assert.equal(f.evidence('question-two').recoveredAt, undefined);
  assert.notEqual(f.paths('question-one').markerPath, f.paths('question-two').markerPath);
  assertUnchangedRun(f, before);
  f.append([answer('question-two')]); await f.flush(); await f.finish(); await until(() => f.callbacks.length === 3);
  assert.match(f.callbacks[2].prompt, /CLI_RESULT_READY/);
  assert.equal(f.store.readResult(f.binding, 1).sessionId, f.sessionId);
  assert.equal(f.store.readResult(f.binding, 1).finalText, 'same original native session completed');
});

test('answered or dismissed questions suppress held notifications without inventing successful approval', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start(); const before = f.store.read(f.binding);
  f.append([question('same-batch'), answer('same-batch')]); await f.flush();
  assert.equal(fs.existsSync(f.paths('same-batch').evidencePath), false);
  for (const [id, error] of [['answered', false], ['dismissed', true]]) {
    f.append([question(id)]); await f.flush();
    f.append([answer(id, error)]); await f.flush(); assert.ok(f.evidence(id).recoveredAt);
  }
  f.releaseForeground(); await until(() => f.marker('answered').status !== 'claimed' && f.marker('dismissed').status !== 'claimed');
  assert.equal(f.callbacks.length, 0); assertUnchangedRun(f, before);
});

test('history, other sessions, other directories, sidechains, prose and unknown results do not create waiting events', { timeout: 25000 }, async t => {
  const f = fixture(t); f.append([question('historical')]); await f.start();
  f.append([
    { ...question('wrong-session'), sessionId: 'other-session' },
    { ...question('wrong-cwd'), cwd: path.dirname(f.root) },
    { ...question('sidechain'), isSidechain: true },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'AskUserQuestion is mentioned in a design example, not a tool call.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'slow-read', name: 'Read', input: { file_path: 'fixture' } }] } },
    answer('unknown-question'), answer('historical'),
    { ...question('invalid-item/../../'), sessionId: f.sessionId },
  ]); await f.flush(); f.releaseForeground();
  assert.equal(f.posted.filter(item => item.route === '/attention').length, 0);
  assert.equal(f.callbacks.length, 0); assert.equal(f.endpoint().status, 'running');
});

test('explicit permission denial alerts once and only a same-tool same-input successful result clears that incident', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start(); const before = f.store.read(f.binding);
  f.append(toolRows('denied-one')); await f.flush();
  const code = 'permission-denied'; assert.equal(f.evidence('denied-one', code).count, 1);
  f.append([...toolRows('denied-two'), ...toolRows('other-tool-ok', { tool: 'Read', success: true }), ...toolRows('same-tool-other-input', { command: 'different harmless operation', success: true })]); await f.flush();
  assert.equal(f.evidence('denied-one', code).recoveredAt, undefined);
  assert.equal(fs.existsSync(f.paths('denied-two', code).evidencePath), false);
  assertUnchangedRun(f, before);
  f.append(toolRows('same-tool-ok', { success: true })); await f.flush();
  assert.ok(f.evidence('denied-one', code).recoveredAt);
  f.releaseForeground(); await until(() => f.marker('denied-one', code).status !== 'claimed');
  assert.equal(f.callbacks.length, 0); assertUnchangedRun(f, before);
  f.append(toolRows('denied-new')); await f.flush(); await until(() => f.callbacks.length === 1);
  assert.equal(f.evidence('denied-new', code).recoveredAt, undefined);
  assert.match(f.callbacks[0].prompt, /权限拒绝/);
  assert.match(f.callbacks[0].prompt, /不授权停止、重建、切换模型、代替用户批准或绕过权限/);
});

test('a concrete follow-up question replaces an unsent generic denial reminder without approving the denied operation', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start(); const before = f.store.read(f.binding);
  f.append(toolRows('denied')); await f.flush();
  f.append([question('clarify')]); await f.flush(); assert.ok(f.evidence('denied', 'permission-denied').recoveredAt);
  f.releaseForeground(); await until(() => f.callbacks.length === 1);
  await until(() => f.marker('denied', 'permission-denied').status !== 'claimed');
  assert.equal(f.marker('denied', 'permission-denied').status, 'suppressed');
  assert.ok(f.callbacks[0].prompt.includes(f.paths('clarify').evidencePath));
  assertUnchangedRun(f, before);
});

test('lost HTTP reply after persistence still clears an answered question and does not consume the next notification', { timeout: 25000 }, async t => {
  const f = fixture(t, { loseBlockedReply: true }); await f.start();
  f.append([question('lost-reply')]); await f.flush();
  assert.equal(f.evidence('lost-reply').recoveredAt, undefined);
  f.append([answer('lost-reply')]); await f.flush(); assert.ok(f.evidence('lost-reply').recoveredAt);
  f.releaseForeground(); await until(() => f.marker('lost-reply').status !== 'claimed'); assert.equal(f.callbacks.length, 0);
  f.append([question('later-question')]); await f.flush(); await until(() => f.callbacks.length === 1);
  assert.ok(f.callbacks[0].prompt.includes(f.paths('later-question').evidencePath));
  assert.equal(f.posted.filter(item => item.route === '/attention' && item.data.itemId === 'lost-reply' && item.data.status === 'blocked').length, 1);
  assert.equal(f.posted.filter(item => item.route === '/attention' && item.data.itemId === 'lost-reply' && item.data.status === 'recovered').length, 1);
});

test('failed denial delivery retries only on new matching denial evidence, not flushes or unrelated operations', { timeout: 25000 }, async t => {
  const f = fixture(t, { failBlockedPost: true }); await f.start();
  f.append(toolRows('first-denial')); await f.flush();
  const attentionPosts = () => f.posted.filter(item => item.route === '/attention');
  assert.equal(attentionPosts().length, 1);
  assert.equal(fs.existsSync(f.paths('first-denial', 'permission-denied').evidencePath), false);
  await f.flush(); await f.flush(); assert.equal(attentionPosts().length, 1);
  f.append(toolRows('unrelated-success', { command: 'different harmless operation', success: true })); await f.flush();
  assert.equal(attentionPosts().length, 1);
  f.append(toolRows('matching-new-denial')); await f.flush();
  assert.equal(attentionPosts().length, 2);
  assert.equal(attentionPosts()[1].data.itemId, 'first-denial');
  assert.equal(f.evidence('first-denial', 'permission-denied').recoveredAt, undefined);
  assert.equal(fs.existsSync(f.paths('matching-new-denial', 'permission-denied').evidencePath), false);
  f.releaseForeground(); await until(() => f.callbacks.length === 1);
  await f.flush(); assert.equal(attentionPosts().length, 2);
  assert.equal(f.endpoint().status, 'running');
});

test('final result or authorized stop suppresses pending question and denial messages', { timeout: 25000 }, async t => {
  for (const ending of ['result', 'stop']) {
    const f = fixture(t); await f.start();
    f.append([question('question')]); await f.flush(); f.append(toolRows('denied')); await f.flush();
    if (ending === 'result') await f.finish('actual final supersedes waiting');
    else f.store.requestStop(f.binding, { stateSha256: digest(f.store.read(f.binding)), expectedSessionId: f.sessionId, reason: 'fixture authorized stop', requestId: 'stop' });
    f.releaseForeground();
    await until(() => f.marker('question').status !== 'claimed' && f.marker('denied', 'permission-denied').status !== 'claimed');
    assert.ok(f.callbacks.every(value => !value.prompt.includes('CLI_ATTENTION_REQUIRED')));
  }
});

test('manager rejects wrong run/session, invalid item IDs and mismatched question tools without writing evidence', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start();
  const base = { sessionId: f.sessionId, runNumber: 1, code: 'question-awaiting-answer', status: 'blocked', itemId: 'valid', tool: 'AskUserQuestion', count: 1, transcriptPath: f.transcriptPath, firstOffset: 0, lastOffset: 1 };
  for (const patch of [{ sessionId: 'foreign' }, { runNumber: 99 }, { itemId: '../escape' }, { code: 'unknown' }, { tool: 'PowerShell' }, { count: 0 }, { firstOffset: -1 }]) {
    await assert.rejects(f.post('/attention', { ...base, ...patch }), /identity mismatch|Invalid/);
  }
  assert.equal(fs.existsSync(f.paths('valid').evidencePath), false);
  assert.equal(f.callbacks.length, 0); assert.equal(f.endpoint().status, 'running');
});

test('UTF8 records are only acted on when complete and evidence contains offsets, never business question text', { timeout: 25000 }, async t => {
  const f = fixture(t); await f.start();
  const sentinel = 'fixture-private-text-中文🙂', record = Buffer.from(JSON.stringify(f.row(question('utf8-question', sentinel))) + '\n');
  const start = fs.statSync(f.transcriptPath).size, split = record.indexOf(Buffer.from('中')) + 1;
  fs.appendFileSync(f.transcriptPath, record.subarray(0, split)); await f.flush();
  assert.equal(fs.existsSync(f.paths('utf8-question').evidencePath), false);
  fs.appendFileSync(f.transcriptPath, record.subarray(split)); await f.flush();
  const evidence = f.evidence('utf8-question');
  assert.equal(evidence.firstOffset, start); assert.equal(evidence.lastOffset, start + record.length);
  assert.equal(fs.readFileSync(f.paths('utf8-question').evidencePath, 'utf8').includes(sentinel), false);
  f.releaseForeground(); await until(() => f.callbacks.length === 1);
  assert.equal(f.callbacks[0].prompt.includes(sentinel), false);
  assert.equal(f.callbacks[0].prompt.includes(f.sessionId), false);
});
