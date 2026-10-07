// Maintainer-only upgrade/rollback check against the exact extracted release.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.argv[2], 'Pass the extracted release root');
const release = path.resolve(process.argv[2]);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-package-upgrade-'));
const project = path.join(scratch, 'project');
const control = path.join(project, 'beyond-control');
const skills = path.join(project, 'user-skills');
const Zip = createRequire(import.meta.url)(process.env.BEYOND_JSZIP_PATH || 'jszip');
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

const baseline = await Zip.loadAsync(execFileSync('git', ['archive', '--format=zip', 'v3.2.10', '模板交付包'], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
for (const [name, entry] of Object.entries(baseline.files)) {
  if (entry.dir) continue;
  assert.ok(name.startsWith('模板交付包/'));
  write(contained(control, name.slice('模板交付包/'.length)), await entry.async('nodebuffer'));
}
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
const manifest = JSON.parse(fs.readFileSync(path.join(release, 'content-manifest.sha256.json')));
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
assert.match(integrity, /3\.2\.11/);
assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /Keep the native business rules/);
const policy = JSON.parse(command(['worker-policy', '--action', 'resolve-stage', '--project-id', projectId, '--task-kind', 'ordinary-engineering']));
assert.equal(policy.requiresSelection, true); assert.deepEqual(policy.continuationParameters, {});
const upgraded = snapshot(project);
for (const [name, hash] of Object.entries(protectedBefore).filter(([name]) => /\/(runtime\/workbench|runtime\/worker-results|shared\/|\.git\/)/.test(name))) assert.equal(upgraded[name], hash, name);
assert.equal(store.snapshot().tasks.active.status, '进行中');
assert.equal(store.snapshot().tasks.paused.status, '已暂停');
// Restore precisely the scratch project's before-image; never delete live paths.
for (const name of Object.keys(upgraded).filter(name => !Object.hasOwn(before, name))) fs.unlinkSync(contained(project, name));
for (const name of Object.keys(before)) write(contained(project, name), fs.readFileSync(contained(backup, name)));
assert.deepEqual(snapshot(project), before);
console.log(JSON.stringify({ passed: true, baseline: 'v3.2.10', release: '3.2.11', productFiles: manifest.files.length, protectedFiles: Object.keys(protectedBefore).length, nativeRulesPreserved: true, tasksUnchanged: true, historicalApprovalNotReinterpreted: true, rollbackBytesEqual: true, scratch, liveProjectWrites: false }, null, 2));
