import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const projectRoot = resolve(process.env.BEYOND_COMPACTION_PROJECT ?? "");
const evidencePath = resolve(process.env.BEYOND_COMPACTION_EVIDENCE ?? join(projectRoot, "real-compaction-cli-evidence.json"));
const codexScript = process.env.BEYOND_CODEX_SCRIPT ?? join(process.env.APPDATA ?? "", "npm", "codex.ps1");
if (!projectRoot || !existsSync(join(projectRoot, ".codex", "hooks.json"))) throw new Error("invalid trusted compaction project");
if (!existsSync(codexScript)) throw new Error(`Codex CLI script not found: ${codexScript}`);

const startedAt = new Date();
const firstOutput = join(projectRoot, "outputs", "real-compaction-cli-first.txt");
const secondOutput = join(projectRoot, "outputs", "real-compaction-cli-second.txt");
mkdirSync(join(projectRoot, "outputs"), { recursive: true });

function codex(args, prompt, output) {
  const result = spawnSync("pwsh.exe", ["-NoProfile", "-File", codexScript, ...args, "-o", output, prompt], {
    cwd: projectRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 240000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Codex CLI failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

function threadId(events) {
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) return event.thread_id;
    } catch {
      // Non-protocol diagnostic lines are retained in command evidence but ignored here.
    }
  }
  throw new Error("Codex CLI did not return a thread id");
}

console.error("stage=cli-first-turn");
const filler = "这只是长上下文压缩样本，不是项目事实、规则、授权或任务。".repeat(300);
const initialEvents = codex([
  "--enable",
  "hooks",
  "exec",
  "--disable",
  "plugins",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--json",
  "--color",
  "never",
  "-m",
  "gpt-5.4",
  "-C",
  projectRoot,
], `$identity-pm 以PM身份进入本次隔离测试。只回答“PM已登记”，不要修改文件。${filler}`, firstOutput);
const existingThreadId = threadId(initialEvents);

console.error(`stage=app-server-compact thread=${existingThreadId}`);
const child = spawn("pwsh.exe", ["-NoProfile", "-File", codexScript, "app-server", "--stdio", "--enable", "hooks"], {
  cwd: projectRoot,
  env: process.env,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
let nextId = 1;
const pending = new Map();
const notifications = [];
let appServerStderr = "";
child.stderr.on("data", (chunk) => { appServerStderr += chunk.toString(); });
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(String(message.id))) {
    const waiter = pending.get(String(message.id));
    pending.delete(String(message.id));
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  } else if (message.method) notifications.push(message);
});

function request(method, params, timeoutMs = 120000) {
  const id = String(nextId++);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolvePromise(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

async function waitForCompaction(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = notifications.find((message) => message.method === "thread/compacted"
      || (message.method === "item/completed"
        && message.params?.threadId === existingThreadId
        && message.params?.item?.type === "contextCompaction"));
    if (found) return found;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("manual compaction notification timed out");
}

try {
  await request("initialize", {
    clientInfo: { name: "beyond-real-compaction-cli", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  await request("thread/resume", { threadId: existingThreadId });
  await request("thread/compact/start", { threadId: existingThreadId });
  await waitForCompaction();
} catch (error) {
  throw new Error(`${error.message}\n${appServerStderr}`);
} finally {
  child.stdin.end();
  child.kill();
}

console.error("stage=cli-resume-after-compact");
const resumedEvents = codex([
  "--enable",
  "hooks",
  "exec",
  "--disable",
  "plugins",
  "resume",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--json",
  "-m",
  "gpt-5.4",
  existingThreadId,
], "可以，继续。只回答当前身份仍然是PM，并说明不会直接修改业务文件；不要调用工具。", secondOutput);

const observed = JSON.parse(readFileSync(join(projectRoot, "local", "runtime", "hook-observed.json"), "utf8"));
const identityRestoreHookSeen = observed.events?.some((entry) => entry.event === "SessionStart"
  && ["compact", "resume"].includes(entry.source)
  && new Date(entry.observedAt) >= startedAt);
const secondMessage = readFileSync(secondOutput, "utf8").trim();
const responseKeptPm = /PM/.test(secondMessage) && /不.{0,12}修改|不会.{0,12}修改|不得.{0,12}修改/.test(secondMessage);
const result = {
  startedAt: startedAt.toISOString(),
  threadId: existingThreadId,
  manualCompactionCompleted: true,
  identityRestoreHookSeen,
  responseKeptPm,
  secondMessage,
  initialEventBytes: Buffer.byteLength(initialEvents),
  resumedEventBytes: Buffer.byteLength(resumedEvents),
  notificationMethods: [...new Set(notifications.map((message) => message.method))].sort(),
};
writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
if (!identityRestoreHookSeen || !responseKeptPm) throw new Error(`real compaction assertions failed: ${JSON.stringify(result)}`);
console.log(`真实PM长上下文压缩回归通过：thread=${existingThreadId}`);
