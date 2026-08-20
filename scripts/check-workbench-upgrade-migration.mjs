import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchTransactionStore } from '../模板交付包/scripts/runtime/workbench-transaction.mjs';

const legacyView = `# 当前工作台

> 这是3.1控制仓的唯一活动控制面。

## 1. 当前判断与正式任务

### 1.1 项目快照

| 更新时间 | 当前主线 / 业务目标 | 项目状态 | 当前主要问题 | 最近一手依据 | 当前下一步 | 需要用户决定 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-18 | 恢复生产 | 已暂停 | 升级窗口内暂停派单 | 当前0进行中、1暂停、3完成 | 完成3.2升级后恢复 | 无 |

### 1.2 正式任务表

| 任务 / 业务结果 | 负责人 / 正式 thread | 状态 | 当前进度 | 暂停原因与恢复条件 | 正式结果 / 证据入口 | 更新时间 |
| --- | --- | --- | --- | --- | --- | --- |
| 公共编排边界与接口合同闭合 | worker-paused-alpha | 已暂停 | 原任务工具状态损坏 | 使用干净任务承接 | thread:worker-paused-alpha | 2026-08-18 |
| 11站L1/L2硬门复核 | worker-completed-a | 已完成 | 已验收 | 无 | evidence:l1 | 2026-08-14 |
| 11站分类准确性收口 | worker-completed-b | 已完成 | 已验收 | 无 | evidence:classification | 2026-08-14 |
| 观察站11/11接入 | worker-completed-c | 已完成 | 已验收 | 无 | evidence:observer | 2026-08-15 |

### 1.3 待办池与稳定边界

- 本节属于项目自由正文，迁移后必须保留。

## 2. 按需协调

- 不自动恢复旧任务。
`;

function createStore(root, source) {
  const local = path.join(root, 'local');
  const viewPath = path.join(local, '当前工作台.md');
  const runtimeRoot = path.join(local, 'runtime', 'workbench');
  const historyRoot = path.join(local, 'history', 'workbench');
  fs.mkdirSync(path.dirname(viewPath), { recursive: true });
  fs.writeFileSync(viewPath, source, 'utf8');
  return {
    viewPath,
    runtimeRoot,
    historyRoot,
    store: new WorkbenchTransactionStore({ runtimeRoot, viewPath, historyRoot }),
  };
}

function verifyMigration(source, expectedActive, expectedCompleted) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-workbench-migration-'));
  try {
    const legacyHistory = path.join(root, 'local', 'history', 'tasks', '2026-08.md');
    fs.mkdirSync(path.dirname(legacyHistory), { recursive: true });
    fs.writeFileSync(legacyHistory, '# existing 3.1 history\n', 'utf8');
    const first = createStore(root, source);
    const state = first.store.snapshot();
    const startup = first.store.startupStatus();
    assert.equal(startup.performed, true);
    assert.equal(startup.activeCount, expectedActive);
    assert.equal(startup.completedCount, expectedCompleted);
    assert.equal(Object.keys(state.tasks).length, expectedActive);
    assert.equal(state.revision, 1);
    assert.equal(state.projectSnapshot?.status, '已暂停');
    assert.equal(fs.readFileSync(legacyHistory, 'utf8'), '# existing 3.1 history\n');
    assert.equal(fs.existsSync(path.join(first.historyRoot, '2026-08.json')), false);
    assert.equal(fs.readFileSync(path.join(first.runtimeRoot, 'backups', 'pre-3.2-markdown-workbench.md'), 'utf8'), source);
    const view = first.store.view();
    assert.match(view, /BEGIN BEYOND MANAGED WORKBENCH/);
    assert.match(view, /公共编排边界与接口合同闭合/);
    assert.match(view, /本节属于项目自由正文|待办池与稳定边界/);
    assert.doesNotMatch(view, /###\s+1\.1\s+项目快照/);
    assert.doesNotMatch(view, /###\s+1\.2\s+正式任务表/);

    const beforeState = fs.readFileSync(first.store.stateFile, 'utf8');
    const beforeView = fs.readFileSync(first.viewPath, 'utf8');
    const second = new WorkbenchTransactionStore({
      runtimeRoot: first.runtimeRoot,
      viewPath: first.viewPath,
      historyRoot: first.historyRoot,
    });
    assert.equal(second.startupStatus().performed, false);
    assert.equal(fs.readFileSync(second.stateFile, 'utf8'), beforeState);
    assert.equal(fs.readFileSync(first.viewPath, 'utf8'), beforeView);
    return startup;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const builtIn = verifyMigration(legacyView, 1, 3);
const sourceIndex = process.argv.indexOf('--source-workbench');
let external = null;
if (sourceIndex >= 0) {
  const sourcePath = process.argv[sourceIndex + 1];
  if (!sourcePath) throw new Error('--source-workbench requires a file');
  external = verifyMigration(fs.readFileSync(path.resolve(sourcePath), 'utf8'), 1, 3);
}

console.log(JSON.stringify({ passed: true, assertions: external ? 28 : 14, builtIn, external }, null, 2));
