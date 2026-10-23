import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClaudeSession, watchClaudeFailures } from './claude-client.mjs';

// Exercise the real hook handler without a native process, API or live session.
function fixture(t, { resuming = false } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-claude-compact-'));
  const root = path.join(tempRoot, 'project');
  const nested = path.join(root, 'apps', 'frontend');
  const outside = path.join(tempRoot, 'outside');
  const sibling = path.join(tempRoot, 'project-other');
  for (const dir of [nested, outside, sibling]) fs.mkdirSync(dir, { recursive: true });
  const posts = [], delivered = [], closers = [];
  const sessionId = 'isolated-compact-session', model = 'isolated-model';
  const transport = { pipe: '\\\\.\\pipe\\isolated-compact', token: crypto.randomUUID() };
  const session = createClaudeSession({ sessionId, model, cwd: root, pid: process.pid, resuming,
    post: async (route, data) => { posts.push({ route, data }); return {}; },
    deliver: async (_transport, prompt) => { delivered.push(prompt); },
    terminate: () => { throw new Error('No native process may be terminated by this test'); },
  });
  const hook = (extra = {}, suppliedTransport = transport) => session.hook({
    session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup', cwd: root, model, ...extra,
  }, suppliedTransport);
  const registrations = () => posts.filter(item => item.route === '/register');
  t.after(() => {
    for (const close of closers) close();
    const actual = fs.realpathSync(tempRoot), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('beyond-claude-compact-'));
    fs.rmSync(actual, { recursive: true });
  });
  return { root, tempRoot, nested, outside, sibling, session, sessionId, model, transport, posts, delivered, hook, registrations, closers };
}

function observingFixture(t, history = []) {
  const f = fixture(t), transcriptPath = path.join(f.tempRoot, `${f.sessionId}.jsonl`), signals = [];
  const row = value => ({ sessionId: f.sessionId, cwd: f.nested, isSidechain: false, ...value });
  const append = values => fs.appendFileSync(transcriptPath, values.map(value => JSON.stringify(row(value))).join('\n') + '\n');
  fs.writeFileSync(transcriptPath, '');
  if (history.length) append(history);
  const observer = watchClaudeFailures({ transcriptPath, sessionId: f.sessionId, cwd: f.root, onSignal: async signal => signals.push(signal) });
  f.closers.push(() => observer.close());
  return { ...f, signals, append, flush: () => observer.flush() };
}
const question = id => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: 'Isolated fixture question' }] } }] } });
const answer = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Isolated fixture answer' }] } });
function operation(id, { success = false, command = 'isolated operation' } = {}) {
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'PowerShell', input: { command } }] } },
    { type: 'user', classifierBoundary: !success, toolDenialKind: success ? undefined : 'automode-blocked',
      permissionDecision: success ? undefined : { decision: 'reject', source: 'config', reasonType: 'classifier' },
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !success, content: success ? 'Fixture success' : 'Fixture rejection' }] } },
  ];
}

test('first startup and unbound compact require the exact root', async t => {
  const f = fixture(t);
  for (const source of ['startup', 'compact']) {
    await assert.rejects(f.hook({ source, cwd: f.nested }), /cwd identity mismatch/);
    assert.equal(f.session.registered, false);
    assert.equal(f.posts.length, 0);
  }
  await f.hook();
  assert.equal(f.session.registered, true);
  assert.equal(f.registrations().length, 1);
});

test('saved-session resume permits missing model only at the exact root', async t => {
  const f = fixture(t, { resuming: true });
  await assert.rejects(f.hook({ source: 'resume', cwd: f.nested, model: undefined }), /cwd identity mismatch/);
  assert.equal(f.posts.length, 0);
  await f.hook({ source: 'resume', model: undefined });
  assert.equal(f.registrations().length, 1);
  assert.equal(f.registrations()[0].data.cwd, f.root);
  assert.equal(f.registrations()[0].data.model, f.model);
});

test('bound compact permits real nested cwd without rebinding identity', async t => {
  const f = fixture(t);
  await f.hook();
  const initial = structuredClone(f.registrations());
  for (const cwd of [f.root, path.dirname(f.nested), f.nested]) {
    await f.hook({ source: 'compact', cwd, model: undefined });
  }
  assert.equal(f.session.registered, true);
  assert.deepEqual(f.registrations(), initial);
  assert.equal(f.posts.length, 1);
});

