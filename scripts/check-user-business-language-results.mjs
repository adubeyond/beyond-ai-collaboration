import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const beforeRoot = process.env.BEYOND_USER_LANGUAGE_BEFORE_ROOT;
const afterRoot = process.env.BEYOND_USER_LANGUAGE_AFTER_ROOT;
const summaryPath = process.env.BEYOND_USER_LANGUAGE_SUMMARY;

for (const [name, value] of Object.entries({ beforeRoot, afterRoot })) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

function readMessage(root, name) {
  const path = join(root, "evidence", `${name}-last-message.txt`);
  if (!existsSync(path)) throw new Error(`missing evidence: ${path}`);
  return readFileSync(path, "utf8").trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const caseNames = ["WST-USER-LANGUAGE-DIRECT", "WST-USER-LANGUAGE-WORKER"];
const forbidden = [
  "node --test",
  "exitCode",
  "4f82c1a0b7d9e2f3a11c",
  "codex/fix-company-manager-dedup",
  "companyManagers",
  "managerCount",
  "managerId",
  "src/companyRelations.js",
  "7 条断言",
];

const cases = caseNames.map((name) => {
  const before = readMessage(beforeRoot, name);
  const after = readMessage(afterRoot, name);
  for (const text of ["老板", "负责人", "测试", "页面"]) {
    assert(after.includes(text), `${name} lost business fact: ${text}`);
  }
  assert(
    after.includes("不再重复") || after.includes("重复负责人") || after.includes("重复显示"),
    `${name} lost the duplicate-manager fix`,
  );
  assert(
    after.includes("尚未") || after.includes("还没有") || after.includes("不能确认可用") || after.includes("不能按线上已可用"),
    `${name} lost the not-yet-usable conclusion`,
  );
  for (const text of forbidden) {
    assert(!after.includes(text), `${name} exposed unnecessary technical detail: ${text}`);
  }
  assert(after.length < before.length, `${name} did not become more focused: ${before.length} -> ${after.length}`);
  return { name, beforeChars: before.length, afterChars: after.length };
});

const summary = { cases, forbiddenTechnicalDetails: forbidden };
if (summaryPath) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
