import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { currentProcessIdentity, processIsGone } from './process-identity.mjs';

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
    const lock = this.checkedPath(path.join(dir, '.lock'));
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
    for (const key of ['goal', 'boundaries', 'acceptance']) if (typeof binding.contract?.[key] !== 'string' || !binding.contract[key].trim()) throw new Error('CLI contract is required');
    for (const key of ['factEntries', 'skillEntries']) if (!Array.isArray(binding.contract[key]) || binding.contract[key].some(x => typeof x !== 'string')) throw new Error('invalid contract entries');
    return this.withLock(binding, () => {
      const file = this.locator(binding);
      if (fs.existsSync(file)) {
        const stored = this.read(binding);
        for (const [key, value] of Object.entries(binding)) if (key !== 'ownerTurnId' && digest(stored[key]) !== digest(value)) throw new Error('CLI binding conflict');
        return stored;
      }
      const state = { schemaVersion: 1, ...clone(binding), sessionId: null, runNumber: 0, status: 'starting', currentResultPath: null, managerPid: null, processIdentity: null, updatedAt: now() };
      atomicJson(file, state); return state;
    });
  }
  read(identity) {
    const state = this.readJson(this.locator(identity)); sameIdentity(state, identity);
    if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.runNumber) || state.runNumber < 0) throw new Error('invalid CLI state');
    if (state.currentResultPath && state.currentResultPath !== path.join(this.runDir(identity, state.runNumber), 'result.json')) throw new Error('CLI result path mismatch');
    return state;
  }
  beginRun(identity, { requestId, prompt, expectedRunNumber, expectedSessionId, ownerTurnId, profile, configuration, faultAt = null }) {
    validIdentifier(requestId);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('CLI prompt required');
    if (ownerTurnId !== undefined) validIdentifier(ownerTurnId);
    return this.withLock(identity, () => {
      this.assertTransferSettled(identity);
      const state = this.read(identity), requestFile = this.checkedPath(path.join(this.taskDir(identity), 'requests', `${requestId}.json`));
      const fingerprint = digest({ requestId, prompt, expectedRunNumber, expectedSessionId, ...(profile ? { profile } : {}), ...(configuration ? { configuration } : {}) });
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
      if (state.runNumber) {
        if (!state.sessionId) throw new Error('CLI session missing; explicit recovery required');
        if (this.readReview(identity, state.runNumber)?.decision !== 'continue') throw new Error('CLI continuation review required');
      }
      const number = state.runNumber + 1, dir = this.checkedPath(this.runDir(identity, number), { createDirectory: true });
      run ??= { ...Object.fromEntries(['projectId', 'taskId', 'ownerThreadId'].map(k => [k, identity[k]])), runNumber: number, requestId, sessionId: state.sessionId, ownerTurnId: ownerTurnId ?? state.ownerTurnId, status: 'starting', resultPath: path.join(dir, 'result.json'), ...(profile ? { profile: clone(profile) } : {}) };
      if (run.runNumber !== number || run.sessionId !== state.sessionId) throw new Error('CLI replay intent mismatch');
      const immutable = (file, value) => { if (fs.existsSync(file)) { if (digest(this.readJson(file)) !== digest(value)) throw new Error('CLI run intent conflict'); } else atomicJson(file, value); };
      this.checkedPath(path.dirname(requestFile), { createDirectory: true });
      immutable(requestFile, { fingerprint, run });
      if (faultAt === 'afterRequest') throw new Error('injected fault afterRequest');
      immutable(path.join(dir, 'run.json'), run);
      if (faultAt === 'afterRun') throw new Error('injected fault afterRun');
      immutable(path.join(dir, 'input.json'), { prompt, fingerprint });
      if (faultAt === 'afterInput') throw new Error('injected fault afterInput');
      atomicJson(this.locator(identity), { ...state, ...(configuration ? { configuration: clone(configuration) } : {}), runNumber: number, status: 'starting', ownerTurnId: run.ownerTurnId, currentResultPath: null, managerPid: null, processIdentity: null, updatedAt: now() });
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
        if (digest(previous) === digest(review)) return clone(review);
        if (previous.decision !== 'pause' || review.decision !== 'continue' || review.supersedesReviewSha256 !== sha256File(file) || !review.authorizationLocator) throw new Error('CLI review conflict');
        if (fs.existsSync(continuation)) { if (digest(this.readJson(continuation)) !== digest(review)) throw new Error('CLI review conflict'); }
        else atomicJson(continuation, review);
        return clone(review);
      }
      atomicJson(file, review); return clone(review);
    });
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
    if (input.fromOwnerThreadId === input.toOwnerThreadId) throw new Error('CLI transfer owner unchanged');
    if (!Number.isSafeInteger(input.expectedRunNumber) || input.expectedRunNumber < 1) throw new Error('invalid CLI transfer run');
    for (const key of ['expectedStateSha256', 'expectedResultSha256']) if (!/^[a-f0-9]{64}$/.test(input[key] ?? '')) throw new Error('CLI transfer exact fingerprint required');
    return input;
  }
  #verifyTransferInput(record, input) {
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
    if (state.taskMode !== 'formal') throw new Error('only formal CLI tasks can transfer');
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
  completeTransfer(input, { workbenchStateSha256 }) {
    this.#transferInput(input); validNonEmpty(workbenchStateSha256, 'workbenchStateSha256');
    return this.withLock({ ...input, ownerThreadId: input.toOwnerThreadId }, () => {
      const file = this.checkedPath(path.join(this.transferDirectory({ ...input, ownerThreadId: input.toOwnerThreadId }, input.operationId), 'transfer.json'));
      const record = this.readJson(file); this.#verifyTransferInput(record, input);
      if (record.phase === 'completed') return record;
      if (record.phase !== 'task-transferred') throw new Error('CLI transfer phase conflict');
      const state = this.read({ ...input, ownerThreadId: input.toOwnerThreadId });
      if (state.ownerThreadId !== input.toOwnerThreadId || state.transferOperationId !== input.operationId) throw new Error('CLI transferred state mismatch');
      const completed = { ...record, phase: 'completed', workbenchStateSha256, completedAt: now() };
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
