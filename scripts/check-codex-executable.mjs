import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDesktopCodexCommand, resolveCodexExecutable } from '../模板交付包/scripts/cli/codex-executable.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-codex-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localAppData = path.join(root, 'local'), programFiles = path.join(root, 'programs');
  const old = path.join(localAppData, 'OpenAI/Codex/bin/1111111111111111/codex.exe');
  const current = path.join(programFiles, 'WindowsApps/OpenAI.Codex_99.0_x64__test/app/resources/codex.exe');
  const put = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'isolated fake executable, never launched'); return file; };
  put(current);
  const calls = [], rows = [{ command: current, signatureValid: true, publisher: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"' }];
  const profile = { schemaVersion: 1, runner: { command: old, args: [] }, codexHome: path.join(root, 'home'), mode: 'interactive', model: 'fixture-model' };
  const options = { platform: 'win32', localAppData, programFiles, registered: () => { calls.push('registration'); return rows; }, probe: command => { calls.push(command); return true; } };
  return { root, old, current, put, calls, rows, profile, options };
}

test('missing Desktop cache path resolves signed current registered CLI without rewriting profile', t => {
  const f = fixture(t), before = JSON.stringify(f.profile);
  assert.equal(resolveCodexExecutable(f.profile, f.options).command, f.current);
  assert.equal(JSON.stringify(f.profile), before);
  assert.deepEqual(f.calls, ['registration', f.current]);
});
test('working configured program remains selected, without registration or version pinning', t => {
  const f = fixture(t); f.put(f.old);
  assert.equal(resolveCodexExecutable(f.profile, f.options).command, f.old);
  assert.deepEqual(f.calls, [f.old]);
});
test('configured program without required capability can fall back to current signed package', t => {
  const f = fixture(t); f.put(f.old); f.options.probe = command => command === f.current;
  assert.equal(resolveCodexExecutable(f.profile, f.options).command, f.current);
});
test('missing, incompatible, unsigned, wrong-publisher and ambiguous registered candidates fail visibly', async t => {
  for (const kind of ['missing', 'incompatible', 'unsigned', 'publisher', 'ambiguous', 'unregistered']) await t.test(kind, t => {
    const f = fixture(t);
    if (kind === 'missing') fs.unlinkSync(f.current);
    if (kind === 'incompatible') f.options.probe = () => false;
    if (kind === 'unsigned') f.rows[0].signatureValid = false;
    if (kind === 'publisher') f.rows[0].publisher = 'CN=NotOpenAI, O=Other Company';
    if (kind === 'unregistered') f.rows.length = 0;
    if (kind === 'ambiguous') f.rows.push({ ...f.rows[0], command: f.put(f.current.replace('99.0', '98.0')) });
    assert.throws(() => resolveCodexExecutable(f.profile, f.options), /No compatible Codex CLI/);
  });
});
test('duplicate registrations for the same executable are not a version conflict', t => {
  const f = fixture(t); f.rows.push({ ...f.rows[0] });
  assert.equal(resolveCodexExecutable(f.profile, f.options).command, f.current);
});
test('custom, relative, GUI launcher, PATH-like and wrapper commands never trigger discovery', t => {
  const f = fixture(t);
  for (const command of ['codex', path.join(f.root, 'project/codex.exe'), f.current.replace('/resources', '').replace('\\resources', ''), path.join(f.root, 'bin/codex.exe')]) {
    assert.equal(isDesktopCodexCommand(command, f.options), false);
    assert.equal(resolveCodexExecutable({ ...f.profile, runner: { command, args: [] } }, f.options).command, command);
  }
  assert.equal(resolveCodexExecutable({ ...f.profile, runner: { command: f.old, args: ['wrapper.js'] } }, f.options).command, f.old);
  assert.deepEqual(f.calls, []);
});
test('a live session keeps its original executable even after it disappears and a new candidate is available', t => {
  const f = fixture(t);
  const result = resolveCodexExecutable(f.profile, { ...f.options, liveEndpoint: { command: f.old } });
  assert.deepEqual(result, { command: f.old, pinned: true });
  assert.deepEqual(f.calls, []);
});
test('stale configured hint still pins a live session previously launched from the official package', t => {
  const f = fixture(t); fs.unlinkSync(f.current);
  const result = resolveCodexExecutable(f.profile, { ...f.options, liveEndpoint: { command: f.current } });
  assert.deepEqual(result, { command: f.current, pinned: true });
  assert.deepEqual(f.calls, []);
});
test('cold launch resolves again but does not mutate the old endpoint', t => {
  const f = fixture(t), endpoint = { command: f.old, sessionId: 'original-session' };
  const snapshot = JSON.stringify(endpoint);
  assert.equal(resolveCodexExecutable(f.profile, { ...f.options, liveEndpoint: endpoint }).command, f.old);
  assert.equal(resolveCodexExecutable(f.profile, f.options).command, f.current);
  assert.equal(JSON.stringify(endpoint), snapshot);
});
test('custom-path changes and other providers cannot be disguised as Desktop executable rollover', t => {
  const f = fixture(t), custom = f.put(path.join(f.root, 'custom/codex.exe'));
  assert.equal(resolveCodexExecutable({ ...f.profile, runner: { command: custom, args: [] } }, { ...f.options, liveEndpoint: { command: f.old } }).pinned, false);
  assert.equal(resolveCodexExecutable(f.profile, { ...f.options, liveEndpoint: { provider: 'claude', command: f.old } }).pinned, false);
});
test('an installation-path symlink cannot redirect discovery outside the trusted layouts', t => {
  const f = fixture(t), outside = f.put(path.join(f.root, 'untrusted/codex.exe'));
  fs.unlinkSync(f.current);
  fs.rmdirSync(path.dirname(f.current));
  fs.symlinkSync(path.dirname(outside), path.dirname(f.current), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveCodexExecutable(f.profile, f.options), /No compatible Codex CLI/);
});

test('case-sensitive hosts do not mistake a different custom executable for the live program', t => {
  const f = fixture(t), command = path.join(f.root, 'CustomCodex');
  const profile = { ...f.profile, runner: { command, args: [] } };
  const liveEndpoint = { command: path.join(f.root, 'customcodex') };
  assert.deepEqual(resolveCodexExecutable(profile, { ...f.options, platform: 'linux', liveEndpoint }), { command, pinned: false });
  assert.deepEqual(resolveCodexExecutable(profile, { ...f.options, platform: 'win32', liveEndpoint }), { command: liveEndpoint.command, pinned: true });
  assert.deepEqual(f.calls, []);
});
