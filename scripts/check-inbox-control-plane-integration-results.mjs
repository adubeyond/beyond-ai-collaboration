import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const summaryPath = process.env.BEYOND_INBOX_INTEGRATION_SUMMARY;
const projectId = "local-c0ffee123456";
const sourceThreadId = "11111111-2222-4333-8444-555555555555";
if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error("BEYOND_ISOLATED_ROOT must be absolute");

const caseRoot = join(runtimeRoot, "cases", "WST-CONTROL-PLANE-integration");
const evidenceRoot = join(runtimeRoot, "evidence", "inbox-control-plane-integration");
const installedSkillsRoot = join(runtimeRoot, "codex-home", "skills");

function read(name) {
  const path = join(evidenceRoot, name);
  if (!existsSync(path)) throw new Error(`missing evidence: ${path}`);
  return readFileSync(path, "utf8").trim();
}

function commands(name) {
  return read(`${name}-events.jsonl`)
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === "item.started" && event.item?.type === "command_execution"
          ? [event.item.command ?? ""]
          : [];
      } catch {
        return [];
      }
    });
}

function historyRecord(recordId) {
  const root = join(caseRoot, "local", "inbox", "history");
  if (!existsSync(root)) return null;
  for (const month of readdirSync(root)) {
    const path = join(root, month, projectId, `${recordId}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  }
  return null;
}

function taskHistory() {
  const root = join(caseRoot, "local", "history", "tasks");
  if (!existsSync(root)) return "";
  return readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(root, name), "utf8"))
    .join("\n");
}

const results = [];
function check(name, condition) {
  results.push({ name, passed: Boolean(condition) });
}

const packet = read("task-packet.txt");
const workerEvents = read("02-worker-execution-events.jsonl");
const workerCommands = commands("02-worker-execution");
const workerFinal = read("02-worker-execution-last-message.txt");
const pmEvents = read("03-pm-safe-consume-events.jsonl");
const pmCommands = commands("03-pm-safe-consume");
const pmFinal = read("03-pm-safe-consume-last-message.txt");
const workbenchDispatch = read("workbench-after-dispatch.md");
const workbenchFinal = read("workbench-after-closeout.md");
const pendingBefore = JSON.parse(read("pending-before-pm.json"));
const pendingAfter = JSON.parse(read("pending-after-pm.json"));
const record = pendingBefore.records?.[0];
const archived = record ? historyRecord(record.recordId) : null;
const archivedTasks = taskHistory();
const workerEvidence = readFileSync(join(caseRoot, "evidence", "worker-result.md"), "utf8");
const source = readFileSync(join(caseRoot, "src", "companyRelations.js"), "utf8");
const status = execFileSync("git", ["status", "--short"], { cwd: caseRoot, encoding: "utf8" });
const log = execFileSync("git", ["log", "--oneline", "-2"], { cwd: caseRoot, encoding: "utf8" }).trim();
const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: caseRoot, encoding: "utf8" });
const testOutput = execFileSync("node", ["--test"], { cwd: caseRoot, encoding: "utf8" });

check("PM packet starts only the Worker identity", packet.includes("$identity-worker") && !/\$task-(design|dev|test|ops)/.test(packet));
check("PM packet preserves the business result and no-release boundary", packet.includes("重复") && packet.includes("负责人") && packet.includes("不") && packet.includes("发布"));
check("dispatch registers exactly one active Worker", workbenchDispatch.includes("worker-company-fix") && workbenchDispatch.includes("进行中"));
check("installed Worker and development Skills are used", existsSync(join(installedSkillsRoot, "identity-worker", "SKILL.md")) && existsSync(join(installedSkillsRoot, "task-dev", "SKILL.md")) && workerEvents.includes("task-dev") && !workerEvents.includes("identity-pm"));
check("Worker fixes duplicate behavior", source.includes("new Set") || source.includes("seen"));
check("Worker writes formal evidence and tests", workerEvidence.includes("npm test") && /(?:3|4).{0,12}(?:测试|tests?).{0,12}(?:通过|passed)|(?:完整测试|tests?).{0,20}(?:3|4)\s*项通过|pass(?:ed)?.{0,8}(?:3|4)/i.test(workerEvidence));
check("all fixture tests pass", /pass\s+[34]/i.test(testOutput) && /fail\s+0/i.test(testOutput));
check("Worker creates a task commit", log.split(/\r?\n/).length >= 2);
check("unrelated dirty change remains", status.includes("notes/unrelated.txt"));
check("no extra worktree is created", (worktrees.match(/^worktree /gm) ?? []).length === 1);

const enqueueCommands = workerCommands.filter((command) => /inbox\s+--action\s+enqueue/i.test(command));
check("Worker actually enqueues exactly one terminal result", enqueueCommands.length === 1);
check("Worker uses the structured source and project identity", enqueueCommands[0]?.includes(sourceThreadId) && enqueueCommands[0]?.includes(projectId));
check("Worker does not use direct PM platform messaging", !/send_message|source PM.{0,20}(?:发送|注入)/i.test(workerEvents));
check("Worker final is self-contained", /老板/.test(workerFinal) && /已完成|完成/.test(workerFinal) && /evidence\/worker-result\.md/.test(workerFinal));

check("pending inbox has exactly one result before PM", pendingBefore.projectId === projectId && pendingBefore.count === 1 && pendingBefore.records.length === 1);
check("pending result binds the source Worker relationship", record?.projectId === projectId && record?.sourceThreadId === sourceThreadId);
check("pending result preserves completion and main evidence", record?.status === "已完成" && record?.task?.includes("负责人") && record?.evidence === "evidence/worker-result.md");
check("pending summary preserves the business fact", /重复|唯一|去重/.test(record?.summary ?? ""));

const listCommands = pmCommands.filter((command) => /inbox\s+--action\s+list/i.test(command));
const pmCommandText = pmCommands.join("\n");
const updateIndex = pmCommandText.search(/workbench\s+--action\s+(?:upsert|progress)/i);
const ackIndex = pmCommandText.search(/inbox\s+--action\s+ack/i);
const listIndex = pmCommandText.search(/inbox\s+--action\s+list/i);
check("PM reads the inbox exactly once in the user turn", listCommands.length === 1);
check("PM does not load an Action Skill", !/task-(dev|design|test|ops)[\\/]+SKILL\.md/i.test(pmEvents));
check("PM consumes in list-update-ack order", listIndex >= 0 && updateIndex > listIndex && ackIndex > updateIndex);
check("PM acknowledges the exact pending record", ackIndex >= 0 && pmCommandText.slice(ackIndex).includes(record?.recordId ?? "missing"));
check("PM marks and archives the same Worker task completed", !workbenchFinal.includes("worker-company-fix") && archivedTasks.includes("worker-company-fix") && /完成任务归档|已完成/.test(archivedTasks));
check("PM does not duplicate the Worker task", (workbenchFinal.match(/worker-company-fix/g) ?? []).length <= 2);
check("pending inbox is empty after PM", pendingAfter.projectId === projectId && pendingAfter.count === 0 && pendingAfter.records.length === 0);
check("acknowledged record is archived without mutation", archived && JSON.stringify(archived) === JSON.stringify(record));
check("PM final states the business result", /老板/.test(pmFinal) && /负责人/.test(pmFinal) && /不再重复|去重|唯一/.test(pmFinal));
check("PM final preserves current user reality", /(?:尚未|还没有|不能).{0,80}(?:页面|线上|生产|真实用户|用户环境)|(?:页面|线上|生产|真实用户|用户环境).{0,80}(?:尚未|还没有|不能)/s.test(pmFinal));
check("PM final avoids technical dump", !pmFinal.includes("node --test") && !/[0-9a-f]{20,40}/i.test(pmFinal));

const failed = results.filter((item) => !item.passed);
const summary = {
  passed: results.length - failed.length,
  failed: failed.length,
  results,
  metrics: {
    taskPacketChars: packet.length,
    workerFinalChars: workerFinal.length,
    pmFinalChars: pmFinal.length,
    worktreeCount: (worktrees.match(/^worktree /gm) ?? []).length,
  },
};
if (summaryPath) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (failed.length > 0) process.exitCode = 1;
