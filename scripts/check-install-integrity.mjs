import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function run(name, expectedStatus, skillsRoot, agentsPath, expectedText) {
  const result = spawnSync(process.execPath, [
    verifier,
    "--installed-skills-root",
    skillsRoot,
    "--project-agents",
    agentsPath,
  ], { encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== expectedStatus || (expectedText && !output.includes(expectedText))) {
    errors.push(`${name}：期望退出码${expectedStatus}且包含“${expectedText}”，实际退出码${result.status}\n${output}`);
  } else {
    passed += 1;
  }
}

try {
  const exactRoot = join(scratch, "exact");
  cpSync(join(packageRoot, "skills"), join(exactRoot, "skills"), { recursive: true });
  cpSync(join(packageRoot, "AGENTS.md"), join(exactRoot, "AGENTS.md"));
  run("完全一致安装", 0, join(exactRoot, "skills"), join(exactRoot, "AGENTS.md"), "安装验真通过");

  const explicitOverride = readFileSync(join(exactRoot, "AGENTS.md"), "utf8").replace(
    "<!-- 没有项目特有覆盖时保持为空。 -->",
    "- 正式工作目录：项目根目录。\n- Worker批量数据核对使用Luna高推理。",
  );
  writeFileSync(join(exactRoot, "AGENTS.md"), explicitOverride, "utf8");
  run("合法项目覆盖", 0, join(exactRoot, "skills"), join(exactRoot, "AGENTS.md"), "安装验真通过");

  const mixedRoot = join(scratch, "mixed");
  cpSync(join(packageRoot, "skills"), join(mixedRoot, "skills"), { recursive: true });
  cpSync(join(packageRoot, "AGENTS.md"), join(mixedRoot, "AGENTS.md"));
  const oldPm = readFileSync(join(mixedRoot, "skills", "identity-pm", "SKILL.md"), "utf8").replace(
    "本节模型分档只用于 PM 创建新的正式 Worker任务",
    "创建任务时",
  );
  writeFileSync(join(mixedRoot, "skills", "identity-pm", "SKILL.md"), oldPm, "utf8");
  run("旧Skill混入", 1, join(mixedRoot, "skills"), join(mixedRoot, "AGENTS.md"), "安装Skill内容不一致");

  const oldEntryRoot = join(scratch, "old-entry");
  cpSync(join(packageRoot, "skills"), join(oldEntryRoot, "skills"), { recursive: true });
  const oldEntry = readFileSync(join(packageRoot, "AGENTS.md"), "utf8").replace(
    "<!-- BEYOND-RUNTIME-VERSION: 3.0.8 -->\n",
    "",
  );
  writeFileSync(join(oldEntryRoot, "AGENTS.md"), oldEntry, "utf8");
  run("旧项目入口混入", 1, join(oldEntryRoot, "skills"), join(oldEntryRoot, "AGENTS.md"), "缺少目标版本标记");

  const ambiguousRoot = join(scratch, "ambiguous");
  cpSync(join(packageRoot, "skills"), join(ambiguousRoot, "skills"), { recursive: true });
  const ambiguous = readFileSync(join(packageRoot, "AGENTS.md"), "utf8").replace(
    "<!-- 没有项目特有覆盖时保持为空。 -->",
    "- 所有正式任务统一使用Luna高推理。",
  );
  writeFileSync(join(ambiguousRoot, "AGENTS.md"), ambiguous, "utf8");
  run("模型覆盖缺少角色", 1, join(ambiguousRoot, "skills"), join(ambiguousRoot, "AGENTS.md"), "模型覆盖没有明确适用角色");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`安装完整性回归失败：${errors.length}项；通过${passed}项`);
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(`安装完整性回归通过：${passed}项`);
