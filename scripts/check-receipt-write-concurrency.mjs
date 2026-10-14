import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const moduleUrl = process.env.BEYOND_TEST_RECEIPT_MODULE
  ? pathToFileURL(path.resolve(process.env.BEYOND_TEST_RECEIPT_MODULE)).href
  : new URL('../模板交付包/scripts/runtime/worker-result-receipts.mjs', import.meta.url).href;
const { WorkerResultReceiptStore } = await import(moduleUrl);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 5_000) {
  const start = Date.now();
  while (!check()) {
    assert.ok(Date.now() - start < timeout, `timed out: ${label}`);
    await delay(10);
  }
}

const childCode = `
import fs from 'node:fs';
import {WorkerResultReceiptStore} from ${JSON.stringify(moduleUrl)};
const c=JSON.parse(process.argv[1]), store=new WorkerResultReceiptStore({runtimeRoot:c.root});
if(c.hold){
  const read=store.readPath.bind(store); let count=0;
  store.readPath=file=>{
    const result=read(file);
    if(file===store.receiptPath(c.input.projectId,c.input.taskId)&&++count===2){
      fs.writeFileSync(c.ready,'ready');
      const started=Date.now();
      while(!fs.existsSync(c.release)){
        if(Date.now()-started>10000)throw Error('test barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
      }
    }
    return result;
  };
}
fs.writeFileSync(c.started,'started');
try {const result=store[c.method](c.input); console.log(JSON.stringify({ok:true,result}));}
catch(error){console.log(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-receipt-concurrency-'));
  const store = new WorkerResultReceiptStore({ runtimeRoot: root });
  const input = { projectId: 'project-a', taskId: 'task-a', workerThreadId: 'worker-a', sourceThreadId: 'pm-a',
    businessState: '已完成', finalText: '已完成：原结果' };
  const old = store.enqueue(input).record;
  const children = [];
  function run(name, method, request, hold = false) {
    const config = { root, method, input: request, hold, started: path.join(root, name + '.started'),
      ready: path.join(root, name + '.ready'), release: path.join(root, name + '.release') };
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', childCode, JSON.stringify(config)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { process, config, finished: false, stdout: '', stderr: '' };
    record.done = new Promise((resolve, reject) => {
      process.on('error', reject);
      process.stdout.on('data', b => record.stdout += b);
      process.stderr.on('data', b => record.stderr += b);
      process.on('close', status => { record.finished = true; resolve({ status, stdout: record.stdout, stderr: record.stderr }); });
    });
    children.push(record);
    return record;
  }
  t.after(async () => {
    for (const child of children) {
      if (!child.finished) child.process.kill();
      await child.done.catch(() => {});
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const release = child => fs.writeFileSync(child.config.release, 'release');
  const entered = child => until(() => fs.existsSync(child.config.ready), 'child inside read/write critical section');
  async function blocked(child) {
    await until(() => fs.existsSync(child.config.started), 'contender started');
    // A candidate directory proves the second process reached lock acquisition.
    // Against the old implementation it instead finishes, which is a failure.
    await until(() => child.finished || fs.existsSync(path.join(root, 'locks'))
      && fs.readdirSync(path.join(root, 'locks')).some(name => name.includes('.candidate-')),
    'contender reached lock acquisition');
    assert.equal(child.finished, false, 'same-task mutation must wait, not overlap');
  }
  const ack = { projectId: input.projectId, taskId: input.taskId, receiptId: old.receiptId };
  return { root, store, input, old, ack, run, release, entered, blocked, trackChild: child => children.push(child) };
}

function assertReceiptWriteClean(f) {
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), []);
  assert.equal(fs.readdirSync(f.store.pendingRoot).some(name => name.endsWith('.tmp')), false);
}

function interceptReceiptRename(f, input, intercept) {
  const target = f.store.receiptPath(input.projectId, input.taskId);
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = function(source, destination, ...args) {
    if (path.resolve(String(source)) === `${target}.tmp` && path.resolve(String(destination)) === target) {
      attempts += 1;
      intercept({ attempts, source, destination });
    }
    return rename.call(this, source, destination, ...args);
  };
  return { attempts: () => attempts, restore: () => { fs.renameSync = rename; } };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`receipt replacement retries transient ${code} without exposing partial or missing evidence`, t => {
    const f = fixture(t), target = f.store.receiptPath(f.input.projectId, f.input.taskId);
    const before = fs.readFileSync(target);
    const input = { ...f.input, finalText: `已完成：${code}占用后替换` };
    const intercepted = interceptReceiptRename(f, input, ({ attempts }) => {
      if (attempts > 3) return;
      assert.deepEqual(fs.readFileSync(target), before, 'old receipt must stay byte-identical before successful replacement');
      throw Object.assign(new Error('injected transient receipt rename denial'), { code });
    });
    let result;
    try {
      result = f.store.enqueue(input);
      assert.equal(intercepted.attempts(), 4);
    } finally { intercepted.restore(); }
    assert.equal(result.mode, 'replaced');
    assert.equal(result.supersededReceiptId, f.old.receiptId);
    assert.notEqual(result.record.receiptId, f.old.receiptId);
    assert.deepEqual(f.store.list({ projectId: f.input.projectId }).records, [result.record]);
    assertReceiptWriteClean(f);
  });

  test(`receipt replacement bounds persistent ${code}, preserves old bytes and permits a later caller retry`, t => {
    const f = fixture(t), target = f.store.receiptPath(f.input.projectId, f.input.taskId);
    const before = fs.readFileSync(target);
    const input = { ...f.input, finalText: `已完成：${code}持续占用` };
    const denied = Object.assign(new Error('injected persistent receipt rename denial'), { code });
    const intercepted = interceptReceiptRename(f, input, () => {
      assert.deepEqual(fs.readFileSync(target), before);
      throw denied;
    });
    try {
      assert.throws(() => f.store.enqueue(input), error => error === denied, 'must propagate failure, not return a successful receipt');
      assert.equal(intercepted.attempts(), 200, 'only the receipt replacement gets this finite retry budget');
    } finally { intercepted.restore(); }
    assert.deepEqual(fs.readFileSync(target), before);
    assertReceiptWriteClean(f);
    const recovered = f.store.enqueue(input);
    assert.equal(recovered.mode, 'replaced');
    assert.equal(recovered.supersededReceiptId, f.old.receiptId);
    assert.equal(f.store.list({ projectId: f.input.projectId }).records[0].finalText, input.finalText);
    assertReceiptWriteClean(f);
  });
}

for (const code of ['ENOSPC', 'EIO', 'ENOENT']) {
  test(`receipt replacement does not retry non-transient ${code}`, t => {
    const f = fixture(t), target = f.store.receiptPath(f.input.projectId, f.input.taskId);
    const before = fs.readFileSync(target), input = { ...f.input, finalText: '已完成：不应伪造成功' };
    const failure = Object.assign(new Error('injected non-transient rename failure'), { code });
    const intercepted = interceptReceiptRename(f, input, () => { throw failure; });
    try {
      assert.throws(() => f.store.enqueue(input), error => error === failure);
      assert.equal(intercepted.attempts(), 1);
    } finally { intercepted.restore(); }
    assert.deepEqual(fs.readFileSync(target), before);
    assertReceiptWriteClean(f);
  });
}

test('receipt creation retries a transient rename and duplicate enqueue remains existing without another rename', t => {
  const f = fixture(t), input = { ...f.input, taskId: 'first-create', createdAt: '2026-10-14T00:00:00.000Z' };
  const target = f.store.receiptPath(input.projectId, input.taskId);
  const intercepted = interceptReceiptRename(f, input, ({ attempts }) => {
    if (attempts === 1) {
      assert.equal(fs.existsSync(target), false);
      throw Object.assign(new Error('injected first-create denial'), { code: 'EPERM' });
    }
  });
  try {
    const created = f.store.enqueue(input);
    assert.equal(created.mode, 'created');
    assert.equal(created.supersededReceiptId, null);
    assert.equal(intercepted.attempts(), 2);
    const before = fs.readFileSync(target);
    const duplicate = f.store.enqueue({ ...input, createdAt: '2026-10-15T00:00:00.000Z' });
    assert.equal(duplicate.mode, 'existing');
    assert.deepEqual(duplicate.record, created.record);
    assert.deepEqual(fs.readFileSync(target), before);
    assert.equal(intercepted.attempts(), 2, 'idempotent enqueue must not enter the replacement retry');
  } finally { intercepted.restore(); }
  assertReceiptWriteClean(f);
});

test('Windows file handle releases after a real rename denial and the same enqueue then succeeds',
  { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
    const f = fixture(t), target = f.store.receiptPath(f.input.projectId, f.input.taskId);
    const before = fs.readFileSync(target);
    const ready = path.join(f.root, 'handle.ready'), release = path.join(f.root, 'handle.release');
    const released = path.join(f.root, 'handle.released');
    const literal = value => `'${value.replaceAll("'", "''")}'`;
    // ReadWrite deliberately omits FileShare.Delete. The child releases only
    // after the parent observes an actual OS rename failure, not after a guessed delay.
    const script = `$ErrorActionPreference='Stop'; $handle=$null; try {
      $handle=[System.IO.File]::Open(${literal(target)},[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite);
      [System.IO.File]::WriteAllText(${literal(ready)},'ready');
      $clock=[System.Diagnostics.Stopwatch]::StartNew();
      while(-not [System.IO.File]::Exists(${literal(release)})) {
        if($clock.ElapsedMilliseconds -gt 15000){throw 'test release signal timed out'};
        [System.Threading.Thread]::Sleep(2)
      }
    } finally { if($null -ne $handle){$handle.Dispose(); [System.IO.File]::WriteAllText(${literal(released)},'released')} }`;
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
    const shell = windowsRoot
      ? path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const holder = { process: child, finished: false, stdout: '', stderr: '' };
    holder.done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.stdout.on('data', b => holder.stdout += b);
      child.stderr.on('data', b => holder.stderr += b);
      child.on('close', status => { holder.finished = true; resolve({ status, stdout: holder.stdout, stderr: holder.stderr }); });
    });
    f.trackChild(holder);
    await until(() => fs.existsSync(ready) || holder.finished, 'Windows handle opened', 10_000);
    assert.equal(fs.existsSync(ready), true, holder.stderr);
    const rename = fs.renameSync, errors = [];
    let attempts = 0, result, failure;
    fs.renameSync = function(source, destination, ...args) {
      if (path.resolve(String(source)) !== `${target}.tmp` || path.resolve(String(destination)) !== target) {
        return rename.call(this, source, destination, ...args);
      }
      attempts += 1;
      try { return rename.call(this, source, destination, ...args); }
      catch (error) {
        errors.push(error.code);
        assert.deepEqual(fs.readFileSync(target), before);
        if (errors.length === 1) fs.writeFileSync(release, 'release-after-real-denial');
        throw error;
      }
    };
    try { result = f.store.enqueue({ ...f.input, finalText: '已完成：真实Windows占用解除' }); }
    catch (error) { failure = error; }
    finally { fs.renameSync = rename; }
    const held = await holder.done;
    assert.equal(held.status, 0, held.stdout + held.stderr);
    assert.equal(fs.existsSync(released), true);
    assert.ok(errors.length > 0, 'a real operating-system denial must be observed');
    assert.ok(errors.every(code => ['EPERM', 'EACCES', 'EBUSY'].includes(code)), JSON.stringify(errors));
    t.diagnostic(`real Windows rename attempts=${attempts}; failures=${errors.join(',')}; handle released after first failure`);
    assert.ifError(failure);
    assert.ok(attempts > 1);
    assert.equal(result.mode, 'replaced');
    assert.equal(result.supersededReceiptId, f.old.receiptId);
    assert.equal(f.store.list({ projectId: f.input.projectId }).records[0].receiptId, result.record.receiptId);
    assertReceiptWriteClean(f);
  });

