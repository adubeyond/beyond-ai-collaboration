import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
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

function control(project, args, expected = 0, controlRoot = join(project, "beyond-control")) {
  return run(process.execPath, [join(controlRoot, "scripts", "beyond-control.mjs"), ...args], project, expected);
}

function setup(name, { legacy = true, sharedControlRoot = null } = {}) {
  const project = join(scratch, name);
  const controlRoot = sharedControlRoot ?? join(project, "beyond-control");
  cpSync(join(repositoryRoot, "examples", "minimal-project"), project, { recursive: true });
  if (!sharedControlRoot) cpSync(packageRoot, controlRoot, { recursive: true });
  if (legacy) writeFileSync(join(project, "AGENTS.md"), `# 旧项目入口

- 稳定规则：使用 npm test 验证。

## 不应继续留在根入口的项目事实

- 测试服务器：legacy.example.invalid
- 发布路径：D:/legacy/release
`, "utf8");
  if (legacy) {
    mkdirSync(join(project, "legacy-docs"), { recursive: true });
    for (const area of ["architecture", "development", "testing", "operations", "security"]) {
      writeFileSync(join(project, "legacy-docs", `${area}.md`), `# ${area}\n\n- ${area} stable fact.\n`, "utf8");
    }
  }
  run("git", ["init"], project);
  if (!sharedControlRoot) control(project, ["init-control", "--project-root", project], 0, controlRoot);
  const installed = JSON.parse(control(project, ["install-project-entry", "--project-root", project, "--confirm-fusion", "yes"], 0, controlRoot).stdout);
  assert(`${name} minimum adoption is awaiting one choice`, installed.initialization.status === "awaiting-choice"
    && installed.initialization.pendingGroups.length === 7, JSON.stringify(installed.initialization));
  return { project, controlRoot, projectId: installed.projectId };
}

function factsPath(scenario) {
  return join(scenario.controlRoot, "projects", scenario.projectId, "项目事实", "README.md");
}

function linkTo(index, target, fragment = "") {
  return `${relative(dirname(index), target).replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}${fragment}`;
}

function rejectWithoutStateChange(scenario, args, name) {
  const overview = join(scenario.controlRoot, "projects", scenario.projectId, "项目总览.md");
  const before = readFileSync(overview);
  const indexBefore = readFileSync(factsPath(scenario));
  control(scenario.project, ["initialization", "--project-id", scenario.projectId, ...args], 2, scenario.controlRoot);
  assert(`${name} rejects without changing initialization or index`, before.equals(readFileSync(overview))
    && indexBefore.equals(readFileSync(factsPath(scenario))));
}

