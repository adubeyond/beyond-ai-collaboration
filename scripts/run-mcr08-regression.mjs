import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const round = process.argv[2] ?? "r1";
if (!/^r[1-9][0-9]*$/u.test(round)) {
  throw new Error(`回归轮次不合法：${round}`);
}
const taskRoot = path.join(
  repositoryRoot,
  "worker-sandbox",
  "BCR-SYSTEM-MECHANISM-REPAIR-20260729",
  "MCR-08",
  `regression-${round}`,
);
const commandsRoot = path.join(taskRoot, "commands");
const fixturesRoot = path.join(taskRoot, "fixtures");
const oldRegressionRoot = path.join(
  repositoryRoot,
  "worker-sandbox",
  "BCR-RUNPATH-FULL-REGRESSION-FINAL-01",
);

if (fs.existsSync(taskRoot)) {
  throw new Error(`拒绝覆盖既有MCR-08回归证据：${taskRoot}`);
}
fs.mkdirSync(commandsRoot, { recursive: true });
fs.mkdirSync(fixturesRoot, { recursive: true });

const normalize = (file) => file.split(path.sep).join("/");
const relative = (file) => normalize(path.relative(repositoryRoot, file));
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

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
  const started = process.hrtime.bigint();
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
      (Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3),
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

const staticChecks = [
  ["01-public-content", "公开内容、链接与Skill结构", "check-public-content.mjs"],
  ["02-terminal-semantics", "终态语义", "check-mechanism-semantics.mjs"],
  ["03-loss-recovery", "失联与恢复语义", "check-lifecycle-recovery-semantics.mjs"],
  ["04-write-isolation", "清晰写入与任务起点", "check-write-isolation-semantics.mjs"],
  ["05-rule-ownership", "规则所有权与文档定位", "check-rule-ownership-semantics.mjs"],
  ["06-system-read-paths", "全系统真实读取路径", "check-system-read-paths.mjs"],
  ["07-action-and-ops", "Action双入口与运维暂停", "check-action-entry-and-ops-pause-semantics.mjs"],
  ["08-architecture-boundaries", "架构、模板与身份边界", "check-architecture-template-boundaries.mjs"],
];
for (const [id, label, script] of staticChecks) {
  run(id, label, process.execPath, [path.join(repositoryRoot, "scripts", script)]);
}

run(
  "09-d03-callback",
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
  "10-source-direct",
  "源码直读业务测试",
  process.execPath,
  ["--test", path.join(sourceDirect, "test", "normalizeLabel.test.js")],
  sourceDirect,
);
run(
  "11-dev-self-check",
  "四层夹具开发自检",
  process.execPath,
  [path.join(fourLayer, "scripts", "dev-self-check.mjs")],
  fourLayer,
);
run(
  "12-independent-test",
  "四层夹具独立测试",
  process.execPath,
  [path.join(fourLayer, "test", "independent-test.mjs")],
  fourLayer,
);
for (const [id, label, action] of [
  ["13-ops-preflight", "隔离运维预检", "preflight"],
  ["14-ops-health", "隔离运维健康检查", "health"],
  ["15-ops-business", "隔离运维业务检查", "business"],
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
  "16-git-diff-check",
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
      ? "mcr08_source_regression_passed"
      : "mcr08_source_regression_failed",
  round,
  commands: records.length,
  passedCommands: records.length - failed.length,
  failedCommands: failed.length,
  failedCommandIds: failed.map((record) => record.id),
  sourceFilesRead: before.length,
  sourceBytesRead: before.reduce((sum, item) => sum + item.bytes, 0),
  sourceDrift: drift,
  scope: "uninstalled_source_direct_and_local_fixture_only",
  exclusions: [
    "installed_skills",
    "wanshitong",
    "network",
    "servers",
    "real_services",
    "production",
    "business_data",
    "git_writes",
    "real_deployment_or_release",
  ],
};
fs.writeFileSync(
  path.join(taskRoot, "final-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(summary, null, 2));

if (summary.verdict !== "mcr08_source_regression_passed") {
  process.exitCode = 1;
}
