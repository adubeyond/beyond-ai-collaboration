import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const strictCandidate = process.argv.includes("--strict-candidate");

const publicTopLevel = new Set([
  ".github",
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
  "docs",
  "examples",
  "scripts",
  "模板交付包",
]);

const publicEntries = [
  ".github",
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
  "docs",
  "examples/minimal-project",
  "scripts",
  "模板交付包",
];

const errors = [];
const decoder = new TextDecoder("utf-8", { fatal: true });
const allowedBinaryAssets = new Set([".github/assets/social-preview.png"]);

function normalizeRelative(path) {
  return path.split(sep).join("/");
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

if (errors.length > 0) {
  console.error("公开内容验证失败：");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`公开内容验证通过：${uniqueFiles.length} 个文件；strictCandidate=${strictCandidate}`);
}