test('new enqueue waits while old ack has read its receipt; new result survives', async t => {
  const f = fixture(t);
  const ack = f.run('ack', 'acknowledge', f.ack, true);
  await f.entered(ack);
  const writer = f.run('writer', 'enqueue', { ...f.input, finalText: '已完成：必须保留的新结果' });
  await f.blocked(writer);
  f.release(ack);
  assert.equal((await ack.done).status, 0);
  const result = await writer.done;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const latest = f.store.list({ projectId: f.input.projectId }).records;
  assert.equal(latest.length, 1);
  assert.notEqual(latest[0].receiptId, f.old.receiptId);
  assert.match(latest[0].finalText, /必须保留的新结果/);
});

test('old ack waits for an in-flight replacement, then rejects without deleting it', async t => {
  const f = fixture(t);
  const writer = f.run('writer', 'enqueue', { ...f.input, finalText: '已完成：替换结果' }, true);
  await f.entered(writer);
  const ack = f.run('ack', 'acknowledge', f.ack);
  await f.blocked(ack);
  f.release(writer);
  assert.equal((await writer.done).status, 0);
  const rejected = await ack.done;
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /stale acknowledgement/);
  assert.equal(f.store.list({ projectId: f.input.projectId }).records[0].finalText, '已完成：替换结果');
});

