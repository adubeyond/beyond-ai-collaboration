import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
    try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('CLI lock conflict; owner verification required'); throw error; }
    try { atomicJson(path.join(lock, 'owner.json'), { pid: process.pid, acquiredAt: now() }); return action(); }
    finally { fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); }
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
        for (const [key, value] of Object.entries(binding)) if (digest(stored[key]) !== digest(value)) throw new Error('CLI binding conflict');
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
  beginRun(identity, { requestId, prompt, expectedRunNumber, expectedSessionId, ownerTurnId }) {
    validIdentifier(requestId);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('CLI prompt required');
    if (ownerTurnId !== undefined) validIdentifier(ownerTurnId);
    return this.withLock(identity, () => {
      const state = this.read(identity), requestFile = this.checkedPath(path.join(this.taskDir(identity), 'requests', `${requestId}.json`));
      const fingerprint = digest({ requestId, prompt, expectedRunNumber, expectedSessionId, ownerTurnId });
      if (fs.existsSync(requestFile)) {
        const previous = this.readJson(requestFile);
        if (previous.fingerprint !== fingerprint) throw new Error('CLI request conflict');
        return previous.run;
      }
      if (expectedSessionId !== state.sessionId) throw new Error('CLI session mismatch');
      if (expectedRunNumber !== state.runNumber) throw new Error('CLI stale run conflict');
      if (state.runNumber && !terminal.has(state.status)) throw new Error('CLI active run conflict');
      if (state.runNumber) {
        if (!state.sessionId) throw new Error('CLI session missing; explicit recovery required');
        if (this.readReview(identity, state.runNumber)?.decision !== 'continue') throw new Error('CLI continuation review required');
      }
      const number = state.runNumber + 1, dir = this.checkedPath(this.runDir(identity, number), { createDirectory: true });
      const run = { ...Object.fromEntries(['projectId', 'taskId', 'ownerThreadId'].map(k => [k, identity[k]])), runNumber: number, requestId, sessionId: state.sessionId, ownerTurnId: ownerTurnId ?? state.ownerTurnId, status: 'starting', resultPath: path.join(dir, 'result.json') };
      atomicJson(path.join(dir, 'run.json'), run);
      atomicJson(path.join(dir, 'input.json'), { prompt, fingerprint });
      this.checkedPath(path.dirname(requestFile), { createDirectory: true });
      atomicJson(requestFile, { fingerprint, run });
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
  finishRun(run, result) {
    return this.withLock(run, () => {
      const state = this.currentRun(run), dir = this.runDir(run, run.runNumber);
      if (!terminal.has(result.status)) throw new Error('invalid CLI terminal status');
      if (result.sessionId !== undefined && result.sessionId !== state.sessionId) throw new Error('CLI session mismatch');
      for (const key of ['projectId', 'taskId', 'ownerThreadId']) if (result[key] !== undefined && result[key] !== state[key]) throw new Error('CLI result identity mismatch');
      const normalized = { projectId: state.projectId, taskId: state.taskId, ownerThreadId: state.ownerThreadId, runNumber: run.runNumber, sessionId: state.sessionId, status: result.status, exitCode: result.exitCode ?? null, finalText: result.finalText ?? '', eventsPath: path.join(dir, 'events.jsonl'), stderrPath: path.join(dir, 'stderr.log'), error: result.error ?? null, completedAt: validTime(result.completedAt ?? now()) };
      const file = path.join(dir, 'result.json'); this.checkedPath(file);
      if (fs.existsSync(file)) throw new Error('CLI result already stable; stale write rejected');
      atomicJson(file, normalized);
      atomicJson(this.locator(run), { ...state, status: normalized.status, currentResultPath: file, managerPid: null, processIdentity: null, updatedAt: now() });
      return normalized;
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
    const value = this.readJson(file); sameIdentity(value, identity); return value;
  }
  recordReview(review) {
    return this.withLock(review, () => {
      const state = this.read(review); this.readResult(review, review.runNumber);
      if (state.runNumber !== review.runNumber) throw new Error('CLI stale review');
      if (sha256File(state.currentResultPath) !== review.resultSha256) throw new Error('CLI result fingerprint mismatch');
      if (!['continue', 'accept', 'pause', 'close'].includes(review.decision) || !review.evidenceLocator || !review.conclusion) throw new Error('CLI review evidence required');
      validTime(review.reviewedAt);
      const file = path.join(this.runDir(review, review.runNumber), 'review.json');
      if (fs.existsSync(file)) { if (digest(this.readJson(file)) !== digest(review)) throw new Error('CLI review conflict'); return clone(review); }
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
