import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const codexScript = process.env.BEYOND_CODEX_SCRIPT
  ?? join(process.env.APPDATA ?? "", "npm", "codex.ps1");
const timeoutMs = Number(process.env.BEYOND_INTEGRATION_TIMEOUT_MS ?? 360000);
const projectId = "local-c0ffee123456";
const sourceThreadId = "11111111-2222-4333-8444-555555555555";

if (!runtimeRoot || !isAbsolute(runtimeRoot)) throw new Error("BEYOND_ISOLATED_ROOT must be absolute");
if (!existsSync(codexScript)) throw new Error("Codex CLI script not found");

const codexHome = join(runtimeRoot, "codex-home");
const caseRoot = join(runtimeRoot, "cases", "WST-CONTROL-PLANE-integration");
const evidenceRoot = join(runtimeRoot, "evidence", "inbox-control-plane-integration");
const controlScript = join(caseRoot, "scripts", "beyond-control.mjs");
if (!existsSync(join(codexHome, "auth.json")) || !existsSync(controlScript)) {
  throw new Error("prepare-isolated-runtime-test.mjs must run first");
}
mkdirSync(evidenceRoot, { recursive: true });

const boundary = "只允许访问当前隔离项目及本次隔离CODEX_HOME内已安装的Skills；禁止网络、真实服务器、生产、万事通、隔离环境之外的全局Skills、worktree、push和部署。";

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
  if (result.status !== 0) throw new Error(`${stage} failed with exit ${result.status}; see ${stderr}`);
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
    "--disable",
    "plugins",
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
    "--color",
    "never",
    "-C",
    caseRoot,
  ];
  if (ephemeral) args.splice(3, 0, "--ephemeral");
  return args;
}

function fixedScript(...args) {
  return execFileSync(process.execPath, [controlScript, ...args], {
    cwd: caseRoot,
    encoding: "utf8",
  });
}

function threadId(events) {
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) return event.thread_id;
    } catch {
      // Raw warnings stay in the evidence stream.
    }
  }
  throw new Error("worker thread id not found");
}

const timings = [];
const dispatch = run(
  "01-pm-dispatch",
  initialArgs(true),
  `$identity-pm\n当前对话已经建立PM身份。老板说：“把公司详情重复负责人的问题修好，相关测试跑完后本地提交，先不要发布。”当前业务事实入口是 docs/business/company-manager-fix.md。隔离平台已经为即将建立的用户可见任务预留唯一Worker标识 worker-company-fix。允许且只允许用固定脚本把当前工作台登记为一个进行中的正式任务，然后输出交给该Worker的紧凑初始任务正文；不要实际创建线程。${boundary}`,
);
timings.push({ stage: dispatch.stage, durationMs: dispatch.durationMs });
writeFileSync(join(evidenceRoot, "task-packet.txt"), `${dispatch.message}\n`);
writeFileSync(join(evidenceRoot, "workbench-after-dispatch.md"), readFileSync(join(caseRoot, "local", "当前工作台.md")));

const worker = run(
  "02-worker-execution",
  initialArgs(false),
  `$identity-worker\n平台已将当前对话建立为上述业务结果的唯一正式Worker worker-company-fix，并结构化注入直接source_thread_id=${sourceThreadId}。下面是来源PM的派单输出。请在当前隔离项目连续完成实现、相关测试、完整测试、evidence/worker-result.md和任务自有本地提交。业务真实完成后，必须按当前项目入口实际调用固定脚本向项目${projectId}的本机结果收件箱登记恰好一条完成记录，再输出Worker自包含final；不得用平台消息直接注入PM。\n\n--- PM派单 ---\n${dispatch.message}\n--- 结束 ---\n\n${boundary}`,
);
timings.push({ stage: worker.stage, durationMs: worker.durationMs });
const workerThreadId = threadId(worker.events);
writeFileSync(join(evidenceRoot, "worker-thread-id.txt"), `${workerThreadId}\n`);
writeFileSync(join(caseRoot, "evidence", "worker-final.txt"), `${worker.message}\n`);

const pendingBefore = fixedScript("inbox", "--action", "list", "--project-id", projectId);
writeFileSync(join(evidenceRoot, "pending-before-pm.json"), pendingBefore);

const closeout = run(
  "03-pm-safe-consume",
  initialArgs(true),
  `$identity-pm\n当前对话已经建立PM身份。这是老板主动发起的新回合：“刚才公司详情重复负责人的任务完成了吗？现在能不能用？”当前工作台登记的唯一Worker是worker-company-fix；它的正式final在evidence/worker-final.txt，主证据在evidence/worker-result.md。请按当前项目入口只读取一次本机结果收件箱，核验同一Worker的Git、正式结果和主证据；证据闭合时只用固定脚本把同一任务更新为已完成，然后确认归档这一条记录，最后先说业务结果和用户现实。不要修改业务代码、测试或证据，不读取Action Skill，不等待或轮询。${boundary}`,
);
timings.push({ stage: closeout.stage, durationMs: closeout.durationMs });

const pendingAfter = fixedScript("inbox", "--action", "list", "--project-id", projectId);
writeFileSync(join(evidenceRoot, "pending-after-pm.json"), pendingAfter);
writeFileSync(join(evidenceRoot, "workbench-after-closeout.md"), readFileSync(join(caseRoot, "local", "当前工作台.md")));
writeFileSync(join(evidenceRoot, "timings.json"), `${JSON.stringify(timings, null, 2)}\n`);

console.log(JSON.stringify({ projectId, sourceThreadId, workerThreadId, timings }, null, 2));
