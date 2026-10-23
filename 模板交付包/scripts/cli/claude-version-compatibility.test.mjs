import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { checkClaudeCapability, claudeArguments } from './claude-profile.mjs';
import { readProfile } from './cli-bridge.mjs';
import { createClaudeSession } from './claude-client.mjs';

function versionProbe(t, result) {
  t.mock.method(childProcess, 'spawnSync', () => result);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('native availability probe never gates on a version number or output format', t => {
  const response = { status: 0, stdout: '' };
  versionProbe(t, response);
  const profile = { runner: { command: process.execPath } };
  for (const stdout of ['2.1.296 (Claude Code)', '2.1.299 (Claude Code)', '2.1.300 (Claude Code)',
    '2.1.295 (Claude Code)', '3.0.0 (Claude Code)', '42.7.100-preview.1 (Claude Code)',
    '2.1.300', 'Claude Code v3.0.0\r\n', 'development build']) {
    response.stdout = stdout;
    assert.doesNotThrow(() => checkClaudeCapability(profile));
  }
});

test('native availability probe still rejects actual launch, exit and output failures', t => {
  const response = { status: 0, stdout: '' };
  versionProbe(t, response);
  const profile = { runner: { command: process.execPath } };
  for (const stdout of ['', ' \r\n\t', null, undefined, 300]) {
    response.stdout = stdout;
    assert.throws(() => checkClaudeCapability(profile), /version probe failed/);
  }
  response.stdout = '2.1.300 (Claude Code)';
  for (const status of [1, -1, null, undefined]) {
    response.status = status;
    assert.throws(() => checkClaudeCapability(profile), /version probe failed/);
  }
  response.status = 0;
  for (const code of ['ENOENT', 'EACCES', 'ETIMEDOUT']) {
    response.error = Object.assign(new Error('fixture executable failure'), { code });
    assert.throws(() => checkClaudeCapability(profile), /version probe failed/);
  }
});

test('new native versions reach original-session resume without changing the persisted profile', t => {
  const response = { status: 0, stdout: '2.1.300 (Claude Code)' };
  versionProbe(t, response);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-claude-null-effort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'profile.json');
  const base = JSON.stringify({ schemaVersion: 1, provider: 'claude', runner: { command: process.execPath, args: [] },
    model: 'test-model', effort: 'max', permissionMode: 'dontAsk', mode: 'interactive', ui: 'window' });
  fs.writeFileSync(file, base);
  if (process.platform !== 'win32') {
    assert.throws(() => readProfile(file, { model: 'test-model-满血', effort: null }), /requires Windows/);
    return;
  }
  for (const stdout of ['2.1.300 (Claude Code)', '4.0.0 (Claude Code)', 'Claude Code development build']) {
    response.stdout = stdout;
    const profile = readProfile(file, { model: 'test-model-满血', effort: null });
    assert.equal(profile.model, 'test-model-满血');
    assert.equal(Object.hasOwn(profile, 'effort'), false);
    const args = claudeArguments(profile, { taskId: 'same-task', sessionId: 'same-session' }, 'settings.json', 'unused');
    assert.ok(!args.includes('--effort'));
    assert.deepEqual(args.slice(-2), ['--resume', 'same-session']);
    assert.equal(fs.readFileSync(file, 'utf8'), base);
  }
});

