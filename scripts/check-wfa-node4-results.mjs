import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');

const evidenceRoot = join(runtimeRoot, 'evidence');
const caseRoot = join(runtimeRoot, 'cases', 'WFA02-workbench-convergence');
const message = readFileSync(join(evidenceRoot, 'WFA02-last-message.txt'), 'utf8');
const events = readFileSync(join(evidenceRoot, 'WFA02-events.jsonl'), 'utf8');
const commandList = events.split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try {
    const event = JSON.parse(line);
    return event.type === 'item.started' && event.item?.type === 'command_execution' ? [event.item.command] : [];
  } catch {
    return [];
  }
});
const commands = commandList.join('\n');

const workbench = readFileSync(join(caseRoot, 'local', '当前工作台.md'), 'utf8');
const historyPath = join(caseRoot, 'local', 'history', 'workbench', '2026-08.md');
const historyJsonPath = join(caseRoot, 'local', 'history', 'workbench', '2026-08.json');
const history = [historyPath, historyJsonPath]
  .filter((path) => existsSync(path))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const backupRoot = join(caseRoot, 'local', 'runtime', 'workbench', 'backups');
const results = [];
const check = (name, passed) => results.push({ name, passed: Boolean(passed) });

check('WFA-02 PM uses the fixed runtime acceptance transaction', commandList.some((command) => /beyond-control\.mjs['"]?\s+runtime/.test(command) && command.includes('--request')));
check('WFA-02 selected completed task leaves the hot table', !workbench.includes('worker-done') && history.includes('worker-done') && history.includes('evidence/manager-fix.md'));
check('WFA-02 active and retained tasks remain', workbench.includes('worker-active') && workbench.includes('worker-retain') && !history.includes('worker-retain'));
check('WFA-02 local recovery backup exists', existsSync(backupRoot) && readdirSync(backupRoot).some((name) => name.endsWith('.json')));
check('WFA-02 PM reports the business result', /worker-done|重复负责人/.test(message) && /(已收拢|移出|归档|完成历史)/.test(message)
  && /worker-active.{0,30}(保持|未改动)/s.test(message) && /worker-retain.{0,30}(仍留|仍保留|保持|未改动)/s.test(message));
check('WFA-02 PM creates no Worker or Action Skill detour', !/create_thread|fork_thread/.test(commands) && ['task-design', 'task-dev', 'task-test', 'task-ops'].every((name) => !commands.includes(name)));
check('WFA-02 shared Git content remains clean', execFileSync('git', ['status', '--short'], { cwd: caseRoot, encoding: 'utf8' }).trim() === '');

const failures = results.filter((result) => !result.passed);
const summary = { checkedAt: new Date().toISOString(), runtimeRoot, assertions: results.length, passed: results.length - failures.length, failed: failures.length, results, failures };
writeFileSync(join(evidenceRoot, 'wfa-node4-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) process.exitCode = 1;
