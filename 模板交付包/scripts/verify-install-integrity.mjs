import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const candidateRoot = resolve(dirname(scriptPath), "..");

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || !process.argv[index + 1]) return null;
  return resolve(process.argv[index + 1]);
}

const installedSkillsRoot = valueAfter("--installed-skills-root");
const projectAgentsPath = valueAfter("--project-agents");

if (!installedSkillsRoot || !projectAgentsPath) {
  console.error(
    "用法：node verify-install-integrity.mjs --installed-skills-root <Codex skills目录> --project-agents <项目AGENTS.md>",
  );
  process.exit(2);
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const errors = [];
const expectedSkills = [
  "identity-pm",
  "identity-worker",
  "task-design",
  "task-dev",
  "task-test",
  "task-ops",
];

function display(path) {
  return path.split(sep).join("/");
}

function readUtf8(path, label) {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    errors.push(`${label}不存在：${display(path)}`);
    return null;
  }
  const bytes = readFileSync(path);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    errors.push(`${label}包含UTF-8 BOM：${display(path)}`);
    return null;
  }
  try {
    return decoder.decode(bytes).replace(/\r\n/g, "\n");
  } catch {
    errors.push(`${label}不是严格UTF-8：${display(path)}`);
    return null;
  }
}

function collectFiles(root) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return null;
  const files = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(`安装目录不允许符号链接：${display(path)}`);
      } else if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        files.push(display(relative(root, path)));
      }
    }
  }
  walk(root);
  return files;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function compareSkill(skill) {
  const sourceRoot = join(candidateRoot, "skills", skill);
  const targetRoot = join(installedSkillsRoot, skill);
  const sourceFiles = collectFiles(sourceRoot);
  const targetFiles = collectFiles(targetRoot);
  if (!sourceFiles) {
    errors.push(`候选缺少Skill：${skill}`);
    return;
  }
  if (!targetFiles) {
    errors.push(`未安装Skill：${skill}`);
    return;
  }
  const all = new Set([...sourceFiles, ...targetFiles]);
  for (const file of [...all].sort()) {
    if (!sourceFiles.includes(file)) {
      errors.push(`安装Skill存在候选外文件：${skill}/${file}`);
      continue;
    }
    if (!targetFiles.includes(file)) {
      errors.push(`安装Skill缺少文件：${skill}/${file}`);
      continue;
    }
    const source = join(sourceRoot, ...file.split("/"));
    const target = join(targetRoot, ...file.split("/"));
    if (sha256(source) !== sha256(target)) {
      errors.push(`安装Skill内容不一致：${skill}/${file}`);
    }
  }
}

const manifestText = readUtf8(join(candidateRoot, "beyond-release.json"), "候选版本清单");
let manifest = null;
if (manifestText) {
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    errors.push("候选版本清单不是有效JSON");
  }
}

function normalizeProjectEntry(text, label) {
  if (!manifest) return null;
  const versionMarker = `<!-- BEYOND-RUNTIME-VERSION: ${manifest.releaseVersion} -->`;
  if (!text.includes(versionMarker)) {
    errors.push(`${label}缺少目标版本标记：${versionMarker}`);
    return null;
  }
  const begin = manifest.projectOverrideBegin;
  const end = manifest.projectOverrideEnd;
  const beginIndex = text.indexOf(begin);
  const endIndex = text.indexOf(end);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    errors.push(`${label}缺少完整项目覆盖区`);
    return null;
  }
  if (text.indexOf(begin, beginIndex + begin.length) !== -1 || text.indexOf(end, endIndex + end.length) !== -1) {
    errors.push(`${label}包含重复项目覆盖区`);
    return null;
  }
  const overrides = text.slice(beginIndex + begin.length, endIndex);
  const activeLines = overrides
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"));
  if (activeLines.length > 5 || activeLines.some((line) => !line.startsWith("- "))) {
    errors.push(`${label}项目覆盖必须是不超过五条的单行列表`);
  }
  for (const line of activeLines) {
    if (/(?:Luna|Terra|Sol|模型|推理)/i.test(line) && !/(?:\bPM\b|\bWorker\b|执行者|项目经理)/i.test(line)) {
      errors.push(`${label}模型覆盖没有明确适用角色：${line}`);
    }
  }
  return `${text.slice(0, beginIndex + begin.length)}\n<!-- PROJECT OVERRIDES OMITTED -->\n${text.slice(endIndex)}`.trimEnd();
}

if (manifest) {
  if (manifest.schemaVersion !== 1 || !/^3\.0\.\d+$/.test(manifest.releaseVersion)) {
    errors.push("候选版本清单字段无效");
  }
  if (!Array.isArray(manifest.skills) || JSON.stringify(manifest.skills) !== JSON.stringify(expectedSkills)) {
    errors.push("候选版本清单必须按正式名称声明六个Skill");
  } else {
    for (const skill of manifest.skills) compareSkill(skill);
  }

  const candidateAgents = readUtf8(join(candidateRoot, manifest.projectEntry), "候选项目入口");
  const installedAgents = readUtf8(projectAgentsPath, "项目入口");
  if (candidateAgents && installedAgents) {
    const normalizedCandidate = normalizeProjectEntry(candidateAgents, "候选项目入口");
    const normalizedInstalled = normalizeProjectEntry(installedAgents, "项目入口");
    if (normalizedCandidate && normalizedInstalled && normalizedCandidate !== normalizedInstalled) {
      errors.push("项目入口的BEYOND通用内容与候选不一致；可能仍是旧版或混合版本");
    }
  }
}

if (errors.length > 0) {
  console.error(`BEYOND安装验真失败：${errors.length}项`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`BEYOND ${manifest.releaseVersion}安装验真通过：六个Skill与项目通用入口一致`);
