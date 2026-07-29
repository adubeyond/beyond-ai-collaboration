import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const taskRoot = path.join(
  repositoryRoot,
  "worker-sandbox",
  "BCR-SYSTEM-MECHANISM-REPAIR-20260729",
  "MCR-05",
);
const commandsRoot = path.join(taskRoot, "commands");
const fixturesRoot = path.join(taskRoot, "fixtures");
const oldRegressionRoot = path.join(
  repositoryRoot,
  "worker-sandbox",
  "BCR-RUNPATH-FULL-REGRESSION-FINAL-01",
);

if (fs.existsSync(taskRoot)) {
  throw new Error(`拒绝覆盖最终回归证据：${taskRoot}`);
}
fs.mkdirSync(commandsRoot, { recursive: true });
fs.mkdirSync(fixturesRoot, { recursive: true });

function normalize(file) {
  return file.split(path.sep).join("/");
}

function relative(file) {
  return normalize(path.relative(repositoryRoot, file));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function collect(target, predicate = () => true) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.lstatSync(target);
  if (stat.isFile()) return predicate(target) ? [target] : [];
  return fs
    .readdirSync(target, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .flatMap((entry) => collect(path.join(target, entry.name), predicate));
}

function sourceFiles() {
  const files = [
    path.join(repositoryRoot, "README.md"),
    path.join(repositoryRoot, "README.zh-CN.md"),
    ...collect(
      path.join(repositoryRoot, "docs"),
      (file) => path.extname(file).toLowerCase() === ".md",
    ),
    ...collect(path.join(repositoryRoot, "模板交付包")),
    ...collect(
      path.join(repositoryRoot, "scripts"),
      (file) => path.extname(file).toLowerCase() === ".mjs",
    ),
  ];
  return [...new Set(files.map((file) => path.resolve(file)))].sort();
}

function snapshot(files) {
  return files.map((file) => {
    const bytes = fs.readFileSync(file);
    return {
      path: relative(file),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
}

const files = sourceFiles();
const before = snapshot(files);
fs.writeFileSync(
  path.join(taskRoot, "source-before.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      filesRead: before.length,
      totalBytesRead: before.reduce((sum, item) => sum + item.bytes, 0),
      files: before,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const sourceDirect = path.join(fixturesRoot, "source-direct-task");
const fourLayer = path.join(fixturesRoot, "design-dev-test-ops");
fs.cpSync(
  path.join(oldRegressionRoot, "fixtures", "source-direct-task-r2"),
  sourceDirect,
  { recursive: true },
);
fs.cpSync(
  path.join(oldRegressionRoot, "fixtures", "design-dev-test-ops-r2"),
  fourLayer,
  { recursive: true },
);

const records = [];

function run(id, label, command, args, cwd = repositoryRoot) {
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  const record = {
    id,
    label,
    command: [command, ...args].join(" "),
    cwd,
    startedAt,
    durationMs: Number(
      (Number(process.hrtime.bigint() - start) / 1_000_000).toFixed(3),
    ),
    exitCode: typeof result.status === "number" ? result.status : null,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  records.push(record);
  fs.writeFileSync(
    path.join(commandsRoot, `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

const nodeChecks = [
  ["01-public-content", "公开内容与链接、Skill结构", "check-public-content.mjs"],
  ["02-terminal-semantics", "终态语义", "check-mechanism-semantics.mjs"],
  ["03-loss-recovery", "失联与恢复语义", "check-lifecycle-recovery-semantics.mjs"],
  ["04-write-isolation", "清晰写入与任务起点", "check-write-isolation-semantics.mjs"],
  ["05-rule-ownership", "规则所有权与文档定位", "check-rule-ownership-semantics.mjs"],
  ["06-system-read-paths", "全系统真实读取路径", "check-system-read-paths.mjs"],
];
for (const [id, label, script] of nodeChecks) {
  run(id, label, process.execPath, [path.join(repositoryRoot, "scripts", script)]);
}

run(
  "07-d03-callback",
  "D-03终态回源规则",
  process.execPath,
  [
    path.join(
      repositoryRoot,
      "worker-sandbox",
      "BCR-RUNPATH-D03-COLD-START-01",
      "callback-fix",
      "test-callback-rules.mjs",
    ),
  ],
);
run(
  "08-source-direct",
  "源码直读业务测试",
  process.execPath,
  ["--test", path.join(sourceDirect, "test", "normalizeLabel.test.js")],
  sourceDirect,
);
run(
  "09-dev-self-check",
  "四层夹具开发自检",
  process.execPath,
  [path.join(fourLayer, "scripts", "dev-self-check.mjs")],
  fourLayer,
);
run(
  "10-independent-test",
  "四层夹具独立测试",
  process.execPath,
  [path.join(fourLayer, "test", "independent-test.mjs")],
  fourLayer,
);
for (const [id, label, action] of [
  ["11-ops-preflight", "运维预检", "preflight"],
  ["12-ops-health", "运维健康检查", "health"],
  ["13-ops-business", "运维业务检查", "business"],
]) {
  run(
    id,
    label,
    process.execPath,
    [path.join(fourLayer, "scripts", "release-sim.mjs"), action],
    fourLayer,
  );
}
run(
  "14-task-doc-lifecycle",
  "任务文档创建、持续更新、接力与历史回收",
  process.execPath,
  [
    path.join(
      oldRegressionRoot,
      "fixtures",
      "task-docs-acceptance-r2.mjs",
    ),
    "runtime-r7",
  ],
  oldRegressionRoot,
);
run(
  "15-git-diff-check",
  "Git差异空白错误检查",
  "git",
  ["diff", "--check"],
);

const after = snapshot(files);
fs.writeFileSync(
  path.join(taskRoot, "source-after.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      filesRead: after.length,
      totalBytesRead: after.reduce((sum, item) => sum + item.bytes, 0),
      files: after,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const beforeMap = new Map(before.map((item) => [item.path, item.sha256]));
const drift = after
  .filter((item) => beforeMap.get(item.path) !== item.sha256)
  .map((item) => item.path);
const failed = records.filter((record) => record.exitCode !== 0);
const summary = {
  verdict:
    failed.length === 0 && drift.length === 0
      ? "source_direct_regression_passed"
      : "source_direct_regression_failed",
  commands: records.length,
  passedCommands: records.length - failed.length,
  failedCommands: failed.length,
  failedCommandIds: failed.map((record) => record.id),
  sourceFilesRead: before.length,
  sourceBytesRead: before.reduce((sum, item) => sum + item.bytes, 0),
  sourceDrift: drift,
  scope: "uninstalled_source_direct_only",
  exclusions: [
    "local_installed_skills",
    "wanshitong",
    "network",
    "servers",
    "real_services",
    "production",
    "business_data",
    "real_deployment_or_release",
  ],
};
fs.writeFileSync(
  path.join(taskRoot, "final-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(summary, null, 2));

if (summary.verdict !== "source_direct_regression_passed") {
  process.exitCode = 1;
}
