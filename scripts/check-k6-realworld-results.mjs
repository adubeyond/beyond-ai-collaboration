import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const caseRuntimeRoots = JSON.parse(process.env.BEYOND_CASE_RUNTIME_ROOTS ?? "{}");
if (!runtimeRoot || !isAbsolute(runtimeRoot)) {
  throw new Error("BEYOND_ISOLATED_ROOT must be an absolute path");
}

function runtimeForCase(caseName) {
  const root = caseRuntimeRoots[caseName] ?? runtimeRoot;
  if (!isAbsolute(root)) throw new Error(`case runtime root must be absolute: ${caseName}`);
  return root;
}

const definitions = [
  ["K6-N03", "K6-N03-approval", [/worker-site-a/i, /终止公告/, /(?:不生效|不包含|未授权|不是授权|不是批准|不等于批准|不启动|不执行)[\s\S]{0,100}(?:定时|周期)|(?:定时|周期).{0,100}(?:不生效|不包含|未授权|不是授权|不是批准|不等于批准|不启动|不执行|不是.{0,12}批准事项)/, /(?:不生效|不包含|未授权|不是授权|不是批准|不等于批准|不执行)[\s\S]{0,120}(?:生产发布|发布到生产|发布生产)|(?:生产发布|发布到生产|发布生产).{0,100}(?:不生效|不包含|未授权|不是授权|不是批准|不等于批准|不执行|不是.{0,12}批准事项)/]],
  ["K6-N05", "K6-N05-discussion", [/Gitea/i, /(CLI|命令)/i, /API/i, /(没有授权|(没有|未)(创建|派发|修改|启动)|不.{0,8}(创建|派发|修改|启动))/]],
  ["K6-N06", "K6-N06-answer-only", [/tea/i, /REST/i, /(?:不应|不应该|无需).{0,30}(?:浏览器|网页)|(?:浏览器|网页).{0,40}(?:补充|降级|少数|备用|不得已)/]],
  ["K6-N08", "K6-N08-outage", [/worker-site-a/i, /worker-release-b/i, /worker-doc-c/i, /不.{0,8}新建/]],
  ["K6-N09", "K6-N09-two-results", [/(2|两个).{0,8}(正式|业务).{0,8}结果/, /(只读|诊断)/, /(远端|Gitea|外部 Git).{0,20}(写入|推送|备份)/]],
  ["K6-N10", "K6-N10-temporary-model", [/当前 PM 对话|当前PM对话/i, /不.{0,12}工作台/, /不影响[\s\S]{0,140}AGENTS\.md|不应写入[\s\S]{0,80}AGENTS\.md/i, /(已经|既有|现有|已存在).{0,12}Worker/i, /失效/]],
  ["K6-W02", "K6-W02-stage-progress", [/进行中/, /worker-guangdong|当前.{0,12}唯一 Worker/i, /(?:不回|无需回|不需要回|不切给).{0,8}PM|PM.{0,20}(?:不裁决|无需裁决|不需要|无需)/i, /(?:不需要|无需).{0,12}(?:再次|重新)?授权|(?:再次|重新)授权.{0,12}(?:不需要|无需)/]],
  ["K6-W04", "K6-W04-background-job", [/(不.{0,8}跟着|不.{0,8}高频|不.{0,8}轮询)/, /(并行|准备).{0,20}(切流|验收|回滚|缓存)/, /PM.{0,30}(?:不接管|不逐步|不要求|不需要|无需|不应)/]],
  ["K6-W07", "K6-W07-completion-question", [/(没有真的完成|未完成|不能算完成)/, /不.{0,12}(登记|构成).{0,8}回源缺口|回源缺口.{0,12}(不登记|不存在)/, /worker-guangdong|广东.{0,24}(原|唯一).{0,8}Worker/i, /不.{0,8}新建/]],
  ["K6-G01", "K6-G01-git-parallel", [/并行/, /串行/, /(index|索引|HEAD|Git 元数据|Git元数据)/i, /(不需要|不用|无需).{0,8}停/]],
  ["K6-G03", "K6-G03-tool-priority", [/Git CLI/i, /(tea|REST)/i, /浏览器.{0,30}(降级|业务页面|验收|少数)/]],
  ["K6-B01", "K6-B01-user-path", [/(用户.{0,8}路径|复现.{0,8}路径|真实复现.{0,8}(整体操作|操作链)|完整业务操作)/, /(业务分类|详细分类)/, /(浏览器|端到端|真实验收)/, /(自动化?测试|自动测试|74\s*项).{0,40}(不能|未覆盖|不等于|不把|不能当)|不把.{0,20}(自动化?测试|自动测试).{0,20}(已验收|验收)|(?:真实)?验收.{0,12}不能只看.{0,20}(代码|单元测试|自动化?测试|74\s*项)/]],
];

function read(path) {
  if (!existsSync(path)) throw new Error(`missing evidence: ${path}`);
  return readFileSync(path, "utf8");
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commands(caseName) {
  return read(join(runtimeForCase(caseName), "evidence", `${caseName}-events.jsonl`))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === "item.started" && event.item?.type === "command_execution"
          ? [event.item.command]
          : [];
      } catch {
        return [];
      }
    });
}

const pmCases = new Set(["K6-N03", "K6-N05", "K6-N06", "K6-N08", "K6-N09", "K6-N10", "K6-W07", "K6-G01"]);
const observations = definitions.map(([caseName, directory, expectations]) => {
  const caseRoot = runtimeForCase(caseName);
  const output = read(join(caseRoot, "evidence", `${caseName}-last-message.txt`)).trim();
  const commandList = commands(caseName);
  const commandText = commandList.join("\n");
  const missingExpectations = expectations
    .filter((pattern) => !pattern.test(output))
    .map((pattern) => String(pattern));
  return {
    case: caseName,
    output,
    chars: output.length,
    clean: git(join(caseRoot, "cases", directory), "status", "--short") === "",
    addressedBoss: /老板/.test(output),
    loadedActionSkill: ["task-design", "task-dev", "task-test", "task-ops"]
      .some((name) => commandText.includes(`skills\\${name}`) || commandText.includes(`skills/${name}`)),
    commandCount: commandList.length,
    missingExpectations,
  };
});

const failures = observations.flatMap((item) => [
  ...(!item.output ? [`${item.case}: empty response`] : []),
  ...(!item.clean ? [`${item.case}: changed fixture files`] : []),
  ...(!item.addressedBoss ? [`${item.case}: did not address the user as 老板`] : []),
  ...(pmCases.has(item.case) && item.loadedActionSkill ? [`${item.case}: PM loaded an Action Skill`] : []),
  ...item.missingExpectations.map((pattern) => `${item.case}: missing semantic evidence ${pattern}`),
]);

const summary = {
  checkedAt: new Date().toISOString(),
  runtimeRoot,
  caseRuntimeRoots,
  cases: observations.length,
  passed: observations.length - new Set(failures.map((failure) => failure.split(":")[0])).size,
  failures,
  observations,
};
writeFileSync(join(runtimeRoot, "evidence", "k6-realworld-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

if (failures.length > 0) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
console.log(`K6 real-world language checks passed: ${observations.length}/${observations.length}`);
