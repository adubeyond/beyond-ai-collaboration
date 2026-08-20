import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(repositoryRoot, '模板交付包');
const scratch = mkdtempSync(join(tmpdir(), 'beyond-historical-workbench-'));
const projectRoot = join(scratch, 'managed-project');
const controlRoot = join(projectRoot, 'beyond-control');
const controlScript = join(controlRoot, 'scripts', 'beyond-control.mjs');

function run(args) {
  const result = spawnSync(process.execPath, [controlScript, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(args[0] + ' failed (' + result.status + '): ' + (result.stderr || result.stdout));
  }
  return JSON.parse(result.stdout);
}

function taskTable(task, worker, status) {
  return [
    '# 当前工作台',
    '',
    '### 1.1 项目快照',
    '',
    '| 更新时间 | 当前主线 / 业务目标 | 项目状态 | 当前主要问题 | 最近一手依据 | 当前下一步 | 需要用户决定 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 2026-08-19 | 稳定升级 | 已暂停 | 安装窗口 | 当前无运行任务 | 完成升级 | 无 |',
    '',
    '### 1.2 正式任务表',
    '',
    '| 任务 / 业务结果 | 负责人 / 正式 thread | 状态 | 当前进度 | 暂停原因与恢复条件 | 正式结果 / 证据入口 | 更新时间 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| ' + task + ' | ' + worker + ' | ' + status + ' | 保留当前状态 | 安装后人工恢复 | thread:' + worker + ' | 2026-08-19 |',
    '',
  ].join('\n');
}

try {
  mkdirSync(projectRoot, { recursive: true });
  cpSync(packageRoot, controlRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'AGENTS.md'), [
    '<!-- BEYOND-CONTROL-ROOT: ./beyond-control -->',
    '# 项目入口',
    '',
    '<!-- BEGIN BEYOND PROJECT OVERRIDES -->',
    '- 本机当前工作台唯一入口为 ./beyond-control/local/当前工作台.md；旧 docs/AI编程协同机制/当前工作台.md 只作历史来源。',
    '<!-- END BEYOND PROJECT OVERRIDES -->',
    '',
  ].join('\n'), 'utf8');
  const oldWorkbench = join(projectRoot, 'docs', 'AI编程协同机制', '当前工作台.md');
  mkdirSync(dirname(oldWorkbench), { recursive: true });
  writeFileSync(oldWorkbench, taskTable('过期旧任务', 'worker-stale', '进行中'), 'utf8');
  writeFileSync(join(controlRoot, 'local', '当前工作台.md'), taskTable('当前真实暂停任务', 'worker-current', '已暂停'), 'utf8');

  const inspect = run(['inspect-project', '--project-root', projectRoot]);
  assert.equal(inspect.legacyWorkbench.parseable, true);
  assert.equal(inspect.legacyWorkbench.historical, true);
  assert.equal(inspect.legacyWorkbench.counts.进行中, 1);
  assert.equal(inspect.adoptionRequired, false);

  const installed = run(['install-project-entry', '--project-root', projectRoot, '--confirm-fusion', 'yes']);
  assert.equal(installed.adoption, null);
  assert.equal(installed.workbenchMigration.performed, true);
  assert.equal(installed.workbenchMigration.activeCount, 1);

  const state = JSON.parse(readFileSync(
    join(controlRoot, 'local', 'runtime', 'workbench', 'workbench-state.json'),
    'utf8',
  ));
  const tasks = Object.values(state.tasks);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].worker, 'worker-current');
  assert.equal(tasks[0].status, '已暂停');
  assert.equal(tasks.some((task) => task.worker === 'worker-stale'), false);
  console.log('历史工作台路由回归通过：11项');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
