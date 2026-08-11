import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const sourceRoot = join(repositoryRoot, '模板交付包');
const scratch = mkdtempSync(join(tmpdir(), 'beyond-workbench-'));
const controlRoot = join(scratch, 'beyond-control');
const script = join(controlRoot, 'scripts', 'beyond-control.mjs');
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed: Boolean(passed), detail });
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: controlRoot, encoding: 'utf8' });
  check(`command ${args.join(' ')} exits ${expectedStatus}`, result.status === expectedStatus, result.stderr || result.stdout);
  return result;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

try {
  cpSync(sourceRoot, controlRoot, { recursive: true });
  run(['init-control']);

  const workbenchPath = join(controlRoot, 'local', '当前工作台.md');
  writeFileSync(workbenchPath, `# 当前工作台

## 1. 当前判断与正式任务

### 1.1 项目快照

| 更新时间 | 当前主线 / 业务目标 | 项目状态 | 当前主要问题 | 最近一手依据 | 当前下一步 | 需要用户决定 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-11 | 完成登录稳定性 | 进行中 | 无 | 当前任务 | 继续活动任务 | 无 |

### 1.2 正式任务表

| 任务 / 业务结果 | 负责人 / 正式 thread | 状态 | 当前进度 | 暂停原因与恢复条件 | 正式结果 / 证据入口 | 更新时间 |
| --- | --- | --- | --- | --- | --- | --- |
| 开发登录接口 | worker-active | 进行中 | 正在开发 | 无 | 无 | 2026-08-11 |
| 修复重复负责人 | worker-done | 已完成 | 已验收 | 无 | evidence/manager-fix.md | 2026-08-11 |
| 部署登录修复 | worker-retain | 已完成 | 结果仍被当前主线消费 | 无 | evidence/release.md | 2026-08-11 |
| 等待外部样本 | worker-paused | 已暂停 | 已保存现场 | 等待脱敏样本 | evidence/sample-gap.md | 2026-08-11 |

## 2. 按需协调

无。
`, 'utf8');

  const listedBefore = run(['workbench', '--action', 'list']);
  const before = parseJson(listedBefore.stdout);
  check('list returns four real task rows', before?.count === 4 && before?.counts?.进行中 === 1 && before?.counts?.已暂停 === 1 && before?.counts?.已完成 === 2, listedBefore.stdout);

  const beforeInvalid = readFileSync(workbenchPath, 'utf8');
  run(['workbench', '--action', 'archive', '--threads', 'worker-active', '--completed-at', '2026-08-11T06:00:00Z'], 1);
  check('active task rejection leaves the workbench unchanged', readFileSync(workbenchPath, 'utf8') === beforeInvalid);

  const archived = run(['workbench', '--action', 'archive', '--threads', 'worker-done', '--completed-at', '2026-08-11T06:00:00Z']);
  const archiveResult = parseJson(archived.stdout);
  const workbenchAfter = readFileSync(workbenchPath, 'utf8');
  const historyPath = join(controlRoot, 'local', 'history', 'tasks', '2026-08.md');
  const history = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
  check('selected completed task is removed from the hot table', !workbenchAfter.includes('worker-done'));
  check('active paused and retained completed tasks remain', ['worker-active', 'worker-retain', 'worker-paused'].every((value) => workbenchAfter.includes(value)));
  check('local monthly history preserves the result entry', history.includes('worker-done') && history.includes('evidence/manager-fix.md') && !history.includes('worker-retain'));
  check('archive reports one selected thread', archiveResult?.archived?.length === 1 && archiveResult.archived[0] === 'worker-done', archived.stdout);

  const backupBase = join(scratch, '.beyond-local-backups', 'beyond-control');
  const backups = existsSync(backupBase) ? readdirSync(backupBase) : [];
  check('successful convergence creates a local recovery snapshot', backups.some((name) => name.includes('workbench-archive')));

  const listedAfter = run(['workbench', '--action', 'list']);
  const after = parseJson(listedAfter.stdout);
  check('list converges to three retained task rows', after?.count === 3 && after?.counts?.进行中 === 1 && after?.counts?.已暂停 === 1 && after?.counts?.已完成 === 1, listedAfter.stdout);

  const unchangedAfter = readFileSync(workbenchPath, 'utf8');
  run(['workbench', '--action', 'archive', '--threads', 'worker-done', '--completed-at', '2026-08-11T06:00:00Z'], 1);
  const historyAfterRepeat = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
  check('repeated archive does not duplicate history or change the workbench', readFileSync(workbenchPath, 'utf8') === unchangedAfter && (historyAfterRepeat.match(/worker-done/g) ?? []).length === 1);

  const created = run(['workbench', '--action', 'upsert', '--task', '修复注册异常', '--thread', 'worker-register', '--status', '进行中', '--progress', '正在实现', '--pause', '无', '--result', '无', '--updated', '2026-08-11']);
  const createdResult = parseJson(created.stdout);
  let upserted = readFileSync(workbenchPath, 'utf8');
  check('upsert creates one active formal task row', createdResult?.mode === 'created' && (upserted.match(/worker-register/g) ?? []).length === 1 && upserted.includes('| 进行中 |'));

  const updated = run(['workbench', '--action', 'upsert', '--task', '修复注册异常', '--thread', 'worker-register', '--status', '已完成', '--progress', '已验收', '--pause', '无', '--result', 'evidence/register-fix.md', '--updated', '2026-08-11']);
  const updatedResult = parseJson(updated.stdout);
  upserted = readFileSync(workbenchPath, 'utf8');
  check('upsert updates the same task row without duplication', updatedResult?.mode === 'updated' && (upserted.match(/worker-register/g) ?? []).length === 1 && upserted.includes('evidence/register-fix.md'));

  const beforeDuplicate = upserted;
  run(['workbench', '--action', 'upsert', '--task', '修复注册异常', '--thread', 'worker-register-duplicate', '--status', '进行中', '--progress', '重复派发', '--pause', '无', '--result', '无', '--updated', '2026-08-11'], 1);
  check('upsert rejects a second thread for the same business result', readFileSync(workbenchPath, 'utf8') === beforeDuplicate);

  const backupsAfterUpsert = existsSync(backupBase) ? readdirSync(backupBase) : [];
  check('workbench upsert creates local recovery snapshots', backupsAfterUpsert.some((name) => name.includes('workbench-upsert')));

  const snapshot = run(['workbench', '--action', 'snapshot', '--mainline', '完成注册稳定性', '--status', '进行中', '--problem', '等待真实回归', '--evidence', 'evidence/register-fix.md', '--next', '执行隔离回归', '--decision', '无', '--updated', '2026-08-11']);
  const snapshotResult = parseJson(snapshot.stdout);
  const snapshotText = readFileSync(workbenchPath, 'utf8');
  check('snapshot updates the single project summary row', snapshotResult?.status === '进行中' && snapshotText.includes('| 2026-08-11 | 完成注册稳定性 | 进行中 | 等待真实回归 | evidence/register-fix.md | 执行隔离回归 | 无 |'));

  const beforeInvalidSnapshot = snapshotText;
  run(['workbench', '--action', 'snapshot', '--mainline', '错误状态', '--status', '验证中', '--problem', '无', '--evidence', '无', '--next', '无', '--decision', '无', '--updated', '2026-08-11'], 2);
  check('snapshot rejects states outside the three-state model', readFileSync(workbenchPath, 'utf8') === beforeInvalidSnapshot);

  const backupsAfterSnapshot = existsSync(backupBase) ? readdirSync(backupBase) : [];
  check('workbench snapshot creates a local recovery snapshot', backupsAfterSnapshot.some((name) => name.includes('workbench-snapshot')));

  const gitStatus = execFileSync('git', ['status', '--short'], { cwd: controlRoot, encoding: 'utf8' });
  check('local convergence does not stage or commit Git content', !/^A |^M |^D /m.test(gitStatus));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const failures = results.filter((result) => !result.passed);
console.log(JSON.stringify({ assertions: results.length, passed: results.length - failures.length, failed: failures.length, results, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
