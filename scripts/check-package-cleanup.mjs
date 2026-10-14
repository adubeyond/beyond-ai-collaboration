// Isolated producer regression: no live install, source commit, or release publication.
// Requires the same existing jszip installation as build-release.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTemporaryWorkspace } from './lib/temporary-workspace.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Zip = createRequire(import.meta.url)(process.env.BEYOND_JSZIP_PATH || 'jszip');
const workspace = createTemporaryWorkspace('beyond-package-cleanup-test-');
const root = workspace.root;
const fixture = path.join(root, 'source');
const temporary = path.join(root, 'temporary');
const output = path.join(root, 'release');
const preserved = path.join(temporary, 'unowned-recovery');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (name, bytes) => { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, bytes); };
const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', windowsHide: true }).trim();
const environment = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary };
delete environment.NODE_TEST_CONTEXT;
function run(script, args, expected, overrides = {}) {
  const execution = spawnSync(process.execPath, [path.join(fixture, 'scripts', script), ...args], {
    cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 120000,
    maxBuffer: 4 * 1024 * 1024, env: { ...environment, ...overrides },
  });
  assert.ifError(execution.error);
  if (expected === 0) assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  else assert.notEqual(execution.status, 0, 'Injected failure must remain a failure');
  assert.deepEqual(fs.readdirSync(temporary).sort(), ['unowned-recovery'], 'Generated scratch was not reclaimed');
  assert.equal(fs.readFileSync(path.join(preserved, 'unique.txt'), 'utf8'), 'unique recovery must survive');
  return execution;
}
function snapshot(base, prefix = '') {
  const result = {};
  for (const entry of fs.readdirSync(path.join(base, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    assert.ok(!entry.isSymbolicLink());
    if (entry.isDirectory()) Object.assign(result, snapshot(base, name + '/'));
    else result[name] = sha(fs.readFileSync(path.join(base, name)));
  }
  return result;
}
let report;
try {
  // Product baseline is immutable HEAD; only candidate producer/helper scripts are overlaid.
  const committed = await Zip.loadAsync(execFileSync('git', ['archive', '--format=zip', 'HEAD', '模板交付包'], {
    cwd: source, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  }));
  for (const [name, entry] of Object.entries(committed.files)) {
    if (!entry.dir) write(path.join(fixture, name), await entry.async('nodebuffer'));
  }
  for (const name of ['build-release.mjs', 'check-release-package.mjs', 'lib/temporary-workspace.mjs']) {
    write(path.join(fixture, 'scripts', name), fs.readFileSync(path.join(source, 'scripts', name)));
  }
  const version = JSON.parse(fs.readFileSync(path.join(fixture, '模板交付包/beyond-release.json'))).releaseVersion;
  write(path.join(fixture, 'LICENSE'), 'Isolated test fixture only\n');
  write(path.join(fixture, 'docs/releases', `v${version}-install.md`), '# Isolated install fixture\n');
  write(path.join(fixture, 'docs/releases', `v${version}.md`), `[Validation](v${version}-validation.md)\n`);
  write(path.join(fixture, 'docs/releases', `v${version}-validation.md`), '# Isolated validation fixture\n');
  write(path.join(preserved, 'unique.txt'), 'unique recovery must survive');
  git('init', '--quiet');
  git('add', '--all');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Isolated packaging fixture');
  const originalSource = snapshot(fixture);
  const baseline = path.join(fixture, '模板交付包');
  const preload = path.join(root, 'fail-extracted-integrity.cjs');
  write(preload, "if ((process.argv[1] || '').endsWith('verify-install-integrity.mjs')) { process.stderr.write('injected extracted integrity failure\\n'); process.exit(23); }\n");
  let zipPath;
  for (let round = 0; round < 5; round++) {
    const roundOutput = path.join(output, String(round));
    const built = JSON.parse(run('build-release.mjs', [roundOutput], 0).stdout);
    assert.equal(built.extractedRoot, null);
    assert.equal(built.temporaryExtractionRemoved, true);
    assert.ok(fs.existsSync(built.zip + '.verification.json'));
    zipPath = built.zip;
    const before = snapshot(roundOutput);
    const checked = JSON.parse(run('check-release-package.mjs', [zipPath, '--baseline-root', baseline], 0).stdout);
    assert.equal(checked.temporaryWorkspaceRemoved, true);
    assert.equal(checked.rollbackBytesEqual, true);
    assert.deepEqual(snapshot(roundOutput), before, 'Release files must remain unchanged');
    const failure = run('build-release.mjs', [path.join(root, 'failed-build')], 1,
      { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` });
    assert.match(failure.stderr, /injected extracted integrity failure/);
    assert.ok(!fs.existsSync(path.join(root, 'failed-build')), 'Failed integrity must not publish release outputs');
    const badBaseline = run('check-release-package.mjs', [zipPath, '--baseline-root', path.join(root, 'missing-baseline')], 1);
    assert.match(badBaseline.stderr, /baseline-root must point to the complete product directory/);
  }
  const extracted = path.join(root, 'caller-extraction');
  const archive = await Zip.loadAsync(fs.readFileSync(zipPath));
  for (const [name, entry] of Object.entries(archive.files)) {
    if (!entry.dir) write(path.join(extracted, name), await entry.async('nodebuffer'));
  }
  const originalExtraction = snapshot(extracted);
  run('check-release-package.mjs', [extracted, '--baseline-root', baseline], 0);
  assert.deepEqual(snapshot(extracted), originalExtraction, 'Caller extraction must be preserved');
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'content-manifest.sha256.json')));
  const corrupted = manifest.files.find(record => record.path !== 'beyond-release.json');
  write(path.join(extracted, 'beyond-control', corrupted.path), 'Intentional corrupt fixture\n');
  const corruptSnapshot = snapshot(extracted);
  for (let round = 0; round < 3; round++) {
    run('check-release-package.mjs', [extracted, '--baseline-root', baseline], 1);
    assert.deepEqual(snapshot(extracted), corruptSnapshot, 'Even failing caller input must remain untouched');
  }
  const unsafe = new Zip();
  unsafe.file('../escape.txt', 'must not extract', { createFolders: false });
  const unsafeZip = path.join(root, 'unsafe.zip');
  write(unsafeZip, await unsafe.generateAsync({ type: 'nodebuffer' }));
  const unsafeHash = sha(fs.readFileSync(unsafeZip));
  const unsafeResult = run('check-release-package.mjs', [unsafeZip, '--baseline-root', baseline], 1);
  assert.match(unsafeResult.stderr, /Unsafe ZIP member/);
  assert.equal(sha(fs.readFileSync(unsafeZip)), unsafeHash);
  assert.ok(!fs.existsSync(path.join(temporary, 'escape.txt')));
  const outputSnapshot = snapshot(output);
  const refused = run('build-release.mjs', [path.join(output, '4')], 1);
  assert.match(refused.stderr, /Refuse overwrite/);
  assert.deepEqual(snapshot(output), outputSnapshot);
  assert.deepEqual(snapshot(fixture), originalSource, 'Source and baseline must stay byte-identical');
  write(path.join(fixture, 'uncommitted.txt'), 'uncommitted source is not a release');
  const dirty = run('build-release.mjs', [path.join(root, 'dirty-build')], 1);
  assert.match(dirty.stderr, /Commit and verify the release tree before packaging/);
  assert.equal(fs.readFileSync(path.join(fixture, 'uncommitted.txt'), 'utf8'), 'uncommitted source is not a release');
  report = { passed: true, repeatedRounds: 5, successfulBuilds: 5, successfulZipUpgradeChecks: 5,
    successfulDirectoryUpgradeChecks: 1, extractedVerificationFailures: 5, invalidBaselineFailures: 5,
    postFixtureValidationFailures: 3, unsafeZipRefusals: 1, overwriteAndDirtySourceRefusals: 2,
    generatedTemporaryDirectoriesRemaining: 0, sourceAndInputBytesPreserved: true,
    unownedRecoveryPreserved: true, productionWrites: false };
} finally {
  workspace.cleanup();
}
console.log(JSON.stringify(report, null, 2));
