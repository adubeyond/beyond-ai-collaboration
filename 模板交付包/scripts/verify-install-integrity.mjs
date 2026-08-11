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
const projectRoot = projectAgentsPath ? dirname(projectAgentsPath) : null;

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

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`${label}不是有效JSON：${error.message}`);
    return null;
  }
}

function compareRuntimeHooks(candidateText, installedText, installedAgentsText) {
  const candidate = parseJson(candidateText, "候选Hook配置");
  const installed = parseJson(installedText, "项目Hook配置");
  if (!candidate?.hooks || !installed?.hooks) {
    errors.push("候选或项目Hook配置缺少hooks对象");
    return;
  }
  const controlMatch = installedAgentsText?.match(/<!-- BEYOND-CONTROL-ROOT: ([^\n]+) -->/);
  const projectMatch = installedAgentsText?.match(/<!-- BEYOND-PROJECT-ID: ([^\n]+) -->/);
  const suffix = controlMatch && projectMatch
    ? ` --control-root ${JSON.stringify(controlMatch[1].trim())} --project-id ${JSON.stringify(projectMatch[1].trim())}`
    : "";
  for (const [event, sourceGroups] of Object.entries(candidate.hooks)) {
    const expectedGroups = sourceGroups.map((group) => ({
      ...group,
      hooks: group.hooks.map((handler) => ({
        ...handler,
        command: handler.command?.includes("beyond-runtime-guard.mjs") ? `${handler.command}${suffix}` : handler.command,
      })),
    }));
    const actualGroups = Array.isArray(installed.hooks[event]) ? installed.hooks[event] : [];
    for (const expected of expectedGroups) {
      const expectedText = JSON.stringify(expected);
      const matches = actualGroups.filter((actual) => JSON.stringify(actual) === expectedText).length;
      if (matches !== 1) errors.push(`项目Hook配置中的${event}身份护栏不是唯一当前版本`);
    }
  }
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  let normalized = `${text.slice(0, beginIndex + begin.length)}\n<!-- PROJECT OVERRIDES OMITTED -->\n${text.slice(endIndex)}`;

  const controlMatch = normalized.match(/<!-- BEYOND-CONTROL-ROOT: ([^\n]+) -->/);
  const projectMatch = normalized.match(/<!-- BEYOND-PROJECT-ID: ([^\n]+) -->/);
  if ((controlMatch && !projectMatch) || (!controlMatch && projectMatch)) {
    errors.push(`${label}控制仓映射不完整`);
    return null;
  }
  if (controlMatch) {
    const controlRoot = controlMatch[1].trim().replace(/\\/g, "/").replace(/\/$/, "");
    const projectId = projectMatch[1].trim();
    for (const directory of ["docs", "scripts", "local", "projects"]) {
      normalized = normalized.replace(
        new RegExp(`\\]\\(<${escapeRegExp(controlRoot)}/${directory}/([^>]+)>\\)`, "g"),
        `](${directory}/$1)`,
      );
      normalized = normalized.replace(
        new RegExp(`\\]\\(${escapeRegExp(controlRoot)}/${directory}/`, "g"),
        `](${directory}/`,
      );
      normalized = normalized.replace(
        new RegExp(`\\\`${escapeRegExp(controlRoot)}/${directory}/`, "g"),
        `\`${directory}/`,
      );
    }
    normalized = normalized.replaceAll(projectId, "<project-id>");
    normalized = normalized
      .replace(/\n?<!-- BEYOND-CONTROL-ROOT: [^\n]+ -->/, "")
      .replace(/\n?<!-- BEYOND-PROJECT-ID: [^\n]+ -->/, "");
  }

  const nativeBegin = "<!-- BEGIN PROJECT NATIVE RULES -->";
  const nativeEnd = "<!-- END PROJECT NATIVE RULES -->";
  const nativeBeginIndex = normalized.indexOf(nativeBegin);
  const nativeEndIndex = normalized.indexOf(nativeEnd);
  if ((nativeBeginIndex === -1) !== (nativeEndIndex === -1) || nativeEndIndex < nativeBeginIndex) {
    errors.push(`${label}项目原生规则保留区不完整`);
    return null;
  }
  if (nativeBeginIndex !== -1) {
    if (
      normalized.indexOf(nativeBegin, nativeBeginIndex + nativeBegin.length) !== -1 ||
      normalized.indexOf(nativeEnd, nativeEndIndex + nativeEnd.length) !== -1
    ) {
      errors.push(`${label}包含重复项目原生规则保留区`);
      return null;
    }
    normalized = normalized.slice(0, nativeBeginIndex);
  }
  return normalized.trimEnd();
}

