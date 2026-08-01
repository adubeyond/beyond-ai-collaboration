import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const sourceCodexHome = process.env.BEYOND_SOURCE_CODEX_HOME;

if (!runtimeRoot || !isAbsolute(runtimeRoot)) {
  throw new Error("BEYOND_ISOLATED_ROOT must be an absolute path");
}
if (!sourceCodexHome || !isAbsolute(sourceCodexHome)) {
  throw new Error("BEYOND_SOURCE_CODEX_HOME must be an absolute path");
}
if (existsSync(runtimeRoot) && readdirSync(runtimeRoot).length > 0) {
  throw new Error(`isolated root must not already contain files: ${runtimeRoot}`);
}

const expectedSkills = [
  "identity-pm",
  "identity-worker",
  "task-design",
  "task-dev",
  "task-test",
  "task-ops",
];

function filesUnder(root) {
  const result = [];
  if (!existsSync(root)) return result;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function manifest(root) {
  return filesUnder(root).map((path) => ({
    path: relative(root, path).replaceAll("\\", "/"),
    bytes: statSync(path).size,
    sha256: sha256(path),
  }));
}

function copyProjectFixture(target) {
  cpSync(join(repositoryRoot, "examples", "minimal-project"), target, { recursive: true });
  cpSync(join(repositoryRoot, "模板交付包", "AGENTS.md"), join(target, "AGENTS.md"));
  cpSync(
    join(repositoryRoot, "模板交付包", "docs", "AI编程协同机制"),
    join(target, "docs", "AI编程协同机制"),
    { recursive: true },
  );
}

function writeFixture(root, relativePath, content) {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function initializeGit(root, message) {
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "BEYOND Isolated Test");
  git(root, "config", "user.email", "beyond-isolated@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", message);
}

function addOrderSummaryFixture(root) {
  writeFixture(root, "src/orderSummary.js", `import { orderSubtotal } from './pricing.js';

export function createOrderSummary(lines) {
  const subtotal = orderSubtotal(lines);
  return { subtotal, total: subtotal };
}
`);
  writeFixture(root, "src/pricing.js", `export function orderSubtotal(lines) {
  return lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0);
}
`);
  writeFixture(root, "test/orderSummary.test.js", `import assert from 'node:assert/strict';
import test from 'node:test';

import { createOrderSummary } from '../src/orderSummary.js';

test('preserves the current undiscounted contract', () => {
  assert.deepEqual(createOrderSummary([{ quantity: 2, unitPrice: 15 }]), { subtotal: 30, total: 30 });
});
`);
}

function addOpsFixture(root) {
  const jsonFiles = {
    "artifacts/v1/api.json": { version: "v1", feature: "old" },
    "artifacts/v1/adjacent.json": { version: "v1", adjacent: "preserved" },
    "artifacts/v2/api.json": { version: "v2", feature: "fixed" },
    "artifacts/v2/adjacent.json": { version: "v2", adjacent: "preserved" },
    "artifacts/v3-bad/api.json": { version: "v3-bad", feature: "fixed" },
    "artifacts/v3-bad/adjacent.json": { version: "v3-bad", adjacent: "broken" },
    "runtime/current/api.json": { version: "v1", feature: "old" },
    "runtime/current/adjacent.json": { version: "v1", adjacent: "preserved" },
    "runtime/current/identity.json": { environment: "sim-prod-a" },
    "runtime/legacy/api.json": { version: "legacy", feature: "legacy" },
    "runtime/legacy/adjacent.json": { version: "legacy", adjacent: "legacy" },
    "runtime/legacy/identity.json": { environment: "sim-old" },
  };
  for (const [path, value] of Object.entries(jsonFiles)) {
    writeFixture(root, path, `${JSON.stringify(value)}\n`);
  }
  writeFixture(root, "ops/current-runbook.md", `# Current simulation runbook

- Owner: this file is the current operations source of truth.
- Environment identity: \`sim-prod-a\`.
- Runtime: \`runtime/current\`.
- Current version before this drill: \`v1\`.
- Deploy the complete named artifact with \`node scripts/deploy.mjs <artifact-dir> runtime/current\`.
- Verify with \`node scripts/health.mjs runtime/current\` and \`node scripts/business.mjs runtime/current\`.
- Roll back with \`node scripts/rollback.mjs runtime/current\`, then rerun both checks.
- This is a local non-network simulation. It authorizes the complete v2 release and the named v3-bad failure/rollback drill only.
`);
  writeFixture(root, "ops/legacy-runbook.md", `# Retired runbook

This historical document points to \`runtime/legacy\` and environment \`sim-old\`. It is not a current release target.
`);
  writeFixture(root, "scripts/deploy.mjs", `import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [artifactArg, runtimeArg] = process.argv.slice(2);
if (!artifactArg || !runtimeArg) process.exit(2);
const artifact = resolve(artifactArg);
const runtime = resolve(runtimeArg);
for (const name of ['api.json', 'adjacent.json']) {
  if (!existsSync(join(artifact, name))) process.exit(3);
}
mkdirSync(join(runtime, 'rollback'), { recursive: true });
for (const name of ['api.json', 'adjacent.json']) {
  cpSync(join(runtime, name), join(runtime, 'rollback', name));
  cpSync(join(artifact, name), join(runtime, name));
}
const api = JSON.parse(readFileSync(join(runtime, 'api.json'), 'utf8'));
writeFileSync(join(runtime, 'runtime-state.json'), \`${"${JSON.stringify({ version: api.version, artifact })}"}\\n\`);
`);
  writeFixture(root, "scripts/health.mjs", `import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const runtime = resolve(process.argv[2] ?? '');
const identity = JSON.parse(readFileSync(join(runtime, 'identity.json'), 'utf8'));
const api = JSON.parse(readFileSync(join(runtime, 'api.json'), 'utf8'));
if (identity.environment !== 'sim-prod-a' || !api.version) process.exit(1);
console.log(\`healthy ${"${identity.environment}"} ${"${api.version}"}\`);
`);
  writeFixture(root, "scripts/business.mjs", `import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const runtime = resolve(process.argv[2] ?? '');
const api = JSON.parse(readFileSync(join(runtime, 'api.json'), 'utf8'));
const adjacent = JSON.parse(readFileSync(join(runtime, 'adjacent.json'), 'utf8'));
if (api.feature !== 'fixed' || adjacent.adjacent !== 'preserved' || api.version !== adjacent.version) {
  console.error(JSON.stringify({ api, adjacent }));
  process.exit(1);
}
console.log(\`business-ok ${"${api.version}"}\`);
`);
  writeFixture(root, "scripts/rollback.mjs", `import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const runtime = resolve(process.argv[2] ?? '');
for (const name of ['api.json', 'adjacent.json']) {
  cpSync(join(runtime, 'rollback', name), join(runtime, name));
}
const api = JSON.parse(readFileSync(join(runtime, 'api.json'), 'utf8'));
writeFileSync(join(runtime, 'runtime-state.json'), \`${"${JSON.stringify({ version: api.version, rolledBack: true })}"}\\n\`);
`);
}

function setHealthyWorkbench(root) {
  const path = join(root, "docs", "AI编程协同机制", "当前工作台.md");
  const original = readFileSync(path, "utf8");
  const updated = original
    .replace(
      "| <时间> | <现在最重要的业务结果> | <进行中 / 已暂停 / 已完成> | <当前首要问题> | <任务线程、提交、测试或运行结果入口> | <动作 + 责任方> | <无 / 唯一问题> |",
      "| 2026-08-01 | 保持计算器示例可验证 | 进行中 | 准备下一个明确功能 | README.md 与 npm test | PM根据用户请求建立下一任务 | 无 |",
    )
    .replace(
      "| <可独立验收的结果> | <唯一 Worker / thread> | <进行中 / 已暂停 / 已完成> | <当前动作或最近有效里程碑> | <无 / 唯一原因 + 恢复条件> | <待交付 / 提交、文件、版本或运行对象> | <时间> |",
      "| 当前无活动业务任务 | 无 | 已完成 | 基线测试已存在 | 无 | README.md | 2026-08-01 |",
    );
  writeFileSync(path, updated);
}

mkdirSync(runtimeRoot, { recursive: true });
const isolatedCodexHome = join(runtimeRoot, "codex-home");
const isolatedSkillsRoot = join(isolatedCodexHome, "skills");
const evidenceRoot = join(runtimeRoot, "evidence");
const casesRoot = join(runtimeRoot, "cases");
mkdirSync(isolatedSkillsRoot, { recursive: true });
mkdirSync(evidenceRoot, { recursive: true });
mkdirSync(casesRoot, { recursive: true });

for (const skill of expectedSkills) {
  const source = join(repositoryRoot, "模板交付包", "skills", skill);
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new Error(`candidate skill missing: ${skill}`);
  }
  cpSync(source, join(isolatedSkillsRoot, skill), { recursive: true });
}

