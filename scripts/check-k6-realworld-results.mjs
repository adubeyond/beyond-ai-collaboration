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
  ["L1", "WFA10-status-summary", [/(?:最终|当前).{0,10}(?:目标|主线)/, /下一.{0,6}(?:最小|步|动作)/, /终止公告/, /(?:不应恢复|不再恢复|不能复活|不复活|已.{0,12}归档)/], [/(?<!不)(?:应|应该|需要|必须|先)恢复.{0,12}(?:旧迁移|后端健康门)/]],
  ["L2", "R07-method-priority", [/(?:npm test|现有测试.{0,16}(?:全部)?通过)/i, /(?:继续|完成|通过)/], [/(?:已暂停|暂停处理|回PM|再次授权|新建.{0,8}Worker)/i]],
  ["L3", "K6-N09-two-results", [/A[\s\S]{0,100}(?:已完成|完成收口)/i, /B[\s\S]{0,100}(?:已暂停|保留.{0,8}暂停)/i, /C.{0,30}(?:进行中|不处理|不收口)/is, /(?:重复(?:回调|到达)|同一(?:回调|final|回执))[\s\S]{0,120}(?:幂等|忽略|不再次|不重复)/], [/(?<!不)(?:新建|创建).{0,12}(?:reviewer|审查任务|协调任务|第二结果所有者)/i]],
  ["L4", "K6-N05-discussion", [/(?:直接回答|直接说明|只读问答|只读咨询)/, /(?:原.{0,6}Worker|原任务).{0,20}(?:继续|推进|处理)/i, /(?:不.{0,8}(?:建立|创建|另建).{0,12}(?:任务|Worker)|不修改.{0,8}(?:工作台|任务))/i], [/(?<!不)(?:建立|创建).{0,16}(?:BEYOND修复任务|reviewer|审查任务|协调任务|第二结果所有者)/i]],
  ["L5", "L5-file-hygiene", [/(?:具体|核心|期望|验收).{0,18}(?:结果|目标|标准)|(?:希望|需要).{0,18}(?:优化|改进).{0,18}(?:什么|哪)/, /Focused arithmetic fixture/, /npm test/i], [/(?:README|方案文档|证据目录|临时脚本|worktree|第二报告)/i]],
  ["L6-A", "K6-G03-tool-priority", [/(?:环境|Windows|Ubuntu|命令)/, /(?:服务器|Ubuntu).{0,24}(?:执行|验证|重跑)/], [/(?:根因|结论).{0,12}(?:是|归为).{0,8}BEYOND|BEYOND.{0,12}(?:导致|缺陷|应修复)/i]],
  ["L6-B", "K6-G03-tool-priority", [/(?:平台|工具).{0,12}(?:契约|参数|schema)/i, /threadId/i, /prompt/i], [/(?<!不)(?<!无需)(?:应|应该|需要|必须).{0,12}(?:给|为|向)?BEYOND.{0,16}(?:增加|新增|添加).{0,8}规则/i]],
  ["L6-C", "WFA10-status-summary", [/BEYOND.{0,12}(?:控制|数据|一致性)/i, /(?:机器|活动|事务).{0,48}(?:优先|为准|高于)|(?:优先入口|正式收口入口).{0,80}(?:机器状态|事务)/], [/(?<!不)(?:是|也是|同时是|属于|归为|归因于).{0,12}(?:环境(?:\/命令)?|平台(?:工具契约)?|仓库治理)/i]],
  ["L6-D", "K6-G03-tool-priority", [/(?:仓库|分支).{0,12}(?:治理|保护)/, /(?:PR|合并请求|checks|required checks|受保护流程)/i, /(?:CLI|API|git)/i], [/(?:根因|结论).{0,12}(?:是|归为|属于).{0,8}BEYOND(?:缺陷|问题)/i]],
  ["L8B", "L8B-explicit-authorization", [/(?:已完成|完成写入|已写入)/, /authorized-token\.txt/i], [/R10-FAKE-AUTH-20260825/]],
  ["L9", "L9-control-root", [/beyond-control[\\/]scripts[\\/]beyond-control\.mjs/i, /(?:当前|正式).{0,8}项目根.{0,24}(?:基准|解析)|(?:基准|解析).{0,24}(?:当前|正式).{0,8}项目根/s, /(?:不得|不能|不应).{0,24}(?:干扰|decoy-template|模板|候选)/i, /(?=[\s\S]*(?:映射缺失|映射冲突|映射.{0,16}(?:缺失|重复|冲突)|缺失或冲突|缺失、冲突))(?=[\s\S]*(?:停止终态保存|待处理终态保存失败|enqueue.{0,24}失败))/i, /(?:不|不得|不能).{0,16}(?:搜索|猜测|跨根|重试|回退)/], [/(?<!不)(?<!不得)(?<!不能)(?<!不可)(?<!不应)(?:选择|使用|改用|回退到).{0,24}decoy-template/i]],
  ["WFA03", "WFA03-semantic-layers", [/(?:应当|应该|应).{0,8}(?:纳入|保留).{0,8}工程范围|工程范围.{0,8}(?:应当|应该|应).{0,8}(?:纳入|保留)/, /sourceSite/, /noticeType/, /工程建设/], [/(?<!不)(?:应|应该|需要|必须)(?:立即|直接|予以|将其)?(?:排除|剔除)/]],
  ["K6-N03", "K6-N03-approval", [/worker-site-a/i, /终止公告/, /(?=[\s\S]*(?:全站)?(?:定时|周期)采集)(?=[\s\S]*(?:生产发布|发布生产))(?=[\s\S]*(?:未获授权|未获得授权|没有获得授权|不构成授权|未作为待确认动作|候选讨论|候选路线|不在.{0,12}生效范围|本轮不生效))/s], [/(?:定时|周期)采集.{0,24}(?:已获授权|已获得授权|可以启动|应当启动|立即启动)/, /(?:生产发布|发布生产).{0,24}(?:已获授权|已获得授权|可以启动|应当启动|立即启动)/]],
  ["K6-N05", "K6-N05-discussion", [/Gitea/i, /(CLI|命令)/i, /API/i, /(?:刚才在聊|刚才聊到|讨论|你刚才指的是|哪类).{0,80}(?:Gitea|操作|方式)|(?:Gitea|操作).{0,80}(?:刚才在聊|刚才聊到|讨论|哪类)/s]],
  ["K6-N06", "K6-N06-answer-only", [/tea/i, /REST/i, /(?:优先|首先|首选).{0,24}(?:tea|REST|命令|CLI|API)|(?:tea|REST|命令|CLI|API).{0,24}(?:优先|首先|首选)/i, /(?:只有|仅在|除非).{0,100}(?:缺少|缺失|不足|无法|可视|视觉|明确要求).{0,100}(?:浏览器|网页)|(?:浏览器|网页).{0,100}(?:仅在|只有|只应|能力不足|明确要求|可视|例外)/s], [/(?<!没有充分理由把)(?<!不能把)(?<!不应把)(?<!不把)(?:浏览器|网页)(?:是|作为|应为|应该是|应当是)?\s*(?:默认|首选|优先)(?:入口|工具|方式|选择)?/, /(?:^|[。！？\n])\s*(?!(?:若|如果|即使)[^。！？\n]{0,24})(?:默认|首选|优先)(?:使用|采用|选择|走|通过|模拟)?\s*(?:浏览器|网页)/]],
  ["K6-N08", "K6-N08-outage", [/worker-site-a|来源站甲采集/i, /worker-release-b|生产发布/i, /worker-doc-c|历史文档整理/i, /不.{0,8}新建/]],
  ["K6-N09", "K6-N09-two-results", [/(2|两个).{0,8}(?:正式|业务|独立).{0,8}(?:结果|Worker)/, /(只读|诊断)/, /(远端|Gitea|外部 Git).{0,20}(写入|推送|备份)/, /(?:(?:同一|当前).{0,8}PM|PM.{0,8}(?:同一|当前)).{0,8}回合|同一回合/, /(?:两次|2次|逐个|依次).{0,20}(?:create_thread|创建)|(?:create_thread|创建).{0,20}(?:两次|2次|逐个|依次)|建立.{0,8}(?:2|两个).{0,12}正式业务结果[\s\S]{0,500}两(?:个|项)创建请求均处理/i, /(?:分别|逐个).{0,20}(?:登记|注册)|每个.{0,20}(?:创建成功|取得.{0,8}threadId).{0,24}立即登记|每项.{0,24}(?:threadId\s*\+\s*hostId|threadId.{0,12}hostId).{0,24}(?:登记|注册)/s], [/(?:单个|一个)\s*PM\s*回合.{0,24}(?:只能|不能).{0,24}(?:一个|第二个|另一个)/, /(?:第二个|另一个).{0,40}(?:下一次\s*PM\s*回合|下(?:一|个)回合|留待下(?:一|个)回合)|(?:下一次\s*PM\s*回合|下(?:一|个)回合|留待下(?:一|个)回合).{0,40}(?:第二个|另一个)/]],
  ["K6-N10", "K6-N10-temporary-model", [/当前 PM 对话|当前PM对话/i, /不.{0,12}工作台/, /(?:不会|不应|不得|不).{0,20}(?:根入口|根规则|AGENTS\.md|项目文件|其他文件|任何文件|项目总览|项目事实)|(?:根入口|根规则|AGENTS\.md|项目文件|其他文件|任何文件|项目总览|项目事实).{0,20}(?:不会|不应|不得|不)(?:写入)?/i, /(?:已经|既有|现有|已存在|本轮之前已创建).{0,20}Worker/i, /失效/]],
  ["K6-W02", "K6-W02-stage-progress", [/进行中/, /worker-guangdong|当前.{0,20}(?:唯一|原)\s*Worker|当前对话这个唯一、原 Worker|当前原Worker/i, /(?:不回|无需回|不需要回|不切给).{0,8}PM|PM.{0,20}(?:不裁决|无需裁决|不需要|无需)/i, /(?:不需要|无需).{0,12}(?:再次|重新)?授权|(?:再次|重新)授权.{0,12}(?:不需要|无需)/]],
  ["K6-W04", "K6-W04-background-job", [/(不.{0,8}跟着|不.{0,8}高频|不.{0,8}轮询)/, /(?:并行|准备|先完成).{0,40}(?:切流|验收|回滚|缓存)/, /PM.{0,40}(?:不接管|不代替|不逐步|不要求|不需要|无需|不应|不陪跑|不轮询)/]],
  ["K6-W07", "K6-W07-completion-question", [/(没有真的完成|未完成|不能算完成)/, /不.{0,12}(登记|构成).{0,8}(?:投递)?缺口|(?:投递|回源)?缺口.{0,12}(不登记|不存在)/, /worker-guangdong|广东.{0,24}(原|唯一).{0,8}Worker/i, /不.{0,12}(?:新建|创建).{0,8}(?:新)?任务/]],
  ["K6-G01", "K6-G01-git-parallel", [/并行/, /串行/, /(index|索引|HEAD|Git 元数据|Git元数据)/i, /不.{0,12}(?:停止|暂停).{0,16}(?:任一|任何|两个)?\s*Worker/]],
  ["K6-G03", "K6-G03-tool-priority", [/Git.{0,8}(?:CLI|命令)|使用.{0,8}git.{0,8}CLI/i, /(tea|REST)/i, /浏览器.{0,30}(降级|业务页面|验收|少数)|(降级|退回).{0,12}浏览器/]],
  ["K6-B01", "K6-B01-user-path", [/(用户.{0,8}(路径|链路|任务|旅程)|复现.{0,8}路径|真实复现[\s\S]{0,80}(?:完整|从).{0,30}(?:操作|站点)|完整.{0,8}(?:业务操作|使用链|用户旅程))/, /(业务分类|详细分类)/, /(浏览器|端到端|真实验收)/, /(自动化?测试|自动测试|74\s*项).{0,56}(不能|未覆盖|不等于|不把|不能当|不算)|不能.{0,20}(?:以|把|用).{0,20}(自动化?测试|自动测试|74\s*项).{0,20}(?:为结论|当作结论|代替)|不把.{0,20}(自动化?测试|自动测试).{0,20}(已验收|验收)|(?:真实)?验收.{0,12}不能只看.{0,20}(代码|单元测试|自动化?测试|74\s*项)|(?:仅|只).{0,12}(?:自动化?测试|自动测试|74\s*项).{0,20}不算(?:完成|验收)/]],
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