for (const [name, change] of [['another task', { taskId: 'task-b' }], ['another project', { projectId: 'project-b' }]]) {
  test(`${name} can write while the original receipt is locked`, async t => {
    const f = fixture(t), ack = f.run('ack', 'acknowledge', f.ack, true);
    await f.entered(ack);
    const writer = f.run('independent', 'enqueue', { ...f.input, ...change });
    await until(() => writer.finished, 'independent namespace completion');
    assert.equal((await writer.done).status, 0);
    assert.equal(ack.finished, false);
    f.release(ack);
    assert.equal((await ack.done).status, 0);
  });
}

test('dead process lock is recovered without losing pending evidence', async t => {
  const f = fixture(t), ack = f.run('crashed', 'acknowledge', f.ack, true);
  await f.entered(ack);
  ack.process.kill();
  await ack.done;
  const writer = f.run('recovery', 'enqueue', { ...f.input, finalText: '已完成：崩溃后新结果' });
  const result = await writer.done;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.store.list({ projectId: f.input.projectId }).records[0].finalText, '已完成：崩溃后新结果');
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), []);
});

test('concurrent dead-lock recovery never removes a replacement live owner', async t => {
  const f = fixture(t), crashed = f.run('crashed', 'acknowledge', f.ack, true);
  await f.entered(crashed);
  crashed.process.kill();
  await crashed.done;
  const writers = Array.from({ length: 8 }, (_, i) => f.run('recovery-' + i, 'enqueue', { ...f.input, finalText: '已完成：并发恢复' + i }));
  for (const result of await Promise.all(writers.map(w => w.done))) assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.store.list({ projectId: f.input.projectId }).count, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), []);
});

