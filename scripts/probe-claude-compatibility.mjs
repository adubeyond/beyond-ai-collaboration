// Opt-in native protocol probe: a real Claude terminal, isolated home and a
// loopback Anthropic fixture. No Desktop task, real credentials or model bill.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeArguments } from '../模板交付包/scripts/cli/claude-profile.mjs';
import { createClaudeSession } from '../模板交付包/scripts/cli/claude-client.mjs';
import { claudeHookEvents } from '../模板交付包/scripts/cli/claude-hook.mjs';
import { processStart } from '../模板交付包/scripts/cli/process-identity.mjs';

const executable = process.argv[2];
const reportPath = process.argv[3];
assert.equal(process.platform, 'win32', 'Native named-pipe probe requires Windows');
assert.ok(process.stdin.isTTY && process.stdout.isTTY, 'Run in a real terminal/PTY, not print mode');
assert.ok(path.isAbsolute(executable ?? '') && fs.statSync(executable).isFile(), 'Pass the native claude.exe');
assert.ok(path.isAbsolute(reportPath ?? ''), 'Pass an absolute report.json output path');
const version = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
assert.equal(version.status, 0);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-claude-compat-'));
const cwd = path.join(root, 'project'), config = path.join(root, '.claude');
fs.mkdirSync(cwd); fs.mkdirSync(config);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
// This synthetic home has no login or real key. Avoid the first-run online
// connectivity wizard; native project trust is still confirmed in the terminal.
write(path.join(config, '.claude.json'), { hasCompletedOnboarding: true,
  customApiKeyResponses: { approved: ['key-not-a-credential'], rejected: [] } });
