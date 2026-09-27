// Maintainer-only packaging. No install, project initialization or remote writes.
// Requires jszip (or BEYOND_JSZIP_PATH pointing to an existing installation).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
assert.equal(git('status', '--porcelain'), '', 'Commit and verify the release tree before packaging');
const commit = git('rev-parse', 'HEAD');
const productTree = git('rev-parse', 'HEAD:模板交付包');
const product = path.join(root, '模板交付包');
const version = JSON.parse(fs.readFileSync(path.join(product, 'beyond-release.json'), 'utf8')).releaseVersion;
assert.match(version, /^\d+\.\d+\.\d+$/);
const outputRoot = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
const filename = 'BEYOND-' + version + '.zip';
const output = path.join(outputRoot, filename);
for (const suffix of ['', '.sha256', '.verification.json']) assert.ok(!fs.existsSync(output + suffix), 'Refuse overwrite: ' + output + suffix);
const Zip = createRequire(import.meta.url)(process.env.BEYOND_JSZIP_PATH || 'jszip');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const generatedAt = git('show', '-s', '--format=%cI', 'HEAD');
const payload = new Map();
const excluded = [];
const tracked = git('-c', 'core.quotePath=false', 'ls-files', '-z', '--', '模板交付包').split('\0').filter(Boolean);
for (const file of tracked) {
  const relative = file.slice('模板交付包/'.length);
  assert.ok(relative && !relative.split('/').includes('..') && !path.isAbsolute(relative));
  if (/^(local|projects|shared|\.git)(\/|$)/.test(relative)) { excluded.push(relative); continue; }
  assert.ok(fs.lstatSync(path.join(root, file)).isFile(), 'Only regular product files');
  payload.set('beyond-control/' + relative, fs.readFileSync(path.join(root, file)));
}
for (const [target, source] of [
  ['LICENSE', 'LICENSE'],
  ['INSTALL.md', 'docs/releases/v' + version + '-install.md'],
  ['RELEASE-NOTES.md', 'docs/releases/v' + version + '.md'],
  ['TEST-RESULTS.md', 'docs/releases/v' + version + '-validation.md'],
]) {
  let bytes = fs.readFileSync(path.join(root, source));
  if (target === 'RELEASE-NOTES.md') {
    const sourceLink = '(v' + version + '-validation.md)';
    assert.ok(bytes.toString('utf8').includes(sourceLink), 'Release validation link missing');
    bytes = Buffer.from(bytes.toString('utf8').replaceAll(sourceLink, '(TEST-RESULTS.md)'));
  }
  payload.set(target, bytes);
}
const products = [...payload].filter(([name]) => name.startsWith('beyond-control/'));
const entry = ([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha(bytes) });
const manifest = json({
  schemaVersion: 1, root: 'beyond-control', fileCount: products.length,
  files: products.map(([name, bytes]) => entry([name.slice(15), bytes])),
  additionalFiles: [...payload].filter(([name]) => !name.startsWith('beyond-control/')).map(entry),
});
payload.set('content-manifest.sha256.json', manifest);
payload.set('release-manifest.json', json({
  schemaVersion: 1, releaseVersion: version, buildId: 'BEYOND-' + version,
  releaseStatus: 'built-for-stable-release', sourceCommit: commit, sourceProductTree: productTree,
  sourceIncludesUncommittedChanges: false, productRoot: 'beyond-control',
  productFileCount: products.length, expectedFileCount: payload.size + 1,
  contentManifest: 'content-manifest.sha256.json', contentManifestSha256: sha(manifest),
  preserveOnUpgrade: ['beyond-control/.git/**', 'beyond-control/local/**', 'beyond-control/projects/**', 'beyond-control/shared/**'],
  excludedProtectedTemplates: excluded, generatedAt, externalSha256Required: false,
}));
const zip = new Zip();
for (const [name, bytes] of payload) zip.file(name, bytes, { createFolders: false, date: new Date(generatedAt) });
const packed = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
const reopened = await Zip.loadAsync(packed, { checkCRC32: true });
assert.deepEqual(Object.keys(reopened.files).sort(), [...payload.keys()].sort());
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-release-verification-'));
for (const [name, bytes] of payload) {
  const actual = await reopened.file(name).async('nodebuffer');
  assert.deepEqual(actual, bytes, name);
  const target = path.join(scratch, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, actual);
}
const content = JSON.parse(await reopened.file('content-manifest.sha256.json').async('string'));
for (const record of [...content.files.map(f => ({ ...f, path: 'beyond-control/' + f.path })), ...content.additionalFiles]) {
  const bytes = await reopened.file(record.path).async('nodebuffer');
  assert.equal(bytes.length, record.bytes); assert.equal(sha(bytes), record.sha256);
}
const control = path.join(scratch, 'beyond-control');
const check = spawnSync(process.execPath, [path.join(control, 'scripts/verify-install-integrity.mjs'),
  '--installed-skills-root', path.join(control, 'skills'), '--project-agents', path.join(control, 'AGENTS.md'), '--content-only'],
{ encoding: 'utf8', windowsHide: true, timeout: 120000 });
assert.equal(check.status, 0, check.stdout + check.stderr);
assert.equal(git('status', '--porcelain'), '', 'Source changed during packaging');
assert.equal(git('rev-parse', 'HEAD'), commit, 'Source commit changed during packaging');
fs.mkdirSync(outputRoot, { recursive: true });
fs.writeFileSync(output, packed, { flag: 'wx' });
fs.writeFileSync(output + '.sha256', sha(packed) + '  ' + filename + '\n', { flag: 'wx' });
const result = { sourceCommit: commit, sourceProductTree: productTree, releaseVersion: version,
  zip: output, sha256: sha(packed), bytes: packed.length, productFiles: products.length,
  totalFiles: payload.size, manifestVerified: true, extractedIntegrityExit: check.status,
  extractedRoot: scratch, installedIntoLiveProject: false };
fs.writeFileSync(output + '.verification.json', json(result), { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
