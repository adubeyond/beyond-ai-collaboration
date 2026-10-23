import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliTaskStore, atomicJson, digest } from './cli-task-store.mjs';
import { processStart, processIsGone } from './process-identity.mjs';
import { cliEnvironment, redact } from './native-cli-runner.mjs';
import { readClaudeProfile, claudeArguments } from './claude-profile.mjs';
import { claudeHookEvents, readClaudeHookText } from './claude-hook.mjs';
import { nativeHookAttentionKinds } from './cli-notify.mjs';

export function createClaudeControlTransport({ url, token, signal, diagnosticPath, fetchImpl = fetch }) {
  const fixedRoutes = new Set(['/command', '/register', '/manual', '/event', '/attention', '/ended']);
  const safe = value => redact(String(value).split(token).join('[REDACTED]')).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[URL]');
  async function traced(method, route, action) {
    const started = performance.now();
    try { return await action(); }
    catch (error) {
      if (!(method === 'GET' && signal.aborted)) {
        const name = safe(error?.name ?? 'Error'), cause = safe(error?.cause?.code ?? '');
        const record = { at: new Date().toISOString(), method, route: fixedRoutes.has(route) ? route : '[unknown-route]', elapsedMs: Math.round(performance.now() - started),
          errorName: /^[A-Za-z][A-Za-z0-9]*(?:Error|Exception)$|^Error$/.test(name) ? name : 'Error',
          causeCode: /^[A-Z0-9_]{1,80}$/.test(cause) ? cause : null,
          stackFrames: String(error?.stack ?? '').split(/\r?\n/).filter(line => /^\s+at\s/.test(line)).slice(0, 12).map(line => safe(line).slice(0, 512)) };
        try { fs.appendFileSync(diagnosticPath, JSON.stringify(record) + '\n', { mode: 0o600 }); }
        catch { process.stderr.write('Claude control fetch diagnostic unavailable\n'); }
      }
      throw error;
    }
  }
  return {
    post(route, data) {
      return traced('POST', route, async () => {
        const response = await fetchImpl(new URL(route, url), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(6000) });
        const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Claude owner rejected event'); return value;
      });
    },
    nextCommand() {
      return traced('GET', '/command', async () => {
        const response = await fetchImpl(new URL('/command', url), { headers: { authorization: `Bearer ${token}` }, signal });
        if (response.status === 204) return { idle: true };
        if (!response.ok) throw new Error('Claude command channel ended');
        return { idle: false, command: await response.json() };
      });
    },
  };
}

export function sendClaudePrompt(transport, prompt) {
  if (!transport?.pipe?.startsWith('\\\\.\\pipe\\') || !transport.token) throw new Error('Claude local messaging pipe unavailable');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(transport.pipe);
    socket.setTimeout(6000, () => socket.destroy(new Error('Claude message delivery unconfirmed')));
    socket.once('error', () => reject(new Error('Claude message delivery unconfirmed')));
    socket.once('connect', () => socket.end([JSON.stringify({ type: 'auth', token: transport.token }), JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })].join('\n') + '\n', resolve));
  });
}

// Correlate a native terminal notification with this run's native tool evidence.
// Older native hooks omit source: this is not authentication of arbitrary prompt text.
function backgroundCompletion(input) {
  if (input.source != null && input.source !== 'system') return null;
  const match = /^<task-notification>\s*<task-id>([A-Za-z0-9_-]+)<\/task-id>\s*(?:<tool-use-id>([^<>]+)<\/tool-use-id>\s*)?(?:<task-type>[^<>]+<\/task-type>\s*)?(?:<output-file>[^<>]+<\/output-file>\s*)?<status>(completed|failed|killed|stopped)<\/status>\s*<summary>[^<>]+<\/summary>\s*(?:<note>[^<>]+<\/note>\s*)?<\/task-notification>$/.exec(input.prompt.trim());
  return match ? { taskId: match[1], toolUseId: match[2] } : null;
}