const sessionId = crypto.randomUUID(), token = crypto.randomBytes(24).toString('hex');
const model = process.argv[4] ?? 'compatibility-model', hooks = [], events = [], requests = [], launches = [];
assert.ok(model.trim() && !/[\r\n]/.test(model));
let blockedProxyRequests = 0;
const waiters = new Set();
function signal() { for (const wake of waiters) wake(); }
async function until(predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timeout: ' + label);
    await new Promise(resolve => { const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); }; const timer = setTimeout(wake, 100); waiters.add(wake); });
  }
}
let child, childClosed, session, transport, hookFailure, queue = Promise.resolve();
let activeRound = 0;
const server = http.createServer(async (req, res) => {
  try {
  if (/^https?:/i.test(req.url ?? '')) { blockedProxyRequests++; res.writeHead(403).end(); return; }
  let body = ''; for await (const chunk of req) { body += chunk; assert.ok(body.length < 4 * 1024 * 1024); }
  if (req.url === '/hook') {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    queue = queue.then(async () => {
      const value = JSON.parse(body), input = value.input;
      hooks.push({ event: input.hook_event_name, sessionId: input.session_id, source: input.source ?? null, model: input.model ?? null,
        round: activeRound, cwd: input.cwd, prompt: input.hook_event_name === 'UserPromptSubmit' ? input.prompt : undefined });
      if (input.hook_event_name === 'SessionStart') transport = value.transport;
      const result = await session.hook(input, value.transport);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result)); signal();
    }).catch(error => { hookFailure = error; res.writeHead(409).end('{}'); signal(); });
    return;
  }
  if (req.url?.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
  if (req.url?.startsWith('/v1/messages')) {
    assert.ok(req.headers['x-api-key'] === 'fixture-key-not-a-credential', 'Only the synthetic API key is allowed');
    const input = JSON.parse(body), text = JSON.stringify(input.messages);
    const round = [...text.matchAll(/BEYOND_COMPAT_ROUND_(\d)/g)].at(-1)?.[1];
    const currentPromptCount = (text.match(new RegExp(`BEYOND_COMPAT_ROUND_${round}`, 'g')) ?? []).length;
    requests.push({ round: Number(round), model: input.model, stream: input.stream === true, currentPromptCount,
      priorAnswerPresent: text.includes('COMPATIBILITY_OK_1'), inputSha256: crypto.createHash('sha256').update(body).digest('hex') });
    if (Number(round) === 3) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'isolated compatibility failure' } })); return; }
    const answer = `COMPATIBILITY_OK_${round}`;
    const message = { id: 'msg_fixture_' + crypto.randomUUID(), type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } };
    if (!input.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...message, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    emit('message_start', { message });
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
    emit('message_stop', {}); res.end(); signal(); return;
  }
  res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  } catch (error) { hookFailure = error; if (!res.headersSent) res.writeHead(400); res.end('{}'); signal(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
server.on('connect', (_request, socket) => { blockedProxyRequests++; socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
const connectionFile = path.join(root, 'connection.json'), settingsFile = path.join(root, 'settings.json');
write(connectionFile, { url, token });
const hookPath = fileURLToPath(new URL('../模板交付包/scripts/cli/claude-hook.mjs', import.meta.url));
write(settingsFile, { hooks: Object.fromEntries(claudeHookEvents.map(event => [event, [{ hooks: [{ type: 'command', command: process.execPath, args: [hookPath, event], timeout: 8 }] }]])), skipDangerousModePermissionPrompt: false });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|TERM|COLORTERM|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
Object.assign(env, { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: url.replace(/\/$/, ''), ANTHROPIC_API_KEY: 'fixture-key-not-a-credential',
  BEYOND_CLAUDE_HOOK_CONNECTION: connectionFile, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: '127.0.0.1,localhost' });
const profile = { model, permissionMode: 'dontAsk' };
async function start(resuming) {
  childClosed = false; transport = null;
  const args = [...claudeArguments(profile, { taskId: 'isolated-compatibility', ...(resuming ? { sessionId } : {}) }, settingsFile, sessionId),
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', ''];
  child = spawn(executable, args, { cwd, env, stdio: 'inherit' });
  session = createClaudeSession({ sessionId, model, cwd, resuming, pid: child.pid,
    post: async (route, value) => { assert.ok(['/register', '/event', '/ended'].includes(route), 'Unexpected manual input'); events.push({ route, ...value }); signal(); return { ok: true }; },
    terminate: () => child?.kill() });
  child.once('exit', () => { childClosed = true; signal(); });
  child.once('error', error => { hookFailure = error; signal(); });
  launches.push({ pid: child.pid, startedAt: processStart(child.pid), resuming, args, effort: profile.effort ?? null });
  await until(() => session.registered || hookFailure || childClosed, 'native SessionStart');
  if (hookFailure) throw hookFailure;
  assert.ok(session.registered, 'Native session exited before registration');
  assert.ok(transport.pipe.startsWith('\\\\.\\pipe\\') && transport.token);
}
async function round(number, expected) {
  activeRound = number;
  await session.command({ action: 'submit', runNumber: number, prompt: `BEYOND_COMPAT_ROUND_${number}: return the fixture response; do not use tools.` });
  await until(() => events.some(e => e.route === '/event' && e.runNumber === number) || hookFailure, 'native terminal event');
  if (hookFailure) throw hookFailure;
  const results = events.filter(e => e.route === '/event' && e.runNumber === number);
  assert.equal(results.length, 1); assert.equal(results[0].status, expected);
  if (expected === 'completed') assert.equal(results[0].finalText.trim(), `COMPATIBILITY_OK_${number}`);
  const attempts = requests.filter(r => r.round === number);
  assert.ok(attempts.length >= 1);
  if (expected === 'completed') assert.equal(attempts.length, 1);
  for (const attempt of attempts) {
    assert.equal(attempt.model, model); assert.equal(attempt.currentPromptCount, 1);
    if (number > 1) assert.ok(attempt.priorAnswerPresent, 'Prior answer must survive live continuation and native resume');
  }
  assert.equal(hooks.filter(h => h.round === number && h.event === 'UserPromptSubmit').length, 1);
  assert.equal(hooks.filter(h => h.round === number && h.event === (expected === 'completed' ? 'Stop' : 'StopFailure')).length, 1);
  console.log(`\nNative compatibility round ${number}: ${expected}`);
}
async function exitNative() {
  console.log('\nNATIVE_EXIT_REQUIRED: enter /exit in this isolated terminal (never through the message pipe).');
  await until(() => childClosed, 'native exit', 120000);
  await queue;
}
let passed = false, error = null;
try {
  console.log(`Isolated native compatibility probe: ${version.stdout.trim()}\nScratch: ${root}\nNo real API is used. Complete only this isolated terminal's first-run trust prompt if shown.`);
  await start(false); await round(1, 'completed'); await round(2, 'completed'); await exitNative();
  assert.ok(hooks.some(h => h.event === 'SessionEnd'));
  await start(true); await round(3, 'failed'); await round(4, 'completed'); await exitNative();
  assert.equal(events.filter(e => e.route === '/register').length, 2);
  assert.ok(hooks.some(h => h.event === 'SessionStart' && h.source === 'resume'));
  assert.ok(hooks.every(h => h.sessionId === sessionId));
  assert.equal(events.filter(e => e.route === '/event').length, 4);
  assert.deepEqual(hooks.map(h => h.event), ['SessionStart', 'UserPromptSubmit', 'Stop', 'UserPromptSubmit', 'Stop', 'SessionEnd',
    'SessionStart', 'UserPromptSubmit', 'StopFailure', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
  passed = true;
} catch (failure) { error = failure.message; process.exitCode = 1; }
finally {
  if (child && !childClosed) { child.kill(); await until(() => childClosed, 'owned probe child exit', 10000).catch(() => {}); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const report = { passed, version: version.stdout.trim(), binarySha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), sessionId, activeRound, launches, hooks, events, requests, blockedProxyRequests, error };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); write(reportPath, report);
  // Save evidence before reclaiming only this probe's own isolated home.
  const actual = fs.realpathSync(root);
  assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(actual).startsWith('beyond-claude-compat-'));
  if (!child || childClosed) {
    try { fs.rmSync(actual, { recursive: true, maxRetries: 5, retryDelay: 200 }); }
    catch (cleanupError) { process.exitCode = 1; console.error('Probe evidence saved; scratch cleanup failed: ' + actual + ' (' + cleanupError.code + ')'); }
  } else console.error('Owned probe process still present; scratch retained: ' + actual);
  console.log('\nCOMPATIBILITY_REPORT=' + reportPath);
  console.log(JSON.stringify({ passed, version: report.version, hookEvents: hooks.map(h => h.event), statuses: events.filter(e => e.route === '/event').map(e => e.status), requests, error }));
}
