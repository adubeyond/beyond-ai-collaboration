import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BUSINESS_STATES = new Set(['已完成', '已暂停']);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const normalized = value.replace(/\r\n/g, '\n').trimEnd();
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

function identifier(value, label) {
  const normalized = text(value, label, 160);
  if (!/^[\p{L}\p{N}._:/-]+$/u.test(normalized)) throw new Error(`${label} contains unsupported characters`);
  return normalized;
}

function optionalIdentifier(value, label) {
  return value === undefined || value === null ? null : identifier(value, label);
}

function timestamp(value) {
  if (value === undefined) return new Date().toISOString();
  const normalized = text(value, 'createdAt', 40);
  if (Number.isNaN(Date.parse(normalized))) throw new Error('createdAt must be an ISO timestamp');
  return new Date(normalized).toISOString();
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical(record) {
  return JSON.stringify({
    projectId: record.projectId,
    taskId: record.taskId,
    workerThreadId: record.workerThreadId ?? null,
    sourceThreadId: record.sourceThreadId,
    businessState: record.businessState,
    finalText: record.finalText,
  });
}

function validateInput(raw) {
  const input = object(raw, 'Worker result receipt');
  const businessState = text(input.businessState, 'businessState', 10);
  if (!BUSINESS_STATES.has(businessState)) throw new Error('businessState must be 已完成 or 已暂停');
  const finalText = text(input.finalText, 'finalText', 32768);
  if (!finalText.startsWith(businessState)) throw new Error('finalText must start with businessState');
  const record = {
    schemaVersion: 1,
    projectId: identifier(input.projectId, 'projectId'),
    taskId: identifier(input.taskId, 'taskId'),
    workerThreadId: optionalIdentifier(input.workerThreadId, 'workerThreadId'),
    sourceThreadId: identifier(input.sourceThreadId, 'sourceThreadId'),
    businessState,
    finalText,
    finalSha256: digest(finalText),
    createdAt: timestamp(input.createdAt),
  };
  record.receiptId = `worker-result-${digest(canonical(record)).slice(0, 32)}`;
  return record;
}

function validateRecord(raw) {
  const stored = object(raw, 'stored Worker result receipt');
  if (stored.schemaVersion !== 1) throw new Error('unsupported Worker result receipt schema');
  const record = validateInput(stored);
  if (stored.receiptId !== record.receiptId) throw new Error('Worker result receipt id mismatch');
  if (stored.finalSha256 !== record.finalSha256) throw new Error('Worker result receipt final fingerprint mismatch');
  record.createdAt = timestamp(stored.createdAt);
  return record;
}

function waitForFileUnlock(milliseconds = 5) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function retryTransientFileOperation(operation, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    try { return operation(); }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error?.code) || index === attempts - 1) throw error;
      waitForFileUnlock();
    }
  }
  return undefined;
}

export class WorkerResultReceiptStore {
  constructor({ runtimeRoot }) {
    this.runtimeRoot = path.resolve(text(runtimeRoot, 'runtimeRoot', 4096));
    this.pendingRoot = path.join(this.runtimeRoot, 'pending');
  }

  receiptPath(projectId, taskId) {
    const namespace = `${identifier(projectId, 'projectId')}\0${identifier(taskId, 'taskId')}`;
    return path.join(this.pendingRoot, `${digest(namespace)}.json`);
  }

  legacyReceiptPath(taskId) {
    return path.join(this.pendingRoot, `${digest(identifier(taskId, 'taskId'))}.json`);
  }

  migratePendingLayout() {
    if (!fs.existsSync(this.pendingRoot)) return;
    const files = fs.readdirSync(this.pendingRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(this.pendingRoot, entry.name));
    for (const file of files) {
      const record = this.readPathIfPresent(file);
      if (!record) continue;
      const target = this.receiptPath(record.projectId, record.taskId);
      if (path.resolve(file) === path.resolve(target)) continue;
      try {
        fs.linkSync(file, target);
      } catch (error) {
        if (['EXDEV', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
          try {
            retryTransientFileOperation(() => fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL));
          } catch (copyError) {
            if (!['EEXIST', 'ENOENT'].includes(copyError?.code)) throw copyError;
          }
        } else if (!['EEXIST', 'ENOENT'].includes(error?.code)) throw error;
      }
      const namespaced = this.readPathIfPresent(target);
      if (!namespaced) {
        throw new Error(`namespaced Worker result receipt disappeared during migration for ${record.projectId}/${record.taskId}`);
      }
      if (namespaced.receiptId !== record.receiptId) {
        throw new Error(`conflicting legacy and namespaced Worker result receipts for ${record.projectId}/${record.taskId}`);
      }
      try { retryTransientFileOperation(() => fs.unlinkSync(file)); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }

  readPathIfPresent(file) {
    try { return retryTransientFileOperation(() => this.readPath(file)); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  readPath(file) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      const wrapped = new Error(`cannot read Worker result receipt ${path.basename(file)}: ${error.message}`);
      if (error?.code) wrapped.code = error.code;
      throw wrapped;
    }
    try {
      return validateRecord(parsed);
    } catch (error) {
      throw new Error(`invalid Worker result receipt ${path.basename(file)}: ${error.message}`);
    }
  }

  enqueue(raw) {
    const record = validateInput(raw);
    fs.mkdirSync(this.pendingRoot, { recursive: true });
    this.migratePendingLayout();
    const target = this.receiptPath(record.projectId, record.taskId);
    const existing = fs.existsSync(target) ? this.readPath(target) : null;
    if (existing?.receiptId === record.receiptId) return { mode: 'existing', record: existing };
    const temporary = `${target}.tmp`;
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return {
      mode: existing ? 'replaced' : 'created',
      supersededReceiptId: existing?.receiptId ?? null,
      record,
    };
  }

  list(raw = {}) {
    const input = object(raw, 'Worker result receipt filter');
    const filters = { projectId: identifier(input.projectId, 'projectId') };
    for (const key of ['projectId', 'taskId', 'workerThreadId', 'sourceThreadId']) {
      if (key !== 'projectId' && input[key] !== undefined) filters[key] = identifier(input[key], key);
    }
    if (!fs.existsSync(this.pendingRoot)) return { count: 0, records: [] };
    this.migratePendingLayout();
    const records = fs.readdirSync(this.pendingRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => this.readPath(path.join(this.pendingRoot, entry.name)))
      .filter((record) => Object.entries(filters).every(([key, value]) => record[key] === value))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.receiptId.localeCompare(right.receiptId));
    return { count: records.length, records };
  }

  acknowledge(raw) {
    const input = object(raw, 'Worker result receipt acknowledgement');
    const projectId = identifier(input.projectId, 'projectId');
    const taskId = identifier(input.taskId, 'taskId');
    const receiptId = identifier(input.receiptId, 'receiptId');
    const workerThreadId = optionalIdentifier(input.workerThreadId, 'workerThreadId');
    this.migratePendingLayout();
    const target = this.receiptPath(projectId, taskId);
    if (!fs.existsSync(target)) throw new Error('pending Worker result receipt not found');
    const record = this.readPath(target);
    if (record.projectId !== projectId) throw new Error('Worker result receipt project mismatch');
    if (record.receiptId !== receiptId) throw new Error('stale acknowledgement cannot remove a newer Worker result receipt');
    if (workerThreadId && record.workerThreadId && record.workerThreadId !== workerThreadId) {
      throw new Error('Worker result receipt owner mismatch');
    }
    fs.unlinkSync(target);
    return { acknowledged: receiptId, projectId, taskId, workerThreadId: record.workerThreadId, removed: true };
  }
}
