import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "beyond-shared-git-"));

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  git("init", "--quiet");
  git("config", "user.name", "BEYOND Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false");

  mkdirSync(join(root, "module-a"));
  mkdirSync(join(root, "module-b"));
  writeFileSync(join(root, "module-a", "value.txt"), "a0\n", "utf8");
  writeFileSync(join(root, "module-b", "value.txt"), "b0\n", "utf8");
  git("add", "--", "module-a/value.txt", "module-b/value.txt");
  git("commit", "--quiet", "-m", "baseline");

  // 两个任务先在同一工作区、不同拥有路径上形成改动。
  writeFileSync(join(root, "module-a", "value.txt"), "a1\n", "utf8");
  writeFileSync(join(root, "module-b", "value.txt"), "b1\n", "utf8");

  // Git 索引与提交动作串行，每次只暂存任务拥有路径。
  git("add", "--", "module-a/value.txt");
  git("commit", "--quiet", "-m", "task-a");
  assert(git("show", "--pretty=format:", "--name-only", "HEAD") === "module-a/value.txt", "task-a commit contains another task path");
  const taskBWorkingText = readFileSync(join(root, "module-b", "value.txt"), "utf8");
  assert(taskBWorkingText === "b1\n", `task-b working change was lost: ${JSON.stringify(taskBWorkingText)}`);
  assert(git("status", "--short") === "M module-b/value.txt", "task-b dirty change was not preserved");

  git("add", "--", "module-b/value.txt");
  git("commit", "--quiet", "-m", "task-b");
  assert(git("show", "--pretty=format:", "--name-only", "HEAD") === "module-b/value.txt", "task-b commit contains another task path");
  assert(git("status", "--short") === "", "shared workspace did not converge cleanly");
  assert(git("rev-list", "--count", "HEAD") === "3", "expected baseline plus two task commits");

  console.log("共享工作区 Git 验证通过：不同路径改动并存，两个精确提交均未丢失或串入对方文件");
} finally {
  rmSync(root, { recursive: true, force: true });
}
