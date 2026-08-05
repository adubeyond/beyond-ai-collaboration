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
check('M-02 simple task is not assigned the highest tier', /Terra/i.test(taskA) && (/推理强度[：:][^\n]*(?:低|中)/.test(taskA) || /Terra[^\n]*(?:低|中)/i.test(taskA)));
check('M-03 complex high-risk task receives Sol with strong reasoning', /Sol/i.test(taskC) && /高|超高|xhigh/i.test(taskC));
check('M-04 high-volume clear audit uses Luna high reasoning', /Luna/i.test(taskD) && /高/.test(taskD));
check('M-05 runtime settings stay outside the business packet', /模型(?:能力)?和推理强度.{0,40}不属于(?:业务)?任务包|(?:业务)?任务包.{0,40}不.{0,20}(?:模型|推理)/s.test(output));
check(
  'M-06 model choice stays a runtime setting beside scope and authorization',
  /模型.{0,80}运行配置|运行配置.{0,80}模型/s.test(output)
    && output.includes('范围')
    && output.includes('授权'),
);
check('M-07 PM does not load Action Skills', ['task-design', 'task-dev', 'task-test', 'task-ops'].every((name) => !commands.includes(name)));
check('M-08 fixture remains read-only', execFileSync('git', ['status', '--short'], { cwd: join(runtimeRoot, 'cases', 'P13-model-selection'), encoding: 'utf8' }).trim() === '');

const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
if (failed.length > 0) process.exitCode = 1;
