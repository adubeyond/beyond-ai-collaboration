import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const controlRoot = resolve(dirname(scriptPath), "..");
const decoder = new TextDecoder("utf-8", { fatal: true });
const runtimeVersionPattern = /<!-- BEYOND-RUNTIME-VERSION: ([^ ]+) -->/;
const overrideBegin = "<!-- BEGIN BEYOND PROJECT OVERRIDES -->";
const overrideEnd = "<!-- END BEYOND PROJECT OVERRIDES -->";
const nativeBegin = "<!-- BEGIN PROJECT NATIVE RULES -->";
const nativeEnd = "<!-- END PROJECT NATIVE RULES -->";
const runtimeGuardRelative = ".codex/beyond-runtime-guard.mjs";
const runtimeHooksRelative = ".codex/hooks.json";

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function has(name) {
  return process.argv.includes(name);
}

function display(path) {
  return path.split(sep).join("/");
}

function canonicalPath(value) {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function samePath(left, right) {
  return canonicalPath(left).toLowerCase() === canonicalPath(right).toLowerCase();
}

function isInside(parent, child) {
  const nested = relative(canonicalPath(parent), canonicalPath(child));
  return Boolean(nested) && !nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested);
}

function readUtf8(path, label = path) {
  if (!existsSync(path) || !lstatSync(path).isFile()) fail(`${label}不存在：${display(path)}`);
  const bytes = readFileSync(path);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${label}包含UTF-8 BOM：${display(path)}`);
  }
  try {
    return decoder.decode(bytes).replace(/\r\n/g, "\n");
  } catch {
    fail(`${label}不是严格UTF-8：${display(path)}`);
  }
}

function writeUtf8(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.replace(/\r\n/g, "\n"), "utf8");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? controlRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function runGit(args, cwd = controlRoot, allowFailure = false) {
  const result = run("git", args, { cwd });
  if (!allowFailure && result.status !== 0) {
    fail(`Git命令失败：git ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result;
}

