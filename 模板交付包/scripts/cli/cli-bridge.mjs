import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliTaskStore, atomicJson, digest, sha256File, validIdentifier } from './cli-task-store.mjs';
import { runNativeCli, processStart } from './native-cli-runner.mjs';
import { currentProcessIdentity, processIsGone } from './process-identity.mjs';
import { ProjectIdentityProvider } from '../runtime/project-identity-provider.mjs';
import { createDesktopHost, desktopHome } from './desktop-host.mjs';
import { notifyWhenReady } from './cli-notify.mjs';
import { checkInteractiveCapability, runInteractiveCli } from './interactive-cli-runner.mjs';
import { readInteractiveEndpoint, callInteractive, openInteractiveWindow } from './interactive-client.mjs';
import { readZcodeProfile, checkZcodeCapability } from './zcode-profile.mjs';
import { runZcodeCli } from './zcode-cli-runner.mjs';
import { readClaudeProfile, checkClaudeCapability } from './claude-profile.mjs';
import { runVisibleCli } from './visible-cli-runner.mjs';
import { openClaudeWindow } from './claude-client.mjs';
import { WorkbenchTransactionStore } from '../runtime/workbench-transaction.mjs';

function checkNativeCapability(profile) {
  return (profile.provider === 'claude' ? checkClaudeCapability : profile.provider === 'zcode' ? checkZcodeCapability : checkInteractiveCapability)(profile);
}

export function readProfile(file, configuration = {}) {
  if (!path.isAbsolute(file)) throw new Error('CLI profile absolute path required');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || Object.keys(configuration).some(key => !['model', 'effort'].includes(key))) throw new Error('CLI configuration only accepts model and effort');
  if (configuration.model !== undefined) {
    if (typeof configuration.model !== 'string' || !configuration.model.trim() || /[\r\n]/.test(configuration.model)) throw new Error('CLI configuration requires a nonempty model');
    profile.model = configuration.model;
  }
  if (Object.hasOwn(configuration, 'effort')) {
    if (configuration.effort === null) delete profile.effort;
    else profile.effort = configuration.effort;
  }
  if (profile.provider === 'zcode') return readZcodeProfile(profile);
  if (profile.provider === 'claude') return readClaudeProfile(profile);
  if (Object.keys(profile).some(key => !['schemaVersion', 'runner', 'codexHome', 'model', 'mode', 'effort', 'ui'].includes(key)) || Object.keys(profile.runner ?? {}).some(key => !['command', 'args'].includes(key))) throw new Error('CLI profile cannot contain credentials or undocumented overrides');
  if (profile.mode !== undefined && !['exec', 'interactive'].includes(profile.mode)) throw new Error('invalid CLI mode');
  if (profile.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(profile.effort)) throw new Error('invalid CLI effort');
  if (profile.ui !== undefined && (profile.mode !== 'interactive' || !['window', 'attach'].includes(profile.ui))) throw new Error('invalid CLI view');
  if (profile.mode === 'interactive' && process.platform !== 'win32' && profile.ui !== 'attach') throw new Error('Native CLI on this platform requires ui=attach and a user terminal');
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

