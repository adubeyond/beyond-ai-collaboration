import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const caseRuntimeRoots = JSON.parse(process.env.BEYOND_CASE_RUNTIME_ROOTS ?? '{}');
if (!runtimeRoot || !isAbsolute(runtimeRoot)) {
  throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');
}

const evidenceRoot = join(runtimeRoot, 'evidence');
const casesRoot = join(runtimeRoot, 'cases');
const results = [];

function runtimeForCase(caseName) {
  return caseRuntimeRoots[caseName] ?? runtimeRoot;
}

function evidenceFile(caseName, suffix = 'last-message.txt') {
  return join(runtimeForCase(caseName), 'evidence', `${caseName}-${suffix}`);
}

function caseDirectory(caseName, directory) {
  return join(runtimeForCase(caseName), 'cases', directory);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function check(name, condition, detail = '') {
  results.push({ name, passed: Boolean(condition), detail });
}

function commands(caseName) {
  return read(evidenceFile(caseName, 'events.jsonl'))
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

function assistantMessages(caseName) {
  return read(evidenceFile(caseName, 'events.jsonl'))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === 'item.completed' && event.item?.type === 'agent_message'
          ? [event.item.text ?? '']
          : [];
      } catch {
        return [];
      }
    });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const sim01Root = caseDirectory('WST-SIM-01', 'WST-SIM-01-fail-closed-continuation');
const sim01State = JSON.parse(read(join(sim01Root, 'runtime', 'run-state.json')));
const sim01Output = read(evidenceFile('WST-SIM-01'));
const sim01Commands = commands('WST-SIM-01').join('\n').replaceAll('\\', '/');
const sim01SourceDiff = git(sim01Root, 'show', '--format=', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll('\\', '/'));

check('SIM-01 repaired the exact local guard implementation', sim01SourceDiff.includes('src/routeGuard.js'));
check('SIM-01 completed all remaining routes through the runner', sim01State.remaining === 0 && sim01State.runner === 'completed' && sim01State.checkpoint === 'route-263');
check('SIM-01 preserved exact identity and parent-shell rejection tests', execFileSync(process.execPath, ['--test', 'test/routeGuard.test.js'], { cwd: sim01Root, encoding: 'utf8' }).includes('pass'));
check('SIM-01 used the existing resume entry instead of editing state only', sim01Commands.includes('resume.mjs') && existsSync(join(sim01Root, 'runtime', 'audit.log')));
check('SIM-01 stayed in the original Worker without PM round-trip', !sim01Commands.includes('identity-pm') && !/已暂停|等待.*授权|请.*授权|需要.*批准/.test(sim01Output));
check('SIM-01 did not create a worktree', git(sim01Root, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length === 1);

const sim02Root = caseDirectory('WST-SIM-02', 'WST-SIM-02-acceptance-correction');
const sim02Workbench = read(join(sim02Root, 'docs', 'AI编程协同机制', '当前工作台.md'));
const sim02Output = read(evidenceFile('WST-SIM-02'));
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

const packetRoot = caseDirectory('WST-AB-PACKET', 'WST-AB-PACKET-review');
const packetOutput = read(evidenceFile('WST-AB-PACKET'));
const packetCommands = commands('WST-AB-PACKET').join('\n');
const packetFacts = ['$identity-worker', '50', '全部异常', '站甲', '站乙', '站丙', '人工复核', 'evidence/three-site-quality-review/'];
check('PACKET keeps every required business fact', packetFacts.every((fact) => packetOutput.includes(fact)) && /10\s*条/.test(packetOutput) && /原有三个站点\s*Worker/.test(packetOutput));
check('PACKET remains a compact business contract', [...packetOutput].length < 1200, 'chars=' + [...packetOutput].length);
check('PACKET starts only Worker identity', !/\$task-(design|dev|test|ops)/.test(packetOutput));
check('PACKET PM does not load Action Skills', !/task-(design|dev|test|ops)/.test(packetCommands));
check('PACKET remains read-only', git(packetRoot, 'status', '--short') === '');

const commsRoot = caseDirectory('WST-PM-COMMS', 'WST-PM-COMMS-status');
const commsOutput = read(evidenceFile('WST-PM-COMMS'));
const commsCommands = commands('WST-PM-COMMS').join('\n');
const commsChanged = git(commsRoot, '-c', 'core.quotepath=false', 'diff', '--name-only').split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll('\\', '/'));
check(
  'COMMS final remains self-contained',
  /(?:来源)?站乙|worker-site-b/i.test(commsOutput)
    && ['50/50', '终止公告'].every((fact) => commsOutput.includes(fact))
    && /进行中|继续处理|继续终止公告/.test(commsOutput),
);
check('COMMS changes only the workbench', commsChanged.join('|') === 'docs/AI编程协同机制/当前工作台.md', commsChanged.join('|'));
check('COMMS PM does not load Action Skills', !/task-(design|dev|test|ops)/.test(commsCommands));

const callbackOutput = read(evidenceFile('WST-WORKER-CALLBACK'));
const callbackRequired = ['已完成', '不通过', 'evidence/quality-review.md', '原站 Worker', '同一冻结集合'];
const callbackDetails = ['evidence/full-check.json', '集合 SHA-256', '136 项', '9 项', '197 项', '未创建 worktree', '未访问网络'];
check('CALLBACK preserves control facts and primary finding', callbackRequired.every((fact) => callbackOutput.includes(fact)) && (callbackOutput.includes('50/50') || /50\s*条[^。\n]*全部/.test(callbackOutput)) && (/section_name/.test(callbackOutput) || /标段名称.{0,20}标段编号/.test(callbackOutput)));
check('CALLBACK moves engineering detail to the evidence entry', callbackDetails.every((detail) => !callbackOutput.includes(detail)));
check('CALLBACK remains compact', [...callbackOutput].length < 500, 'chars=' + [...callbackOutput].length);

const languageForbidden = ['node --test', 'exitCode', '4f82c1a0b7d9e2f3a11c', 'codex/fix-company-manager-dedup', 'companyManagers', 'managerCount', 'managerId', 'src/companyRelations.js', '7 条断言'];
for (const caseName of ['WST-USER-LANGUAGE-DIRECT', 'WST-USER-LANGUAGE-WORKER']) {
  const output = read(evidenceFile(caseName));
  check(caseName + ' preserves the business result and current usability', ['老板', '负责人', '测试', '页面'].every((fact) => output.includes(fact)) && /不再重复|重复负责人|重复显示/.test(output) && /尚未|还没有|不能确认可用|不能按线上已可用|还不能按/.test(output));
  check(caseName + ' avoids unnecessary technical detail', languageForbidden.every((detail) => !output.includes(detail)));
}

const failures = results.filter((result) => !result.passed);
const summary = {
  checkedAt: new Date().toISOString(),
  runtimeRoot,
  caseRuntimeRoots,
  assertions: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  communicationObservations: {
    'WST-PM-COMMS': assistantMessages('WST-PM-COMMS').length,
  },
  results,
  failures,
};
writeFileSync(join(evidenceRoot, 'wst-simulation-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

if (failures.length > 0) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
console.log(`WST simulations passed: ${summary.passed}/${summary.assertions}`);