function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 12)}`;
}

function normalizedRemote(value) {
  return value
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function safeRemote(value) {
  const trimmed = String(value ?? "").trim().replace(/[\r\n]+/g, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (/^https?:$/i.test(url.protocol)) url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    fail("Git remote不是可安全登记的地址；请先改用不含凭据的remote");
  }
}

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  const result = {};
  if (!match) return result;
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function registeredProjectId(projectRoot, remote) {
  const matches = new Set();
  const localDirectory = join(controlRoot, "local", "projects");
  if (existsSync(localDirectory)) {
    for (const entry of readdirSync(localDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const facts = frontmatter(readUtf8(join(localDirectory, entry.name)));
      if (facts.id && facts.path && resolve(facts.path).toLowerCase() === projectRoot.toLowerCase()) matches.add(facts.id);
    }
  }
  const sharedDirectory = join(controlRoot, "shared", "projects");
  if (remote && existsSync(sharedDirectory)) {
    for (const entry of readdirSync(sharedDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const facts = frontmatter(readUtf8(join(sharedDirectory, entry.name)));
      if (facts.id && facts.remote && normalizedRemote(facts.remote) === normalizedRemote(remote)) matches.add(facts.id);
    }
  }
  if (matches.size > 1) fail(`项目登记冲突：同一路径或remote对应多个项目编号：${[...matches].join(", ")}`);
  return [...matches][0] ?? null;
}

const ignoredDiscoveryDirectories = new Set([
  ".git", ".next", ".pytest_cache", ".tmp", ".codex_build", ".codex_exports",
  ".codex_release", ".codex-artifacts", ".codex-out", "node_modules", "dist",
  "build", "coverage", "vendor", "artifacts", "logs", "tmp", "_publish", ".tmp_publish",
]);

function repositoryFacts(repositoryRoot) {
  const remoteResult = runGit(["remote", "get-url", "origin"], repositoryRoot, true);
  const branchResult = runGit(["branch", "--show-current"], repositoryRoot, true);
  const statusResult = runGit(["status", "--porcelain=v1", "--untracked-files=all"], repositoryRoot, true);
  const statusLines = statusResult.status === 0 ? statusResult.stdout.split("\n").filter(Boolean) : [];
  const remote = remoteResult.status === 0 ? safeRemote(remoteResult.stdout) : null;
  return {
    path: display(repositoryRoot),
    remote,
    normalizedRemote: remote ? normalizedRemote(remote) : null,
    branch: branchResult.status === 0 && branchResult.stdout ? branchResult.stdout : null,
    trackedChanges: statusLines.filter((line) => !line.startsWith("??")).length,
    untracked: statusLines.filter((line) => line.startsWith("??")).length,
  };
}

function discoverRepositories(projectRoot, rootGit) {
  const roots = new Set();
  if (rootGit) roots.add(rootGit);
  for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredDiscoveryDirectories.has(entry.name)) continue;
    const candidate = join(projectRoot, entry.name);
    if (samePath(candidate, controlRoot)) continue;
    if (existsSync(join(candidate, ".git"))) roots.add(candidate);
  }
  const repositories = [...roots].sort((left, right) => left.localeCompare(right)).map(repositoryFacts);
  const byRemote = new Map();
  for (const repository of repositories) {
    if (!repository.normalizedRemote) continue;
    const paths = byRemote.get(repository.normalizedRemote) ?? [];
    paths.push(repository.path);
    byRemote.set(repository.normalizedRemote, paths);
  }
  const remoteConflicts = [...byRemote.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([remote, paths]) => ({ remote, paths }));
  return { repositories, remoteConflicts };
}

function discoveryClass(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  if (/(^|\/)agents\.md$/.test(lower)) return "formal";
  if (/^(readme(?:\.[^/]+)?\.md|docs\/readme(?:\.[^/]+)?\.md)$/.test(lower)) return "formal";
  if (/(^|\/)docs\/ai编程协同机制\/(00-模板入口|当前工作台|项目总览)\.md$/.test(lower)
    || /(^|\/)docs\/ai编程协同机制\/项目事实\/readme\.md$/.test(lower)) return "formal";
  if (/(部署|运维|发布|回滚|架构|工程|开发|测试).*(索引|说明|流程|手册).*\.md$/i.test(normalized)) return "formal";
  if (/(^|\/)(归档|archive|history|历史|记录)(\/|$)/i.test(normalized)) return "archive";
  return "normal";
}

function discoverMarkdown(projectRoot) {
  const records = [];
  const excluded = new Map();
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (samePath(path, controlRoot)) continue;
        if (ignoredDiscoveryDirectories.has(entry.name)) {
          const key = display(relative(projectRoot, path));
          excluded.set(key, entry.name);
        } else walk(path);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const relativePath = display(relative(projectRoot, path));
        records.push({ path: relativePath, class: discoveryClass(relativePath) });
      }
    }
  }
  walk(projectRoot);
  const rank = { formal: 0, normal: 1, archive: 2 };
  records.sort((left, right) => rank[left.class] - rank[right.class] || left.path.localeCompare(right.path));
  const counts = { formal: 0, normal: 0, archive: 0 };
  for (const record of records) counts[record.class] += 1;
  return {
    markdown: records.slice(0, 200),
    markdownTotal: records.length,
    markdownCounts: counts,
    markdownTruncated: records.length > 200,
    excludedDirectories: [...excluded.keys()].sort(),
  };
}

function legacyWorkbenchFacts(projectRoot) {
  const candidates = [
    join(projectRoot, "docs", "AI编程协同机制", "当前工作台.md"),
    join(projectRoot, "AI编程协同机制", "当前工作台.md"),
    join(projectRoot, "当前工作台.md"),
  ];
  const source = candidates.find((path) => existsSync(path) && lstatSync(path).isFile());
  if (!source) return null;
  const lines = readUtf8(source, "旧项目当前工作台").split("\n");
  const section = lines.findIndex((line) => /^###\s+1\.2\s+正式任务表\s*$/.test(line.trim()));
  if (section < 0) return { path: display(source), parseable: false, reason: "缺少1.2正式任务表" };
  const headerLine = lines.findIndex((line, index) => index > section && line.trim().startsWith("|"));
  const header = headerLine >= 0 ? markdownCells(lines[headerLine]) : null;
  if (!header || header.length < 3) return { path: display(source), parseable: false, reason: "任务表表头无效" };
  const indexes = {
    task: header.findIndex((cell) => cell.includes("任务")),
    worker: header.findIndex((cell) => cell.includes("负责人")),
    status: header.findIndex((cell) => cell === "状态"),
    progress: header.findIndex((cell) => cell.includes("当前进度")),
    pause: header.findIndex((cell) => cell.includes("暂停原因")),
    result: header.findIndex((cell) => cell.includes("正式结果")),
    updated: header.findIndex((cell) => cell.includes("更新时间")),
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    return { path: display(source), parseable: false, reason: "任务表缺少必要列" };
  }
  const records = [];
  for (let index = headerLine + 2; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith("|")) break;
    const cells = markdownCells(lines[index]);
    if (!cells || cells.length !== header.length) continue;
    const status = cells[indexes.status];
    if (!["进行中", "已暂停", "已完成"].includes(status)) continue;
    records.push(Object.fromEntries(Object.entries(indexes).map(([key, column]) => [key, cells[column]])));
  }
  const counts = { 进行中: 0, 已暂停: 0, 已完成: 0 };
  for (const record of records) counts[record.status] += 1;
  return {
    path: display(source),
    parseable: true,
    counts,
    active: records.filter((record) => record.status !== "已完成"),
    completed: records.filter((record) => record.status === "已完成").map((record) => ({
      task: record.task,
      worker: record.worker,
      result: record.result,
      updated: record.updated,
    })),
  };
}

function inspectProject(projectRootValue) {
  if (!projectRootValue) fail("缺少 --project-root <业务项目目录>", 2);
  const projectRoot = resolve(projectRootValue);
  if (!existsSync(projectRoot) || !lstatSync(projectRoot).isDirectory()) {
    fail(`业务项目目录不存在：${display(projectRoot)}`);
  }
  const topLevel = runGit(["rev-parse", "--show-toplevel"], projectRoot, true);
  const gitRoot = topLevel.status === 0 ? resolve(topLevel.stdout) : null;
  const remoteResult = gitRoot
    ? runGit(["remote", "get-url", "origin"], gitRoot, true)
    : { status: 1, stdout: "" };
  const remote = remoteResult.status === 0 ? safeRemote(remoteResult.stdout) : null;
  const identity = remote ? normalizedRemote(remote) : projectRoot.toLowerCase();
  const projectId = registeredProjectId(projectRoot, remote) ?? stableId(remote ? "project" : "local", identity);
  const discovery = discoverMarkdown(projectRoot);
  const repositoryDiscovery = discoverRepositories(projectRoot, gitRoot);
  const legacyWorkbench = legacyWorkbenchFacts(projectRoot);
  return {
    projectId,
    name: basename(projectRoot),
    projectRoot: display(projectRoot),
    gitRoot: gitRoot ? display(gitRoot) : null,
    remote,
    hostId: arg("--host-id"),
    codexProjectId: arg("--codex-project-id"),
    agentsPath: existsSync(join(projectRoot, "AGENTS.md")) ? display(join(projectRoot, "AGENTS.md")) : null,
    ...discovery,
    repositories: repositoryDiscovery.repositories,
    remoteConflicts: repositoryDiscovery.remoteConflicts,
    legacyWorkbench,
    adoptionRequired: Boolean(
      repositoryDiscovery.remoteConflicts.length
      || legacyWorkbench?.parseable && (legacyWorkbench.counts.进行中 + legacyWorkbench.counts.已暂停 > 0)
    ),
  };
}

function requiredDirectories() {
  return [
    "projects",
    "shared/projects",
    "shared/tasks/active",
    "shared/tasks/archive",
    "shared/collaborations/active",
    "shared/collaborations/details",
    "shared/collaborations/responses",
    "shared/collaborations/archive",
    "local/projects",
  ];
}

function ensureControl() {
  for (const directory of requiredDirectories()) mkdirSync(join(controlRoot, directory), { recursive: true });
  const ignorePath = join(controlRoot, ".gitignore");
  const ignore = existsSync(ignorePath) ? readUtf8(ignorePath) : "";
  if (!ignore.split("\n").some((line) => line.trim() === "/local/")) {
    writeUtf8(ignorePath, `${ignore.trimEnd()}\n/local/\n`.replace(/^\n/, ""));
  }
  if (!existsSync(join(controlRoot, ".git"))) runGit(["init"], controlRoot);
  const workbench = join(controlRoot, "local", "当前工作台.md");
  if (!existsSync(workbench)) {
    const source = join(controlRoot, "docs", "AI编程协同机制", "当前工作台.md");
    writeUtf8(workbench, existsSync(source) ? readUtf8(source) : "# 当前工作台\n");
  }
}

function ensureProjectControlIsolation(project) {
  if (!isInside(project.projectRoot, controlRoot)) {
    fail("项目内初始化要求beyond-control位于 --project-root 目录之下；外置控制仓请不要传 --project-root", 2);
  }
  if (!project.gitRoot || !samePath(project.gitRoot, project.projectRoot)) {
    return { changed: false, rules: [], backup: null };
  }
  const nestedControl = display(relative(project.projectRoot, controlRoot));
  const rules = [`/${nestedControl}/`, "/.beyond-local-backups/"];
  const ignorePath = join(project.projectRoot, ".gitignore");
  const existing = existsSync(ignorePath) ? readUtf8(ignorePath, "项目.gitignore") : "";
  const existingRules = new Set(existing.split("\n").map((line) => line.trim()));
  const missingRules = rules.filter((rule) => !existingRules.has(rule));
  if (!missingRules.length) {
    return { changed: false, rules, backup: null };
  }
  let backup = null;
  if (existing) {
    const backupDirectory = join(controlRoot, "local", "backups", "project-init", project.projectId);
    mkdirSync(backupDirectory, { recursive: true });
    backup = join(backupDirectory, `${timestamp()}-gitignore`);
    copyFileSync(ignorePath, backup);
  }
  writeUtf8(ignorePath, `${existing.trimEnd()}\n${missingRules.join("\n")}\n`.replace(/^\n/, ""));
  return { changed: true, rules, backup };
}

function activeRecords(root, type) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => {
      const path = join(root, entry.name);
      const text = readUtf8(path);
      const facts = frontmatter(text);
      const heading = text.match(/^#\s+(.+)$/m)?.[1] ?? entry.name;
      return { type, file: display(relative(controlRoot, path)), title: heading, ...facts };
    });
}

function markdownCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = [];
  let current = "";
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim() || !trimmed.endsWith("|")) cells.push(current.trim());
  return cells;
}

function workbenchTasks(text) {
  const lines = text.split("\n");
  const section = lines.findIndex((line) => /^###\s+1\.2\s+正式任务表\s*$/.test(line.trim()));
  if (section < 0) fail("当前工作台缺少“1.2 正式任务表”，停止自动汇总或收拢");
  const headerLine = lines.findIndex((line, index) => index > section && line.trim().startsWith("|"));
  const separatorLine = headerLine + 1;
  const header = headerLine >= 0 ? markdownCells(lines[headerLine]) : null;
  const separator = separatorLine < lines.length ? markdownCells(lines[separatorLine]) : null;
  if (!header || !separator || header.length !== 7 || separator.length !== header.length) {
    fail("当前工作台正式任务表结构无效，停止自动汇总或收拢");
  }
  const indexes = {
    task: header.findIndex((cell) => cell.includes("任务")),
    worker: header.findIndex((cell) => cell.includes("负责人")),
    status: header.findIndex((cell) => cell === "状态"),
    progress: header.findIndex((cell) => cell.includes("当前进度")),
    pause: header.findIndex((cell) => cell.includes("暂停原因")),
    result: header.findIndex((cell) => cell.includes("正式结果")),
    updated: header.findIndex((cell) => cell.includes("更新时间")),
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    fail("当前工作台正式任务表缺少必要列，停止自动汇总或收拢");
  }
  const records = [];
  for (let lineIndex = separatorLine + 1; lineIndex < lines.length; lineIndex += 1) {
    if (!lines[lineIndex].trim().startsWith("|")) break;
    const cells = markdownCells(lines[lineIndex]);
    if (!cells || cells.length !== header.length) fail(`当前工作台任务行列数无效：第${lineIndex + 1}行`);
    if (cells[indexes.task].startsWith("<")) continue;
    if (!["进行中", "已暂停", "已完成"].includes(cells[indexes.status])) {
      fail(`当前工作台任务状态无效：${cells[indexes.task]} = ${cells[indexes.status]}`);
    }
    records.push({
      lineIndex,
      task: cells[indexes.task],
      worker: cells[indexes.worker],
      status: cells[indexes.status],
      progress: cells[indexes.progress],
      pause: cells[indexes.pause],
      result: cells[indexes.result],
      updated: cells[indexes.updated],
    });
  }
  return { lines, records, header, indexes, separatorLine };
}

function workbenchSnapshot(text) {
  const lines = text.split("\n");
  const section = lines.findIndex((line) => /^###\s+1\.1\s+项目快照\s*$/.test(line.trim()));
  if (section < 0) fail("当前工作台缺少“1.1 项目快照”，停止快照更新");
  const headerLine = lines.findIndex((line, index) => index > section && line.trim().startsWith("|"));
  const separatorLine = headerLine + 1;
  const header = headerLine >= 0 ? markdownCells(lines[headerLine]) : null;
  const separator = separatorLine < lines.length ? markdownCells(lines[separatorLine]) : null;
  if (!header || !separator || header.length !== 7 || separator.length !== header.length) {
    fail("当前工作台项目快照结构无效，停止快照更新");
  }
  const indexes = {
    updated: header.findIndex((cell) => cell.includes("更新时间")),
    mainline: header.findIndex((cell) => cell.includes("当前主线")),
    status: header.findIndex((cell) => cell.includes("项目状态")),
    problem: header.findIndex((cell) => cell.includes("当前主要问题")),
    evidence: header.findIndex((cell) => cell.includes("最近一手依据")),
    next: header.findIndex((cell) => cell.includes("当前下一步")),
    decision: header.findIndex((cell) => cell.includes("需要用户决定")),
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    fail("当前工作台项目快照缺少必要列，停止快照更新");
  }
  const dataLines = [];
  for (let lineIndex = separatorLine + 1; lineIndex < lines.length; lineIndex += 1) {
    if (!lines[lineIndex].trim().startsWith("|")) break;
    const cells = markdownCells(lines[lineIndex]);
    if (!cells || cells.length !== header.length) fail(`当前工作台项目快照列数无效：第${lineIndex + 1}行`);
    dataLines.push(lineIndex);
  }
  if (dataLines.length !== 1) fail("当前工作台必须且只能有一行项目快照，停止快照更新");
  return { lines, header, indexes, lineIndex: dataLines[0] };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function workbenchRecordLine(parsed, record) {
  const cells = new Array(parsed.header.length).fill("");
  for (const [field, index] of Object.entries(parsed.indexes)) cells[index] = markdownCell(record[field]);
  return `| ${cells.join(" | ")} |`;
}

function workbench() {
  ensureControl();
  const action = arg("--action") ?? "list";
  const workbenchPath = join(controlRoot, "local", "当前工作台.md");
  const parsed = workbenchTasks(readUtf8(workbenchPath, "本机当前工作台"));
  if (action === "list") {
    const counts = { 进行中: 0, 已暂停: 0, 已完成: 0 };
    for (const record of parsed.records) counts[record.status] += 1;
    console.log(JSON.stringify({ count: parsed.records.length, counts, records: parsed.records.map(({ lineIndex, ...record }) => record) }, null, 2));
    return;
  }
  if (action === "upsert") {
    const record = {
      task: arg("--task") ?? "",
      worker: arg("--thread") ?? "",
      status: arg("--status") ?? "",
      progress: arg("--progress") ?? "无",
      pause: arg("--pause") ?? "无",
      result: arg("--result") ?? "无",
      updated: arg("--updated") ?? new Date().toISOString().slice(0, 10),
    };
    const fields = [record.task, record.worker, record.progress, record.pause, record.result];
    if (!record.task || !record.worker || fields.some((value) => value.length > 500 || /[\r\n]/.test(value))) {
      fail("工作台任务字段无效", 2);
    }
    if (!["进行中", "已暂停", "已完成"].includes(record.status)) {
      fail(`工作台任务状态无效：${record.status}`, 2);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.updated) || Number.isNaN(Date.parse(`${record.updated}T00:00:00Z`))) {
      fail(`工作台更新时间无效：${record.updated}`, 2);
    }
    if (record.status === "已暂停" && (!record.pause || record.pause === "无")) {
      fail("已暂停任务必须说明暂停原因与恢复条件", 2);
    }
    if (record.status === "已完成" && (!record.result || record.result === "无")) {
      fail("已完成任务必须提供正式结果或证据入口", 2);
    }
    const sameThread = parsed.records.filter((item) => item.worker === record.worker);
    if (sameThread.length > 1) fail(`工作台存在重复正式thread：${record.worker}`);
    if (!sameThread.length && parsed.records.some((item) => item.task === record.task && item.worker !== "无")) {
      fail(`工作台已存在同名任务但正式thread不同：${record.task}`);
    }
    const lines = [...parsed.lines];
    let mode = "updated";
    if (sameThread.length === 1) {
      lines[sameThread[0].lineIndex] = workbenchRecordLine(parsed, record);
    } else {
      const placeholders = parsed.records.filter((item) => item.task === "当前无活动正式任务" && item.worker === "无");
      if (placeholders.length > 1) fail("工作台存在重复的空任务占位行");
      if (placeholders.length === 1) lines[placeholders[0].lineIndex] = workbenchRecordLine(parsed, record);
      else lines.splice(parsed.separatorLine + 1, 0, workbenchRecordLine(parsed, record));
      mode = "created";
    }
    const backup = backupLocal("workbench-upsert");
    writeUtf8(workbenchPath, lines.join("\n").replace(/\n*$/, "\n"));
    console.log(JSON.stringify({ mode, thread: record.worker, status: record.status, localBackup: display(backup) }, null, 2));
    return;
  }
  if (action === "snapshot") {
    const snapshot = workbenchSnapshot(readUtf8(workbenchPath, "本机当前工作台"));
    const record = {
      updated: arg("--updated") ?? new Date().toISOString().slice(0, 10),
      mainline: arg("--mainline") ?? "",
      status: arg("--status") ?? "",
      problem: arg("--problem") ?? "无",
      evidence: arg("--evidence") ?? "无",
      next: arg("--next") ?? "无",
      decision: arg("--decision") ?? "无",
    };
    const fields = [record.mainline, record.problem, record.evidence, record.next, record.decision];
    if (!record.mainline || fields.some((value) => value.length > 500 || /[\r\n]/.test(value))) {
      fail("工作台项目快照字段无效", 2);
    }
    if (!["进行中", "已暂停", "已完成"].includes(record.status)) {
      fail(`工作台项目状态无效：${record.status}`, 2);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.updated) || Number.isNaN(Date.parse(`${record.updated}T00:00:00Z`))) {
      fail(`工作台快照更新时间无效：${record.updated}`, 2);
    }
    snapshot.lines[snapshot.lineIndex] = workbenchRecordLine(snapshot, record);
    const backup = backupLocal("workbench-snapshot");
    writeUtf8(workbenchPath, snapshot.lines.join("\n").replace(/\n*$/, "\n"));
    console.log(JSON.stringify({ mainline: record.mainline, status: record.status, localBackup: display(backup) }, null, 2));
    return;
  }
  if (action !== "archive") fail(`未知工作台动作：${action}`, 2);
  const requested = (arg("--threads") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!requested.length) fail("工作台收拢需要 --threads <逗号分隔的正式thread>", 2);
  if (new Set(requested).size !== requested.length || requested.some((value) => value.length > 200 || /[|\r\n]/.test(value))) {
    fail("工作台收拢的thread列表无效", 2);
  }
  const selected = requested.map((thread) => {
    const matches = parsed.records.filter((record) => record.worker === thread);
    if (matches.length !== 1) fail(`工作台中没有唯一匹配的正式thread：${thread}`);
    const record = matches[0];
    if (record.status !== "已完成") fail(`只有已完成任务可以移出高频区：${thread}`);
    if (!record.result || record.result === "无" || record.result.startsWith("<")) {
      fail(`已完成任务缺少正式结果或证据入口：${thread}`);
    }
    return record;
  });
  const completedAt = arg("--completed-at") ?? new Date().toISOString();
  const month = completedAt.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || Number.isNaN(Date.parse(completedAt))) {
    fail(`完成时间无效：${completedAt}`, 2);
  }
  const historyPath = join(controlRoot, "local", "history", "tasks", `${month}.md`);
  const historyHeader = `# ${month}本机完成任务归档\n\n| 任务 / 业务结果 | 负责人 / 正式 thread | 正式结果 / 证据入口 | 原更新时间 | 收拢时间 |\n| --- | --- | --- | --- | --- |\n`;
  let history = existsSync(historyPath) ? readUtf8(historyPath) : historyHeader;
  for (const record of selected) {
    if (history.split("\n").some((line) => markdownCells(line)?.[1] === record.worker)) {
      fail(`本机历史已经存在该正式thread，停止重复收拢：${record.worker}`);
    }
  }
  const backup = backupLocal("workbench-archive");
  for (const record of selected) {
    history = `${history.trimEnd()}\n| ${markdownCell(record.task)} | ${markdownCell(record.worker)} | ${markdownCell(record.result)} | ${markdownCell(record.updated)} | ${markdownCell(completedAt)} |\n`;
  }
  const removedLines = new Set(selected.map((record) => record.lineIndex));
  const remaining = parsed.lines.filter((_line, index) => !removedLines.has(index)).join("\n").replace(/\n*$/, "\n");
  writeUtf8(historyPath, history);
  writeUtf8(workbenchPath, remaining);
  console.log(JSON.stringify({
    archived: selected.map((record) => record.worker),
    archive: display(relative(controlRoot, historyPath)),
    localBackup: display(backup),
    remaining: parsed.records.length - selected.length,
  }, null, 2));
}

