import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliTaskStore } from './cli-task-store.mjs';

const identity = { projectId: 'lock-project', taskId: 'lock-task', ownerThreadId: 'lock-owner' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-lock-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = path.join(root, 'control'); fs.mkdirSync(control);
  const store = new CliTaskStore({ controlRoot: control });
  const dir = store.checkedPath(store.taskDir(identity), { createDirectory: true });
  return { root, control, store, dir, lock: path.join(dir, '.lock') };
}
function owner(lock, text = 'existing-owner') {
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), text);
}
function release(lock) { fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); }

test('lock released after leaf lstat can be acquired without realpath on the volatile leaf', t => {
  const f = fixture(t); owner(f.lock);
  const lstat = fs.lstatSync, realpath = fs.realpathSync;
  let released = 0, leafRealpaths = 0, actions = 0;
  t.mock.method(fs, 'lstatSync', function (file, options) {
    const stat = lstat.call(fs, file, options);
    if (path.resolve(file) === f.lock && !released) { release(f.lock); released++; }
    return stat;
  });
  t.mock.method(fs, 'realpathSync', function (file, options) {
    if (path.resolve(file) === f.lock) leafRealpaths++;
    return realpath.call(fs, file, options);
  });
  assert.equal(f.store.withLock(identity, () => { actions++; return 'done'; }), 'done');
  assert.equal(released, 1); assert.equal(actions, 1); assert.equal(leafRealpaths, 0);
  assert.equal(fs.existsSync(f.lock), false); assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('active owner is not replaced and only our prepared directory is removed', t => {
  const f = fixture(t); owner(f.lock); let actions = 0;
  assert.throws(() => f.store.withLock(identity, () => actions++), /CLI lock conflict/);
  assert.equal(actions, 0); assert.equal(fs.readFileSync(path.join(f.lock, 'owner.json'), 'utf8'), 'existing-owner');
  assert.deepEqual(fs.readdirSync(f.dir), ['.lock']);
});

test('another owner winning immediately before atomic rename remains untouched', t => {
  const f = fixture(t), rename = fs.renameSync; let actions = 0, injected = 0;
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (path.resolve(to) === f.lock && !injected) { injected++; owner(f.lock, 'winning-owner'); }
    return rename.call(fs, from, to);
  });
  assert.throws(() => f.store.withLock(identity, () => actions++), /CLI lock conflict/);
  assert.equal(injected, 1); assert.equal(actions, 0);
  assert.equal(fs.readFileSync(path.join(f.lock, 'owner.json'), 'utf8'), 'winning-owner');
  assert.deepEqual(fs.readdirSync(f.dir), ['.lock']);
});

for (const dangling of [false, true]) test(`lock junction rejected (dangling=${dangling})`, t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.lock, 'junction'); if (dangling) fs.rmdirSync(outside);
  let actions = 0;
  assert.throws(() => f.store.withLock(identity, () => actions++), /CLI linked path escape/);
  assert.equal(actions, 0); assert.equal(fs.lstatSync(f.lock).isSymbolicLink(), true);
  if (!dangling) assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(f.lock);
});

test('linked ancestor and lexical escape are still rejected', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const linked = path.join(f.store.root, 'linked-project'); fs.symlinkSync(outside, linked, 'junction');
  let actions = 0;
  assert.throws(() => f.store.withLock({ ...identity, projectId: 'linked-project' }, () => actions++), /link|escape/);
  assert.throws(() => f.store.withLock({ ...identity, taskId: '../escape' }, () => actions++), /identifier/);
  assert.equal(actions, 0); assert.deepEqual(fs.readdirSync(outside), []); fs.unlinkSync(linked);
});

for (const code of ['EACCES', 'EPERM', 'ENOTDIR']) test(`leaf lstat ${code} propagates without writes`, t => {
  const f = fixture(t), lstat = fs.lstatSync; const failure = Object.assign(new Error('injected'), { code }); let actions = 0;
  t.mock.method(fs, 'lstatSync', function (file, options) {
    if (path.resolve(file) === f.lock) throw failure;
    return lstat.call(fs, file, options);
  });
  assert.throws(() => f.store.withLock(identity, () => actions++), error => error === failure);
  assert.equal(actions, 0); assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('normal acquisition creates missing parents; action failure releases only its own lock', t => {
  const f = fixture(t), other = { ...identity, taskId: 'fresh-task' };
  assert.equal(f.store.withLock(other, () => 42), 42);
  const expected = new Error('action failed');
  assert.throws(() => f.store.withLock(identity, () => { throw expected; }), error => error === expected);
  assert.equal(fs.existsSync(f.lock), false); assert.deepEqual(fs.readdirSync(f.dir), []);
  assert.equal(f.store.withLock(identity, () => 'next'), 'next');
});
