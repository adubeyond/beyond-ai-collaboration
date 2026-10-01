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
  beginRun(identity, { requestId, prompt, expectedRunNumber, expectedSessionId, ownerTurnId, faultAt = null }) {
    validIdentifier(requestId);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('CLI prompt required');
    if (ownerTurnId !== undefined) validIdentifier(ownerTurnId);
    return this.withLock(identity, () => {
      const state = this.read(identity), requestFile = this.checkedPath(path.join(this.taskDir(identity), 'requests', `${requestId}.json`));
      const fingerprint = digest({ requestId, prompt, expectedRunNumber, expectedSessionId });
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
      run ??= { ...Object.fromEntries(['projectId', 'taskId', 'ownerThreadId'].map(k => [k, identity[k]])), runNumber: number, requestId, sessionId: state.sessionId, ownerTurnId: ownerTurnId ?? state.ownerTurnId, status: 'starting', resultPath: path.join(dir, 'result.json') };
      if (run.runNumber !== number || run.sessionId !== state.sessionId) throw new Error('CLI replay intent mismatch');
      const immutable = (file, value) => { if (fs.existsSync(file)) { if (digest(this.readJson(file)) !== digest(value)) throw new Error('CLI run intent conflict'); } else atomicJson(file, value); };
      this.checkedPath(path.dirname(requestFile), { createDirectory: true });
      immutable(requestFile, { fingerprint, run });
      if (faultAt === 'afterRequest') throw new Error('injected fault afterRequest');
      immutable(path.join(dir, 'run.json'), run);
      if (faultAt === 'afterRun') throw new Error('injected fault afterRun');
      immutable(path.join(dir, 'input.json'), { prompt, fingerprint });
      if (faultAt === 'afterInput') throw new Error('injected fault afterInput');
      atomicJson(this.locator(identity), { ...state, runNumber: number, status: 'starting', ownerTurnId: run.ownerTurnId, currentResultPath: null, managerPid: null, processIdentity: null, updatedAt: now() });
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
      const state = this.read(identity);
      if (digest(state) !== stateSha256) throw new Error('CLI state fingerprint mismatch');
      const result = this.readResult(identity, state.runNumber);
      if (result.sessionId !== state.sessionId) throw new Error('CLI saved result session mismatch');
      atomicJson(this.locator(identity), { ...state, status: result.status, currentResultPath: path.join(this.runDir(identity, state.runNumber), 'result.json'), managerPid: null, processIdentity: null, updatedAt: now() });
      return result;
    });
  }
  readResult(identity, number) {
    this.read(identity);
    const result = this.readJson(path.join(this.runDir(identity, number), 'result.json')); sameIdentity(result, identity);
    if (result.runNumber !== number || !terminal.has(result.status)) throw new Error('CLI result mismatch');
    for (const [key, leaf] of [['eventsPath', 'events.jsonl'], ['stderrPath', 'stderr.log']]) if (result[key] !== path.join(this.runDir(identity, number), leaf)) throw new Error('CLI result path mismatch');
    return result;
  }
  readReview(identity, number) {
    this.readResult(identity, number);
    const file = path.join(this.runDir(identity, number), 'review.json'); this.checkedPath(file);
    if (!fs.existsSync(file)) return null;
    const value = this.readJson(file); sameIdentity(value, identity);
    const continuation = path.join(this.runDir(identity, number), 'resume-review.json');
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
      const file = path.join(this.runDir(review, review.runNumber), 'review.json');
      if (fs.existsSync(file)) {
        const previous = this.readJson(file);
        if (digest(previous) === digest(review)) return clone(review);
        if (previous.decision !== 'pause' || review.decision !== 'continue' || review.supersedesReviewSha256 !== sha256File(file) || !review.authorizationLocator) throw new Error('CLI review conflict');
        const continuation = path.join(this.runDir(review, review.runNumber), 'resume-review.json');
        if (fs.existsSync(continuation)) { if (digest(this.readJson(continuation)) !== digest(review)) throw new Error('CLI review conflict'); }
        else atomicJson(continuation, review);
        return clone(review);
      }
      atomicJson(file, review); return clone(review);
    });
  }
  claimNotification(identity, number) {
    return this.withLock(identity, () => {
      this.readResult(identity, number);
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
}
