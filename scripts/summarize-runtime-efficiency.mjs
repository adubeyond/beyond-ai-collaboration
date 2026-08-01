import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) {
  throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');
}

const evidenceRoot = join(runtimeRoot, 'evidence');
const casesRoot = join(runtimeRoot, 'cases');
const skillsRoot = join(runtimeRoot, 'codex-home', 'skills');
const timingsPath = join(evidenceRoot, 'run-timings.json');
const timings = existsSync(timingsPath)
  ? new Map(JSON.parse(readFileSync(timingsPath, 'utf8')).map((entry) => [entry.case, entry]))
  : new Map();
const caseDirectories = {
  I03: 'I03-discovery',
  R01: 'R01-direct',
  R02: 'R02-worker',
  'R05-explicit': 'R05-explicit-design',
  O01: 'O01-ops',
  R06: 'R06-pause',
  P01: 'P01-pm-healthy',
  P02: 'P02-pm-empty',
  P03: 'P03-pm-delegation',
};

function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}

const skillFiles = filesUnder(skillsRoot)
  .filter((path) => path.endsWith('.md'))
  .map((path) => ({
    key: relative(runtimeRoot, path).replaceAll('\\', '/').toLowerCase(),
    path,
    kind: path.replaceAll('\\', '/').includes('/references/') ? 'reference' : 'skill',
  }));

function parseEvents(path) {
  const commands = [];
  let usage = null;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'item.started' && event.item?.type === 'command_execution') {
      commands.push(event.item.command);
    }
    if (event.type === 'turn.completed') usage = event.usage;
  }
  return { commands, usage };
}

function normalizedCommand(command) {
  return command.replaceAll('\\', '/').replace(/\/{2,}/g, '/').toLowerCase();
}

const summaries = readdirSync(evidenceRoot)
  .filter((name) => name.endsWith('-events.jsonl'))
  .sort((left, right) => left.localeCompare(right, 'en'))
  .map((name) => {
    const caseName = name.slice(0, -'-events.jsonl'.length);
    const { commands, usage } = parseEvents(join(evidenceRoot, name));
    const normalized = commands.map(normalizedCommand);
    const reads = skillFiles.flatMap((entry) => {
      const count = normalized.filter((command) => command.includes(entry.key)).length;
      return count > 0 ? [{ ...entry, count }] : [];
    });
    const caseDirectory = caseDirectories[caseName];
    const automaticAgents = caseDirectory ? join(casesRoot, caseDirectory, 'AGENTS.md') : null;
    const uniqueBytes = reads.reduce((sum, entry) => sum + statSync(entry.path).size, 0);
    const totalBytes = reads.reduce((sum, entry) => sum + statSync(entry.path).size * entry.count, 0);
    return {
      case: caseName,
      commandCount: commands.length,
      skillMainReads: reads.filter((entry) => entry.kind === 'skill').reduce((sum, entry) => sum + entry.count, 0),
      referenceReads: reads.filter((entry) => entry.kind === 'reference').reduce((sum, entry) => sum + entry.count, 0),
      uniqueSkillFiles: reads.length,
      uniqueSkillBytes: uniqueBytes,
      totalSkillBytes: totalBytes,
      automaticAgentsBytes: automaticAgents && existsSync(automaticAgents) ? statSync(automaticAgents).size : null,
      usage,
      durationMs: timings.get(caseName)?.durationMs ?? null,
      files: reads.map((entry) => ({
        path: relative(skillsRoot, entry.path).replaceAll('\\', '/'),
        kind: entry.kind,
        reads: entry.count,
        bytes: statSync(entry.path).size,
      })),
    };
  });

console.log(JSON.stringify({ runtimeRoot: resolve(runtimeRoot), cases: summaries }, null, 2));
