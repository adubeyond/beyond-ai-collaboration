import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createTemporaryWorkspace } from './lib/temporary-workspace.mjs';
import { runProductValidation } from './run-product-validation.mjs';

function fixture() {
  const workspace = createTemporaryWorkspace('beyond-validation-cleanup-test-');
  const root = path.join(workspace.root, 'repo'), temporary = path.join(workspace.root, 'tmp');
  fs.mkdirSync(root); fs.mkdirSync(temporary);
  const previous = Object.fromEntries(['TMP', 'TEMP', 'TMPDIR'].map(k => [k, process.env[k]]));
  for (const k of Object.keys(previous)) process.env[k] = temporary;
  const write = (name, value) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value); };
  write('.gitignore', '/outputs/\n');
  write('模板交付包/beyond-release.json', '{"releaseVersion":"0.0.0"}\n');
  write('unique.txt', 'unique original source\n');
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['init', '--quiet']); git(['add', '.']);
  git(['-c', 'user.name=Isolated Test', '-c', 'user.email=isolated@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  return { root, write, cleanup() {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    workspace.cleanup();
  } };
}
const tempRoots = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('beyond-full-validation-')).sort();
const sourceCopy = file => JSON.parse(gunzipSync(fs.readFileSync(file)));
const filesIn = root => fs.readdirSync(root, { recursive: true }).filter(n => fs.lstatSync(path.join(root, n)).isFile()).sort();
const bytesIn = root => filesIn(root).reduce((n, file) => n + fs.statSync(path.join(root, file)).size, 0);
function command(fail = false) {
  return [{ name: 'fixture-command', args: ['-e', "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const p=fs.mkdtempSync(path.join(os.tmpdir(),'intentionally-leaked-child-'));fs.writeFileSync(path.join(p,'large.bin'),Buffer.alloc(1024*1024));console.log('fixture evidence');process.exit(" + (fail ? '1' : '0') + ');'] }];
}

test('five passes and five failures reclaim all child temp; evidence count stays bounded', () => {
  const f = fixture(), before = tempRoots();
  try {
    let first, report;
    for (let i = 0; i < 5; i++) {
      report = runProductValidation({ sourceRoot: f.root, commands: command() });
      assert.equal(report.passed, true); assert.equal(report.scratchRemoved, true);
      assert.deepEqual(tempRoots(), before);
      assert.equal(filesIn(report.evidenceRoot).length, 3);
      const size = bytesIn(report.evidenceRoot); first ??= size;
      assert.ok(Math.abs(size - first) < 512, 'same-input evidence must not accumulate');
    }
    for (let i = 0; i < 5; i++) {
      report = runProductValidation({ sourceRoot: f.root, commands: command(true) });
      assert.equal(report.passed, false); assert.equal(report.results[0].exitCode, 1);
      assert.deepEqual(tempRoots(), before);
      assert.equal(filesIn(report.evidenceRoot).length, 4);
    }
    const failure = JSON.parse(gunzipSync(fs.readFileSync(path.join(report.evidenceRoot, 'last-failure.json.gz'))));
    assert.match(failure.logs['fixture-command'], /fixture evidence/);
    assert.equal(fs.readFileSync(path.join(f.root, 'unique.txt'), 'utf8'), 'unique original source\n');
    console.log(JSON.stringify({ repeatSuccess: 5, repeatFailure: 5, retainedFiles: 4, evidenceBytes: bytesIn(report.evidenceRoot), leakedTemporaryRoots: 0 }));
  } finally { f.cleanup(); }
});

test('distinct dirty source is preserved byte-for-byte; damaged recovery is never overwritten', () => {
  const f = fixture(), before = tempRoots();
  try {
    const a = runProductValidation({ sourceRoot: f.root, commands: command() });
    f.write('unique.txt', 'unique revised source\n');
    const b = runProductValidation({ sourceRoot: f.root, commands: command() });
    assert.notEqual(a.snapshotFile, b.snapshotFile);
    for (const [report, expected] of [[a, 'unique original source\n'], [b, 'unique revised source\n']]) {
      const archive = sourceCopy(report.snapshotFile);
      const record = archive.files.find(r => r.path === 'unique.txt');
      const bytes = Buffer.from(record.contentBase64, 'base64');
      assert.equal(bytes.toString(), expected);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
    }
    const corrupt = gzipSync(Buffer.from('do not overwrite this recovery material'));
    fs.writeFileSync(b.snapshotFile, corrupt);
    assert.throws(() => runProductValidation({ sourceRoot: f.root, commands: command() }), /refusing to overwrite/);
    assert.deepEqual(fs.readFileSync(b.snapshotFile), corrupt);
    assert.deepEqual(tempRoots(), before);
  } finally { f.cleanup(); }
});

test('capture error and timeout leave no work trees; timeout is a failed result', () => {
  const f = fixture(), before = tempRoots();
  try {
    fs.unlinkSync(path.join(f.root, 'unique.txt'));
    assert.throws(() => runProductValidation({ sourceRoot: f.root, commands: command() }), /ENOENT/);
    assert.deepEqual(tempRoots(), before);
    f.write('unique.txt', 'unique original source\n');
    const report = runProductValidation({ sourceRoot: f.root, commands: [{ name: 'timeout', args: ['-e', 'setInterval(()=>{},1000)'] }], timeout: 100 });
    assert.equal(report.passed, false); assert.match(report.results[0].error, /ETIMEDOUT/);
    assert.deepEqual(tempRoots(), before);
  } finally { f.cleanup(); }
});

