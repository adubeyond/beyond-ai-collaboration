import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { atomicJson, digest, sha256File, validIdentifier } from './cli-task-store.mjs';
import { processStart, processIsGone } from './process-identity.mjs';
import { redact } from './native-cli-runner.mjs';
import { notifyWhenReady } from './cli-notify.mjs';

export async function runVisibleCli({ binding, run: firstRun, profile, prompt, store, managerIdentity, host, ready = () => {}, openWindow }) {
  const directory = store.runDir(firstRun, firstRun.runNumber);
  const tokenPath = store.checkedPath(path.join(directory, 'remote-token'));
  const connectionPath = store.checkedPath(path.join(directory, `${profile.provider}-connection.json`));
  const viewExitPath = store.checkedPath(path.join(directory, `${profile.provider}-view-exit.json`));
  const endpointPath = store.checkedPath(path.join(store.taskDir(binding), 'interactive.json'));
  const token = crypto.randomBytes(32).toString('hex'), launchId = crypto.randomUUID();
  fs.writeFileSync(tokenPath, token, { flag: 'wx', mode: 0o600 });
  const safe = value => redact(String(value).split(token).join('[REDACTED]'));
  let run = firstRun, sessionId = run.sessionId, native = null, active = true, detached = false, closing = false, closed = false, stopSent = false, channel = null, endpoint, watcher, startup;
  let pendingCommand = null, queue = Promise.resolve(), endLifetime;
  const lifetime = new Promise(resolve => { endLifetime = resolve; }), notifications = new Set();
  const persist = status => atomicJson(endpointPath, { ...endpoint, sessionId, status, server: native ?? managerIdentity });
  const log = item => fs.appendFileSync(store.checkedPath(path.join(store.runDir(run, run.runNumber), 'events.jsonl')), safe(JSON.stringify(item)) + '\n', { mode: 0o600 });
  const answer = (response, status, value) => { if (!response.destroyed && !response.writableEnded) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); } };
  function command(value) {
    if (pendingCommand) throw new Error('Native CLI command already pending');
    if (channel && !channel.destroyed) { const response = channel; channel = null; answer(response, 200, value); }
    else pendingCommand = value;
  }
  function notify(resultRun) {
    if (!host) return;
    const sourceEnd = (async () => { for (;;) { const source = host.currentSource(); await host.waitForSourceTurnEnd(source); if (host.currentSource().ownerTurnId === source.ownerTurnId) return; } })();
    sourceEnd.catch(() => {});
    const work = notifyWhenReady({ store, identity: resultRun, runNumber: resultRun.runNumber, host, sourceEnd }).catch(error => log({ notificationError: safe(error.message) }));
    notifications.add(work); work.finally(() => notifications.delete(work));
  }
  function finish(status, finalText = '', error = null) {
    if (!active || fs.existsSync(run.resultPath)) return;
    const ended = run;
    store.finishRun(run, { status, sessionId, finalText: safe(finalText), error: error ? safe(error) : null });
    active = false; persist('idle'); notify(ended);
  }
  async function close({ viewExited = false, error = null } = {}) {
    if (closed) return;
    if (closing && !viewExited) return;
    closing = true; clearTimeout(startup); persist('closing');
    if (active) finish('unknown', '', error ?? 'Native CLI view ended before a stable result');
    if (!viewExited && native && !processIsGone(native)) {
      pendingCommand = null; command({ action: 'close' });
      return; // View's exit record ends the lifetime; no guessed process death.
    }
    closed = true; watcher?.close();
    if (channel) { answer(channel, 410, { error: 'Native CLI owner closed' }); channel = null; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    persist('closed');
    for (const file of [tokenPath, connectionPath]) if (fs.existsSync(file)) fs.unlinkSync(file);
    endLifetime();
  }
  function instruction(text) {
    return ['You are a native CLI helper for one Desktop owner. Do not send Desktop messages or worker-result receipts. Return evidence; the owner decides goal completion.', `Goal: ${binding.contract.goal}`, `Boundaries: ${binding.contract.boundaries}`, `Acceptance: ${binding.contract.acceptance}`, `Read the relevant project/Action Skill entries as needed: ${JSON.stringify([...binding.contract.factEntries, ...binding.contract.skillEntries])}`, `Current authorized instruction: ${text}`].join('\n');
  }
  function goalActive() {
    if (binding.taskMode !== 'formal') return true;
    const task = store.readJson(path.join(store.controlRoot, 'local/runtime/workbench/workbench-state.json')).tasks?.[binding.taskId];
    return task?.status === '进行中' && task.execution?.ownerThreadId === binding.ownerThreadId;
  }
  function checkStop() {
    const stopFile = store.checkedPath(path.join(store.runDir(run, run.runNumber), 'stop.json'));
    if (!active || !native || stopSent || !fs.existsSync(stopFile)) return;
    const stop = store.readJson(stopFile);
    if (stop.runNumber !== run.runNumber || digest(stop.processIdentity) !== digest(managerIdentity) || (stop.sessionId && stop.sessionId !== sessionId)) throw new Error('Native CLI stop identity mismatch');
    if (pendingCommand) return;
    stopSent = true; detached = true; command({ action: 'stop', runNumber: run.runNumber });
  }
  const server = http.createServer((request, response) => {
    if (request.headers.origin || request.headers.authorization !== `Bearer ${token}`) return answer(response, 403, { error: 'forbidden' });
    if (request.method === 'GET' && request.url === '/command') {
      if (channel) return answer(response, 409, { error: 'Command channel already connected' });
      if (pendingCommand) { const value = pendingCommand; pendingCommand = null; answer(response, 200, value); queue = queue.then(checkStop).catch(error => log({ error: safe(error.message) })); return; }
      channel = response; response.on('close', () => { if (channel === response) channel = null; }); return;
    }
    const handle = async () => {
      if (request.method !== 'POST') throw new Error('Unsupported Native CLI request');
      let text = ''; for await (const bytes of request) { text += bytes; if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Native CLI request too large'); }
      const input = JSON.parse(text || '{}');
      if (closing && !['/event', '/ended'].includes(request.url)) throw new Error('Native CLI view is closing');
      let result = { ok: true };
      if (request.url === '/register') {
        if (native) throw new Error('Native CLI view already registered');
        if (fs.realpathSync(input.cwd) !== fs.realpathSync(binding.executionRoot)) throw new Error('Native CLI execution root mismatch');
        if (input.model !== profile.model) throw new Error('Native CLI selected model mismatch');
        if (profile.provider === 'zcode' && profile.effort !== undefined && input.effort !== profile.effort) throw new Error('Native CLI selected effort mismatch');
        validIdentifier(input.sessionId);
        if (sessionId && input.sessionId !== sessionId) throw new Error('Native CLI restored another session');
        const proofFile = store.checkedPath(path.join(store.runDir(run, run.runNumber), 'cli-process.json'));
        if (profile.provider === 'claude') {
          native = store.readJson(proofFile);
          if (native.pid !== input.pid || native.startedAt !== processStart(input.pid) || native.requestId !== run.requestId) throw new Error('Native CLI launch process mismatch');
        } else {
          native = { pid: input.pid, startedAt: processStart(input.pid), token: crypto.randomUUID() };
          store.setChildProcess(run, native);
        }
        sessionId = input.sessionId; store.bindSession(run, sessionId);
        clearTimeout(startup); persist('running'); log({ event: 'session-bound', sessionId, cwd: input.cwd, model: input.model, reportedEffort: input.effort ?? null, requestedEffort: profile.effort ?? null });
        command({ action: 'submit', runNumber: run.runNumber, prompt: instruction(prompt) });
      } else if (request.url === '/event') {
        if (!native || input.sessionId !== sessionId || input.runNumber !== run.runNumber) throw new Error('Native CLI result identity mismatch');
        if (!active || fs.existsSync(run.resultPath)) throw new Error('Native CLI result already stable');
        if (!['completed', 'failed', 'stopped', 'unknown'].includes(input.status) || typeof input.finalText !== 'string') throw new Error('Invalid Native CLI result');
        const status = input.status === 'completed' && !input.finalText.trim() ? 'failed' : input.status;
        log({ event: 'turn-ended', runNumber: run.runNumber, status }); finish(status, input.finalText, input.error);
        if (detached) { answer(response, 200, result); await close(); return; }
      } else if (request.url === '/resume') {
        if (active || !native || !goalActive()) throw new Error('Native CLI session is not idle/active');
        if (digest(input.profile) !== digest(profile)) throw new Error('Live Native CLI profile changed; detach before changing configuration');
        const saved = store.readJson(path.join(store.runDir(input.run, input.run.runNumber), 'run.json'));
        if (digest(saved) !== digest(input.run) || saved.sessionId !== sessionId || store.read(binding).runNumber !== saved.runNumber) throw new Error('Native CLI resume run mismatch');
        run = saved; store.setProcess(run, managerIdentity); store.setChildProcess(run, native); active = true; stopSent = false; persist('running');
        command({ action: 'submit', runNumber: run.runNumber, prompt: instruction(input.prompt) }); result = { ...run, status: 'running', stateLocator: store.locator(run) };
      } else if (request.url === '/manual') {
        if (active || !native || input.sessionId !== sessionId || !input.prompt?.trim() || !goalActive()) throw new Error('Native CLI manual continuation is unavailable');
        const review = store.readReview(binding, run.runNumber);
        if (review && review.decision !== 'continue') throw new Error('Owner already closed, accepted or paused this goal');
        if (!review) store.recordReview({ ...Object.fromEntries(['projectId', 'taskId', 'ownerThreadId'].map(k => [k, binding[k]])), runNumber: run.runNumber, resultSha256: sha256File(run.resultPath), decision: 'continue', evidenceLocator: `cli-ui:${sessionId}`, conclusion: 'User typed a continuation in the same managed native session; goal not yet accepted', reviewedAt: new Date().toISOString() });
        run = store.beginRun(binding, { requestId: `ui-${crypto.randomUUID()}`, prompt: input.prompt, expectedRunNumber: run.runNumber, expectedSessionId: sessionId, ownerTurnId: host?.currentSource().ownerTurnId ?? store.read(binding).ownerTurnId, profile });
        store.setProcess(run, managerIdentity); store.setChildProcess(run, native); active = true; stopSent = false; persist('running'); result = { runNumber: run.runNumber };
      } else if (request.url === '/detach') { detached = true; result = { status: active ? 'detach-after-turn' : 'detached' }; }
      else if (request.url === '/ended') { if (input.sessionId !== sessionId) throw new Error('Native CLI ended session mismatch'); detached = true; }
      else throw new Error('Unknown Native CLI action');
      answer(response, 200, result);
      if (detached && !active) await close();
    };
    queue = queue.then(handle).catch(error => answer(response, 409, { error: safe(error.message) }));
  });
  try {
    server.requestTimeout = 0;
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const controlUrl = `http://127.0.0.1:${server.address().port}/`;
    atomicJson(connectionPath, { url: controlUrl, token, model: profile.model, ...(profile.effort !== undefined ? { effort: profile.effort } : {}), ...(profile.provider === 'zcode' ? { startupErrorPath: store.checkedPath(path.join(directory, 'zcode-startup-error.json')) } : {}) });
    endpoint = { provider: profile.provider, schemaVersion: 1, ...Object.fromEntries(['projectId', 'taskId', 'ownerThreadId', 'executionRoot'].map(k => [k, binding[k]])), manager: managerIdentity, tokenPath, connectionPath, controlUrl, launchId, viewExitPath, profileSha256: digest(profile) };
    persist('starting');
    watcher = fs.watch(store.taskDir(binding), { recursive: true }, () => {
      queue = queue.then(async () => {
        if (fs.existsSync(viewExitPath)) { const record = store.readJson(viewExitPath); if (record.launchId === launchId) await close({ viewExited: true, error: record.error }); return; }
        if (closing) return;
        checkStop();
        if (!active && fs.existsSync(run.resultPath) && ['accept', 'pause', 'close'].includes(store.readReview(binding, run.runNumber)?.decision)) await close();
      }).catch(error => { log({ error: safe(error.message) }); });
    });
    atomicJson(store.checkedPath(path.join(directory, 'cli-launch-intent.json')), { runNumber: run.runNumber, requestId: run.requestId });
    const view = openWindow(store, binding); endpoint.view = view; persist('starting');
    startup = setTimeout(() => { queue = queue.then(async () => { finish('unknown', '', 'Native CLI native view did not register; inspect the visible window before retrying'); await close(); }); }, 30000);
    ready({ stateLocator: store.locator(run), sessionId });
    await lifetime; await Promise.all(notifications);
  } catch (error) { ready(null, error); if (endpoint) { finish('unknown', '', error.message); await close(); } else { server.close(); endLifetime(); } throw error; }
}