function detectGitAccount() {
  const provided = arg("--git-account");
  if (provided) return provided;
  const remoteResult = runGit(["remote", "get-url", "origin"], controlRoot, true);
  if (remoteResult.status !== 0) {
    fail("控制仓尚无远程仓库，无法确认当前远程Git账号；请先配置团队远程或传入已由用户确认的 --git-account", 2);
  }
  const remote = remoteResult.stdout.toLowerCase();
  if (remote.includes("github.com")) {
    const current = run("gh", ["api", "user", "--jq", ".login"], { cwd: controlRoot });
    if (current.status === 0 && current.stdout) return current.stdout;
  }
  if (remote.includes("gitlab")) {
    const current = run("glab", ["api", "user"], { cwd: controlRoot });
    if (current.status === 0 && current.stdout) {
      try {
        const parsed = JSON.parse(current.stdout);
        if (parsed.username) return parsed.username;
      } catch {
        // The caller receives the normal identity failure below.
      }
    }
  }
  fail("无法从远程平台CLI确认当前Git账号；不要用git user.name冒充权限身份，请先登录对应平台CLI或传入已由用户确认的 --git-account", 2);
}

function backupRoot() {
  return join(dirname(controlRoot), ".beyond-local-backups", basename(controlRoot));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupLocal(reason = "manual") {
  ensureControl();
  const source = join(controlRoot, "local");
  const stem = `${timestamp()}-${reason.replace(/[^a-z0-9_-]+/gi, "-")}`;
  let target = join(backupRoot(), stem);
  let suffix = 1;
  while (existsSync(target)) target = join(backupRoot(), `${stem}-${suffix++}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, errorOnExist: true });
  return target;
}

function extractBetween(text, begin, end) {
  const start = text.indexOf(begin);
  const finish = text.indexOf(end);
  if (start < 0 || finish < start) return "";
  return text.slice(start + begin.length, finish).trim();
}

function renderProjectEntry(project, existingText) {
  let source = readUtf8(join(controlRoot, "AGENTS.md"), "控制仓AGENTS.md");
  const controlRelativeRaw = relative(project.projectRoot, controlRoot) || ".";
  const controlRelative = isAbsolute(controlRelativeRaw)
    ? display(controlRoot)
    : display(controlRelativeRaw).replace(/^(?!\.)/, "./");
  source = source.replace(/\]\((docs\/[^)\r\n]+)\)/g, (_match, target) => {
    const mapped = `${controlRelative}/${target}`;
    return `](${/\s/.test(mapped) ? `<${mapped}>` : mapped})`;
  });
  source = source.replace(/\]\((scripts\/[^)\r\n]+)\)/g, (_match, target) => {
    const mapped = `${controlRelative}/${target}`;
    return `](${/\s/.test(mapped) ? `<${mapped}>` : mapped})`;
  });
  source = source.replace(/\]\(local\//g, `](${controlRelative}/local/`);
  source = source.replace(/\]\(projects\//g, `](${controlRelative}/projects/`);
  source = source.replace(/`scripts\//g, `\`${controlRelative}/scripts/`);
  source = source.replace(/`local\//g, `\`${controlRelative}/local/`);
  source = source.replace(/`projects\//g, `\`${controlRelative}/projects/`);
  source = source.replaceAll("<project-id>", project.projectId);
  source = source.replace(
    runtimeVersionPattern,
    (marker) => `${marker}\n<!-- BEYOND-CONTROL-ROOT: ${controlRelative} -->\n<!-- BEYOND-PROJECT-ID: ${project.projectId} -->`,
  );

  let overrides = "";
  let native = "";
  if (existingText) {
    if (runtimeVersionPattern.test(existingText)) {
      overrides = extractBetween(existingText, overrideBegin, overrideEnd);
      native = extractBetween(existingText, nativeBegin, nativeEnd);
    } else {
      native = existingText.trim();
    }
  }
  if (overrides) {
    source = source.replace("<!-- 没有项目特有覆盖时保持为空。 -->", overrides);
  }
  source = `${source.trimEnd()}\n\n${nativeBegin}\n${native || "<!-- 没有项目原生规则时保持为空。 -->"}\n${nativeEnd}\n`;
  return { text: source, controlRelative };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label}不是有效JSON：${error.message}`);
  }
}

function beyondHook(handler) {
  if (!handler || typeof handler !== "object") return false;
  return [handler.command, handler.commandWindows, handler.command_windows]
    .some((value) => typeof value === "string" && value.includes("beyond-runtime-guard.mjs"));
}

function prepareProjectRuntimeGuard(project) {
  const sourceGuardPath = join(controlRoot, runtimeGuardRelative);
  const sourceHooksPath = join(controlRoot, runtimeHooksRelative);
  const targetGuardPath = join(project.projectRoot, runtimeGuardRelative);
  const targetHooksPath = join(project.projectRoot, runtimeHooksRelative);
  const sourceGuard = readUtf8(sourceGuardPath, "BEYOND身份护栏脚本");
  const sourceHooksText = readUtf8(sourceHooksPath, "BEYOND Hook配置");
  const sourceHooks = parseJson(sourceHooksText, "BEYOND Hook配置");
  if (!sourceHooks.hooks || typeof sourceHooks.hooks !== "object") fail("BEYOND Hook配置缺少hooks对象");
  const controlRelativeRaw = relative(project.projectRoot, controlRoot) || ".";
  const controlRelative = isAbsolute(controlRelativeRaw)
    ? display(controlRoot)
    : display(controlRelativeRaw).replace(/^(?!\.)/, "./");
  const commandSuffix = ` --control-root ${JSON.stringify(controlRelative)} --project-id ${JSON.stringify(project.projectId)}`;
  const installedGroups = Object.fromEntries(Object.entries(sourceHooks.hooks).map(([event, groups]) => [
    event,
    groups.map((group) => ({
      ...group,
      hooks: group.hooks.map((handler) => ({
        ...handler,
        command: beyondHook(handler) ? `${handler.command}${commandSuffix}` : handler.command,
      })),
    })),
  ]));

  const existingHooksText = existsSync(targetHooksPath) ? readUtf8(targetHooksPath, "项目现有Hook配置") : null;
  const merged = existingHooksText ? parseJson(existingHooksText, "项目现有Hook配置") : { hooks: {} };
  if (!merged.hooks || typeof merged.hooks !== "object" || Array.isArray(merged.hooks)) {
    fail("项目现有Hook配置缺少可合并的hooks对象；未覆盖原文件");
  }

  for (const [event, candidateGroups] of Object.entries(installedGroups)) {
    const currentGroups = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    merged.hooks[event] = currentGroups
      .map((group) => {
        if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return group;
        return { ...group, hooks: group.hooks.filter((handler) => !beyondHook(handler)) };
      })
      .filter((group) => !group || typeof group !== "object" || !Array.isArray(group.hooks) || group.hooks.length > 0)
      .concat(candidateGroups);
  }

  return {
    sourceGuard,
    hooksText: `${JSON.stringify(merged, null, 2)}\n`,
    targetGuardPath,
    targetHooksPath,
  };
}

function registerProject(project, nameValue = null) {
  if (samePath(project.projectRoot, controlRoot)) {
    fail("控制仓不能把自身登记或融合为业务项目；请传入承载该控制仓的项目根，或另一个真实业务项目目录", 2);
  }
  ensureControl();
  const localBackup = backupLocal("before-project-register");
  const sharedPath = join(controlRoot, "shared", "projects", `${project.projectId}.md`);
  const localPath = join(controlRoot, "local", "projects", `${project.projectId}.md`);
  const overviewPath = join(controlRoot, "projects", project.projectId, "项目总览.md");
  const factsPath = join(controlRoot, "projects", project.projectId, "项目事实", "README.md");
  const name = String(nameValue || project.name).trim().replace(/[\r\n]+/g, " ");
  if (!name) fail("项目名称不能为空");
  if (!existsSync(sharedPath)) {
    writeUtf8(sharedPath, `---\nid: ${project.projectId}\nname: ${name}\nremote: ${project.remote ?? ""}\nupdated_at: ${new Date().toISOString()}\n---\n\n# ${name}\n\n## 共同资料入口\n\n- 待初始化。\n`);
  } else if (project.remote) {
    const existing = readUtf8(sharedPath);
    const facts = frontmatter(existing);
    if (facts.remote && normalizedRemote(facts.remote) !== normalizedRemote(project.remote)) {
      fail(`项目${project.projectId}已经绑定其他remote；停止覆盖：${facts.remote}`);
    }
    if (!facts.remote) {
      const updated = existing
        .replace(/^remote:.*$/m, `remote: ${project.remote}`)
        .replace(/^updated_at:.*$/m, `updated_at: ${new Date().toISOString()}`);
      writeUtf8(sharedPath, updated);
    }
  }
  if (!existsSync(overviewPath)) {
    writeUtf8(overviewPath, `# ${name} 项目总览

> 项目编号：\`${project.projectId}\`。这是最低接入建立的项目文档地基；未知内容保持待确认，不阻断无关任务。

## 项目定位与边界

- 项目名称：${name}
- 最终目标：待确认
- 核心业务边界：待确认
- 正式业务目录与远程身份：见[共享项目登记](../../shared/projects/${project.projectId}.md)和各成员本机映射。

## 长期事实入口

- [项目事实索引](项目事实/README.md)
- 项目已有产品、架构、开发、测试和运维文档：待逐组登记；不自动复制或删除原文档。

## 维护边界

- 这里只保留跨任务稳定的项目定位、边界和事实入口，不记录任务进度、分支、提交或单次运行结果。
- 能从代码、配置、Git、测试或环境确认的内容先调查；无法确认的内容保持待确认。
`);
  }
  if (!existsSync(factsPath)) {
    writeUtf8(factsPath, `# ${name} 项目事实索引

> 项目编号：\`${project.projectId}\`。本索引只登记当前项目已经采用的长期事实入口，不是任务启动许可证或固定文件清单。

| 事实领域 | 当前正式入口 |
| --- | --- |
| 产品、设计与契约 | 待登记已有正式文档 |
| 技术架构与核心逻辑 | 待登记已有正式文档 |
| 工程开发与测试 | 待登记已有正式文档 |
| 运行环境、部署与回滚 | 待登记已有正式文档 |
| 安全与凭据来源 | 待登记合法来源；不得写入秘密值 |

- 当前任务需要某类事实时才定点调查和补充；其他空项不阻断执行。
- 已有可信文档继续作为唯一正文，本索引只登记入口，不复制内容。
- [返回项目总览](../项目总览.md)
`);
  }
  const canonicalRepositories = project.canonicalRepositories?.length
    ? project.canonicalRepositories.map((item) => `- ${item.remote} → ${item.path}`).join("\n")
    : "- 无重复remote需要选择。";
  writeUtf8(localPath, `---\nid: ${project.projectId}\nname: ${name}\npath: ${project.projectRoot}\nremote: ${project.remote ?? ""}\nhost_id: ${project.hostId ?? ""}\ncodex_project_id: ${project.codexProjectId ?? ""}\nupdated_at: ${new Date().toISOString()}\n---\n\n# ${name} 本机登记\n\n- 本机项目路径：${project.projectRoot}\n- 根入口：${project.agentsPath ?? "尚未建立"}\n- Codex主机：${project.hostId ?? "待登记"}\n- Codex项目：${project.codexProjectId ?? "待登记"}\n\n## 重复remote的本机正式路径\n\n${canonicalRepositories}\n`);
  return { sharedPath, overviewPath, factsPath, localPath, localBackup };
}

