import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { CliTaskStore, atomicJson, digest, sha256File } from './cli-task-store.mjs';
import { currentProcessIdentity } from './process-identity.mjs';
import { runVisibleCli } from './visible-cli-runner.mjs';
import { createClaudeControlTransport } from './claude-client.mjs';

function cleanup(root) {
  const actual = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
  assert.ok(path.basename(actual).startsWith('wst-command-channel-test-'));
  fs.rmSync(actual, { recursive: true });
}

async function visibleFixture(t, root, provider = 'claude') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiters = [], originalEmit = http.Server.prototype.emit;
  t.mock.method(http.Server.prototype, 'emit', function (event, ...args) {
    const value = originalEmit.call(this, event, ...args);
    if (event === 'request' && args[0].method === 'GET' && args[0].url === '/command') waiters.shift()?.(args[1]);
    return value;
  });
  const store = new CliTaskStore({ controlRoot: root });
  const identity = { projectId: 'project-test', taskId: 'command-test', ownerThreadId: 'owner-test' };
  const profile = { provider, model: 'test-model', mode: 'interactive', ui: 'window' };
  const binding = { ...identity, taskMode: 'assist', ownerTurnId: 'turn-test', executionRoot: root, profilePath: path.join(root, 'profile.json'), contract: { goal: 'local test', boundaries: 'fixture only', acceptance: 'protocol assertions', factEntries: [], skillEntries: [] } };
  store.create(binding);
  const run = store.beginRun(identity, { requestId: 'request-test', prompt: 'one original prompt', expectedRunNumber: 0, expectedSessionId: null, profile });
  const managerIdentity = { ...currentProcessIdentity(), token: 'fixture-manager' };
  store.setProcess(run, managerIdentity);
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const lifetime = runVisibleCli({ binding, run, profile, prompt: 'one original prompt', store, managerIdentity,
    openWindow() { store.setChildProcess(run, { ...currentProcessIdentity(), token: 'fixture-child' }); return { windowPid: process.pid }; },
    ready(value, error) { if (error) readyReject(error); else readyResolve(value); } });
  lifetime.catch(readyReject); await ready;
  const connection = store.readJson(path.join(store.runDir(run, 1), `${provider}-connection.json`));
  function call(method, route, body) {
    const request = http.request(new URL(route, connection.url), { method, headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' } });
    const result = new Promise((resolve, reject) => {
      request.once('error', reject);
      request.once('response', response => {
        let data = ''; response.setEncoding('utf8'); response.on('data', value => { data += value; }); response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode, text: data, value: data ? JSON.parse(data) : null }));
      });
    });
    result.catch(() => {}); request.end(body === undefined ? undefined : JSON.stringify(body));
    return { request, result };
  }
  const hold = async () => {
    const handled = new Promise(resolve => waiters.push(resolve));
    const request = call('GET', '/command'); return { ...request, response: await handled };
  };
  const register = () => call('POST', '/register', { cwd: root, model: profile.model, sessionId: 'test-session', pid: process.pid }).result;
  const close = async () => {
    const endpoint = store.readJson(path.join(store.taskDir(identity), 'interactive.json'));
    atomicJson(endpoint.viewExitPath, { launchId: endpoint.launchId, exitCode: 0, error: null });
    await lifetime;
  };
  return { store, identity, run, profile, call, hold, register, close };
}

test('Claude command channel: bounded idle and unchanged command delivery', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-command-channel-test-'));
  t.after(() => cleanup(base));
  let number = 0;
  const make = async (subtest, provider) => { const root = path.join(base, `server-${++number}`); fs.mkdirSync(root); return visibleFixture(subtest, root, provider); };
  await t.test('25-second idle emits bodyless 204; next poll gets exactly one initial submit', async st => {
    const f = await make(st);
    try {
      const first = await f.hold(); st.mock.timers.tick(24999); assert.equal(first.response.writableEnded, false);
      st.mock.timers.tick(1); assert.deepEqual(await first.result, { status: 204, text: '', value: null });
      const next = await f.hold(); assert.equal((await f.register()).status, 200);
      const delivered = await next.result; assert.equal(delivered.status, 200); assert.equal(delivered.value.action, 'submit');
      assert.equal(delivered.value.runNumber, 1); assert.match(delivered.value.prompt, /one original prompt/);
      const empty = await f.hold(); st.mock.timers.tick(25000); assert.equal((await empty.result).status, 204);
    } finally { await f.close(); }
  });
  await t.test('submit before the idle deadline clears its timer; the old timer cannot clear a new poll', async st => {
    const f = await make(st);
    try {
      const pending = await f.hold(); st.mock.timers.tick(24999); assert.equal((await f.register()).status, 200);
      assert.equal((await pending.result).value.action, 'submit');
      const next = await f.hold(); st.mock.timers.tick(1); assert.equal(next.response.writableEnded, false);
      st.mock.timers.tick(24999); assert.equal((await next.result).status, 204);
    } finally { await f.close(); }
  });
  await t.test('disconnect clears the old timer without disturbing a replacement poll', async st => {
    const f = await make(st);
    try {
      assert.equal((await f.register()).status, 200); assert.equal((await (await f.hold()).result).value.action, 'submit');
      const old = await f.hold(); st.mock.timers.tick(10000);
      const disconnected = new Promise(resolve => old.response.once('close', resolve)); old.request.destroy(); await disconnected;
      const next = await f.hold(); st.mock.timers.tick(15000); assert.equal(next.response.writableEnded, false);
      st.mock.timers.tick(10000); assert.equal((await next.result).status, 204);
    } finally { await f.close(); }
  });
  await t.test('view close releases a pending poll and clears its timer', async st => {
    const f = await make(st);
    const held = await f.hold(); await f.close();
    assert.equal((await held.result).status, 410); st.mock.timers.tick(25000);
    assert.equal(f.store.read(f.identity).status, 'unknown');
  });
  await t.test('zcode retains its existing pending response instead of receiving idle 204', async st => {
    const f = await make(st, 'zcode');
    const held = await f.hold(); st.mock.timers.tick(25000); assert.equal(held.response.writableEnded, false);
    await f.close(); assert.equal((await held.result).status, 410);
  });
});

