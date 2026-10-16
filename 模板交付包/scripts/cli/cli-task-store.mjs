import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { currentProcessIdentity, processIsGone, initialRecoveryWindowIsGone } from './process-identity.mjs';

export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const terminal = new Set(['completed', 'failed', 'stopped', 'unknown']);
export function validIdentifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) || value.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) throw new Error('invalid identifier');
  return value;
}
function sameIdentity(stored, input) {
  for (const key of ['projectId', 'taskId', 'ownerThreadId']) if (stored[key] !== input[key]) throw new Error('CLI identity mismatch');
}
function historicalOwners(state) {
  return new Set([state.ownerThreadId, ...(state.ownerTransfers ?? []).map(item => item.fromOwnerThreadId)]);
}
function sameHistoricalIdentity(state, stored, identity) {
  for (const key of ['projectId', 'taskId']) if (stored[key] !== identity[key]) throw new Error('CLI identity mismatch');
  if (!historicalOwners(state).has(stored.ownerThreadId)) throw new Error('CLI historical owner mismatch');
}
function validNonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} required`);
  return value;
}
function validTime(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('invalid time');
  return value;
}
function validContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw new Error('CLI contract is required');
  for (const key of ['goal', 'boundaries', 'acceptance']) if (typeof contract[key] !== 'string' || !contract[key].trim()) throw new Error('CLI contract is required');
  for (const key of ['factEntries', 'skillEntries']) if (!Array.isArray(contract[key]) || contract[key].some(x => typeof x !== 'string')) throw new Error('invalid contract entries');
}
function validStage(stage) {
  if (!stage || typeof stage !== 'object' || Array.isArray(stage) || Object.keys(stage).some(key => !['goal', 'acceptance'].includes(key))) throw new Error('CLI stage requires goal and acceptance only');
  validNonEmpty(stage.goal, 'CLI stage goal'); validNonEmpty(stage.acceptance, 'CLI stage acceptance');
  return { goal: stage.goal, acceptance: stage.acceptance };
}
export function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export class CliTaskStore {
  constructor({ controlRoot }) {
    this.controlRoot = fs.realpathSync(controlRoot);
    this.root = path.join(this.controlRoot, 'local', 'runtime', 'cli-tasks');
  }
  checkedPath(file, { createDirectory = false } = {}) {
    const resolved = path.resolve(file), relative = path.relative(this.controlRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('CLI path escape');
    let current = this.controlRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (fs.existsSync(current) || fs.lstatSync(current, { throwIfNoEntry: false })) {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('CLI linked path escape');
        const physical = fs.realpathSync(current), rel = path.relative(this.controlRoot, physical);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('CLI path escape');
      } else if (createDirectory) fs.mkdirSync(current);
    }
    return resolved;
  }
  taskDir(identity) {
    validIdentifier(identity.projectId); validIdentifier(identity.taskId); validIdentifier(identity.ownerThreadId);
    return this.checkedPath(path.join(this.root, identity.projectId, identity.taskId));
  }
  locator(identity) { return path.join(this.taskDir(identity), 'task.json'); }
  runDir(identity, number) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid run number');
    return this.checkedPath(path.join(this.taskDir(identity), 'runs', String(number)));
  }
  readJson(file) {
    this.checkedPath(file);
    if (!fs.existsSync(file)) throw new Error('CLI record not found');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  withLock(identity, action) {
    const dir = this.checkedPath(this.taskDir(identity), { createDirectory: true });
    // The validated parent is stable; the lock leaf may disappear during normal release.
    // Do not realpath that transient leaf. Reject links; rename below arbitrates ownership.
    const lock = path.join(dir, '.lock');
    if (fs.lstatSync(lock, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('CLI linked path escape');
    const prepared = `${lock}.${process.pid}.${crypto.randomUUID()}`;
    fs.mkdirSync(prepared);
    try {
      atomicJson(path.join(prepared, 'owner.json'), { ...currentProcessIdentity(), token: crypto.randomUUID(), acquiredAt: now() });
      if (fs.existsSync(lock)) throw new Error('CLI lock conflict; owner verification required');
      try { fs.renameSync(prepared, lock); } catch (error) { if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw new Error('CLI lock conflict; owner verification required'); throw error; }
    } catch (error) { if (fs.existsSync(prepared)) { const owner = path.join(prepared, 'owner.json'); if (fs.existsSync(owner)) fs.unlinkSync(owner); fs.rmdirSync(prepared); } throw error; }
    try { return action(); }
    finally { fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); }
  }
  recoverLock(identity, stateSha256) {
    if (digest(this.read(identity)) !== stateSha256) throw new Error('CLI state fingerprint mismatch');
    const lock = this.checkedPath(path.join(this.taskDir(identity), '.lock'));
    if (!fs.existsSync(lock)) return;
    const owner = this.readJson(path.join(lock, 'owner.json'));
    if (!processIsGone(owner)) throw new Error('CLI lock owner still exists');
    const retired = `${lock}.recovered.${crypto.randomUUID()}`;
    fs.renameSync(lock, retired);
    if (digest(this.readJson(path.join(retired, 'owner.json'))) !== digest(owner)) throw new Error('CLI lock ownership changed; retired lock preserved');
    fs.unlinkSync(path.join(retired, 'owner.json')); fs.rmdirSync(retired);
  }
  create(binding) {
    validIdentifier(binding.ownerTurnId);
    if (!['formal', 'assist'].includes(binding.taskMode) || !path.isAbsolute(binding.executionRoot) || !path.isAbsolute(binding.profilePath)) throw new Error('invalid CLI binding');
    validContract(binding.contract);
    return this.withLock(binding, () => {
      const file = this.locator(binding);
      if (fs.existsSync(file)) {
        const stored = this.read(binding);
        for (const [key, value] of Object.entries(binding)) if (key !== 'ownerTurnId' && digest(stored[key]) !== digest(value)) throw new Error('CLI binding conflict');
        return stored;
      }
      const state = { schemaVersion: 1, ...clone(binding), effectiveContract: clone(binding.contract), sessionId: null, runNumber: 0, status: 'starting', currentResultPath: null, managerPid: null, processIdentity: null, updatedAt: now() };
      atomicJson(file, state); return state;
    });
  }
  read(identity) {
    const state = this.readJson(this.locator(identity)); sameIdentity(state, identity);
    if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.runNumber) || state.runNumber < 0) throw new Error('invalid CLI state');
    if (state.currentResultPath && state.currentResultPath !== path.join(this.runDir(identity, state.runNumber), 'result.json')) throw new Error('CLI result path mismatch');
    return state;
  }
  #verifyInitialSessionRecovery(identity, state, recovery, prompt, profile, stage) {
    if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)
      || Object.keys(recovery).some(key => !['stateSha256', 'resultSha256', 'reason'].includes(key))
      || !/^[a-f0-9]{64}$/.test(recovery.stateSha256 ?? '') || !/^[a-f0-9]{64}$/.test(recovery.resultSha256 ?? '')
      || typeof recovery.reason !== 'string' || !recovery.reason.trim()) throw new Error('CLI initial session recovery requires exact fingerprints and reason');
    if (digest(state) !== recovery.stateSha256) throw new Error('CLI state fingerprint mismatch');
    if (state.runNumber !== 1 || state.sessionId !== null || state.status !== 'unknown') {
      throw new Error('CLI initial session recovery only permits an unbound first failed run');
    }
    const directory = this.runDir(identity, 1), saved = leaf => this.readJson(path.join(directory, leaf));
    const previous = saved('run.json'), input = saved('input.json'), result = this.readResult(identity, 1);
    sameIdentity(previous, identity); sameIdentity(result, identity);
    const originalRequest = this.readJson(path.join(this.taskDir(identity), 'requests', `${validIdentifier(previous.requestId)}.json`));
    const originalFingerprint = digest({ requestId: previous.requestId, prompt: input.prompt, expectedRunNumber: 0, expectedSessionId: null,
      ...(previous.profile ? { profile: previous.profile } : {}), ...(state.configuration ? { configuration: state.configuration } : {}), ...(previous.stage !== undefined ? { stage: previous.stage } : {}) });
    if (digest(originalRequest.run) !== digest(previous) || input.fingerprint !== originalRequest.fingerprint
      || originalFingerprint !== originalRequest.fingerprint) throw new Error('CLI initial session recovery original request evidence changed');
    if (previous.runNumber !== 1 || previous.sessionId !== null || result.sessionId !== null
      || result.status !== state.status || result.finalText !== ''
      || state.currentResultPath !== path.join(directory, 'result.json')) throw new Error('CLI initial session recovery has bound or unstable result evidence');
    if (sha256File(state.currentResultPath) !== recovery.resultSha256) throw new Error('CLI result fingerprint mismatch');
    const review = this.readReview(identity, 1);
    if (review?.decision !== 'continue' || review.runNumber !== 1 || review.resultSha256 !== recovery.resultSha256) {
      throw new Error('CLI initial session recovery requires an exact continue review');
    }
    if (previous.profile?.provider !== 'claude' || previous.profile.mode !== 'interactive'
      || digest(profile) !== digest(previous.profile)) throw new Error('CLI initial session recovery profile changed or unsupported');
    if (prompt !== input.prompt) throw new Error('CLI initial session recovery prompt changed');
    if (!isDeepStrictEqual(stage, previous.stage)) throw new Error('CLI initial session recovery stage changed');
    // SessionStart is saved before registration; only registration can dispatch a business prompt.
    if (fs.existsSync(this.checkedPath(path.join(directory, 'claude-session-start.json')))
      || (fs.existsSync(this.checkedPath(path.join(directory, 'events.jsonl')))
        && fs.statSync(path.join(directory, 'events.jsonl')).size > 0)) throw new Error('CLI initial session recovery has session or dispatch evidence');
    const endpoint = this.readJson(path.join(this.taskDir(identity), 'interactive.json'));
    sameIdentity(endpoint, identity);
    const exit = saved('claude-view-exit.json'), manager = saved('manager-process.json'), cli = saved('cli-process.json');
    if (endpoint.provider !== 'claude' || endpoint.status !== 'closed' || endpoint.sessionId !== null
      || path.resolve(endpoint.executionRoot) !== path.resolve(state.executionRoot)
      || endpoint.profileSha256 !== digest(previous.profile) || !endpoint.launchId || endpoint.launchId !== exit.launchId
      || !Number.isInteger(exit.exitCode) || !exit.error || !endpoint.manager || !endpoint.server
      || digest(endpoint.manager) !== digest(manager) || digest(endpoint.server) !== digest(manager)
      || cli.runNumber !== 1 || cli.requestId !== previous.requestId) throw new Error('CLI initial session recovery launch proof mismatch');
    if (!processIsGone(manager)) throw new Error('CLI manager still exists; initial session recovery cannot restart it');
    if (!processIsGone(cli)) throw new Error('CLI process still exists; initial session recovery cannot restart it');
    if (!initialRecoveryWindowIsGone(endpoint.view, result.completedAt, { legacyExitEvidence: { resultError: result.error, viewExitError: exit.error } })) {
      throw new Error('CLI window still exists; initial session recovery cannot restart it');
    }
    return { ...clone(recovery), previousRunNumber: 1, reviewSha256: digest(review), launchId: endpoint.launchId };
  }
  queueContinuation(identity, { requestId, prompt, stage, expectedRunNumber, expectedSessionId, ownerTurnId, replacesRequestId, contract, authorizationLocator, ...unsupported }) {
    if (Object.keys(unsupported).length) throw new Error('unsupported CLI continuation fields');
    validIdentifier(requestId); validIdentifier(ownerTurnId); validIdentifier(expectedSessionId);
    validNonEmpty(prompt, 'CLI prompt'); stage = validStage(stage);
    if (!Number.isSafeInteger(expectedRunNumber) || expectedRunNumber < 1) throw new Error('invalid continuation run number');
    if (replacesRequestId !== undefined) validIdentifier(replacesRequestId);
    return this.withLock(identity, () => {
      this.assertTransferSettled(identity);
      const state = this.read(identity), items = state.continuations ?? [];
      const updatesContract = authorizationLocator !== undefined || (contract !== undefined && !isDeepStrictEqual(contract, state.contract));
      if (updatesContract) { validContract(contract); validNonEmpty(authorizationLocator, 'CLI contract authorization locator'); }
      const payload = { ...Object.fromEntries(['projectId', 'taskId', 'ownerThreadId'].map(key => [key, identity[key]])), requestId, prompt, stage, expectedRunNumber, expectedSessionId, ownerTurnId, ...(replacesRequestId !== undefined ? { replacesRequestId } : {}), ...(updatesContract ? { contract: clone(contract), authorizationLocator } : {}) };
      const previous = items.find(item => item.requestId === requestId);
      if (previous) {
        // Desktop turn context can change on retry; retain the first origin as
        // provenance without treating it as a change to the owner's request.
        const replayPayload = { ...payload, ownerTurnId: previous.ownerTurnId };
        if (!isDeepStrictEqual(Object.fromEntries(Object.keys(replayPayload).map(key => [key, previous[key]])), replayPayload) || previous.replacesRequestId !== replacesRequestId || previous.authorizationLocator !== payload.authorizationLocator) throw new Error('CLI continuation request conflict');
        return clone(previous);
      }
      if (state.runNumber !== expectedRunNumber) throw new Error('CLI stale run conflict');
      if (state.sessionId !== expectedSessionId) throw new Error('CLI session mismatch');
      if (terminal.has(state.status) && ['accept', 'close'].includes(this.readReview(identity, state.runNumber)?.decision)) throw new Error('CLI final review forbids continuation');
      if (fs.existsSync(this.checkedPath(path.join(this.taskDir(identity), 'requests', `${requestId}.json`)))) throw new Error('CLI continuation request conflicts with an existing run');
      const pending = items.find(item => item.status === 'pending');
      if (pending ? replacesRequestId !== pending.requestId : replacesRequestId !== undefined) throw new Error('CLI continuation replacement requires the pending request ID');
      if (pending) this.#assertContinuationNotDispatched(identity, pending);
      const queuedAt = now(), item = { ...payload, status: 'pending', queuedAt };
      const continuations = items.map(value => value === pending ? { ...value, status: 'superseded', supersededBy: requestId, supersededAt: queuedAt } : value);
      continuations.push(item);
      atomicJson(this.locator(identity), { ...state, continuations, updatedAt: queuedAt });
      return clone(item);
    });
  }
  readContinuation(identity, runNumber) {
    if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new Error('invalid continuation run number');
    const state = this.read(identity);
    const item = (state.continuations ?? []).findLast(value => value.expectedRunNumber === runNumber);
    return clone(item && ['pending', 'consumed'].includes(item.status) ? item : null);
  }
  #assertContinuationNotDispatched(identity, item) {
    // A durable beginRun intent must finish its exact replay before the slot can change.
    if (fs.existsSync(this.checkedPath(path.join(this.taskDir(identity), 'requests', `${item.requestId}.json`)))) throw new Error('CLI continuation dispatch intent exists; replay the same continuation');
  }
  cancelContinuation(identity, { requestId, reason }) {
    validIdentifier(requestId); validNonEmpty(reason, 'CLI continuation cancellation reason');
    return this.withLock(identity, () => {
      this.assertTransferSettled(identity);
      const state = this.read(identity), item = (state.continuations ?? []).find(value => value.requestId === requestId);
      if (!item) throw new Error('CLI continuation not found');
      sameIdentity(item, identity);
      if (item.status === 'cancelled' && item.reason === reason) return clone(item);
      if (item.status !== 'pending') throw new Error('CLI continuation is not pending');
      this.#assertContinuationNotDispatched(identity, item);
      const cancelled = { ...item, status: 'cancelled', reason, cancelledAt: now() };
      atomicJson(this.locator(identity), { ...state, continuations: state.continuations.map(value => value === item ? cancelled : value), updatedAt: cancelled.cancelledAt });
      return clone(cancelled);
    });
  }
  beginRun(identity, { requestId, prompt, expectedRunNumber, expectedSessionId, ownerTurnId, profile, configuration, initialSessionRecovery, contract, authorizationLocator, stage, continuationId, faultAt = null }) {
    validIdentifier(requestId);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('CLI prompt required');
    if (ownerTurnId !== undefined) validIdentifier(ownerTurnId);
    if (stage !== undefined) stage = validStage(stage);
    if (continuationId !== undefined) validIdentifier(continuationId);
    return this.withLock(identity, () => {
      this.assertTransferSettled(identity);
      const state = this.read(identity), requestFile = this.checkedPath(path.join(this.taskDir(identity), 'requests', `${requestId}.json`));
      // Legacy callers spread the initial binding into resume. Without explicit
      // authorization that identical field is metadata, never a rollback of current scope.
      const updatesContract = authorizationLocator !== undefined || (contract !== undefined && !isDeepStrictEqual(contract, state.contract));
      if (updatesContract) {
        validContract(contract);
        validNonEmpty(authorizationLocator, 'CLI contract authorization locator');
        if (ownerTurnId === undefined) throw new Error('CLI contract update owner turn required');
        if (initialSessionRecovery !== undefined) throw new Error('CLI contract update cannot accompany initial session recovery');
      }
      const fingerprint = digest({ requestId, prompt, expectedRunNumber, expectedSessionId, ...(profile ? { profile } : {}), ...(configuration ? { configuration } : {}), ...(initialSessionRecovery !== undefined ? { initialSessionRecovery } : {}), ...(updatesContract ? { contract, authorizationLocator } : {}), ...(stage !== undefined ? { stage } : {}), ...(continuationId !== undefined ? { continuationId } : {}) });
      let run;
      if (fs.existsSync(requestFile)) {
        const previous = this.readJson(requestFile);
        if (previous.fingerprint !== fingerprint) throw new Error('CLI request conflict');
        run = previous.run;
        if (state.runNumber >= run.runNumber) return run;
      }
      if (expectedSessionId !== state.sessionId) throw new Error('CLI session mismatch');
      if (expectedRunNumber !== state.runNumber) throw new Error('CLI stale run conflict');
      if (state.runNumber && !terminal.has(state.status)) throw new Error('CLI active run conflict');
      const pending = (state.continuations ?? []).find(item => item.status === 'pending');
      if (continuationId !== undefined) {
        if (!pending || pending.requestId !== continuationId || requestId !== continuationId || pending.expectedRunNumber !== expectedRunNumber || pending.expectedSessionId !== expectedSessionId || pending.prompt !== prompt || !isDeepStrictEqual(pending.stage, stage)) throw new Error('CLI continuation intent mismatch');
        if (!isDeepStrictEqual(pending.contract, updatesContract ? contract : undefined) || pending.authorizationLocator !== (updatesContract ? authorizationLocator : undefined)) throw new Error('CLI continuation contract intent mismatch');
        sameIdentity(pending, identity);
      } else if (pending) throw new Error('CLI pending continuation must be consumed or explicitly cancelled');
      if (updatesContract && !state.runNumber) throw new Error('CLI contract update requires same-session resume');
      const endpointFile = this.checkedPath(path.join(this.taskDir(identity), 'interactive.json'));
      if (updatesContract && fs.existsSync(endpointFile)) {
        const endpoint = this.readJson(endpointFile); sameIdentity(endpoint, identity);
        if (!['idle', 'closed'].includes(endpoint.status) || endpoint.activeTurnId) {
          // Recovery preserves the old endpoint. Match cold-resume liveness checks:
          // stale running/turn markers are harmless only after both saved processes exit.
          const exited = endpoint.manager && endpoint.server && processIsGone(endpoint.manager) && processIsGone(endpoint.server);
          if (!exited) throw new Error('CLI contract update requires an idle native session');
        }
      }
      const recovery = initialSessionRecovery !== undefined
        ? this.#verifyInitialSessionRecovery(identity, state, initialSessionRecovery, prompt, profile, stage) : null;
      let review;
      if (state.runNumber && !recovery) {
        if (!state.sessionId) throw new Error('CLI session missing; explicit recovery required');
        review = this.readReview(identity, state.runNumber);
        if (review?.decision !== 'continue') throw new Error('CLI continuation review required');
        if (updatesContract && (review.runNumber !== state.runNumber || review.resultSha256 !== sha256File(state.currentResultPath))) throw new Error('CLI contract update result fingerprint mismatch');
      }
      // The start contract and prior runs remain history; only an explicit owner-authorized
      // continuation replaces the effective scope. Every run pins the contract it dispatched.
      const effectiveContract = clone(updatesContract ? contract : state.effectiveContract ?? state.contract);
      const contractUpdate = updatesContract ? { authorizationLocator, previousRunNumber: state.runNumber, previousContractSha256: digest(state.effectiveContract ?? state.contract), reviewSha256: digest(review) } : null;
      const number = state.runNumber + 1, dir = this.checkedPath(this.runDir(identity, number), { createDirectory: true });
      run ??= { ...Object.fromEntries(['projectId', 'taskId', 'ownerThreadId'].map(k => [k, identity[k]])), runNumber: number, requestId, sessionId: state.sessionId, ownerTurnId: ownerTurnId ?? state.ownerTurnId, status: 'starting', resultPath: path.join(dir, 'result.json'), effectiveContract, ...(contractUpdate ? { contractUpdate } : {}), ...(profile ? { profile: clone(profile) } : {}), ...(recovery ? { initialSessionRecovery: recovery } : {}), ...(stage !== undefined ? { stage: clone(stage) } : {}), ...(continuationId !== undefined ? { continuationId } : {}) };
      if (run.runNumber !== number || run.sessionId !== state.sessionId) throw new Error('CLI replay intent mismatch');
      if (recovery && digest(run.initialSessionRecovery) !== digest(recovery)) throw new Error('CLI initial session recovery evidence changed');
      if (updatesContract && (digest(run.effectiveContract) !== digest(effectiveContract) || digest(run.contractUpdate) !== digest(contractUpdate))) throw new Error('CLI contract update evidence changed');
      const immutable = (file, value) => { if (fs.existsSync(file)) { if (digest(this.readJson(file)) !== digest(value)) throw new Error('CLI run intent conflict'); } else atomicJson(file, value); };
      this.checkedPath(path.dirname(requestFile), { createDirectory: true });
      immutable(requestFile, { fingerprint, run });
      if (faultAt === 'afterRequest') throw new Error('injected fault afterRequest');
      immutable(path.join(dir, 'run.json'), run);
      if (faultAt === 'afterRun') throw new Error('injected fault afterRun');
      immutable(path.join(dir, 'input.json'), { prompt, fingerprint });
      if (faultAt === 'afterInput') throw new Error('injected fault afterInput');
      const updatedAt = now();
      atomicJson(this.locator(identity), { ...state, effectiveContract: clone(run.effectiveContract ?? state.contract), ...(configuration ? { configuration: clone(configuration) } : {}), ...(continuationId !== undefined ? { continuations: state.continuations.map(item => item === pending ? { ...item, status: 'consumed', targetRunNumber: number, consumedAt: updatedAt } : item) } : {}), runNumber: number, status: 'starting', ownerTurnId: run.ownerTurnId, currentResultPath: null, managerPid: null, processIdentity: null, updatedAt });
      return run;
    });
  }
  currentRun(run) {
    const state = this.read(run);
    if (state.runNumber !== run.runNumber) throw new Error('CLI stale run');
    const saved = this.readJson(path.join(this.runDir(run, run.runNumber), 'run.json'));
    if (saved.requestId !== run.requestId) throw new Error('CLI run identity mismatch');
    return state;
  }
  bindSession(run, sessionId) {
    validIdentifier(sessionId);
    return this.withLock(run, () => {
      const state = this.currentRun(run);
      if (terminal.has(state.status)) throw new Error('CLI run already ended');
      if (state.sessionId && state.sessionId !== sessionId) throw new Error('CLI session mismatch');
      const updated = { ...state, sessionId, updatedAt: now() }; atomicJson(this.locator(run), updated); return updated;
    });
  }
  setProcess(run, processIdentity) {
    return this.withLock(run, () => {
      const state = this.currentRun(run);
      if (terminal.has(state.status) || state.processIdentity) throw new Error('CLI process binding conflict');
      if (!Number.isSafeInteger(processIdentity.pid) || processIdentity.pid < 1 || !processIdentity.startedAt || !processIdentity.token) throw new Error('invalid CLI process identity');
      const proof = this.checkedPath(path.join(this.runDir(run, run.runNumber), 'manager-process.json'));
      if (fs.existsSync(proof)) { if (digest(this.readJson(proof)) !== digest(processIdentity)) throw new Error('CLI manager process proof conflict'); }
      else atomicJson(proof, processIdentity);
      const updated = { ...state, status: 'running', managerPid: processIdentity.pid, processIdentity, updatedAt: now() };
      atomicJson(this.locator(run), updated); return updated;
    });
  }
  setChildProcess(run, identity) {
    return this.withLock(run, () => {
      const state = this.currentRun(run);
      if (terminal.has(state.status) || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || !identity.startedAt || !identity.token) throw new Error('invalid CLI child process identity');
      const file = this.checkedPath(path.join(this.runDir(run, run.runNumber), 'cli-process.json'));
      if (fs.existsSync(file)) throw new Error('CLI child process binding conflict');
      atomicJson(file, { ...clone(identity), runNumber: run.runNumber, requestId: run.requestId });
    });
  }
  requestStop(identity, { stateSha256, expectedSessionId, reason, requestId }) {
    return this.withLock(identity, () => {
      const state = this.read(identity);
      if (digest(state) !== stateSha256) throw new Error('CLI state fingerprint mismatch');
      if (expectedSessionId !== state.sessionId) throw new Error('CLI session mismatch');
      if (!reason || !state.processIdentity || terminal.has(state.status)) throw new Error('CLI active process proof required');
      const file = path.join(this.runDir(identity, state.runNumber), 'stop.json'); this.checkedPath(file);
      const value = { requestId: validIdentifier(requestId), reason: String(reason), processIdentity: state.processIdentity, runNumber: state.runNumber, sessionId: state.sessionId, requestedAt: now() };
      if (fs.existsSync(file)) throw new Error('CLI stop already requested');
      // Cancel before publishing stop intent, so a crash never leaves that intent
      // visible with an older queued instruction still eligible for automatic resume.
      if ((state.continuations ?? []).some(item => item.status === 'pending' && item.expectedRunNumber === state.runNumber)) {
        atomicJson(this.locator(identity), { ...state, continuations: state.continuations.map(item => item.status === 'pending' && item.expectedRunNumber === state.runNumber ? { ...item, status: 'cancelled', reason: `CLI stop requested: ${reason}`, cancelledAt: value.requestedAt, stopRequestId: requestId } : item), updatedAt: value.requestedAt });
      }
      atomicJson(file, value); return { status: 'stop-requested', runNumber: state.runNumber };
    });
  }
  finishRun(run, result, { faultAt = null, stateSha256 = null } = {}) {
    return this.withLock(run, () => {
      const state = this.currentRun(run), dir = this.runDir(run, run.runNumber);
      if (stateSha256 && digest(state) !== stateSha256) throw new Error('CLI state fingerprint mismatch');
      if (!terminal.has(result.status)) throw new Error('invalid CLI terminal status');
      if (result.sessionId !== undefined && result.sessionId !== state.sessionId) throw new Error('CLI session mismatch');
      for (const key of ['projectId', 'taskId', 'ownerThreadId']) if (result[key] !== undefined && result[key] !== state[key]) throw new Error('CLI result identity mismatch');
      const normalized = { projectId: state.projectId, taskId: state.taskId, ownerThreadId: state.ownerThreadId, runNumber: run.runNumber, sessionId: state.sessionId, status: result.status, exitCode: result.exitCode ?? null, finalText: result.finalText ?? '', eventsPath: path.join(dir, 'events.jsonl'), stderrPath: path.join(dir, 'stderr.log'), error: result.error ?? null, completedAt: validTime(result.completedAt ?? now()) };
      const runProfile = this.readJson(path.join(dir, 'run.json')).profile;
      if (runProfile) normalized.configuration = { provider: runProfile.provider ?? 'codex', model: runProfile.model, effort: runProfile.effort ?? (runProfile.mode === 'interactive' && !runProfile.provider ? 'medium' : null) };
      const file = path.join(dir, 'result.json'); this.checkedPath(file);
      if (fs.existsSync(file)) throw new Error('CLI result already stable; stale write rejected');
      atomicJson(file, normalized);
      if (faultAt === 'afterResult') throw new Error('injected fault afterResult');
      atomicJson(this.locator(run), { ...state, status: normalized.status, currentResultPath: file, managerPid: null, processIdentity: null, updatedAt: now() });
      return normalized;
    });
  }
  reconcileResult(identity, stateSha256) {
    return this.withLock(identity, () => {
      this.assertTransferSettled(identity);
      const state = this.read(identity);
      if (digest(state) !== stateSha256) throw new Error('CLI state fingerprint mismatch');
      const result = this.readResult(identity, state.runNumber);
      if (result.sessionId !== state.sessionId) throw new Error('CLI saved result session mismatch');
      atomicJson(this.locator(identity), { ...state, status: result.status, currentResultPath: path.join(this.runDir(identity, state.runNumber), 'result.json'), managerPid: null, processIdentity: null, updatedAt: now() });
      return result;
    });
  }
  readResult(identity, number) {
    const state = this.read(identity);
    const result = this.readJson(path.join(this.runDir(identity, number), 'result.json')); sameHistoricalIdentity(state, result, identity);
    if (result.runNumber !== number || !terminal.has(result.status)) throw new Error('CLI result mismatch');
    for (const [key, leaf] of [['eventsPath', 'events.jsonl'], ['stderrPath', 'stderr.log']]) if (result[key] !== path.join(this.runDir(identity, number), leaf)) throw new Error('CLI result path mismatch');
    return result;
  }
  #reviewPaths(identity, number) {
    this.readResult(identity, number);
    const state = this.read(identity), dir = this.runDir(identity, number);
    // A successor reviews the preserved result independently; the predecessor's review is immutable.
    const transfer = state.transferOperationId ? this.readJson(path.join(this.transferDirectory(identity, state.transferOperationId), 'transfer.json')) : null;
    if (!transfer || number > transfer.expectedRunNumber) return { file: path.join(dir, 'review.json'), continuation: path.join(dir, 'resume-review.json') };
    const directory = this.checkedPath(path.join(dir, 'owner-reviews', state.transferOperationId));
    return { file: path.join(directory, `${validIdentifier(identity.ownerThreadId)}.json`), continuation: path.join(directory, `${identity.ownerThreadId}.resume.json`) };
  }
  assertTransferSettled(identity, operationId = null) {
    const directory = this.checkedPath(path.join(this.taskDir(identity), 'transfers'));
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      const file = this.checkedPath(path.join(directory, name, 'transfer.json'));
      if (name !== operationId && fs.existsSync(file) && ['authorized', 'task-transferred'].includes(this.readJson(file).phase)) throw new Error('CLI owner transfer pending; finish the same transfer before changing this task');
    }
  }
  readReview(identity, number) {
    this.readResult(identity, number);
    const { file, continuation } = this.#reviewPaths(identity, number); this.checkedPath(file);
    if (!fs.existsSync(file)) return null;
    const value = this.readJson(file); sameIdentity(value, identity);
    if (!fs.existsSync(continuation)) return value;
    const next = this.readJson(continuation); sameIdentity(next, identity);
    if (value.decision !== 'pause' || next.decision !== 'continue' || next.supersedesReviewSha256 !== sha256File(file) || next.resultSha256 !== value.resultSha256 || !next.authorizationLocator) throw new Error('CLI continuation review conflict');
    return next;
  }
  recordReview(review) {
    return this.withLock(review, () => {
      const state = this.read(review); this.readResult(review, review.runNumber);
      if (state.runNumber !== review.runNumber) throw new Error('CLI stale review');
      if (sha256File(state.currentResultPath) !== review.resultSha256) throw new Error('CLI result fingerprint mismatch');
      if (!['continue', 'accept', 'pause', 'close'].includes(review.decision) || !review.evidenceLocator || !review.conclusion) throw new Error('CLI review evidence required');
      validTime(review.reviewedAt);
      this.assertTransferSettled(review);
      const { file, continuation } = this.#reviewPaths(review, review.runNumber);
      this.checkedPath(path.dirname(file), { createDirectory: true });
      if (fs.existsSync(file)) {
        const previous = this.readJson(file);
        if (digest(previous) === digest(review)) { this.#cancelReviewedContinuations(state, review); return clone(review); }
        if (previous.decision !== 'pause' || review.decision !== 'continue' || review.supersedesReviewSha256 !== sha256File(file) || !review.authorizationLocator) throw new Error('CLI review conflict');
        if (fs.existsSync(continuation)) { if (digest(this.readJson(continuation)) !== digest(review)) throw new Error('CLI review conflict'); }
        else atomicJson(continuation, review);
        return clone(review);
      }
      atomicJson(file, review); this.#cancelReviewedContinuations(state, review); return clone(review);
    });
  }
  #cancelReviewedContinuations(state, review) {
    if (!['accept', 'close'].includes(review.decision) || !(state.continuations ?? []).some(item => item.status === 'pending' && item.expectedRunNumber === review.runNumber)) return;
    // Review is immutable first. Repeating it repairs a crash before this state write.
    const cancelledAt = now();
    const continuations = state.continuations.map(item => item.status === 'pending' && item.expectedRunNumber === review.runNumber ? { ...item, status: 'cancelled', reason: `CLI ${review.decision} review`, reviewSha256: digest(review), cancelledAt } : item);
    atomicJson(this.locator(state), { ...state, continuations, updatedAt: cancelledAt });
  }
  claimNotification(identity, number) {
    return this.withLock(identity, () => {
      if (this.readResult(identity, number).ownerThreadId !== identity.ownerThreadId) throw new Error('Historical CLI notification belongs to its original owner');
      const markerPath = path.join(this.runDir(identity, number), 'notification.json'); this.checkedPath(markerPath);
      if (fs.existsSync(markerPath)) return { claimed: false, markerPath };
      atomicJson(markerPath, { status: 'claimed', claimedAt: now() }); return { claimed: true, markerPath };
    });
  }
  finishNotification(identity, number, outcome) {
    return this.withLock(identity, () => {
      this.readResult(identity, number);
      const file = path.join(this.runDir(identity, number), 'notification.json'), previous = this.readJson(file);
      if (!['delivered', 'delivery-unknown', 'unavailable'].includes(outcome.status)) throw new Error('invalid notification outcome');
      if (previous.status !== 'claimed') throw new Error('notification already finalized');
      atomicJson(file, { ...previous, ...outcome, finishedAt: now() }); return { ...outcome, markerPath: file };
    });
  }
  transferDirectory(identity, operationId) {
    validIdentifier(operationId);
    return this.checkedPath(path.join(this.taskDir(identity), 'transfers', operationId));
  }
  #inventory(taskDirectory) {
    const files = [];
    const walk = relative => {
      const absolute = this.checkedPath(path.join(taskDirectory, relative));
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const child = relative ? path.join(relative, entry.name) : entry.name;
        if (entry.isDirectory()) {
          if (['.lock', 'transfers'].includes(entry.name)) continue;
          walk(child);
        } else if (entry.isFile() && entry.name !== 'remote-token') files.push(child);
      }
    };
    walk('');
    return files.sort().map(file => ({ file, size: fs.statSync(path.join(taskDirectory, file)).size, sha256: sha256File(path.join(taskDirectory, file)) }));
  }
  #transferInput(input) {
    validIdentifier(input.operationId); validIdentifier(input.projectId); validIdentifier(input.taskId);
    validIdentifier(input.fromOwnerThreadId); validIdentifier(input.toOwnerThreadId); validIdentifier(input.expectedSessionId);
    validNonEmpty(input.authorizationLocator, 'authorizationLocator');
    if (!['formal', 'assist'].includes(input.taskMode ?? 'formal')) throw new Error('invalid CLI transfer mode');
    if (input.fromOwnerThreadId === input.toOwnerThreadId) throw new Error('CLI transfer owner unchanged');
    if (!Number.isSafeInteger(input.expectedRunNumber) || input.expectedRunNumber < 1) throw new Error('invalid CLI transfer run');
    for (const key of ['expectedStateSha256', 'expectedResultSha256']) if (!/^[a-f0-9]{64}$/.test(input[key] ?? '')) throw new Error('CLI transfer exact fingerprint required');
    return input;
  }
  #verifyTransferInput(record, input) {
    if ((record.taskMode ?? 'formal') !== (input.taskMode ?? 'formal')) throw new Error('CLI transfer request conflict');
    for (const key of ['operationId', 'projectId', 'taskId', 'fromOwnerThreadId', 'toOwnerThreadId', 'expectedStateSha256', 'expectedSessionId', 'expectedRunNumber', 'expectedResultSha256', 'authorizationLocator']) {
      if (record[key] !== input[key]) throw new Error('CLI transfer request conflict');
    }
  }
  #authorizeTransferCaller(record, callerThreadId) {
    validIdentifier(callerThreadId);
    if (record.callerThreadId === callerThreadId) return;
    if (callerThreadId === record.toOwnerThreadId && processIsGone(record.callerProcessIdentity)) return;
    throw new Error('CLI transfer recovery caller mismatch or previous transfer caller still active');
  }
  #verifyStableTransferState(input, state) {
    if ((state.continuations ?? []).some(item => item.status === 'pending')) throw new Error('CLI pending continuation must be cancelled before owner transfer');
    if (state.taskMode !== (input.taskMode ?? 'formal')) throw new Error('CLI transfer task mode mismatch');
    if (state.status !== 'completed' || state.managerPid !== null || state.processIdentity) throw new Error('CLI transfer requires a completed stable run');
    if (state.sessionId !== input.expectedSessionId || state.runNumber !== input.expectedRunNumber) throw new Error('CLI transfer session or run mismatch');
    const result = this.readResult({ ...state, ownerThreadId: state.ownerThreadId }, state.runNumber);
    if (result.status !== 'completed' || sha256File(state.currentResultPath) !== input.expectedResultSha256) throw new Error('CLI transfer result fingerprint mismatch');
    if (['accept', 'close'].includes(this.readReview({ ...state, ownerThreadId: state.ownerThreadId }, state.runNumber)?.decision)) throw new Error('CLI terminal review must be completed before transfer');
    this.#verifyStableTransferProcessProofs(input, state);
  }
  #verifyStableTransferEndpoint(input, endpoint) {
    if (!endpoint) return;
    if (endpoint.projectId !== input.projectId || endpoint.taskId !== input.taskId) throw new Error('CLI transfer endpoint identity mismatch');
    if (!['idle', 'closed'].includes(endpoint.status) || endpoint.activeTurnId) throw new Error('CLI native helper is not idle');
    for (const key of ['manager', 'server']) if (endpoint[key] && !processIsGone(endpoint[key])) throw new Error('CLI native helper still exists');
  }
  #verifyStableTransferProcessProofs(input, state) {
    for (let number = 1; number <= state.runNumber; number += 1) {
      const directory = this.runDir({ ...input, ownerThreadId: input.fromOwnerThreadId }, number);
      const processProofs = ['manager-process.json', 'cli-process.json'].map(leaf => fs.existsSync(path.join(directory, leaf)) ? this.readJson(path.join(directory, leaf)) : null).filter(Boolean);
      const claimFile = path.join(directory, 'manager-claim.json');
      if (!processProofs.length && fs.existsSync(claimFile)) processProofs.push(this.readJson(claimFile).caller);
      if (!fs.existsSync(path.join(directory, 'cli-process.json')) && fs.existsSync(path.join(directory, 'cli-launch-intent.json'))) throw new Error('CLI child process proof unavailable after launch intent');
      for (const proof of processProofs) if (!processIsGone(proof)) throw new Error('CLI saved process proof is still alive');
    }
  }
  #verifyTransferredTransferState(input, state) {
    if (state.ownerThreadId !== input.toOwnerThreadId || state.transferOperationId !== input.operationId) throw new Error('CLI transfer state ownership conflict');
    if (!state.ownerProvenance || state.ownerProvenance.originalOwnerThreadId !== input.fromOwnerThreadId || state.ownerProvenance.currentOwnerThreadId !== input.toOwnerThreadId) throw new Error('CLI transfer provenance mismatch');
    if (!state.ownerTransfers?.some(item => item.operationId === input.operationId && item.fromOwnerThreadId === input.fromOwnerThreadId && item.toOwnerThreadId === input.toOwnerThreadId)) throw new Error('CLI transfer audit chain mismatch');
    this.#verifyStableTransferState(input, state);
    const endpointFile = path.join(this.taskDir(state), 'interactive.json');
    this.#verifyStableTransferEndpoint(input, fs.existsSync(endpointFile) ? this.readJson(endpointFile) : null);
  }
  beginTransfer(identity, input) {
    this.#transferInput(input);
    return this.withLock({ ...input, ownerThreadId: input.fromOwnerThreadId }, () => {
      const file = this.checkedPath(path.join(this.transferDirectory({ ...input, ownerThreadId: input.fromOwnerThreadId }, input.operationId), 'transfer.json'));
      if (fs.existsSync(file)) {
        const record = this.readJson(file);
        this.#verifyTransferInput(record, input);
        this.#authorizeTransferCaller(record, identity.ownerThreadId);
        if (record.phase === 'completed') return record;
        let state;
        try { state = this.read({ ...input, ownerThreadId: input.fromOwnerThreadId }); }
        catch { state = this.read({ ...input, ownerThreadId: input.toOwnerThreadId }); }
        if (state.ownerThreadId === input.fromOwnerThreadId) {
          if (digest(state) !== input.expectedStateSha256) throw new Error('CLI transfer state fingerprint mismatch');
          this.#verifyStableTransferState(input, state);
          const endpointFile = path.join(this.taskDir(state), 'interactive.json');
          this.#verifyStableTransferEndpoint(input, fs.existsSync(endpointFile) ? this.readJson(endpointFile) : null);
        } else this.#verifyTransferredTransferState(input, state);
        return record;
      }
      const state = this.read({ ...input, ownerThreadId: input.fromOwnerThreadId });
      this.assertTransferSettled(state);
      if (identity.ownerThreadId !== input.fromOwnerThreadId && identity.ownerThreadId !== input.toOwnerThreadId) throw new Error('CLI transfer caller identity mismatch');
      if (state.ownerThreadId !== input.fromOwnerThreadId) throw new Error('CLI transfer source owner mismatch');
      if (digest(state) !== input.expectedStateSha256) throw new Error('CLI transfer state fingerprint mismatch');
      this.#verifyStableTransferState(input, state);
      const endpointFile = path.join(this.taskDir(state), 'interactive.json');
      const endpoint = fs.existsSync(endpointFile) ? this.readJson(endpointFile) : null;
      if (endpoint && endpoint.ownerThreadId !== input.fromOwnerThreadId) throw new Error('CLI transfer endpoint owner mismatch');
      this.#verifyStableTransferEndpoint(input, endpoint);
      const directory = this.transferDirectory({ ...input, ownerThreadId: input.fromOwnerThreadId }, input.operationId);
      this.checkedPath(directory, { createDirectory: true });
      fs.copyFileSync(this.locator(state), path.join(directory, 'task.preimage.json'));
      const originalTaskSha256 = sha256File(this.locator(state));
      const originalInteractiveSha256 = endpoint ? (fs.copyFileSync(endpointFile, path.join(directory, 'interactive.preimage.json')), sha256File(endpointFile)) : null;
      const record = { schemaVersion: 1, phase: 'authorized', ...clone(input), callerThreadId: identity.ownerThreadId, callerProcessIdentity: currentProcessIdentity(), authorizedAt: now(), originalTaskSha256, originalInteractiveSha256, originalEndpointPresent: Boolean(endpoint), inventory: this.#inventory(this.taskDir(state)) };
      atomicJson(file, record);
      return clone(record);
    });
  }
  applyTransfer(input) {
    this.#transferInput(input);
    return this.withLock({ ...input, ownerThreadId: input.toOwnerThreadId }, () => {
      const file = this.checkedPath(path.join(this.transferDirectory({ ...input, ownerThreadId: input.toOwnerThreadId }, input.operationId), 'transfer.json'));
      const record = this.readJson(file); this.#verifyTransferInput(record, input);
      if (record.phase === 'completed') return record;
      if (record.phase === 'task-transferred') { this.verifyTransferredTransfer(input); return record; }
      if (record.phase !== 'authorized') throw new Error('CLI transfer phase conflict');
      const endpointFile = path.join(this.taskDir({ ...input, ownerThreadId: input.fromOwnerThreadId }), 'interactive.json');
      let state, transferredAt;
      try {
        state = this.read({ ...input, ownerThreadId: input.fromOwnerThreadId });
        if (digest(state) !== input.expectedStateSha256) throw new Error('CLI transfer state fingerprint mismatch');
        if (sha256File(this.locator(state)) !== record.originalTaskSha256) throw new Error('CLI task changed after transfer authorization');
        if (record.originalEndpointPresent) {
          const endpoint = this.readJson(endpointFile);
          this.#verifyStableTransferEndpoint(input, endpoint);
          if (endpoint.ownerThreadId !== input.toOwnerThreadId) {
            if (sha256File(endpointFile) !== record.originalInteractiveSha256) throw new Error('CLI endpoint changed after transfer authorization');
            atomicJson(endpointFile, { ...endpoint, ownerThreadId: input.toOwnerThreadId, transferredAt: now(), transferOperationId: input.operationId });
          }
        }
        transferredAt = now();
        const transferRecord = { fromOwnerThreadId: input.fromOwnerThreadId, toOwnerThreadId: input.toOwnerThreadId, operationId: input.operationId, transferredAt, authorizationLocator: input.authorizationLocator };
        const updated = { ...state, ownerThreadId: input.toOwnerThreadId, transferOperationId: input.operationId, ownerProvenance: { originalOwnerThreadId: input.fromOwnerThreadId, currentOwnerThreadId: input.toOwnerThreadId, transferredAt }, ownerTransfers: [...(state.ownerTransfers ?? []), transferRecord], updatedAt: transferredAt };
        atomicJson(this.locator(updated), updated);
        state = updated;
      } catch (error) {
        if (error.message !== 'CLI identity mismatch') throw error;
        state = this.read({ ...input, ownerThreadId: input.toOwnerThreadId });
        this.#verifyTransferredTransferState(input, state);
        transferredAt = state.ownerProvenance.transferredAt;
      }
      const completed = { ...record, phase: 'task-transferred', currentOwnerThreadId: input.toOwnerThreadId, transferredAt };
      atomicJson(file, completed);
      return completed;
    });
  }
  completeTransfer(input, { workbenchStateSha256 } = {}) {
    this.#transferInput(input);
    if ((input.taskMode ?? 'formal') === 'formal') validNonEmpty(workbenchStateSha256, 'workbenchStateSha256');
    return this.withLock({ ...input, ownerThreadId: input.toOwnerThreadId }, () => {
      const file = this.checkedPath(path.join(this.transferDirectory({ ...input, ownerThreadId: input.toOwnerThreadId }, input.operationId), 'transfer.json'));
      const record = this.readJson(file); this.#verifyTransferInput(record, input);
      if (record.phase === 'completed') return record;
      if (record.phase !== 'task-transferred') throw new Error('CLI transfer phase conflict');
      const state = this.read({ ...input, ownerThreadId: input.toOwnerThreadId });
      if (state.ownerThreadId !== input.toOwnerThreadId || state.transferOperationId !== input.operationId) throw new Error('CLI transferred state mismatch');
      const completed = { ...record, phase: 'completed', ...((input.taskMode ?? 'formal') === 'formal' ? { workbenchStateSha256 } : {}), completedAt: now() };
      atomicJson(file, completed);
      return completed;
    });
  }
  verifyTransferredTransfer(input) {
    this.#transferInput(input);
    const state = this.read({ ...input, ownerThreadId: input.toOwnerThreadId });
    this.#verifyTransferredTransferState(input, state);
    return state;
  }
  validateTransferCandidate(input) {
    this.#transferInput(input);
    const state = this.read({ ...input, ownerThreadId: input.fromOwnerThreadId });
    this.assertTransferSettled(state, input.operationId);
    if (digest(state) !== input.expectedStateSha256) throw new Error('CLI transfer state fingerprint mismatch');
    this.#verifyStableTransferState(input, state);
    const endpointFile = path.join(this.taskDir(state), 'interactive.json');
    const endpoint = fs.existsSync(endpointFile) ? this.readJson(endpointFile) : null;
    if (endpoint && ![input.fromOwnerThreadId, input.toOwnerThreadId].includes(endpoint.ownerThreadId)) throw new Error('CLI transfer endpoint owner mismatch');
    this.#verifyStableTransferEndpoint(input, endpoint);
    return state;
  }
}
