import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const codexScript = process.env.BEYOND_CODEX_SCRIPT
  ?? join(process.env.APPDATA ?? "", "npm", "codex.ps1");
const timeoutMs = Number(process.env.BEYOND_INTEGRATION_TIMEOUT_MS ?? 360000);

if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error("BEYOND_ISOLATED_ROOT must be absolute");
if (!existsSync(codexScript)) throw new Error("Codex CLI script not found");

const codexHome = join(runtimeRoot, "codex-home");
const caseRoot = join(runtimeRoot, "cases", "WST-CONTROL-PLANE-integration");
const evidenceRoot = join(runtimeRoot, "evidence", "control-plane-integration");
if (!existsSync(join(codexHome, "auth.json")) || !existsSync(caseRoot)) {
  throw new Error("prepare-isolated-runtime-test.mjs must run first");
}
mkdirSync(evidenceRoot, { recursive: true });

const boundary = "只允许访问当前隔离项目及本次隔离CODEX_HOME内已安装的Skills；禁止网络、真实服务器、生产、万事通、隔离环境之外的全局Skills、worktree、push和部署。";
const resumeWorkerThreadId = process.env.BEYOND_INTEGRATION_RESUME_WORKER;
const closeoutOnly = process.env.BEYOND_INTEGRATION_CLOSEOUT_ONLY === "1";

function run(stage, args, prompt) {
  const lastMessage = join(evidenceRoot, `${stage}-last-message.txt`);
  const events = join(evidenceRoot, `${stage}-events.jsonl`);
  const stderr = join(evidenceRoot, `${stage}-stderr.txt`);
  const startedAt = Date.now();
  const result = spawnSync(
    "pwsh.exe",
    ["-NoProfile", "-File", codexScript, ...args, "-o", lastMessage, prompt],
    {
      cwd: caseRoot,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    },
  );
  writeFileSync(events, result.stdout ?? "");
  writeFileSync(stderr, result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`${stage} failed with exit ${result.status}; see ${stderr}`);
  }
  if (!existsSync(lastMessage) || !readFileSync(lastMessage, "utf8").trim()) {
    throw new Error(`${stage} produced no final message`);
  }
  return {
    stage,
    durationMs: Date.now() - startedAt,
    message: readFileSync(lastMessage, "utf8").trim(),
    events: result.stdout ?? "",
  };
}

function initialArgs(ephemeral = true) {
  const args = [
    "exec",
    "--ignore-user-config",
    "--disable",
    "plugins",
    "--sandbox",
    "danger-full-access",
    "--json",
    "--color",
    "never",
    "-C",
    caseRoot,
  ];
  if (ephemeral) args.splice(1, 0, "--ephemeral");
  return args;
}

function threadId(events) {
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) return event.thread_id;
    } catch {
      // Non-JSON warnings are preserved in the raw evidence.
    }
  }
  throw new Error("worker thread id not found");
}

