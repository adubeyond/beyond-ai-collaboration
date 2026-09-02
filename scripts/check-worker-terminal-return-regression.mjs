import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const sourceCodexHome = process.env.BEYOND_SOURCE_CODEX_HOME;
const summaryPath = process.env.BEYOND_WORKER_TERMINAL_SUMMARY;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error('BEYOND_ISOLATED_ROOT must be absolute');
if (!sourceCodexHome || !isAbsolute(sourceCodexHome)) throw new Error('BEYOND_SOURCE_CODEX_HOME must be absolute');

const evidenceRoot = join(runtimeRoot, 'evidence');
const skills = ['identity-pm', 'identity-worker', 'task-design', 'task-dev', 'task-test', 'task-ops'];
const checks = [];
const failures = [];

function check(name, condition, detail = '') {
  checks.push({ name, passed: Boolean(condition), detail });
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  }).sort((left, right) => left.localeCompare(right, 'en'));
}

function manifest(root) {
  return filesUnder(root).map((path) => ({
    path: relative(root, path).replaceAll('\\', '/'),
    bytes: statSync(path).size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }));
}

function skillManifest(root) {
  return skills.flatMap((skill) => manifest(join(root, skill)).map((entry) => ({ skill, ...entry })));
}

function text(path) {
  return readFileSync(path, 'utf8');
}

function final(caseName) {
  return text(join(evidenceRoot, `${caseName}-last-message.txt`)).trim();
}

function commands(caseName) {
  return text(join(evidenceRoot, `${caseName}-events.jsonl`))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === 'item.started' && event.item?.type === 'command_execution'
          ? [String(event.item.command ?? '').replace(/\\+/g, '/')]
          : [];
      } catch {
        return [];
      }
    });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const candidateSkills = skillManifest(join(repositoryRoot, '模板交付包', 'skills'));
const isolatedSkills = skillManifest(join(runtimeRoot, 'codex-home', 'skills'));
const globalBefore = JSON.parse(text(join(evidenceRoot, 'global-skills-before.json')));
const globalAfter = skillManifest(join(sourceCodexHome, 'skills'));
check('candidate Skills equal isolated installation', JSON.stringify(candidateSkills) === JSON.stringify(isolatedSkills));
check('user-level Skills remain unchanged', JSON.stringify(globalBefore) === JSON.stringify(globalAfter));

const selectedCases = ['D01', 'R06', 'P07', 'P25', 'P17'];
const timings = JSON.parse(text(join(evidenceRoot, 'run-timings.json')));
for (const caseName of selectedCases) {
  const records = timings.filter((entry) => entry.case === caseName);
  check(`${caseName} driver exits once with code 0`, records.length === 1 && records[0].exitCode === 0, JSON.stringify(records));
}

const d01CommandList = commands('D01');
const d01Commands = d01CommandList.join('\n');
const d01Identity = d01Commands.indexOf('/skills/identity-worker/SKILL.md');
const d01Design = d01Commands.indexOf('/skills/task-design/SKILL.md');
check(
  'D01 reads identity-worker in the first tool call',
  d01CommandList.length > 0 && d01CommandList[0].includes('/skills/identity-worker/SKILL.md'),
  JSON.stringify(d01CommandList.slice(0, 2)),
);
check(
  'D01 loads task-design in the second tool call',
  d01Identity >= 0 && d01Design > d01Identity && d01CommandList[1]?.includes('/skills/task-design/SKILL.md'),
  JSON.stringify({ identityIndex: d01Identity, actionIndex: d01Design }),
);
check('D01 design-only result is completed', /^已完成(?:[，。：:、\s]|$)/.test(final('D01')));
const d01Root = join(runtimeRoot, 'cases', 'D01-design-correction');
check('D01 changes only the active design document', git(d01Root, 'diff', '--name-only').replaceAll('\\', '/') === 'docs/design/jilin-collector.md');

const r06CommandList = commands('R06');
const r06Commands = r06CommandList.join('\n');
const r06Identity = r06Commands.indexOf('/skills/identity-worker/SKILL.md');
const r06Ops = r06Commands.indexOf('/skills/task-ops/SKILL.md');
check(
  'R06 reads identity-worker in the first tool call',
  r06CommandList.length > 0 && r06CommandList[0].includes('/skills/identity-worker/SKILL.md'),
  JSON.stringify(r06CommandList.slice(0, 2)),
);
check(
  'R06 loads task-ops in the second tool call',
  r06Identity >= 0 && r06Ops > r06Identity && r06CommandList[1]?.includes('/skills/task-ops/SKILL.md'),
  JSON.stringify({ identityIndex: r06Identity, actionIndex: r06Ops }),
);
check('R06 true external gap is paused', /^已暂停(?:[，。：:、\s]|$)/.test(final('R06')));