if (manifest) {
  if (manifest.schemaVersion !== 3 || !/^3\.\d+\.\d+$/.test(manifest.releaseVersion)) {
    errors.push("候选版本清单字段无效");
  }
  if (
    manifest.controlEntry !== "AGENTS.md" ||
    manifest.projectEntry !== "AGENTS.md" ||
    manifest.controlScript !== "scripts/beyond-control.mjs" ||
    manifest.runtimeHooks !== ".codex/hooks.json" ||
    manifest.runtimeGuard !== ".codex/beyond-runtime-guard.mjs"
  ) {
    errors.push("候选版本清单缺少控制仓入口、项目入口、固定动作脚本或身份护栏");
  }
  if (!Array.isArray(manifest.skills) || JSON.stringify(manifest.skills) !== JSON.stringify(expectedSkills)) {
    errors.push("候选版本清单必须按正式名称声明六个Skill");
  } else {
    for (const skill of manifest.skills) compareSkill(skill);
  }

  const candidateAgents = readUtf8(join(candidateRoot, manifest.controlEntry), "候选控制仓入口");
  const installedAgents = readUtf8(projectAgentsPath, "项目入口");
  if (candidateAgents && installedAgents) {
    const normalizedCandidate = normalizeProjectEntry(candidateAgents, "候选控制仓入口");
    const normalizedInstalled = normalizeProjectEntry(installedAgents, "项目入口");
    if (normalizedCandidate && normalizedInstalled && normalizedCandidate !== normalizedInstalled) {
      errors.push("项目入口的BEYOND运行内核与控制仓候选不一致；可能仍是旧版、弱入口或混合版本");
    }
  }

  const controlMatch = installedAgents?.match(/<!-- BEYOND-CONTROL-ROOT: ([^\n]+) -->/);
  if (controlMatch) {
    const mappedControlRoot = resolve(projectRoot, controlMatch[1].trim());
    const mappedManifest = readUtf8(join(mappedControlRoot, "beyond-release.json"), "项目映射的控制仓版本清单");
    const mappedControlScript = readUtf8(join(mappedControlRoot, manifest.controlScript), "项目映射的控制仓固定脚本");
    const candidateControlScript = readUtf8(join(candidateRoot, manifest.controlScript), "候选控制仓固定脚本");
    if (mappedManifest && mappedManifest !== manifestText) {
      errors.push("项目映射的控制仓版本清单与当前候选不一致");
    }
    if (mappedControlScript && candidateControlScript && mappedControlScript !== candidateControlScript) {
      errors.push("项目映射的控制仓固定脚本与当前候选不一致");
    }
  }

  const controlScript = readUtf8(join(candidateRoot, manifest.controlScript), "控制仓固定动作脚本");
  const candidateHooks = readUtf8(join(candidateRoot, manifest.runtimeHooks), "候选Hook配置");
  const installedHooks = readUtf8(join(projectRoot, manifest.runtimeHooks), "项目Hook配置");
  const candidateGuard = readUtf8(join(candidateRoot, manifest.runtimeGuard), "候选身份护栏脚本");
  const installedGuard = readUtf8(join(projectRoot, manifest.runtimeGuard), "项目身份护栏脚本");
  const gitignore = readUtf8(join(candidateRoot, ".gitignore"), "控制仓.gitignore");
  if (controlScript && !controlScript.includes("install-project-entry")) {
    errors.push("控制仓固定动作脚本缺少项目入口融合动作");
  }
  if (candidateHooks && installedHooks) compareRuntimeHooks(candidateHooks, installedHooks, installedAgents);
  if (candidateGuard && installedGuard && candidateGuard !== installedGuard) {
    errors.push("项目身份护栏脚本与控制仓候选不一致");
  }
  if (gitignore && !gitignore.split("\n").some((line) => line.trim() === "/local/")) {
    errors.push("控制仓.gitignore没有排除local/");
  }
}

if (errors.length > 0) {
  console.error(`BEYOND安装验真失败：${errors.length}项`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`BEYOND ${manifest.releaseVersion}安装验真通过：六个Skill、控制仓结构、项目运行内核与身份护栏一致`);
