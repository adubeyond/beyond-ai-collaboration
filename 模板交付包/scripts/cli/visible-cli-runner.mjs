import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { atomicJson, digest, sha256File, validIdentifier } from './cli-task-store.mjs';
import { processStart, processIsGone, nativeViewIsGone } from './process-identity.mjs';
import { redact, stageInstruction } from './native-cli-runner.mjs';
import { notifyWhenReady, notifyOnAttention, attentionPaths, nativeHookAttentionKinds } from './cli-notify.mjs';
import { buildCliContext } from './cli-context.mjs';

export async function runVisibleCli({ binding, run: firstRun, profile, prompt, store, managerIdentity, host, ready = () => {}, openWindow, nativeExitCheckMs = 30000 }) {
  const directory = store.runDir(firstRun, firstRun.runNumber);
  const tokenPath = store.checkedPath(path.join(directory, 'remote-token'));
  const connectionPath = store.checkedPath(path.join(directory, `${profile.provider}-connection.json`));
  const viewExitPath = store.checkedPath(path.join(directory, `${profile.provider}-view-exit.json`));
  const endpointPath = store.checkedPath(path.join(store.taskDir(binding), 'interactive.json'));
  const token = crypto.randomBytes(32).toString('hex'), launchId = crypto.randomUUID();
  fs.writeFileSync(tokenPath, token, { flag: 'wx', mode: 0o600 });
  const safe = value => redact(String(value).split(token).join('[REDACTED]'));
  let run = firstRun, sessionId = run.sessionId, native = null, active = true, detached = false, closing = false, closed = false, stopSent = false, channel = null, endpoint, watcher, startup;
  let pendingCommand = null, commandIdleTimer = null, nativeExitTimer = null, nativeExitError = null, queue = Promise.resolve(), endLifetime;
  const lifetime = new Promise(resolve => { endLifetime = resolve; }), notifications = new Set();
  const persist = status => atomicJson(endpointPath, { ...endpoint, sessionId, status, server: native ?? managerIdentity });
  const log = item => fs.appendFileSync(store.checkedPath(path.join(store.runDir(run, run.runNumber), 'events.jsonl')), safe(JSON.stringify(item)) + '\n', { mode: 0o600 });
  const answer = (response, status, value) => { if (!response.destroyed && !response.writableEnded) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); } };
  function releaseChannel(response) {
    if (channel !== response) return;
    clearTimeout(commandIdleTimer); commandIdleTimer = null; channel = null;
  }
  function command(value) {
    if (pendingCommand) throw new Error('Native CLI command already pending');
    if (channel && !channel.destroyed) { const response = channel; releaseChannel(response); answer(response, 200, value); }
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
    closed = true; watcher?.close(); clearTimeout(nativeExitTimer);
    if (channel) { const response = channel; releaseChannel(response); answer(response, 410, { error: 'Native CLI owner closed' }); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    persist('closed');
    for (const file of [tokenPath, connectionPath]) if (fs.existsSync(file)) fs.unlinkSync(file);
    endLifetime();
  }
  function observeNativeExit() {
    // This is a lifetime check for this manager, not an idle timeout or a task
    // scheduler. An alive CLI can remain idle indefinitely and is never killed.
    nativeExitTimer = setTimeout(() => {
      queue = queue.then(async () => {
        if (closed || !native || profile.provider !== 'claude') return;
        if (!nativeViewIsGone({ server: native, view: endpoint.view })) return;
        const saved = store.readJson(endpointPath), state = store.currentRun(run);
        if (saved.launchId !== launchId || digest(saved.manager) !== digest(managerIdentity)
          || saved.projectId !== binding.projectId || saved.taskId !== binding.taskId
          || digest(saved.server) !== digest(native) || digest(saved.view) !== digest(endpoint.view)
          || saved.ownerThreadId !== binding.ownerThreadId || saved.sessionId !== sessionId || state.sessionId !== sessionId) {
          throw new Error('Native CLI retirement identity changed');
        }
        if (fs.existsSync(run.resultPath) && store.readResult(run, run.runNumber).sessionId !== sessionId) {
          throw new Error('Native CLI retirement result session mismatch');
        }
        log({ event: 'native-view-exit-confirmed', runNumber: run.runNumber, receiptMissing: !fs.existsSync(viewExitPath) });
        await close({ viewExited: true, error: 'Verified native CLI and window exited without a stable response' });
        nativeExitError = null;
      }).catch(error => {
        const message = safe(error.message);
        if (message !== nativeExitError) {
          nativeExitError = message;
          try { log({ nativeExitError: message }); } catch { /* A failed diagnostic must not stop the task. */ }
        }
      }).finally(() => { if (!closed) observeNativeExit(); });
    }, nativeExitCheckMs);
    nativeExitTimer.unref?.();
  }
  function instruction(text) {
    const contract = run.effectiveContract ?? binding.contract;
    const context = buildCliContext({ binding, run, controlRoot: store.controlRoot });
    atomicJson(store.checkedPath(path.join(store.runDir(run, run.runNumber), 'document-context.json')), context.manifest);
    return ['You are a native CLI helper for one Desktop owner. Do not send Desktop messages or worker-result receipts. Return evidence; the owner decides goal completion.', 'Current effective contract for this run (supersedes earlier task contracts, not platform or system constraints):', `Goal: ${contract.goal}`, `Boundaries: ${contract.boundaries}`, `Acceptance: ${contract.acceptance}`, context.text, stageInstruction(run.stage), `Current authorized instruction: ${text}`].filter(Boolean).join('\n');
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
      channel = response; response.on('close', () => releaseChannel(response));
      if (profile.provider === 'claude') {
        commandIdleTimer = setTimeout(() => {
          if (channel !== response) return;
          releaseChannel(response);
          if (!response.destroyed && !response.writableEnded) { response.writeHead(204); response.end(); }
        }, 25000);
        commandIdleTimer.unref?.();
      }
      return;
    }
    const handle = async () => {
      if (request.method !== 'POST') throw new Error('Unsupported Native CLI request');
      request.setEncoding('utf8'); // Preserve multibyte prompt/result characters across HTTP chunks.
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
      } else if (request.url === '/attention') {
        if (profile.provider !== 'claude' || !native || input.sessionId !== sessionId || input.runNumber !== run.runNumber) throw new Error('Native CLI attention identity mismatch');
        if (!active || fs.existsSync(run.resultPath)) throw new Error('Native CLI attention run already ended');
        const legacy = input.code === 'permission-classifier-unavailable';
        const hookKind = Object.hasOwn(nativeHookAttentionKinds, input.code) ? nativeHookAttentionKinds[input.code] : null;
        if (!['blocked', 'recovered'].includes(input.status) || !/^[\w.-]{1,128}$/.test(input.tool ?? '')
          || (input.code === 'question-awaiting-answer' && input.tool !== 'AskUserQuestion')) throw new Error('Invalid Native CLI attention');
        if (hookKind && (input.evidenceKind !== 'native-hook' || input.hookEvent !== hookKind.hookEvent
          || input.itemId !== hookKind.itemId || input.tool !== hookKind.tool || input.status !== 'blocked')) throw new Error('Invalid Native CLI hook attention');
        if (!hookKind && input.evidenceKind === 'native-hook') throw new Error('Invalid Native CLI hook attention');
        const attention = { code: input.code, ...(!legacy ? { itemId: input.itemId } : {}) };
        const { evidencePath } = attentionPaths(store, run, attention);
        if (input.status === 'recovered') {
          if (fs.existsSync(evidencePath)) {
            const previous = store.readJson(evidencePath);
            if (previous.tool === input.tool && previous.code === input.code && previous.itemId === attention.itemId && !previous.recoveredAt) atomicJson(evidencePath, { ...previous, recoveredAt: new Date().toISOString() });
          }
        } else {
          if (!Number.isSafeInteger(input.count) || input.count < (legacy ? 3 : 1)) throw new Error('Invalid Native CLI attention evidence');
          if (!hookKind && (!Number.isSafeInteger(input.firstOffset) || input.firstOffset < 0
            || !Number.isSafeInteger(input.lastOffset) || input.lastOffset < input.firstOffset
            || !path.isAbsolute(input.transcriptPath ?? '') || path.basename(input.transcriptPath) !== `${sessionId}.jsonl`)) throw new Error('Invalid Native CLI attention evidence');
          if (!fs.existsSync(evidencePath)) {
            atomicJson(evidencePath, { schemaVersion: 1, projectId: run.projectId, taskId: run.taskId, ownerThreadId: run.ownerThreadId,
              runNumber: run.runNumber, requestId: run.requestId, sessionId, ...attention, tool: input.tool, count: input.count,
              ...(hookKind ? { evidenceKind: 'native-hook', hookEvent: input.hookEvent }
                : { transcriptPath: input.transcriptPath, firstOffset: input.firstOffset, lastOffset: input.lastOffset }), observedAt: new Date().toISOString() });
            if (host) {
              const sourceEnd = (async () => { for (;;) { const source = host.currentSource(); await host.waitForSourceTurnEnd(source); if (host.currentSource().ownerTurnId === source.ownerTurnId) return; } })();
              sourceEnd.catch(() => {});
              const work = notifyOnAttention({ store, run, host, sourceEnd, attention }).catch(error => log({ attentionError: safe(error.message) }));
              notifications.add(work); work.finally(() => notifications.delete(work));
            }
          }
        }
      } else if (request.url === '/resume') {
        if (active || !native || !goalActive()) throw new Error('Native CLI session is not idle/active');
        if (digest(input.profile) !== digest(profile)) throw new Error('Live Native CLI profile changed; detach before changing configuration');
        const saved = store.readJson(path.join(store.runDir(input.run, input.run.runNumber), 'run.json'));
        if (digest(saved) !== digest(input.run) || saved.sessionId !== sessionId || store.read(binding).runNumber !== saved.runNumber) throw new Error('Native CLI resume run mismatch');
        if (host?.refreshTransport) await host.refreshTransport(input.desktopTransport, saved);
        else if (input.desktopTransport) throw new Error('Desktop transport refresh unavailable');
        if (response.destroyed) throw new Error('Native resume caller disconnected before dispatch; retry the same request');
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
    if (profile.provider === 'claude') observeNativeExit();
    startup = setTimeout(() => { queue = queue.then(async () => { finish('unknown', '', 'Native CLI native view did not register; inspect the visible window before retrying'); await close(); }); }, 30000);
    ready({ stateLocator: store.locator(run), sessionId });
    await lifetime; await Promise.all(notifications);
  } catch (error) { ready(null, error); if (endpoint) { finish('unknown', '', error.message); await close(); } else { server.close(); endLifetime(); } throw error; }
}
