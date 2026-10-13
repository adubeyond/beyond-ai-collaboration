// Maintainer-only upgrade/rollback check against an exact release ZIP or extracted root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTemporaryWorkspace } from './lib/temporary-workspace.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(args[0] && !args[0].startsWith('--'), 'Pass a release ZIP or extracted release root');
const releaseInput = path.resolve(args[0]);
let baselineRef = null;
let baselineRoot = null;
for (let index = 1; index < args.length; index++) {
  const option = args[index];
  assert.ok(['--baseline-ref', '--baseline-root'].includes(option), 'Unknown option: ' + option);
  const value = args[++index];
  assert.ok(value && !value.startsWith('--'), option + ' requires a value');
  assert.ok(!baselineRef && !baselineRoot, 'Select exactly one of --baseline-ref or --baseline-root');
  if (option === '--baseline-ref') baselineRef = value;
  else baselineRoot = path.resolve(value);
}
assert.ok(baselineRef || baselineRoot, 'Select exactly one of --baseline-ref or --baseline-root');
const workspace = createTemporaryWorkspace('beyond-package-upgrade-');
const scratch = workspace.root;
let result;
try {
let release = releaseInput;
if (fs.lstatSync(releaseInput).isFile()) {
  const Zip = createRequire(import.meta.url)(process.env.BEYOND_JSZIP_PATH || 'jszip');
  const archive = await Zip.loadAsync(fs.readFileSync(releaseInput), { checkCRC32: true });
  release = path.join(scratch, 'release');
  for (const [name, entry] of Object.entries(archive.files)) {
    const original = entry.unsafeOriginalName ?? name;
    assert.ok(!original.replaceAll('\\', '/').split('/').includes('..'), 'Unsafe ZIP member: ' + original);
    assert.ok(!path.win32.isAbsolute(original) && !path.posix.isAbsolute(original), 'Absolute ZIP member: ' + original);
    assert.notEqual((Number(entry.unixPermissions) & 0o170000), 0o120000, 'ZIP links are not product files');
    if (entry.dir) continue;
    const target = path.resolve(release, name), relative = path.relative(release, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Unsafe ZIP member: ' + name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async('nodebuffer'));
  }
}
const releaseManifest = JSON.parse(fs.readFileSync(path.join(release, 'release-manifest.json'), 'utf8'));
const releaseVersion = releaseManifest.releaseVersion;
assert.match(releaseVersion, /^\d+\.\d+\.\d+$/);
const productVersion = JSON.parse(fs.readFileSync(path.join(release, 'beyond-control/beyond-release.json'), 'utf8')).releaseVersion;
assert.equal(productVersion, releaseVersion, 'Release manifest and product version must agree');
assert.equal(releaseManifest.productRoot, 'beyond-control');
assert.equal(releaseManifest.contentManifest, 'content-manifest.sha256.json');
const manifestBytes = fs.readFileSync(path.join(release, releaseManifest.contentManifest));
assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), releaseManifest.contentManifestSha256);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.fileCount, manifest.files.length);
assert.equal(releaseManifest.productFileCount, manifest.files.length);
assert.equal(new Set(manifest.files.map(record => record.path)).size, manifest.files.length, 'Duplicate product manifest paths');
const project = path.join(scratch, 'project');
const control = path.join(project, 'beyond-control');
const skills = path.join(project, 'user-skills');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const contained = (base, name) => {
  const target = path.resolve(base, name), rel = path.relative(base, target);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'unsafe path: ' + name);
  return target;
};
const write = (target, bytes) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
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
function command(args, script = 'scripts/beyond-control.mjs') {
  const r = spawnSync(process.execPath, [path.join(control, script), ...args], { cwd: project, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}

if (baselineRoot) {
  assert.ok(fs.existsSync(path.join(baselineRoot, 'beyond-release.json')), '--baseline-root must point to the complete product directory');
  const baselineSnapshot = snapshot(baselineRoot);
  fs.cpSync(baselineRoot, control, { recursive: true });
  assert.deepEqual(snapshot(control), baselineSnapshot, 'Baseline copy must preserve its complete product bytes');
} else {
  const Zip = createRequire(import.meta.url)(process.env.BEYOND_JSZIP_PATH || 'jszip');
  const baseline = await Zip.loadAsync(execFileSync('git', ['archive', '--format=zip', baselineRef, '模板交付包'], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
  for (const [name, entry] of Object.entries(baseline.files)) {
    if (entry.dir) continue;
    assert.ok(name.startsWith('模板交付包/'));
    write(contained(control, name.slice('模板交付包/'.length)), await entry.async('nodebuffer'));
  }
}
const baselineVersion = JSON.parse(fs.readFileSync(path.join(control, 'beyond-release.json'), 'utf8')).releaseVersion;
write(path.join(project, 'AGENTS.md'), '# Existing project\n\nKeep the native business rules.\n');
command(['install-project-entry', '--project-root', project, '--confirm-fusion', 'yes']);
const projectId = JSON.parse(command(['register-project', '--project-root', project])).project.projectId;
const overview = path.join(control, 'projects', projectId, '项目总览.md');
const oldPolicy = { schemaVersion: 1, mode: 'beyond-worker-gpt61-v4', scope: 'formal-worker-stages', confirmed: true, approvedBy: 'Historical test approval', approvedAt: '2026-10-01T00:00:00.000Z' };
const oldOverview = fs.readFileSync(overview, 'utf8');
assert.match(oldOverview, /BEGIN BEYOND WORKER POLICY/);
const fence = String.fromCharCode(96).repeat(3);
write(overview, oldOverview.replace(/(<!-- BEGIN BEYOND WORKER POLICY -->)[\s\S]*?(<!-- END BEYOND WORKER POLICY -->)/, (_, begin, end) => begin + '\n' + fence + 'json\n' + JSON.stringify(oldPolicy) + '\n' + fence + '\n' + end));
fs.cpSync(path.join(control, 'skills'), skills, { recursive: true });
execFileSync('git', ['init', '--quiet', control], { windowsHide: true });
write(path.join(control, 'shared', 'user-facts.md'), '# Preserved user facts\n');
// Byte-preservation sentinels only: do not launch or impersonate a live CLI session.
const preservedSentinels = {
  'beyond-control/local/runtime/cli-tasks/upgrade-session-sentinel.json': JSON.stringify({
    kind: 'upgrade-byte-preservation-fixture', sessionId: 'fixture-cli-session', ownerThreadId: 'fixture-owner',
  }) + '\n',
  [`beyond-control/projects/${projectId}/existing-engineering-guide.md`]: '# Existing engineering facts\n\nKeep the agreed module boundaries.\n',
  'docs/existing-business-guide.md': '# Existing business facts\n\nKeep the original business definitions.\n',
};
for (const [name, bytes] of Object.entries(preservedSentinels)) write(contained(project, name), bytes);
const { WorkbenchTransactionStore } = await import(pathToFileURL(path.join(control, 'scripts/runtime/workbench-transaction.mjs')));
const store = new WorkbenchTransactionStore({ runtimeRoot: path.join(control, 'local/runtime/workbench'), viewPath: path.join(control, 'local/当前工作台.md'), historyRoot: path.join(control, 'local/history/workbench') });
for (const name of ['active', 'paused']) store.registerTask({ taskId: name, task: name, worker: 'fixture-' + name, status: '进行中', progress: 'Preserve task', pause: '无', result: '无', updatedAt: '2026-10-01T00:00:00.000Z' });
store.updateTask({ operationId: 'fixture-pause', taskId: 'paused', expectedStatus: '进行中', status: '已暂停', progress: 'Waiting for input', pause: 'Need owner input', updatedAt: '2026-10-01T00:01:00.000Z' });
const request = path.join(scratch, 'receipt.json');
write(request, JSON.stringify({ schemaVersion: 1, action: 'worker-result.enqueue', input: { projectId, taskId: 'active', sourceThreadId: 'fixture-owner', businessState: '已完成', finalText: '已完成\nFixture result' } }));
command(['runtime', '--request', request]);
const before = snapshot(project);
const backup = path.join(scratch, 'backup'); fs.cpSync(project, backup, { recursive: true });
assert.deepEqual(snapshot(backup), before);
for (const record of manifest.files) {
  assert.ok(!/^(local|projects|shared|\.git)(\/|$)/.test(record.path));
  const bytes = fs.readFileSync(contained(path.join(release, 'beyond-control'), record.path));
  assert.equal(bytes.length, record.bytes); assert.equal(sha(bytes), record.sha256);
  write(contained(control, record.path), bytes);
}
const protectedBefore = Object.fromEntries(Object.entries(before).filter(([name]) => /^beyond-control\/(local|projects|shared|\.git)\//.test(name)));
const afterCopy = snapshot(project);
for (const [name, hash] of Object.entries(protectedBefore)) assert.equal(afterCopy[name], hash, name);
for (const name of fs.readdirSync(path.join(release, 'beyond-control/skills'))) fs.cpSync(path.join(release, 'beyond-control/skills', name), path.join(skills, name), { recursive: true });
command(['install-project-entry', '--project-root', project, '--confirm-fusion', 'yes']);
const integrity = command(['--installed-skills-root', skills, '--project-agents', path.join(project, 'AGENTS.md')], 'scripts/verify-install-integrity.mjs');
assert.ok(integrity.includes('BEYOND ' + releaseVersion));
assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /Keep the native business rules/);
const policy = JSON.parse(command(['worker-policy', '--action', 'resolve-stage', '--project-id', projectId, '--task-kind', 'ordinary-engineering']));
assert.equal(policy.requiresSelection, true); assert.deepEqual(policy.continuationParameters, {});
const upgraded = snapshot(project);
for (const [name, hash] of Object.entries(protectedBefore).filter(([name]) => /\/(runtime\/workbench|runtime\/worker-results|runtime\/cli-tasks|shared\/|\.git\/)/.test(name))) assert.equal(upgraded[name], hash, name);
for (const name of Object.keys(preservedSentinels)) assert.equal(upgraded[name], before[name], name);
assert.equal(store.snapshot().tasks.active.status, '进行中');
assert.equal(store.snapshot().tasks.paused.status, '已暂停');
// Restore precisely the scratch project's before-image; never delete live paths.
for (const name of Object.keys(upgraded).filter(name => !Object.hasOwn(before, name))) fs.unlinkSync(contained(project, name));
for (const name of Object.keys(before)) write(contained(project, name), fs.readFileSync(contained(backup, name)));
assert.deepEqual(snapshot(project), before);
result = { passed: true, baseline: baselineRef ?? baselineRoot, baselineKind: baselineRef ? 'git-ref' : 'product-directory', baselineVersion,
  release: releaseVersion, productFiles: manifest.files.length, protectedFiles: Object.keys(protectedBefore).length,
  nativeRulesPreserved: true, tasksUnchanged: true, cliSessionBytesPreserved: true, businessDocumentsPreserved: true,
  liveCliExecutionTested: false, historicalApprovalNotReinterpreted: true, rollbackBytesEqual: true,
  releaseInput, scratch: null, temporaryWorkspaceRemoved: true, liveProjectWrites: false };
} finally {
  workspace.cleanup();
}
console.log(JSON.stringify(result, null, 2));