async function detachForTransfer(store, identity) {
  const savedFile = store.checkedPath(path.join(store.taskDir(identity), 'interactive.json'));
  // A crash may have changed the closed endpoint's owner before task.json. The
  // transfer record validates that partial state; never reopen it just to detach.
  if (fs.existsSync(savedFile) && store.readJson(savedFile).status === 'closed') return;
  const endpoint = readInteractiveEndpoint(store, identity);
  if (!endpoint) return;
  if (endpoint.status !== 'idle' || endpoint.activeTurnId) throw new Error('CLI transfer cannot detach active business');
  const result = await callInteractive(store, identity, 'detach');
  if (result?.status === 'detach-after-turn') throw new Error('CLI became active; transfer stopped without changing ownership');
  const file = store.checkedPath(path.join(store.taskDir(identity), 'interactive.json'));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const saved = store.readJson(file);
    if (saved.status === 'closed' && processIsGone(saved.manager) && processIsGone(saved.server)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('CLI idle helper exit unconfirmed; ownership was not changed');
}
async function transferOwners(request, context, store) {
  const input = request.input, operationId = validIdentifier(`cli-transfer-${request.requestId}`);
  for (const key of ['projectId', 'fromOwnerThreadId', 'toOwnerThreadId']) validIdentifier(input[key]);
  if (input.fromOwnerThreadId === input.toOwnerThreadId || ![input.fromOwnerThreadId, input.toOwnerThreadId].includes(context.ownerThreadId)) throw new Error('CLI transfer caller identity mismatch');
  if (typeof input.authorizationLocator !== 'string' || !input.authorizationLocator.trim()) throw new Error('CLI transfer authorization required');
  if (!Number.isSafeInteger(input.expectedWorkbenchStateRevision) || input.expectedWorkbenchStateRevision < 0) throw new Error('CLI transfer workbench basis required');
  if (!Array.isArray(input.tasks) || !input.tasks.length || new Set(input.tasks.map(item => item?.taskId)).size !== input.tasks.length) throw new Error('CLI transfer unique task set required');
  const provider = new ProjectIdentityProvider({ controlRoot: context.controlRoot, runtimeRoot: path.join(context.controlRoot, 'local/runtime/project-identity') });
  const canonical = provider.validateSameRootProject(input.projectId, { executionRoot: context.executionRoot });
  const workbench = new WorkbenchTransactionStore({ runtimeRoot: path.join(context.controlRoot, 'local/runtime/workbench'), viewPath: path.join(context.controlRoot, 'local/当前工作台.md'), historyRoot: path.join(context.controlRoot, 'local/history/workbench') });
  const snapshot = workbench.snapshot();
  const prepared = input.tasks.map(item => {
    validIdentifier(item.taskId); validIdentifier(item.expectedSessionId);
    if (!Number.isSafeInteger(item.expectedRunNumber) || item.expectedRunNumber < 1 || ['expectedStateSha256', 'expectedResultSha256'].some(key => !/^[a-f0-9]{64}$/.test(item[key] ?? ''))) throw new Error('CLI transfer exact task fingerprint required');
    const original = { projectId: input.projectId, taskId: item.taskId, ownerThreadId: input.fromOwnerThreadId };
    const file = store.checkedPath(path.join(store.transferDirectory(original, operationId), 'transfer.json'));
    const record = fs.existsSync(file) ? store.readJson(file) : null;
    const intent = { operationId, projectId: input.projectId, fromOwnerThreadId: input.fromOwnerThreadId, toOwnerThreadId: input.toOwnerThreadId, authorizationLocator: input.authorizationLocator, taskId: item.taskId, expectedStateSha256: item.expectedStateSha256, expectedResultSha256: item.expectedResultSha256, expectedRunNumber: item.expectedRunNumber, expectedSessionId: item.expectedSessionId };
    if (record && Object.entries(intent).some(([key, value]) => record[key] !== value)) throw new Error('CLI transfer request conflict');
    const task = snapshot.tasks[item.taskId];
    const expectedStatus = item.expectedStatus ?? record?.expectedWorkbenchStatus ?? task?.status;
    if (!['进行中', '已暂停'].includes(expectedStatus)) throw new Error('CLI transfer requires an active workbench task');
    // A completed replay returns the saved transaction, even after the successor resumed or archived it.
    if (record?.phase === 'completed' && snapshot.operations?.[operationId]) return { intent, record, expectedStatus };
    const state = store.readJson(store.locator(original));
    if (![input.fromOwnerThreadId, input.toOwnerThreadId].includes(state.ownerThreadId)) throw new Error('CLI transfer source owner mismatch');
    if (!task || task.projectId !== input.projectId || task.status !== expectedStatus || task.execution?.kind !== 'cli'
      || ![input.fromOwnerThreadId, input.toOwnerThreadId].includes(task.execution.ownerThreadId) || path.resolve(task.execution.stateLocator) !== store.locator(original)) throw new Error('CLI transfer workbench task changed');
    if (path.resolve(state.executionRoot) !== path.resolve(canonical.canonicalProjectRoot)) {
      if (!state.projectRoute) throw new Error('CLI cross-root transfer requires projectRoute');
      provider.validateWorkerRoute(input.projectId, state.projectRoute, { executionRoot: state.executionRoot });
    }
    if (state.ownerThreadId === input.toOwnerThreadId) {
      if (!record) throw new Error('CLI transfer evidence missing');
      store.verifyTransferredTransfer(intent);
    } else {
      const result = store.readResult(original, state.runNumber);
      if (digest(state) !== intent.expectedStateSha256 || state.taskMode !== 'formal' || state.status !== 'completed' || state.managerPid || state.processIdentity || result.status !== 'completed'
        || state.runNumber !== intent.expectedRunNumber || state.sessionId !== intent.expectedSessionId || sha256File(state.currentResultPath) !== intent.expectedResultSha256) throw new Error('CLI transfer stable result or fingerprint mismatch');
      if (['accept', 'close'].includes(store.readReview(original, state.runNumber)?.decision)) throw new Error('CLI terminal review must close before transfer');
    }
    if (record?.expectedWorkbenchTaskSha256 && task.execution.ownerThreadId === input.fromOwnerThreadId && digest(task) !== record.expectedWorkbenchTaskSha256) throw new Error('CLI transfer workbench task changed');
    return { intent: { ...intent, expectedWorkbenchTaskSha256: record?.expectedWorkbenchTaskSha256 ?? digest(task), expectedWorkbenchStatus: expectedStatus }, record, state, original, expectedStatus };
  });
  const benchInput = { operationId, projectId: input.projectId, fromOwnerThreadId: input.fromOwnerThreadId, toOwnerThreadId: input.toOwnerThreadId, expectedStateRevision: input.expectedWorkbenchStateRevision, tasks: prepared.map(item => ({ taskId: item.intent.taskId, expectedStatus: item.expectedStatus })) };
  const prior = snapshot.operations?.[operationId];
  if (prior && prior.inputDigest !== digest(benchInput)) throw new Error('CLI transfer operation id reused with different input');
  if (!prior && !prepared.some(item => item.record) && snapshot.revision !== input.expectedWorkbenchStateRevision) throw new Error('CLI transfer workbench revision mismatch');
  if (prior && prepared.every(item => item.record?.phase === 'completed')) return { operationId, workbenchResult: prior.output, tasks: prepared.map(item => ({ taskId: item.intent.taskId, phase: 'completed' })) };
  // Validate the entire set before detaching any idle helper or changing ownership.
  for (const item of prepared) if (item.state?.ownerThreadId === input.fromOwnerThreadId) await detachForTransfer(store, item.original);
  for (const item of prepared) if (item.state?.ownerThreadId === input.fromOwnerThreadId) store.validateTransferCandidate(item.intent);
  for (const item of prepared) store.beginTransfer({ ownerThreadId: context.ownerThreadId }, item.intent);
  for (const item of prepared) store.applyTransfer(item.intent);
  const result = prior ? prior.output : workbench.transferCliOwners(benchInput);
  const workbenchStateSha256 = sha256File(workbench.stateFile);
  const tasks = prepared.map(item => {
    const record = store.completeTransfer(item.intent, { workbenchStateSha256 });
    return { taskId: item.intent.taskId, phase: record.phase, sessionId: record.expectedSessionId, preimageDirectory: store.transferDirectory({ ...item.intent, ownerThreadId: input.toOwnerThreadId }, operationId) };
  });
  return { operationId, workbenchResult: result, tasks };
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
      if (message.type === 'rejected') reject(new Error(message.error)); else resolve({ ...run, sessionId: message.sessionId ?? run.sessionId, status: 'running', stateLocator: store.locator(run), ...(message.attachCommand ? { attachCommand: message.attachCommand } : {}) });
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
  if (request.action === 'cli.transfer') return transferOwners(request, context, store);
  if (input.ownerThreadId !== context.ownerThreadId) throw new Error('CLI owner identity mismatch');
  if (request.action === 'cli.start') {
    const { prompt, configuration = {}, ...supplied } = input;
    if (supplied.ownerTurnId !== context.ownerTurnId) throw new Error('CLI source turn identity mismatch');
    const profile = readProfile(supplied.profilePath, configuration); validateBinding(supplied, context, store);
    if (profile.mode === 'interactive') checkNativeCapability(profile);
    const binding = store.create(supplied);
    const run = store.beginRun(binding, { requestId: request.requestId, prompt, expectedRunNumber: 0, expectedSessionId: null, ownerTurnId: context.ownerTurnId, profile, configuration: { model: profile.model, effort: profile.effort ?? null } });
    return startManager(store, binding, run, profile, prompt, context);
  }
  const binding = store.read(input); validateBinding(binding, context, store);
  if (request.action === 'cli.status') return binding;
  if (request.action === 'cli.result') return store.readResult(input, input.runNumber);
  if (request.action === 'cli.review') return store.recordReview(input);
  if (request.action === 'cli.open') {
    const endpoint = readInteractiveEndpoint(store, binding);
    if (!endpoint) throw new Error('Native view is not running; use explicit same-session resume');
    if (['zcode', 'claude'].includes(endpoint.provider)) return { status: 'already-open', ...endpoint.view };
    return openInteractiveWindow(store, binding);
  }
  if (request.action === 'cli.detach') {
    const result = await callInteractive(store, binding, 'detach');
    return result ?? { status: 'already-detached' };
  }
  if (request.action === 'cli.resume') {
    if (input.configuration !== undefined) readProfile(binding.profilePath, input.configuration);
    const configuration = { ...(binding.configuration ?? {}), ...(input.configuration ?? {}) };
    const profile = readProfile(binding.profilePath, configuration);
    const endpoint = profile.mode === 'interactive' ? readInteractiveEndpoint(store, binding) : null;
    if (profile.mode === 'interactive') checkNativeCapability(profile);
    if (endpoint && endpoint.profileSha256 !== digest(profile)) throw new Error('Live native profile changed; detach idle view before changing model');
    const run = store.beginRun(input, { requestId: request.requestId, prompt: input.prompt, expectedRunNumber: input.expectedRunNumber, expectedSessionId: input.expectedSessionId, ownerTurnId: context.ownerTurnId, profile, configuration: { model: profile.model, effort: profile.effort ?? null } });
    if (endpoint) {
      const current = store.read(binding);
      if (current.status !== 'starting') return { ...run, status: current.status, stateLocator: store.locator(run) };
      return callInteractive(store, binding, 'resume', { run, profile, prompt: input.prompt });
    }
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
      try {
        if (payload.profile.mode === 'interactive') {
          const runner = payload.profile.provider === 'claude' ? runVisibleCli : payload.profile.provider === 'zcode' ? runZcodeCli : runInteractiveCli;
          await runner({ ...payload, store, host, ...(payload.profile.provider === 'claude' ? { openWindow: openClaudeWindow } : {}), ready: (result, error) => { if (process.connected) process.send(error ? { type: 'rejected', error: error.message } : { type: 'accepted', ...result }); } });
        } else {
          process.send({ type: 'accepted' });
          await runNativeCli({ ...payload, store, onTerminal: host ? () => notifyWhenReady({ store, identity: payload.run, runNumber: payload.run.runNumber, host, sourceEnd }) : undefined });
        }
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
