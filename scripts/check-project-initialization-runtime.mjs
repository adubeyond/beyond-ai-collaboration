import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "模板交付包");
const scratch = mkdtempSync(join(tmpdir(), "beyond-project-initialization-"));
const results = [];

function assert(name, condition, detail = "") {
  results.push({ name, passed: Boolean(condition), detail });
  if (!condition) throw new Error(`${name}${detail ? `：${detail}` : ""}`);
}

function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  assert(`${command} ${args.join(" ")} exits ${expected}`, result.status === expected, output);
  return { stdout: (result.stdout ?? "").trim(), output };
}

function control(project, args, expected = 0) {
  return run(process.execPath, [join(project, "beyond-control", "scripts", "beyond-control.mjs"), ...args], project, expected);
}

function setup(name) {
  const project = join(scratch, name);
  cpSync(join(repositoryRoot, "examples", "minimal-project"), project, { recursive: true });
  cpSync(packageRoot, join(project, "beyond-control"), { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), `# 旧项目入口

- 稳定规则：使用 npm test 验证。

## 不应继续留在根入口的项目事实

- 测试服务器：legacy.example.invalid
- 发布路径：D:/legacy/release
`, "utf8");
  mkdirSync(join(project, "legacy-docs"), { recursive: true });
  for (const area of ["architecture", "development", "testing", "operations", "security"]) {
    writeFileSync(join(project, "legacy-docs", `${area}.md`), `# ${area}\n\n- ${area} stable fact.\n`, "utf8");
  }
  run("git", ["init"], project);
  control(project, ["init-control", "--project-root", project]);
  const installed = JSON.parse(control(project, ["install-project-entry", "--project-root", project, "--confirm-fusion", "yes"]).stdout);
  assert(`${name} minimum adoption is awaiting one choice`, installed.initialization.status === "awaiting-choice"
    && installed.initialization.pendingGroups.length === 7, JSON.stringify(installed.initialization));
  return { project, controlRoot: join(project, "beyond-control"), projectId: installed.projectId };
}

function replaceNativeRules(agentsPath, projectId) {
  const begin = "<!-- BEGIN PROJECT NATIVE RULES -->";
  const end = "<!-- END PROJECT NATIVE RULES -->";
  const text = readFileSync(agentsPath, "utf8");
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start + begin.length);
  if (start < 0 || finish < start) throw new Error("fused project entry lacks native-rule markers");
  const native = `${begin}\n- 项目原生稳定规则：使用 npm test 验证。\n- 长期事实入口：[项目事实索引](./beyond-control/projects/${projectId}/项目事实/README.md)\n${end}`;
  writeFileSync(agentsPath, `${text.slice(0, start)}${native}${text.slice(finish + end.length)}`, "utf8");
}

function verifyInstall(scenario) {
  const output = run(process.execPath, [
    join(scenario.controlRoot, "scripts", "verify-install-integrity.mjs"),
    "--installed-skills-root", join(scenario.controlRoot, "skills"),
    "--project-agents", join(scenario.project, "AGENTS.md"),
  ], scenario.project).output;
  assert(`${scenario.projectId} installation remains consistent`, output.includes("安装验真通过"), output);
}

