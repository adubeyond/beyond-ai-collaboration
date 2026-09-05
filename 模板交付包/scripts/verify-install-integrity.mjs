import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
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
const contentOnly = process.argv.includes("--content-only");

if (!installedSkillsRoot || !projectAgentsPath) {
  console.error(
    "用法：node verify-install-integrity.mjs --installed-skills-root <Codex skills目录> --project-agents <项目AGENTS.md> [--content-only]",
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
const expectedControlRuntimeFiles = [
  "scripts/runtime/control-runtime.mjs",
  "scripts/runtime/project-identity-provider.mjs",
  "scripts/runtime/worker-result-receipts.mjs",
  "scripts/runtime/workbench-transaction.mjs",
];

function display(path) {
  return path.split(sep).join("/");
}

function canonicalPath(value) {
  const absolute = resolve(value);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

function samePath(left, right) {
  const canonicalLeft = canonicalPath(left);
  const canonicalRight = canonicalPath(right);
  return process.platform === "win32"
    ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
    : canonicalLeft === canonicalRight;
}

function pathKey(value) {
  const canonical = canonicalPath(value);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function normalizeRemote(value) {
  let remote = String(value ?? "").trim();
  if (!remote) return null;
  remote = remote.replace(/^([^@\s]+)@([^:\s]+):(.+)$/, "https://$2/$3");
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    if (["ssh:", "git:"].includes(url.protocol)) url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    remote = url.toString();
  } catch {
    // Local and provider-specific spellings remain opaque normalized values.
  }
  return remote.replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase();
}

function gitRepositoryFacts(repositoryRoot) {
  const run = (args) => spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8", windowsHide: true,
  });
  const topLevel = run(["rev-parse", "--show-toplevel"]);
  if (topLevel.status !== 0) return null;
  const remote = run(["remote", "get-url", "origin"]);
  return {
    topLevel: canonicalPath(String(topLevel.stdout ?? "").trim()),
    remote: remote.status === 0 ? normalizeRemote(remote.stdout) : null,
  };
}

function validateRegisteredRepositories(value, canonicalProjectRoot, label) {
  let parsed;
  try { parsed = JSON.parse(value ?? ""); }
  catch {
    errors.push(`${label}缺少有效repositories_json`);
    return null;
  }
  if (!Array.isArray(parsed)) {
    errors.push(`${label}的repositories_json不是数组`);
    return null;
  }
  const paths = [];
  for (const item of parsed) {
    const objectItem = item && typeof item === "object" && !Array.isArray(item) ? item : null;
    const rawPath = typeof item === "string" ? item : objectItem?.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      errors.push(`${label}的repositories_json包含无效路径条目`);
      continue;
    }
    const repositoryPath = canonicalPath(rawPath);
    const expectedRole = samePath(repositoryPath, canonicalProjectRoot) ? "project-root" : "component";
    if (objectItem?.role !== undefined && !["project-root", "component"].includes(objectItem.role)) {
      errors.push(`${label}的repositories_json包含无效role`);
    } else if (objectItem?.role !== undefined && objectItem.role !== expectedRole) {
      errors.push(`${label}的repositories_json的role与路径不一致`);
    }
    if (objectItem?.kind !== undefined && objectItem.kind !== "git") {
      errors.push(`${label}的repositories_json包含无效kind`);
    }
    const requiresGit = objectItem?.kind === "git" || expectedRole === "component" || Boolean(objectItem?.remote);
    if (requiresGit) {
      const facts = existsSync(repositoryPath) && lstatSync(repositoryPath).isDirectory()
        ? gitRepositoryFacts(repositoryPath) : null;
      if (!facts || !samePath(facts.topLevel, repositoryPath)) {
        errors.push(`${label}的登记仓库不是存在的精确Git根：${display(repositoryPath)}`);
      } else if (objectItem?.remote && facts.remote !== normalizeRemote(objectItem.remote)) {
        errors.push(`${label}的登记仓库remote与现场不一致：${display(repositoryPath)}`);
      }
    }
    paths.push(pathKey(repositoryPath));
  }
  if (new Set(paths).size !== paths.length) errors.push(`${label}的repositories_json包含重复路径`);
  return parsed;
}

