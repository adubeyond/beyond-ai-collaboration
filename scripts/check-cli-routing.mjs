import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCliRequest } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { CliTaskStore } from '../模板交付包/scripts/cli/cli-task-store.mjs';
test('an existing formal Worker remains the only owner of its CLI assistance', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-route-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'local/projects'), { recursive: true }); fs.mkdirSync(path.join(root, 'cli-home'));
  fs.writeFileSync(path.join(root, 'local/projects/local-test.md'), `---\nid: local-test\npath: ${root}\nhost_id: local\ncodex_project_id: desktop-test\n---\n`);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: local-test -->\n');
  const profilePath = path.join(root, 'profile.json'); fs.writeFileSync(profilePath, JSON.stringify({ schemaVersion: 1, runner: { command: process.execPath, args: [] }, codexHome: path.join(root, 'cli-home'), model: 'test' }));
  const stateDir = path.join(root, 'local/runtime/workbench'); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'workbench-state.json'), JSON.stringify({ tasks: { goal: { worker: 'original-worker', status: '进行中' } } }));
  const binding = { projectId: 'local-test', taskId: 'goal', ownerThreadId: 'pm', ownerTurnId: 'turn', executionRoot: root, profilePath, taskMode: 'assist', contract: { goal: 'original task', boundaries: 'only original', acceptance: 'tests', factEntries: [], skillEntries: [] } };
  await assert.rejects(() => launchCliRequest({ schemaVersion: 1, requestId: 'wrong', action: 'cli.start', input: { ...binding, prompt: 'do work' } }, { controlRoot: root, executionRoot: root, ownerThreadId: 'pm', ownerTurnId: 'turn' }), /original Worker/);
  assert.equal(fs.existsSync(new CliTaskStore({ controlRoot: root }).locator(binding)), false);
});
test('optional CLI has one rule owner and keeps the default Worker callback intact', () => {
  const base = path.join(import.meta.dirname, '..', '模板交付包');
  const rule = fs.readFileSync(path.join(base, 'docs/AI编程协同机制/机制/04-CLI目标协作机制.md'), 'utf8');
  for (const file of ['AGENTS.md', 'skills/identity-pm/SKILL.md', 'skills/identity-worker/SKILL.md']) {
    const text = fs.readFileSync(path.join(base, file), 'utf8');
    assert.match(text, /04-CLI目标协作机制/);
  }
  assert.match(rule, /PM → Worker ↔ CLI/); assert.match(rule, /PM或Worker ↔ CLI/);
  assert.match(rule, /CLI_RESULT_READY/); assert.match(rule, /workbench\.accept-cli/);
  assert.match(rule, /不.*worker-result\.enqueue/);
  const worker = fs.readFileSync(path.join(base, 'skills/identity-worker/SKILL.md'), 'utf8');
  assert.match(worker, /已确认.*CLI后台/);
  assert.match(worker, /当前Worker正在提交终态；请扫描待处理终态并在任务线程结束后核对final/);
  assert.match(worker, /"threadId":"<source_thread_id>","prompt"/);
  assert.match(worker, /正式任务在回源前通过固定`runtime`入口执行一次`worker-result.enqueue`/);
});

test('CLI local result inspection accepts equivalent absolute execution paths but not another root', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'local/projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'local/projects/local-test.md'), `---\nid: local-test\npath: ${root}\n---\n`);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: local-test -->\n');
  const equivalent = root.replaceAll('\\', '/') + '/.';
  const binding = { projectId: 'local-test', taskId: 'goal', ownerThreadId: 'owner', ownerTurnId: 'turn', executionRoot: equivalent, profilePath: path.join(root, 'profile.json'), taskMode: 'assist', contract: { goal: 'inspect', boundaries: 'temporary', acceptance: 'same root', factEntries: [], skillEntries: [] } };
  const store = new CliTaskStore({ controlRoot: root }); store.create(binding);
  const request = { schemaVersion: 1, requestId: 'inspect-equivalent', action: 'cli.status', input: { projectId: 'local-test', taskId: 'goal', ownerThreadId: 'owner' } };
  const context = { controlRoot: root, executionRoot: root, ownerThreadId: 'owner' };
  assert.equal((await launchCliRequest(request, context)).taskId, 'goal');
  const before = fs.readFileSync(store.locator(binding));
  await assert.rejects(() => launchCliRequest(request, { ...context, executionRoot: path.join(root, 'other') }), /identity mismatch/);
  assert.deepEqual(fs.readFileSync(store.locator(binding)), before);
});