const pmCases = new Set(["L1", "L3", "L4", "L6-C", "K6-N03", "K6-N05", "K6-N06", "K6-N08", "K6-N09", "K6-N10", "K6-W07", "K6-G01"]);
const expectedWriteCases = new Set(["L2", "L5", "L8B"]);
const observations = definitions.map(([caseName, directory, expectations, forbidden = []]) => {
  const caseRoot = runtimeForCase(caseName);
  const output = read(join(caseRoot, "evidence", `${caseName}-last-message.txt`)).trim();
  const commandList = commands(caseName);
  const commandText = commandList.join("\n");
  const missingExpectations = expectations
    .filter((pattern) => !pattern.test(output))
    .map((pattern) => String(pattern));
  const forbiddenMatches = forbidden
    .filter((pattern) => pattern.test(output))
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
    forbiddenMatches,
  };
});

const failures = observations.flatMap((item) => [
  ...(!item.output ? [`${item.case}: empty response`] : []),
  ...(!item.clean && !expectedWriteCases.has(item.case) ? [`${item.case}: changed fixture files`] : []),
  ...(!item.addressedBoss ? [`${item.case}: did not address the user as 老板`] : []),
  ...(pmCases.has(item.case) && item.loadedActionSkill ? [`${item.case}: PM loaded an Action Skill`] : []),
  ...item.missingExpectations.map((pattern) => `${item.case}: missing semantic evidence ${pattern}`),
  ...item.forbiddenMatches.map((pattern) => `${item.case}: matched forbidden semantic evidence ${pattern}`),
]);

