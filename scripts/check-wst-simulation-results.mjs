import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) {
  throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');
}

const evidenceRoot = join(runtimeRoot, 'evidence');
const casesRoot = join(runtimeRoot, 'cases');
const results = [];

function read(path) {
  return readFileSync(path, 'utf8');
}

function check(name, condition, detail = '') {
  results.push({ name, passed: Boolean(condition), detail });
}

function commands(caseName) {
  return read(join(evidenceRoot, `${caseName}-events.jsonl`))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === 'item.started' && event.item?.type === 'command_execution'
          ? [event.item.command]
          : [];
      } catch {
        return [];
      }
    });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const sim01Root = join(casesRoot, 'WST-SIM-01-fail-closed-continuation');
const sim01State = JSON.parse(read(join(sim01Root, 'runtime', 'run-state.json')));
const sim01Output = read(join(evidenceRoot, 'WST-SIM-01-last-message.txt'));
const sim01Commands = commands('WST-SIM-01').join('\n').replaceAll('\\', '/');
const sim01SourceDiff = git(sim01Root, 'show', '--format=', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll('\\', '/'));

check('SIM-01 repaired the exact local guard implementation', sim01SourceDiff.includes('src/routeGuard.js'));
check('SIM-01 completed all remaining routes through the runner', sim01State.remaining === 0 && sim01State.runner === 'completed' && sim01State.checkpoint === 'route-263');
check('SIM-01 preserved exact identity and parent-shell rejection tests', execFileSync(process.execPath, ['--test', 'test/routeGuard.test.js'], { cwd: sim01Root, encoding: 'utf8' }).includes('pass'));
check('SIM-01 used the existing resume entry instead of editing state only', sim01Commands.includes('resume.mjs') && existsSync(join(sim01Root, 'runtime', 'audit.log')));
check('SIM-01 stayed in the original Worker without PM round-trip', !sim01Commands.includes('identity-pm') && !/已暂停|等待.*授权|请.*授权|需要.*批准/.test(sim01Output));
check('SIM-01 did not create a worktree', git(sim01Root, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length === 1);

const sim02Root = join(casesRoot, 'WST-SIM-02-acceptance-correction');
const sim02Workbench = read(join(sim02Root, 'docs', 'AI编程协同机制', '当前工作台.md'));
const sim02Output = read(join(evidenceRoot, 'WST-SIM-02-last-message.txt'));
const sim02Commands = commands('WST-SIM-02').join('\n');
const sim02Changed = git(sim02Root, '-c', 'core.quotepath=false', 'diff', '--name-only').split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll('\\', '/'));
const sim02WorkerIds = [...`${sim02Workbench}\n${sim02Output}`.matchAll(/worker-site-[a-z0-9-]+/g)].map((match) => match[0]);

check('SIM-02 changed only the PM workbench', sim02Changed.join('|') === 'docs/AI编程协同机制/当前工作台.md', sim02Changed.join('|'));
check('SIM-02 kept the already-valid station A completed', /来源站甲分类采集与质量审查\s*\|\s*worker-site-a\s*\|\s*已完成/.test(sim02Workbench));
check('SIM-02 reopened station B on its original Worker', /来源站乙分类采集与质量审查\s*\|\s*worker-site-b\s*\|\s*进行中/.test(sim02Workbench));
check('SIM-02 reopened station C on its original Worker', /来源站丙分类采集与质量审查\s*\|\s*worker-site-c\s*\|\s*进行中/.test(sim02Workbench));
check('SIM-02 recorded the corrected per-category acceptance', /每个分类.{0,12}50|分类各50|各分类.{0,8}50/.test(sim02Workbench));
check('SIM-02 removed the stale all-completed project snapshot', !/完成三个来源站的分类采集与质量审查\s*\|\s*已完成/.test(sim02Workbench));
check('SIM-02 did not create a replacement Worker', sim02WorkerIds.every((id) => ['worker-site-a', 'worker-site-b', 'worker-site-c'].includes(id)) && /worker-site-b/.test(sim02Output) && /worker-site-c/.test(sim02Output));
check('SIM-02 did not load Action Skills', ['task-design', 'task-dev', 'task-test', 'task-ops'].every((name) => !sim02Commands.includes(name)));
check('SIM-02 did not ask the boss to reconfirm the explicit correction', /(无需|不需要|不必|不用).{0,12}(确认|批准)|无需再次/.test(sim02Output));

const failures = results.filter((result) => !result.passed);
const summary = {
  checkedAt: new Date().toISOString(),
  runtimeRoot,
  assertions: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  results,
  failures,
};
writeFileSync(join(evidenceRoot, 'wst-simulation-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

if (failures.length > 0) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
console.log(`WST simulations passed: ${summary.passed}/${summary.assertions}`);
