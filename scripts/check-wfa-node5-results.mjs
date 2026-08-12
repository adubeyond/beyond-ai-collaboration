import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');

const evidenceRoot = join(runtimeRoot, 'evidence');
const casesRoot = join(runtimeRoot, 'cases');
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, passed: Boolean(condition), detail });
}

function text(path) {
  return readFileSync(path, 'utf8');
}

function output(caseName) {
  return text(join(evidenceRoot, `${caseName}-last-message.txt`));
}

function events(caseName) {
  return text(join(evidenceRoot, `${caseName}-events.jsonl`))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function commands(caseName) {
  return events(caseName)
    .filter((event) => event.type === 'item.started' && event.item?.type === 'command_execution')
    .map((event) => event.item.command);
}

function commandResults(caseName) {
  return events(caseName)
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'command_execution')
    .map((event) => ({
      command: event.item.command,
      exitCode: event.item.exit_code,
      output: event.item.aggregated_output ?? '',
    }));
}

function effectiveExitCode(result) {
  const reported = [...result.output.matchAll(/(?:^|\r?\n)EXIT:(\d+)(?=\r?$)/gm)].at(-1)?.[1];
  return reported === undefined ? result.exitCode : Number(reported);
}

function gitClean(path) {
  return execFileSync('git', ['status', '--short'], { cwd: path, encoding: 'utf8' }).trim() === '';
}

const timings = JSON.parse(text(join(evidenceRoot, 'run-timings.json')));
const expectedCases = ['P13', 'WFA10', 'WFA12', 'WFA06', 'WFA03', 'WFA02', 'WFA08', 'WFA09', 'P18', 'P19', 'P20', 'P21', 'R12', 'R13', 'O05', 'WST-SIM-01', 'WST-USER-LANGUAGE-DIRECT', 'WST-USER-LANGUAGE-WORKER'];
check('Node5 runs all selected cases exactly once', expectedCases.every((caseName) => timings.filter((item) => item.case === caseName).length === 1));
check('Node5 selected cases all exit successfully', timings.every((item) => item.exitCode === 0));

const p18Output = output('P18');
const p18Commands = commands('P18').join('\n');
const p18 = join(casesRoot, 'P18-team-list');
check('P18 reads the team rule', p18Commands.includes('团队任务与协同.md'));
check('P18 lists only the current account through the control script', p18Commands.includes('beyond-control.mjs') && /\blist\b/.test(p18Commands) && /--git-account\s+['"]?current-user/i.test(p18Commands) && !/\blist\s+--all\b/.test(p18Commands));
check('P18 reports both current-account records', p18Output.includes('登录修复') && p18Output.includes('异常样本'));
check('P18 creates no Worker or Action Skill detour', !/create_thread|fork_thread/.test(p18Commands) && ['task-design', 'task-dev', 'task-test', 'task-ops'].every((name) => !p18Commands.includes(name)));
check('P18 remains read-only', gitClean(p18));

const p19Business = join(casesRoot, 'P19-team-from-business', 'business');
const p19Control = join(p19Business, 'beyond-control');
const p19Output = output('P19');
const p19Commands = commands('P19').join('\n').replace(/[\\/]+/g, '/');
const p19Results = commandResults('P19');
check('P19 reads the mapped project-local control rule', /\.\/beyond-control\/docs\/AI编程协同机制\/团队任务与协同\.md/.test(p19Commands));
check('P19 invokes the mapped control script successfully', p19Results.some((result) => /beyond-control\.mjs.+\blist\b.+--git-account\s+['"]?current-user/i.test(result.command) && effectiveExitCode(result) === 0 && result.output.includes('task-business')));
check('P19 does not depend on a business-project script copy', !existsSync(join(p19Business, 'scripts', 'beyond-control.mjs')));
check('P19 reports the mapped team task', p19Output.includes('从业务项目读取团队任务'));
check('P19 remains read-only in both repositories', gitClean(p19Business) && gitClean(p19Control));

for (const [caseName, workspace, projectName] of [
  ['P20', 'P20-new-init-cold', 'new-project'],
  ['P21', 'P21-existing-init-cold', 'existing-project'],
]) {
  const project = join(casesRoot, workspace, projectName);
  const control = join(project, 'beyond-control');
  const caseOutput = output(caseName);
  const caseCommands = commands(caseName).join('\n').replace(/[\\/]+/g, '/');
  const caseResults = commandResults(caseName);
  check(`${caseName} inspects through the project-local control script`, caseResults.some((result) => /beyond-control\.mjs.+inspect-project/i.test(result.command) && effectiveExitCode(result) === 0));
  check(`${caseName} loads no Action Skill`, ['task-design', 'task-dev', 'task-test', 'task-ops'].every((name) => !caseCommands.includes(name)));
  check(`${caseName} remains read-only`, gitClean(project) && gitClean(control));
  check(`${caseName} asks only for a real initialization decision`, caseName === 'P20' ? /最低接入|融合|项目登记|确认|是否允许/.test(caseOutput) : /融合|确认/.test(caseOutput));
  check(`${caseName} preserves the user-path signal`, caseOutput.includes('老板'));
}

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

console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;