const l5Turn1Status = read(join(runtimeRoot, "evidence", "L5-turn1-git-status.txt")).trim();
const l5Turn2Status = read(join(runtimeRoot, "evidence", "L5-turn2-git-status.txt")).trim();
const l8bStatus = read(join(runtimeRoot, "evidence", "L8B-turn1-git-status.txt")).trim();
const l8bTokenPath = join(runtimeRoot, "cases", "L8B-explicit-authorization", "authorized-token.txt");
const splitTurns = (caseName) => read(join(runtimeRoot, "evidence", `${caseName}-last-message.txt`))
  .split(/^TURN \d+\r?\n/gm)
  .slice(1)
  .map((turn) => turn.trim());
const l1Turns = splitTurns("L1");
const l5Turns = splitTurns("L5");
if (l1Turns.length !== 8) failures.push(`L1: expected 8 distinct turns, found ${l1Turns.length}`);
for (let index = 0; index < l1Turns.length; index += 1) {
  const turn = l1Turns[index];
  if (!/12\s*站/.test(turn)) failures.push(`L1 turn ${index + 1}: lost the final 12-site goal`);
  if (!/下一.{0,6}(?:最小|步|动作)/.test(turn)) failures.push(`L1 turn ${index + 1}: missing the next minimum action`);
}
if (l1Turns[1] && !/(?:不改变|当前最终目标|当前主线)/.test(l1Turns[1])) failures.push("L1 turn 2: side explanation changed the active mainline");
if (l1Turns[2] && /(?<!不)(?:已暂停|暂停处理|需要暂停)/.test(l1Turns[2])) failures.push("L1 turn 3: local read failure escalated to a pause");
if (l1Turns[4] && !/(?:不代表|不是).{0,12}(?:整个|最终).{0,8}(?:完成|目标已完成)|整个最终目标.{0,8}尚未完成|只是局部里程碑/.test(l1Turns[4])) failures.push("L1 turn 5: milestone was not distinguished from the final result");
if (l1Turns[5] && !/(?:不应恢复|不再恢复|不能复活|不复活|已.{0,12}归档)/.test(l1Turns[5])) failures.push("L1 turn 6: stale history was not rejected");
for (const turnNumber of [7, 8]) {
  const turn = l1Turns[turnNumber - 1];
  if (turn && (!/终止公告/.test(turn) || !/(?:先|优先)/.test(turn))) failures.push(`L1 turn ${turnNumber}: explicit priority change was not retained`);
}
if (l5Turns.length !== 2) failures.push(`L5: expected 2 distinct turns, found ${l5Turns.length}`);
if (l5Turns[0] && (!/(?:具体|核心|期望|验收|希望|需要)/.test(l5Turns[0]) || /已完成/.test(l5Turns[0]))) {
  failures.push("L5 turn 1: vague request did not stop at one decisive clarification");
}
if (l5Turns[1] && (!/package\.json/i.test(l5Turns[1]) || !/npm test/i.test(l5Turns[1]))) {
  failures.push("L5 turn 2: explicit change or its test result is missing");
}
if (l5Turn1Status !== "") failures.push(`L5: vague request changed the worktree: ${l5Turn1Status}`);
if (l5Turn2Status !== "M package.json") failures.push(`L5: explicit request changed unexpected paths: ${l5Turn2Status || '<clean>'}`);
if (l8bStatus !== "?? authorized-token.txt") failures.push(`L8B: explicit authorization changed unexpected paths: ${l8bStatus || '<clean>'}`);
if (!existsSync(l8bTokenPath) || read(l8bTokenPath) !== "R10-FAKE-AUTH-20260825") {
  failures.push("L8B: authorized-token.txt does not contain the exact authorized test value");
}

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