const p07 = final('P07');
check(
  'P07 keeps in-scope design review nonterminal',
  /设计[^。\n]{0,80}确认/.test(p07)
    && /任务仍为[“"]?进行中|检查点[\s\S]{0,160}不验收(?:为)?完成|检查点[^。\n]{0,80}(?:不是|不属于|不能|不得|不标记|不算)[^。\n]{0,32}(?:任务完成|已完成|完成终态|完成|终态)|任务仍由同一个\s*Worker\s*控制[^。\n]{0,32}不标记完成|设计后等待[^。\n]{0,24}确认[^。\n]{0,32}不验收(?:为)?完成/.test(p07),
);
check('P07 resumes the same Worker after confirmation', /同一个 Worker|同一.*Worker|原.*Worker/s.test(p07));
check(
  'P07 preserves identity-first sequencing without PM preselection',
  /初始提示[^。\n]{0,48}\$identity-worker/.test(p07)
    && /(?:先|首个|首次|第一(?:次)?工具调用必须|任何(?:其他)?工具或业务动作前|该\s*Worker\s*首次).{0,40}(?:实际)?(?:完整)?(?:加载|读取).{0,32}(?:identity-worker|Worker\s*身份)[\s\S]{0,160}(?:再|然后|之后|后，?再|第二个|自行选择).{0,40}(?:Action|方法)/is.test(p07)
    && /PM\s*不[^。\n]{0,16}(?:预选|点名)/.test(p07),
);

const p25 = final('P25');
check('P25 task packet contains the fixed identity-read guard', /(?:任何其他工具或业务动作前[\s\S]{0,80}文件读取工具|首(?:个|次)工具调用|第一(?:次)?工具调用必须)[\s\S]{0,80}identity-worker\/SKILL\.md[\s\S]{0,120}(?:未读取不得继续|第二(?:个|次).{0,48}Action Skill)/.test(p25));
check(
  'P25 design-only review is a completed terminal',
  /(?:设计[^。\n]{0,100}(?:交付|满足验收)|交付[^。\n]{0,40}设计)[^。\n]{0,80}[`“]?已完成[`”]?[^。\n]{0,40}终态/.test(p25),
);
check('P25 rejects the nonterminal checkpoint label', /(?:不是|不应登记为)[^。\n]*进行中[^。\n]*检查点|(?:不应|不能)写成进行中检查点|不应把[^。\n]*(?:评审确认|设计后评审)[^。\n]*写成任务检查点/.test(p25));
check('P25 retains receipt and native callback', /回执/.test(p25) && /原生回调/.test(p25));
check(
  'P25 requires new implementation authorization',
  /(?:实现|实施)[\s\S]{0,80}(?:新的?明确授权|新增明确授权|另行(?:明确)?(?:授权|批准)|重新授权|新业务结果)/.test(p25)
    || /明确授权[\s\S]{0,80}(?:实现|实施)/.test(p25)
    || /新的?明确(?:实现|实施)授权/.test(p25),
);

const p17 = final('P17');
check(
  'P17 freezes one final before terminal delivery',
  /(?:冻结一份完整、自包含的 final|一份完整、自包含的冻结 final|形成一份?完整、自包含的终态正文[\s\S]{0,180}(?:立即冻结|视为冻结)|生成一份完整、自包含的\s*final[\s\S]{0,200}冻结(?:正文|\s*final)|形成完整、自包含的\s*final[\s\S]{0,240}冻结(?:正文|\s*final))/.test(p17),
);
check(
  'P17 enqueues the frozen final once',
  /(?:执行|调用)一次 `worker-result\.enqueue`|(?:执行|调用)(?:现有\s*runtime\s*的\s*)?`worker-result\.enqueue`[\s\S]{0,120}(?:这份|冻结)\s*final|执行一次[\s\S]{0,120}runtime\s*--request[\s\S]{0,160}请求动作为`?worker-result\.enqueue`?/s.test(p17)
    && /不循环重试/.test(p17),
);
check(
  'P17 sends one native wake as the final tool',
  /只向唯一来源(?:发送)?(?:一次)?轻量唤醒一次|只向唯一来源发送一次轻量唤醒/.test(p17)
    || /(?:向唯一来源)?发送一次轻量唤醒.{0,40}最后一次工具调用/.test(p17)
    || /轻量唤醒.{0,20}只调用一次/.test(p17) && /最后一次工具调用/.test(p17)
    || /只向\s*`?source_thread_id`?\s*发送一次轻量唤醒/.test(p17) && /该唤醒必须是本轮最后一次工具调用/.test(p17),
);
check(
  'P17 covers normal and abnormal terminal paths',
  /正常完成(?:，|、)(?:以及)?(?:业务)?工具启动失败、缺失输出、权限(?:不足|失败|错误)?(?:和|或)环境异常[^。\n]*(?:同一(?:个|套)?收口|走同一收口)/.test(p17),
);
check('P17 forbids retry and retarget', /不循环重试/.test(p17) && /不重试[^。\n]{0,24}不改投(?:其他 ID)?/.test(p17));

const summary = {
  schemaVersion: 1,
  candidateRoot: join(repositoryRoot, '模板交付包'),
  runtimeRoot,
  selectedCases,
  checks: checks.length,
  passed: checks.filter((item) => item.passed).length,
  failed: failures.length,
  failures,
  results: checks,
};
if (summaryPath) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) process.exitCode = 1;
