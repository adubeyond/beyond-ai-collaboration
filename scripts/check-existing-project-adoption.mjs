import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "模板交付包");
const scratch = mkdtempSync(join(tmpdir(), "beyond-existing-project-"));
const controlRoot = join(scratch, "beyond-control");
const projectRoot = join(scratch, "existing-product");
const controlScript = join(controlRoot, "scripts", "beyond-control.mjs");
let passed = 0;
const errors = [];

function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else errors.push(`${name}${detail ? `：${detail}` : ""}`);
}

function runNode(args) {
  return spawnSync(process.execPath, [controlScript, ...args], { cwd: controlRoot, encoding: "utf8" });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

try {
  cpSync(packageRoot, controlRoot, { recursive: true });
  mkdirSync(join(projectRoot, ".tmp"), { recursive: true });
  mkdirSync(join(projectRoot, "docs", "AI编程协同机制", "项目事实"), { recursive: true });
  mkdirSync(join(projectRoot, "docs", "06-部署与运维"), { recursive: true });
  for (let index = 0; index < 260; index += 1) {
    writeFileSync(join(projectRoot, ".tmp", `noise-${String(index).padStart(3, "0")}.md`), "# 临时文件\n", "utf8");
  }
  for (let index = 0; index < 205; index += 1) {
    writeFileSync(join(projectRoot, `note-${String(index).padStart(3, "0")}.md`), "# 普通文档\n", "utf8");
  }
  const originalAgents = Buffer.from("# 原项目规则\r\n\r\n- 保留 CRLF。\r\n", "utf8");
  writeFileSync(join(projectRoot, "AGENTS.md"), originalAgents);
  writeFileSync(join(projectRoot, "docs", "README.md"), "# 正式文档入口\n", "utf8");
  writeFileSync(join(projectRoot, "docs", "AI编程协同机制", "项目总览.md"), "# 旧项目总览\n", "utf8");
  writeFileSync(join(projectRoot, "docs", "AI编程协同机制", "项目事实", "README.md"), "# 旧项目事实\n", "utf8");
  writeFileSync(join(projectRoot, "docs", "06-部署与运维", "发布流程说明.md"), "# 发布流程\n", "utf8");
  writeFileSync(join(projectRoot, "docs", "AI编程协同机制", "当前工作台.md"), `# 当前工作台

### 1.2 正式任务表

| 任务 / 业务结果 | 负责人 / 正式 thread | 状态 | 当前进度 | 暂停原因与恢复条件 | 正式结果 / 证据入口 | 更新时间 |
| --- | --- | --- | --- | --- | --- | --- |
| 活动甲 | Worker-A | 进行中 | 开发中 | 无 | 无 | 2026-08-01 |
| 活动乙 | Worker-B | 进行中 | 测试中 | 无 | 无 | 2026-08-02 |
| 暂停丙 | Worker-C | 已暂停 | 等待外部 | 服务恢复后继续 | 无 | 2026-08-03 |
| 完成丁 | Worker-D | 已完成 | 已完成 | 无 | evidence-D | 2026-07-30 |
| 完成戊 | Worker-E | 已完成 | 已完成 | 无 | evidence-E | 2026-07-31 |
`, "utf8");

  git(projectRoot, ["init"]);
  git(projectRoot, ["remote", "add", "origin", "https://gitea.example/team/product.git"]);
  for (const name of ["ui-a", "ui-b"]) {
    const child = join(projectRoot, name);
    mkdirSync(child, { recursive: true });
    git(child, ["init"]);
    git(child, ["remote", "add", "origin", "https://gitea.example/team/ui.git"]);
  }

  const inspectResult = runNode(["inspect-project", "--project-root", projectRoot]);
  const inspect = JSON.parse(inspectResult.stdout);
  check("只读检查成功", inspectResult.status === 0);
  check("临时目录不占扫描名额", inspect.markdownTotal === 211 && !inspect.markdown.some((item) => item.path.startsWith(".tmp/")), `总数${inspect.markdownTotal}`);
  check("正式文档优先返回", inspect.markdown.slice(0, 5).every((item) => item.class === "formal"));
  check("重复remote被识别", inspect.repositories.length === 3 && inspect.remoteConflicts.length === 1, JSON.stringify({ repositories: inspect.repositories, conflicts: inspect.remoteConflicts }));
  check("旧工作台三态被识别", inspect.legacyWorkbench.counts.进行中 === 2
    && inspect.legacyWorkbench.counts.已暂停 === 1
    && inspect.legacyWorkbench.counts.已完成 === 2);

  const blocked = runNode(["install-project-entry", "--project-root", projectRoot, "--confirm-fusion", "yes"]);
  check("未选择正式仓库和旧任务迁移时阻断", blocked.status === 2 && blocked.stderr.includes("准确选择一个正式路径"));

  const installed = runNode([
    "install-project-entry", "--project-root", projectRoot, "--confirm-fusion", "yes",
    "--canonical-repositories", join(projectRoot, "ui-a"), "--adopt-legacy-workbench", "yes",
  ]);
  const installResult = JSON.parse(installed.stdout);
  check("显式确认后完成融合", installed.status === 0 && installResult.adoption?.imported === 3, installed.stderr);
  const backupAgents = readdirSync(installResult.backupDirectory)
    .find((name) => name.endsWith("-AGENTS.md"));
  check("原AGENTS按字节备份", Boolean(backupAgents)
    && readFileSync(join(installResult.backupDirectory, backupAgents)).equals(originalAgents));
  const workbench = runNode(["workbench", "--action", "list"]);
  const workbenchResult = JSON.parse(workbench.stdout);
  check("活动与暂停任务进入本机工作台", workbench.status === 0
    && workbenchResult.counts.进行中 === 2
    && workbenchResult.counts.已暂停 === 1);
  check("已完成任务进入历史", existsSync(join(controlRoot, "local", "history", "legacy", `${inspect.projectId}-workbench.md`)));
  const localRegistration = readFileSync(join(controlRoot, "local", "projects", `${inspect.projectId}.md`), "utf8");
  check("重复remote正式路径进入本机登记", localRegistration.includes(join(projectRoot, "ui-a").replace(/\\/g, "/")));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`老项目接入回归失败：${errors.length}项；通过${passed}项`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`老项目接入回归通过：${passed}项`);