test('bound startup and resume still reject nested cwd', async t => {
  const f = fixture(t, { resuming: true });
  await f.hook({ source: 'resume', model: undefined });
  for (const source of ['startup', 'resume']) {
    await assert.rejects(f.hook({ source, cwd: f.nested }), /cwd identity mismatch/);
  }
  assert.equal(f.posts.length, 1);
});

test('bound compact rejects parent, outside and prefix-sibling directories', async t => {
  const f = fixture(t);
  await f.hook();
  for (const cwd of [f.tempRoot, f.outside, f.sibling]) {
    await assert.rejects(f.hook({ source: 'compact', cwd, model: undefined }), /cwd identity mismatch/);
  }
  assert.equal(f.posts.length, 1);
});

test('realpath rejects an inside junction escaping to outside the project', async t => {
  const f = fixture(t);
  const escaped = path.join(f.root, 'escaped');
  fs.symlinkSync(f.outside, escaped, process.platform === 'win32' ? 'junction' : 'dir');
  await f.hook();
  await assert.rejects(f.hook({ source: 'compact', cwd: escaped, model: undefined }), /cwd identity mismatch/);
  assert.equal(fs.realpathSync(escaped), fs.realpathSync(f.outside));
  assert.equal(f.posts.length, 1);
});

test('compact still verifies the original session, model and messaging transport', async t => {
  const f = fixture(t);
  await f.hook();
  const compact = { source: 'compact', cwd: f.nested, model: undefined };
  await assert.rejects(f.hook({ ...compact, session_id: 'foreign-session' }), /session identity changed/);
  await assert.rejects(f.hook({ ...compact, model: 'foreign-model' }), /model identity mismatch/);
  await assert.rejects(f.hook(compact, { pipe: 'not-a-native-pipe', token: f.transport.token }), /messaging pipe unavailable/);
  assert.equal(f.posts.length, 1);
  await f.hook(compact);
  assert.equal(f.posts.length, 1);
});

test('compaction keeps the original active round and reports its result once', async t => {
  const f = fixture(t);
  await f.hook();
  await f.session.command({ action: 'submit', runNumber: 7, prompt: 'isolated approved instruction' });
  await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'isolated approved instruction' });
  await f.hook({ source: 'compact', cwd: f.nested, model: undefined });
  assert.deepEqual(f.delivered, ['isolated approved instruction']);
  assert.equal(f.registrations().length, 1);
  // This hook-only fixture omits transcript_path. That gap is now reported,
  // without rebinding or settling the original run during compaction.
  assert.deepEqual(f.posts.filter(item => item.route === '/attention').map(item => item.data.code), ['attention-observer-unavailable']);
  assert.equal(f.posts.some(item => item.route === '/event'), false);
  await f.hook({ hook_event_name: 'Stop', last_assistant_message: 'isolated result', background_tasks: [], session_crons: [] });
  assert.deepEqual(f.posts.filter(item => item.route === '/event'), [{ route: '/event', data: {
    sessionId: f.sessionId, runNumber: 7, status: 'completed', finalText: 'isolated result', error: null,
  } }]);
  assert.equal(f.registrations().length, 1);
});

test('hook evidence scan registers background work without awaiting unrelated attention delivery', async t => {
  const f = fixture(t), transcriptPath = path.join(f.tempRoot, `${f.sessionId}.jsonl`), background = [];
  fs.writeFileSync(transcriptPath, '');
  let release;
  const pendingSignal = new Promise(resolve => { release = resolve; });
  const observer = watchClaudeFailures({ transcriptPath, sessionId: f.sessionId, cwd: f.root,
    onSignal: () => pendingSignal, onBackground: task => background.push(task) });
  f.closers.push(() => { release(); observer.close(); });
  const records = [question('pending-attention'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'background-tool', name: 'PowerShell', input: { command: 'fixture' } }] } },
    { type: 'user', toolUseResult: { backgroundTaskId: 'background-task' }, message: { content: [{ type: 'tool_result', tool_use_id: 'background-tool', content: 'fixture' }] } },
  ];
  fs.appendFileSync(transcriptPath, records.map(row => JSON.stringify({ sessionId: f.sessionId, cwd: f.root, isSidechain: false, ...row })).join('\n') + '\n');
  await observer.flush({ waitForDelivery: false });
  assert.deepEqual(background, [{ taskId: 'background-task', toolUseId: 'background-tool' }]);
  let completed = false;
  const complete = observer.flush().then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  release(); await complete;
});