test('Claude control fetch diagnostics preserve failures without leaking request data or retrying', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-command-channel-test-'));
  t.after(() => cleanup(root));
  let count = 0;
  function setup(fetchImpl) {
    const diagnosticPath = path.join(root, `diagnostic-${++count}.jsonl`), abort = new AbortController();
    const token = 'sensitive-test-token-123';
    const transport = createClaudeControlTransport({ url: new URL('http://127.0.0.1:12345/'), token, signal: abort.signal, diagnosticPath, fetchImpl });
    return { transport, diagnosticPath, token, abort, entries: () => fs.existsSync(diagnosticPath) ? fs.readFileSync(diagnosticPath, 'utf8').trim().split('\n').map(JSON.parse) : [] };
  }
  await t.test('204 is idle and its empty body is never parsed', async () => {
    let calls = 0;
    const f = setup(async () => { calls++; return { status: 204, ok: true, json() { throw new Error('must not parse'); } }; });
    assert.deepEqual(await f.transport.nextCommand(), { idle: true }); assert.equal(calls, 1); assert.deepEqual(f.entries(), []);
  });
  await t.test('200 returns one command without changing it', async () => {
    let calls = 0; const command = { action: 'submit', prompt: 'business text', runNumber: 2 };
    const f = setup(async () => { calls++; return { status: 200, ok: true, json: async () => command }; });
    assert.deepEqual(await f.transport.nextCommand(), { idle: false, command }); assert.equal(calls, 1); assert.deepEqual(f.entries(), []);
  });
  await t.test('GET network error preserves original error/cause and records only safe diagnostics', async () => {
    let calls = 0;
    const error = new TypeError('fetch failed sensitive-test-token-123', { cause: Object.assign(new Error('private cause body'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    error.stack = 'TypeError: sensitive-test-token-123\n    at http://127.0.0.1:12345/command?token=sensitive-test-token-123\n    at internal/sensitive-test-token-123:1:2';
    const f = setup(async () => { calls++; throw error; });
    await assert.rejects(f.transport.nextCommand(), value => value === error); assert.equal(calls, 1);
    const [entry] = f.entries(); assert.equal(entry.method, 'GET'); assert.equal(entry.route, '/command'); assert.equal(entry.errorName, 'TypeError');
    assert.equal(entry.causeCode, 'UND_ERR_HEADERS_TIMEOUT'); assert.ok(entry.elapsedMs >= 0);
    const saved = fs.readFileSync(f.diagnosticPath, 'utf8');
    for (const forbidden of [f.token, '127.0.0.1', 'http://', '?token=', 'private cause body', 'authorization']) assert.equal(saved.includes(forbidden), false);
  });
  await t.test('non-204 HTTP errors are not re-polled or treated as idle', async () => {
    let calls = 0; const f = setup(async () => { calls++; return { status: 410, ok: false }; });
    await assert.rejects(f.transport.nextCommand(), /command channel ended/); assert.equal(calls, 1); assert.equal(f.entries().length, 1);
  });
  await t.test('malformed successful response body stays an error', async () => {
    const error = new SyntaxError('malformed body'); let calls = 0;
    const f = setup(async () => { calls++; return { status: 200, ok: true, json: async () => { throw error; } }; });
    await assert.rejects(f.transport.nextCommand(), value => value === error); assert.equal(calls, 1); assert.equal(f.entries()[0].errorName, 'SyntaxError');
  });
  await t.test('POST network error is recorded once and the business payload is never retried or logged', async () => {
    let calls = 0; const error = new TypeError('fetch failed');
    const f = setup(async (_url, options) => { calls++; assert.equal(options.method, 'POST'); assert.equal(options.signal.aborted, false); throw error; });
    await assert.rejects(f.transport.post('/event', { business: 'sensitive-business-payload' }), value => value === error);
    assert.equal(calls, 1); assert.equal(f.entries()[0].method, 'POST'); assert.equal(f.entries()[0].route, '/event');
    assert.equal(fs.readFileSync(f.diagnosticPath, 'utf8').includes('sensitive-business-payload'), false);
  });
  await t.test('POST rejection does not retry; original owner error still propagates', async () => {
    let calls = 0; const f = setup(async () => { calls++; return { status: 409, ok: false, json: async () => ({ error: 'owner rejected this event' }) }; });
    await assert.rejects(f.transport.post('/register', {}), /owner rejected this event/); assert.equal(calls, 1); assert.equal(f.entries().length, 1);
  });
  await t.test('intentional GET cancellation propagates without a misleading failure diagnostic', async () => {
    const error = new DOMException('aborted', 'AbortError'); const f = setup(async () => { throw error; }); f.abort.abort();
    await assert.rejects(f.transport.nextCommand(), value => value === error); assert.deepEqual(f.entries(), []);
  });
});
