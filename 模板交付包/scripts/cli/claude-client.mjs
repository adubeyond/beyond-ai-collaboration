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
import { claudeHookEvents } from './claude-hook.mjs';

export function sendClaudePrompt(transport, prompt) {
  if (!transport?.pipe?.startsWith('\\\\.\\pipe\\') || !transport.token) throw new Error('Claude local messaging pipe unavailable');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(transport.pipe);
    socket.setTimeout(6000, () => socket.destroy(new Error('Claude message delivery unconfirmed')));
    socket.once('error', () => reject(new Error('Claude message delivery unconfirmed')));
    socket.once('connect', () => socket.end([JSON.stringify({ type: 'auth', token: transport.token }), JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })].join('\n') + '\n', resolve));
  });
}

// One live native session, one foreground instruction. Hooks carry evidence, not acceptance.
export function createClaudeSession({ sessionId, model, cwd, pid, post, resuming = false, deliver = sendClaudePrompt, terminate }) {
  let registered = false, transport, current = null, stopped = false, ended = false;
  const sameSession = input => { if (input.session_id !== sessionId) throw new Error('Claude session identity changed'); };
  async function report(status, text = '', error = null) {
    if (!current) return;
    const job = current; current = null;
    await post('/event', { sessionId, runNumber: job.runNumber, status, finalText: text, error });
  }
  return {
    get registered() { return registered; },
    async command(command) {
      if (command.action === 'submit') {
        if (!registered || current || ended) throw new Error('Claude native session is not idle');
        current = { runNumber: command.runNumber, prompt: command.prompt, seen: false }; stopped = false;
        try { await deliver(transport, command.prompt); }
        catch (error) { await report('unknown', '', error.message); terminate(); }
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
        if (fs.realpathSync(input.cwd) !== fs.realpathSync(cwd)) throw new Error('Claude cwd identity mismatch');
        // This native version omits model in resume hooks. The explicit --model argument
        // still owns selection; only an exact saved-session resume may use that evidence.
        const missingOnResume = input.model == null && input.source === 'resume' && resuming;
        const missingAfterCompaction = input.model == null && input.source === 'compact' && registered;
        if (input.model !== model && !missingOnResume && !missingAfterCompaction) throw new Error(`Claude model identity mismatch: expected ${model}; received ${String(input.model)}`);
        if (!suppliedTransport?.pipe?.startsWith('\\\\.\\pipe\\') || !suppliedTransport.token) throw new Error('Claude local messaging pipe unavailable');
        transport = suppliedTransport;
        if (!registered) { await post('/register', { sessionId, model, cwd, pid }); registered = true; }
      } else if (input.hook_event_name === 'PreModelSwitch') {
        return { decision: 'block', reason: 'Ask the owner to detach the idle view and resume this same session with its next-run model and effort.' };
      } else if (input.hook_event_name === 'UserPromptSubmit') {
        if (!registered || ended || typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('Unregistered Claude input');
        if (current) {
          if (current.seen || input.prompt !== current.prompt) return { decision: 'block', reason: 'The current managed instruction is still running.' };
          current.seen = true;
        } else {
          const job = await post('/manual', { sessionId, prompt: input.prompt });
          current = { runNumber: job.runNumber, prompt: input.prompt, seen: true }; stopped = false;
        }
      } else if (input.hook_event_name === 'Stop') {
        if (!current) return {};
        if (!current.seen) throw new Error('Claude completion lacks prompt-start evidence');
        // A response may merely be waiting for background work; do not announce finality then.
        if (input.background_tasks?.length || input.session_crons?.length) return {};
        const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
        await report(text.trim() ? 'completed' : 'failed', text, text.trim() ? null : 'Claude ended without an answer');
      } else if (input.hook_event_name === 'StopFailure') {
        await report('failed', '', 'Claude API turn failed');
      } else if (input.hook_event_name === 'SessionEnd') { ended = true; }
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
  return { windowPid: Number(answer.stdout.trim()), transport: 'external-native-terminal' };
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
    const post = async (route, data) => {
      const response = await fetch(new URL(route, url), { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(6000) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Claude owner rejected event'); return value;
    };
    async function commands() {
      try {
        while (!abort.signal.aborted) {
          const response = await fetch(new URL('/command', url), { headers: { authorization: `Bearer ${connection.token}` }, signal: abort.signal });
          if (!response.ok) throw new Error('Claude command channel ended');
          await session.command(await response.json());
        }
      } catch (error) { if (!abort.signal.aborted) fail(error); }
    }
    server = http.createServer((request, response) => {
      if (request.headers.origin || request.headers.authorization !== `Bearer ${hookToken}` || request.method !== 'POST' || request.url !== '/hook') { response.writeHead(403); response.end(); return; }
      const handle = async () => {
        let text = ''; for await (const bytes of request) { text += bytes; if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Claude hook too large'); }
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
    session = createClaudeSession({ sessionId, model: profile.model, cwd: binding.executionRoot, pid: child.pid, post, terminate, resuming: Boolean(binding.sessionId) });
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