const sourceAuth = join(sourceCodexHome, "auth.json");
if (!existsSync(sourceAuth)) {
  throw new Error(`Codex authentication file missing: ${sourceAuth}`);
}
cpSync(sourceAuth, join(isolatedCodexHome, "auth.json"));

for (const caseName of ["I03-discovery", "R01-direct", "R02-worker", "R05-design", "R05-explicit-design", "R06-pause", "O01-ops", "P01-pm-healthy", "P02-pm-empty", "P03-pm-delegation"]) {
  copyProjectFixture(join(casesRoot, caseName));
}

initializeGit(join(casesRoot, "I03-discovery"), "fixture: isolated discovery");
initializeGit(join(casesRoot, "R01-direct"), "fixture: direct local change");

const r02 = join(casesRoot, "R02-worker");
writeFixture(r02, "src/normalizeLabel.js", `export function normalizeLabel(value) {
  return value.trim();
}
`);
writeFixture(r02, "test/normalizeLabel.test.js", `import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeLabel } from '../src/normalizeLabel.js';

test('trims leading and trailing whitespace', () => {
  assert.equal(normalizeLabel('  Alpha  '), 'Alpha');
});

test('collapses consecutive internal whitespace', () => {
  assert.equal(normalizeLabel('Alpha   Beta'), 'Alpha Beta');
});
`);
writeFixture(r02, "notes/unrelated.txt", "This file belongs to another local change.\n");
initializeGit(r02, "fixture: failing normalize behavior");
writeFixture(r02, "notes/unrelated.txt", "This file belongs to another local change.\nThis line was added by another task and must remain uncommitted.\n");