function verifyGeneratedIndex(scenario) {
  const canonicalPath = join(scenario.controlRoot, "docs", "AI编程协同机制", "项目事实", "README.md");
  const canonical = readFileSync(canonicalPath, "utf8");
  const generatedPath = factsPath(scenario);
  const generated = readFileSync(generatedPath, "utf8");
  const fields = (text) => [...text.matchAll(/^\| ([^|]+) \|/gm)].map((match) => match[1]);
  assert(`${scenario.projectId} derives every canonical table field`, JSON.stringify(fields(generated)) === JSON.stringify(fields(canonical)));
  assert(`${scenario.projectId} replaces template identity`, generated.includes(scenario.projectId)
    && !generated.includes("本文件只提供结构") && !generated.includes("<project-id>"));
  const links = (text, path) => [...text.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)]
    .map((match) => resolve(dirname(path), decodeURIComponent(match[1].split("#")[0])));
  const expected = links(canonical, canonicalPath);
  const actual = links(generated, generatedPath);
  assert(`${scenario.projectId} relocates all canonical resources without changing targets`, expected.every((target) => actual.includes(target))
    && actual.every((target) => existsSync(target))
    && actual.includes(join(scenario.controlRoot, "projects", scenario.projectId, "项目总览.md")),
  JSON.stringify({ unmatched: expected.filter((target) => !actual.includes(target)), missing: actual.filter((target) => !existsSync(target)) }));
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
  verifyGeneratedIndex(full);
  const fullChoice = JSON.parse(control(full.project, ["initialization", "--action", "choose", "--project-id", full.projectId,
    "--mode", "full", "--approved-by", "隔离验收选择完整初始化"]).stdout);
  assert("full path enters full-in-progress", fullChoice.initialization.status === "full-in-progress");

  const factsDirectory = join(full.controlRoot, "projects", full.projectId, "项目事实");
  const factsIndex = join(factsDirectory, "README.md");
  const migratedArchitecture = join(factsDirectory, "architecture.md");
  copyFileSync(join(full.project, "legacy-docs", "architecture.md"), migratedArchitecture);
  writeFileSync(migratedArchitecture, `${readFileSync(migratedArchitecture, "utf8")}\n## 运行与检查\n\n## Repeat\n\n## Repeat\n\nSetext section\n--------------\n\n## Divided\n---\n\n<a id="explicit-section"></a>\n\n\`<a id="example-anchor"></a>\`\n\n\`\`\`md\n## Not a heading\n\`\`\`\n`, "utf8");
  const generatedIndex = readFileSync(factsIndex, "utf8");
  const architectureEntry = `projects/${full.projectId}/项目事实/architecture.md`;
  const recordArchitecture = ["--action", "record", "--group", "architecture", "--decision", "migrate", "--entry", architectureEntry];
  for (const [name, indexText] of [
    ["bare path", `- ${architectureEntry}`],
    ["inline-code mention", `- \`${architectureEntry}\``],
    ["wrong control-root relative link", `- [架构](${architectureEntry})`],
    ["wrong project-root relative link", "- [架构](legacy-docs/architecture.md)"],
    ["different existing document", "- [架构](../../../../legacy-docs/development.md)"],
    ["missing link target", "- [架构](missing.md)"],
    ["invalid URL encoding", "- [架构](architecture%ZZ.md)"],
    ["inline-code example", "`[架构](architecture.md)`"],
    ["fenced example", "```md\n[架构](architecture.md)\n```"],
    ["backtick fence inside list", "- 示例\n\n    ```md\n    [架构](architecture.md)\n    ```"],
    ["tilde fence inside list", "- 示例\n\n    ~~~md\n    [架构](architecture.md)\n    ~~~"],
    ["indented example", "独立代码示例：\n\n    [架构](architecture.md)"],
    ["commented link", "<!-- [架构](architecture.md) -->"],
    ["unclosed comment", "<!-- obsolete\n[架构](architecture.md)"],
    ["image is not a navigation link", "![架构](architecture.md)"],
    ["absent anchor", "- [架构](architecture.md#missing-section)"],
    ["heading in a code block", "- [架构](architecture.md#not-a-heading)"],
    ["explicit anchor in inline code", "- [架构](architecture.md#example-anchor)"],
    ["horizontal rule cannot duplicate an ATX heading", "- [架构](architecture.md#divided-1)"],
    ["good link cannot hide a bad chapter", "- [架构](architecture.md)\n- [章节](architecture.md#missing-section)"],
  ]) {
    writeFileSync(factsIndex, `${generatedIndex}\n${indexText}\n`, "utf8");
    rejectWithoutStateChange(full, recordArchitecture, name);
  }
  writeFileSync(factsIndex, `${generatedIndex}\n- 工程资料\n    - [架构](architecture.md)\n`, "utf8");
  control(full.project, ["initialization", "--project-id", full.projectId, ...recordArchitecture]);
  for (const [name, destination] of [
    ["plain file", "architecture.md"],
    ["heading", "./architecture.md#architecture"],
    ["Chinese URL-encoded heading", `architecture.md#${encodeURIComponent("运行与检查")}`],
    ["duplicate heading", "architecture.md#repeat-1"],
    ["Setext heading", "architecture.md#setext-section"],
    ["explicit anchor", "architecture.md#explicit-section"],
    ["angle target and title", '<architecture.md#architecture> "架构原文"'],
    ["absolute file target", `<${migratedArchitecture.replace(/\\/g, "/")}>`],
  ]) {
    writeFileSync(factsIndex, `${generatedIndex}\n- [${name}](${destination})\n`, "utf8");
    control(full.project, ["initialization", "--project-id", full.projectId, ...recordArchitecture]);
  }
  const namedArchitecture = join(factsDirectory, "架构 原文(当前).md");
  copyFileSync(migratedArchitecture, namedArchitecture);
  for (const destination of [linkTo(factsIndex, namedArchitecture), "<架构 原文(当前).md>"]) {
    writeFileSync(factsIndex, `${generatedIndex}\n- [架构原文](${destination})\n`, "utf8");
    control(full.project, ["initialization", "--project-id", full.projectId, "--action", "record", "--group", "architecture",
      "--decision", "migrate", "--entry", namedArchitecture]);
  }
  const registered = ["development", "testing", "operations", "security"];
  const registeredIndex = `${generatedIndex}\n- [架构](architecture.md#architecture)\n${registered
    .map((area) => `- [${area}](${linkTo(factsIndex, join(full.project, "legacy-docs", `${area}.md`))})`).join("\n")}\n`;
  writeFileSync(factsIndex, registeredIndex, "utf8");
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
  writeFileSync(factsIndex, registeredIndex.replace("architecture.md#architecture", "architecture.md#missing-section"), "utf8");
  rejectWithoutStateChange(full, ["--action", "complete", "--root-entry-reviewed", "yes"], "completion rechecks anchors");
  writeFileSync(factsIndex, registeredIndex, "utf8");
  const movedArchitecture = join(factsDirectory, "architecture-current.md");
  renameSync(migratedArchitecture, movedArchitecture);
  rejectWithoutStateChange(full, ["--action", "complete", "--root-entry-reviewed", "yes"], "completion rejects a moved owner");
  const movedRecord = ["--action", "record", "--group", "architecture", "--decision", "migrate", "--entry", movedArchitecture];
  rejectWithoutStateChange(full, movedRecord, "new owner cannot retain a stale index link");
  writeFileSync(factsIndex, registeredIndex.replace("architecture.md#architecture", "architecture-current.md#architecture"), "utf8");
  control(full.project, ["initialization", "--project-id", full.projectId, ...movedRecord]);
  const completed = JSON.parse(control(full.project, ["initialization", "--action", "complete", "--project-id", full.projectId,
    "--root-entry-reviewed", "yes"]).stdout);
  assert("full path completes only after real entries and root review", completed.initialization.status === "complete"
    && completed.initialization.pendingGroups.length === 0 && Boolean(completed.initialization.rootEntryReviewedAt));
  const slimRoot = readFileSync(join(full.project, "AGENTS.md"), "utf8");
  assert("full path removes bulky facts from the root entry", !slimRoot.includes("legacy.example.invalid")
    && slimRoot.includes("项目事实索引"));
  assert("migration preserves the old source and creates the adopted owner", existsSync(join(full.project, "legacy-docs", "architecture.md"))
    && existsSync(movedArchitecture));
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
  rejectWithoutStateChange(onDemand, ["--action", "record", "--group", "other", "--decision", "defer", "--entry", "README.md"],
    "defer cannot invent an entry");
  control(onDemand.project, ["initialization", "--action", "record", "--project-id", onDemand.projectId,
    "--group", "overview", "--decision", "register", "--entry", "README.md"]);
  const afterResume = JSON.parse(control(onDemand.project, ["initialization", "--action", "show", "--project-id", onDemand.projectId]).stdout);
  assert("on-demand progress persists without pretending to be complete", afterResume.initialization.status === "on-demand"
    && afterResume.initialization.pendingGroups.length === 6
    && afterResume.initialization.pendingGroups[0] === "architecture");
  verifyInstall(onDemand);

  const fresh = setup("new-project", { legacy: false });
  verifyGeneratedIndex(fresh);
  control(fresh.project, ["initialization", "--action", "choose", "--project-id", fresh.projectId,
    "--mode", "full", "--approved-by", "隔离验收暂不处理已有资料"]);
  for (const group of ["overview", "architecture", "development", "testing", "operations", "security", "other"]) {
    control(fresh.project, ["initialization", "--action", "record", "--project-id", fresh.projectId, "--group", group, "--decision", "defer"]);
  }
  const deferred = JSON.parse(control(fresh.project, ["initialization", "--action", "complete", "--project-id", fresh.projectId,
    "--root-entry-reviewed", "yes"]).stdout);
  assert("all seven explicit defer decisions remain valid", deferred.initialization.status === "complete"
    && deferred.initialization.pendingGroups.length === 0);

  // 只改隔离副本的模板，证明后续新项目派生当前模板；已有索引不参与刷新。
  const canonicalPath = join(full.controlRoot, "docs", "AI编程协同机制", "项目事实", "README.md");
  writeFileSync(canonicalPath, `${readFileSync(canonicalPath, "utf8")}\n## 隔离模板新增专题\n\n| 隔离新增领域 | 待登记 | 当前原文 | 不建空文档 |\n\n- [专题导航](../00-模板入口.md)\n`, "utf8");
  const preservedIndex = readFileSync(factsIndex);
  const preservedOverviewPath = join(full.controlRoot, "projects", full.projectId, "项目总览.md");
  const preservedOverview = readFileSync(preservedOverviewPath);
  control(full.project, ["register-project", "--project-root", full.project]);
  assert("re-registering an existing project preserves its facts byte-for-byte", preservedIndex.equals(readFileSync(factsIndex))
    && preservedOverview.equals(readFileSync(preservedOverviewPath)));
  const second = setup("second-shared-project", { legacy: false, sharedControlRoot: full.controlRoot });
  verifyGeneratedIndex(second);
  assert("shared control root creates distinct project indexes from the current template", second.projectId !== full.projectId
    && readFileSync(factsPath(second), "utf8").includes("隔离模板新增专题")
    && !readFileSync(factsIndex, "utf8").includes("隔离模板新增专题")
    && preservedIndex.equals(readFileSync(factsIndex)) && preservedOverview.equals(readFileSync(preservedOverviewPath)));
  assert("shared project index keeps its own overview link", readFileSync(factsPath(second), "utf8").includes("[返回项目总览](../项目总览.md)"));

  console.log(JSON.stringify({
    verdict: "passed",
    assertions: results.length,
    full: { projectId: full.projectId, status: "complete" },
    onDemand: { projectId: onDemand.projectId, status: "on-demand", pendingGroups: 6 },
    fresh: { projectId: fresh.projectId, status: "complete", decisions: "defer" },
    shared: { projectId: second.projectId, status: "awaiting-choice" },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ verdict: "failed", error: error.message, results }, null, 2));
  process.exitCode = 1;
} finally {
  if (dirname(resolve(scratch)) !== resolve(tmpdir()) || !basename(scratch).startsWith("beyond-project-initialization-")) {
    throw new Error("refusing to remove an unexpected scratch path");
  }
  rmSync(scratch, { recursive: true, force: true });
}
