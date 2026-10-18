import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CliTaskStore, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { createDesktopHost } from '../模板交付包/scripts/cli/desktop-host.mjs';
import { launchCliRequest } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { notifyWhenReady } from '../模板交付包/scripts/cli/cli-notify.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 15000;
  for (;;) { const value = check(); if (value) return value; if (Date.now() > deadline) throw new Error('Reconnect fixture timed out'); await delay(20); }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-reconnect-'));
  const ownerThreadId = 'original-owner', sourceRecordPath = path.join(root, 'owner.jsonl');
  fs.writeFileSync(sourceRecordPath, JSON.stringify({ type: 'session_meta', payload: { id: ownerThreadId } }) + '\n');
  const event = (type, turn_id) => fs.appendFileSync(sourceRecordPath, JSON.stringify({ type: 'event_msg', payload: { type, turn_id } }) + '\n');
  event('task_started', 'turn-one');
  const pluginRoot = path.join(root, 'plugins'), plugin = path.join(pluginRoot, 'codex-app-tools/1.0.0');
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'codex-app-tools', version: '1.0.0', mcpServers: './.mcp.json' }));
  const proxy = path.join(plugin, 'proxy.cjs');
  // Use a real replaceable local pipe, not a mock that ignores the inherited path.
  fs.writeFileSync(proxy, `const socket=require('node:net').connect(process.env.CODEX_APP_TOOLS_PIPE_PATH);socket.on('error',()=>process.exit(1));process.stdin.pipe(socket);socket.pipe(process.stdout);`);
  fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { codex_app: { command: process.execPath, args: [proxy], cwd: plugin } } }));
  const env = { ...process.env, CODEX_HOME: root, CODEX_THREAD_ID: ownerThreadId, UNRELATED_SECRET: 'must-not-cross-resume-or-persist' };
  const hostSpec = { env, sourceRecordPath, pluginRoot, requestTimeoutMs: 2000, handoffTimeoutMs: 2000 };
  const transports = [], children = [], calls = [];
  async function transport({ schemaValid = true, onList = null } = {}) {
    const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\beyond-reconnect-${crypto.randomUUID()}` : path.join(root, `${crypto.randomUUID()}.sock`);
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      let buffer = ''; socket.setEncoding('utf8'); socket.on('data', chunk => {
        buffer += chunk; let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
          const request = JSON.parse(line); if (!request.id) continue;
          let result = {};
          if (request.method === 'tools/list') {
            result = { tools: [{ name: 'send_message_to_thread', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, [schemaValid ? 'prompt' : 'message']: { type: 'string' } }, required: ['threadId', schemaValid ? 'prompt' : 'message'] } }] };
            Promise.resolve(onList?.()).then(() => {
              if (!socket.destroyed) socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
            });
            continue;
          }
          if (request.method === 'tools/call') {
            calls.push({ pipePath, ...request.params });
            const turn = `notification-${calls.length}`; event('task_started', turn); event('task_complete', turn);
            result = { content: [{ type: 'text', text: 'delivered' }] };
          }
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
        }
      });
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(pipePath, resolve));
    let closed = false;
    const close = async () => { if (closed) return; closed = true; for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); };
    const entry = { pipePath, close }; transports.push(entry); return entry;
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
    for (const entry of transports) await entry.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { root, env, hostSpec, ownerThreadId, sourceRecordPath, event, calls, children, transport };
}

test('transport refresh accepts only the original owner, current source and working inherited pipe', async t => {
  const f = fixture(t), old = await f.transport(); f.env.CODEX_APP_TOOLS_PIPE_PATH = old.pipePath;
  const host = createDesktopHost(f.hostSpec), oldSnapshot = host.transportSnapshot();
  const fresh = await f.transport(), candidateHost = createDesktopHost({ ...f.hostSpec, env: { ...f.env, CODEX_APP_TOOLS_PIPE_PATH: fresh.pipePath } });
  f.event('task_complete', 'turn-one'); f.event('task_started', 'turn-two');
  const snapshot = candidateHost.transportSnapshot(), expected = { ownerThreadId: f.ownerThreadId, ownerTurnId: 'turn-two' };
  assert.deepEqual(Object.keys(snapshot).sort(), ['ownerThreadId', 'ownerTurnId', 'pipePath', 'sourceRecordPath']);
  for (const invalid of [null, { ...snapshot, ownerThreadId: 'other-owner' }, { ...snapshot, sourceRecordPath: path.join(f.root, 'another.jsonl') }, oldSnapshot, { ...snapshot, env: { token: crypto.randomUUID() } }]) {
    await assert.rejects(() => host.refreshTransport(invalid, expected), /refresh/);
    assert.equal(host.transportSnapshot().pipePath, old.pipePath);
  }
  await assert.rejects(() => host.refreshTransport(snapshot, { ...expected, ownerThreadId: 'other-owner' }), /identity/);
  const unsupported = await f.transport({ schemaValid: false });
  await assert.rejects(() => host.refreshTransport({ ...snapshot, pipePath: unsupported.pipePath }, expected), /capability/);
  assert.equal(host.transportSnapshot().pipePath, old.pipePath);
  await old.close(); assert.equal((await host.checkCapability()).available, false);
  await host.refreshTransport(snapshot, expected);
  assert.equal(host.transportSnapshot().pipePath, fresh.pipePath);
  assert.equal((await host.checkCapability()).available, true);
  assert.equal(f.calls.length, 0, 'refresh only probes capability; it does not send a message');
  assert.equal(JSON.stringify(host.descriptor).includes(fresh.pipePath), false, 'transport is not persisted in the host descriptor');
});

test('a foreground advance during capability validation rejects the stale refresh atomically', async t => {
  const f = fixture(t), old = await f.transport(); f.env.CODEX_APP_TOOLS_PIPE_PATH = old.pipePath;
  const host = createDesktopHost(f.hostSpec), snapshot = host.transportSnapshot();
  const candidate = await f.transport({ onList: () => f.event('task_started', 'turn-two') });
  await assert.rejects(() => host.refreshTransport({ ...snapshot, pipePath: candidate.pipePath }, snapshot), /stale/);
  assert.equal(host.transportSnapshot().pipePath, old.pipePath);
  assert.equal(f.calls.length, 0);
});

test('same live manager resumes the original native session after Desktop pipe replacement and notifies exactly once', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const f = fixture(t), old = await f.transport(); f.env.CODEX_APP_TOOLS_PIPE_PATH = old.pipePath;
  const profile = { schemaVersion: 1, provider: 'claude', mode: 'interactive', ui: 'window', model: 'fixture-model', permissionMode: 'dontAsk', runner: { command: process.execPath, args: [] } };
  const profilePath = path.join(f.root, 'profile.json'); fs.writeFileSync(profilePath, JSON.stringify(profile));
  const binding = { projectId: 'local-test', taskId: 'reconnect', ownerThreadId: f.ownerThreadId, ownerTurnId: 'turn-one', taskMode: 'assist', executionRoot: f.root, profilePath, contract: { goal: 'same session', boundaries: 'fixture only', acceptance: 'one notification', factEntries: [], skillEntries: [] } };
  fs.mkdirSync(path.join(f.root, 'local/projects'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'local/projects/local-test.md'), `---\nid: local-test\npath: ${f.root}\nhost_id: local\ncodex_project_id: fixture-project\n---\n`);
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), '<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: local-test -->\n');
  const store = new CliTaskStore({ controlRoot: f.root }); store.create(binding);
  const run = store.beginRun(binding, { requestId: 'first', prompt: 'first', expectedRunNumber: 0, expectedSessionId: null, profile });
  const moduleUrl = file => pathToFileURL(path.resolve('模板交付包/scripts/cli', file)).href;
  const entry = path.join(f.root, 'fixture-manager.mjs');
  fs.writeFileSync(entry, `
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {CliTaskStore} from ${JSON.stringify(moduleUrl('cli-task-store.mjs'))};
import {currentProcessIdentity} from ${JSON.stringify(moduleUrl('process-identity.mjs'))};
import {createDesktopHost} from ${JSON.stringify(moduleUrl('desktop-host.mjs'))};
import {runVisibleCli} from ${JSON.stringify(moduleUrl('visible-cli-runner.mjs'))};
const {binding,run,profile,hostSpec}=JSON.parse(process.argv[2]);
const store=new CliTaskStore({controlRoot:binding.executionRoot}),managerIdentity={...currentProcessIdentity(),token:randomUUID()};
store.setProcess(run,managerIdentity);
await runVisibleCli({binding,run,profile,prompt:'first',store,managerIdentity,host:createDesktopHost({...hostSpec,env:process.env}),ready:()=>process.send({ready:true}),openWindow(){store.setChildProcess(run,managerIdentity);return {transport:'fixture-native'};}});
process.disconnect();
`);
  const child = fork(entry, [JSON.stringify({ binding, run, profile, hostSpec: { ...f.hostSpec, env: undefined } })], { env: f.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); f.children.push(child);
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Fixture manager exited ${code}`))); });
  const endpointFile = path.join(store.taskDir(binding), 'interactive.json'), endpoint = () => store.readJson(endpointFile);
  const originalEndpoint = endpoint(), sessionId = 'same-native-session';
  const invoke = async (route, data) => {
    const current = endpoint(), response = await fetch(new URL(route, current.controlUrl), { method: data === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${fs.readFileSync(current.tokenPath, 'utf8')}`, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(5000) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error); return body;
  };
  await invoke('register', { sessionId, cwd: f.root, model: profile.model, pid: child.pid });
  assert.equal((await invoke('command')).action, 'submit');
  await old.close(); f.event('task_complete', 'turn-one');
  await invoke('event', { sessionId, runNumber: 1, status: 'completed', finalText: 'first preserved result' });
  const firstNotification = path.join(store.runDir(binding, 1), 'notification.json');
  await until(() => fs.existsSync(firstNotification) && store.readJson(firstNotification).status === 'unavailable');
  const preservedResult = fs.readFileSync(run.resultPath, 'utf8'), preservedNotification = fs.readFileSync(firstNotification, 'utf8');
  store.recordReview({ ...binding, runNumber: 1, resultSha256: sha256File(run.resultPath), decision: 'continue', evidenceLocator: 'fixture-only', conclusion: 'continue original session', reviewedAt: new Date().toISOString() });
  const fresh = await f.transport(); f.event('task_started', 'turn-two');
  const currentSpec = { ...f.hostSpec, env: { ...f.env, CODEX_APP_TOOLS_PIPE_PATH: fresh.pipePath } };
  const request = { schemaVersion: 1, requestId: 'resume', action: 'cli.resume', input: { projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: binding.ownerThreadId, prompt: 'second in original session', expectedRunNumber: 1, expectedSessionId: sessionId } };
  const context = { controlRoot: f.root, executionRoot: f.root, ownerThreadId: f.ownerThreadId, ownerTurnId: 'turn-two', hostSpec: currentSpec };
  const stale = await f.transport({ onList: () => f.event('task_started', 'turn-three') });
  await assert.rejects(() => launchCliRequest(request, { ...context, hostSpec: { ...currentSpec, env: { ...f.env, CODEX_APP_TOOLS_PIPE_PATH: stale.pipePath } } }), /stale/);
  assert.equal(store.read(binding).status, 'starting'); assert.equal(store.read(binding).runNumber, 2);
  assert.equal(endpoint().status, 'idle'); assert.deepEqual(endpoint().manager, originalEndpoint.manager);
  const savedRunPath = path.join(store.runDir(binding, 2), 'run.json'), savedRunBytes = fs.readFileSync(savedRunPath, 'utf8');
  assert.equal(JSON.parse(savedRunBytes).ownerTurnId, 'turn-two');
  assert.equal(fs.existsSync(path.join(store.runDir(binding, 2), 'cli-process.json')), false);
  assert.equal(fs.existsSync(path.join(store.runDir(binding, 2), 'result.json')), false);
  const unsupported = await f.transport({ schemaValid: false });
  context.ownerTurnId = 'turn-three';
  await assert.rejects(() => launchCliRequest(request, { ...context, hostSpec: { ...currentSpec, env: { ...f.env, CODEX_APP_TOOLS_PIPE_PATH: unsupported.pipePath } } }), /capability/);
  assert.equal(store.read(binding).status, 'starting'); assert.equal(store.read(binding).runNumber, 2); assert.equal(endpoint().status, 'idle');
  let releaseProbe, probeEntered = false;
  const probeGate = new Promise(resolve => { releaseProbe = resolve; });
  const delayed = await f.transport({ onList: () => { probeEntered = true; return probeGate; } });
  const abort = new AbortController(), abortedSnapshot = createDesktopHost({ ...currentSpec, env: { ...f.env, CODEX_APP_TOOLS_PIPE_PATH: delayed.pipePath } }).transportSnapshot();
  const interrupted = fetch(new URL('resume', endpoint().controlUrl), { method: 'POST', headers: { authorization: `Bearer ${fs.readFileSync(endpoint().tokenPath, 'utf8')}`, 'content-type': 'application/json' }, body: JSON.stringify({ run: JSON.parse(savedRunBytes), profile, prompt: request.input.prompt, desktopTransport: abortedSnapshot }), signal: abort.signal });
  try {
    await until(() => probeEntered);
    abort.abort(); await assert.rejects(interrupted, /abort/i);
    // Let the server observe the closed HTTP response before capability succeeds.
    await delay(50);
  } finally { releaseProbe(); }
  await delay(150);
  assert.equal(store.read(binding).status, 'starting', 'a disconnected caller must not dispatch after capability finishes');
  assert.equal(endpoint().status, 'idle');
  const next = await launchCliRequest(request, context);
  assert.equal(next.sessionId, sessionId); assert.equal(next.runNumber, 2);
  assert.equal(fs.readFileSync(savedRunPath, 'utf8'), savedRunBytes, 'same-request retry preserves the original run intent');
  assert.equal(fs.existsSync(store.runDir(binding, 3)), false, 'retry does not allocate a replacement run');
  assert.deepEqual(endpoint().manager, originalEndpoint.manager); assert.equal(endpoint().controlUrl, originalEndpoint.controlUrl);
  assert.equal((await invoke('command')).runNumber, 2);
  await invoke('event', { sessionId, runNumber: 2, status: 'completed', finalText: 'second preserved result' });
  await delay(150); assert.equal(f.calls.length, 0, 'active foreground still blocks notification after refresh');
  f.event('task_complete', 'turn-three');
  const secondNotification = path.join(store.runDir(binding, 2), 'notification.json');
  await until(() => {
    if (!fs.existsSync(secondNotification)) return false;
    const notification = store.readJson(secondNotification);
    if (notification.status !== 'claimed') assert.equal(notification.status, 'delivered', JSON.stringify(notification));
    return notification.status === 'delivered';
  });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].pipePath, fresh.pipePath);
  assert.equal(f.calls[0].arguments.threadId, f.ownerThreadId); assert.match(f.calls[0].arguments.prompt, /runNumber=2/);
  assert.equal((await notifyWhenReady({ store, identity: binding, runNumber: 2, host: createDesktopHost(currentSpec) })).status, 'duplicate-suppressed');
  assert.equal(f.calls.length, 1); assert.equal(store.read(binding).sessionId, sessionId);
  assert.equal(fs.readFileSync(run.resultPath, 'utf8'), preservedResult); assert.equal(fs.readFileSync(firstNotification, 'utf8'), preservedNotification);
  for (const file of [store.locator(binding), endpointFile, ...[1, 2].flatMap(number => ['run.json', 'input.json', 'result.json', 'notification.json'].map(leaf => path.join(store.runDir(binding, number), leaf)))]) {
    const bytes = fs.readFileSync(file, 'utf8'); assert.equal(bytes.includes(fresh.pipePath), false); assert.equal(bytes.includes('must-not-cross-resume-or-persist'), false);
  }
  await invoke('ended', { sessionId });
  fs.writeFileSync(originalEndpoint.viewExitPath, JSON.stringify({ launchId: originalEndpoint.launchId, exitCode: 0 }));
  await until(() => endpoint().status === 'closed');
  await until(() => child.exitCode !== null);
  t.diagnostic(JSON.stringify({ sameManager: true, sameNativeSession: true, oldTransportUnavailable: true, staleRefreshRejected: true, capabilityFailureRetriedWithSameRequestAndRun: true, disconnectedCallerDidNotDispatch: true, refreshedTransportDelivered: 1, originalResultAndNotificationPreserved: true, foregroundWaitPreserved: true, persistedTransportOrEnvironment: false }));
});