function frontmatter(text) {
  const match = text?.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const values = {};
  if (!match) return values;
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
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

function containsBeyondHook(text, label) {
  const parsed = parseJson(text, label);
  if (!parsed?.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) return false;
  return Object.values(parsed.hooks).some((groups) => Array.isArray(groups) && groups.some((group) =>
    Array.isArray(group?.hooks) && group.hooks.some((handler) =>
      [handler?.command, handler?.commandWindows, handler?.command_windows]
        .some((value) => typeof value === "string" && value.includes("beyond-runtime-guard.mjs")))));
}

function validateWorkerPolicy(text, label) {
  const begin = "<!-- BEGIN BEYOND WORKER POLICY -->";
  const end = "<!-- END BEYOND WORKER POLICY -->";
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start + begin.length);
  if (start < 0 || finish < start || text.indexOf(begin, start + begin.length) >= 0 || text.indexOf(end, finish + end.length) >= 0) {
    errors.push(`${label}缺少唯一Worker运行策略受管块`);
    return;
  }
  const block = text.slice(start + begin.length, finish);
  const encoded = block.match(/```json\s*([\s\S]*?)\s*```/i)?.[1];
  if (!encoded) {
    errors.push(`${label}的Worker运行策略不是受管JSON`);
    return;
  }
  const policy = parseJson(encoded, `${label}的Worker运行策略`);
  if (!policy) return;
  if (policy.schemaVersion !== 1 || !["platform-default", "beyond-worker-matrix-v1"].includes(policy.mode)
    || policy.scope !== "new-formal-worker" || typeof policy.confirmed !== "boolean") {
    errors.push(`${label}的Worker运行策略字段无效`);
  }
  if (policy.confirmed && (!policy.approvedBy || !policy.approvedAt || Number.isNaN(Date.parse(policy.approvedAt)))) {
    errors.push(`${label}的已确认Worker运行策略缺少有效批准依据或时间`);
  }
}

