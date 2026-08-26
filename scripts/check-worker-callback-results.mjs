import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const beforeRoot = process.env.BEYOND_WORKER_CALLBACK_BEFORE_ROOT;
const afterRoot = process.env.BEYOND_WORKER_CALLBACK_AFTER_ROOT;
const summaryPath = process.env.BEYOND_WORKER_CALLBACK_SUMMARY;

for (const [name, value] of Object.entries({ beforeRoot, afterRoot })) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

function message(root) {
  const path = join(root, "evidence", "WST-WORKER-CALLBACK-last-message.txt");
  if (!existsSync(path)) throw new Error(`missing callback evidence: ${path}`);
  return readFileSync(path, "utf8").trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const before = message(beforeRoot);
const after = message(afterRoot);

const required = [
  "已完成",
  "不通过",
  "section_name",
  "evidence/quality-review.md",
  "原站 Worker",
  "同一冻结集合",
];
for (const text of required) assert(after.includes(text), `after callback lost required fact: ${text}`);
assert(
  after.includes("50/50") || /50\s*条[^。\n]*全部/.test(after),
  "after callback lost the 50-of-50 primary finding",
);

const movedToEvidence = [
  "evidence/full-check.json",
  "集合 SHA-256",
  "136 项",
  "9 项",
  "197 项",
  "未创建 worktree",
  "未访问网络",
];
for (const text of movedToEvidence) assert(!after.includes(text), `control-plane callback copied detail: ${text}`);

assert(after.length < 500, `callback exceeded the current compact terminal limit: ${after.length}`);

const summary = {
  beforeChars: before.length,
  afterChars: after.length,
  reduction: Number((1 - after.length / before.length).toFixed(4)),
  compactLimit: 500,
  requiredFacts: required,
  detailsMovedToEvidence: movedToEvidence,
};

if (summaryPath) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
