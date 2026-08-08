import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');

const output = readFileSync(join(runtimeRoot, 'evidence', 'P13-last-message.txt'), 'utf8');
const events = readFileSync(join(runtimeRoot, 'evidence', 'P13-events.jsonl'), 'utf8');
const commands = events.split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try {
    const event = JSON.parse(line);
    return event.type === 'item.started' && event.item?.type === 'command_execution' ? [event.item.command] : [];
  } catch {
    return [];
  }
}).join('\n');

const taskSection = (label, nextLabel) => {
  const next = nextLabel
    ? `(?=\\n(?:#{1,6}\\s*)?(?:\\*\\*)?${nextLabel}(?:\\*\\*)?\\s*(?:[：:]\\s*)?\\r?\\n)`
    : '(?=\\n(?:统一|总体|原则)|$)';
  const heading = output.match(new RegExp(`(?:^|\\n)(?:#{1,6}\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*(?:[：:]\\s*)?\\r?\\n([\\s\\S]*?)${next}`, 'i'))?.[1];
  if (heading) return heading;
  return output.split(/\r?\n/).find((line) => new RegExp(`(?:^|\\|)\\s*${label}(?:\\s|：|:)`).test(line)) ?? '';
};
const taskA = taskSection('A', 'B');
const taskB = taskSection('B', 'C');
const taskC = taskSection('C', 'D');
const taskD = taskSection('D', null);

const results = [];
const check = (name, passed) => results.push({ name, passed: Boolean(passed) });
check('M-01 PM applies the confirmed model policy', /Terra/i.test(taskA) && /Terra/i.test(taskB) && /Sol/i.test(taskC) && /Luna/i.test(taskD));
check('M-02 ordinary development uses the approved Terra high mapping', /Terra/i.test(taskA) && /高|high/i.test(taskA));
check('M-03 complex high-risk task receives Sol with strong reasoning', /Sol/i.test(taskC) && /高|超高|xhigh/i.test(taskC));
check('M-04 high-volume clear audit uses Luna high reasoning', /Luna/i.test(taskD) && /高|high/i.test(taskD));
check(
  'M-05 runtime settings stay outside the business packet',
  /模型(?:能力)?(?:与|和)推理(?:强度|档位).{0,40}(?:不属于|不写进)(?:业务)?任务包|(?:业务)?任务包(?:里)?.{0,40}不.{0,20}(?:模型|推理)|(?:不应|不该|不得|不要|不).{0,12}写(?:入|进)(?:业务)?任务包[\s\S]{0,120}(?:Luna|Terra|Sol|模型|推理)/s.test(output),
);
check(
  'M-06 model choice is limited to new Worker creation',
  /(?:创建|新建).{0,40}(?:新的)?(?:正式)?\s*Worker|Worker.{0,40}(?:创建参数|新建时)/is.test(output),
);
check('M-07 PM does not load Action Skills', ['task-design', 'task-dev', 'task-test', 'task-ops'].every((name) => !commands.includes(name)));
check('M-08 fixture remains read-only', execFileSync('git', ['status', '--short'], { cwd: join(runtimeRoot, 'cases', 'P13-model-selection'), encoding: 'utf8' }).trim() === '');
check('M-09 Worker model policy does not change the current PM model', /当前\s*PM.{0,40}(?:不改变|不能改变|不会改变|无权改变)|(?:不改变|不能改变|不会改变|无权改变).{0,40}当前\s*PM/s.test(output));

const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
if (failed.length > 0) process.exitCode = 1;
