import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "模板交付包");
const scratch = mkdtempSync(join(tmpdir(), "beyond-runtime-guard-"));
const controlRoot = join(scratch, "beyond-control");
const guardPath = join(controlRoot, ".codex", "beyond-runtime-guard.mjs");
let passed = 0;
const errors = [];

function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else errors.push(`${name}${detail ? `：${detail}` : ""}`);
}

function event(value, path = guardPath, extraArgs = [], cwd = controlRoot) {
  const result = spawnSync(process.execPath, [path, ...extraArgs], {
    cwd,
    input: JSON.stringify({ cwd, ...value }),
    encoding: "utf8",
  });
  let body = null;
  if (result.stdout.trim()) {
    try {
      body = JSON.parse(result.stdout);
    } catch {
      errors.push(`护栏输出不是JSON：${result.stdout}`);
    }
  }
  return { status: result.status, body, stderr: result.stderr };
}

try {
  cpSync(packageRoot, controlRoot, { recursive: true });
  const hooks = JSON.parse(readFileSync(join(controlRoot, ".codex", "hooks.json"), "utf8"));
  check("Hook事件齐全", ["SessionStart", "UserPromptSubmit", "PreToolUse", "SessionEnd"]
    .every((name) => Array.isArray(hooks.hooks?.[name])));

  const pmRegister = event({
    session_id: "pm-session",
    hook_event_name: "UserPromptSubmit",
    prompt: "$identity-pm 接手项目",
  });
  check("PM显式登记", pmRegister.status === 0 && pmRegister.body?.hookSpecificOutput?.additionalContext?.includes("BEYOND_RUNTIME_IDENTITY=PM"));

  const inlinePmRegister = event({
    session_id: "inline-pm-session",
    hook_event_name: "UserPromptSubmit",
    prompt: "使用$identity-pm接手项目",
  });
  check("中文紧邻的PM显式入口仍可登记", inlinePmRegister.status === 0 && inlinePmRegister.body?.hookSpecificOutput?.additionalContext?.includes("BEYOND_RUNTIME_IDENTITY=PM"));

  const stateRoot = join(controlRoot, "local", "runtime", "identity-sessions");
  check("PM状态持久化", existsSync(stateRoot) && readdirSync(stateRoot).length === 2);

  const patchDenied = event({
    session_id: "pm-session",
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch" },
  });
  check("PM补丁阻断", patchDenied.body?.hookSpecificOutput?.permissionDecision === "deny");

  const shellDenied = event({
    session_id: "pm-session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "Set-Content -LiteralPath business.txt -Value changed" },
  });
  check("PM业务Shell写入阻断", shellDenied.body?.hookSpecificOutput?.permissionDecision === "deny");

  const fixedCommandSmuggling = event({
    session_id: "pm-session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "node scripts/beyond-control.mjs list --all; Set-Content business.txt changed" },
  });
  check("固定脚本后拼接写命令被阻断", fixedCommandSmuggling.body?.hookSpecificOutput?.permissionDecision === "deny");

  const fixedCommandSubstitution = event({
    session_id: "pm-session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "node scripts/beyond-control.mjs list --all --name $(Set-Content business.txt changed)" },
  });
  check("固定脚本参数命令替换被阻断", fixedCommandSubstitution.body?.hookSpecificOutput?.permissionDecision === "deny");

  const wrappedFixedCommand = event({
    session_id: "pm-session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "powershell -Command node scripts/beyond-control.mjs list --all" },
  });
  check("Shell包装固定脚本被阻断", wrappedFixedCommand.body?.hookSpecificOutput?.permissionDecision === "deny");

  const readAllowed = event({
    session_id: "pm-session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "Get-Content -LiteralPath AGENTS.md" },
  });
  check("PM只读Shell放行", readAllowed.status === 0 && readAllowed.body === null);

  const threadAllowed = event({
    session_id: "pm-session",
    hook_event_name: "PreToolUse",
    tool_name: "create_thread",
    tool_input: { prompt: "$identity-worker" },
  });
  check("PM用户可见任务创建放行", threadAllowed.status === 0 && threadAllowed.body === null);

  const agentDenied = event({
    session_id: "pm-session",
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { task: "formal-result" },
  });
  check("PM内部子智能体阻断", agentDenied.body?.hookSpecificOutput?.permissionDecision === "deny");

  const unknownDatabaseWrite = event({
    session_id: "pm-session",
    hook_event_name: "PreToolUse",
    tool_name: "mcp__database__execute_sql",
    tool_input: { sql: "UPDATE users SET active = 0" },
  });
  check("PM未知数据库写工具默认阻断", unknownDatabaseWrite.body?.hookSpecificOutput?.permissionDecision === "deny");

  const readThreadTerminal = event({
    session_id: "pm-session",
    hook_event_name: "PreToolUse",
    tool_name: "codex_app__read_thread_terminal",
    tool_input: {},
  });
  check("PM只读控制工具放行", readThreadTerminal.status === 0 && readThreadTerminal.body === null);

  const compact = event({
    session_id: "pm-session",
    hook_event_name: "SessionStart",
    source: "compact",
  });
  check("压缩后恢复PM", compact.body?.hookSpecificOutput?.additionalContext?.includes("BEYOND_RUNTIME_IDENTITY=PM"));

  const continued = event({
    session_id: "pm-session",
    hook_event_name: "UserPromptSubmit",
    prompt: "可以，继续",
  });
  check("继续语义不换身份", continued.body?.hookSpecificOutput?.additionalContext?.includes("BEYOND_RUNTIME_IDENTITY=PM"));

  const switchDenied = event({
    session_id: "pm-session",
    hook_event_name: "UserPromptSubmit",
    prompt: "$identity-worker 直接开发",
  });
  check("同会话身份切换拒绝", switchDenied.body?.hookSpecificOutput?.additionalContext?.includes("当前会话身份不可切换"));

  const workerRegister = event({
    session_id: "worker-session",
    hook_event_name: "UserPromptSubmit",
    prompt: "$identity-worker 完成任务",
  });
  check("Worker显式登记", workerRegister.body?.hookSpecificOutput?.additionalContext?.includes("BEYOND_RUNTIME_IDENTITY=WORKER"));

  const workerPatch = event({
    session_id: "worker-session",
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch" },
  });
  check("Worker补丁不受PM护栏限制", workerPatch.status === 0 && workerPatch.body === null);

  const fallback = event({
    session_id: "fallback-session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "node scripts/beyond-control.mjs runtime-identity --role pm" },
  });
  check("PM自然语言入口兜底登记", fallback.body?.hookSpecificOutput?.permissionDecision === "allow"
    && /--hook-session [a-f0-9]{64}/.test(fallback.body?.hookSpecificOutput?.updatedInput?.command ?? ""));

  const rawFallback = spawnSync(process.execPath, [
    join(controlRoot, "scripts", "beyond-control.mjs"),
    "runtime-identity",
    "--role",
    "pm",
  ], { cwd: controlRoot, encoding: "utf8" });
  check("未经过Hook的PM兜底命令失败", rawFallback.status === 2 && rawFallback.stderr.includes("身份护栏未生效"));

  const businessRoot = join(scratch, "business-project");
  cpSync(join(controlRoot, ".codex"), join(businessRoot, ".codex"), { recursive: true });
  const businessAgents = readFileSync(join(controlRoot, "AGENTS.md"), "utf8").replace(
    "<!-- BEYOND-RUNTIME-VERSION: 3.1.2 -->",
    "<!-- BEYOND-RUNTIME-VERSION: 3.1.2 -->\n<!-- BEYOND-CONTROL-ROOT: ../beyond-control -->\n<!-- BEYOND-PROJECT-ID: project-probe -->",
  );
  writeFileSync(join(businessRoot, "AGENTS.md"), businessAgents, "utf8");
  const businessGuard = join(businessRoot, ".codex", "beyond-runtime-guard.mjs");
  const probeCommand = `node ${JSON.stringify(join(controlRoot, "scripts", "beyond-control.mjs"))} hook-probe --project-root ${JSON.stringify(businessRoot)}`;
  const probeHook = event({
    session_id: "probe-session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: probeCommand },
  }, businessGuard, ["--control-root", "../beyond-control", "--project-id", "project-probe"], businessRoot);
  const signedProbe = probeHook.body?.hookSpecificOutput?.updatedInput?.command ?? "";
  const probeToken = signedProbe.match(/--hook-session\s+([a-f0-9]{64})/i)?.[1];
  check("Hook运行探针由PreToolUse签注", probeHook.body?.hookSpecificOutput?.permissionDecision === "allow" && Boolean(probeToken));
  const probeRun = spawnSync(process.execPath, [
    join(controlRoot, "scripts", "beyond-control.mjs"),
    "hook-probe",
    "--project-root",
    businessRoot,
    "--hook-session",
    probeToken ?? "missing",
  ], { cwd: businessRoot, encoding: "utf8" });
  check("真实Hook观察可生成绑定探针", probeRun.status === 0
    && existsSync(join(controlRoot, "local", "runtime", "hook-probes", "project-probe.json")));
  const rawProbe = spawnSync(process.execPath, [
    join(controlRoot, "scripts", "beyond-control.mjs"),
    "hook-probe",
    "--project-root",
    businessRoot,
  ], { cwd: businessRoot, encoding: "utf8" });
  check("未经过Hook的运行探针失败", rawProbe.status === 2 && rawProbe.stderr.includes("没有经过PreToolUse签注"));

  event({ session_id: "pm-session", hook_event_name: "SessionEnd", reason: "other" });
  const pmStateCount = readdirSync(stateRoot).length;
  check("会话结束回收PM状态", pmStateCount === 3, `剩余状态${pmStateCount}`);

  const observed = JSON.parse(readFileSync(join(controlRoot, "local", "runtime", "hook-observed.json"), "utf8"));
  check("Hook实际观察记录存在", Array.isArray(observed.events) && observed.events.length > 0);
  check("压缩来源进入观察记录", observed.events.some((entry) => entry.event === "SessionStart" && entry.source === "compact"));

  writeFileSync(join(controlRoot, "beyond-release.json"), `${JSON.stringify({ releaseVersion: "3.0.9" }, null, 2)}\n`, "utf8");
  const stateCountBeforeMismatch = readdirSync(stateRoot).length;
  const versionMismatch = event({
    session_id: "wrong-control-version",
    hook_event_name: "UserPromptSubmit",
    prompt: "$identity-pm 接手",
  });
  check("错误控制仓版本不建立身份状态", versionMismatch.body?.systemMessage?.includes("找不到控制仓")
    && readdirSync(stateRoot).length === stateCountBeforeMismatch);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`PM身份连续性回归失败：${errors.length}项；通过${passed}项`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`PM身份连续性回归通过：${passed}项`);