function selectCanonicalRepositories(project) {
  if (!project.remoteConflicts.length) return [];
  const requested = (arg("--canonical-repositories") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value).toLowerCase());
  const selected = [];
  for (const conflict of project.remoteConflicts) {
    const matches = conflict.paths.filter((path) => requested.includes(resolve(path).toLowerCase()));
    if (matches.length !== 1) {
      fail(`同一remote对应多个本地仓库，必须用 --canonical-repositories 为每组准确选择一个正式路径：\n${conflict.remote}: ${conflict.paths.join(", ")}`, 2);
    }
    selected.push({ remote: conflict.remote, path: matches[0] });
  }
  if (requested.length !== selected.length) fail("--canonical-repositories包含不属于重复remote组或重复的路径", 2);
  return selected;
}

function adoptLegacyWorkbench(project) {
  const legacy = project.legacyWorkbench;
  if (!legacy?.parseable || legacy.active.length === 0) return null;
  const workbenchPath = join(controlRoot, "local", "当前工作台.md");
  const parsed = workbenchTasks(readUtf8(workbenchPath, "本机当前工作台"));
  const lines = [...parsed.lines];
  const imported = [];
  for (const record of legacy.active) {
    const sameThread = parsed.records.filter((item) => item.worker === record.worker);
    if (sameThread.length > 1) fail(`本机工作台已有重复正式thread：${record.worker}`);
    if (sameThread.length === 1) continue;
    if (parsed.records.some((item) => item.task === record.task && item.worker !== record.worker)) {
      fail(`本机工作台已有同名任务但正式thread不同，停止迁移：${record.task}`);
    }
    const normalized = {
      task: record.task,
      worker: record.worker,
      status: record.status,
      progress: record.progress || "从旧项目工作台迁入，待当前现场重证",
      pause: record.pause || "无",
      result: record.result || "无",
      updated: /^\d{4}-\d{2}-\d{2}$/.test(record.updated) ? record.updated : new Date().toISOString().slice(0, 10),
    };
    lines.splice(parsed.separatorLine + 1, 0, workbenchRecordLine(parsed, normalized));
    imported.push(normalized);
  }
  const placeholders = parsed.records.filter((item) => item.task === "当前无活动正式任务" && item.worker === "无");
  for (const placeholder of placeholders.sort((left, right) => right.lineIndex - left.lineIndex)) {
    lines.splice(placeholder.lineIndex + imported.length, 1);
  }
  const backup = backupLocal("before-legacy-workbench-adoption");
  writeUtf8(workbenchPath, lines.join("\n").replace(/\n*$/, "\n"));
  const historyPath = join(controlRoot, "local", "history", "legacy", `${project.projectId}-workbench.md`);
  const completedRows = legacy.completed.length
    ? legacy.completed.map((record) => `| ${markdownCell(record.task)} | ${markdownCell(record.worker)} | ${markdownCell(record.result)} | ${markdownCell(record.updated)} |`).join("\n")
    : "| 无 | 无 | 无 | 无 |";
  writeUtf8(historyPath, `# ${project.name}旧工作台接入记录

- 原工作台：${legacy.path}
- 接入时间：${new Date().toISOString()}
- 活动任务迁入：${imported.length}
- 已完成任务仅归档：${legacy.completed.length}
- 迁入内容只是恢复线索；状态、代码、Git和环境仍需从当前一手现场重证。

| 已完成任务 | 原负责人 / thread | 原结果入口 | 原更新时间 |
| --- | --- | --- | --- |
${completedRows}
`);
  return { imported: imported.length, historyPath, backup };
}

