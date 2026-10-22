import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { atomicJson, digest } from './cli-task-store.mjs';
import { processStart } from './process-identity.mjs';
import { buildCliContext } from './cli-context.mjs';
export { processStart } from './process-identity.mjs';
export function redact(text) {
  return String(text).replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
}
function keepCliPathEntry(entry, tempRoot) {
  // Old isolated BEYOND .NET runs left these tool directories in User PATH.
  // Only remove a proven-missing local temp entry; never trim the whole PATH.
  if (!/^[a-z]:[\\/]/i.test(entry) || /[%$"]/.test(entry)
    || entry.split(/[\\/]/).some(part => part === '.' || part === '..')) return true;
  const parts = path.win32.relative(tempRoot, entry).split(/[\\/]/);
  if (!/^beyond-[a-z0-9_-]+$/i.test(parts[0])
    || parts.slice(-3).join('/').toLowerCase() !== 'dotnet-home/.dotnet/tools') return true;
  try { fs.statSync(entry); return true; }
  catch (error) { return !['ENOENT', 'ENOTDIR'].includes(error.code); }
}
export function cliEnvironment(home) {
  const env = { ...process.env, CODEX_HOME: home };
  for (const key of Object.keys(env)) if (/^(OPENAI_|CODEX_(THREAD|TURN|APP|AUTH|API|SESSION))/.test(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  if (process.platform === 'win32') {
    const tempRoot = os.tmpdir();
    if (/^[a-z]:[\\/]/i.test(tempRoot)) {
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'path')
        env[key] = env[key].split(';').filter(entry => keepCliPathEntry(entry, tempRoot)).join(';');
    }
  }
  // Suppress the SDK's first-run User PATH write, not tool installation or use.
  const dotnetPathKey = 'DOTNET_ADD_GLOBAL_TOOLS_TO_PATH';
  if (!Object.keys(env).some(key => (process.platform === 'win32' ? key.toUpperCase() : key) === dotnetPathKey))
    env[dotnetPathKey] = 'false';
  env.CODEX_HOME = home; return env;
}
export function stageInstruction(stage) {
  if (!stage) return '';
  return [`Current round deliverable: ${stage.goal}`, `Current round acceptance: ${stage.acceptance}`,
    'The full goal above remains in force. This stage limits this round, not the overall goal or its authorization. Complete this stage, report its evidence and remaining work toward the full goal, then end this round. Do not expand into later stages or claim the full goal is complete merely because this stage is done.'].join('\n');
}
export async function runNativeCli({ binding, run, profile, prompt, store, onTerminal }) {
  const directory = store.runDir(run, run.runNumber), eventsPath = store.checkedPath(path.join(directory, 'events.jsonl'));
  const stderrPath = store.checkedPath(path.join(directory, 'stderr.log')), finalPath = store.checkedPath(path.join(directory, 'final.txt'));
  const args = [...profile.runner.args, 'exec', ...(run.sessionId ? ['resume', run.sessionId] : []), '--skip-git-repo-check', '--json', '--output-last-message', finalPath, '--model', profile.model, '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"', ...(profile.effort ? ['-c', `model_reasoning_effort="${profile.effort}"`] : []), '-'];
  const contract = run.effectiveContract ?? binding.contract;
  const context = buildCliContext({ binding, run, controlRoot: store.controlRoot });
  atomicJson(store.checkedPath(path.join(directory, 'document-context.json')), context.manifest);
  const instruction = [
    'You are a CLI execution session managed by one Desktop owner. Do not send Desktop callbacks or worker-result receipts. Return evidence; the owner decides goal completion.',
    'Current effective contract for this run (supersedes earlier task contracts, not platform or system constraints):',
    `Goal: ${contract.goal}`, `Boundaries: ${contract.boundaries}`, `Acceptance: ${contract.acceptance}`,
    context.text,
    stageInstruction(run.stage),
    `Current authorized instruction: ${prompt}`,
  ].filter(Boolean).join('\n');
  fs.writeFileSync(eventsPath, '', { mode: 0o600 }); fs.writeFileSync(stderrPath, '', { mode: 0o600 });
  let session = run.sessionId, ended = false, error = null, stopped = false, child, childStart = null;
  let outputBuffer = '', stderrBuffer = ''; const decoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
  const result = await new Promise((resolve, reject) => {
    let completed = false, watcher;
    const append = (file, text) => fs.appendFileSync(store.checkedPath(file), redact(text));
    function fail(failure) { error ??= redact(failure.message ?? failure); if (!completed) child?.kill(); }
    function event(line) {
      if (!line.trim()) return;
      try {
        append(eventsPath, line + '\n');
        const value = JSON.parse(line);
        if (value.type === 'thread.started') { store.bindSession(run, value.thread_id); session = value.thread_id; }
        if (value.type === 'turn.completed') ended = true;
        if (value.type === 'turn.failed' || value.type === 'error') error = redact(value.error?.message ?? value.message ?? 'CLI failed event');
      } catch (failure) { fail(`CLI event/log rejected: ${failure.message}`); }
    }
    function checkStop() {
      if (completed || !child?.pid || !childStart) return;
      const stopFile = store.checkedPath(path.join(directory, 'stop.json'));
      if (!fs.existsSync(stopFile)) return;
      const stop = JSON.parse(fs.readFileSync(stopFile, 'utf8')), state = store.read(run);
      const initialSessionBound = stop.sessionId === null && run.sessionId === null;
      if (stop.runNumber !== run.runNumber || digest(stop.processIdentity) !== digest(state.processIdentity) || (!initialSessionBound && stop.sessionId !== session) || processStart(child.pid) !== childStart) { error = 'CLI stop process identity mismatch'; return; }
      stopped = true; child.kill('SIGTERM');
    }
    async function finish(code, signal) {
      if (completed) return; completed = true; watcher?.close();
      outputBuffer += decoder.end(); if (outputBuffer.trim()) event(outputBuffer);
      stderrBuffer += errDecoder.end(); if (stderrBuffer) { try { append(stderrPath, stderrBuffer); } catch (failure) { fail(`CLI stderr log rejected: ${failure.message}`); } }
      let finalText = '';
      if (fs.existsSync(finalPath)) {
        try { store.checkedPath(finalPath); finalText = redact(fs.readFileSync(finalPath, 'utf8')); fs.writeFileSync(finalPath, finalText); } catch (failure) { error = `CLI final output rejected: ${failure.message}`; }
      }
      const status = stopped ? 'stopped' : !error && code === 0 && ended && session && finalText.trim() ? 'completed' : 'failed';
      if (status === 'failed' && !error) error = signal ? `CLI process ended by ${signal}` : 'CLI exit, session, completed event and final output do not agree';
      // Persistence failure is not a terminal result. Leave the saved state for explicit recovery.
      resolve(store.finishRun(run, { status, sessionId: session, exitCode: code, finalText, error }));
    }
    try {
      atomicJson(store.checkedPath(path.join(directory, 'cli-launch-intent.json')), { runNumber: run.runNumber, requestId: run.requestId });
      child = spawn(profile.runner.command, args, { cwd: binding.executionRoot, env: cliEnvironment(profile.codexHome), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('spawn', () => { try { childStart = processStart(child.pid); store.setChildProcess(run, { pid: child.pid, startedAt: childStart, token: crypto.randomUUID() }); watcher = fs.watch(directory, () => { try { checkStop(); } catch (failure) { fail(failure); } }); checkStop(); if (!stopped) child.stdin.end(instruction); } catch (failure) { fail(failure); } });
      child.stdout.on('data', data => { outputBuffer += decoder.write(data); if (outputBuffer.length > 1024 * 1024) { error = 'CLI event line exceeds size limit'; child.kill(); return; } let end; while ((end = outputBuffer.indexOf('\n')) >= 0) { const line = outputBuffer.slice(0, end); outputBuffer = outputBuffer.slice(end + 1); event(line); } });
      child.stderr.on('data', data => { try { stderrBuffer += errDecoder.write(data); if (stderrBuffer.length > 1024 * 1024) throw new Error('CLI stderr line exceeds size limit'); let end; while ((end = stderrBuffer.indexOf('\n')) >= 0) { append(stderrPath, stderrBuffer.slice(0, end + 1)); stderrBuffer = stderrBuffer.slice(end + 1); } } catch (failure) { fail(`CLI stderr log rejected: ${failure.message}`); } });
      child.once('error', failure => { error = redact(failure.message); });
      child.once('close', (code, signal) => { finish(code, signal).catch(reject); });
      child.stdin.on('error', failure => { if (failure.code !== 'EPIPE') error = redact(failure.message); });
    } catch (failure) { error = redact(failure.message); finish(null, null).catch(reject); }
  });
  if (onTerminal) await onTerminal(result);
  return result;
}