test('a source mutation during checks cannot be reported as a pass', () => {
  const f = fixture(), before = tempRoots();
  try {
    const changedFile = path.join(f.root, 'unique.txt');
    const report = runProductValidation({ sourceRoot: f.root, commands: [{ name: 'change-isolated-source', args: ['-e', 'require("node:fs").writeFileSync(' + JSON.stringify(changedFile) + ',"changed during test")'] }] });
    assert.equal(report.results[0].exitCode, 0);
    assert.equal(report.passed, false); assert.equal(report.sourceChangedDuringValidation, true);
    assert.equal(Buffer.from(sourceCopy(report.snapshotFile).files.find(f => f.path === 'unique.txt').contentBase64, 'base64').toString(), 'unique original source\n');
    assert.deepEqual(tempRoots(), before);
  } finally { f.cleanup(); }
});

test('evidence destination failure retains diagnostics instead of deleting the only copy', t => {
  const f = fixture();
  const realRename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(to) === 'latest.json.gz') throw Object.assign(new Error('evidence destination denied'), { code: 'EACCES' });
    return realRename(from, to);
  });
  try {
    assert.throws(() => runProductValidation({ sourceRoot: f.root, commands: command() }), /workspace kept at/);
    const leftovers = tempRoots(); assert.equal(leftovers.length, 1);
    const saved = sourceCopy(path.join(os.tmpdir(), leftovers[0], 'validation-evidence.json.gz'));
    assert.match(saved.logs['fixture-command'], /fixture evidence/);
    assert.equal(saved.report.passed, false);
    assert.equal(fs.readFileSync(path.join(f.root, 'unique.txt'), 'utf8'), 'unique original source\n');
  } finally { mocked.mock.restore(); f.cleanup(); }
});

test('cleanup denial is recorded as failure without losing logs or claiming removal', t => {
  const f = fixture(), realRemove = fs.rmSync;
  const mocked = t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.basename(target).startsWith('beyond-full-validation-')) throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    return realRemove(target, options);
  });
  try {
    assert.throws(() => runProductValidation({ sourceRoot: f.root, commands: command() }), /cleanup denied/);
    const output = path.join(f.root, 'outputs/product-validation');
    const record = sourceCopy(path.join(output, fs.readdirSync(output)[0], 'last-failure.json.gz'));
    assert.equal(record.report.passed, false); assert.equal(record.report.scratchRemoved, false);
    assert.equal(record.report.cleanupStatus, 'failed'); assert.match(record.logs['fixture-command'], /fixture evidence/);
    assert.equal(fs.existsSync(record.report.remainingScratch), true);
  } finally { mocked.mock.restore(); f.cleanup(); }
});

test('a busy publication keeps its prior evidence and is not forcefully unlocked', () => {
  const f = fixture();
  try {
    const report = runProductValidation({ sourceRoot: f.root, commands: command() });
    const original = fs.readFileSync(report.evidenceFile);
    fs.mkdirSync(report.evidenceFile + '.lock');
    assert.throws(() => runProductValidation({ sourceRoot: f.root, commands: command() }), /workspace kept at/);
    assert.deepEqual(fs.readFileSync(report.evidenceFile), original);
    assert.equal(fs.existsSync(report.evidenceFile + '.lock'), true);
    assert.equal(tempRoots().length, 1);
  } finally { f.cleanup(); }
});

test('concurrent same-source runs always publish self-contained matching reports and logs', async () => {
  const f = fixture(), before = tempRoots();
  const moduleUrl = new URL('./run-product-validation.mjs', import.meta.url).href;
  const run = marker => new Promise((resolve, reject) => {
    const command = { name: marker, args: ['-e', 'console.log(' + JSON.stringify(marker) + ')'] };
    const script = 'import {runProductValidation} from ' + JSON.stringify(moduleUrl) + '; runProductValidation(' + JSON.stringify({ sourceRoot: f.root, commands: [command] }) + ');';
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let error = ''; child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(error || 'child failed: ' + code)));
  });
  try {
    const children = await Promise.allSettled([run('run-A'), run('run-B')]);
    for (const child of children) if (child.status === 'rejected') throw child.reason;
    const output = path.join(f.root, 'outputs/product-validation');
    const evidence = path.join(output, fs.readdirSync(output)[0]);
    for (const file of ['latest.json.gz', 'last-success.json.gz']) {
      const record = sourceCopy(path.join(evidence, file));
      const marker = record.report.results[0].name;
      assert.equal(record.logs[marker].trim(), marker);
      assert.equal(Object.keys(record.logs).length, 1);
      assert.equal(record.report.passed, true);
    }
    assert.equal(filesIn(evidence).length, 3); assert.deepEqual(tempRoots(), before);
  } finally { f.cleanup(); }
});