function installProjectEntry(project) {
  if (arg("--confirm-fusion") !== "yes") {
    fail("写入项目AGENTS.md前必须由用户确认融合，并传入 --confirm-fusion yes", 2);
  }
  project.canonicalRepositories = selectCanonicalRepositories(project);
  if (project.legacyWorkbench && !project.legacyWorkbench.parseable && arg("--confirm-legacy-skip") !== "yes") {
    fail(`发现旧工作台但无法安全解析：${project.legacyWorkbench.path}（${project.legacyWorkbench.reason}）。请人工核对后传入 --confirm-legacy-skip yes，不能静默建立空工作台。`, 2);
  }
  if (project.legacyWorkbench?.parseable && project.legacyWorkbench.active.length > 0
    && arg("--adopt-legacy-workbench") !== "yes") {
    fail(`旧工作台仍有${project.legacyWorkbench.active.length}个活动任务；请确认后传入 --adopt-legacy-workbench yes，将活动任务迁入本机工作台、已完成任务进入历史。`, 2);
  }
  const runtimeGuard = prepareProjectRuntimeGuard(project);
  registerProject(project, arg("--name"));
  const projectIsolation = isInside(project.projectRoot, controlRoot)
    ? ensureProjectControlIsolation(project)
    : { changed: false, rules: [], backup: null };
  const adoption = arg("--adopt-legacy-workbench") === "yes" ? adoptLegacyWorkbench(project) : null;
  const target = join(project.projectRoot, "AGENTS.md");
  const existing = existsSync(target) ? readUtf8(target) : "";
  const hadRuntimeHooks = existsSync(runtimeGuard.targetHooksPath);
  const hadRuntimeGuard = existsSync(runtimeGuard.targetGuardPath);
  const backupDirectory = join(controlRoot, "local", "backups", "project-entry", project.projectId);
  const backupStamp = timestamp();
  if (existing) {
    mkdirSync(backupDirectory, { recursive: true });
    copyFileSync(target, join(backupDirectory, `${backupStamp}-AGENTS.md`));
  }
  if (hadRuntimeHooks) {
    mkdirSync(backupDirectory, { recursive: true });
    copyFileSync(runtimeGuard.targetHooksPath, join(backupDirectory, `${backupStamp}-hooks.json`));
  }
  if (hadRuntimeGuard) {
    mkdirSync(backupDirectory, { recursive: true });
    copyFileSync(runtimeGuard.targetGuardPath, join(backupDirectory, `${backupStamp}-beyond-runtime-guard.mjs`));
  }
  const rendered = renderProjectEntry(project, existing);
  writeUtf8(target, rendered.text);
  writeUtf8(runtimeGuard.targetGuardPath, runtimeGuard.sourceGuard);
  writeUtf8(runtimeGuard.targetHooksPath, runtimeGuard.hooksText);
  backupLocal("project-entry");
  return {
    target,
    runtimeGuard: runtimeGuard.targetGuardPath,
    runtimeHooks: runtimeGuard.targetHooksPath,
    backupDirectory: existing || hadRuntimeHooks || hadRuntimeGuard ? backupDirectory : null,
    controlRelative: rendered.controlRelative,
    projectIsolation,
    adoption,
  };
}