test('transient Windows directory denial during recovery is retried without losing pending', async t => {
  const f = fixture(t), crashed = f.run('crashed', 'acknowledge', f.ack, true);
  await f.entered(crashed);
  crashed.process.kill();
  await crashed.done;
  const lock = path.join(f.root, 'locks', path.basename(f.store.receiptPath(f.input.projectId, f.input.taskId), '.json') + '.lock');
  const read = fs.readdirSync;
  let injected = 0;
  fs.readdirSync = function(directory, ...args) {
    if (path.resolve(String(directory)) === lock && injected++ === 0) {
      throw Object.assign(new Error('injected transient directory denial'), { code: 'EPERM' });
    }
    return read.call(this, directory, ...args);
  };
  try {
    const result = f.store.enqueue({ ...f.input, finalText: '已完成：短暂占用后恢复' });
    assert.equal(result.mode, 'replaced');
    assert.ok(injected >= 2, 'retry must reach the same lock directory again');
    assert.equal(f.store.list({ projectId: f.input.projectId }).records[0].finalText, '已完成：短暂占用后恢复');
  } finally { fs.readdirSync = read; }
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), []);
});

test('persistent directory denial fails closed without deleting old receipt or lock owner', async t => {
  const f = fixture(t), crashed = f.run('crashed', 'acknowledge', f.ack, true);
  await f.entered(crashed);
  crashed.process.kill();
  await crashed.done;
  const lock = path.join(f.root, 'locks', path.basename(f.store.receiptPath(f.input.projectId, f.input.taskId), '.json') + '.lock');
  const owners = fs.readdirSync(lock);
  const read = fs.readdirSync;
  let attempts = 0;
  fs.readdirSync = function(directory, ...args) {
    if (path.resolve(String(directory)) === lock) {
      attempts += 1;
      throw Object.assign(new Error('injected persistent directory denial'), { code: 'EACCES' });
    }
    return read.call(this, directory, ...args);
  };
  try {
    assert.throws(() => f.store.enqueue({ ...f.input, finalText: '已完成：不可写入' }), error => error.code === 'EACCES');
    assert.equal(attempts, 20, 'the existing retry bound must remain finite');
  } finally { fs.readdirSync = read; }
  assert.deepEqual(fs.readdirSync(lock), owners);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), [path.basename(lock)]);
  assert.equal(f.store.list({ projectId: f.input.projectId }).records[0].receiptId, f.old.receiptId);
});

