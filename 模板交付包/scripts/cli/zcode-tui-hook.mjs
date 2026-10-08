import fs from 'node:fs';
import crypto from 'node:crypto';
import { redact } from './native-cli-runner.mjs';

// Only the task-local TUI copy imports this hook. No global hooks or key copies.
export async function attachZcode(app, options, connection = JSON.parse(fs.readFileSync(process.env.BEYOND_ZCODE_CONNECTION, 'utf8'))) {
  try { return await connectZcode(app, options, connection); }
  catch (error) {
    // The upstream launcher redirects its diagnostic log; retain the exact failure
    // in this run so the owner need not inspect a shared, possibly overwritten log.
    if (connection.startupErrorPath) fs.writeFileSync(connection.startupErrorPath, JSON.stringify({ error: redact(error.message).slice(0, 2000) }), { flag: 'wx', mode: 0o600 });
    throw error;
  }
}

async function connectZcode(app, options, connection) {
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !connection.token) throw new Error('Invalid local ZCode connection');
  if (!connection.model || !options.setTransientModel) throw new Error('Native ZCode session model selection unavailable');
  await app.handleResult(await options.setTransientModel(connection.model), false);
  if (app.model !== connection.model) throw new Error('Native ZCode did not select the requested model');
  if (connection.effort !== undefined) {
    const optionsAvailable = (app.effortOptions ?? []).map(value => typeof value === 'string' ? value : value.id);
    if (!optionsAvailable.includes(connection.effort) || !options.submitPrompt) throw new Error(`Native ZCode model does not support the requested effort; available: ${optionsAvailable.join(', ') || 'none'}`);
    const result = await options.submitPrompt(`/effort ${connection.effort}`, { inputId: `input_${crypto.randomUUID()}`, queryId: `query_${crypto.randomUUID()}` });
    await app.handleResult(result, false, 'effort');
    if (app.thoughtLevel !== connection.effort) throw new Error('Native ZCode did not apply the requested effort');
  }
  const sessionId = options.getMainSessionId?.() ?? app.sessionId;
  let current = null, ended = false, lastEvent = null, lastFailure = null, serial = Promise.resolve();
  const abort = new AbortController();
  const post = async (route, body) => {
    const r = await fetch(new URL(route, url), { method: 'POST', headers: {authorization: `Bearer ${connection.token}`, 'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error ?? 'ZCode owner rejected event'); return data;
  };
  const fail = error => { app.addNotice?.(`BEYOND connection lost: ${error.message}`, 'error'); app.stop(); };
  const report = body => {
    // No retry after an ambiguous delivery. The owner retains the run for recovery.
    serial = serial.then(() => post('/event', { sessionId, ...body })).catch(fail);
  };
  const submit = app.submit, finish = app.finishTurn, onEvent = app.onEvent;
  app.onEvent = function(event, ...rest) {
    const kind = event?.type ?? event?.event?.type;
    if (['turn_complete', 'turn.completed', 'turn_error', 'turn.failed'].includes(kind)) lastEvent = kind;
    // Preserve a model/turn error before the native renderer handles it. A later
    // UI exception must not erase the provider's original failure or expose its
    // request object, headers or credentials. Ignore ordinary tool failures.
    if (current && (['model_request_failed', 'turn_error', 'turn.failed'].includes(kind) || (event?.kind === 'error' && !event.toolCallId && !event.toolName))) {
      const detail = event?.error?.message ?? (typeof event?.error === 'string' ? event.error : event?.message);
      if (typeof detail === 'string' && detail.trim()) lastFailure ??= redact(detail).slice(0, 2000);
    }
    return onEvent.call(this, event, ...rest);
  };
  app.finishTurn = function(state, ...rest) {
    const text = this.turnAssistantText || this.pendingTurnNotificationDetail || '';
    const notice = this.pendingTurnNotification, job = current;
    const status = state === 'cancelled' ? 'stopped' : notice === 'failed' || ['turn_error', 'turn.failed'].includes(lastEvent) ? 'failed' : notice === 'completed' || ['turn_complete', 'turn.completed'].includes(lastEvent) ? 'completed' : job?.stopRequested ? 'stopped' : 'unknown';
    const answer = finish.call(this, state, ...rest);
    if (job && !job.reported) job.terminal = { runNumber: job.runNumber, status: status === 'completed' && !text.trim() ? 'failed' : status, finalText: text, ...(status === 'failed' && lastFailure ? { error: lastFailure } : {}) };
    return answer;
  };
  async function execute(job, input, queued) {
    if (current || app.primaryTurnActive || app.activeSubmissions > 0) throw new Error('ZCode still has an active turn');
    if ((options.getMainSessionId?.() ?? app.sessionId) !== sessionId) throw new Error('ZCode session changed');
    if (app.model !== connection.model) throw new Error('ZCode model changed outside its owner');
    if (connection.effort !== undefined && app.thoughtLevel !== connection.effort) throw new Error('ZCode effort changed outside its owner');
    current = job; lastEvent = null; lastFailure = null;
    try {
      await submit.call(app, input, queued);
      if (!job.reported) {
        current = null; lastEvent = null; lastFailure = null; job.reported = true;
        // finishTurn runs inside submit. Notify only after submit has fully unwound.
        report(job.terminal ?? { runNumber: job.runNumber, status: 'failed', finalText: '', error: 'Native turn ended without a completion event' });
      }
    } catch (error) {
      if (!job.reported) {
        const secondary = redact(error.message);
        const detail = lastFailure && lastFailure !== secondary ? `${lastFailure}\nNative submit/render error: ${secondary}` : secondary;
        current = null; lastFailure = null; job.reported = true;
        report({ runNumber: job.runNumber, status: 'failed', finalText: '', error: detail });
      }
    }
  }
  app.submit = async function(input, queued) {
    const text = (queued?.input ?? input).trim();
    if (!text) return false;
    // A managed task may not silently jump to a different conversation or run a workflow outside its owner.
    if (text.startsWith('/')) {
      if (!['/exit', '/quit', '/cls', '/copy', '/transcript', '/activity'].includes(text)) { app.addNotice?.('Managed task: use the owner for session/model changes or new work.', 'warning'); return false; }
      return submit.call(this, input, queued);
    }
    if (current || app.primaryTurnActive || app.activeSubmissions > 0) { app.addNotice?.('Current task is running; wait for its completion before adding a new instruction.', 'warning'); return false; }
    try { const job = await post('/manual', { sessionId, prompt: text }); await execute(job, input, queued); return true; }
    catch (error) { app.addNotice?.(error.message, 'warning'); return false; }
  };
  await post('/register', { sessionId, model: app.model, effort: app.thoughtLevel ?? null, pid: process.pid, cwd: options.workspaceDirectory ?? process.cwd() });
  const commands = (async () => {
    while (!ended) {
      const r = await fetch(new URL('/command', url), { headers: { authorization: `Bearer ${connection.token}` }, signal: abort.signal });
      if (!r.ok) throw new Error('ZCode command channel ended');
      const cmd = await r.json();
      if (cmd.action === 'submit') {
        void execute({ runNumber: cmd.runNumber }, cmd.prompt, { input: cmd.prompt, displayInput: cmd.prompt, recordHistory: true }).catch(fail);
      } else if (cmd.action === 'stop') {
        if (current?.runNumber === cmd.runNumber) { current.stopRequested = true; app.requestForegroundTurnInterrupt(); }
      } else if (cmd.action === 'close') { app.stop(); break; }
      else throw new Error('Invalid ZCode command');
    }
  })().catch(error => { if (!ended) fail(error); });
  app.addNotice?.('BEYOND connected: visible session, owner notifications, same-session continuation.', 'muted');
  return { async close() {
    if (ended) return; ended = true; abort.abort();
    if (current && !current.reported) { current.reported = true; report({ runNumber: current.runNumber, status: 'unknown', finalText: '', error: 'ZCode window closed before a stable turn result' }); }
    await serial; await post('/ended', { sessionId }).catch(() => {}); await commands;
    app.submit = submit; app.finishTurn = finish; app.onEvent = onEvent;
  } };
}
