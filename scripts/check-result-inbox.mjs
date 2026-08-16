import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const sourceControl = join(repositoryRoot, "模板交付包");
const testRoot = mkdtempSync(join(tmpdir(), "beyond-result-inbox-"));
const projectOne = join(testRoot, "project-one");
const projectTwo = join(testRoot, "project-two");
const controlRoot = join(testRoot, "external-beyond-control");
const script = join(controlRoot, "scripts", "beyond-control.mjs");
let passed = 0;

function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: projectOne,
    encoding: "utf8",
    windowsHide: true,
  });
  check(result.status === expectedStatus, `${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`);
  return result;
}

function json(args) {
  return JSON.parse(run(args).stdout);
}

try {
  mkdirSync(projectOne, { recursive: true });
  mkdirSync(projectTwo, { recursive: true });
  cpSync(sourceControl, controlRoot, { recursive: true });
  run(["init-control"]);
  const registeredOne = json(["register-project", "--project-root", projectOne, "--name", "收件箱项目一"]);
  const registeredTwo = json(["register-project", "--project-root", projectTwo, "--name", "收件箱项目二"]);
  const projectIdOne = registeredOne.project.projectId;
  const projectIdTwo = registeredTwo.project.projectId;
  check(!controlRoot.startsWith(`${projectOne}\\`) && !controlRoot.startsWith(`${projectTwo}\\`), "control root must be external to both business projects");
  const installedOne = json(["install-project-entry", "--project-root", projectOne, "--confirm-fusion", "yes"]);
  check(installedOne.projectId === projectIdOne, "external control installation must retain the registered project id");
  const projectEntry = readFileSync(join(projectOne, "AGENTS.md"), "utf8");
  check(projectEntry.includes("BEYOND-CONTROL-ROOT: ../external-beyond-control"), "project entry must point to the external control root");
  check(projectEntry.includes(`BEYOND-PROJECT-ID: ${projectIdOne}`), "project entry must expose the registered project id");
  const sourceThread = "11111111-2222-4333-8444-555555555555";
  const common = [
    "--source-thread", sourceThread,
    "--task", "完成账号页面修复",
    "--status", "已完成",
    "--summary", "账号页面重复负责人已经消除",
    "--evidence", "evidence/account-page.md",
    "--next", "PM核验后更新工作台",
  ];

  const created = json(["inbox", "--action", "enqueue", "--project-id", projectIdOne, ...common]);
  check(created.mode === "created", "first enqueue must create a record");
  const duplicate = json(["inbox", "--action", "enqueue", "--project-id", projectIdOne, ...common]);
  check(duplicate.mode === "existing", "identical pending result must be idempotent");
  check(duplicate.record.recordId === created.record.recordId, "idempotent enqueue must return the original record");

  const secondProject = json([
    "inbox", "--action", "enqueue", "--project-id", projectIdTwo,
    "--source-thread", sourceThread,
    "--task", "核对第二项目",
    "--status", "已暂停",
    "--summary", "缺少唯一生产目标",
    "--evidence", "worker final",
    "--next", "补充目标后恢复",
  ]);
  check(secondProject.mode === "created", "second project result must be created");
  const listOne = json(["inbox", "--action", "list", "--project-id", projectIdOne]);
  const listTwo = json(["inbox", "--action", "list", "--project-id", projectIdTwo]);
  check(listOne.count === 1 && listOne.records[0].projectId === projectIdOne, "list must isolate project one");
  check(listTwo.count === 1 && listTwo.records[0].projectId === projectIdTwo, "list must isolate project two");

  run(["inbox", "--action", "ack", "--project-id", projectIdTwo, "--record-id", created.record.recordId], 2);
  const acknowledged = json(["inbox", "--action", "ack", "--project-id", projectIdOne, "--record-id", created.record.recordId]);
  check(acknowledged.acknowledged === created.record.recordId, "ack must confirm the requested record");
  check(acknowledged.deleted === true, "ack must delete the consumed legacy record");
  check(json(["inbox", "--action", "list", "--project-id", projectIdOne]).count === 0, "acknowledged record must leave pending");
  check(!existsSync(join(controlRoot, "local", "inbox", "history")), "consumed legacy results must not create long-term history");

  run([
    "inbox", "--action", "enqueue", "--project-id", projectIdOne,
    "--source-thread", sourceThread,
    "--task", "无效状态",
    "--status", "进行中",
    "--summary", "不应建立",
    "--evidence", "无",
    "--next", "无",
  ], 2);
  run([
    "inbox", "--action", "enqueue", "--project-id", projectIdOne,
    "--source-thread", "source-pm-001",
    "--task", "无效来源",
    "--status", "已完成",
    "--summary", "不应建立",
    "--evidence", "无",
    "--next", "无",
  ], 2);

  const pendingOne = join(controlRoot, "local", "inbox", "pending", projectIdOne);
  const pendingTwo = join(controlRoot, "local", "inbox", "pending", projectIdTwo);
  writeFileSync(join(pendingTwo, "broken.json"), "{not-json\n", "utf8");
  check(json(["inbox", "--action", "list", "--project-id", projectIdOne]).count === 0, "a damaged second-project record must not block the first project");
  run(["inbox", "--action", "list", "--project-id", projectIdTwo], 2);
  rmSync(join(pendingTwo, "broken.json"), { force: true });
  writeFileSync(join(pendingOne, "broken.json"), "{not-json\n", "utf8");
  run(["inbox", "--action", "list", "--project-id", projectIdOne], 2);

  rmSync(pendingOne, { recursive: true, force: true });
  writeFileSync(pendingOne, "blocked\n", "utf8");
  check(lstatSync(pendingOne).isFile(), "blocked inbox fixture must make the project pending path unwritable as a directory");
  run(["inbox", "--action", "enqueue", "--project-id", projectIdOne, ...common], 1);

  console.log(JSON.stringify({ passed, failed: 0, behavior: "external control result inbox" }, null, 2));
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
