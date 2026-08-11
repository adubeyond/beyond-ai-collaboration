import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const runtimeVersion = "3.1.0";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const installedControlRoot = arg("--control-root");
const installedProjectId = arg("--project-id");

let input = "";
for await (const chunk of process.stdin) input += chunk;

function output(value) {
  process.stdout.write(JSON.stringify(value));
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

function validControlRoot(root) {
  try {
    return JSON.parse(readFileSync(join(root, "beyond-release.json"), "utf8")).releaseVersion === runtimeVersion;
  } catch {
    return false;
  }
}

function controlRootForProject() {
  if (installedControlRoot) {
    const installed = resolve(projectRoot, installedControlRoot);
    return validControlRoot(installed) ? installed : null;
  }
  if (validControlRoot(projectRoot)) return projectRoot;
  const agents = safeRead(join(projectRoot, "AGENTS.md"));
  const marker = agents?.match(/<!-- BEYOND-CONTROL-ROOT: ([^\n]+) -->/);
  if (!marker) return null;
  const mapped = resolve(projectRoot, marker[1].trim());
  return validControlRoot(mapped) ? mapped : null;
}

function sessionKey(sessionId) {
  return createHash("sha256").update(String(sessionId)).digest("hex");
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function hookResult(hookEventName, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function singleFixedNodeCommand(command, scriptName) {
  if (/[;&|`<>\r\n]|\$\(|@\(/.test(command)) return false;
  const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const script = `(?:"[^"]*${escaped}"|'[^']*${escaped}'|[^\\s"']*${escaped})`;
  return new RegExp(`^\\s*node(?:\\.exe)?\\s+${script}(?:\\s+[^;&|\\r\\n<>]*)?\\s*$`, "i").test(command);
}

function registerRequest(command) {
  return singleFixedNodeCommand(command, "beyond-control.mjs")
    && /beyond-control\.mjs["']?\s+runtime-identity\s+--role\s+pm\s*$/i.test(command);
}

function fixedControlCommand(command) {
  return singleFixedNodeCommand(command, "beyond-control.mjs")
    || singleFixedNodeCommand(command, "verify-install-integrity.mjs");
}

function pmShellAllowed(command) {
  if (fixedControlCommand(command)) return true;
  const forbidden = [
    /(?:^|[;&|\n]\s*)(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Clear-Content|Start-Process|Stop-Process)\b/i,
    /(?:^|[;&|\n]\s*)(?:rm|del|erase|mv|cp|mkdir|rmdir|touch|tee)\b/i,
    /(?:^|[;&|\n]\s*)(?:ssh|scp|sftp|rsync|docker|kubectl|mysql|psql|sqlcmd)\b/i,
    /\bgit\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|clean|stash|tag|cherry-pick|revert)\b/i,
    /\b(?:npm|pnpm|yarn)\s+(?:install|add|remove|publish|deploy)\b/i,
    /(?:^|[;&|\n]\s*)(?:node|python|py|ruby|perl|php|java|cmd|powershell|pwsh)\b/i,
    /(?:^|[^<])>>?(?:[^>]|$)/,
  ];
  return !forbidden.some((pattern) => pattern.test(command));
}

function pmToolDenied(toolName) {
  const allowedThreadTools = new Set([
    "create_thread",
    "read_thread",
    "list_threads",
    "wait_threads",
    "send_message_to_thread",
    "handoff_thread",
    "set_thread_pinned",
    "set_thread_archived",
    "set_thread_title",
  ]);
  if (allowedThreadTools.has(toolName)) return false;
  const allowedControlTools = new Set([
    "Bash",
    "request_user_input",
    "update_plan",
    "get_goal",
    "view_image",
    "web__run",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
    "codex_app__read_thread_terminal",
  ]);
  return !allowedControlTools.has(toolName);
}

let event;
try {
  event = JSON.parse(input);
} catch {
  output({ systemMessage: "BEYOND身份护栏收到无效事件；本次未建立身份约束。" });
  process.exit(0);
}

const controlRoot = controlRootForProject();
if (!controlRoot) {
  output({ systemMessage: "BEYOND身份护栏找不到控制仓；请重新执行项目入口验真。" });
  process.exit(0);
}

const sessionId = String(event.session_id ?? "");
if (!sessionId) {
  output({ systemMessage: "BEYOND身份护栏缺少会话编号；本次未建立身份约束。" });
  process.exit(0);
}

const runtimeRoot = join(controlRoot, "local", "runtime");
const statePath = join(runtimeRoot, "identity-sessions", `${sessionKey(sessionId)}.json`);
const observedPath = join(runtimeRoot, "hook-observed.json");
let previousObserved = {};
if (existsSync(observedPath)) {
  try {
    previousObserved = JSON.parse(readFileSync(observedPath, "utf8"));
  } catch {
    previousObserved = {};
  }
}
atomicJson(observedPath, {
  runtimeVersion,
  lastEvent: event.hook_event_name,
  lastSession: sessionKey(sessionId).slice(0, 16),
  observedAt: new Date().toISOString(),
  projectRoot: projectRoot.replace(/\\/g, "/"),
  projectId: installedProjectId,
  events: [
    ...(Array.isArray(previousObserved.events) ? previousObserved.events : []),
    {
      event: event.hook_event_name,
      source: event.source ?? null,
      tool: event.tool_name ?? null,
      session: sessionKey(sessionId).slice(0, 16),
      observedAt: new Date().toISOString(),
    },
  ].slice(-20),
});

let state = null;
if (existsSync(statePath)) {
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    state = null;
  }
}

function register(role, source) {
  if (state && state.role !== role) return false;
  state = state ?? {
    schemaVersion: 1,
    sessionId,
    role,
    source,
    runtimeVersion,
    registeredAt: new Date().toISOString(),
  };
  atomicJson(statePath, state);
  return true;
}

const pmContext = "BEYOND_RUNTIME_IDENTITY=PM。只管理当前主线、工作台和用户可见Worker；不得加载Action Skill或直接修改业务代码、测试、运行环境、数据与生产。用户说“可以/继续”不改变身份，只推进最后明确批准的当前主线；历史后台不得自动晋升。";
const workerContext = "BEYOND_RUNTIME_IDENTITY=WORKER。继续对当前唯一业务结果负责；Action Skill只是方法，压缩、恢复和继续都不改变任务所有权。";

if (event.hook_event_name === "UserPromptSubmit") {
  const prompt = String(event.prompt ?? "");
  const requestedRole = /\$identity-pm(?:\b|：|:)/i.test(prompt)
    ? "pm"
    : /\$identity-worker(?:\b|：|:)/i.test(prompt)
      ? "worker"
      : null;
  if (requestedRole && !register(requestedRole, "explicit-skill")) {
    output(hookResult("UserPromptSubmit", `BEYOND_RUNTIME_IDENTITY=${state.role.toUpperCase()}。当前会话身份不可切换；请在新的用户可见任务中进入另一身份。`));
  } else if (state?.role === "pm") {
    output(hookResult("UserPromptSubmit", pmContext));
  } else if (state?.role === "worker") {
    output(hookResult("UserPromptSubmit", workerContext));
  }
  process.exit(0);
}

if (event.hook_event_name === "SessionStart") {
  if (state?.role === "pm") output(hookResult("SessionStart", pmContext));
  else if (state?.role === "worker") output(hookResult("SessionStart", workerContext));
  process.exit(0);
}

if (event.hook_event_name === "SessionEnd") {
  rmSync(statePath, { force: true });
  process.exit(0);
}

if (event.hook_event_name !== "PreToolUse") process.exit(0);

const toolName = String(event.tool_name ?? "");
const toolInput = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
const command = String(toolInput.command ?? "");

if (toolName === "Bash" && registerRequest(command)) {
  if (!register("pm", "pm-skill-fallback")) {
    output(deny("当前会话已经登记为Worker，不能在同一任务中切换为PM。"));
  } else {
    output({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "BEYOND PM身份已登记。",
        updatedInput: {
          ...toolInput,
          command: `${command} --hook-session ${sessionKey(sessionId)}`,
        },
      },
    });
  }
  process.exit(0);
}

if (state?.role !== "pm") process.exit(0);

if (toolName === "apply_patch") {
  output(deny("当前会话是PM控制面；业务文件修改必须交给用户可见的唯一Worker。"));
} else if (toolName === "Bash" && !pmShellAllowed(command)) {
  output(deny("当前会话是PM控制面；该命令可能产生业务、Git、环境或外部写入，请交给Worker或使用BEYOND固定控制脚本。"));
} else if (pmToolDenied(toolName)) {
  output(deny("当前会话是PM控制面；该工具不属于主线、工作台或用户可见Worker管理。"));
}
