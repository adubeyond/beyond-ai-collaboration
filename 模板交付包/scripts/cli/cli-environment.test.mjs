import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { cliEnvironment } from './native-cli-runner.mjs';

const windows = process.platform === 'win32';
const pathKey = () => Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path';
const readPath = env => Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1];
function setEnv(t, key, value) {
  const before = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-environment-'));
  t.after(() => {
    const actual = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('beyond-cli-environment-'));
    fs.rmSync(actual, { recursive: true });
  });
  return root;
}
function emptyNode(commandPath, value) {
  const env = { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT, Path: value };
  const args = commandPath === process.execPath ? ['-e', "process.stdout.write('empty-node-ok')"]
    : ['/d', '/s', '/c', 'node -e "process.stdout.write(\'empty-node-ok\')"'];
  const result = spawnSync(commandPath, args, { env, cwd: os.tmpdir(), encoding: 'utf8',
    windowsHide: true, windowsVerbatimArguments: commandPath !== process.execPath, timeout: 10000 });
  return { status: result.status, output: result.stdout, error: result.error?.code };
}

test('CLI environment preserves the parent and defaults only the SDK automatic PATH write', t => {
  const name = 'DOTNET_ADD_GLOBAL_TOOLS_TO_PATH';
  const actual = Object.keys(process.env).find(key => (windows ? key.toUpperCase() : key) === name) ?? name;
  setEnv(t, actual, undefined);
  setEnv(t, 'NODE_TEST_CONTEXT', 'fixture-test-context');
  const before = JSON.stringify(process.env);
  const env = cliEnvironment('fixture-codex-home');
  assert.equal(env[name], 'false');
  assert.equal(env.CODEX_HOME, 'fixture-codex-home');
  assert.equal(env.NODE_TEST_CONTEXT, undefined);
  assert.ok(JSON.stringify(process.env) === before, 'parent environment must stay unchanged');
  for (const value of ['true', '0', 'false', '']) {
    process.env[actual] = value;
    const explicit = cliEnvironment('fixture-codex-home');
    assert.equal(explicit[actual], value);
  }
});

test('Windows cleanup removes only missing BEYOND temp dotnet tools and preserves order', { skip: !windows }, t => {
  const root = fixture(t), tools = name => path.join(root, name, 'dotnet-home', '.dotnet', 'tools');
  const existing = tools('existing'), missing = tools('missing'), denied = tools('denied'), uncertain = tools('uncertain');
  const nestedMissing = tools(path.join('public-query', 'oracle', 'run-fixture'));
  const notDirectory = tools('not-directory');
  fs.mkdirSync(existing, { recursive: true });
  const otherMissing = path.join(root, 'unrelated', 'bin');
  const outsideTemp = path.join(path.dirname(os.tmpdir()), 'beyond-outside-temp', 'dotnet-home', '.dotnet', 'tools');
  const relative = 'beyond-relative\\dotnet-home\\.dotnet\\tools';
  const variable = '%TEMP%\\beyond-variable\\dotnet-home\\.dotnet\\tools';
  const unc = '\\\\uncontacted-server\\share\\beyond-test\\dotnet-home\\.dotnet\\tools';
  const traversal = root + '\\existing\\..\\missing\\dotnet-home\\.dotnet\\tools';
  const entries = [existing, missing, nestedMissing, notDirectory, otherMissing, relative, variable, unc, outsideTemp, denied, uncertain,
    traversal, '"' + missing + '"', '', existing];
  const originalStat = fs.statSync, inspected = [];
  t.mock.method(fs, 'statSync', (value, ...args) => {
    inspected.push(value);
    if (value === denied || value === uncertain) throw Object.assign(new Error('fixture stat unavailable'),
      { code: value === denied ? 'EACCES' : 'EIO' });
    if (value === notDirectory) throw Object.assign(new Error('fixture parent is not a directory'), { code: 'ENOTDIR' });
    return originalStat(value, ...args);
  });
  const input = entries.join(';'); setEnv(t, pathKey(), input);
  assert.equal(readPath(cliEnvironment('fixture-home')), entries.filter(value => ![missing, nestedMissing, notDirectory].includes(value)).join(';'));
  assert.equal(readPath(process.env), input);
  assert.deepEqual(inspected, [existing, missing, nestedMissing, notDirectory, denied, uncertain, existing]);
});

test('CMD name lookup succeeds at PATH 8191 and fails at 8192 without losing Win32 environment', { skip: !windows }, t => {
  const cmd = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
  const prefix = path.dirname(process.execPath) + ';' + path.join(process.env.SystemRoot, 'System32') + ';C:\\fixture-padding-';
  const key = pathKey(); setEnv(t, key, readPath(process.env));
  for (const length of [8191, 8192]) {
    const input = prefix + 'x'.repeat(length - prefix.length);
    assert.equal(emptyNode(process.execPath, input).status, 0, 'absolute Node must remain executable');
    const result = emptyNode(cmd, input);
    assert.equal(result.status, length === 8191 ? 0 : 1);
    if (length === 8191) assert.equal(result.output, 'empty-node-ok');
    // Out-of-scope overflow is preserved, not truncated or turned into a new launch ban.
    process.env[key] = input;
    assert.equal(readPath(cliEnvironment('fixture-home')), input);
  }
});

test('removing missing temp dotnet tools restores CMD lookup in an isolated child', { skip: !windows }, t => {
  const root = fixture(t), cmd = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
  const retained = [path.dirname(process.execPath), path.join(process.env.SystemRoot, 'System32')];
  const entries = [...retained];
  while (entries.join(';').length <= 8192)
    entries.push(path.join(root, 'old-' + entries.length + '-fixture', 'dotnet-home', '.dotnet', 'tools'));
  const input = entries.join(';'); setEnv(t, pathKey(), input);
  assert.equal(emptyNode(cmd, input).status, 1);
  const output = readPath(cliEnvironment('fixture-home'));
  assert.equal(output, retained.join(';'));
  assert.equal(readPath(process.env), input);
  const result = emptyNode(cmd, output);
  assert.equal(result.status, 0);
  assert.equal(result.output, 'empty-node-ok');
});
