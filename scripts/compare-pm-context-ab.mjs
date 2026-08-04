import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const baselineRoot = process.env.BEYOND_AB_BASELINE_ROOT;
const currentRoot = process.env.BEYOND_AB_CURRENT_ROOT;
const outputPath = process.env.BEYOND_AB_OUTPUT;

for (const [name, value] of Object.entries({ baselineRoot, currentRoot, outputPath })) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

const cases = [
  {
    name: "WST-AB-Q1",
    directory: "WST-AB-Q1-design",
    requiredFacts: ["关键词订阅", "Worker"],
    directDecision: /建立|安排|派发/,
    blockingClarification: /先确认是否指当前主线|先确认.*关键词订阅/,
  },
  {
    name: "WST-AB-Q2",
    directory: "WST-AB-Q2-develop",
    requiredFacts: ["关键词订阅", "worker-keyword-subscription"],
    directDecision: /恢复.*worker-keyword-subscription|worker-keyword-subscription.*继续/si,
    blockingClarification: /需要先确认.*(?:功能|主线)|先说明.*(?:功能|主线)/,
  },
  {
    name: "WST-AB-Q3",
    directory: "WST-AB-Q3-release",
    requiredFacts: ["worker-keyword-subscription", "v1.4.0", "sim-test-a"],
    directDecision: /恢复.*worker-keyword-subscription/si,
    blockingClarification: /请.*(?:提供|确认).*(?:版本|环境|服务器|授权)|需要.*(?:版本|环境|服务器|授权)/,
  },
  {
    name: "WST-AB-Q4",
    directory: "WST-AB-Q4-bugfix",
    requiredFacts: ["关键词订阅", "刷新", "Worker"],
    directDecision: /建立.*(?:修复|Worker)|交给.*Worker/si,
    blockingClarification: /请.*(?:提供|说明).*(?:现象|复现|报错|预期)|需要先.*(?:现象|复现|报错|预期)/,
  },
];

function gitStatus(path) {
  return execFileSync("git", ["status", "--short"], { cwd: path, encoding: "utf8" }).trim();
}

function readEvents(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function measure(root, testCase) {
  const evidenceRoot = join(root, "evidence");
  const messagePath = join(evidenceRoot, `${testCase.name}-last-message.txt`);
  const eventsPath = join(evidenceRoot, `${testCase.name}-events.jsonl`);
  if (!existsSync(messagePath) || !existsSync(eventsPath)) {
    throw new Error(`missing evidence for ${testCase.name} under ${root}`);
  }
  const message = readFileSync(messagePath, "utf8").trim();
  const events = readEvents(eventsPath);
  const commands = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "command_execution")
    .map((event) => event.item.command ?? "");
  const facts = Object.fromEntries(testCase.requiredFacts.map((fact) => [fact, message.includes(fact)]));
  return {
    message,
    characters: [...message].length,
    paragraphs: message.split(/\r?\n\s*\r?\n/).filter(Boolean).length,
    questionMarks: (message.match(/[？?]/g) ?? []).length,
    facts,
    allRequiredFactsUsed: Object.values(facts).every(Boolean),
    directDecision: testCase.directDecision.test(message),
    blockingClarification: testCase.blockingClarification.test(message),
    actionSkillRead: commands.some((command) => /skills[\\/]+task-(design|dev|test|ops)[\\/]+SKILL\.md/i.test(command)),
    commandCount: commands.length,
    worktreeClean: gitStatus(join(root, "cases", testCase.directory)) === "",
  };
}

function collect(root) {
  return Object.fromEntries(cases.map((testCase) => [testCase.name, measure(root, testCase)]));
}

const baseline = collect(baselineRoot);
const current = collect(currentRoot);
const aggregate = (results) => ({
  totalCharacters: Object.values(results).reduce((sum, result) => sum + result.characters, 0),
  totalCommands: Object.values(results).reduce((sum, result) => sum + result.commandCount, 0),
  factCompleteCases: Object.values(results).filter((result) => result.allRequiredFactsUsed).length,
  directDecisionCases: Object.values(results).filter((result) => result.directDecision).length,
  blockingClarificationCases: Object.values(results).filter((result) => result.blockingClarification).length,
  actionSkillReadCases: Object.values(results).filter((result) => result.actionSkillRead).length,
  cleanCases: Object.values(results).filter((result) => result.worktreeClean).length,
});

const summary = {
  createdAt: new Date().toISOString(),
  baselineRoot,
  currentRoot,
  baseline: { aggregate: aggregate(baseline), cases: baseline },
  current: { aggregate: aggregate(current), cases: current },
  verdict: {
    invariantFailures: [baseline, current].flatMap((results, versionIndex) =>
      Object.entries(results).flatMap(([name, result]) => [
        ...(!result.worktreeClean ? [`version${versionIndex + 1}:${name}:worktree-not-clean`] : []),
        ...(result.actionSkillRead ? [`version${versionIndex + 1}:${name}:action-skill-read`] : []),
      ]),
    ),
    comparisonOnly: "Single-run behavioral comparison; repeat before attributing a stochastic response difference to the mechanism.",
  },
};

writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
  baseline: summary.baseline.aggregate,
  current: summary.current.aggregate,
  invariantFailures: summary.verdict.invariantFailures,
}, null, 2));