function validateProjectInitialization(text, label) {
  const begin = "<!-- BEGIN BEYOND PROJECT INITIALIZATION -->";
  const end = "<!-- END BEYOND PROJECT INITIALIZATION -->";
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start + begin.length);
  if (start < 0 || finish < start || text.indexOf(begin, start + begin.length) >= 0 || text.indexOf(end, finish + end.length) >= 0) {
    errors.push(`${label}缺少唯一项目初始化受管块`);
    return;
  }
  const encoded = text.slice(start + begin.length, finish).match(/```json\s*([\s\S]*?)\s*```/i)?.[1];
  if (!encoded) {
    errors.push(`${label}的项目初始化状态不是受管JSON`);
    return;
  }
  const state = parseJson(encoded, `${label}的项目初始化状态`);
  if (!state) return;
  const groups = ["overview", "architecture", "development", "testing", "operations", "security", "other"];
  const groupKeys = state.groups && typeof state.groups === "object" && !Array.isArray(state.groups)
    ? Object.keys(state.groups).sort().join("|") : "";
  if (state.schemaVersion !== 1 || !["awaiting-choice", "full-in-progress", "on-demand", "complete"].includes(state.status)
    || ![null, "full", "on-demand"].includes(state.mode) || groupKeys !== groups.sort().join("|")) {
    errors.push(`${label}的项目初始化状态字段无效`);
    return;
  }
  const pending = groups.filter((group) => state.groups[group] === null);
  if (state.status === "complete" && (pending.length || !state.rootEntryReviewedAt
    || Number.isNaN(Date.parse(state.rootEntryReviewedAt))
    || !state.completedAt || Number.isNaN(Date.parse(state.completedAt)))) {
    errors.push(`${label}把未收口的项目初始化标成完成`);
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
    if (/(?:Luna|Terra|Sol|gpt-5\.[0-9]+-(?:luna|terra|sol)|模型矩阵|Worker.{0,20}(?:模型|推理))/i.test(line)) {
      errors.push(`${label}仍在根覆盖区保存模型策略；必须迁入项目总览受管策略块：${line}`);
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
    "runtimeHooks" in manifest ||
    "runtimeGuard" in manifest
  ) {
    errors.push("候选版本清单必须声明控制仓入口、项目入口和固定动作脚本，且不得继续登记BEYOND Hook");
  }
  if (!Array.isArray(manifest.skills) || JSON.stringify(manifest.skills) !== JSON.stringify(expectedSkills)) {
    errors.push("候选版本清单必须按正式名称声明六个Skill");
  } else {
    for (const skill of manifest.skills) compareSkill(skill);
  }
  if (!Array.isArray(manifest.controlRuntimeFiles)
    || JSON.stringify(manifest.controlRuntimeFiles) !== JSON.stringify(expectedControlRuntimeFiles)) {
    errors.push("候选版本清单必须完整声明确定性控制运行文件");
  } else {
    for (const relativePath of manifest.controlRuntimeFiles) {
      readUtf8(join(candidateRoot, ...relativePath.split("/")), `候选控制运行文件${relativePath}`);
    }
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
  const projectMatch = installedAgents?.match(/<!-- BEYOND-PROJECT-ID: ([^\n]+) -->/);
  if ((installedAgents?.match(/<!-- BEYOND-CONTROL-ROOT: /g) ?? []).length > 1
    || (installedAgents?.match(/<!-- BEYOND-PROJECT-ID: /g) ?? []).length > 1) {
    errors.push("项目入口包含重复控制仓或项目编号映射");
  }
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
    for (const relativePath of manifest.controlRuntimeFiles ?? []) {
      const mappedRuntime = readUtf8(
        join(mappedControlRoot, ...relativePath.split("/")),
        `项目映射的控制运行文件${relativePath}`,
      );
      const candidateRuntime = readUtf8(
        join(candidateRoot, ...relativePath.split("/")),
        `候选控制运行文件${relativePath}`,
      );
      if (mappedRuntime && candidateRuntime && mappedRuntime !== candidateRuntime) {
        errors.push(`项目映射的控制运行文件与当前候选不一致：${relativePath}`);
      }
    }
    if (!projectMatch) {
      errors.push("项目入口缺少BEYOND项目编号映射");
    } else {
      const projectId = projectMatch[1].trim();
      const localDirectory = join(mappedControlRoot, "local", "projects");
      const localRegistrations = existsSync(localDirectory) && lstatSync(localDirectory).isDirectory()
        ? readdirSync(localDirectory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
          .map((entry) => {
            const file = join(localDirectory, entry.name);
            return { file, facts: frontmatter(readUtf8(file, `本机项目登记${entry.name}`)) };
          })
        : [];
      const idMatches = localRegistrations.filter((record) => record.facts.id === projectId);
      const pathMatches = localRegistrations.filter((record) => record.facts.path && samePath(record.facts.path, projectRoot));
      if (idMatches.length === 1 && (!idMatches[0].facts.path || !samePath(idMatches[0].facts.path, projectRoot))) {
        errors.push("本机项目登记路径与当前项目根不一致");
      }
      if (pathMatches.length === 1 && pathMatches[0].facts.id !== projectId) {
        errors.push("本机项目登记编号与项目入口不一致");
      }
      if (idMatches.length === 0 && pathMatches.length === 0) errors.push("项目映射的本机项目登记不存在");
      if (idMatches.length !== 1) errors.push(`本机项目编号必须且只能登记一次：${projectId}`);
      if (pathMatches.length !== 1) errors.push("当前项目根必须且只能存在一条本机登记");
      const registrationRecord = idMatches.length === 1 && pathMatches.length === 1
        && idMatches[0].file === pathMatches[0].file ? idMatches[0] : null;
      if (!registrationRecord) {
        errors.push("本机项目登记编号与当前项目根没有唯一闭合");
      } else {
        const registeredRepositories = validateRegisteredRepositories(
          registrationRecord.facts.repositories_json,
          projectRoot,
          "项目映射的本机项目登记",
        );
        const hasComponentRepository = registeredRepositories?.some((item) => {
          const value = typeof item === "string" ? item : item?.path;
          return typeof value === "string" && value.trim() && !samePath(value, projectRoot);
        });
        if (hasComponentRepository
          && (!registrationRecord.facts.host_id || !registrationRecord.facts.codex_project_id)) {
          errors.push("多仓或跨根项目登记缺少host_id或codex_project_id，不能形成可执行Worker路由");
        }
      }
      const overview = readUtf8(join(mappedControlRoot, "projects", projectId, "项目总览.md"), "项目映射的项目总览");
      if (overview) {
        validateProjectInitialization(overview, "项目映射的项目总览");
        validateWorkerPolicy(overview, "项目映射的项目总览");
      }
    }
  } else if (!contentOnly) {
    errors.push("完整安装验真需要项目控制仓映射；仅核对候选内容请显式使用 --content-only");
  }

  const controlScript = readUtf8(join(candidateRoot, manifest.controlScript), "控制仓固定动作脚本");
  const controlRuntime = readUtf8(join(candidateRoot, "scripts", "runtime", "control-runtime.mjs"), "控制运行统一入口");
  const workerResultRuntime = readUtf8(join(candidateRoot, "scripts", "runtime", "worker-result-receipts.mjs"), "Worker短期终态运行文件");
  const workbenchRuntime = readUtf8(join(candidateRoot, "scripts", "runtime", "workbench-transaction.mjs"), "工作台事务运行文件");
  const candidateHooksPath = join(candidateRoot, ".codex", "hooks.json");
  const candidateGuardPath = join(candidateRoot, ".codex", "beyond-runtime-guard.mjs");
  const installedHooksPath = join(projectRoot, ".codex", "hooks.json");
  const installedGuardPath = join(projectRoot, ".codex", "beyond-runtime-guard.mjs");
  const gitignore = readUtf8(join(candidateRoot, ".gitignore"), "控制仓.gitignore");
  if (controlScript && !controlScript.includes("install-project-entry")) {
    errors.push("控制仓固定动作脚本缺少项目入口融合动作");
  }
  if (controlScript && !controlScript.includes('command === "initialization"')) {
    errors.push("控制仓固定动作脚本缺少可恢复的项目初始化动作");
  }
  if (controlScript && !controlScript.includes("workbenchMigration")) {
    errors.push("控制仓固定动作脚本缺少老工作台迁移接入");
  }
  if (controlRuntime && !controlRuntime.includes("workbench.migrate")) {
    errors.push("控制运行统一入口缺少老工作台迁移动作");
  }
  if (controlRuntime && !controlRuntime.includes("worker-result.enqueue")) {
    errors.push("控制运行统一入口缺少Worker短期终态动作");
  }
  if (controlRuntime && !controlRuntime.includes("workbench.inspect")) {
    errors.push("控制运行统一入口缺少只读工作台检查动作");
  }
  if (workerResultRuntime && (!workerResultRuntime.includes("pendingRoot") || !workerResultRuntime.includes("acknowledge"))) {
    errors.push("Worker短期终态运行文件缺少pending或消费删除能力");
  }
  if (workbenchRuntime && !workbenchRuntime.includes("pre-3.2-markdown-workbench.md")) {
    errors.push("工作台事务缺少迁移前Markdown备份");
  }
  if (existsSync(candidateGuardPath)) {
    errors.push("候选交付包仍包含BEYOND身份护栏脚本");
  }
  if (existsSync(candidateHooksPath)) {
    const candidateHooks = readUtf8(candidateHooksPath, "候选现有Hook配置");
    if (candidateHooks && containsBeyondHook(candidateHooks, "候选现有Hook配置")) {
      errors.push("候选交付包仍引用BEYOND身份护栏");
    }
  }
  if (existsSync(installedGuardPath)) {
    errors.push("项目仍残留BEYOND身份护栏脚本");
  }
  if (existsSync(installedHooksPath)) {
    const installedHooks = readUtf8(installedHooksPath, "项目现有Hook配置");
    if (installedHooks && containsBeyondHook(installedHooks, "项目现有Hook配置")) {
      errors.push("项目现有Hook配置仍引用BEYOND身份护栏");
    }
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

console.log(contentOnly
  ? `BEYOND ${manifest.releaseVersion}内容验真通过（模式：发行模板，不是已初始化业务项目）：六个Skill、控制仓入口和固定脚本一致`
  : `BEYOND ${manifest.releaseVersion}安装验真通过（模式：已初始化业务项目）：六个Skill、控制仓结构、项目运行内核一致，标准路径不依赖BEYOND Hook`);
