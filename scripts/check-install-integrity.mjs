import { createHash } from "node:crypto";
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
  const args = [
    verifier,
    "--installed-skills-root",
    skillsRoot,
    "--project-agents",
    agentsPath,
  ];
  if (contentOnly) args.push("--content-only");
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== expectedStatus || (expectedText && !output.includes(expectedText))) {
    errors.push(`${name}：期望退出码${expectedStatus}且包含“${expectedText}”，实际退出码${result.status}\n${output}`);
  } else {
    passed += 1;
  }
}

function copyRuntime(root) {
  cpSync(join(packageRoot, ".codex"), join(root, ".codex"), { recursive: true });
}

function bindRuntime(root, controlRelative, projectId) {
  const path = join(root, ".codex", "hooks.json");
  const hooks = JSON.parse(readFileSync(path, "utf8"));
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        if (handler.command?.includes("beyond-runtime-guard.mjs")) {
          handler.command += ` --control-root ${JSON.stringify(controlRelative)} --project-id ${JSON.stringify(projectId)}`;
        }
      }
    }
  }
  writeFileSync(path, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeRuntimeProof(controlRoot, projectRoot, projectId) {
  const proofPath = join(controlRoot, "local", "runtime", "hook-probes", `${projectId}.json`);
  mkdirSync(dirname(proofPath), { recursive: true });
  writeFileSync(proofPath, `${JSON.stringify({
    schemaVersion: 1,
    releaseVersion: "3.1.1",
    projectId,
    projectRoot: projectRoot.replace(/\\/g, "/"),
    hooksSha256: sha256(join(projectRoot, ".codex", "hooks.json")),
    guardSha256: sha256(join(projectRoot, ".codex", "beyond-runtime-guard.mjs")),
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

try {
  const exactRoot = join(scratch, "exact");
  cpSync(join(packageRoot, "skills"), join(exactRoot, "skills"), { recursive: true });
  cpSync(join(packageRoot, "AGENTS.md"), join(exactRoot, "AGENTS.md"));
  copyRuntime(exactRoot);
  run("完全一致安装", 0, join(exactRoot, "skills"), join(exactRoot, "AGENTS.md"), "内容验真通过");

  const explicitOverride = readFileSync(join(exactRoot, "AGENTS.md"), "utf8").replace(
    "<!-- 没有项目特有覆盖时保持为空。 -->",
    "- 正式工作目录：项目根目录。\n- Worker批量数据核对使用Luna高推理。",
  );
  writeFileSync(join(exactRoot, "AGENTS.md"), explicitOverride, "utf8");
  run("合法项目覆盖", 0, join(exactRoot, "skills"), join(exactRoot, "AGENTS.md"), "内容验真通过");

  const fusedRoot = join(scratch, "fused");
  cpSync(packageRoot, join(scratch, "beyond-control"), { recursive: true });
  cpSync(join(packageRoot, "skills"), join(fusedRoot, "skills"), { recursive: true });
  copyRuntime(fusedRoot);
  const fused = readFileSync(join(packageRoot, "AGENTS.md"), "utf8")
    .replace(
      "<!-- BEYOND-RUNTIME-VERSION: 3.1.1 -->",
      "<!-- BEYOND-RUNTIME-VERSION: 3.1.1 -->\n<!-- BEYOND-CONTROL-ROOT: ../beyond-control -->\n<!-- BEYOND-PROJECT-ID: project-demo -->",
    )
    .replace(/\]\(docs\//g, "](../beyond-control/docs/")
    .replace(/\]\(local\//g, "](../beyond-control/local/")
    .replace(/\]\(projects\//g, "](../beyond-control/projects/") +
    "\n\n<!-- BEGIN PROJECT NATIVE RULES -->\n# 原项目规则\n\n- 保留真实测试命令。\n<!-- END PROJECT NATIVE RULES -->\n";
  writeFileSync(join(fusedRoot, "AGENTS.md"), fused, "utf8");
  bindRuntime(fusedRoot, "../beyond-control", "project-demo");
  writeRuntimeProof(join(scratch, "beyond-control"), fusedRoot, "project-demo");
  run("完整融合项目入口", 0, join(fusedRoot, "skills"), join(fusedRoot, "AGENTS.md"), "安装验真通过", false);

  const wrongControlRoot = join(scratch, "wrong-control");
  cpSync(join(packageRoot, "skills"), join(wrongControlRoot, "skills"), { recursive: true });
  copyRuntime(wrongControlRoot);
  writeFileSync(join(wrongControlRoot, "AGENTS.md"), fused.replaceAll("../beyond-control", "../missing-control"), "utf8");
  bindRuntime(wrongControlRoot, "../missing-control", "project-demo");
  run("错误控制仓映射", 1, join(wrongControlRoot, "skills"), join(wrongControlRoot, "AGENTS.md"), "项目映射的控制仓版本清单不存在", false);

  const mixedRoot = join(scratch, "mixed");
  cpSync(join(packageRoot, "skills"), join(mixedRoot, "skills"), { recursive: true });
  cpSync(join(packageRoot, "AGENTS.md"), join(mixedRoot, "AGENTS.md"));
  copyRuntime(mixedRoot);
  const oldPm = `${readFileSync(join(mixedRoot, "skills", "identity-pm", "SKILL.md"), "utf8")}\n<!-- simulated stale installed Skill -->\n`;
  writeFileSync(join(mixedRoot, "skills", "identity-pm", "SKILL.md"), oldPm, "utf8");
  run("旧Skill混入", 1, join(mixedRoot, "skills"), join(mixedRoot, "AGENTS.md"), "安装Skill内容不一致");

  const oldEntryRoot = join(scratch, "old-entry");
  cpSync(join(packageRoot, "skills"), join(oldEntryRoot, "skills"), { recursive: true });
  copyRuntime(oldEntryRoot);
  const oldEntry = readFileSync(join(packageRoot, "AGENTS.md"), "utf8").replace(
    "<!-- BEYOND-RUNTIME-VERSION: 3.1.1 -->\n",
    "",
  );
  writeFileSync(join(oldEntryRoot, "AGENTS.md"), oldEntry, "utf8");
  run("旧项目入口混入", 1, join(oldEntryRoot, "skills"), join(oldEntryRoot, "AGENTS.md"), "缺少目标版本标记");

  const ambiguousRoot = join(scratch, "ambiguous");
  cpSync(join(packageRoot, "skills"), join(ambiguousRoot, "skills"), { recursive: true });
  copyRuntime(ambiguousRoot);
  const ambiguous = readFileSync(join(packageRoot, "AGENTS.md"), "utf8").replace(
    "<!-- 没有项目特有覆盖时保持为空。 -->",
    "- 所有正式任务统一使用Luna高推理。",
  );
  writeFileSync(join(ambiguousRoot, "AGENTS.md"), ambiguous, "utf8");
  run("模型覆盖缺少角色", 1, join(ambiguousRoot, "skills"), join(ambiguousRoot, "AGENTS.md"), "模型覆盖没有明确适用角色");

  const staleGuardRoot = join(scratch, "stale-guard");
  cpSync(join(packageRoot, "skills"), join(staleGuardRoot, "skills"), { recursive: true });
  cpSync(join(packageRoot, "AGENTS.md"), join(staleGuardRoot, "AGENTS.md"));
  copyRuntime(staleGuardRoot);
  writeFileSync(
    join(staleGuardRoot, ".codex", "beyond-runtime-guard.mjs"),
    `${readFileSync(join(staleGuardRoot, ".codex", "beyond-runtime-guard.mjs"), "utf8")}\n// stale\n`,
    "utf8",
  );
  run("旧身份护栏混入", 1, join(staleGuardRoot, "skills"), join(staleGuardRoot, "AGENTS.md"), "项目身份护栏脚本与控制仓候选不一致");

  const missingHookRoot = join(scratch, "missing-hook");
  cpSync(join(packageRoot, "skills"), join(missingHookRoot, "skills"), { recursive: true });
  cpSync(join(packageRoot, "AGENTS.md"), join(missingHookRoot, "AGENTS.md"));
  run("项目Hook缺失", 1, join(missingHookRoot, "skills"), join(missingHookRoot, "AGENTS.md"), "项目Hook配置不存在");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`安装完整性回归失败：${errors.length}项；通过${passed}项`);
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(`安装完整性回归通过：${passed}项`);