test('registered max preserves the base profile and respects native platform support', t => {
  versionProbe(t, { status: 0, stdout: '2.1.296 (Claude Code)' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-claude-version-test-'));
  t.after(() => {
    const actual = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('wst-claude-version-test-'));
    fs.rmSync(actual, { recursive: true });
  });
  const file = path.join(root, 'profile.json');
  const base = JSON.stringify({ schemaVersion: 1, provider: 'claude', runner: { command: process.execPath, args: [] },
    model: 'glm-5.3-codex', permissionMode: 'bypassPermissions', mode: 'interactive', ui: 'window' });
  fs.writeFileSync(file, base);
  let profile;
  if (process.platform === 'win32') {
    profile = readProfile(file, { model: 'glm-5.3-codex', effort: 'max' });
  } else {
    assert.throws(() => readProfile(file, { model: 'glm-5.3-codex', effort: 'max' }),
      /Claude native adapter requires Windows interactive window mode/);
    // Argument generation is platform-independent; native profile acceptance is not.
    profile = { ...JSON.parse(base), effort: 'max' };
  }
  assert.equal(profile.effort, 'max');
  assert.equal(fs.readFileSync(file, 'utf8'), base);
  const args = claudeArguments(profile, { taskId: 'original-task', sessionId: 'original-session' }, 'owned-settings.json', 'original-session');
  assert.deepEqual(args, ['--model', 'glm-5.3-codex', '--effort', 'max', '--permission-mode', 'bypassPermissions',
    '--settings', 'owned-settings.json', '--name', 'BEYOND-original-task', '--resume', 'original-session']);
});

function sessionFixture({ resuming = true, deliverError = null } = {}) {
  const calls = [], deliveries = [], sessionId = 'original-session', cwd = os.tmpdir();
  let terminated = 0;
  const transport = { pipe: '\\\\.\\pipe\\unit-claude-compatibility', token: 'fixture-token' };
  const session = createClaudeSession({ sessionId, model: 'glm-5.3-codex', cwd, pid: process.pid, resuming,
    async post(route, value) { calls.push({ route, value }); return route === '/manual' ? { runNumber: 3 } : { ok: true }; },
    async deliver(_transport, prompt) { deliveries.push(prompt); if (deliverError) throw deliverError; },
    terminate() { terminated++; } });
  const hook = (event, extra = {}) => session.hook({ hook_event_name: event, session_id: sessionId, cwd, ...extra }, transport);
  return { session, hook, calls, deliveries, get terminated() { return terminated; } };
}

test('same-session resume registers once and delivers each managed prompt once', async () => {
  const f = sessionFixture();
  await f.hook('SessionStart', { source: 'resume' });
  await f.hook('SessionStart', { source: 'resume' });
  assert.equal(f.calls.filter(c => c.route === '/register').length, 1);
  await f.session.command({ action: 'submit', runNumber: 1, prompt: 'first original instruction' });
  await f.hook('UserPromptSubmit', { prompt: 'first original instruction' });
  assert.equal((await f.hook('UserPromptSubmit', { prompt: 'first original instruction' })).decision, 'block');
  assert.equal((await f.hook('UserPromptSubmit', { prompt: 'another instruction while busy' })).decision, 'block');
  await f.hook('Stop', { last_assistant_message: 'first answer' });
  await f.hook('Stop', { last_assistant_message: 'duplicate stop' });
  assert.equal(f.calls.filter(c => c.route === '/event').length, 1);
  await f.session.command({ action: 'submit', runNumber: 2, prompt: 'second original instruction' });
  await f.hook('UserPromptSubmit', { prompt: 'second original instruction' });
  await f.hook('Stop', { last_assistant_message: 'second answer' });
  assert.deepEqual(f.deliveries, ['first original instruction', 'second original instruction']);
  assert.deepEqual(f.calls.filter(c => c.route === '/event').map(c => [c.value.sessionId, c.value.runNumber, c.value.status]),
    [['original-session', 1, 'completed'], ['original-session', 2, 'completed']]);
});

test('session, cwd and model mismatches stay rejected; missing startup model is not a resume', async () => {
  const f = sessionFixture({ resuming: false });
  await assert.rejects(f.hook('SessionStart', { source: 'startup' }), /model identity mismatch/);
  await assert.rejects(f.hook('SessionStart', { session_id: 'other-session', model: 'glm-5.3-codex' }), /session identity changed/);
  await assert.rejects(f.hook('SessionStart', { cwd: process.execPath, model: 'glm-5.3-codex' }), /cwd identity mismatch/);
  await assert.rejects(f.hook('SessionStart', { model: 'other-model' }), /model identity mismatch/);
  assert.equal(f.calls.length, 0);
});

test('API failure persists failed once; a later original-session turn can finish normally', async () => {
  const f = sessionFixture();
  await f.hook('SessionStart', { source: 'resume' });
  await f.session.command({ action: 'submit', runNumber: 1, prompt: 'first instruction' });
  await f.hook('UserPromptSubmit', { prompt: 'first instruction' });
  await f.hook('StopFailure');
  await f.hook('StopFailure');
  assert.equal(f.calls.filter(c => c.route === '/event').length, 1);
  assert.equal(f.calls.find(c => c.route === '/event').value.status, 'failed');
  await f.session.command({ action: 'submit', runNumber: 2, prompt: 'continue original work' });
  await f.hook('UserPromptSubmit', { prompt: 'continue original work' });
  await f.hook('Stop', { last_assistant_message: 'recovered answer' });
  assert.deepEqual(f.calls.filter(c => c.route === '/event').map(c => c.value.status), ['failed', 'completed']);
});

test('background work postpones Stop and empty answers remain failed', async () => {
  const f = sessionFixture();
  await f.hook('SessionStart', { source: 'resume' });
  await f.session.command({ action: 'submit', runNumber: 1, prompt: 'original work' });
  await f.hook('UserPromptSubmit', { prompt: 'original work' });
  await f.hook('Stop', { background_tasks: ['pending'], last_assistant_message: 'waiting' });
  assert.equal(f.calls.filter(c => c.route === '/event').length, 0);
  assert.equal(f.calls.filter(c => c.route === '/attention' && c.value.code === 'background-state-unavailable').length, 1);
  await f.hook('Stop', { background_tasks: ['pending'], last_assistant_message: 'still waiting' });
  assert.equal(f.calls.filter(c => c.route === '/attention' && c.value.code === 'background-state-unavailable').length, 1);
  await f.hook('Stop', { last_assistant_message: '' });
  assert.equal(f.calls.find(c => c.route === '/event').value.status, 'failed');
});

test('stop records stopped only after the exact child exits', async () => {
  const f = sessionFixture();
  await f.hook('SessionStart', { source: 'resume' });
  await f.session.command({ action: 'submit', runNumber: 1, prompt: 'original work' });
  await f.hook('UserPromptSubmit', { prompt: 'original work' });
  await f.session.command({ action: 'stop', runNumber: 1 });
  assert.equal(f.terminated, 1);
  assert.equal(f.calls.filter(c => c.route === '/event').length, 0);
  await f.session.nativeEnded();
  assert.equal(f.calls.find(c => c.route === '/event').value.status, 'stopped');
});

test('unconfirmed delivery stays unknown and terminates its owned child', async () => {
  const f = sessionFixture({ deliverError: new Error('delivery unconfirmed') });
  await f.hook('SessionStart', { source: 'resume' });
  await f.session.command({ action: 'submit', runNumber: 1, prompt: 'original work' });
  assert.equal(f.calls.find(c => c.route === '/event').value.status, 'unknown');
  assert.equal(f.terminated, 1);
});

test('first rejected input finishes once without manual replay or changing session', async () => {
  const f = sessionFixture();
  await f.hook('SessionStart', { source: 'resume' });
  await f.session.command({ action: 'submit', runNumber: 1, prompt: 'approved secret business input' });
  for (const prompt of ['corrupted input', 'approved secret business input', 'another input'])
    assert.equal((await f.hook('UserPromptSubmit', { prompt })).decision, 'block');
  await f.hook('StopFailure'); await f.hook('Stop', { last_assistant_message: 'late final' });
  const results = () => f.calls.filter(c => c.route === '/event');
  assert.equal(results().length, 1); assert.equal(results()[0].value.status, 'failed');
  assert.doesNotMatch(JSON.stringify(results()), /secret|corrupted/);
  assert.equal(f.calls.some(c => c.route === '/manual'), false);
  assert.equal(f.terminated, 0);
  await f.session.command({ action: 'submit', runNumber: 2, prompt: 'owner resume' });
  await f.hook('StopFailure'); // A late failure cannot finish a not-yet-started new run.
  assert.equal(results().length, 1);
  await f.hook('UserPromptSubmit', { prompt: 'owner resume' });
  await f.hook('Stop', { last_assistant_message: 'resumed' });
  assert.deepEqual(results().map(c => [c.value.runNumber, c.value.status, c.value.sessionId]),
    [[1, 'failed', 'original-session'], [2, 'completed', 'original-session']]);
});

test('stopping input is blocked without prematurely turning the run into failed', async () => {
  const f = sessionFixture(); await f.hook('SessionStart', { source: 'resume' });
  await f.session.command({ action: 'submit', runNumber: 1, prompt: 'approved' });
  await f.session.command({ action: 'stop', runNumber: 1 });
  assert.equal((await f.hook('UserPromptSubmit', { prompt: 'damaged' })).decision, 'block');
  assert.equal(f.calls.filter(c => c.route === '/event').length, 0);
  await f.session.nativeEnded();
  assert.equal(f.calls.find(c => c.route === '/event').value.status, 'stopped');
});

test('late delivery error cannot settle or terminate a subsequent run', async () => {
  let rejectFirst, terminated = 0; const events = [];
  const session = createClaudeSession({ sessionId: 'saved', model: 'm', cwd: os.tmpdir(), pid: process.pid,
    post: async (route, value) => { events.push({ route, value }); return {}; },
    deliver: async (_transport, prompt) => { if (prompt === 'first') await new Promise((_resolve, reject) => { rejectFirst = reject; }); },
    terminate: () => { terminated++; } });
  const hook = (event, extra = {}) => session.hook({ session_id: 'saved', hook_event_name: event, ...extra });
  await session.hook({ session_id: 'saved', hook_event_name: 'SessionStart', model: 'm', cwd: os.tmpdir() }, { pipe: '\\\\.\\pipe\\test', token: 'fixture' });
  const first = session.command({ action: 'submit', runNumber: 1, prompt: 'first' });
  await hook('UserPromptSubmit', { prompt: 'damaged' });
  await session.command({ action: 'submit', runNumber: 2, prompt: 'second' });
  rejectFirst(new Error('late delivery error')); await first;
  assert.equal(terminated, 0);
  await hook('UserPromptSubmit', { prompt: 'second' });
  await hook('Stop', { last_assistant_message: 'done' });
  assert.deepEqual(events.filter(e => e.route === '/event').map(e => e.value.status), ['failed', 'completed']);
});
