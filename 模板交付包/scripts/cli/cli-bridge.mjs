import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliTaskStore, digest, validIdentifier } from './cli-task-store.mjs';
import { runNativeCli, processStart } from './native-cli-runner.mjs';
import { ProjectIdentityProvider } from '../runtime/project-identity-provider.mjs';

export function readProfile(file) {
  if (!path.isAbsolute(file)) throw new Error('CLI profile absolute path required');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Object.keys(profile).some(key => !['schemaVersion', 'runner', 'codexHome', 'model'].includes(key)) || Object.keys(profile.runner ?? {}).some(key => !['command', 'args'].includes(key))) throw new Error('CLI profile cannot contain credentials or undocumented overrides');
  if (profile.schemaVersion !== 1 || !path.isAbsolute(profile.runner?.command ?? '') || !fs.statSync(profile.runner.command).isFile() || !Array.isArray(profile.runner.args) || profile.runner.args.some(a => typeof a !== 'string' || /(?:api[_-]?key|auth|provider|--last|--config|--ephemeral)/i.test(a)) || !path.isAbsolute(profile.codexHome ?? '') || !fs.statSync(profile.codexHome).isDirectory() || typeof profile.model !== 'string' || !profile.model.trim()) throw new Error('invalid CLI profile');
  if (process.env.CODEX_HOME && fs.realpathSync(profile.codexHome) === fs.realpathSync(process.env.CODEX_HOME)) throw new Error('CLI profile must not reuse Desktop authentication home');
  return profile;
}
function validateBinding(binding, context, store) {
  if (binding.ownerThreadId !== context.ownerThreadId || binding.executionRoot !== context.executionRoot) throw new Error('CLI owner/execution identity mismatch');
  const provider = new ProjectIdentityProvider({ controlRoot: context.controlRoot, runtimeRoot: path.join(context.controlRoot, 'local/runtime/project-identity') });
  if (binding.projectRoute) provider.validateWorkerRoute(binding.projectId, binding.projectRoute, { executionRoot: context.executionRoot });
  else provider.validateSameRootProject(binding.projectId, { executionRoot: context.executionRoot });
  const stateFile = path.join(context.controlRoot, 'local/runtime/workbench/workbench-state.json');
  const registered = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).tasks?.[binding.taskId] : null;
  if (registered) {
    if (!['进行中', '已暂停'].includes(registered.status)) throw new Error('CLI goal is not active');
    if (binding.taskMode === 'formal') {
      if (registered.execution?.kind !== 'cli' || registered.execution.ownerThreadId !== binding.ownerThreadId || registered.projectId !== binding.projectId || path.resolve(registered.execution.stateLocator) !== store.locator(binding)) throw new Error('CLI formal registration identity mismatch');
    } else if (registered.worker !== binding.ownerThreadId) throw new Error('CLI assistance must belong to the original Worker');
  } else if (binding.taskMode === 'formal') throw new Error('CLI formal task registration required');
  else {
    const historyRoot = path.join(context.controlRoot, 'local/history/workbench');
    if (fs.existsSync(historyRoot)) for (const entry of fs.readdirSync(historyRoot).filter(x => x.endsWith('.json'))) {
      const records = JSON.parse(fs.readFileSync(path.join(historyRoot, entry), 'utf8'));
      if ((Array.isArray(records) ? records : records.records ?? []).some(x => x.taskId === binding.taskId)) throw new Error('CLI goal is already archived');
    }
  }
}
async function startManager(store, binding, run, profile, prompt, context) {
  const state = store.read(binding);
  if (state.status !== 'starting' || state.runNumber !== run.runNumber || state.managerPid || fs.existsSync(run.resultPath)) return { ...run, status: state.status };
  // Exclusive claim prevents an idempotent start request from spawning a second manager.
  const claim = store.checkedPath(path.join(store.runDir(run, run.runNumber), 'manager-claim.json'));
  let fd; try { fd = fs.openSync(claim, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return { ...run, status: store.read(run).status }; throw error; }
  fs.writeFileSync(fd, JSON.stringify({ requestId: run.requestId, claimedAt: new Date().toISOString() })); fs.closeSync(fd);
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--manager'], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    const timer = setTimeout(() => { child.disconnect(); child.unref(); reject(new Error('CLI manager startup unconfirmed; inspect this run before recovery')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.on('message', message => {
      if (message.type !== 'accepted' && message.type !== 'rejected') return;
      clearTimeout(timer); child.disconnect(); child.unref();
      if (message.type === 'rejected') reject(new Error(message.error)); else resolve({ ...run, status: 'running', stateLocator: store.locator(run) });
    });
    child.send({ binding, run, profile, prompt, controlRoot: context.controlRoot, hostSpec: context.hostSpec ?? null });
  });
}
export async function launchCliRequest(request, context) {
  if (request.schemaVersion !== 1 || !request.action?.startsWith('cli.')) throw new Error('invalid CLI request schema');
  validIdentifier(request.requestId);
  const input = request.input, store = new CliTaskStore({ controlRoot: context.controlRoot });
  if (input.ownerThreadId !== context.ownerThreadId) throw new Error('CLI owner identity mismatch');
  if (request.action === 'cli.start') {
    const { prompt, ...supplied } = input;
    if (supplied.ownerTurnId !== context.ownerTurnId) throw new Error('CLI source turn identity mismatch');
    const profile = readProfile(supplied.profilePath); validateBinding(supplied, context, store);
    const binding = store.create(supplied);
    const run = store.beginRun(binding, { requestId: request.requestId, prompt, expectedRunNumber: 0, expectedSessionId: null, ownerTurnId: context.ownerTurnId });
    return startManager(store, binding, run, profile, prompt, context);
  }
  const binding = store.read(input); validateBinding(binding, context, store);
  if (request.action === 'cli.status') return binding;
  if (request.action === 'cli.result') return store.readResult(input, input.runNumber);
  if (request.action === 'cli.review') return store.recordReview(input);
  if (request.action === 'cli.resume') {
    const profile = readProfile(binding.profilePath);
    const run = store.beginRun(input, { requestId: request.requestId, prompt: input.prompt, expectedRunNumber: input.expectedRunNumber, expectedSessionId: input.expectedSessionId, ownerTurnId: context.ownerTurnId });
    return startManager(store, binding, run, profile, input.prompt, context);
  }
  if (request.action === 'cli.stop' || request.action === 'cli.recover') {
    if (digest(binding) !== input.stateSha256) throw new Error('CLI state fingerprint mismatch');
    if (binding.sessionId !== input.expectedSessionId || !input.reason) throw new Error('CLI recovery session and reason required');
    if (request.action === 'cli.stop') {
      if (!binding.processIdentity || processStart(binding.managerPid) !== binding.processIdentity.startedAt) throw new Error('CLI process ownership could not be verified');
      return store.requestStop(input, { ...input, requestId: request.requestId });
    }
    if (binding.processIdentity) {
      try { process.kill(binding.managerPid, 0); } catch (error) { if (error.code !== 'ESRCH') throw new Error('CLI manager liveness is unknown');
        const run = store.readJson(path.join(store.runDir(input, binding.runNumber), 'run.json'));
        return store.finishRun(run, { status: 'unknown', exitCode: null, error: 'Verified manager exit; inspect saved session and effects before continuation' });
      }
      throw new Error('CLI manager still exists; recovery cannot restart it');
    }
    throw new Error('CLI recovery requires saved process proof; no automatic restart');
  }
  throw new Error('unsupported CLI action');
}
if (process.argv[2] === '--manager' && process.send) {
  process.once('message', async payload => {
    const store = new CliTaskStore({ controlRoot: payload.controlRoot });
    try {
      const identity = { pid: process.pid, startedAt: processStart(process.pid), token: crypto.randomUUID() };
      store.setProcess(payload.run, identity);
      process.send({ type: 'accepted' });
      await runNativeCli({ ...payload, store });
    } catch (error) { if (process.connected) process.send({ type: 'rejected', error: error.message }); process.exitCode = 1; }
  });
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--request');
    if (index < 0) throw new Error('--request must name a JSON file');
    const request = JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));
    const context = { controlRoot: path.resolve(fileURLToPath(new URL('../../', import.meta.url))), executionRoot: process.cwd(), ownerThreadId: process.env.CODEX_THREAD_ID, ownerTurnId: process.env.CODEX_TURN_ID };
    const result = await launchCliRequest(request, context); process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) { process.stderr.write(`CLI bridge failed: ${error.message}\n`); process.exitCode = 1; }
}