for (const persistent of [false, true]) {
  test(`${persistent ? 'persistent' : 'transient'} Windows owner-file denial uses the bounded retry without losing pending`, async t => {
    const f = fixture(t), crashed = f.run('crashed', 'acknowledge', f.ack, true);
    await f.entered(crashed); crashed.process.kill(); await crashed.done;
    const lock = path.join(f.root, 'locks', path.basename(f.store.receiptPath(f.input.projectId, f.input.taskId), '.json') + '.lock');
    const owners = fs.readdirSync(lock), ownerFile = path.join(lock, owners[0]);
    const read = fs.readFileSync; let attempts = 0;
    fs.readFileSync = function(file, ...args) {
      if (path.resolve(String(file)) === ownerFile) {
        attempts += 1;
        if (persistent || attempts === 1) throw Object.assign(new Error('injected owner-file denial'), { code: persistent ? 'EACCES' : 'EPERM' });
      }
      return read.call(this, file, ...args);
    };
    try {
      if (persistent) {
        assert.throws(() => f.store.enqueue({ ...f.input, finalText: '已完成：不可写入' }), error => error.code === 'EACCES');
        assert.equal(attempts, 20);
      } else {
        assert.equal(f.store.enqueue({ ...f.input, finalText: '已完成：owner读取恢复' }).mode, 'replaced');
        assert.ok(attempts >= 2);
      }
    } finally { fs.readFileSync = read; }
    if (persistent) {
      assert.deepEqual(fs.readdirSync(lock), owners);
      assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), [path.basename(lock)]);
      assert.equal(f.store.list({ projectId: f.input.projectId }).records[0].receiptId, f.old.receiptId);
    } else {
      assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), []);
      assert.equal(f.store.list({ projectId: f.input.projectId }).records[0].finalText, '已完成：owner读取恢复');
    }
  });
}

test('live lock times out without theft; failure releases only the contender directory', async t => {
  const f = fixture(t), ack = f.run('owner', 'acknowledge', f.ack, true);
  await f.entered(ack);
  const lockRoot = path.join(f.root, 'locks');
  const lock = path.join(lockRoot, fs.readdirSync(lockRoot).find(name => name.endsWith('.lock')));
  fs.utimesSync(lock, new Date('2000-01-01'), new Date('2000-01-01'));
  const writer = f.run('timeout', 'enqueue', { ...f.input, finalText: '已完成：不应越锁' });
  const result = await writer.done;
  assert.equal(result.status, 1);
  assert.match(result.stdout, /receipt lock timeout/);
  assert.deepEqual(fs.readdirSync(lockRoot), [path.basename(lock)]);
  assert.equal(f.store.list({ projectId: f.input.projectId }).records[0].receiptId, f.old.receiptId);
  f.release(ack);
  assert.equal((await ack.done).status, 0);
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

test('stale acknowledgement and thrown write error release the lock for retry', t => {
  const f = fixture(t);
  assert.throws(() => f.store.acknowledge({ ...f.ack, receiptId: 'stale' }), /stale acknowledgement/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), []);
  const read = f.store.readPath.bind(f.store);
  let count = 0;
  f.store.readPath = file => { if (++count === 2) throw new Error('injected write-path error'); return read(file); };
  assert.throws(() => f.store.enqueue({ ...f.input, finalText: '已完成：新结果' }), /injected write-path error/);
  f.store.readPath = read;
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), []);
  assert.equal(f.store.enqueue({ ...f.input, finalText: '已完成：恢复后结果' }).mode, 'replaced');
});

test('several same-task writers complete without shared temporary-file collisions', async t => {
  const f = fixture(t);
  const writers = Array.from({ length: 8 }, (_, i) => f.run('writer-' + i, 'enqueue', { ...f.input, finalText: '已完成：结果' + i }));
  for (const result of await Promise.all(writers.map(w => w.done))) assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.store.list({ projectId: f.input.projectId }).count, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), []);
  assert.equal(fs.readdirSync(f.store.pendingRoot).some(name => name.endsWith('.tmp')), false);
});