// Observe only bytes appended after an accepted instruction, in its exact native
// transcript. No timeout guesses, transcript discovery, permission changes or stops.
export function watchClaudeFailures({ transcriptPath, sessionId, cwd, onSignal, onBackground = () => {}, diagnose = () => {}, allowMissingTranscript = false }) {
  if (!path.isAbsolute(transcriptPath ?? '') || path.basename(transcriptPath) !== `${sessionId}.jsonl`) throw new Error('Claude attention transcript identity mismatch');
  const directory = fs.realpathSync(path.dirname(transcriptPath)), root = fs.realpathSync(cwd);
  const expected = path.join(directory, path.basename(transcriptPath));
  let physical = null, fileIdentity = null, offset = 0;
  try {
    const stat = fs.lstatSync(transcriptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Claude attention transcript is not a regular file');
    physical = fs.realpathSync(transcriptPath); fileIdentity = [stat.dev, stat.ino]; offset = stat.size;
  } catch (error) {
    // Native UserPromptSubmit precedes creation of a new transcript. Watch only
    // its existing parent directory; do not discover another file or scan history.
    if (error.code !== 'ENOENT' || !allowMissingTranscript) throw error;
  }
  let pending = Buffer.alloc(0), closed = false, watcher, delivery = Promise.resolve(), alerted = false;
  let desired = null, inFlight = null, scheduled = false, alertedTool = null, attemptedTool = null;
  const tools = new Map(), toolInputs = new Map(), seen = new Set(), failures = new Map();
  // Explicit questions/denials are independent incidents within a native turn.
  // Keep only identifiers and offsets; business questions and credentials stay
  // in the native transcript, not in the wake-up message or managed evidence.
  const incidents = new Map(), pendingIncidents = new Map(), knownQuestions = new Set();
  let incidentDeliveryScheduled = false;
  const diagnostic = event => { try { diagnose({ event }); } catch { /* Observing must never stop the native task. */ } };
  function incident(code, itemId, tool, firstOffset, lastOffset, inputDigest = null) {
    if (!/^[\w.-]{1,128}$/.test(itemId ?? '')) return;
    const key = `${code}:${itemId}`;
    if (incidents.has(key)) return;
    const item = { signal: { status: 'blocked', code, itemId, tool, count: 1, firstOffset, lastOffset }, inputDigest, attempted: false, failed: false };
    incidents.set(key, item); pendingIncidents.set(key, item.signal);
  }
  function resolveIncident(key) {
    const item = incidents.get(key);
    if (!item) return;
    incidents.delete(key);
    // Cancel an unsent question answered in the same batch; if delivery might
    // have reached the manager, explicitly resolve it even after a lost reply.
    if (item.attempted) pendingIncidents.set(key, { ...item.signal, status: 'recovered' });
    else pendingIncidents.delete(key);
  }
  function dispatchIncidents() {
    if (incidentDeliveryScheduled || !pendingIncidents.size || closed) return;
    incidentDeliveryScheduled = true;
    delivery = delivery.then(async () => {
      while (!closed && pendingIncidents.size) {
        const [key, signal] = pendingIncidents.entries().next().value;
        pendingIncidents.delete(key);
        if (signal.status === 'blocked') {
          const item = incidents.get(key);
          if (!item) continue;
          item.attempted = true;
        }
        try { await onSignal({ ...signal, transcriptPath: physical }); const item = incidents.get(key); if (item) item.failed = false; }
        catch { const item = incidents.get(key); if (item) item.failed = true; diagnostic('attention-delivery-unavailable'); }
      }
    }).finally(() => { incidentDeliveryScheduled = false; if (pendingIncidents.size) dispatchIncidents(); });
  }
  function dispatch() {
    if (scheduled || !desired || closed) return;
    scheduled = true;
    let attempted;
    delivery = delivery.then(async () => {
      attempted = desired;
      if (!attempted || closed) return;
      inFlight = attempted;
      try {
        // A lost HTTP response does not prove the manager missed the signal.
        // A later recovery must also clear that possibly persisted evidence.
        if (attempted.status === 'blocked') attemptedTool ??= attempted.tool;
        await onSignal({ ...attempted, transcriptPath: physical });
        if (attempted.status === 'blocked') { alerted = true; alertedTool = attempted.tool; }
        if (desired === attempted || (attempted.status === 'blocked' && desired?.status === 'blocked')) desired = null;
      } catch { diagnostic('attention-delivery-unavailable'); }
      finally { inFlight = null; }
    }).finally(() => {
      scheduled = false;
      // Only newer evidence/recovery warrants another attempt, not a retry timer.
      if (desired && desired !== attempted) dispatch();
    });
  }
  function record(line, endOffset, startOffset) {
    let row; try { row = JSON.parse(line); } catch { return; }
    if (row.sessionId !== sessionId || row.isSidechain || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) return;
    // Native compaction can retain a real project subdirectory in transcript
    // records. Keep the bound session/root, and reject missing or escaping cwd.
    let relative;
    try {
      const actualCwd = fs.realpathSync(row.cwd);
      if (!fs.statSync(actualCwd).isDirectory()) return;
      relative = path.relative(root, actualCwd);
    } catch { return; }
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    const content = row.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (row.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && /^[\w.-]{1,128}$/.test(block.name ?? '')) {
        tools.set(block.id, block.name); toolInputs.set(block.id, block.input && typeof block.input === 'object' ? digest(block.input) : null);
        if (tools.size > 512) { const oldest = tools.keys().next().value; tools.delete(oldest); toolInputs.delete(oldest); }
        if (block.name === 'AskUserQuestion' && !knownQuestions.has(block.id)) {
          knownQuestions.add(block.id); if (knownQuestions.size > 512) knownQuestions.delete(knownQuestions.values().next().value);
          // A concrete follow-up question replaces an unsent generic denial
          // reminder. This cancels notification only; it never grants permission.
          for (const [key, item] of incidents) if (item.signal.code === 'permission-denied') resolveIncident(key);
          incident('question-awaiting-answer', block.id, block.name, startOffset, endOffset);
        }
      }
      if (row.type !== 'user' || block.type !== 'tool_result' || !tools.has(block.tool_use_id) || seen.has(block.tool_use_id)) continue;
      const tool = tools.get(block.tool_use_id), inputDigest = toolInputs.get(block.tool_use_id);
      tools.delete(block.tool_use_id); toolInputs.delete(block.tool_use_id);
      seen.add(block.tool_use_id); if (seen.size > 1024) seen.delete(seen.values().next().value);
      if (tool === 'AskUserQuestion') resolveIncident(`question-awaiting-answer:${block.tool_use_id}`);
      if (!block.is_error) {
        // This is native structured result metadata, not a task id mentioned in
        // shell output. The matching tool invocation was observed after run start.
        const taskId = row.toolUseResult?.backgroundTaskId;
        if (['PowerShell', 'Bash'].includes(tool) && content.filter(item => item.type === 'tool_result').length === 1
          && typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(taskId))
          onBackground({ taskId, toolUseId: block.tool_use_id });
        // A different PowerShell command succeeding does not resolve a refused
        // deployment. Only identical tool input can cancel that reminder.
        if (inputDigest) for (const [key, item] of incidents)
          if (item.signal.code === 'permission-denied' && item.signal.tool === tool && item.inputDigest === inputDigest) resolveIncident(key);
        if (failures.has(tool)) {
          if (alertedTool === tool || attemptedTool === tool || (inFlight?.status === 'blocked' && inFlight.tool === tool)) desired = { status: 'recovered', code: 'permission-classifier-unavailable', tool };
          else if (desired?.tool === tool) desired = null;
        }
        failures.delete(tool); continue;
      }
      if (row.classifierBoundary === true && row.toolDenialKind === 'automode-blocked'
        && row.permissionDecision?.decision === 'reject' && row.permissionDecision?.reasonType === 'classifier') {
        // Repeated denials of the same tool remain one outstanding incident,
        // rather than repeatedly waking the owner while the model retries it.
        const existing = [...incidents.entries()].find(([, item]) => item.signal.code === 'permission-denied' && item.signal.tool === tool && inputDigest && item.inputDigest === inputDigest);
        if (!existing) incident('permission-denied', block.tool_use_id, tool, startOffset, endOffset, inputDigest);
        else if (existing[1].failed) pendingIncidents.set(existing[0], existing[1].signal);
        continue;
      }
      // Permission denials are not PostToolUseFailure hooks. The native transcript
      // distinguishes a real denial from unavailable classification; do not bypass either.
      if (row.classifierBoundary !== true || row.toolDenialKind !== 'automode-unavailable'
        || row.permissionDecision?.decision !== 'reject' || row.permissionDecision?.reasonType !== 'classifier') continue;
      const prior = failures.get(tool) ?? { count: 0, firstOffset: endOffset };
      prior.count++; failures.set(tool, prior);
      if (prior.count >= 3 && !alerted && (!attemptedTool || attemptedTool === tool)) {
        desired = { status: 'blocked', code: 'permission-classifier-unavailable', tool, count: prior.count, firstOffset: prior.firstOffset, lastOffset: endOffset };
      }
    }
  }
  function scan() {
    if (closed) return;
    const beforeOffset = offset;
    let fd;
    try {
      let next;
      try { next = fs.lstatSync(transcriptPath); }
      catch (error) { if (!physical && error.code === 'ENOENT') return; throw error; }
      const actual = fs.realpathSync(transcriptPath);
      if (!next.isFile() || next.isSymbolicLink() || actual !== (physical ?? expected) || next.size < offset
        || (fileIdentity && (next.dev !== fileIdentity[0] || next.ino !== fileIdentity[1]))) throw new Error('Claude attention transcript changed');
      physical ??= actual; fileIdentity ??= [next.dev, next.ino];
      fd = fs.openSync(transcriptPath, 'r');
      while (offset < next.size) {
        const bytes = Buffer.alloc(Math.min(65536, next.size - offset)), length = fs.readSync(fd, bytes, 0, bytes.length, offset);
        if (!length) break;
        offset += length; pending = Buffer.concat([pending, bytes.subarray(0, length)]);
        let end;
        while ((end = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, end).toString('utf8'), endOffset = offset - pending.length + end + 1;
          const startOffset = offset - pending.length;
          pending = pending.subarray(end + 1); record(line, endOffset, startOffset);
        }
        if (pending.length > 2 * 1024 * 1024) throw new Error('Claude attention record too large');
      }
      if (offset > beforeOffset) { dispatch(); dispatchIncidents(); }
    } catch { close(); diagnostic('attention-observer-unavailable'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function close() { closed = true; watcher?.close(); }
  watcher = fs.watch(directory, (_event, file) => { if (!file || String(file) === path.basename(transcriptPath)) scan(); });
  watcher.on('error', () => { close(); diagnostic('attention-observer-unavailable'); });
  scan();
  return { close, async flush({ waitForDelivery = true } = {}) {
    scan();
    // Hook identity checks need the synchronous task registration, not a wait
    // for unrelated attention HTTP delivery within the native hook deadline.
    if (!waitForDelivery) return;
    for (;;) { const currentDelivery = delivery; await currentDelivery; if (currentDelivery === delivery) return; }
  } };
}

// One live native session, one foreground instruction. Hooks carry evidence, not acceptance.
export function createClaudeSession({ sessionId, model, cwd, pid, post, resuming = false, deliver = sendClaudePrompt, terminate, diagnose = () => {}, observeFailures = watchClaudeFailures }) {
  let registered = false, transport, transcriptPath, observation, current = null, stopped = false, ended = false, rejectedSubmission = false, observedInstruction = false;
  const sameSession = input => { if (input.session_id !== sessionId) throw new Error('Claude session identity changed'); };
  const observerDiagnostic = record => { try { diagnose(record); } catch { /* Optional observation must not stop execution. */ } };
  async function hookAttention(job, code, hookEvent, count = 1) {
    if (current !== job || stopped || ended || job.attention?.has(code)) return;
    (job.attention ??= new Set()).add(code);
    const { itemId, tool } = nativeHookAttentionKinds[code];
    try {
      await post('/attention', { sessionId, runNumber: job.runNumber, status: 'blocked', code,
        itemId, tool, count, evidenceKind: 'native-hook', hookEvent });
    } catch {
      job.attention.delete(code);
      observerDiagnostic({ event: 'attention-delivery-unavailable', runNumber: job.runNumber });
    }
  }
  function observerUnavailable(job, event = 'attention-observer-unavailable') {
    job.observerUnavailable = true;
    observerDiagnostic({ event, runNumber: job.runNumber });
    void hookAttention(job, 'attention-observer-unavailable', 'UserPromptSubmit');
  }
  function observe(job, input) {
    observation?.close(); observation = null;
    // A missing resumed transcript could later be restored with old same-session
    // records. Only a newly launched session's first instruction starts at zero.
    const allowMissingTranscript = !resuming && !observedInstruction;
    observedInstruction = true;
    const file = input.transcript_path ?? transcriptPath;
    if (!file) { observerUnavailable(job, 'attention-transcript-unavailable'); return; }
    try {
      observation = observeFailures({ transcriptPath: file, sessionId, cwd, allowMissingTranscript,
        diagnose: record => record.event === 'attention-observer-unavailable' ? observerUnavailable(job) : observerDiagnostic(record),
        // Registration is synchronous with scanning. A hook flush sees the same
        // native evidence even when fs.watch has not delivered its callback yet.
        onBackground: ({ taskId, toolUseId }) => {
          if (current !== job || stopped || ended) return;
          (job.background ??= new Set()).add(taskId);
          (job.backgroundTools ??= new Map()).set(taskId, toolUseId);
        },
        onSignal: signal => current === job && !stopped && !ended ? post('/attention', { sessionId, runNumber: job.runNumber, ...signal }) : undefined });
    } catch { observerUnavailable(job); }
  }
  async function report(status, text = '', error = null) {
    if (!current) return;
    observation?.close(); observation = null;
    const job = current; current = null;
    await post('/event', { sessionId, runNumber: job.runNumber, status, finalText: text, error });
  }
  return {
    get registered() { return registered; },
    async command(command) {
      if (command.action === 'submit') {
        if (!registered || current || ended) throw new Error('Claude native session is not idle');
        const job = current = { runNumber: command.runNumber, prompt: command.prompt, seen: false }; stopped = false; rejectedSubmission = false;
        try { await deliver(transport, command.prompt); }
        catch (error) { if (current === job) { await report('unknown', '', error.message); terminate(); } }
      } else if (command.action === 'stop') {
        if (!current || command.runNumber !== current.runNumber) throw new Error('Claude stop run mismatch');
        stopped = true; terminate(); // Completion is recorded only after this exact child exits.
      } else if (command.action === 'close') { terminate(); }
      else throw new Error('Invalid Claude command');
    },
    async hook(input, suppliedTransport) {
      sameSession(input);
      if (input.agent_id) return {}; // Never bind a subagent's lifecycle to the owner's turn.
      if (input.hook_event_name === 'SessionStart') {
        const actualCwd = fs.realpathSync(input.cwd), root = fs.realpathSync(cwd);
        const relative = path.relative(root, actualCwd);
        // Native compaction keeps the current shell directory. A build inside a
        // project subdirectory must not invalidate this already-bound session.
        // Initial/resume binding stays exact; real paths reject junction escapes.
        const projectCompaction = registered && input.source === 'compact'
          && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        if (actualCwd !== root && !projectCompaction) throw new Error('Claude cwd identity mismatch');
        // This native version omits model in resume hooks. The explicit --model argument
        // still owns selection; only an exact saved-session resume may use that evidence.
        const missingOnResume = input.model == null && input.source === 'resume' && resuming;
        const missingAfterCompaction = input.model == null && input.source === 'compact' && registered;
        if (input.model !== model && !missingOnResume && !missingAfterCompaction) throw new Error(`Claude model identity mismatch: expected ${model}; received ${String(input.model)}`);
        if (!suppliedTransport?.pipe?.startsWith('\\\\.\\pipe\\') || !suppliedTransport.token) throw new Error('Claude local messaging pipe unavailable');
        transport = suppliedTransport;
        transcriptPath = input.transcript_path ?? transcriptPath;
        if (!registered) { await post('/register', { sessionId, model, cwd, pid }); registered = true; }
      } else if (input.hook_event_name === 'PreModelSwitch') {
        return { decision: 'block', reason: 'Ask the owner to detach the idle view and resume this same session with its next-run model and effort.' };
      } else if (input.hook_event_name === 'UserPromptSubmit') {
        if (!registered || ended || typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('Unregistered Claude input');
        // Record comparison evidence, not business text or transport credentials.
        diagnose({ event: 'user-prompt-check', at: new Date().toISOString(), sessionId,
          runNumber: current?.runNumber ?? null, currentSeen: current?.seen ?? null,
          expectedLength: current?.prompt.length ?? null, actualLength: input.prompt.length,
          expectedSha256: current ? crypto.createHash('sha256').update(current.prompt).digest('hex') : null,
          actualSha256: crypto.createHash('sha256').update(input.prompt).digest('hex'),
          promptMatches: current ? input.prompt === current.prompt : null });
        if (rejectedSubmission) return { decision: 'block', reason: 'Managed input was rejected; the owner must review and resume this session.' };
        if (current) {
          const job = current;
          if (job.seen && !stopped) await observation?.flush({ waitForDelivery: false });
          if (current !== job || ended) return { decision: 'block', reason: 'The managed instruction changed while checking native evidence.' };
          if (job.observerUnavailable) void hookAttention(job, 'attention-observer-unavailable', 'UserPromptSubmit');
          const completion = job.seen && !stopped && backgroundCompletion(input);
          const taskId = completion?.taskId, toolUseId = job.backgroundTools?.get(taskId);
          if (taskId && job.background?.has(taskId) && !job.delivered?.has(taskId)
            && (!toolUseId || completion.toolUseId == null || completion.toolUseId === toolUseId)) {
            (job.delivered ??= new Set()).add(taskId);
            return {}; // Continue the original native run; only a later Stop reports a result.
          }
          if (stopped) return { decision: 'block', reason: 'The current managed instruction is stopping.' };
          if (current.seen) return { decision: 'block', reason: 'The current managed instruction is still running.' };
          if (input.prompt !== current.prompt) {
            // No work began. Finish the rejected run, but do not let a repeated hook
            // enter /manual and create an unapproved round after report clears current.
            rejectedSubmission = true;
            await report('failed', '', 'Claude rejected the delivered instruction: prompt content mismatch before execution');
            return { decision: 'block', reason: 'Managed input differs from the approved instruction; this run failed before execution.' };
          }
          current.seen = true;
          observe(current, input);
          diagnose({ event: 'managed-prompt-started', at: new Date().toISOString(), sessionId, runNumber: current.runNumber });
        } else {
          if (input.prompt.trim().startsWith('<task-notification>')) return { decision: 'block', reason: 'No managed instruction is awaiting this background notification.' };
          const job = await post('/manual', { sessionId, prompt: input.prompt });
          current = { runNumber: job.runNumber, prompt: input.prompt, seen: true }; stopped = false;
          observe(current, input);
        }
      } else if (input.hook_event_name === 'Stop') {
        if (!current) return {};
        if (!current.seen) throw new Error('Claude completion lacks prompt-start evidence');
        const job = current;
        await observation?.flush({ waitForDelivery: false });
        if (current !== job || stopped || ended) return {};
        // A response may merely be waiting for background work; do not announce finality then.
        const tasks = input.background_tasks ?? [];
        const knownTasks = Array.isArray(tasks) && tasks.every(task => task && typeof task.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(task.id)
          && ['running', 'pending', 'completed', 'failed', 'killed', 'stopped'].includes(task.status));
        if (!knownTasks) { await hookAttention(job, 'background-state-unavailable', 'Stop'); return {}; }
        job.background = new Set(tasks.filter(task => ['running', 'pending'].includes(task.status)).map(task => task.id));
        if (input.session_crons?.length) {
          await hookAttention(job, 'session-cron-awaiting-owner', 'Stop', input.session_crons.length);
          return {};
        }
        if (job.background.size) return {};
        const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
        await report(text.trim() ? 'completed' : 'failed', text, text.trim() ? null : 'Claude ended without an answer');
      } else if (input.hook_event_name === 'StopFailure') {
        if (current?.seen) await report('failed', '', 'Claude API turn failed');
      } else if (input.hook_event_name === 'SessionEnd') { ended = true; observation?.close(); observation = null; }
      else throw new Error('Unsupported Claude hook');
      return {};
    },
    async nativeEnded(error = null) {
      ended = true;
      await report(stopped ? 'stopped' : 'unknown', '', error ?? 'Claude process exited before a stable response');
      if (registered) await post('/ended', { sessionId });
    }
  };
}

export function openClaudeWindow(store, binding) {
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const command = `$Host.UI.RawUI.WindowTitle = 'BEYOND - Claude Code'; & ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --view ${quote(store.locator(binding))}`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const launch = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-EncodedCommand','${encoded}') -WindowStyle Normal -PassThru; $p.Id`;
  const answer = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (answer.status !== 0 || !/^\d+$/.test(answer.stdout.trim())) throw new Error('Claude native window launch failed');
  const windowPid = Number(answer.stdout.trim());
  let windowStartedAt;
  try { windowStartedAt = processStart(windowPid); } catch { /* Preserve missing proof when the window already exited or identity is unavailable. */ }
  return { windowPid, ...(windowStartedAt ? { windowStartedAt } : {}), transport: 'external-native-terminal' };
}

export async function launchClaudeView(taskFile) {
  const binding = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  const store = new CliTaskStore({ controlRoot: path.resolve(path.dirname(taskFile), '../../../../..') });
  if (path.resolve(taskFile) !== store.locator(binding)) throw new Error('Claude task locator mismatch');
  const endpoint = store.readJson(path.join(store.taskDir(binding), 'interactive.json'));
  if (endpoint.provider !== 'claude' || endpoint.ownerThreadId !== binding.ownerThreadId || endpoint.status !== 'starting') throw new Error('Claude launch is not awaiting a view');
  const directory = store.runDir(binding, binding.runNumber);
  const hookFile = store.checkedPath(path.join(directory, 'claude-hook-connection.json'));
  const settingsFile = store.checkedPath(path.join(directory, 'claude-settings.json'));
  let child, identity, session, server, startup, closed, queue = Promise.resolve(), code = 1, fault = null, commandLoop;
  const abort = new AbortController(), hookToken = crypto.randomBytes(32).toString('hex');
  const terminate = () => { if (child && identity && !processIsGone(identity)) child.kill(); };
  const fail = error => { fault ??= redact(error.message); process.stderr.write(fault + '\n'); terminate(); };
  try {
    const profile = readClaudeProfile(store.readJson(path.join(directory, 'run.json')).profile ?? JSON.parse(fs.readFileSync(binding.profilePath, 'utf8')));
    if (digest(profile) !== endpoint.profileSha256) throw new Error('Claude profile changed before launch');
    const connection = store.readJson(endpoint.connectionPath), sessionId = binding.sessionId ?? crypto.randomUUID();
    const url = new URL(connection.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || !connection.token) throw new Error('Invalid Claude owner endpoint');
    const transport = createClaudeControlTransport({ url, token: connection.token, signal: abort.signal,
      diagnosticPath: store.checkedPath(path.join(directory, 'claude-control-fetch-errors.jsonl')) });
    const post = transport.post;
    async function commands() {
      try {
        while (!abort.signal.aborted) {
          const response = await transport.nextCommand();
          if (!response.idle) await session.command(response.command);
        }
      } catch (error) { if (!abort.signal.aborted) fail(error); }
    }
    server = http.createServer((request, response) => {
      if (request.headers.origin || request.headers.authorization !== `Bearer ${hookToken}` || request.method !== 'POST' || request.url !== '/hook') { response.writeHead(403); response.end(); return; }
      const handle = async () => {
        const text = await readClaudeHookText(request);
        const { input, transport } = JSON.parse(text);
        if (input.hook_event_name === 'SessionStart') atomicJson(store.checkedPath(path.join(directory, 'claude-session-start.json')), { sessionId: input.session_id, cwd: input.cwd, reportedModel: input.model ?? null, requestedModel: profile.model, requestedEffort: profile.effort ?? null, source: input.source ?? null });
        const result = await session.hook(input, transport);
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
        if (session.registered && !commandLoop) { clearTimeout(startup); commandLoop = commands(); }
      };
      queue = queue.then(handle).catch(error => { if (!response.writableEnded) { response.writeHead(409); response.end('{}'); } fail(error); });
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    atomicJson(hookFile, { url: `http://127.0.0.1:${server.address().port}/`, token: hookToken });
    atomicJson(settingsFile, { hooks: Object.fromEntries(claudeHookEvents.map(event => [event, [{ hooks: [{ type: 'command', command: process.execPath, args: [fileURLToPath(new URL('./claude-hook.mjs', import.meta.url)), event], timeout: 8 }] }]])) });
    const env = cliEnvironment(''); env.BEYOND_CLAUDE_HOOK_CONNECTION = hookFile;
    if (profile.effort) env.CLAUDE_CODE_EFFORT_LEVEL = profile.effort;
    child = spawn(profile.runner.command, claudeArguments(profile, binding, settingsFile, sessionId), { cwd: binding.executionRoot, env, stdio: ['inherit', 'inherit', 'pipe'] });
    const stderrPath = store.checkedPath(path.join(directory, 'stderr.log'));
    let pendingError = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => {
      pendingError += text; let end;
      while ((end = pendingError.indexOf('\n')) >= 0) { const line = redact(pendingError.slice(0, end + 1)); pendingError = pendingError.slice(end + 1); fs.appendFileSync(stderrPath, line); process.stderr.write(line); }
      if (pendingError.length > 1024 * 1024) pendingError = '[oversized stderr line omitted]\n';
    });
    closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', status => resolve(status ?? 1)); });
    closed.catch(() => {});
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    identity = { pid: child.pid, startedAt: processStart(child.pid), token: crypto.randomUUID() };
    store.setChildProcess(store.readJson(path.join(directory, 'run.json')), identity); // Proof survives a trust or registration failure.
    session = createClaudeSession({ sessionId, model: profile.model, cwd: binding.executionRoot, pid: child.pid, post, terminate, resuming: Boolean(binding.sessionId),
      diagnose(record) {
        const currentRun = store.read(binding).runNumber;
        fs.appendFileSync(store.checkedPath(path.join(store.runDir(binding, currentRun), 'claude-input-checks.jsonl')), JSON.stringify(record) + '\n', { mode: 0o600 });
      } });
    startup = setTimeout(() => fail(new Error('Claude did not register its native session; inspect the visible window')), 25000);
    code = await closed;
    if (pendingError) { const line = redact(pendingError); fs.appendFileSync(stderrPath, line); process.stderr.write(line); }
    abort.abort(); await queue; await session.nativeEnded(fault).catch(error => { fault ??= redact(error.message); });
  } catch (error) { fault = redact(error.message); terminate(); if (closed) await closed.catch(() => {}); throw error;
  } finally {
    clearTimeout(startup); abort.abort(); await commandLoop;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (fs.existsSync(hookFile)) fs.unlinkSync(hookFile);
    atomicJson(store.checkedPath(endpoint.viewExitPath), { launchId: endpoint.launchId, exitCode: code, error: fault });
  }
  return code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv[2] !== '--view' || !path.isAbsolute(process.argv[3] ?? '')) throw new Error('Use --view <task.json>'); process.exitCode = await launchClaudeView(process.argv[3]); }
  catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
