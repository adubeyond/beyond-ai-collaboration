import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { CLAUDE_VERSION, checkClaudeCapability, claudeArguments } from './claude-profile.mjs';
import { readProfile } from './cli-bridge.mjs';
import { createClaudeSession } from './claude-client.mjs';

function versionProbe(t, result) {
  t.mock.method(childProcess, 'spawnSync', () => result);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('native version guard accepts only the validated 2.1.296 response', t => {
  let response = { status: 0, stdout: '2.1.296 (Claude Code)\r\n' };
  versionProbe(t, response);
  const profile = { runner: { command: process.execPath } };
  assert.equal(CLAUDE_VERSION, '2.1.296');
  assert.doesNotThrow(() => checkClaudeCapability(profile));
  for (const stdout of ['2.1.297 (Claude Code)', '2.1.295 (Claude Code)', '2.1.294 (Claude Code)', '2.1.296', '']) {
    response.stdout = stdout;
    assert.throws(() => checkClaudeCapability(profile), /revalidation required/);
  }
  response.stdout = '2.1.296 (Claude Code)'; response.status = 1;
  assert.throws(() => checkClaudeCapability(profile), /revalidation required/);
});

test('registered max survives a base profile without effort and does not rewrite it', t => {
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
  const profile = readProfile(file, { model: 'glm-5.3-codex', effort: 'max' });
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
