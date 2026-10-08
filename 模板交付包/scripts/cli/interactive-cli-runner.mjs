import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { atomicJson, digest, sha256File } from './cli-task-store.mjs';
import { cliEnvironment, redact } from './native-cli-runner.mjs';
import { processStart } from './process-identity.mjs';
import { connectAppServer } from './app-server-rpc.mjs';
import { openInteractiveWindow, projectTrustOverride } from './interactive-client.mjs';
import { notifyWhenReady } from './cli-notify.mjs';

export function checkInteractiveCapability(profile) {
  const help = spawnSync(profile.runner.command, [...profile.runner.args, 'app-server', '--help'], { env: cliEnvironment(profile.codexHome), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (help.status !== 0 || !['--ws-auth', '--ws-token-file', '--listen'].every(x => help.stdout.includes(x))) throw new Error('Native interactive CLI requires an executable with authenticated app-server support (tested: Codex 0.160.0)');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Native interactive CLI requires Node.js 24 or newer');
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
export function classifyInteractiveTurn(turn, text) {
  if (turn.status === 'interrupted') return 'stopped';
  return turn.status === 'completed' && !turn.error && text?.trim() ? 'completed' : 'failed';
}
export async function runInteractiveCli({ binding, run: initialRun, profile, prompt, store, managerIdentity, host, ready = () => {}, openWindow = openInteractiveWindow, connect = connectAppServer }) {
  const endpointFile = store.checkedPath(path.join(store.taskDir(binding), 'interactive.json'));
  const tokenPath = store.checkedPath(path.join(store.runDir(initialRun, initialRun.runNumber), 'remote-token'));
  const token = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(tokenPath, token, { mode: 0o600, flag: 'wx' });
  const safe = text => redact(String(text).split(token).join('[REDACTED]'));
  const wsUrl = `ws://127.0.0.1:${await freePort()}`;
  let rpc, api, sessionId = initialRun.sessionId, run = initialRun, activeTurnId = null, dispatching = true, detached = false, closing = false, viewOpened = false, queue = Promise.resolve(), currentText = '', child;
  let endpoint;
  const endedTurnIds = new Set();
  const notifications = new Set();
  const workbenchFile = store.checkedPath(path.join(store.controlRoot, 'local/runtime/workbench/workbench-state.json'));
  function goalActive() {
    if (binding.taskMode !== 'formal') return true;
    const task = store.readJson(workbenchFile).tasks?.[binding.taskId];
    return task?.status === '进行中' && task.projectId === binding.projectId && task.execution?.kind === 'cli' && task.execution.ownerThreadId === binding.ownerThreadId;
  }
  let finishLifetime;
  const lifetime = new Promise(resolve => { finishLifetime = resolve; });
  const runDirectory = () => store.runDir(run, run.runNumber);
  const eventLog = data => fs.appendFileSync(store.checkedPath(path.join(runDirectory(), 'events.jsonl')), safe(JSON.stringify({ at: new Date().toISOString(), ...data })) + '\n', { mode: 0o600 });
  const persistEndpoint = status => { if (endpoint) atomicJson(endpointFile, { ...endpoint, status, sessionId, activeTurnId }); };
  async function close() {
    if (closing) return; closing = true; persistEndpoint('closing');
    rpc?.close(); if (api) await new Promise(resolve => api.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('close', () => { clearTimeout(timer); resolve(); }); });
    }
    watcher?.close(); workbenchWatcher?.close();
    const exited = !child || child.exitCode !== null || child.signalCode !== null;
    persistEndpoint(exited ? 'closed' : 'shutdown-unconfirmed');
    // A token is no longer useful after its server stops. Do not remove it on an unverified live server.
    if (exited && fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    finishLifetime();
  }
  async function notify(endedRun) {
    if (!host) return;
    // Recheck the current foreground, not just the old dispatch turn, before sending.
    const foregroundEnd = (async () => {
      for (;;) {
        const source = host.currentSource(); await host.waitForSourceTurnEnd(source);
        if (host.currentSource().ownerTurnId === source.ownerTurnId) return;
      }
    })();
    foregroundEnd.catch(() => {});
    await notifyWhenReady({ store, identity: endedRun, runNumber: endedRun.runNumber, host, sourceEnd: foregroundEnd });
  }
  function notifyLater(endedRun) {
    const pending = notify(endedRun).catch(error => { try { eventLog({ event: 'notification-error', error: safe(error.message) }); } catch {} });
    notifications.add(pending); pending.finally(() => notifications.delete(pending));
  }
  async function finish(turn) {
    if (turn.id !== activeTurnId || fs.existsSync(run.resultPath)) return;
    for (const item of turn.items ?? []) if (item.type === 'agentMessage' && (item.phase === 'final_answer' || !item.phase)) currentText = item.text;
    // Providers may omit phase. Only a real terminal event makes the candidate final stable.
    const status = classifyInteractiveTurn(turn, currentText), endedRun = run;
    store.finishRun(run, { status, sessionId, finalText: safe(currentText), error: turn.error ? safe(JSON.stringify(turn.error)) : status === 'failed' ? 'CLI did not provide a successful final result' : null });
    endedTurnIds.add(turn.id);
    activeTurnId = null; dispatching = false; persistEndpoint('idle');
    notifyLater(endedRun);
    if (!viewOpened && profile.ui !== 'attach') tryOpenView();
    if (detached || status === 'stopped') await close();
  }
  function tryOpenView() {
    if (viewOpened || profile.ui === 'attach' || !sessionId || closing) return;
    try { const view = openWindow(store, binding); endpoint = { ...endpoint, view }; viewOpened = true; persistEndpoint(activeTurnId ? 'running' : 'idle'); }
    catch (error) { eventLog({ event: 'view-unavailable', error: safe(error.message) }); }
  }
  async function receive(message) {
    if (closing) return;
    const params = message.params ?? {};
    if (!params.threadId || params.threadId !== sessionId) return;
    eventLog({ method: message.method, params });
    if (message.method === 'turn/started') {
      if (endedTurnIds.has(params.turn.id)) return;
      if (activeTurnId === params.turn.id) return;
      if (activeTurnId) throw new Error('Unexpected overlapping CLI turn');
      if (!dispatching) {
        if (!goalActive()) { await rpc.request('turn/interrupt', { threadId: sessionId, turnId: params.turn.id }); await close(); return; }
        // A typed native-UI instruction is an explicit continuation of this same authorized goal.
        const previous = store.read(binding), review = store.readReview(binding, previous.runNumber);
        if (review && review.decision !== 'continue') { await rpc.request('turn/interrupt', { threadId: sessionId, turnId: params.turn.id }); throw new Error('Goal reviewed as stopped/accepted; new native input is not continuation'); }
        if (!review) store.recordReview({ projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: binding.ownerThreadId, runNumber: previous.runNumber, resultSha256: sha256File(previous.currentResultPath), decision: 'continue', evidenceLocator: `cli-ui:${sessionId}#turn:${params.turn.id}`, conclusion: 'User typed a continuation in the bound native CLI; business completion remains unaccepted', reviewedAt: new Date().toISOString() });
        run = store.beginRun(binding, { requestId: `ui-${params.turn.id}`, prompt: 'Explicit native-UI input; see CLI event history', expectedRunNumber: previous.runNumber, expectedSessionId: sessionId, ownerTurnId: host?.currentSource().ownerTurnId ?? previous.ownerTurnId, profile });
        store.setProcess(run, managerIdentity);
        store.setChildProcess(run, endpoint.server);
      }
      activeTurnId = params.turn.id; currentText = ''; persistEndpoint('running');
    }
    if (message.method === 'item/completed' && params.turnId === activeTurnId && params.item?.type === 'agentMessage' && (params.item.phase === 'final_answer' || !params.item.phase)) currentText = params.item.text;
    if (message.method === 'turn/completed') await finish(params.turn);
    // First output means the initial prompt has been persisted; empty-session resume is not attempted.
    if (message.method === 'item/agentMessage/delta') tryOpenView();
  }
  async function fatal(error) {
    if (closing) return;
    try {
      if (!fs.existsSync(run.resultPath)) {
        const endedRun = run; store.finishRun(run, { status: 'unknown', sessionId, finalText: '', error: safe(error.message) });
        notifyLater(endedRun);
      }
    } finally { await close(); }
  }
  let watcher, workbenchWatcher;
  try {
    const directory = runDirectory();
    atomicJson(store.checkedPath(path.join(directory, 'cli-launch-intent.json')), { runNumber: run.runNumber, requestId: run.requestId });
    child = spawn(profile.runner.command, [...profile.runner.args, '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"', '-c', projectTrustOverride(binding.executionRoot), 'app-server', '--listen', wsUrl, '--ws-auth', 'capability-token', '--ws-token-file', tokenPath], { cwd: binding.executionRoot, env: cliEnvironment(profile.codexHome), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const serverIdentity = { pid: child.pid, startedAt: processStart(child.pid), token: crypto.randomUUID() };
    store.setChildProcess(run, serverIdentity);
    child.stdout.resume();
    child.stderr.on('data', bytes => { try { fs.appendFileSync(store.checkedPath(path.join(runDirectory(), 'stderr.log')), safe(bytes.toString()), { mode: 0o600 }); } catch (error) { void fatal(error); } });
    child.once('close', () => { if (!closing) void fatal(new Error('Native app-server exited before controlled shutdown')); });
    // Readiness is bounded startup detection, never model/task polling.
    for (let attempt = 0; ; attempt++) {
      try { const answer = await fetch(wsUrl.replace('ws:', 'http:') + '/readyz', { signal: AbortSignal.timeout(600) }); if (answer.ok) break; } catch {}
      if (attempt === 49 || child.exitCode !== null) throw new Error('Native app-server readiness failed');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    rpc = await connect(wsUrl, token, { onNotification: message => { queue = queue.then(() => receive(message)).catch(fatal); }, onDisconnect: error => { void fatal(error); } });
    await rpc.request('initialize', { clientInfo: { name: 'beyond_native_cli', title: 'BEYOND native CLI owner', version: '3.2.12' }, capabilities: { experimentalApi: true } }); rpc.initialized();
    const thread = await rpc.request(sessionId ? 'thread/resume' : 'thread/start', { ...(sessionId ? { threadId: sessionId } : { ephemeral: false }), cwd: binding.executionRoot, model: profile.model, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    if (sessionId && thread.thread.id !== sessionId) throw new Error('Native session identity changed');
    sessionId = thread.thread.id; store.bindSession(run, sessionId);
    api = http.createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.headers.origin || request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end('{"error":"forbidden"}'); return; }
      try {
        let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 65536) throw new Error('Control request too large'); }
        const input = text ? JSON.parse(text) : {};
        let result;
        if (request.url === '/resume') {
          if (activeTurnId || dispatching || closing) throw new Error('CLI turn already active; do not duplicate');
          if (digest(input.profile) !== digest(profile)) throw new Error('Live native profile changed; detach idle view before changing model');
          const saved = store.readJson(path.join(store.runDir(input.run, input.run.runNumber), 'run.json'));
          if (digest(saved) !== digest(input.run) || saved.sessionId !== sessionId || store.read(binding).runNumber !== saved.runNumber) throw new Error('Native resume run mismatch');
          run = saved; store.setProcess(run, managerIdentity); store.setChildProcess(run, serverIdentity);
          await dispatch(input.prompt, false); result = { ...run, status: 'running', stateLocator: store.locator(run) };
        } else if (request.url === '/open') { result = openWindow(store, binding); }
        else if (request.url === '/detach') {
          if (input.viewExitCode !== undefined) {
            if (!Number.isInteger(input.viewExitCode)) throw new Error('Invalid native view exit code');
            endpoint = { ...endpoint, viewExitCode: input.viewExitCode };
            eventLog({ event: 'native-view-exited', exitCode: input.viewExitCode });
            persistEndpoint(activeTurnId ? 'running' : 'idle');
          }
          detached = true; result = { status: activeTurnId || dispatching ? 'detach-after-turn' : 'detached' };
        }
        else throw new Error('Unknown interactive action');
        response.end(JSON.stringify(result));
        if (request.url === '/detach' && !activeTurnId && !dispatching) void close();
      } catch (error) { response.writeHead(409); response.end(JSON.stringify({ error: safe(error.message) })); }
    });
    await new Promise((resolve, reject) => api.once('error', reject).listen(0, '127.0.0.1', resolve));
    endpoint = { schemaVersion: 1, projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: binding.ownerThreadId, manager: managerIdentity, server: serverIdentity, tokenPath, wsUrl, controlUrl: `http://127.0.0.1:${api.address().port}/`, profileSha256: digest(profile), codexHome: profile.codexHome, command: profile.runner.command, args: profile.runner.args, executionRoot: binding.executionRoot };
    persistEndpoint('starting');
    watcher = fs.watch(store.taskDir(binding), { recursive: true }, () => {
      queue = queue.then(async () => {
        if (closing) return;
        const stopFile = store.checkedPath(path.join(runDirectory(), 'stop.json'));
        if (fs.existsSync(stopFile) && activeTurnId) {
          const stop = store.readJson(stopFile);
          if (stop.runNumber !== run.runNumber || digest(stop.processIdentity) !== digest(managerIdentity) || (stop.sessionId && stop.sessionId !== sessionId)) throw new Error('Native stop identity mismatch');
          await rpc.request('turn/interrupt', { threadId: sessionId, turnId: activeTurnId });
        }
        if (!activeTurnId && !dispatching && fs.existsSync(run.resultPath) && ['accept', 'pause', 'close'].includes(store.readReview(binding, run.runNumber)?.decision)) await close();
      }).catch(fatal);
    });
    if (binding.taskMode === 'formal') workbenchWatcher = fs.watch(path.dirname(workbenchFile), () => {
      queue = queue.then(async () => { if (!closing && !activeTurnId && !dispatching && !goalActive()) await close(); }).catch(fatal);
    });
    async function dispatch(instruction, first) {
      dispatching = true; currentText = ''; persistEndpoint('dispatching');
      const text = [first ? 'You are a native CLI session managed by a Desktop owner. Never call Desktop callbacks or worker-result receipts. Return evidence; the owner decides business completion. Read project AGENTS.md and relevant Action Skills as needed.' : '', `Goal: ${binding.contract.goal}`, `Boundaries: ${binding.contract.boundaries}`, `Acceptance: ${binding.contract.acceptance}`, `Relevant entries: ${JSON.stringify([...binding.contract.factEntries, ...binding.contract.skillEntries])}`, `Current authorized instruction: ${instruction}`].filter(Boolean).join('\n');
      const reply = await rpc.request('turn/start', { threadId: sessionId, input: [{ type: 'text', text }], model: profile.model, effort: profile.effort ?? 'medium', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
      activeTurnId ??= reply.turn.id; dispatching = false; persistEndpoint('running');
      if (reply.turn.status !== 'inProgress') await finish(reply.turn);
    }
    await dispatch(prompt, true); ready({ sessionId, stateLocator: store.locator(run), attachCommand: [process.execPath, path.join(import.meta.dirname, 'interactive-client.mjs'), '--attach', store.locator(run)] });
    if (initialRun.sessionId) tryOpenView();
    await lifetime;
    await Promise.all(notifications);
  } catch (error) { ready(null, error); await fatal(error); throw error; }
}
