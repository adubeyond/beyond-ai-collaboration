import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliTaskStore, atomicJson, digest, validIdentifier } from './cli-task-store.mjs';
import { runNativeCli, processStart } from './native-cli-runner.mjs';
import { currentProcessIdentity, processIsGone } from './process-identity.mjs';
import { ProjectIdentityProvider } from '../runtime/project-identity-provider.mjs';
import { createDesktopHost, desktopHome } from './desktop-host.mjs';
import { notifyWhenReady } from './cli-notify.mjs';

export function readProfile(file) {
  if (!path.isAbsolute(file)) throw new Error('CLI profile absolute path required');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Object.keys(profile).some(key => !['schemaVersion', 'runner', 'codexHome', 'model'].includes(key)) || Object.keys(profile.runner ?? {}).some(key => !['command', 'args'].includes(key))) throw new Error('CLI profile cannot contain credentials or undocumented overrides');
  const home = desktopHome();
  const lexical = file => {
    const absolute = path.resolve(file);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  // Reject Desktop credential reuse before stat, including a cold host with no home yet.
  if (path.isAbsolute(profile.codexHome ?? '') && lexical(profile.codexHome) === lexical(home)) throw new Error('CLI profile must not reuse Desktop authentication home');
  if (profile.schemaVersion !== 1 || !path.isAbsolute(profile.runner?.command ?? '') || !fs.statSync(profile.runner.command).isFile() || !Array.isArray(profile.runner.args) || profile.runner.args.some(a => typeof a !== 'string' || /(?:api[_-]?key|auth|provider|--last|--config|--ephemeral)/i.test(a)) || !path.isAbsolute(profile.codexHome ?? '') || !fs.statSync(profile.codexHome).isDirectory() || typeof profile.model !== 'string' || !profile.model.trim()) throw new Error('invalid CLI profile');
  const normalized = file => { const physical = fs.realpathSync(file); return process.platform === 'win32' ? physical.toLowerCase() : physical; };
  if (fs.existsSync(home) && normalized(profile.codexHome) === normalized(home)) throw new Error('CLI profile must not reuse Desktop authentication home');
  return profile;
}
function validateBinding(binding, context, store) {
  if (binding.ownerThreadId !== context.ownerThreadId || !path.isAbsolute(binding.executionRoot) || path.resolve(binding.executionRoot) !== path.resolve(context.executionRoot)) throw new Error('CLI owner/execution identity mismatch');
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
  try { fs.writeFileSync(fd, JSON.stringify({ requestId: run.requestId, caller: currentProcessIdentity(), claimedAt: new Date().toISOString() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--manager'], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    const timer = setTimeout(() => { child.disconnect(); child.unref(); reject(new Error('CLI manager startup unconfirmed; inspect this run before recovery')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.on('message', message => {
      if (message.type !== 'accepted' && message.type !== 'rejected') return;
      clearTimeout(timer); child.disconnect(); child.unref();
      if (message.type === 'rejected') reject(new Error(message.error)); else resolve({ ...run, status: 'running', stateLocator: store.locator(run) });
    });
    child.once('spawn', () => {
      try {
        const managerIdentity = { pid: child.pid, startedAt: processStart(child.pid), token: crypto.randomUUID() };
        atomicJson(store.checkedPath(path.join(store.runDir(run, run.runNumber), 'manager-process.json')), managerIdentity);
        // The child cannot launch a CLI until its durable process proof precedes this payload.
        child.send({ binding, run, profile, prompt, managerIdentity, controlRoot: context.controlRoot, hostSpec: context.hostSpec ?? null });
      } catch (error) { clearTimeout(timer); child.disconnect(); child.unref(); reject(error); }
    });
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
      if (!binding.processIdentity || processIsGone(binding.processIdentity)) throw new Error('CLI process ownership could not be verified');
      return store.requestStop(input, { ...input, requestId: request.requestId });
    }
    if (!binding.runNumber) throw new Error('CLI recovery requires a saved run');
    const directory = store.runDir(input, binding.runNumber), saved = leaf => {
      const file = store.checkedPath(path.join(directory, leaf)); return fs.existsSync(file) ? store.readJson(file) : null;
    };
    const manager = saved('manager-process.json') ?? binding.processIdentity, cli = saved('cli-process.json'), claim = saved('manager-claim.json');
    if (manager && !processIsGone(manager)) throw new Error('CLI manager still exists; recovery cannot restart it');
    if (cli && !processIsGone(cli)) throw new Error('CLI process still exists; recovery cannot clear a running CLI');
    if (!manager && claim && !processIsGone(claim.caller)) throw new Error('CLI startup caller still exists; manager launch is unconfirmed');
    if (!cli && saved('cli-launch-intent.json')) throw new Error('CLI child process proof unavailable after launch intent; exit cannot be verified');
    store.recoverLock(input, input.stateSha256);
    if (digest(store.read(input)) !== input.stateSha256) throw new Error('CLI state fingerprint mismatch');
    if (fs.existsSync(path.join(directory, 'result.json'))) return store.reconcileResult(input, input.stateSha256);
    const run = store.readJson(path.join(directory, 'run.json'));
    return store.finishRun(run, { status: 'unknown', exitCode: null, error: 'Verified saved processes exited; inspect session and effects before explicit continuation' }, { stateSha256: input.stateSha256 });
  }
  throw new Error('unsupported CLI action');
}
if (process.argv[2] === '--manager' && process.send) {
  let received = false;
  process.once('disconnect', () => { if (!received) process.exitCode = 1; });
  process.once('message', async payload => {
    received = true;
    const store = new CliTaskStore({ controlRoot: payload.controlRoot });
    try {
      const identity = payload.managerIdentity;
      if (identity?.pid !== process.pid || identity.startedAt !== processStart(process.pid)) throw new Error('CLI manager inherited process proof mismatch');
      const abort = new AbortController();
      const host = payload.hostSpec ? createDesktopHost(payload.hostSpec) : null;
      // Attach the observer before CLI start; the promise is consumed after result persistence.
      const sourceEnd = host ? host.waitForSourceTurnEnd({ ownerThreadId: payload.run.ownerThreadId, ownerTurnId: payload.run.ownerTurnId, signal: abort.signal }) : null;
      sourceEnd?.catch(() => {});
      store.setProcess(payload.run, identity);
      process.send({ type: 'accepted' });
      try {
        await runNativeCli({ ...payload, store, onTerminal: host ? () => notifyWhenReady({ store, identity: payload.run, runNumber: payload.run.runNumber, host, sourceEnd }) : undefined });
      } finally { abort.abort(); }
    } catch (error) { if (process.connected) process.send({ type: 'rejected', error: error.message }); process.exitCode = 1; }
  });
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--request');
    if (index < 0) throw new Error('--request must name a JSON file');
    const request = JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));
    let source = { ownerThreadId: validIdentifier(process.env.CODEX_THREAD_ID) }, host;
    // Local recovery and inspection do not depend on the message transport that may have failed.
    if (['cli.start', 'cli.resume'].includes(request.action)) {
      host = createDesktopHost(); source = host.currentSource();
      if (!(await host.checkCapability()).available) throw new Error('Desktop original-owner notification capability unavailable');
    }
    const context = { controlRoot: path.resolve(fileURLToPath(new URL('../../', import.meta.url))), executionRoot: process.cwd(), ownerThreadId: source.ownerThreadId, ownerTurnId: source.ownerTurnId, hostSpec: host?.descriptor };
    if (request.action === 'cli.start') {
      if (request.input.ownerThreadId && request.input.ownerThreadId !== source.ownerThreadId) throw new Error('CLI source identity mismatch');
      if (request.input.ownerTurnId && request.input.ownerTurnId !== source.ownerTurnId) throw new Error('CLI source turn mismatch');
      request.input.ownerThreadId = source.ownerThreadId; request.input.ownerTurnId = source.ownerTurnId;
    }
    const result = await launchCliRequest(request, context); process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) { process.stderr.write(`CLI bridge failed: ${error.message}\n`); process.exitCode = 1; }
}
