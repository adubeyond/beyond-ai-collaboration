import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const outputPath = process.env.BEYOND_COMMS_SUMMARY;
const runRoots = {
  v305: process.env.BEYOND_COMMS_V305_ROOT,
  currentBefore: process.env.BEYOND_COMMS_CURRENT_BEFORE_ROOT,
  fixedR1: process.env.BEYOND_COMMS_FIXED_R1_ROOT,
  fixedR2: process.env.BEYOND_COMMS_FIXED_R2_ROOT,
};

for (const [name, value] of Object.entries({ outputPath, ...runRoots })) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

function events(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function inspect(root) {
  const evidenceRoot = join(root, "evidence");
  const finalMessage = readFileSync(join(evidenceRoot, "WST-PM-COMMS-last-message.txt"), "utf8").trim();
  const allEvents = events(join(evidenceRoot, "WST-PM-COMMS-events.jsonl"));
  const messages = allEvents
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text.trim());
  const commentary = messages.filter((message) => message !== finalMessage);
  const commands = allEvents
    .filter((event) => event.type === "item.completed" && event.item?.type === "command_execution")
    .map((event) => event.item.command ?? "");
  const caseRoot = join(root, "cases", "WST-PM-COMMS-status");
  const changed = execFileSync("git", ["-c", "core.quotepath=false", "diff", "--name-only"], { cwd: caseRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  const requiredFinalFacts = ["worker-site-b", "50/50", "终止公告", "进行中"];
  return {
    commentaryCount: commentary.length,
    commentaryCharacters: commentary.reduce((sum, message) => sum + [...message].length, 0),
    finalCharacters: [...finalMessage].length,
    finalFacts: Object.fromEntries(requiredFinalFacts.map((fact) => [fact, finalMessage.includes(fact)])),
    finalSelfContained: requiredFinalFacts.every((fact) => finalMessage.includes(fact)),
    actionSkillRead: commands.some((command) => /skills[\\/]+task-(design|dev|test|ops)[\\/]+SKILL\.md/i.test(command)),
    changedFiles: changed,
    onlyWorkbenchChanged: changed.length === 1 && changed[0].replaceAll("\\", "/").endsWith("docs/AI编程协同机制/当前工作台.md"),
  };
}

const runs = Object.fromEntries(Object.entries(runRoots).map(([name, root]) => [name, inspect(root)]));
const fixedAverageCommentaryCount = (runs.fixedR1.commentaryCount + runs.fixedR2.commentaryCount) / 2;
const fixedAverageCommentaryCharacters = Math.round(
  (runs.fixedR1.commentaryCharacters + runs.fixedR2.commentaryCharacters) / 2,
);
const failures = Object.entries(runs).flatMap(([name, run]) => [
  ...(!run.finalSelfContained ? [`${name}:final-not-self-contained`] : []),
  ...(run.actionSkillRead ? [`${name}:pm-read-action-skill`] : []),
  ...(!run.onlyWorkbenchChanged ? [`${name}:unexpected-file-change`] : []),
]);
if (fixedAverageCommentaryCount >= runs.currentBefore.commentaryCount) {
  failures.push("fixed:commentary-count-not-reduced");
}
if (fixedAverageCommentaryCharacters >= runs.currentBefore.commentaryCharacters) {
  failures.push("fixed:commentary-characters-not-reduced");
}

const summary = {
  createdAt: new Date().toISOString(),
  runs,
  comparison: {
    fixedAverageCommentaryCount,
    fixedAverageCommentaryCharacters,
    commentaryCharacterReductionFromV305: 1 - fixedAverageCommentaryCharacters / runs.v305.commentaryCharacters,
    commentaryCharacterReductionFromCurrentBefore: 1 - fixedAverageCommentaryCharacters / runs.currentBefore.commentaryCharacters,
  },
  failures,
};

writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ comparison: summary.comparison, failures }, null, 2));
if (failures.length > 0) process.exit(1);
