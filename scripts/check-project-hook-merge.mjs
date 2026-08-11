import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "模板交付包");
const scratch = mkdtempSync(join(tmpdir(), "beyond-project-hook-merge-"));
const controlRoot = join(scratch, "beyond-control");
const projectRoot = join(scratch, "business-project");
let passed = 0;
const errors = [];

function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else errors.push(`${name}${detail ? `：${detail}` : ""}`);
}

function run(args, cwd = controlRoot, input = null) {
  return spawnSync(process.execPath, args, { cwd, input, encoding: "utf8" });
}

try {
  cpSync(packageRoot, controlRoot, { recursive: true });
  mkdirSync(join(projectRoot, ".codex"), { recursive: true });
  writeFileSync(join(projectRoot, "AGENTS.md"), "# 原项目入口\n\n- 保留原生规则。\n", "utf8");
  writeFileSync(join(projectRoot, ".codex", "existing-hook.mjs"), "process.exit(0);\n", "utf8");
  writeFileSync(join(projectRoot, ".codex", "beyond-runtime-guard.mjs"), "// stale guard\n", "utf8");
  writeFileSync(join(projectRoot, ".codex", "hooks.json"), `${JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: "startup",
        hooks: [{ type: "command", command: "node .codex/existing-hook.mjs", timeout: 2 }],
      }],
    },
  }, null, 2)}\n`, "utf8");

  const install = run([
    join(controlRoot, "scripts", "beyond-control.mjs"),
    "install-project-entry",
    "--project-root",
    projectRoot,
    "--confirm-fusion",
    "yes",
    "--name",
    "测试业务项目",
  ]);
  check("项目入口安装成功", install.status === 0, install.stderr || install.stdout);

  const agents = readFileSync(join(projectRoot, "AGENTS.md"), "utf8");
  const projectId = agents.match(/<!-- BEYOND-PROJECT-ID: ([^\n]+) -->/)?.[1]?.trim();
  const hooks = JSON.parse(readFileSync(join(projectRoot, ".codex", "hooks.json"), "utf8"));
  const handlers = Object.fromEntries(Object.entries(hooks.hooks).map(([event, groups]) => [
    event,
    groups.flatMap((group) => group.hooks),
  ]));
  check("原项目Hook保留", handlers.SessionStart.some((handler) => handler.command === "node .codex/existing-hook.mjs"));
  check("四类身份Hook各唯一", ["SessionStart", "UserPromptSubmit", "PreToolUse", "SessionEnd"].every((event) =>
    handlers[event].filter((handler) => handler.command?.includes("beyond-runtime-guard.mjs")).length === 1));
  check("Hook固定控制仓与项目身份", Object.values(handlers).flat().filter((handler) => handler.command?.includes("beyond-runtime-guard.mjs"))
    .every((handler) => handler.command.includes('--control-root "../beyond-control"') && handler.command.includes(`--project-id "${projectId}"`)));
  check("候选身份脚本准确安装", readFileSync(join(projectRoot, ".codex", "beyond-runtime-guard.mjs"), "utf8")
    === readFileSync(join(controlRoot, ".codex", "beyond-runtime-guard.mjs"), "utf8"));

  const backupRoot = join(controlRoot, "local", "backups", "project-entry", projectId);
  const backups = existsSync(backupRoot) ? readdirSync(backupRoot) : [];
  check("原入口与运行文件已备份", backups.some((name) => name.endsWith("-AGENTS.md"))
    && backups.some((name) => name.endsWith("-hooks.json"))
    && backups.some((name) => name.endsWith("-beyond-runtime-guard.mjs")));

  const verify = run([
    join(controlRoot, "scripts", "verify-install-integrity.mjs"),
    "--installed-skills-root",
    join(controlRoot, "skills"),
    "--project-agents",
    join(projectRoot, "AGENTS.md"),
    "--content-only",
  ]);
  check("融合内容验真通过", verify.status === 0 && verify.stdout.includes("内容验真通过"), verify.stderr || verify.stdout);

  const guardCommand = handlers.UserPromptSubmit.find((handler) => handler.command?.includes("beyond-runtime-guard.mjs")).command;
  const controlRelative = guardCommand.match(/--control-root\s+"([^"]+)"/)?.[1];
  const boundProjectId = guardCommand.match(/--project-id\s+"([^"]+)"/)?.[1];
  const guardArgs = [
    join(projectRoot, ".codex", "beyond-runtime-guard.mjs"),
    "--control-root",
    controlRelative,
    "--project-id",
    boundProjectId,
  ];
  const register = run(guardArgs, projectRoot, JSON.stringify({
    session_id: "root-replacement-session",
    hook_event_name: "UserPromptSubmit",
    prompt: "$identity-pm 接手",
  }));
  check("融合项目PM身份登记", register.status === 0 && register.stdout.includes("BEYOND_RUNTIME_IDENTITY=PM"));

  writeFileSync(join(projectRoot, "AGENTS.md"), "# 被外部替换的项目入口\n", "utf8");
  const compact = run(guardArgs, projectRoot, JSON.stringify({
    session_id: "root-replacement-session",
    hook_event_name: "SessionStart",
    source: "compact",
  }));
  check("根入口替换后压缩恢复身份", compact.status === 0 && compact.stdout.includes("BEYOND_RUNTIME_IDENTITY=PM"));
  const denied = run(guardArgs, projectRoot, JSON.stringify({
    session_id: "root-replacement-session",
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch" },
  }));
  const deniedBody = denied.stdout ? JSON.parse(denied.stdout) : null;
  check("根入口替换后PM写入仍阻断", deniedBody?.hookSpecificOutput?.permissionDecision === "deny");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`项目Hook融合回归失败：${errors.length}项；通过${passed}项`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`项目Hook融合回归通过：${passed}项`);