const timings = [];
let dispatch;
let workerThreadId;
if (closeoutOnly) {
  if (!resumeWorkerThreadId) throw new Error("closeout-only mode requires BEYOND_INTEGRATION_RESUME_WORKER");
  dispatch = { message: readFileSync(join(evidenceRoot, "task-packet.txt"), "utf8").trim() };
  workerThreadId = resumeWorkerThreadId;
} else if (resumeWorkerThreadId) {
  dispatch = { message: readFileSync(join(evidenceRoot, "task-packet.txt"), "utf8").trim() };
  workerThreadId = resumeWorkerThreadId;
  const resumedWorker = run(
    "02b-worker-resume",
    ["exec", "--disable", "plugins", "resume", "--ignore-user-config", "--dangerously-bypass-approvals-and-sandbox", "--json", workerThreadId],
    `上轮隔离平台在相关测试已经通过后发生响应流中断。请沿用当前同一Worker、Git现场和已有结果继续：复核当前事实，完成 evidence/worker-result.md、精确本地提交和面向老板的最终交付。不要从头重做，不回PM申请普通步骤。${boundary}`,
  );
  timings.push({ stage: resumedWorker.stage, durationMs: resumedWorker.durationMs });
} else {
  dispatch = run(
    "01-pm-dispatch",
    initialArgs(true),
    `$identity-pm\n当前对话已经建立PM身份。老板说：“把公司详情重复负责人的问题修好，相关测试跑完后本地提交，先不要发布。”当前业务事实入口是 docs/business/company-manager-fix.md。隔离平台已经为即将建立的用户可见任务预留唯一Worker标识 worker-company-fix。允许且只允许把当前工作台登记为一个进行中的正式任务，然后输出将交给该Worker的真实初始任务正文；不要实际创建线程。任务正文保持紧凑但不能丢业务结果、验收、正式目录、事实入口、用户现实和真实暂停边界。${boundary}`,
  );
  timings.push({ stage: dispatch.stage, durationMs: dispatch.durationMs });
  writeFileSync(join(evidenceRoot, "task-packet.txt"), `${dispatch.message}\n`);
  writeFileSync(
    join(evidenceRoot, "workbench-after-dispatch.md"),
    readFileSync(join(caseRoot, "docs", "AI编程协同机制", "当前工作台.md")),
  );

  const worker = run(
    "02-worker-execution",
    initialArgs(false),
    `$identity-worker\n平台已将当前对话建立为上述业务结果的唯一正式Worker worker-company-fix。下面是来源PM的派单输出，请从中收敛业务契约，自行选择当前主要问题需要的Action Skill，并在当前隔离项目连续完成，不回PM申请普通步骤或Skill；实际运行相关和完整测试，把任务证据写入 evidence/worker-result.md，并完成任务自有本地提交。\n\n--- PM派单 ---\n${dispatch.message}\n--- 结束 ---\n\n${boundary}`,
  );
  timings.push({ stage: worker.stage, durationMs: worker.durationMs });
  workerThreadId = threadId(worker.events);
}
writeFileSync(join(evidenceRoot, "worker-thread-id.txt"), `${workerThreadId}\n`);

let callback;
if (closeoutOnly) {
  callback = { message: readFileSync(join(evidenceRoot, "03-worker-callback-last-message.txt"), "utf8").trim() };
} else {
  callback = run(
    "03-worker-callback",
    ["exec", "--disable", "plugins", "resume", "--ignore-user-config", "--dangerously-bypass-approvals-and-sandbox", "--json", workerThreadId],
    `现在只生成应投递给来源PM的一次完成回传正文，不做新业务工作、不修改文件，也不要声称已经实际发送。完整工程证据仍在当前Worker任务和 evidence/worker-result.md；回传只传控制面增量。${boundary}`,
  );
  timings.push({ stage: callback.stage, durationMs: callback.durationMs });
}
mkdirSync(join(caseRoot, "evidence"), { recursive: true });
writeFileSync(join(caseRoot, "evidence", "control-plane-callback.txt"), `${callback.message}\n`);

const closeout = run(
  "04-pm-closeout",
  initialArgs(true),
  `$identity-pm\n当前对话已经建立PM身份。唯一Worker worker-company-fix 已返回完成结果，正文在 evidence/control-plane-callback.txt，完整证据在 evidence/worker-result.md。只消费这一次结果，定点核验当前Git和证据；允许且只允许把当前工作台同一个任务更新为已完成，然后面向老板说明真实业务结果、现在能否使用和下一步。不要修改业务代码、测试或证据，不读取Action Skill。${boundary}`,
);
timings.push({ stage: closeout.stage, durationMs: closeout.durationMs });

writeFileSync(
  join(evidenceRoot, "workbench-after-closeout.md"),
  readFileSync(join(caseRoot, "docs", "AI编程协同机制", "当前工作台.md")),
);
writeFileSync(join(evidenceRoot, "timings.json"), `${JSON.stringify(timings, null, 2)}\n`);

console.log(JSON.stringify({ workerThreadId, timings }, null, 2));