test('nested transcript questions notify and answers recover, while preceding history stays excluded', async t => {
  const f = observingFixture(t, [question('historical-question')]);
  f.append([question('nested-question')]); await f.flush();
  assert.deepEqual(f.signals.map(signal => [signal.itemId, signal.status]), [['nested-question', 'blocked']]);
  f.append([answer('nested-question')]); await f.flush();
  assert.deepEqual(f.signals.map(signal => [signal.itemId, signal.status]), [['nested-question', 'blocked'], ['nested-question', 'recovered']]);
  assert.ok(f.signals.every(signal => !JSON.stringify(signal).includes('Isolated fixture')));
});

test('nested transcript explicit denial clears only after the same operation succeeds', async t => {
  const f = observingFixture(t);
  f.append(operation('nested-denial')); await f.flush();
  assert.deepEqual(f.signals.map(signal => [signal.code, signal.status]), [['permission-denied', 'blocked']]);
  f.append(operation('different-operation', { success: true, command: 'different isolated operation' })); await f.flush();
  assert.equal(f.signals.length, 1);
  f.append(operation('same-operation', { success: true })); await f.flush();
  assert.deepEqual(f.signals.map(signal => [signal.itemId, signal.status]), [['nested-denial', 'blocked'], ['nested-denial', 'recovered']]);
});

test('transcript observer rejects foreign sessions, sidechains, missing cwd and all project escapes', async t => {
  const f = observingFixture(t), escaped = path.join(f.root, 'escaped');
  const notDirectory = path.join(f.root, 'not-a-directory'); fs.writeFileSync(notDirectory, 'fixture');
  fs.symlinkSync(f.outside, escaped, process.platform === 'win32' ? 'junction' : 'dir');
  const invalid = [
    { sessionId: 'foreign-session' }, { isSidechain: true }, { cwd: undefined }, { cwd: 'relative-directory' },
    { cwd: path.join(f.root, 'missing') }, { cwd: notDirectory }, { cwd: f.tempRoot }, { cwd: f.outside }, { cwd: f.sibling }, { cwd: escaped },
  ];
  invalid.forEach((extra, index) => f.append([question(`invalid-question-${index}`), ...operation(`invalid-operation-${index}`)].map(row => ({ ...row, ...extra }))));
  await f.flush(); assert.equal(f.signals.length, 0);
  f.append([{ ...question('valid-after-invalid'), cwd: f.nested }]); await f.flush();
  assert.deepEqual(f.signals.map(signal => [signal.itemId, signal.status]), [['valid-after-invalid', 'blocked']]);
});

test('invalid answer and recovery records cannot clear valid nested incidents', async t => {
  const f = observingFixture(t);
  f.append([question('pending-question'), ...operation('pending-denial')]); await f.flush();
  assert.deepEqual(f.signals.map(signal => signal.status), ['blocked', 'blocked']);
  for (const extra of [{ cwd: f.outside }, { sessionId: 'foreign-session' }, { isSidechain: true }]) {
    f.append([{ ...answer('pending-question'), ...extra }, ...operation(`invalid-recovery-${f.signals.length}`, { success: true }).map(row => ({ ...row, ...extra }))]);
    await f.flush();
  }
  assert.deepEqual(f.signals.map(signal => signal.status), ['blocked', 'blocked']);
  f.append([answer('pending-question'), ...operation('valid-recovery', { success: true })]); await f.flush();
  assert.deepEqual(f.signals.map(signal => [signal.itemId, signal.status]), [
    ['pending-question', 'blocked'], ['pending-denial', 'blocked'], ['pending-question', 'recovered'], ['pending-denial', 'recovered'],
  ]);
});
