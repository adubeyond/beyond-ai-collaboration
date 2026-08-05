import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const outputPath = process.env.BEYOND_PACKET_SUMMARY;
const runRoots = {
  v305: process.env.BEYOND_PACKET_V305_ROOT,
  currentBefore: process.env.BEYOND_PACKET_CURRENT_BEFORE_ROOT,
  fixedR1: process.env.BEYOND_PACKET_FIXED_R1_ROOT,
  fixedR2: process.env.BEYOND_PACKET_FIXED_R2_ROOT,
};

for (const [name, value] of Object.entries({ outputPath, ...runRoots })) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

const requiredFacts = [
  "$identity-worker",
  "50",
  "全部异常",
  "10 条",
  "站甲",
  "站乙",
  "站丙",
  "人工复核",
  "原有三个站点 Worker",
  "evidence/three-site-quality-review/",
];

function readEvents(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function inspect(root) {
  const evidenceRoot = join(root, "evidence");
  const messagePath = join(evidenceRoot, "WST-AB-PACKET-last-message.txt");
  const eventsPath = join(evidenceRoot, "WST-AB-PACKET-events.jsonl");
  if (!existsSync(messagePath) || !existsSync(eventsPath)) throw new Error(`missing packet evidence: ${root}`);
  const message = readFileSync(messagePath, "utf8").trim();
  const lines = message.split(/\r?\n/);
  const commands = readEvents(eventsPath)
    .filter((event) => event.type === "item.completed" && event.item?.type === "command_execution")
    .map((event) => event.item.command ?? "");
  const worktree = join(root, "cases", "WST-AB-PACKET-review");
  const facts = Object.fromEntries(requiredFacts.map((fact) => [fact, message.includes(fact)]));
  return {
    characters: [...message].length,
    lines: lines.length,
    listLines: lines.filter((line) => /^\s*[-0-9]/.test(line)).length,
    commandCount: commands.length,
    actionSkillRead: commands.some((command) => /skills[\\/]+task-(design|dev|test|ops)[\\/]+SKILL\.md/i.test(command)),
    worktreeClean: execFileSync("git", ["status", "--short"], { cwd: worktree, encoding: "utf8" }).trim() === "",
    facts,
    factsComplete: Object.values(facts).every(Boolean),
    actionSkillInjectedByPm: /\$task-(design|dev|test|ops)/.test(message),
  };
}

const runs = Object.fromEntries(Object.entries(runRoots).map(([name, root]) => [name, inspect(root)]));
const fixedAverageCharacters = Math.round((runs.fixedR1.characters + runs.fixedR2.characters) / 2);
const fixedAverageListLines = Math.round((runs.fixedR1.listLines + runs.fixedR2.listLines) / 2);
const failures = Object.entries(runs).flatMap(([name, run]) => [
  ...(!run.worktreeClean ? [`${name}:worktree-not-clean`] : []),
  ...(run.actionSkillRead ? [`${name}:pm-read-action-skill`] : []),
  ...(!run.factsComplete ? [`${name}:required-business-fact-missing`] : []),
]);
for (const name of ["fixedR1", "fixedR2"]) {
  if (runs[name].actionSkillInjectedByPm) failures.push(`${name}:pm-injected-action-skill`);
}
if (fixedAverageCharacters >= runs.currentBefore.characters) failures.push("fixed:not-shorter-than-current-before");
if (fixedAverageListLines >= runs.currentBefore.listLines) failures.push("fixed:list-not-shorter-than-current-before");

const summary = {
  createdAt: new Date().toISOString(),
  runs,
  comparison: {
    fixedAverageCharacters,
    fixedAverageListLines,
    reductionFromV305: 1 - fixedAverageCharacters / runs.v305.characters,
    reductionFromCurrentBefore: 1 - fixedAverageCharacters / runs.currentBefore.characters,
  },
  failures,
};

writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ comparison: summary.comparison, failures }, null, 2));
if (failures.length > 0) process.exit(1);