try {
  const full = setup("legacy-full");
  const fullChoice = JSON.parse(control(full.project, ["initialization", "--action", "choose", "--project-id", full.projectId,
    "--mode", "full", "--approved-by", "隔离验收选择完整初始化"]).stdout);
  assert("full path enters full-in-progress", fullChoice.initialization.status === "full-in-progress");

  const factsDirectory = join(full.controlRoot, "projects", full.projectId, "项目事实");
  const factsIndex = join(factsDirectory, "README.md");
  const migratedArchitecture = join(factsDirectory, "architecture.md");
  copyFileSync(join(full.project, "legacy-docs", "architecture.md"), migratedArchitecture);
  const registered = ["development", "testing", "operations", "security"];
  writeFileSync(factsIndex, `${readFileSync(factsIndex, "utf8")}\n- projects/${full.projectId}/项目事实/architecture.md\n${registered
    .map((area) => `- legacy-docs/${area}.md`).join("\n")}\n`, "utf8");
  replaceNativeRules(join(full.project, "AGENTS.md"), full.projectId);

  control(full.project, ["initialization", "--action", "record", "--project-id", full.projectId,
    "--group", "overview", "--decision", "register", "--entry", "README.md"]);
  control(full.project, ["initialization", "--action", "record", "--project-id", full.projectId,
    "--group", "architecture", "--decision", "migrate", "--entry", `projects/${full.projectId}/项目事实/architecture.md`]);
  for (const area of registered) {
    control(full.project, ["initialization", "--action", "record", "--project-id", full.projectId,
      "--group", area, "--decision", "register", "--entry", `legacy-docs/${area}.md`]);
  }
  control(full.project, ["initialization", "--action", "record", "--project-id", full.projectId,
    "--group", "other", "--decision", "defer"]);
  const completed = JSON.parse(control(full.project, ["initialization", "--action", "complete", "--project-id", full.projectId,
    "--root-entry-reviewed", "yes"]).stdout);
  assert("full path completes only after real entries and root review", completed.initialization.status === "complete"
    && completed.initialization.pendingGroups.length === 0 && Boolean(completed.initialization.rootEntryReviewedAt));
  const slimRoot = readFileSync(join(full.project, "AGENTS.md"), "utf8");
  assert("full path removes bulky facts from the root entry", !slimRoot.includes("legacy.example.invalid")
    && slimRoot.includes("项目事实索引"));
  assert("migration preserves the old source and creates the adopted owner", existsSync(join(full.project, "legacy-docs", "architecture.md"))
    && existsSync(migratedArchitecture));
  verifyInstall(full);

  const onDemand = setup("legacy-on-demand");
  const onDemandChoice = JSON.parse(control(onDemand.project, ["initialization", "--action", "choose", "--project-id", onDemand.projectId,
    "--mode", "on-demand", "--approved-by", "隔离验收选择先使用"]).stdout);
  assert("on-demand path remains explicitly incomplete", onDemandChoice.initialization.status === "on-demand"
    && onDemandChoice.initialization.pendingGroups.length === 7);
  const overviewPath = join(onDemand.controlRoot, "projects", onDemand.projectId, "项目总览.md");
  const beforeOrdinaryWork = readFileSync(overviewPath, "utf8");
  run(process.execPath, ["--test", "test/calc.test.js"], onDemand.project);
  assert("ordinary work does not mutate initialization state", readFileSync(overviewPath, "utf8") === beforeOrdinaryWork);
  const resumed = JSON.parse(control(onDemand.project, ["initialization", "--action", "show", "--project-id", onDemand.projectId]).stdout);
  assert("on-demand path resumes at the first pending group", resumed.initialization.status === "on-demand"
    && resumed.initialization.pendingGroups[0] === "overview"
    && resumed.initialization.nextRequiredDecision.includes("普通任务可以继续"));
  control(onDemand.project, ["initialization", "--action", "record", "--project-id", onDemand.projectId,
    "--group", "overview", "--decision", "register", "--entry", "README.md"]);
  const afterResume = JSON.parse(control(onDemand.project, ["initialization", "--action", "show", "--project-id", onDemand.projectId]).stdout);
  assert("on-demand progress persists without pretending to be complete", afterResume.initialization.status === "on-demand"
    && afterResume.initialization.pendingGroups.length === 6
    && afterResume.initialization.pendingGroups[0] === "architecture");
  verifyInstall(onDemand);

  console.log(JSON.stringify({
    verdict: "passed",
    assertions: results.length,
    full: { projectId: full.projectId, status: "complete" },
    onDemand: { projectId: onDemand.projectId, status: "on-demand", pendingGroups: 6 },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ verdict: "failed", error: error.message, results }, null, 2));
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
