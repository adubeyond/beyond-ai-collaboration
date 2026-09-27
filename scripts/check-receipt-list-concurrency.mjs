import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const moduleUrl = process.env.BEYOND_TEST_RECEIPT_MODULE
  ? pathToFileURL(path.resolve(process.env.BEYOND_TEST_RECEIPT_MODULE)).href
  : new URL('../模板交付包/scripts/runtime/worker-result-receipts.mjs', import.meta.url).href;
const { WorkerResultReceiptStore } = await import(moduleUrl);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-receipt-list-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkerResultReceiptStore({ runtimeRoot: root });
  const input = { projectId: 'project-a', taskId: 'task-a', workerThreadId: 'worker-a',
    sourceThreadId: 'pm-a', businessState: '已完成', finalText: '已完成：待确认结果' };
  const record = store.enqueue(input).record;
  return { root, store, input, record };
}

function snapshot(root) {
  const result = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (entry.isDirectory()) {
        result.push([relative, 'directory']);
        visit(file);
      } else {
        result.push([relative, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
      }
    }
  }
  visit(root);
  return result;
}

function acknowledgeInChild(f) {
  const code = `import { WorkerResultReceiptStore } from ${JSON.stringify(moduleUrl)};
const store = new WorkerResultReceiptStore({ runtimeRoot: ${JSON.stringify(f.root)} });
console.log(JSON.stringify(store.acknowledge(${JSON.stringify({ projectId: f.input.projectId,
    taskId: f.input.taskId, receiptId: f.record.receiptId })})));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(JSON.parse(child.stdout).removed, true);
}

for (const readOnly of [false, true]) {
  test(`list skips a receipt acknowledged in another process after enumeration (readOnly=${readOnly})`, t => {
    const f = fixture(t);
    const survivor = f.store.enqueue({ ...f.input, taskId: 'task-b', finalText: '已完成：仍需处理的结果' }).record;
    const reader = new WorkerResultReceiptStore({ runtimeRoot: f.root, readOnly });
    const readdir = fs.readdirSync;
    let pendingScans = 0;
    let acknowledgements = 0;
    let afterAck;
    fs.readdirSync = (directory, options) => {
      const entries = readdir(directory, options);
      // Writable list first enumerates migration input; hold only the actual
      // list enumeration, after it has captured a filename and before reading.
      if (path.resolve(directory) === reader.pendingRoot && options?.withFileTypes
        && ++pendingScans === (readOnly ? 1 : 2)) {
        assert.ok(entries.some(entry => entry.name === path.basename(reader.receiptPath(f.input.projectId, f.input.taskId))));
        acknowledgeInChild(f);
        acknowledgements += 1;
        afterAck = snapshot(f.root);
      }
      return entries;
    };
    let actual;
    try { actual = reader.list({ projectId: f.input.projectId }); }
    finally { fs.readdirSync = readdir; }
    assert.equal(acknowledgements, 1, 'the independent ack must run inside the enumeration/read gap');
    assert.deepEqual(actual, { count: 1, records: [survivor] });
    assert.deepEqual(snapshot(f.root), afterAck, 'list must not write after the independent acknowledgement');
  });
}

test('list still rejects malformed JSON instead of hiding damaged evidence', t => {
  const f = fixture(t);
  const file = f.store.receiptPath(f.input.projectId, f.input.taskId);
  fs.writeFileSync(file, '{broken-json');
  for (const readOnly of [false, true]) {
    const reader = new WorkerResultReceiptStore({ runtimeRoot: f.root, readOnly });
    const before = snapshot(f.root);
    assert.throws(() => reader.list({ projectId: f.input.projectId }), /cannot read Worker result receipt/);
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('list still rejects an invalid receipt fingerprint', t => {
  const f = fixture(t);
  fs.writeFileSync(f.store.receiptPath(f.input.projectId, f.input.taskId), JSON.stringify({ ...f.record, finalSha256: 'invalid' }));
  for (const readOnly of [false, true]) {
    const reader = new WorkerResultReceiptStore({ runtimeRoot: f.root, readOnly });
    const before = snapshot(f.root);
    assert.throws(() => reader.list({ projectId: f.input.projectId }), /final fingerprint mismatch/);
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('list does not swallow persistent permission failures', t => {
  const f = fixture(t);
  const reader = new WorkerResultReceiptStore({ runtimeRoot: f.root, readOnly: true });
  const before = snapshot(f.root);
  reader.readPath = () => { throw Object.assign(new Error('test permission denied'), { code: 'EACCES' }); };
  assert.throws(() => reader.list({ projectId: f.input.projectId }), error => error.code === 'EACCES');
  assert.deepEqual(snapshot(f.root), before);
});

test('read-only list preserves and deduplicates identical legacy and namespaced receipts without writes', t => {
  const f = fixture(t);
  fs.copyFileSync(f.store.receiptPath(f.input.projectId, f.input.taskId), f.store.legacyReceiptPath(f.input.taskId));
  const reader = new WorkerResultReceiptStore({ runtimeRoot: f.root, readOnly: true });
  const before = snapshot(f.root);
  assert.deepEqual(reader.list({ projectId: f.input.projectId }), { count: 1, records: [f.record] });
  assert.deepEqual(snapshot(f.root), before);
});
