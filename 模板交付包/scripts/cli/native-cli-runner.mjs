import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { digest } from './cli-task-store.mjs';

export function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid process PID');
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !/^\d+$/.test(result.stdout.trim())) throw new Error('process start identity unavailable');
    return result.stdout.trim();
  }
  if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  throw new Error('process identity is unsupported on this host');
}
export function redact(text) {
  return String(text).replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
}
function cliEnvironment(home) {
  const env = { ...process.env, CODEX_HOME: home };
  for (const key of Object.keys(env)) if (/^(OPENAI_|CODEX_(THREAD|TURN|APP|AUTH|API|SESSION))/.test(key)) delete env[key];
  env.CODEX_HOME = home; return env;
}
export async function runNativeCli({ binding, run, profile, prompt, store, onTerminal }) {
  const directory = store.runDir(run, run.runNumber), eventsPath = store.checkedPath(path.join(directory, 'events.jsonl'));
  const stderrPath = store.checkedPath(path.join(directory, 'stderr.log')), finalPath = store.checkedPath(path.join(directory, 'final.txt'));
  const args = [...profile.runner.args, 'exec', ...(run.sessionId ? ['resume', run.sessionId] : []), '--json', '--output-last-message', finalPath, '--model', profile.model, '-'];
  const instruction = [
    'You are a CLI execution session managed by one Desktop owner. Do not send Desktop callbacks or worker-result receipts. Return evidence; the owner decides goal completion.',
    `Goal: ${binding.contract.goal}`, `Boundaries: ${binding.contract.boundaries}`, `Acceptance: ${binding.contract.acceptance}`,
    `Read project AGENTS.md and these relevant fact/Action Skill entries when needed: ${JSON.stringify([...binding.contract.factEntries, ...binding.contract.skillEntries])}`,
    `Current authorized instruction: ${prompt}`,
  ].join('\n');
  fs.writeFileSync(eventsPath, '', { mode: 0o600 }); fs.writeFileSync(stderrPath, '', { mode: 0o600 });
  let session = run.sessionId, ended = false, error = null, stopped = false, child, childStart = null;
  let outputBuffer = '', stderrBuffer = ''; const decoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
  const result = await new Promise(resolve => {
    let completed = false, watcher;
    const append = (file, text) => fs.appendFileSync(store.checkedPath(file), redact(text));
    function event(line) {
      if (!line.trim()) return;
      append(eventsPath, line + '\n');
      try {
        const value = JSON.parse(line);
        if (value.type === 'thread.started') { store.bindSession(run, value.thread_id); session = value.thread_id; }
        if (value.type === 'turn.completed') ended = true;
        if (value.type === 'turn.failed' || value.type === 'error') error = redact(value.error?.message ?? value.message ?? 'CLI failed event');
      } catch (failure) { error = redact(`CLI event rejected: ${failure.message}`); child?.kill(); }
    }
    function checkStop() {
      if (completed || !child?.pid || !childStart) return;
      const stopFile = store.checkedPath(path.join(directory, 'stop.json'));
      if (!fs.existsSync(stopFile)) return;
      const stop = JSON.parse(fs.readFileSync(stopFile, 'utf8')), state = store.read(run);
      if (digest(stop.processIdentity) !== digest(state.processIdentity) || stop.sessionId !== session || processStart(child.pid) !== childStart) { error = 'CLI stop process identity mismatch'; return; }
      stopped = true; child.kill('SIGTERM');
    }
    async function finish(code, signal) {
      if (completed) return; completed = true; watcher?.close();
      outputBuffer += decoder.end(); if (outputBuffer.trim()) event(outputBuffer);
      stderrBuffer += errDecoder.end(); if (stderrBuffer) append(stderrPath, stderrBuffer);
      let finalText = '';
      if (fs.existsSync(finalPath)) {
        try { store.checkedPath(finalPath); finalText = redact(fs.readFileSync(finalPath, 'utf8')); fs.writeFileSync(finalPath, finalText); } catch (failure) { error = `CLI final output rejected: ${failure.message}`; }
      }
      const status = stopped ? 'stopped' : !error && code === 0 && ended && session && finalText.trim() ? 'completed' : 'failed';
      if (status === 'failed' && !error) error = signal ? `CLI process ended by ${signal}` : 'CLI exit, session, completed event and final output do not agree';
      resolve(store.finishRun(run, { status, sessionId: session, exitCode: code, finalText, error }));
    }
    try {
      child = spawn(profile.runner.command, args, { cwd: binding.executionRoot, env: cliEnvironment(profile.codexHome), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('spawn', () => { try { childStart = processStart(child.pid); watcher = fs.watch(directory, () => { try { checkStop(); } catch (failure) { error = failure.message; } }); checkStop(); } catch (failure) { error = failure.message; child.kill(); } });
      child.stdout.on('data', data => { outputBuffer += decoder.write(data); if (outputBuffer.length > 1024 * 1024) { error = 'CLI event line exceeds size limit'; child.kill(); return; } let end; while ((end = outputBuffer.indexOf('\n')) >= 0) { const line = outputBuffer.slice(0, end); outputBuffer = outputBuffer.slice(end + 1); event(line); } });
      child.stderr.on('data', data => { stderrBuffer += errDecoder.write(data); let end; while ((end = stderrBuffer.indexOf('\n')) >= 0) { append(stderrPath, stderrBuffer.slice(0, end + 1)); stderrBuffer = stderrBuffer.slice(end + 1); } });
      child.once('error', failure => { error = redact(failure.message); });
      child.once('close', (code, signal) => { finish(code, signal).catch(failure => resolve({ status: 'unknown', error: failure.message })); });
      child.stdin.on('error', failure => { if (failure.code !== 'EPIPE') error = redact(failure.message); });
      child.stdin.end(instruction);
    } catch (failure) { error = redact(failure.message); finish(null, null).catch(failure => resolve({ status: 'unknown', error: failure.message })); }
  });
  if (onTerminal) await onTerminal(result);
  return result;
}