for (const caseName of ["R05-design", "R05-explicit-design"]) {
  const root = join(casesRoot, caseName);
  addOrderSummaryFixture(root);
  initializeGit(root, "fixture: initial order summary");
}

initializeGit(join(casesRoot, "R06-pause"), "fixture: production information gap");

const ops = join(casesRoot, "O01-ops");
addOpsFixture(ops);
initializeGit(ops, "fixture: local release drill");

for (const caseName of ["P01-pm-healthy", "P03-pm-delegation"]) {
  const root = join(casesRoot, caseName);
  setHealthyWorkbench(root);
  initializeGit(root, `fixture: ${caseName}`);
}
initializeGit(join(casesRoot, "P02-pm-empty"), "fixture: empty workbench");

const globalSkillsRoot = join(sourceCodexHome, "skills");
const globalSkillManifest = expectedSkills.flatMap((skill) => {
  const root = join(globalSkillsRoot, skill);
  return manifest(root).map((entry) => ({ skill, ...entry }));
});

const candidateSkillManifest = expectedSkills.flatMap((skill) => {
  const root = join(repositoryRoot, "模板交付包", "skills", skill);
  return manifest(root).map((entry) => ({ skill, ...entry }));
});

const installedSkillManifest = expectedSkills.flatMap((skill) => {
  const root = join(isolatedSkillsRoot, skill);
  return manifest(root).map((entry) => ({ skill, ...entry }));
});

const candidateByKey = new Map(
  candidateSkillManifest.map((entry) => [`${entry.skill}/${entry.path}`, entry.sha256]),
);
const installMismatch = installedSkillManifest.filter(
  (entry) => candidateByKey.get(`${entry.skill}/${entry.path}`) !== entry.sha256,
);

const preflight = {
  createdAt: new Date().toISOString(),
  repositoryRoot,
  runtimeRoot: resolve(runtimeRoot),
  isolatedCodexHome,
  casesRoot,
  expectedSkills,
  preparedCases: readdirSync(casesRoot).sort((left, right) => left.localeCompare(right, "en")),
  globalSkillFiles: globalSkillManifest.length,
  candidateSkillFiles: candidateSkillManifest.length,
  installedSkillFiles: installedSkillManifest.length,
  installMismatch,
  note: "auth.json was copied only into the isolated CODEX_HOME and is intentionally excluded from evidence",
};

writeFileSync(join(evidenceRoot, "global-skills-before.json"), `${JSON.stringify(globalSkillManifest, null, 2)}\n`);
writeFileSync(join(evidenceRoot, "candidate-skills.json"), `${JSON.stringify(candidateSkillManifest, null, 2)}\n`);
writeFileSync(join(evidenceRoot, "installed-skills.json"), `${JSON.stringify(installedSkillManifest, null, 2)}\n`);
writeFileSync(join(evidenceRoot, "preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`);

if (installMismatch.length > 0 || candidateSkillManifest.length !== installedSkillManifest.length) {
  throw new Error("isolated Skill installation differs from the candidate source");
}

console.log(JSON.stringify(preflight, null, 2));
