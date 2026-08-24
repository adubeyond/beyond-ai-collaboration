import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "模板交付包");
const verifier = join(packageRoot, "scripts", "verify-install-integrity.mjs");
const scratch = mkdtempSync(join(tmpdir(), "beyond-install-integrity-"));
let passed = 0;
const errors = [];

function run(name, expectedStatus, skillsRoot, agentsPath, expectedText, contentOnly = true) {
  const args = [verifier, "--installed-skills-root", skillsRoot, "--project-agents", agentsPath];
  if (contentOnly) args.push("--content-only");
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== expectedStatus || (expectedText && !output.includes(expectedText))) {
    errors.push(`${name}：期望退出码${expectedStatus}且包含“${expectedText}”，实际退出码${result.status}\n${output}`);
  } else passed += 1;
}

function copySkills(root) {
  cpSync(join(packageRoot, "skills"), join(root, "skills"), { recursive: true });
}

function fusedEntry(controlRelative, projectId) {
  return cpEntry()
    .replace(
      "<!-- BEYOND-RUNTIME-VERSION: 3.2.2 -->",
      `<!-- BEYOND-RUNTIME-VERSION: 3.2.2 -->\n<!-- BEYOND-CONTROL-ROOT: ${controlRelative} -->\n<!-- BEYOND-PROJECT-ID: ${projectId} -->`,
    )
    .replace(/\]\(docs\//g, `](${controlRelative}/docs/`)
    .replace(/\]\(local\//g, `](${controlRelative}/local/`)
    .replace(/\]\(projects\//g, `](${controlRelative}/projects/`)
    + "\n\n<!-- BEGIN PROJECT NATIVE RULES -->\n# 原项目规则\n\n- 保留真实测试命令。\n<!-- END PROJECT NATIVE RULES -->\n";
}

function cpEntry() {
  return readFileSync(join(packageRoot, "AGENTS.md"), "utf8");
}

function writeProjectOverview(controlRoot, projectId) {
  const path = join(controlRoot, "projects", projectId, "项目总览.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# 安装验真项目总览

## 项目初始化

<!-- BEGIN BEYOND PROJECT INITIALIZATION -->
\`\`\`json
{"schemaVersion":1,"status":"awaiting-choice","mode":null,"approvedBy":null,"approvedAt":null,"groups":{"overview":null,"architecture":null,"development":null,"testing":null,"operations":null,"security":null,"other":null},"completedAt":null}
\`\`\`
<!-- END BEYOND PROJECT INITIALIZATION -->

## Worker运行策略

<!-- BEGIN BEYOND WORKER POLICY -->
\`\`\`json
{"schemaVersion":1,"mode":"platform-default","scope":"new-formal-worker","confirmed":false,"approvedBy":null,"approvedAt":null}
\`\`\`
<!-- END BEYOND WORKER POLICY -->
`, "utf8");
}

try {
  const exactRoot = join(scratch, "exact");
  copySkills(exactRoot);
  cpSync(join(packageRoot, "AGENTS.md"), join(exactRoot, "AGENTS.md"));
  run("完全一致内容", 0, join(exactRoot, "skills"), join(exactRoot, "AGENTS.md"), "内容验真通过");

  const controlRoot = join(scratch, "beyond-control");
  cpSync(packageRoot, controlRoot, { recursive: true });
  writeProjectOverview(controlRoot, "project-demo");
  writeProjectOverview(controlRoot, "project-third-party");
  const fusedRoot = join(scratch, "fused");
  copySkills(fusedRoot);
  writeFileSync(join(fusedRoot, "AGENTS.md"), fusedEntry("../beyond-control", "project-demo"), "utf8");
  run("完整融合项目入口", 0, join(fusedRoot, "skills"), join(fusedRoot, "AGENTS.md"), "安装验真通过", false);

  const missingInitializationId = "project-missing-init";
  const missingInitializationOverview = join(controlRoot, "projects", missingInitializationId, "项目总览.md");
  mkdirSync(dirname(missingInitializationOverview), { recursive: true });
  writeFileSync(missingInitializationOverview, `# 旧项目总览\n\n## Worker运行策略\n\n<!-- BEGIN BEYOND WORKER POLICY -->\n\`\`\`json\n{"schemaVersion":1,"mode":"platform-default","scope":"new-formal-worker","confirmed":false,"approvedBy":null,"approvedAt":null}\n\`\`\`\n<!-- END BEYOND WORKER POLICY -->\n`, "utf8");
  const missingInitializationRoot = join(scratch, "missing-initialization");
  copySkills(missingInitializationRoot);
  writeFileSync(join(missingInitializationRoot, "AGENTS.md"), fusedEntry("../beyond-control", missingInitializationId), "utf8");
  run("旧项目缺少初始化状态", 1, join(missingInitializationRoot, "skills"), join(missingInitializationRoot, "AGENTS.md"), "缺少唯一项目初始化受管块", false);

  const thirdPartyRoot = join(scratch, "third-party-hook");
  copySkills(thirdPartyRoot);
  writeFileSync(join(thirdPartyRoot, "AGENTS.md"), fusedEntry("../beyond-control", "project-third-party"), "utf8");
  mkdirSync(join(thirdPartyRoot, ".codex"), { recursive: true });
  writeFileSync(join(thirdPartyRoot, ".codex", "hooks.json"), `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node .codex/native-hook.mjs" }] }] } }, null, 2)}\n`, "utf8");
  run("第三方Hook不属于BEYOND失败", 0, join(thirdPartyRoot, "skills"), join(thirdPartyRoot, "AGENTS.md"), "安装验真通过", false);

  const wrongControlRoot = join(scratch, "wrong-control");
  copySkills(wrongControlRoot);
  writeFileSync(join(wrongControlRoot, "AGENTS.md"), fusedEntry("../missing-control", "project-demo"), "utf8");
  run("错误控制仓映射", 1, join(wrongControlRoot, "skills"), join(wrongControlRoot, "AGENTS.md"), "项目映射的控制仓版本清单不存在", false);

  const missingRuntimeControl = join(scratch, "missing-runtime-control");
  cpSync(packageRoot, missingRuntimeControl, { recursive: true });
  writeProjectOverview(missingRuntimeControl, "project-missing-runtime");
  rmSync(join(missingRuntimeControl, "scripts", "runtime", "control-runtime.mjs"));
  const missingRuntimeRoot = join(scratch, "missing-runtime-project");
  copySkills(missingRuntimeRoot);
  writeFileSync(
    join(missingRuntimeRoot, "AGENTS.md"),
    fusedEntry("../missing-runtime-control", "project-missing-runtime"),
    "utf8",
  );
  run(
    "控制运行模块缺失",
    1,
    join(missingRuntimeRoot, "skills"),
    join(missingRuntimeRoot, "AGENTS.md"),
    "项目映射的控制运行文件scripts/runtime/control-runtime.mjs不存在",
    false,
  );

  const mixedRoot = join(scratch, "mixed");
  copySkills(mixedRoot);
  cpSync(join(packageRoot, "AGENTS.md"), join(mixedRoot, "AGENTS.md"));
  writeFileSync(join(mixedRoot, "skills", "identity-pm", "SKILL.md"), `${readFileSync(join(mixedRoot, "skills", "identity-pm", "SKILL.md"), "utf8")}\n<!-- stale -->\n`, "utf8");
  run("旧Skill混入", 1, join(mixedRoot, "skills"), join(mixedRoot, "AGENTS.md"), "安装Skill内容不一致");

  const oldEntryRoot = join(scratch, "old-entry");
  copySkills(oldEntryRoot);
  writeFileSync(join(oldEntryRoot, "AGENTS.md"), cpEntry().replace(/<!-- BEYOND-RUNTIME-VERSION: [^>]+ -->\r?\n/, ""), "utf8");
  run("旧项目入口混入", 1, join(oldEntryRoot, "skills"), join(oldEntryRoot, "AGENTS.md"), "缺少目标版本标记");

  const staleGuardRoot = join(scratch, "stale-guard");
  copySkills(staleGuardRoot);
  cpSync(join(packageRoot, "AGENTS.md"), join(staleGuardRoot, "AGENTS.md"));
  mkdirSync(join(staleGuardRoot, ".codex"), { recursive: true });
  writeFileSync(join(staleGuardRoot, ".codex", "beyond-runtime-guard.mjs"), "// BEYOND_RUNTIME_IDENTITY\n", "utf8");
  run("旧身份护栏脚本残留", 1, join(staleGuardRoot, "skills"), join(staleGuardRoot, "AGENTS.md"), "项目仍残留BEYOND身份护栏脚本");

  const staleHookRoot = join(scratch, "stale-hook");
  copySkills(staleHookRoot);
  cpSync(join(packageRoot, "AGENTS.md"), join(staleHookRoot, "AGENTS.md"));
  mkdirSync(join(staleHookRoot, ".codex"), { recursive: true });
  writeFileSync(join(staleHookRoot, ".codex", "hooks.json"), `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node .codex/beyond-runtime-guard.mjs" }] }] } }, null, 2)}\n`, "utf8");
  run("旧身份Hook残留", 1, join(staleHookRoot, "skills"), join(staleHookRoot, "AGENTS.md"), "仍引用BEYOND身份护栏");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`安装完整性回归失败：${errors.length}项；通过${passed}项`);
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(`安装完整性回归通过：${passed}项`);
