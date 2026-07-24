import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const strictCandidate = process.argv.includes("--strict-candidate");
const pathSafetySelfTest = process.argv.includes("--self-test-paths");

const publicTopLevel = new Set([
  ".github",
  ".gitattributes",
  ".gitignore",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CODE_OF_CONDUCT.zh-CN.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING.en.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "SECURITY.en.md",
  "VERSION",
  "docs",
  "examples",
  "scripts",
  "模板交付包",
]);

const publicEntries = [
  ".github",
  ".gitattributes",
  ".gitignore",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CODE_OF_CONDUCT.zh-CN.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING.en.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "SECURITY.en.md",
  "VERSION",
  "docs",
  "examples/minimal-project",
  "scripts",
  "模板交付包",
];

const errors = [];
const decoder = new TextDecoder("utf-8", { fatal: true });
const allowedBinaryAssets = new Set([".github/assets/social-preview.png"]);

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    errors.push(`${name} 缺少参数`);
    return null;
  }
  return value;
}

const candidateTargetOption = optionValue("--assemble-candidate");
const manifestTargetOption = optionValue("--manifest");
const selfTestRootOption = optionValue("--self-test-root");

if ([strictCandidate, candidateTargetOption !== null, pathSafetySelfTest].filter(Boolean).length > 1) {
  errors.push("--strict-candidate、--assemble-candidate 与 --self-test-paths 不能同时使用");
}
if ((candidateTargetOption === null) !== (manifestTargetOption === null)) {
  errors.push("--assemble-candidate 与 --manifest 必须同时提供");
}
if (pathSafetySelfTest !== (selfTestRootOption !== null)) {
  errors.push("--self-test-paths 与 --self-test-root 必须同时提供");
}

function normalizeRelative(path) {
  return path.split(sep).join("/");
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function collectFiles(path) {
  if (!existsSync(path)) {
    return [];
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    errors.push(`不允许符号链接：${normalizeRelative(relative(repositoryRoot, path))}`);
    return [];
  }
  if (stat.isFile()) {
    return [path];
  }
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .flatMap((entry) => collectFiles(join(path, entry.name)));
}

function isPublicPath(path) {
  const rel = normalizeRelative(relative(repositoryRoot, path));
  if (rel === "" || rel.startsWith("../") || isAbsolute(rel)) {
    return false;
  }
  const top = rel.split("/")[0];
  return publicTopLevel.has(top);
}

function decodeText(path) {
  const bytes = readFileSync(path);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    errors.push(`UTF-8 BOM：${normalizeRelative(relative(repositoryRoot, path))}`);
  }
  if (bytes.includes(0)) {
    errors.push(`公开候选包含二进制或 NUL：${normalizeRelative(relative(repositoryRoot, path))}`);
    return null;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    errors.push(`不是严格 UTF-8：${normalizeRelative(relative(repositoryRoot, path))}`);
    return null;
  }
}

function validateBinaryAsset(path) {
  const rel = normalizeRelative(relative(repositoryRoot, path));
  const bytes = readFileSync(path);
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  if (rel !== ".github/assets/social-preview.png") {
    errors.push(`未定义校验规则的二进制资产：${rel}`);
    return;
  }
  if (bytes.length > 1024 * 1024) {
    errors.push(`社交预览图超过 1 MiB：${rel} (${bytes.length} bytes)`);
  }
  if (bytes.length < 24 || !pngSignature.every((value, index) => bytes[index] === value)) {
    errors.push(`社交预览图不是有效 PNG：${rel}`);
    return;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1280 || height < 640 || width !== height * 2) {
    errors.push(`社交预览图尺寸必须为至少 1280×640 的 2:1：${rel} (${width}×${height})`);
  }
}

function validateMarkdownLinks(path, text) {
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    } else {
      target = target.split(/\s+["']/)[0];
    }
    if (!target || target.startsWith("#") || /^(?:https?:|mailto:)/i.test(target)) {
      continue;
    }
    const cleanTarget = target.split("#")[0].split("?")[0];
    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(cleanTarget);
    } catch {
      errors.push(`无法解码链接：${normalizeRelative(relative(repositoryRoot, path))} -> ${target}`);
      continue;
    }
    const resolved = resolve(dirname(path), decodedTarget);
    if (!existsSync(resolved)) {
      errors.push(`断开的本地链接：${normalizeRelative(relative(repositoryRoot, path))} -> ${target}`);
      continue;
    }
    const canonical = realpathSync(resolved);
    if (!isPublicPath(canonical)) {
      errors.push(`链接逃出公开范围：${normalizeRelative(relative(repositoryRoot, path))} -> ${target}`);
    }
  }
}

