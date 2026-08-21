import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) {
  throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');
}

const casesRoot = join(runtimeRoot, 'cases');
const evidenceRoot = join(runtimeRoot, 'evidence');
const cases = [
  ['WST-PM-Q1', 'WST-PM-Q1-design'],
  ['WST-PM-Q2', 'WST-PM-Q2-develop'],
  ['WST-PM-Q3', 'WST-PM-Q3-release'],
  ['WST-PM-Q4', 'WST-PM-Q4-bugfix'],
];

function read(path) {
  return readFileSync(path, 'utf8');
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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

const observations = cases.map(([caseName, directory]) => {
  const output = read(join(evidenceRoot, `${caseName}-last-message.txt`)).trim();
  const commandText = commands(caseName).join('\n');
  return {
    case: caseName,
    output,
    chars: output.length,
    clean: git(join(casesRoot, directory), 'status', '--short') === '',
    loadedActionSkill: ['task-design', 'task-dev', 'task-test', 'task-ops'].some((name) => commandText.includes(name)),
    claimedCompletion: /(?:^|[。；\n])\s*(?:本任务|该任务|功能|设计|开发|修复|发布)?\s*(?:已完成|已经(?:发布|修复|开发)|设计已完成)/.test(output),
    asksQuestion: /[？?]|请告诉我|请给我|需要你提供|先确认/.test(output),
  };
});

const failures = observations.flatMap((item) => [
  ...(!item.output ? [`${item.case}: empty response`] : []),
  ...(!item.clean ? [`${item.case}: changed fixture files`] : []),
  ...(item.loadedActionSkill ? [`${item.case}: PM loaded an Action Skill`] : []),
  ...(item.claimedCompletion ? [`${item.case}: falsely claimed business completion`] : []),
  ...((item.output.match(/[？?]/g) ?? []).length > 1 ? [`${item.case}: asked more than one first-round question`] : []),
  ...(item.case === 'WST-PM-Q3' && /发布什么.{0,30}(?:环境|服务器)|(?:环境|服务器).{0,30}发布什么/s.test(item.output)
    ? [`${item.case}: bundled target environment into the first object question`] : []),
  ...(item.case === 'WST-PM-Q4' && ['报错', '复现', '日志', '页面'].filter((term) => item.output.includes(term)).length > 1
    ? [`${item.case}: bundled investigation details into the first object question`] : []),
]);

const summary = {
  checkedAt: new Date().toISOString(),
  runtimeRoot,
  observations,
  failures,
};
writeFileSync(join(evidenceRoot, 'pm-literal-prompts-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

if (failures.length > 0) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
console.log(`PM literal prompts completed: ${observations.length}; invariant failures: 0`);
