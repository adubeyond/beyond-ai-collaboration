import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "模板交付包");
const scratch = mkdtempSync(join(tmpdir(), "beyond-project-entry-migration-"));
const controlRoot = join(scratch, "beyond-control");
const projectRoot = join(scratch, "business-project");
let passed = 0;
const errors = [];

function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else errors.push(`${name}${detail ? `：${detail}` : ""}`);
}

function run(args, cwd = controlRoot) {
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
}

function legacyHooks(includeNative = true) {
  const native = includeNative ? [{ type: "command", command: "node .codex/existing-hook.mjs", timeout: 2 }] : [];
  return `${JSON.stringify({
    keepTopLevel: "preserved",
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [...native, { type: "command", command: "node .codex/beyond-runtime-guard.mjs --role pm" }] }],
      PreToolUse: [{ hooks: [{ type: "command", commandWindows: "node .codex/beyond-runtime-guard.mjs" }] }],
    },
  }, null, 2)}\n`;
}

try {
  cpSync(packageRoot, controlRoot, { recursive: true });
  mkdirSync(join(projectRoot, ".codex"), { recursive: true });
  writeFileSync(join(projectRoot, "AGENTS.md"), "# 原项目入口\n\n- 保留原生规则。\n", "utf8");
  writeFileSync(join(projectRoot, ".codex", "existing-hook.mjs"), "process.exit(0);\n", "utf8");
  writeFileSync(join(projectRoot, ".codex", "beyond-runtime-guard.mjs"), "// BEYOND_RUNTIME_IDENTITY\n", "utf8");
  writeFileSync(join(projectRoot, ".codex", "hooks.json"), legacyHooks(), "utf8");

  mkdirSync(join(controlRoot, ".codex"), { recursive: true });
  writeFileSync(join(controlRoot, ".codex", "beyond-runtime-guard.mjs"), "// installedControlRoot\n", "utf8");
  writeFileSync(join(controlRoot, ".codex", "hooks.json"), legacyHooks(false), "utf8");
  for (const relative of ["identity-sessions/old.json", "hook-probes/old.json", "hook-observed.json"]) {
    const target = join(controlRoot, "local", "runtime", relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "{}\n", "utf8");
  }

  const command = [
    join(controlRoot, "scripts", "beyond-control.mjs"), "install-project-entry",
    "--project-root", projectRoot, "--confirm-fusion", "yes", "--name", "测试业务项目",
  ];
  const install = run(command);
  check("项目入口迁移成功", install.status === 0, install.stderr || install.stdout);

  const agents = readFileSync(join(projectRoot, "AGENTS.md"), "utf8");
  const projectId = agents.match(/<!-- BEYOND-PROJECT-ID: ([^\n]+) -->/)?.[1]?.trim();
  check("原项目规则保留", agents.includes("保留原生规则"));
  check("建立控制仓映射", Boolean(projectId) && agents.includes("BEYOND-CONTROL-ROOT"));

  const projectHooks = JSON.parse(readFileSync(join(projectRoot, ".codex", "hooks.json"), "utf8"));
  const projectHookText = JSON.stringify(projectHooks);
  check("第三方Hook保留", projectHookText.includes("existing-hook.mjs") && projectHooks.keepTopLevel === "preserved");
  check("项目旧BEYOND处理器清除", !projectHookText.includes("beyond-runtime-guard.mjs"));
  check("项目旧护栏脚本清除", !existsSync(join(projectRoot, ".codex", "beyond-runtime-guard.mjs")));
  const controlHooks = JSON.parse(readFileSync(join(controlRoot, ".codex", "hooks.json"), "utf8"));
  check("控制仓旧BEYOND处理器清除且其他配置保留", controlHooks.keepTopLevel === "preserved"
    && !JSON.stringify(controlHooks).includes("beyond-runtime-guard.mjs"));
  check("控制仓旧护栏脚本清除", !existsSync(join(controlRoot, ".codex", "beyond-runtime-guard.mjs")));
  check("旧运行身份状态清除", ["identity-sessions", "hook-probes", "hook-observed.json"]
    .every((name) => !existsSync(join(controlRoot, "local", "runtime", name))));

  const backupRoot = join(controlRoot, "local", "backups", "project-entry", projectId);
  const backups = existsSync(backupRoot) ? readdirSync(backupRoot) : [];
  check("迁移前入口与旧运行文件已备份", ["-AGENTS.md", "-project-hooks.json", "-project-beyond-runtime-guard.mjs", "-control-hooks.json", "-control-beyond-runtime-guard.mjs"]
    .every((suffix) => backups.some((name) => name.endsWith(suffix))));

  const verify = run([
    join(controlRoot, "scripts", "verify-install-integrity.mjs"),
    "--installed-skills-root", join(controlRoot, "skills"),
    "--project-agents", join(projectRoot, "AGENTS.md"),
  ]);
  check("无Hook完整安装验真通过", verify.status === 0 && verify.stdout.includes("标准路径不依赖BEYOND Hook"), verify.stderr || verify.stdout);

  const repeat = run(command);
  check("重复迁移幂等", repeat.status === 0, repeat.stderr || repeat.stdout);
  check("重复迁移不重建BEYOND Hook", !existsSync(join(projectRoot, ".codex", "beyond-runtime-guard.mjs"))
    && !JSON.stringify(JSON.parse(readFileSync(join(projectRoot, ".codex", "hooks.json"), "utf8"))).includes("beyond-runtime-guard.mjs"));

  const invalidControl = join(scratch, "invalid-control");
  const invalidProject = join(scratch, "invalid-project");
  cpSync(packageRoot, invalidControl, { recursive: true });
  mkdirSync(join(invalidProject, ".codex"), { recursive: true });
  writeFileSync(join(invalidProject, "AGENTS.md"), "# 不得覆盖的入口\n", "utf8");
  writeFileSync(join(invalidProject, ".codex", "hooks.json"), "{ invalid json\n", "utf8");
  const invalid = run([
    join(invalidControl, "scripts", "beyond-control.mjs"), "install-project-entry",
    "--project-root", invalidProject, "--confirm-fusion", "yes",
  ], invalidControl);
  check("无法解析的Hook配置停止受影响迁移", invalid.status !== 0);
  check("失败前不覆盖项目入口", readFileSync(join(invalidProject, "AGENTS.md"), "utf8") === "# 不得覆盖的入口\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`项目入口迁移回归失败：${errors.length}项；通过${passed}项`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`项目入口迁移回归通过：${passed}项`);