function validateMarkdownFences(path, text) {
  let active = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (!match) {
      continue;
    }
    const marker = match[1][0];
    if (active === null) {
      active = marker;
    } else if (active === marker) {
      active = null;
    }
  }
  if (active !== null) {
    errors.push(`Markdown 围栏未闭合：${normalizeRelative(relative(repositoryRoot, path))}`);
  }
}

const sensitivePatterns = [
  ["真实 Codex 对话链接", new RegExp("codex" + ":\\/\\/threads", "i")],
  ["疑似真实 thread ID", /\b019f[0-9a-f-]{12,}\b/i],
  ["Windows 绝对路径", /\b[A-Za-z]:\\[^\s`"'<>]+/],
  ["用户目录绝对路径", /\/(?:Users|home)\/[^\s`"'<>]+/],
  ["内网 IPv4 地址", /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/],
  ["疑似动态 SHA-256", /\b[0-9a-f]{64}\b/i],
  ["疑似秘密赋值", /\b(?:api[_-]?key|secret|token|password|authorization)\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ["私钥正文", new RegExp("BEGIN" + " (?:RSA |EC |OPENSSH )?PRIVATE KEY")],
];

function validateText(path, text) {
  const rel = normalizeRelative(relative(repositoryRoot, path));
  if (/[ \t]+$/m.test(text)) {
    errors.push(`尾随空白：${rel}`);
  }
  for (const [label, pattern] of sensitivePatterns) {
    if (pattern.test(text)) {
      errors.push(`${label}：${rel}`);
    }
  }
  if (extname(path).toLowerCase() === ".md") {
    validateMarkdownLinks(path, text);
    validateMarkdownFences(path, text);
  }
  if ([".yml", ".yaml"].includes(extname(path).toLowerCase()) && /\t/.test(text)) {
    errors.push(`YAML 包含 Tab 缩进：${rel}`);
  }
}

if (strictCandidate) {
  for (const entry of readdirSync(repositoryRoot, { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue;
    }
    if (!publicTopLevel.has(entry.name)) {
      errors.push(`严格候选包含未授权顶层入口：${entry.name}`);
    }
  }
}

const files = publicEntries.flatMap((entry) => collectFiles(join(repositoryRoot, entry)));
const uniqueFiles = [...new Set(files.map((path) => resolve(path)))].sort();

for (const path of uniqueFiles) {
  const rel = normalizeRelative(relative(repositoryRoot, path));
  if (allowedBinaryAssets.has(rel)) {
    validateBinaryAsset(path);
    continue;
  }
  const text = decodeText(path);
  if (text !== null) {
    validateText(path, text);
  }
}

const requiredSkillFacts = [
  {
    path: "模板交付包/skills/identity-pm/SKILL.md",
    label: "PM separates business authorization from runtime permissions",
    value: "业务授权与 Codex 运行权限分开编译",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker forbids proactive tool escalation",
    value: "不主动携带审批参数",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker limits one capability to one permission request",
    value: "同一能力最多请求一次最小权限",
  },
  {
    path: "模板交付包/skills/identity-worker/SKILL.md",
    label: "worker does not present an unreleased candidate as currently usable",
    value: "只有任务本身要求一个用户可见功能已经上线时",
  },
  {
    path: "模板交付包/skills/task-design/SKILL.md",
    label: "design distinguishes current behavior from the proposed state",
    value: "当前用户页面/系统业务流程尚未变化",
  },
];

for (const fact of requiredSkillFacts) {
  const path = join(repositoryRoot, ...fact.path.split("/"));
  if (!existsSync(path)) {
    errors.push(`关键 Skill 文件缺失：${fact.path}`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  if (!text.includes(fact.value)) {
    errors.push(`关键 Skill 规则缺失：${fact.label} (${fact.path})`);
  }
}

const packagePath = join(repositoryRoot, "examples", "minimal-project", "package.json");
if (existsSync(packagePath)) {
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    if (!packageJson.scripts?.test || !packageJson.scripts?.check) {
      errors.push("最小示例缺少 test 或 check 脚本");
    }
  } catch {
    errors.push("最小示例 package.json 无法解析");
  }
}

for (const forbidden of ["node_modules", "package-lock.json"]) {
  if (existsSync(join(repositoryRoot, "examples", "minimal-project", forbidden))) {
    errors.push(`最小示例存在运行残留：${forbidden}`);
  }
}

for (const fixturePath of [
  join(repositoryRoot, "examples", "minimal-project", "src", "calc.js"),
  join(repositoryRoot, "examples", "minimal-project", "test", "calc.test.js"),
]) {
  if (existsSync(fixturePath) && /\bsubtract\b/.test(readFileSync(fixturePath, "utf8"))) {
    errors.push(`最小示例提前包含快速开始目标 subtract：${normalizeRelative(relative(repositoryRoot, fixturePath))}`);
  }
}

function pathKey(path) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrWithin(root, target) {
  return pathKey(root) === pathKey(target) || isWithin(resolve(root), resolve(target));
}

function lstatExisting(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function inspectPhysicalDirectoryChain(input, label) {
  const target = resolve(input);
  const filesystemRoot = parse(target).root;
  let cursor = filesystemRoot;
  let nearestExisting = filesystemRoot;
  let missingStarted = false;
  const missingDirectories = [];
  const parts = relative(filesystemRoot, target).split(sep).filter(Boolean);
  for (const part of parts) {
    cursor = join(cursor, part);
    const stat = lstatExisting(cursor);
    if (stat === null) {
      missingStarted = true;
      missingDirectories.push(cursor);
      continue;
    }
    if (missingStarted) {
      throw new Error(`${label} has an existing descendant below a missing parent: ${cursor}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink, junction, reparse point, or non-directory ancestor: ${cursor}`);
    }
    const canonical = realpathSync(cursor);
    if (pathKey(canonical) !== pathKey(cursor)) {
      throw new Error(`${label} resolves through a physical alias: ${cursor}`);
    }
    nearestExisting = cursor;
  }
  const rootStat = lstatExisting(filesystemRoot);
  if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} filesystem root is not a real directory: ${filesystemRoot}`);
  }
  const canonicalRoot = realpathSync(filesystemRoot);
  if (pathKey(canonicalRoot) !== pathKey(filesystemRoot)) {
    throw new Error(`${label} filesystem root resolves through a physical alias: ${filesystemRoot}`);
  }
  return {
    target,
    nearestExisting,
    allowedPhysicalRoot: realpathSync(nearestExisting),
    missingDirectories,
  };
}

function planAssemblyOutput(input, label) {
  if (!input || !isAbsolute(input)) {
    throw new Error(`${label}必须是显式绝对路径`);
  }
  const output = resolve(input);
  if (pathKey(output) === pathKey(parse(output).root)) {
    throw new Error(`${label}不得为文件系统根`);
  }
  if (lstatExisting(output) !== null) {
    throw new Error(`${label}已经存在；为避免覆盖，装配已停止`);
  }
  const parent = dirname(output);
  const chain = inspectPhysicalDirectoryChain(parent, label);
  const plannedPhysicalParent = resolve(chain.allowedPhysicalRoot, relative(chain.nearestExisting, parent));
  const plannedPhysicalOutput = resolve(plannedPhysicalParent, relative(parent, output));
  if (!isSameOrWithin(chain.allowedPhysicalRoot, plannedPhysicalParent)) {
    throw new Error(`${label}的计划父目录逃出已验证物理根`);
  }
  return {
    label,
    output,
    parent,
    allowedPhysicalRoot: chain.allowedPhysicalRoot,
    missingDirectories: chain.missingDirectories,
    plannedPhysicalParent,
    plannedPhysicalOutput,
  };
}

function assertPhysicalDirectory(allowedRoot, path, label) {
  if (!isSameOrWithin(allowedRoot, path)) {
    throw new Error(`${label}词法路径逃出已验证物理根: ${path}`);
  }
  const chain = inspectPhysicalDirectoryChain(path, label);
  if (chain.missingDirectories.length > 0) {
    throw new Error(`${label}目录不存在: ${path}`);
  }
  const canonical = realpathSync(path);
  if (!isSameOrWithin(allowedRoot, canonical) || pathKey(canonical) !== pathKey(path)) {
    throw new Error(`${label}物理路径逃出已验证根或经过reparse: ${path}`);
  }
}

function assertPhysicalFile(allowedRoot, path, label) {
  assertPhysicalDirectory(allowedRoot, dirname(path), `${label} parent`);
  const stat = lstatExisting(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label}必须是已验证根内的普通文件: ${path}`);
  }
  const canonical = realpathSync(path);
  if (!isSameOrWithin(allowedRoot, canonical) || pathKey(canonical) !== pathKey(path)) {
    throw new Error(`${label}物理路径逃出已验证根或经过reparse: ${path}`);
  }
}

function assertOutputStillAbsent(plan) {
  assertPhysicalDirectory(plan.allowedPhysicalRoot, plan.parent, `${plan.label} parent`);
  if (lstatExisting(plan.output) !== null) {
    throw new Error(`${plan.label}在装配期间出现未知对象: ${plan.output}`);
  }
}

function recordOwned(owned, path, allowedRoot, kind) {
  owned.set(pathKey(path), { path: resolve(path), allowedRoot: resolve(allowedRoot), kind });
}

function transferOwned(owned, fromRoot, toRoot, allowedRoot) {
  const transfers = [...owned.values()].filter((entry) => isSameOrWithin(fromRoot, entry.path));
  for (const entry of transfers) {
    owned.delete(pathKey(entry.path));
    const nextPath = pathKey(entry.path) === pathKey(fromRoot)
      ? resolve(toRoot)
      : resolve(toRoot, relative(fromRoot, entry.path));
    recordOwned(owned, nextPath, allowedRoot, entry.kind);
  }
}

function createPlannedParents(plan, owned) {
  for (const path of plan.missingDirectories) {
    const stat = lstatExisting(path);
    if (stat === null) {
      assertPhysicalDirectory(plan.allowedPhysicalRoot, dirname(path), `${plan.label} parent`);
      mkdirSync(path);
      recordOwned(owned, path, plan.allowedPhysicalRoot, "directory");
    }
    assertPhysicalDirectory(plan.allowedPhysicalRoot, path, `${plan.label} created parent`);
  }
}

function createOwnedParentDirectories(root, destination, allowedRoot, owned) {
  const parent = dirname(destination);
  if (!isSameOrWithin(root, parent)) {
    throw new Error(`候选文件父目录逃出pending root: ${destination}`);
  }
  let cursor = resolve(root);
  for (const part of relative(root, parent).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (lstatExisting(cursor) === null) {
      assertPhysicalDirectory(allowedRoot, dirname(cursor), "candidate parent");
      mkdirSync(cursor);
      recordOwned(owned, cursor, allowedRoot, "directory");
    }
    assertPhysicalDirectory(allowedRoot, cursor, "candidate parent");
  }
}

function cleanupOwnedPaths(owned) {
  const cleanupErrors = [];
  const entries = [...owned.values()].sort((left, right) => right.path.length - left.path.length);
  for (const entry of entries) {
    const stat = lstatExisting(entry.path);
    if (stat === null) {
      continue;
    }
    if (!isSameOrWithin(entry.allowedRoot, entry.path) || stat.isSymbolicLink()) {
      cleanupErrors.push(`preserved unknown reparse or escaped path: ${entry.path}`);
      continue;
    }
    let canonical;
    try {
      canonical = realpathSync(entry.path);
    } catch (error) {
      cleanupErrors.push(`preserved unreadable owned path: ${entry.path} (${error.message})`);
      continue;
    }
    if (!isSameOrWithin(entry.allowedRoot, canonical) || pathKey(canonical) !== pathKey(entry.path)) {
      cleanupErrors.push(`preserved physically escaped owned path: ${entry.path}`);
      continue;
    }
    if (entry.kind === "file" && stat.isFile()) {
      unlinkSync(entry.path);
      continue;
    }
    if (entry.kind === "directory" && stat.isDirectory()) {
      if (readdirSync(entry.path).length === 0) {
        rmSync(entry.path, { recursive: false });
      } else {
        cleanupErrors.push(`preserved non-empty directory with unknown contents: ${entry.path}`);
      }
      continue;
    }
    cleanupErrors.push(`preserved owned path whose type changed: ${entry.path}`);
  }
  return cleanupErrors;
}

function assemblePublicCandidate(targetOption, manifestOption, testHooks = {}) {
  const sourceRepositoryRoot = testHooks.sourceRepositoryRoot ?? repositoryRoot;
  const sourceFiles = testHooks.sourceFiles ?? uniqueFiles;
  const sourceVersion = testHooks.sourceVersion ?? readFileSync(join(sourceRepositoryRoot, "VERSION"), "utf8").trim();
  const targetPlan = planAssemblyOutput(targetOption, "候选目录");
  const manifestPlan = planAssemblyOutput(manifestOption, "候选清单");
  const targetRoot = targetPlan.output;
  const manifestPath = manifestPlan.output;
  const pendingRoot = `${targetRoot}.pending-${process.pid}`;
  const pendingManifest = `${manifestPath}.pending-${process.pid}`;
  const pendingTargetPlan = planAssemblyOutput(pendingRoot, "候选暂存目录");
  const pendingManifestPlan = planAssemblyOutput(pendingManifest, "候选暂存清单");
  const canonicalRepository = realpathSync(sourceRepositoryRoot);
  if (pathKey(canonicalRepository) !== pathKey(sourceRepositoryRoot)) {
    throw new Error("建设源自身经过symlink、junction或reparse，装配已停止");
  }
  for (const plan of [targetPlan, pendingTargetPlan]) {
    if (isSameOrWithin(canonicalRepository, plan.plannedPhysicalOutput)) {
      throw new Error("候选目录不得位于建设源内或通过reparse解析进入建设源");
    }
  }
  for (const plan of [manifestPlan, pendingManifestPlan]) {
    if (isSameOrWithin(canonicalRepository, plan.plannedPhysicalOutput)) {
      throw new Error("候选清单不得位于建设源内或通过reparse解析进入建设源");
    }
  }
  if (isSameOrWithin(targetPlan.plannedPhysicalOutput, manifestPlan.plannedPhysicalOutput)) {
    throw new Error("清单不得物理位于候选根内");
  }
  if (
    pathKey(targetPlan.allowedPhysicalRoot) !== pathKey(pendingTargetPlan.allowedPhysicalRoot)
    || pathKey(manifestPlan.allowedPhysicalRoot) !== pathKey(pendingManifestPlan.allowedPhysicalRoot)
  ) {
    throw new Error("pending路径与最终路径没有绑定到同一已验证物理父根");
  }

  const entries = sourceFiles
    .map((path) => {
      const rel = normalizeRelative(relative(sourceRepositoryRoot, path));
      const bytes = readFileSync(path);
      return { path: rel, sha256: sha256(bytes), bytes: bytes.length };
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const canonicalManifest = `${entries.map((entry) => `${entry.path}\t${entry.sha256}`).join("\n")}\n`;
  const treeSha256 = sha256(Buffer.from(canonicalManifest, "utf8"));
  const version = sourceVersion;

  const owned = new Map();
  try {
    createPlannedParents(targetPlan, owned);
    createPlannedParents(manifestPlan, owned);
    assertOutputStillAbsent(targetPlan);
    assertOutputStillAbsent(manifestPlan);
    assertOutputStillAbsent(pendingTargetPlan);
    assertOutputStillAbsent(pendingManifestPlan);

    mkdirSync(pendingRoot);
    recordOwned(owned, pendingRoot, targetPlan.allowedPhysicalRoot, "directory");
    assertPhysicalDirectory(targetPlan.allowedPhysicalRoot, pendingRoot, "候选暂存目录");
    testHooks.afterPendingRootCreated?.({ pendingRoot });
    assertPhysicalDirectory(targetPlan.allowedPhysicalRoot, pendingRoot, "候选暂存目录");
    for (const sourcePath of sourceFiles) {
      const rel = relative(sourceRepositoryRoot, sourcePath);
      const targetPath = join(pendingRoot, rel);
      createOwnedParentDirectories(pendingRoot, targetPath, targetPlan.allowedPhysicalRoot, owned);
      if (lstatExisting(targetPath) !== null) {
        throw new Error(`候选暂存路径在写入前出现未知对象: ${targetPath}`);
      }
      copyFileSync(sourcePath, targetPath);
      recordOwned(owned, targetPath, targetPlan.allowedPhysicalRoot, "file");
      assertPhysicalFile(targetPlan.allowedPhysicalRoot, targetPath, "候选暂存文件");
    }

    assertOutputStillAbsent(pendingManifestPlan);
    writeFileSync(pendingManifest, `${JSON.stringify({
      schemaVersion: 1,
      version,
      fileCount: entries.length,
      treeSha256,
      canonicalFormat: "path<TAB>sha256; UTF-8; LF; final LF",
      files: entries,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    recordOwned(owned, pendingManifest, manifestPlan.allowedPhysicalRoot, "file");
    assertPhysicalFile(manifestPlan.allowedPhysicalRoot, pendingManifest, "候选暂存清单");

    assertOutputStillAbsent(targetPlan);
    assertPhysicalDirectory(targetPlan.allowedPhysicalRoot, pendingRoot, "候选暂存目录");
    renameSync(pendingRoot, targetRoot);
    transferOwned(owned, pendingRoot, targetRoot, targetPlan.allowedPhysicalRoot);
    assertPhysicalDirectory(targetPlan.allowedPhysicalRoot, targetRoot, "候选目录");

    assertOutputStillAbsent(manifestPlan);
    assertPhysicalFile(manifestPlan.allowedPhysicalRoot, pendingManifest, "候选暂存清单");
    const canonicalTarget = realpathSync(targetRoot);
    if (isSameOrWithin(canonicalTarget, manifestPlan.plannedPhysicalOutput)) {
      throw new Error("清单物理路径落入已发布候选根，装配已停止");
    }
    renameSync(pendingManifest, manifestPath);
    transferOwned(owned, pendingManifest, manifestPath, manifestPlan.allowedPhysicalRoot);
    assertPhysicalFile(manifestPlan.allowedPhysicalRoot, manifestPath, "候选清单");
  } catch (error) {
    const cleanupErrors = cleanupOwnedPaths(owned);
    if (cleanupErrors.length > 0) {
      throw new Error(`${error.message}; 安全清理保留未知对象：${cleanupErrors.join("; ")}`);
    }
    throw error;
  }

  console.log(`公开候选装配完成：${entries.length} 个文件；treeSha256=${treeSha256}`);
  console.log(`候选目录：${targetRoot}`);
  console.log(`候选清单：${manifestPath}`);
}

function runPathSafetySelfTest(ownerOption) {
  if (process.platform !== "win32") {
    throw new Error("CANNOT_DETERMINE: path safety self-test requires Windows.");
  }
  if (!isAbsolute(ownerOption)) {
    throw new Error("CANNOT_DETERMINE: self-test root must be an explicit absolute path.");
  }
  const ownerRoot = resolve(ownerOption);
  if (!existsSync(ownerRoot) || !lstatSync(ownerRoot).isDirectory() || lstatSync(ownerRoot).isSymbolicLink()) {
    throw new Error("CANNOT_DETERMINE: self-test root must be an existing real directory.");
  }
  const canonicalOwner = realpathSync.native(ownerRoot);
  const canonicalTemp = realpathSync.native(tmpdir());
  if (!isWithin(canonicalTemp, canonicalOwner)) {
    throw new Error("CANNOT_DETERMINE: fixtures must be inside one OS temporary task root.");
  }
  if (readdirSync(canonicalOwner).length !== 0) {
    throw new Error("CANNOT_DETERMINE: self-test root must be empty and task-owned.");
  }

  const testRoot = mkdtempSync(join(canonicalOwner, "path-self-test-"));
  const fixtureRepository = join(testRoot, "fixture-repository");
  const fixturePayload = join(fixtureRepository, "payload.txt");
  mkdirSync(fixtureRepository);
  writeFileSync(join(fixtureRepository, "VERSION"), "0.0.0-test\n", "utf8");
  writeFileSync(fixturePayload, "fixture payload\n", "utf8");
  const fixtureSource = {
    sourceRepositoryRoot: fixtureRepository,
    sourceFiles: [fixturePayload],
    sourceVersion: "0.0.0-test",
  };
  const fixtureLinks = [];
  const failures = [];
  let assertions = 0;
  const check = (condition, message) => {
    assertions += 1;
    if (!condition) {
      failures.push(message);
    }
  };
  const isSameOrWithin = (root, target) => resolve(root) === resolve(target) || isWithin(resolve(root), resolve(target));
  const assertNoFixtureLinks = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`fixture cleanup found a link: ${path}`);
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        assertNoFixtureLinks(join(path, entry.name));
      }
    }
  };
  const removeFixtureOwned = (path) => {
    if (!existsSync(path)) {
      return;
    }
    if (!isSameOrWithin(canonicalOwner, path)) {
      throw new Error(`fixture cleanup path escapes owner root: ${path}`);
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      unlinkSync(path);
      return;
    }
    const canonical = realpathSync(path);
    if (!isSameOrWithin(canonicalOwner, canonical)) {
      throw new Error(`fixture cleanup physical path escapes owner root: ${path}`);
    }
    if (stat.isDirectory()) {
      assertNoFixtureLinks(path);
      rmSync(path, { recursive: true, force: true });
    } else {
      unlinkSync(path);
    }
  };
  const writeCanary = (label) => {
    const root = join(testRoot, label);
    mkdirSync(root);
    writeFileSync(join(root, "canary.txt"), `${label}\n`, "utf8");
    check(isWithin(testRoot, realpathSync(root)), `${label}: outside canary must be physically task-owned`);
    return root;
  };
  const createDirectoryLink = (actual, link, type) => {
    try {
      symlinkSync(actual, link, type);
    } catch (error) {
      throw new Error(`CANNOT_DETERMINE: cannot create Windows ${type} fixture: ${error.message}`);
    }
    check(lstatSync(link).isSymbolicLink(), `${type}: fixture must be a real filesystem link`);
    fixtureLinks.push(link);
  };
  const snapshotTree = (root) => {
    if (!existsSync(root)) {
      return "ABSENT";
    }
    const snapshot = [];
    const visit = (current, relativeRoot = "") => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = join(current, entry.name);
        const relativePath = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
        if (entry.isSymbolicLink()) {
          snapshot.push(["link", relativePath]);
        } else if (entry.isDirectory()) {
          snapshot.push(["directory", relativePath]);
          visit(absolute, relativePath);
        } else {
          snapshot.push(["file", relativePath, readFileSync(absolute).toString("base64")]);
        }
      }
    };
    visit(root);
    return JSON.stringify(snapshot);
  };
  const attemptAssembly = (target, manifest, hooks = {}) => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      assemblePublicCandidate(target, manifest, { ...fixtureSource, ...hooks });
      return { rejected: false, error: null };
    } catch (error) {
      return { rejected: true, error };
    } finally {
      console.log = originalLog;
    }
  };

  try {
    check(isWithin(canonicalOwner, realpathSync(testRoot)), "self-test root must be physically task-owned");

    const targetOutside = writeCanary("target-parent-outside");
    const targetParentLink = join(testRoot, "target-parent-link");
    createDirectoryLink(targetOutside, targetParentLink, "junction");
    const targetViaLink = join(targetParentLink, "candidate");
    const targetManifest = join(testRoot, "target-parent.manifest.json");
    const targetOutsideBefore = snapshotTree(targetOutside);
    const targetResult = attemptAssembly(targetViaLink, targetManifest);
    check(targetResult.rejected, "candidate parent junction must be rejected");
    check(snapshotTree(targetOutside) === targetOutsideBefore, "candidate parent junction must preserve outside canary");
    check(!existsSync(targetViaLink) && !existsSync(targetManifest), "candidate parent junction must publish no candidate or manifest");
    removeFixtureOwned(join(targetOutside, "candidate"));
    removeFixtureOwned(targetManifest);

    const manifestOutside = writeCanary("manifest-parent-outside");
    const manifestParentLink = join(testRoot, "manifest-parent-link");
    createDirectoryLink(manifestOutside, manifestParentLink, "dir");
    const manifestCandidate = join(testRoot, "manifest-parent-candidate");
    const manifestViaLink = join(manifestParentLink, "candidate.manifest.json");
    const manifestOutsideBefore = snapshotTree(manifestOutside);
    const manifestResult = attemptAssembly(manifestCandidate, manifestViaLink);
    check(manifestResult.rejected, "manifest parent directory symlink must be rejected");
    check(snapshotTree(manifestOutside) === manifestOutsideBefore, "manifest parent directory symlink must preserve outside canary");
    check(!existsSync(manifestCandidate) && !existsSync(manifestViaLink), "manifest parent directory symlink must publish nothing");
    removeFixtureOwned(manifestCandidate);
    removeFixtureOwned(join(manifestOutside, "candidate.manifest.json"));

    const repositoryBefore = snapshotTree(fixtureRepository);
    const repositoryLink = join(testRoot, "repository-ingress-link");
    createDirectoryLink(fixtureRepository, repositoryLink, "junction");
    const repositoryArtifact = join(fixtureRepository, `.path-safety-self-test-${process.pid}`);
    const repositoryManifest = join(testRoot, "repository-ingress.manifest.json");
    const repositoryResult = attemptAssembly(join(repositoryLink, `.path-safety-self-test-${process.pid}`), repositoryManifest);
    check(repositoryResult.rejected, "lexically external candidate resolving into repository root must be rejected");
    check(snapshotTree(fixtureRepository) === repositoryBefore, "repository tree must remain byte-identical");
    check(!existsSync(repositoryManifest), "repository-ingress rejection must publish no manifest");
    removeFixtureOwned(repositoryArtifact);
    removeFixtureOwned(repositoryManifest);
    check(snapshotTree(fixtureRepository) === repositoryBefore, "fixture recovery must restore the repository tree exactly");

    const prefixTargetParent = join(testRoot, "prefix-root");
    const prefixManifestParent = join(testRoot, "prefix-root-evil");
    mkdirSync(prefixTargetParent);
    mkdirSync(prefixManifestParent);
    const prefixTarget = join(prefixTargetParent, "candidate");
    const prefixManifest = join(prefixManifestParent, "candidate.manifest.json");
    const prefixResult = attemptAssembly(prefixTarget, prefixManifest);
    check(!prefixResult.rejected, "prefix-similar real sibling parents must support normal assembly");
    check(existsSync(prefixTarget) && existsSync(prefixManifest), "prefix-similar normal assembly must publish both outputs");

    const normalTargetParent = join(testRoot, "normal-target");
    const normalManifestParent = join(testRoot, "normal-manifest");
    mkdirSync(normalTargetParent);
    mkdirSync(normalManifestParent);
    const normalTarget = join(normalTargetParent, "candidate");
    const normalManifest = join(normalManifestParent, "candidate.manifest.json");
    const normalResult = attemptAssembly(normalTarget, normalManifest);
    check(!normalResult.rejected, "normal real parents must support assembly");
    check(readFileSync(prefixManifest).equals(readFileSync(normalManifest)), "two normal assemblies must produce byte-identical manifests");

    const reparseOutside = writeCanary("pending-reparse-outside");
    const reparseTarget = join(testRoot, "pending-reparse-candidate");
    const reparseManifest = join(testRoot, "pending-reparse.manifest.json");
    const reparseOutsideBefore = snapshotTree(reparseOutside);
    const expectedPending = `${reparseTarget}.pending-${process.pid}`;
    const reparseResult = attemptAssembly(reparseTarget, reparseManifest, {
      afterPendingRootCreated({ pendingRoot }) {
        rmdirSync(pendingRoot);
        createDirectoryLink(reparseOutside, pendingRoot, "junction");
      },
    });
    check(reparseResult.rejected, "pending root replaced by a junction must be rejected");
    check(snapshotTree(reparseOutside) === reparseOutsideBefore, "pending reparse rejection must preserve outside canary");
    check(!existsSync(reparseTarget) && !existsSync(reparseManifest), "pending reparse rejection must publish nothing");
    const preservedPending = lstatExisting(expectedPending);
    check(
      preservedPending?.isSymbolicLink(),
      `unknown pending reparse must be preserved for inspection (${reparseResult.error?.message ?? "no error"})`,
    );
    removeFixtureOwned(expectedPending);
    removeFixtureOwned(reparseTarget);
    removeFixtureOwned(reparseManifest);

    removeFixtureOwned(prefixTarget);
    removeFixtureOwned(prefixManifest);
    removeFixtureOwned(normalTarget);
    removeFixtureOwned(normalManifest);

    if (failures.length > 0) {
      throw new Error(`PATH_SAFETY_SELF_TEST: RED; assertions=${assertions}; failures=${failures.join(" | ")}`);
    }
  } finally {
    for (const link of fixtureLinks.reverse()) {
      if (existsSync(link)) {
        if (!lstatSync(link).isSymbolicLink()) {
          throw new Error(`refusing fixture cleanup because path is no longer a link: ${link}`);
        }
        unlinkSync(link);
      }
    }
    removeFixtureOwned(testRoot);
    if (existsSync(testRoot)) {
      throw new Error(`fixture cleanup failed: ${testRoot}`);
    }
  }

  console.log(`PATH_SAFETY_SELF_TEST: PASS; assertions=${assertions}; platform=${process.platform}; symlink=actual; junction=actual; cleanup=VERIFIED`);
}

if (errors.length > 0) {
  console.error("公开内容验证失败：");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`公开内容验证通过：${uniqueFiles.length} 个文件；strictCandidate=${strictCandidate}`);
  if (pathSafetySelfTest) {
    try {
      runPathSafetySelfTest(selfTestRootOption);
    } catch (error) {
      console.error(`公开候选路径安全自测失败：${error.message}`);
      process.exitCode = 1;
    }
  } else if (candidateTargetOption !== null && manifestTargetOption !== null) {
    try {
      assemblePublicCandidate(candidateTargetOption, manifestTargetOption);
    } catch (error) {
      console.error(`公开候选装配失败：${error.message}`);
      process.exitCode = 1;
    }
  }
}