function validateSharedPaths(paths, scope) {
  if (!paths.length) fail("推送前必须用 --paths 指定本次团队任务或协同文件", 2);
  const normalized = paths.map((value) => {
    const absolute = resolve(controlRoot, value);
    const relativePath = display(relative(controlRoot, absolute));
    const teamRecord = /^(shared\/(tasks|collaborations)\/).+\.md$/i.test(relativePath);
    const projectRegistration = scope === "project-registration" && (
      /^shared\/projects\/[^/]+\.md$/i.test(relativePath)
      || /^projects\/[^/]+\/项目总览\.md$/i.test(relativePath)
      || /^projects\/[^/]+\/项目事实\/README\.md$/i.test(relativePath)
    );
    if (relativePath.startsWith("../") || (!teamRecord && !projectRegistration)) {
      fail(`PM普通协同推送不允许该路径：${value}`);
    }
    return relativePath;
  });
  if (scope === "project-registration") {
    const projectIds = normalized.map((path) => path.match(/^shared\/projects\/([^/]+)\.md$/i)?.[1]
      ?? path.match(/^projects\/([^/]+)\//i)?.[1]);
    if (new Set(projectIds).size !== 1) fail("一次项目接入同步只能包含同一个项目编号的固定基础文件");
  }
  return normalized;
}

function sync() {
  const action = arg("--action") ?? "pull";
  if (action === "pull") {
    const result = runGit(["pull", "--no-rebase", "--no-edit"], controlRoot, true);
    if (result.status !== 0) fail(`控制仓拉取失败；未丢弃本地内容。\n${result.stderr || result.stdout}`);
    console.log(result.stdout || "控制仓已是最新状态");
    return;
  }
  if (action !== "push") fail(`未知同步动作：${action}`, 2);
  const scope = arg("--scope") ?? "team";
  if (!['team', 'project-registration'].includes(scope)) fail(`未知同步范围：${scope}`, 2);
  const paths = validateSharedPaths((arg("--paths") ?? "").split(",").map((item) => item.trim()).filter(Boolean), scope);
  const message = arg("--message");
  if (!message) fail("推送需要 --message <提交说明>", 2);
  const stagedBefore = runGit(["diff", "--cached", "--name-only"], controlRoot).stdout;
  if (stagedBefore) fail(`控制仓已有暂存内容，停止本次协同提交：\n${stagedBefore}`);
  runGit(["add", "--", ...paths], controlRoot);
  const stagedPaths = runGit(["diff", "--cached", "--name-only", "-z"], controlRoot).stdout
    .split("\0")
    .filter(Boolean)
    .sort();
  const staged = stagedPaths.join("\n");
  if (!stagedPaths.length) {
    console.log("指定团队任务或协同文件没有可提交变化");
    return;
  }
  const requestedPaths = [...new Set(paths)].sort();
  if (JSON.stringify(stagedPaths) !== JSON.stringify(requestedPaths)) {
    runGit(["restore", "--staged", "--", ...stagedPaths], controlRoot, true);
    fail(`实际暂存集合与指定文件不一致，已取消暂存：\n${staged}`);
  }
  runGit(["commit", "-m", message], controlRoot);
  const pull = runGit(["pull", "--rebase"], controlRoot, true);
  if (pull.status !== 0) {
    const conflicts = runGit(["diff", "--name-only", "--diff-filter=U"], controlRoot, true).stdout;
    runGit(["rebase", "--abort"], controlRoot, true);
    fail(`远端变化无法自动整合，已保留本地提交并停止推送。${conflicts ? `\n冲突文件：\n${conflicts}` : ""}`);
  }
  runGit(["push"], controlRoot);
  console.log(`已提交并推送：\n${staged}`);
}

function archiveRecord() {
  const type = arg("--type");
  const id = arg("--id");
  const result = arg("--result");
  if (!['task', 'collaboration'].includes(type) || !id || !result) {
    fail("归档需要 --type task|collaboration --id <编号> --result <最终结果>", 2);
  }
  if (id.length > 160 || id === "." || id === ".." || /[\\/\u0000-\u001f]/.test(id)) {
    fail(`归档编号无效：${id}`, 2);
  }
  const group = type === "task" ? "tasks" : "collaborations";
  const activePath = join(controlRoot, "shared", group, "active", `${id}.md`);
  if (!existsSync(activePath)) fail(`活动记录不存在：${display(activePath)}`);
  const text = readUtf8(activePath);
  const facts = frontmatter(text);
  if (facts.status !== "已完成") fail(`只有状态为“已完成”的记录可以归档：${id}`);
  const tracked = runGit(["ls-files", "--error-unmatch", "--", display(relative(controlRoot, activePath))], controlRoot, true);
  if (tracked.status !== 0) fail(`活动记录尚未进入Git，不能依赖Git历史回收：${id}`);
  const removedPaths = [display(relative(controlRoot, activePath))];
  let collaborationDetail = null;
  let collaborationResponses = null;
  if (type === "collaboration") {
    collaborationDetail = join(controlRoot, "shared", "collaborations", "details", `${id}.md`);
    collaborationResponses = join(controlRoot, "shared", "collaborations", "responses", id);
    const processFiles = [];
    if (existsSync(collaborationDetail)) {
      if (!lstatSync(collaborationDetail).isFile()) fail(`协同详情不是普通文件：${display(collaborationDetail)}`);
      processFiles.push(collaborationDetail);
    }
    if (existsSync(collaborationResponses)) {
      const pending = [collaborationResponses];
      while (pending.length) {
        const currentDirectory = pending.pop();
        for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
          const path = join(currentDirectory, entry.name);
          if (entry.isSymbolicLink()) fail(`协同回复不允许符号链接：${display(path)}`);
          if (entry.isDirectory()) pending.push(path);
          else if (entry.isFile()) processFiles.push(path);
        }
      }
    }
    for (const path of processFiles) {
      const relativePath = display(relative(controlRoot, path));
      if (!relativePath.toLowerCase().endsWith(".md")) fail(`协同过程目录只允许Markdown文件：${relativePath}`);
      const processTracked = runGit(["ls-files", "--error-unmatch", "--", relativePath], controlRoot, true);
      if (processTracked.status !== 0) fail(`协同过程文件尚未进入Git，不能依赖Git历史回收：${relativePath}`);
      removedPaths.push(relativePath);
    }
  }
  const completedAt = arg("--completed-at") ?? new Date().toISOString();
  const month = completedAt.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) fail(`完成时间无效：${completedAt}`);
  const archivePath = join(controlRoot, "shared", group, "archive", `${month}.md`);
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? id).replace(/\|/g, "\\|");
  const owner = (facts.owner ?? facts.initiator ?? "").replace(/\|/g, "\\|");
  const safeResult = result.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const header = `# ${month}${type === "task" ? "团队任务" : "协同事项"}归档\n\n| 编号 | 目标 | 当前承担者/发起人 | 最终结果 | 完成时间 |\n| --- | --- | --- | --- | --- |\n`;
  const current = existsSync(archivePath) ? readUtf8(archivePath) : header;
  let archiveChanged = false;
  if (!current.includes(`| ${id} |`)) {
    writeUtf8(archivePath, `${current.trimEnd()}\n| ${id} | ${title} | ${owner} | ${safeResult} | ${completedAt} |\n`);
    archiveChanged = true;
  }
  if (type === "collaboration") {
    if (existsSync(collaborationDetail)) rmSync(collaborationDetail);
    if (existsSync(collaborationResponses)) rmSync(collaborationResponses, { recursive: true, force: true });
  }
  rmSync(activePath);
  const archiveRelative = display(relative(controlRoot, archivePath));
  console.log(JSON.stringify({
    removed: removedPaths[0],
    removedPaths,
    archive: archiveRelative,
    syncPaths: [...removedPaths, ...(archiveChanged ? [archiveRelative] : [])],
  }, null, 2));
}

