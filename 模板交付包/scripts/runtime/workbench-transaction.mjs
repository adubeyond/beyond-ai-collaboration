import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MANAGED_BEGIN = '<!-- BEGIN BEYOND MANAGED WORKBENCH -->';
const MANAGED_END = '<!-- END BEYOND MANAGED WORKBENCH -->';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ACTIVE_STATES = new Set(['进行中', '已暂停']);

export class InjectedFault extends Error {
  constructor(point) {
    super(`injected fault: ${point}`);
    this.name = 'InjectedFault';
    this.point = point;
  }
}

function validId(value) {
  return SAFE_ID.test(value ?? '') && !Object.prototype.hasOwnProperty.call(Object.prototype, value);
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function markdown(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
}

function markdownCells(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('|')) return null;
  const cells = [];
  let current = '';
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === '\\' && trimmed[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (character === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim() || !trimmed.endsWith('|')) cells.push(current.trim());
  return cells;
}

function initialState() {
  return {
    schemaVersion: 1,
    revision: 0,
    projectSnapshot: null,
    tasks: {},
    recentMainlineResults: [],
    operations: {},
    operationOrder: [],
  };
}

function pristineState(state) {
  return state?.schemaVersion === 1 && state.revision === 0 && state.projectSnapshot === null
    && Object.keys(state.tasks ?? {}).length === 0
    && (state.recentMainlineResults ?? []).length === 0
    && Object.keys(state.operations ?? {}).length === 0;
}

function legacyTimestamp(value) {
  const text = String(value ?? '').trim();
  if (validTimestamp(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00+08:00`))) {
    return `${text}T00:00:00+08:00`;
  }
  throw new Error(`invalid legacy workbench timestamp: ${value}`);
}

function legacySection(lines, pattern) {
  const start = lines.findIndex((line) => pattern.test(line.trim()));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^###\s+/.test(line.trim()));
  return { start, end: end < 0 ? lines.length : end };
}

function tableInSection(lines, section) {
  if (!section) return null;
  const headerLine = lines.findIndex((line, index) => index > section.start && index < section.end && line.trim().startsWith('|'));
  if (headerLine < 0 || headerLine + 1 >= section.end) return null;
  const header = markdownCells(lines[headerLine]);
  const separator = markdownCells(lines[headerLine + 1]);
  if (!header || !separator || header.length !== separator.length) return null;
  const rows = [];
  for (let index = headerLine + 2; index < section.end; index += 1) {
    if (!lines[index].trim().startsWith('|')) break;
    const cells = markdownCells(lines[index]);
    if (!cells || cells.length !== header.length) throw new Error(`invalid legacy workbench row: ${index + 1}`);
    rows.push(cells);
  }
  return { header, rows };
}

function legacyWorkbenchMigration(current) {
  const lines = String(current ?? '').replace(/\r\n/g, '\n').split('\n');
  const snapshotSection = legacySection(lines, /^###\s+1\.1\s+项目快照\s*$/);
  const taskSection = legacySection(lines, /^###\s+1\.2\s+正式任务表\s*$/);
  if (!taskSection) return null;
  const taskTable = tableInSection(lines, taskSection);
  if (!taskTable) throw new Error('legacy workbench task table is invalid');
  const taskIndexes = {
    task: taskTable.header.findIndex((cell) => cell.includes('任务')),
    worker: taskTable.header.findIndex((cell) => cell.includes('负责人')),
    status: taskTable.header.findIndex((cell) => cell === '状态'),
    progress: taskTable.header.findIndex((cell) => cell.includes('当前进度')),
    pause: taskTable.header.findIndex((cell) => cell.includes('暂停原因')),
    result: taskTable.header.findIndex((cell) => cell.includes('正式结果')),
    updated: taskTable.header.findIndex((cell) => cell.includes('更新时间')),
  };
  if (Object.values(taskIndexes).some((index) => index < 0)) {
    throw new Error('legacy workbench task table is missing required columns');
  }

  const state = initialState();
  let completedCount = 0;
  for (const cells of taskTable.rows) {
    const task = cells[taskIndexes.task];
    const worker = cells[taskIndexes.worker];
    const status = cells[taskIndexes.status];
    if (task === '当前无活动正式任务' && worker === '无'
      || task.startsWith('<') || worker.startsWith('<')) continue;
    if (!['进行中', '已暂停', '已完成'].includes(status)) {
      throw new Error(`invalid legacy workbench task state: ${status}`);
    }
    if (status === '已完成') {
      completedCount += 1;
      continue;
    }
    if (!validId(worker)) throw new Error(`invalid legacy Worker id: ${worker}`);
    const taskId = `legacy-${worker}`;
    if (!validId(taskId) || state.tasks[taskId]) throw new Error(`duplicate legacy Worker id: ${worker}`);
    if (Object.values(state.tasks).some((record) => record.task === task)) {
      throw new Error(`duplicate legacy business result: ${task}`);
    }
    state.tasks[taskId] = {
      taskId,
      task,
      worker,
      status,
      progress: cells[taskIndexes.progress] || '从3.1工作台迁入，待当前现场重证',
      pause: cells[taskIndexes.pause] || '无',
      result: cells[taskIndexes.result] || '无',
      updatedAt: legacyTimestamp(cells[taskIndexes.updated]),
    };
  }

  const snapshotTable = tableInSection(lines, snapshotSection);
  if (snapshotTable?.rows.length && !snapshotTable.rows[0].some((cell) => cell.startsWith('<'))) {
    const indexes = {
      updatedAt: snapshotTable.header.findIndex((cell) => cell.includes('更新时间')),
      mainline: snapshotTable.header.findIndex((cell) => cell.includes('当前主线')),
      status: snapshotTable.header.findIndex((cell) => cell.includes('项目状态')),
      problem: snapshotTable.header.findIndex((cell) => cell.includes('当前主要问题')),
      evidence: snapshotTable.header.findIndex((cell) => cell.includes('最近一手依据')),
      next: snapshotTable.header.findIndex((cell) => cell.includes('当前下一步')),
      decision: snapshotTable.header.findIndex((cell) => cell.includes('需要用户决定')),
    };
    if (Object.values(indexes).some((index) => index < 0)) {
      throw new Error('legacy workbench project snapshot is missing required columns');
    }
    const row = snapshotTable.rows[0];
    if (!['进行中', '已暂停', '已完成'].includes(row[indexes.status])) {
      throw new Error(`invalid legacy project state: ${row[indexes.status]}`);
    }
    state.projectSnapshot = {
      mainline: row[indexes.mainline],
      status: row[indexes.status],
      problem: row[indexes.problem],
      evidence: row[indexes.evidence],
      next: row[indexes.next],
      decision: row[indexes.decision] || '无',
      updatedAt: legacyTimestamp(row[indexes.updatedAt]),
    };
  }

  const sections = [snapshotSection, taskSection].filter(Boolean).sort((left, right) => right.start - left.start);
  const cleaned = [...lines];
  for (const section of sections) cleaned.splice(section.start, section.end - section.start);
  state.revision = 1;
  return {
    state,
    cleanedView: `${cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`,
    activeCount: Object.keys(state.tasks).length,
    completedCount,
    snapshotImported: state.projectSnapshot !== null,
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function writeDurable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  writeDurable(temporary, text);
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(temporary, file); break; }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code) || attempt >= 49) throw error;
      sleep(10);
    }
  }
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return clone(fallback);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return clone(fallback);
    throw error;
  }
}

function monthOf(value) {
  const text = String(value ?? '');
  const month = text.slice(0, 7);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new Error(`invalid completion month: ${value}`);
  }
  return month;
}

function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && !Number.isNaN(Date.parse(value));
}

export class WorkbenchTransactionStore {
  constructor({ runtimeRoot, viewPath, historyRoot, recentLimit = 20, readOnly = false }) {
    if (!runtimeRoot || !viewPath || !historyRoot
      || !Number.isInteger(recentLimit) || recentLimit < 1 || recentLimit > 100) {
      throw new Error('invalid workbench store configuration');
    }
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.viewPath = path.resolve(viewPath);
    this.historyRoot = path.resolve(historyRoot);
    this.recentLimit = recentLimit;
    this.readOnly = readOnly;
    this.stateFile = path.join(this.runtimeRoot, 'workbench-state.json');
    this.transactionRoot = path.join(this.runtimeRoot, 'transactions');
    this.backupRoot = path.join(this.runtimeRoot, 'backups');
    this.lockDirectory = path.join(this.runtimeRoot, '.workbench.lock');
    this.startupMigration = { performed: false, activeCount: 0, completedCount: 0, snapshotImported: false };
    if (readOnly) {
      if (!fs.existsSync(this.stateFile) || !fs.existsSync(this.viewPath)) {
        throw new Error('read-only workbench state is missing');
      }
      return;
    }
    fs.mkdirSync(this.transactionRoot, { recursive: true });
    fs.mkdirSync(this.backupRoot, { recursive: true });
    fs.mkdirSync(this.historyRoot, { recursive: true });
    fs.mkdirSync(path.dirname(this.viewPath), { recursive: true });
    this.#withLock(() => {
      if (!fs.existsSync(this.viewPath)) fs.writeFileSync(this.viewPath, '# 当前工作台\n', 'utf8');
      const current = fs.readFileSync(this.viewPath, 'utf8');
      const state = readJson(this.stateFile, initialState());
      const migration = legacyWorkbenchMigration(current);
      if (migration) {
        if (!pristineState(state)) throw new Error('legacy workbench exists beside non-empty machine state');
        const sourceBackup = path.join(this.backupRoot, 'pre-3.2-markdown-workbench.md');
        if (!fs.existsSync(sourceBackup)) writeDurable(sourceBackup, current);
        writeAtomic(path.join(this.backupRoot, 'pre-3.2-markdown-workbench-migration.json'), {
          schemaVersion: 1,
          activeCount: migration.activeCount,
          completedCount: migration.completedCount,
          snapshotImported: migration.snapshotImported,
          migratedAt: new Date().toISOString(),
        });
        writeAtomic(this.stateFile, migration.state);
        writeAtomic(this.viewPath, migration.cleanedView);
        this.startupMigration = {
          performed: true,
          activeCount: migration.activeCount,
          completedCount: migration.completedCount,
          snapshotImported: migration.snapshotImported,
        };
      } else if (!fs.existsSync(this.stateFile)) {
        writeAtomic(this.stateFile, state);
      }
      this.#ensureView(this.#readState());
    });
  }

  startupStatus() {
    return { ...clone(this.startupMigration), ...this.recoveryStatus() };
  }

  registerTask(input) {
    this.#assertWritable();
    return this.#withLock(() => {
      if (!validId(input.taskId) || !validId(input.worker) || !String(input.task ?? '').trim()
        || !ACTIVE_STATES.has(input.status) || !String(input.progress ?? '').trim()
        || !String(input.pause ?? '').trim() || !validTimestamp(input.updatedAt)) {
        throw new Error('invalid task registration');
      }
      const state = this.#readState();
      const record = clone(input);
      const existing = state.tasks[input.taskId];
      if (existing) {
        if (digest(existing) !== digest(record)) throw new Error('task already registered with different content');
        return clone(existing);
      }
      if (Object.values(state.tasks).some((task) => task.worker === input.worker)) {
        throw new Error('worker already owns another active task');
      }
      if (Object.values(state.tasks).some((task) => task.task === input.task)) {
        throw new Error('business result already has another active task');
      }
      state.tasks[input.taskId] = record;
      state.revision += 1;
      this.#commitState(state);
      this.#ensureView(state);
      return clone(record);
    });
  }

  updateTask(input) {
    this.#assertWritable();
    return this.#withLock(() => {
      if (!validId(input.operationId) || !validId(input.taskId) || !ACTIVE_STATES.has(input.status)) {
        throw new Error('invalid task update');
      }
      if (!String(input.progress ?? '').trim() || !String(input.pause ?? '').trim()
        || !validTimestamp(input.updatedAt)) {
        throw new Error('invalid task update content');
      }
      const state = this.#readState();
      const inputDigest = digest(input);
      const prior = state.operations[input.operationId];
      if (prior) {
        if (prior.inputDigest !== inputDigest) throw new Error('operation id reused with different input');
        return clone(prior.output);
      }
      const task = state.tasks[input.taskId];
      if (!task) throw new Error('active task is missing');
      if (task.status !== input.expectedStatus) throw new Error(`unexpected task state: ${task.status}`);
      const updated = {
        ...task,
        status: input.status,
        progress: input.progress,
        pause: input.pause,
        result: input.result ?? task.result,
        updatedAt: input.updatedAt,
      };
      state.tasks[input.taskId] = updated;
      state.revision += 1;
      const output = { operationId: input.operationId, taskId: input.taskId, status: input.status, stateRevision: state.revision };
      this.#rememberOperation(state, input.operationId, inputDigest, output);
      this.#commitState(state);
      this.#ensureView(state);
      return clone(output);
    });
  }

  updateProjectSnapshot(input) {
    this.#assertWritable();
    return this.#withLock(() => {
      if (!validId(input.operationId) || !['进行中', '已暂停', '已完成'].includes(input.status)
        || !String(input.mainline ?? '').trim() || !String(input.problem ?? '').trim()
        || !String(input.evidence ?? '').trim() || !String(input.next ?? '').trim()
        || !validTimestamp(input.updatedAt)) {
        throw new Error('invalid project snapshot');
      }
      const state = this.#readState();
      const inputDigest = digest(input);
      const prior = state.operations[input.operationId];
      if (prior) {
        if (prior.inputDigest !== inputDigest) throw new Error('operation id reused with different input');
        return clone(prior.output);
      }
      state.projectSnapshot = {
        mainline: input.mainline,
        status: input.status,
        problem: input.problem,
        evidence: input.evidence,
        next: input.next,
        decision: input.decision ?? '无',
        updatedAt: input.updatedAt,
      };
      state.revision += 1;
      const output = { operationId: input.operationId, stateRevision: state.revision };
      this.#rememberOperation(state, input.operationId, inputDigest, output);
      this.#commitState(state);
      this.#ensureView(state);
      return clone(output);
    });
  }

  consumeAcceptedResult(input, { faultAt = null } = {}) {
    this.#assertWritable();
    return this.#withLock(() => this.#consumeLocked(input, faultAt, 'accepted'));
  }

  closeTask(input, { faultAt = null } = {}) {
    this.#assertWritable();
    return this.#withLock(() => this.#consumeLocked(input, faultAt, 'closed'));
  }

  #consumeLocked(input, faultAt, kind) {
    if (!validId(input.operationId)) throw new Error('invalid operation id');
    if (!validId(input.taskId) || !validId(input.worker)) {
      throw new Error('invalid task or worker id');
    }
    const inputDigest = digest(input);
    const transactionFile = path.join(this.transactionRoot, `${input.operationId}.json`);
    let transaction = readJson(transactionFile, null);
    if (transaction) {
      if (transaction.inputDigest !== inputDigest) throw new Error('operation id reused with different input');
      if ((transaction.kind ?? 'accepted') !== kind) throw new Error('operation id reused for another terminal action');
      if (transaction.phase === 'completed') return clone(transaction.output);
    }

    let state = this.#readState();
    if (!transaction) {
      this.#validateTerminalInput(state, input, kind);
      const backupFile = path.join(this.backupRoot, `${input.operationId}.json`);
      if (!fs.existsSync(backupFile)) {
        writeAtomic(backupFile, { operationId: input.operationId, stateFingerprint: digest(state), state });
      }
      transaction = {
        schemaVersion: 1,
        operationId: input.operationId,
        inputDigest,
        input: clone(input),
        kind,
        phase: 'intent',
        output: null,
        historyRecord: null,
        startedAt: new Date().toISOString(),
      };
      writeAtomic(transactionFile, transaction);
      if (faultAt === 'afterIntent') throw new InjectedFault(faultAt);
    }

    state = this.#readState();
    if (transaction.phase === 'intent') {
      const alreadyCommitted = state.operations[input.operationId];
      if (alreadyCommitted) {
        if (alreadyCommitted.inputDigest !== inputDigest) throw new Error('committed operation digest conflict');
        transaction.output = clone(alreadyCommitted.output);
        transaction.historyRecord = clone(alreadyCommitted.historyRecord);
      } else {
        const task = state.tasks[input.taskId];
        if (!task || task.worker !== input.worker || task.status !== input.expectedStatus) {
          throw new Error('task changed after transaction intent');
        }
        state.revision += 1;
        const terminalStatus = kind === 'closed' ? '已关闭' : '已完成';
        const terminalAt = kind === 'closed' ? input.closedAt : input.completedAt;
        const historyRecord = kind === 'closed' ? {
          operationId: input.operationId,
          taskId: input.taskId,
          task: task.task,
          worker: input.worker,
          status: terminalStatus,
          result: input.taskLocator,
          evidence: input.authorizationLocator,
          conclusion: input.closureReason,
          completedAt: terminalAt,
          affectsMainline: false,
          pendingDependencies: [],
        } : {
          operationId: input.operationId,
          taskId: input.taskId,
          task: task.task,
          worker: input.worker,
          status: terminalStatus,
          result: input.finalLocator,
          evidence: input.evidenceLocator,
          conclusion: input.conclusion,
          completedAt: terminalAt,
          affectsMainline: input.affectsMainline === true,
          pendingDependencies: [...new Set(input.pendingDependencies ?? [])],
        };
        delete state.tasks[input.taskId];
        if (kind === 'accepted' && input.affectsMainline === true) {
          state.recentMainlineResults.push({
            taskId: input.taskId,
            task: task.task,
            worker: input.worker,
            result: input.finalLocator,
            completedAt: input.completedAt,
          });
          state.recentMainlineResults = state.recentMainlineResults.slice(-this.recentLimit);
        }
        const output = {
          operationId: input.operationId,
          taskId: input.taskId,
          worker: input.worker,
          status: terminalStatus,
          stateRevision: state.revision,
          archived: true,
        };
        this.#rememberOperation(state, input.operationId, inputDigest, output, historyRecord);
        this.#commitState(state);
        transaction.output = output;
        transaction.historyRecord = historyRecord;
      }
      transaction.phase = 'stateCommitted';
      writeAtomic(transactionFile, transaction);
      if (faultAt === 'afterStateCommit') throw new InjectedFault(faultAt);
    }

    if (transaction.phase === 'stateCommitted') {
      this.#appendHistory(transaction.historyRecord);
      transaction.phase = 'historyWritten';
      writeAtomic(transactionFile, transaction);
      if (faultAt === 'afterHistoryWrite') throw new InjectedFault(faultAt);
    }

    if (transaction.phase === 'historyWritten') {
      this.#ensureView(this.#readState());
      transaction.phase = 'viewWritten';
      writeAtomic(transactionFile, transaction);
      if (faultAt === 'afterViewWrite') throw new InjectedFault(faultAt);
    }

    if (transaction.phase === 'viewWritten') {
      transaction = {
        schemaVersion: 1,
        operationId: input.operationId,
        inputDigest,
        kind,
        phase: 'completed',
        output: transaction.output,
        completedAt: kind === 'closed' ? input.closedAt : input.completedAt,
      };
      writeAtomic(transactionFile, transaction);
      this.#trimBackups();
    }
    return clone(transaction.output);
  }

  #validateTerminalInput(state, input, kind) {
    const task = state.tasks[input.taskId];
    if (!task || task.worker !== input.worker) throw new Error('unique active task is missing');
    if (task.status !== input.expectedStatus || !ACTIVE_STATES.has(task.status)) {
      throw new Error(`unexpected task state: ${task.status}`);
    }
    if (kind === 'closed') {
      if (input.businessState !== '已关闭'
        || input.ownerDirective !== 'explicit-owner-instruction'
        || input.workerStopped !== true
        || !validId(input.closedBy)
        || !validTimestamp(input.closedAt)) {
        throw new Error('explicit owner-authorized task closure is required');
      }
      if (!String(input.closureReason ?? '').trim()
        || !String(input.taskLocator ?? '').trim()
        || !String(input.authorizationLocator ?? '').trim()) {
        throw new Error('closure reason or traceable locator is missing');
      }
      monthOf(input.closedAt);
      return;
    }
    if (input.acceptance !== 'accepted' || !validId(input.acceptedBy)
      || !validTimestamp(input.acceptedAt) || !validTimestamp(input.completedAt)) {
      throw new Error('PM acceptance is required');
    }
    if (!String(input.finalLocator ?? '').trim() || !String(input.evidenceLocator ?? '').trim()
      || !String(input.conclusion ?? '').trim()) {
      throw new Error('result conclusion or locator is missing');
    }
    monthOf(input.completedAt);
    if (input.businessState !== '已完成') throw new Error('only a completed Worker final can close the task');
  }

  recover() {
    this.#assertWritable();
    const recoveredOperations = [];
    for (const entry of fs.readdirSync(this.transactionRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.transactionRoot, entry.name);
      const transaction = readJson(file, null);
      if (!transaction || transaction.phase === 'completed' || !transaction.input) continue;
      if ((transaction.kind ?? 'accepted') === 'closed') this.closeTask(transaction.input);
      else this.consumeAcceptedResult(transaction.input);
      recoveredOperations.push(transaction.operationId);
    }
    this.#withLock(() => {
      for (const entry of fs.readdirSync(this.runtimeRoot)) {
        if (entry.endsWith('.tmp')) fs.rmSync(path.join(this.runtimeRoot, entry), { force: true });
      }
      this.#ensureView(this.#readState());
    });
    return { recoveredOperations, ...this.recoveryStatus() };
  }

  snapshot() {
    return clone(this.#readState());
  }

  view() {
    return fs.readFileSync(this.viewPath, 'utf8');
  }

  history(month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`invalid history month: ${month}`);
    return clone(readJson(path.join(this.historyRoot, `${month}.json`), { schemaVersion: 1, month, records: [] }));
  }

  recoveryStatus() {
    const state = this.#readState();
    const current = fs.readFileSync(this.viewPath, 'utf8');
    const transactionFiles = fs.existsSync(this.transactionRoot)
      ? fs.readdirSync(this.transactionRoot)
      : [];
    return {
      stateRevision: state.revision,
      viewMatchesState: current === this.#composeView(current, state),
      pendingTransactions: transactionFiles
        .filter((name) => name.endsWith('.json'))
        .filter((name) => readJson(path.join(this.transactionRoot, name), {}).phase !== 'completed'),
    };
  }

  injectDeadLockForTest(pid) {
    this.#assertWritable();
    fs.rmSync(this.lockDirectory, { recursive: true, force: true });
    fs.mkdirSync(this.lockDirectory, { recursive: true });
    writeAtomic(path.join(this.lockDirectory, 'owner.json'), {
      pid, nonce: 'injected', acquiredAt: new Date().toISOString(), injectedForTest: true,
    });
  }

  #appendHistory(record) {
    const month = monthOf(record.completedAt);
    const jsonFile = path.join(this.historyRoot, `${month}.json`);
    const history = readJson(jsonFile, { schemaVersion: 1, month, records: [] });
    const prior = history.records.find((item) => item.operationId === record.operationId);
    if (prior) {
      if (digest(prior) !== digest(record)) throw new Error('history operation conflict');
    } else {
      history.records.push(clone(record));
      history.records.sort((left, right) => left.completedAt.localeCompare(right.completedAt));
      writeAtomic(jsonFile, history);
    }
    const rows = history.records.map((item) => (
      `| ${markdown(item.taskId)} | ${markdown(item.task)} | ${markdown(item.worker)} | ${markdown(item.status ?? '已完成')} | ${markdown(item.result)} | ${markdown(item.conclusion)} | ${markdown(item.completedAt)} |`
    ));
    writeAtomic(path.join(this.historyRoot, `${month}.md`), [
      `# ${month} 工作台历史`, '',
      '| 任务编号 | 业务结果 | Worker | 状态 | 正式结果 / 任务入口 | 结论 / 关闭原因 | 终态时间 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...rows, '',
    ].join('\n'));
  }

  #renderManaged(state) {
    const snapshot = state.projectSnapshot;
    const snapshotRow = snapshot
      ? `| ${markdown(snapshot.updatedAt)} | ${markdown(snapshot.mainline)} | ${markdown(snapshot.status)} | ${markdown(snapshot.problem)} | ${markdown(snapshot.evidence)} | ${markdown(snapshot.next)} | ${markdown(snapshot.decision)} |`
      : '| 无 | 待确认 | 进行中 | 无 | 无 | 待确认 | 无 |';
    const tasks = Object.values(state.tasks).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const taskRows = tasks.length ? tasks.map((task) => (
      `| ${markdown(task.task)} | ${markdown(task.worker)} | ${markdown(task.status)} | ${markdown(task.progress)} | ${markdown(task.pause ?? '无')} | ${markdown(task.result ?? '无')} | ${markdown(task.updatedAt)} |`
    )) : ['| 当前无活动正式任务 | 无 | 已完成 | 无 | 无 | 无 | 无 |'];
    const recentRows = state.recentMainlineResults.length ? state.recentMainlineResults.map((item) => (
      `| ${markdown(item.task)} | ${markdown(item.worker)} | ${markdown(item.result)} | ${markdown(item.completedAt)} |`
    )) : ['| 当前无近期主线结果 | 无 | 无 | 无 |'];
    return [
      MANAGED_BEGIN,
      `> 机器状态修订：${state.revision}。本区由固定事务维护，自由正文位于标记外。`, '',
      '## 当前判断', '',
      '| 更新时间 | 当前主线 / 业务目标 | 项目状态 | 当前主要问题 | 最近一手依据 | 当前下一步 | 需要用户决定 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      snapshotRow, '',
      '## 正式任务', '',
      '| 任务 / 业务结果 | 负责人 / 正式 thread | 状态 | 当前进度 | 暂停原因与恢复条件 | 正式结果 / 证据入口 | 更新时间 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...taskRows, '',
      '## 近期主线结果', '',
      '| 任务 | Worker | 正式结果 | 完成时间 |',
      '| --- | --- | --- | --- |',
      ...recentRows,
      MANAGED_END,
    ].join('\n');
  }

  #composeView(current, state) {
    const managed = this.#renderManaged(state);
    const start = current.indexOf(MANAGED_BEGIN);
    const end = current.indexOf(MANAGED_END);
    const beginCount = current.split(MANAGED_BEGIN).length - 1;
    const endCount = current.split(MANAGED_END).length - 1;
    if ((start >= 0) !== (end >= 0) || end >= 0 && end < start
      || beginCount > 1 || endCount > 1) {
      throw new Error('managed workbench marker mismatch');
    }
    if (start >= 0 && end >= start) {
      return `${current.slice(0, start)}${managed}${current.slice(end + MANAGED_END.length)}`;
    }
    const firstLineEnd = current.indexOf('\n');
    if (firstLineEnd >= 0 && /^#\s+/.test(current.slice(0, firstLineEnd).trim())) {
      const heading = current.slice(0, firstLineEnd).trimEnd();
      const remainder = current.slice(firstLineEnd + 1).replace(/^\s+/, '').trimEnd();
      return remainder ? `${heading}\n\n${managed}\n\n${remainder}\n` : `${heading}\n\n${managed}\n`;
    }
    return `${current.trimEnd()}\n\n${managed}\n`;
  }

  #ensureView(state) {
    const current = fs.readFileSync(this.viewPath, 'utf8');
    const expected = this.#composeView(current, state);
    if (expected !== current) writeAtomic(this.viewPath, expected);
  }

  #readState() {
    return readJson(this.stateFile, initialState());
  }

  #commitState(state) {
    writeAtomic(this.stateFile, state);
  }

  #rememberOperation(state, operationId, inputDigest, output, historyRecord = null) {
    state.operations[operationId] = { inputDigest, output: clone(output), historyRecord: clone(historyRecord) };
    state.operationOrder = state.operationOrder.filter((item) => item !== operationId);
    state.operationOrder.push(operationId);
    while (state.operationOrder.length > 100) {
      const removed = state.operationOrder.shift();
      delete state.operations[removed];
    }
  }

  #trimBackups() {
    const files = fs.readdirSync(this.backupRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ name: entry.name, time: fs.statSync(path.join(this.backupRoot, entry.name)).mtimeMs }))
      .sort((left, right) => right.time - left.time);
    for (const file of files.slice(20)) fs.rmSync(path.join(this.backupRoot, file.name), { force: true });
  }

  #assertWritable() {
    if (this.readOnly) throw new Error('read-only workbench does not accept mutations');
  }

  #withLock(action) {
    const startedAt = Date.now();
    const ownerFile = path.join(this.lockDirectory, 'owner.json');
    const nonce = crypto.randomUUID();
    while (true) {
      try {
        fs.mkdirSync(this.lockDirectory);
        writeAtomic(ownerFile, { pid: process.pid, nonce, acquiredAt: new Date().toISOString() });
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const owner = readJson(ownerFile, {});
        const ownerKnown = Number.isInteger(owner.pid) && owner.pid > 0;
        let ownerMissingTooLong = false;
        if (!ownerKnown) {
          try { ownerMissingTooLong = Date.now() - fs.statSync(this.lockDirectory).mtimeMs > 1_000; } catch {}
        }
        const acquired = Date.parse(owner.acquiredAt ?? '');
        const stale = Number.isFinite(acquired) && Date.now() - acquired > 30_000;
        if ((ownerKnown && !pidAlive(owner.pid)) || ownerMissingTooLong || stale) {
          fs.rmSync(this.lockDirectory, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - startedAt > 5_000) throw new Error('workbench lock timeout');
        sleep(20);
      }
    }
    try { return action(); }
    finally {
      const owner = readJson(ownerFile, {});
      if (owner.nonce === nonce) fs.rmSync(this.lockDirectory, { recursive: true, force: true });
    }
  }
}
