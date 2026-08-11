import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const summaryPath = process.env.BEYOND_CONTROL_PLANE_SUMMARY;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error("BEYOND_ISOLATED_ROOT must be absolute");

const caseRoot = join(runtimeRoot, "cases", "WST-CONTROL-PLANE-integration");
const evidenceRoot = join(runtimeRoot, "evidence", "control-plane-integration");
const installedSkillsRoot = join(runtimeRoot, "codex-home", "skills");

function read(name) {
  const path = join(evidenceRoot, name);
  if (!existsSync(path)) throw new Error(`missing evidence: ${path}`);
  return readFileSync(path, "utf8").trim();
}

function check(name, condition) {
  results.push({ name, passed: Boolean(condition) });
}

function git(...args) {
  return execFileSync("git", args, { cwd: caseRoot, encoding: "utf8" }).trim();
}

const results = [];
const packet = read("task-packet.txt");
const workerEvents = read("02-worker-execution-events.jsonl");
const workerResumePath = join(evidenceRoot, "02b-worker-resume-events.jsonl");
const workerResumeEvents = existsSync(workerResumePath)
  ? readFileSync(workerResumePath, "utf8").trim()
  : workerEvents;
const callbackEvents = read("03-worker-callback-events.jsonl");
const callback = read("03-worker-callback-last-message.txt");
const closeoutEvents = read("04-pm-closeout-events.jsonl");
const final = read("04-pm-closeout-last-message.txt");
const workbenchDispatch = read("workbench-after-dispatch.md");
const workbenchFinal = read("workbench-after-closeout.md");
const workerEvidence = readFileSync(join(caseRoot, "evidence", "worker-result.md"), "utf8");
const source = readFileSync(join(caseRoot, "src", "companyRelations.js"), "utf8");
const status = git("status", "--short");
const log = git("log", "--oneline", "-2");
const worktrees = git("worktree", "list", "--porcelain");
const testOutput = execFileSync("node", ["--test"], { cwd: caseRoot, encoding: "utf8" });

check("PM packet starts only the Worker identity", packet.includes("$identity-worker") && !/\$task-(design|dev|test|ops)/.test(packet));
check("PM packet preserves business result", packet.includes("重复") && packet.includes("负责人") && packet.includes("导出"));
check("PM packet preserves no-release reality", packet.includes("不") && packet.includes("发布"));
check("PM packet remains compact", packet.length < 1400);
check("dispatch registers one active Worker", workbenchDispatch.includes("worker-company-fix") && workbenchDispatch.includes("进行中"));
check(
  "installed Worker identity is available and runtime acts as assigned Worker",
  existsSync(join(installedSkillsRoot, "identity-worker", "SKILL.md"))
    && /identity-worker|Worker\s*身份/i.test(workerEvents),
);
check(
  "Worker selects the installed development method and completes implementation",
  existsSync(join(installedSkillsRoot, "task-dev", "SKILL.md"))
    && workerEvents.includes("task-dev")
    && workerEvents.includes("公司详情")
    && workerResumeEvents.includes("完整测试")
    && workerResumeEvents.includes("src/companyRelations.js"),
);
check("Worker does not route ordinary work to PM", !workerEvents.includes("identity-pm"));
check("Worker fixes duplicate behavior", source.includes("new Set") || source.includes("seen"));
check(
  "Worker writes formal evidence",
  workerEvidence.includes("npm test")
    && /(?:3|4).{0,8}(?:(?:个测试|项).{0,8}通过|tests?.{0,8}passed)|pass(?:ed)?.{0,8}(?:3|4).{0,8}tests?/i.test(workerEvidence)
    && /当前用户页面(?:和|\/)业务操作[：:]?(?:尚未变化|[\s\S]{0,40}尚未发布[\s\S]{0,40}未变化)|current user page\/business operation (?:is|remains) unchanged|current user page and business operations? (?:are|remain) unchanged|no push, deployment|not published, pushed, deployed|not pushed, deployed, or applied to any external environment/i.test(workerEvidence),
);
const testPasses = Number(testOutput.match(/pass\s+(\d+)/i)?.[1] ?? 0);
check("all tests pass", testPasses >= 3 && /fail\s+0/i.test(testOutput));
check("Worker creates a task commit", log.split(/\r?\n/).length >= 2);
check("unrelated dirty change remains", status.includes("notes/unrelated.txt"));
check("no extra worktree", (worktrees.match(/^worktree /gm) ?? []).length === 1);
check("same Worker resumes for callback", callbackEvents.includes(read("worker-thread-id.txt")));
check("callback is terminal and compact", callback.includes("已完成") && callback.length < 500);
check("callback points to main evidence", callback.includes("evidence/worker-result.md"));
check("callback does not dump command or hash", !callback.includes("node --test") && !/[0-9a-f]{12,40}/i.test(callback));
check("PM closeout does not load Action Skill", !/task-(dev|design|test|ops)[\\/]+SKILL\.md/i.test(closeoutEvents));
check("PM marks same task completed", workbenchFinal.includes("worker-company-fix") && workbenchFinal.includes("已完成"));
check("PM does not duplicate task row", (workbenchFinal.match(/worker-company-fix/g) ?? []).length <= 2);
check(
  "user final states business result",
  final.includes("老板")
    && final.includes("负责人")
    && (final.includes("不再重复") || final.includes("只展示一次") || final.includes("去重") || /重复负责人.{0,20}(?:已.{0,8}修复|唯一负责人)/.test(final)),
);
check("user final states not yet live", /(?:尚未|还没有|不能).{0,80}(?:页面|线上|生产|外部环境|真实用户|用户环境)|(?:页面|线上|生产|外部环境|真实用户|用户环境).{0,80}(?:尚未|还没有|不能)/s.test(final));
check("user final avoids technical dump", !final.includes("node --test") && !/[0-9a-f]{12,40}/i.test(final) && !final.includes("managerId"));

const failed = results.filter((item) => !item.passed);
const summary = {
  passed: results.length - failed.length,
  failed: failed.length,
  results,
  metrics: {
    taskPacketChars: packet.length,
    callbackChars: callback.length,
    userFinalChars: final.length,
    worktreeCount: (worktrees.match(/^worktree /gm) ?? []).length,
  },
};

if (summaryPath) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (failed.length) process.exit(1);