function restoreLocal() {
  const snapshotValue = arg("--snapshot");
  if (!snapshotValue || arg("--confirm-restore") !== "yes") {
    fail("恢复需要 --snapshot <备份目录> --confirm-restore yes", 2);
  }
  const snapshot = resolve(snapshotValue);
  const root = resolve(backupRoot());
  const snapshotRelative = relative(root, snapshot);
  if (snapshotRelative.startsWith("..") || isAbsolute(snapshotRelative) || !existsSync(snapshot)) {
    fail(`备份不属于当前控制仓：${display(snapshot)}`);
  }
  const currentBackup = backupLocal("before-restore");
  const target = join(controlRoot, "local");
  const temporary = join(controlRoot, `.local-restore-${Date.now()}`);
  cpSync(snapshot, temporary, { recursive: true, errorOnExist: true });
  rmSync(target, { recursive: true, force: true });
  renameSync(temporary, target);
  console.log(`本机工作台已恢复；恢复前快照：${display(currentBackup)}`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runtimeProjectIdentity(projectRootValue) {
  if (!projectRootValue) fail("缺少 --project-root <业务项目目录>", 2);
  const projectRoot = resolve(projectRootValue);
  const agentsPath = join(projectRoot, "AGENTS.md");
  const agents = readUtf8(agentsPath, "项目AGENTS.md");
  const projectId = agents.match(/<!-- BEYOND-PROJECT-ID: ([^\n]+) -->/)?.[1].trim();
  const mappedControl = agents.match(/<!-- BEYOND-CONTROL-ROOT: ([^\n]+) -->/)?.[1].trim();
  if (!projectId || !mappedControl) fail("项目AGENTS.md缺少完整的BEYOND项目编号或控制仓映射", 2);
  if (resolve(projectRoot, mappedControl).toLowerCase() !== controlRoot.toLowerCase()) {
    fail("项目AGENTS.md映射的控制仓不是当前控制仓", 2);
  }
  return { projectRoot, projectId, agentsPath };
}

function currentRuntimeBinding(projectRoot) {
  const hooksPath = join(projectRoot, runtimeHooksRelative);
  const guardPath = join(projectRoot, runtimeGuardRelative);
  if (!existsSync(hooksPath) || !existsSync(guardPath)) return null;
  return {
    hooksPath,
    guardPath,
    hooksSha256: sha256File(hooksPath),
    guardSha256: sha256File(guardPath),
  };
}

function hookProbe() {
  const hookSession = arg("--hook-session");
  if (!hookSession || !/^[a-f0-9]{64}$/i.test(hookSession)) {
    fail("Hook运行探针没有经过PreToolUse签注；不能把文件存在当成Hook已运行", 2);
  }
  const identity = runtimeProjectIdentity(arg("--project-root"));
  const binding = currentRuntimeBinding(identity.projectRoot);
  if (!binding) fail("项目缺少Hook配置或身份护栏脚本", 2);
  const observedPath = join(controlRoot, "local", "runtime", "hook-observed.json");
  const observed = existsSync(observedPath) ? parseJson(readUtf8(observedPath), "Hook观察记录") : null;
  const matching = observed?.events?.filter((event) => event.event === "PreToolUse"
    && event.tool === "Bash"
    && event.session === hookSession.slice(0, 16)) ?? [];
  const latest = matching.at(-1);
  if (!latest || Number.isNaN(Date.parse(latest.observedAt)) || Date.now() - Date.parse(latest.observedAt) > 5 * 60 * 1000) {
    fail("没有找到同一会话五分钟内的真实PreToolUse观察记录；运行探针失败", 2);
  }
  const manifest = parseJson(readUtf8(join(controlRoot, "beyond-release.json"), "BEYOND版本清单"), "BEYOND版本清单");
  const proof = {
    schemaVersion: 1,
    releaseVersion: manifest.releaseVersion,
    projectId: identity.projectId,
    projectRoot: display(identity.projectRoot),
    hooksSha256: binding.hooksSha256,
    guardSha256: binding.guardSha256,
    hookSession: hookSession.slice(0, 16),
    observedAt: latest.observedAt,
    verifiedAt: new Date().toISOString(),
  };
  const proofPath = join(controlRoot, "local", "runtime", "hook-probes", `${identity.projectId}.json`);
  writeUtf8(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify({ runtimeProbePassed: true, proofPath: display(proofPath), ...proof }, null, 2));
}

function hookDoctor() {
  const identity = runtimeProjectIdentity(arg("--project-root"));
  const binding = currentRuntimeBinding(identity.projectRoot);
  const version = run("codex", ["--version"], { cwd: identity.projectRoot });
  const features = run("codex", ["features", "list"], { cwd: identity.projectRoot });
  const proofPath = join(controlRoot, "local", "runtime", "hook-probes", `${identity.projectId}.json`);
  let proof = null;
  if (existsSync(proofPath)) {
    try {
      proof = JSON.parse(readFileSync(proofPath, "utf8"));
    } catch {
      proof = null;
    }
  }
  const manifest = parseJson(readUtf8(join(controlRoot, "beyond-release.json"), "BEYOND版本清单"), "BEYOND版本清单");
  const runtimeProbePassed = Boolean(binding && proof
    && proof.releaseVersion === manifest.releaseVersion
    && proof.projectId === identity.projectId
    && proof.projectRoot.toLowerCase() === display(identity.projectRoot).toLowerCase()
    && proof.hooksSha256 === binding.hooksSha256
    && proof.guardSha256 === binding.guardSha256);
  console.log(JSON.stringify({
    projectId: identity.projectId,
    projectRoot: display(identity.projectRoot),
    codexVersion: version.status === 0 ? version.stdout : null,
    codexFeaturesAvailable: features.status === 0,
    runtimeFilesPresent: Boolean(binding),
    runtimeProbePassed,
    proofPath: existsSync(proofPath) ? display(proofPath) : null,
    nextAction: runtimeProbePassed
      ? "Hook已经由真实PreToolUse探针验证。"
      : "在项目根目录启动Codex CLI，输入 /hooks，审核并信任当前项目Hook；随后在Codex任务中运行hook-probe。项目可信不等于Hook定义已信任。",
  }, null, 2));
}

function runtimeIdentity() {
  if (arg("--role") !== "pm") fail("runtime-identity只接受 --role pm", 2);
  const hookSession = arg("--hook-session");
  if (!hookSession || !/^[a-f0-9]{64}$/i.test(hookSession)) {
    fail("BEYOND身份护栏未生效：PM身份登记命令没有经过PreToolUse Hook", 2);
  }
  console.log("BEYOND PM身份已由运行时护栏登记；后续压缩、恢复和继续沿用该身份。");
}

function printHelp() {
  console.log(`BEYOND控制仓固定动作\n\n` +
    `  init-control [--project-root <当前项目根>]  # 默认项目内模式传入项目根；外置模式省略\n` +
    `  inspect-project --project-root <目录> [--host-id <主机>] [--codex-project-id <项目>]\n` +
    `  register-project --project-root <目录> [--name <名称>] [--host-id <主机>] [--codex-project-id <项目>]\n` +
    `  install-project-entry --project-root <目录> --confirm-fusion yes [--adopt-legacy-workbench yes] [--canonical-repositories <每组重复remote选择一个正式路径>] [--confirm-legacy-skip yes] [--host-id <主机>] [--codex-project-id <项目>]\n` +
    `  list [--git-account <已确认账号> | --all]\n` +
    `  workbench --action list\n` +
    `  workbench --action upsert --task <业务结果> --thread <正式thread> --status 进行中|已暂停|已完成 --progress <当前进度> [--pause <原因与恢复条件>] [--result <证据入口>] [--updated <YYYY-MM-DD>]\n` +
    `  workbench --action snapshot --mainline <当前主线> --status 进行中|已暂停|已完成 --problem <当前主要问题> --evidence <一手依据> --next <当前下一步> [--decision <需要用户决定>] [--updated <YYYY-MM-DD>]\n` +
    `  workbench --action archive --threads <正式thread,...> [--completed-at <ISO时间>]\n` +
    `  sync --action pull\n` +
    `  sync --action push --paths <逗号分隔路径> --message <提交说明> [--scope team|project-registration]\n` +
    `  archive --type task|collaboration --id <编号> --result <最终结果>\n` +
    `  backup-local [--reason <原因>]\n` +
    `  restore-local --snapshot <备份目录> --confirm-restore yes\n` +
    `  hook-doctor --project-root <目录>  # 只读诊断Hook文件、CLI能力与运行探针\n` +
    `  hook-probe --project-root <目录>  # 必须由真实PreToolUse Hook签注\n` +
    `  runtime-identity --role pm  # 只由identity-pm在显式入口未登记时调用`);
}

const command = process.argv[2] ?? "help";
if (command === "help" || has("--help")) printHelp();
else if (command === "init-control") {
  ensureControl();
  const projectRootValue = arg("--project-root");
  const projectIsolation = projectRootValue
    ? ensureProjectControlIsolation(inspectProject(projectRootValue))
    : null;
  const snapshot = backupLocal("control-init");
  console.log(JSON.stringify({
    controlRoot: display(controlRoot),
    localBackup: display(snapshot),
    projectIsolation: projectIsolation ? {
      changed: projectIsolation.changed,
      rules: projectIsolation.rules,
      backup: projectIsolation.backup ? display(projectIsolation.backup) : null,
    } : null,
  }, null, 2));
} else if (command === "inspect-project") {
  console.log(JSON.stringify(inspectProject(arg("--project-root")), null, 2));
} else if (command === "register-project") {
  const project = inspectProject(arg("--project-root"));
  const result = registerProject(project, arg("--name"));
  console.log(JSON.stringify({ project, ...Object.fromEntries(Object.entries(result).map(([key, value]) => [key, display(value)])) }, null, 2));
} else if (command === "install-project-entry") {
  const project = inspectProject(arg("--project-root"));
  const result = installProjectEntry(project);
  console.log(JSON.stringify({
    projectId: project.projectId,
    target: display(result.target),
    runtimeGuard: display(result.runtimeGuard),
    runtimeHooks: display(result.runtimeHooks),
    backupDirectory: result.backupDirectory ? display(result.backupDirectory) : null,
    controlRelative: result.controlRelative,
    projectIsolation: {
      changed: result.projectIsolation.changed,
      rules: result.projectIsolation.rules,
      backup: result.projectIsolation.backup ? display(result.projectIsolation.backup) : null,
    },
    adoption: result.adoption ? {
      imported: result.adoption.imported,
      historyPath: display(result.adoption.historyPath),
      backup: display(result.adoption.backup),
    } : null,
  }, null, 2));
} else if (command === "runtime-identity") {
  runtimeIdentity();
} else if (command === "hook-doctor") {
  hookDoctor();
} else if (command === "hook-probe") {
  hookProbe();
} else if (command === "list") {
  ensureControl();
  const account = has("--all") ? null : detectGitAccount();
  const records = [
    ...activeRecords(join(controlRoot, "shared", "tasks", "active"), "task"),
    ...activeRecords(join(controlRoot, "shared", "collaborations", "active"), "collaboration"),
  ];
  const filtered = account ? records.filter((item) => !item.owner || item.owner === account || item.participants?.split(",").map((value) => value.trim()).includes(account)) : records;
  console.log(JSON.stringify({ account: account ?? null, count: filtered.length, records: filtered }, null, 2));
} else if (command === "workbench") workbench();
else if (command === "sync") sync();
else if (command === "archive") archiveRecord();
else if (command === "backup-local") console.log(display(backupLocal(arg("--reason") ?? "manual")));
else if (command === "restore-local") restoreLocal();
else fail(`未知命令：${command}。使用 help 查看固定动作。`, 2);
