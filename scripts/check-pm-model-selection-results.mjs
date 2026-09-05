import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');

const output = readFileSync(join(runtimeRoot, 'evidence', 'P13-last-message.txt'), 'utf8');
const events = readFileSync(join(runtimeRoot, 'evidence', 'P13-events.jsonl'), 'utf8');
const fixture = join(runtimeRoot, 'cases', 'P13-model-selection');
const commands = events.split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try {
    const event = JSON.parse(line);
    return event.type === 'item.started' && event.item?.type === 'command_execution' ? [event.item.command] : [];
  } catch {
    return [];
  }
}).join('\n');

const resolve = (projectId, taskKind) => JSON.parse(execFileSync(process.execPath, [
  join(fixture, 'scripts', 'beyond-control.mjs'),
  'worker-policy', '--action', 'resolve', '--project-id', projectId, '--task-kind', taskKind,
], { cwd: fixture, encoding: 'utf8' }));
const approved = {
  A: resolve('local-aaaaaaaaaaaa', 'ordinary-engineering'),
  B: resolve('local-aaaaaaaaaaaa', 'ordinary-engineering'),
  C: resolve('local-aaaaaaaaaaaa', 'design-analysis'),
  D: resolve('local-aaaaaaaaaaaa', 'bulk-structured'),
  E: resolve('local-aaaaaaaaaaaa', 'ordinary-engineering'),
};
const unapproved = resolve('local-bbbbbbbbbbbb', 'design-analysis');

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
const taskD = taskSection('D', 'E');
const taskE = taskSection('E', null);
const taskEReasoning = output.split(/\r?\n/)
  .filter((line) => /^\s*[-*]\s*E\s*(?:只是|是|中|[：:])/.test(line))
  .join('\n') || taskE;

const results = [];
const check = (name, passed) => results.push({ name, passed: Boolean(passed) });
check('M-01 PM actually invokes the fixed resolver for all distinct policy decisions', /--action[= ]+resolve/.test(commands)
  && /local-aaaaaaaaaaaa[^\r\n]*ordinary-engineering/.test(commands)
  && /local-aaaaaaaaaaaa[^\r\n]*bulk-structured/.test(commands)
  && /local-aaaaaaaaaaaa[^\r\n]*design-analysis/.test(commands)
  && /local-bbbbbbbbbbbb[^\r\n]*design-analysis/.test(commands));
check('M-02 ordinary development uses the approved Terra high mapping', approved.A.createParameters.model === 'gpt-5.6-terra' && approved.A.createParameters.thinking === 'high' && /Terra/i.test(taskA) && /高|high/i.test(taskA));
check('M-03 difficult diagnosis receives Sol with high reasoning', approved.C.createParameters.model === 'gpt-5.6-sol' && approved.C.createParameters.thinking === 'high' && /Sol/i.test(taskC) && /高|high/i.test(taskC) && !/超高|极高|xhigh/i.test(taskC));
check('M-04 high-volume clear audit uses Luna high reasoning', approved.D.createParameters.model === 'gpt-5.6-luna' && approved.D.createParameters.thinking === 'high' && /Luna/i.test(taskD) && /高|high/i.test(taskD));
check(
  'M-05 runtime settings stay outside the business packet',
  /(?:不(?:会)?进入业务任务包的内容|以下内容不进入业务任务包|业务任务包中不写入)[\s\S]{0,240}(?:model|模型)[\s\S]{0,80}(?:thinking|推理)|(?:model|模型)[\s\S]{0,80}(?:thinking|推理)[\s\S]{0,240}不(?:会)?进入业务任务包/s.test(output),
);
check(
  'M-06 model choice is limited to new Worker creation',
  /(?:创建|新建).{0,40}(?:新的)?(?:正式)?\s*Worker|Worker.{0,40}(?:创建参数|新建时)/is.test(output),
);
check('M-07 PM does not load Action Skills', ['task-design', 'task-dev', 'task-test', 'task-ops'].every((name) => !commands.includes(name)));
check('M-08 fixture remains read-only', execFileSync('git', ['status', '--short'], { cwd: fixture, encoding: 'utf8' }).trim() === '');
check('M-09 Worker model policy does not change the current PM model', /当前\s*PM.{0,40}(?:不改变|不能改变|不会改变|无权改变)|(?:不|不会|不能|不得|无权).{0,24}(?:切换或)?改变.{0,24}当前\s*PM/s.test(output));
check('M-10 unapproved project keeps platform defaults', unapproved.decision === 'keep-platform-default' && Object.keys(unapproved.createParameters).length === 0 && /local-bbbbbbbbbbbb|未批准/.test(output));
check('M-11 fixed resolver matches the actual task creation field names', ['model', 'thinking'].every((name) => Object.hasOwn(approved.C.createParameters, name)));
check('M-12 bounded local account work stays on Terra high', approved.E.createParameters.model === 'gpt-5.6-terra' && approved.E.createParameters.thinking === 'high' && /Terra/i.test(taskE) && /高|high/i.test(taskE));
check('M-13 credential checkpoints and normal VIP do not alone escalate the task',
  /(?:验证码|密码|敏感信息)/.test(output)
  && /VIP/i.test(output)
  && /(?:VIP.{0,40}(?:不构成|不属于).{0,20}(?:额外)?高风险|VIP.{0,40}(?:正常|默认).{0,40}(?:不形成|不产生).{0,24}(?:额外)?(?:授权)?检查点|(?:不会|不能|并非|不).{0,20}(?:把它)?升级.{0,12}(?:复杂高风险)?)/s.test(output));

const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
if (failed.length > 0) process.exitCode = 1;
