import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const sourceCodexHome = process.env.BEYOND_SOURCE_CODEX_HOME;
const liveProjectRoot = process.env.BEYOND_LIVE_PROJECT_ROOT;
const writeSummary = process.argv.includes('--write-summary');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--write-summary');
if (!runtimeRoot || !isAbsolute(runtimeRoot) || !sourceCodexHome || !isAbsolute(sourceCodexHome)) {
  throw new Error('absolute BEYOND_ISOLATED_ROOT and BEYOND_SOURCE_CODEX_HOME are required');
}
if (unknownArguments.length > 0) {
  throw new Error(`unknown arguments: ${unknownArguments.join(', ')}`);
}

const skills = ['identity-pm', 'identity-worker', 'task-design', 'task-dev', 'task-test', 'task-ops'];
const results = [];
const failures = [];

function check(name, condition, detail = '') {
  results.push({ name, passed: Boolean(condition), detail });
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  }).sort((a, b) => a.localeCompare(b, 'en'));
}

function manifest(root) {
  return filesUnder(root).map((path) => ({
    path: relative(root, path).replaceAll('\\', '/'),
    bytes: statSync(path).size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }));
}

function skillManifest(root) {
  return skills.flatMap((skill) => manifest(join(root, skill)).map((entry) => ({ skill, ...entry })));
}

function text(path) {
  return readFileSync(path, 'utf8');
}

function commands(caseName) {
  return text(join(runtimeRoot, 'evidence', `${caseName}-events.jsonl`))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === 'item.started' && event.item?.type === 'command_execution'
          ? [event.item.command]
          : [];
      } catch {
        return [];
      }
    });
}

function commandResults(caseName) {
  return text(join(runtimeRoot, 'evidence', `${caseName}-events.jsonl`))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === 'item.completed' && event.item?.type === 'command_execution'
          ? [{
              command: event.item.command,
              exitCode: event.item.exit_code,
              output: event.item.aggregated_output ?? '',
            }]
          : [];
      } catch {
        return [];
      }
    });
}

function effectiveExitCode(result) {
  const reported = [...result.output.matchAll(/(?:^|\r?\n)EXIT:(\d+)(?=\r?$)/gm)].at(-1)?.[1];
  return reported === undefined ? result.exitCode : Number(reported);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const evidenceRoot = join(runtimeRoot, 'evidence');
const casesRoot = join(runtimeRoot, 'cases');
const before = JSON.parse(text(join(evidenceRoot, 'global-skills-before.json')));
const globalAfter = skillManifest(join(sourceCodexHome, 'skills'));
check('I-01 global Skills unchanged', JSON.stringify(before) === JSON.stringify(globalAfter));

const candidateNow = skillManifest(join(repositoryRoot, '模板交付包', 'skills'));
const installedNow = skillManifest(join(runtimeRoot, 'codex-home', 'skills'));
check('I-02 isolated install matches candidate', JSON.stringify(candidateNow) === JSON.stringify(installedNow));

const discovery = text(join(evidenceRoot, 'I03-last-message.txt'));
check('I-03 all six Skills discovered', skills.every((skill) => discovery.includes(skill)));

const r01 = join(casesRoot, 'R01-direct');
check('R-01 only target files changed', git(r01, 'diff', '--name-only').split(/\r?\n/).sort().join('|') === 'src/calc.js|test/calc.test.js');
check('R-01 no Git commit', git(r01, 'rev-list', '--count', 'HEAD') === '1');
check('R-01 no worktree created', git(r01, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length === 1);

const r02 = join(casesRoot, 'R02-worker');
check('R-02 task commit exact', git(r02, 'show', '--format=', '--name-only', 'HEAD').trim() === 'src/normalizeLabel.js');
check('R-02 unrelated dirty change preserved', git(r02, 'status', '--short').trim() === 'M notes/unrelated.txt');
const r02Commands = commands('R02').join('\n');
check('R-02 dev and test loaded', r02Commands.includes('task-dev') && r02Commands.includes('task-test'));
check('R-02 local commit does not load ops', !r02Commands.includes('task-ops'));

const r05 = join(casesRoot, 'R05-explicit-design');
const r05Commands = commands('R05-explicit').join('\n');
check('R-05 design-dev-test chain loaded', ['identity-worker', 'task-design', 'task-dev', 'task-test'].every((name) => r05Commands.includes(name)));
check('R-05 avoids PM and ops', !r05Commands.includes('identity-pm') && !r05Commands.includes('task-ops'));
check('R-05 clean exact delivery', git(r05, 'status', '--short') === '' && git(r05, 'show', '--format=', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean).sort().join('|') === 'src/orderSummary.js|src/pricing.js|test/orderSummary.test.js');

const ops = join(casesRoot, 'O01-ops');
const finalApi = JSON.parse(text(join(ops, 'runtime', 'current', 'api.json')));
const finalAdjacent = JSON.parse(text(join(ops, 'runtime', 'current', 'adjacent.json')));
check('O-01/O-02/O-03 final runtime is verified v2', finalApi.version === 'v2' && finalApi.feature === 'fixed' && finalAdjacent.version === 'v2' && finalAdjacent.adjacent === 'preserved');
check('O-01 legacy target untouched', git(ops, 'diff', '--exit-code', 'HEAD', '--', 'runtime/legacy') === '');
const opsResults = commandResults('O01');
const badDeployIndex = opsResults.findIndex((result) => result.command.includes('deploy.mjs artifacts/v3-bad') && effectiveExitCode(result) === 0);
const rollbackIndex = opsResults.findIndex((result, index) => index > badDeployIndex && result.command.includes('rollback.mjs') && effectiveExitCode(result) === 0);
const badBusinessFailed = opsResults.slice(badDeployIndex + 1, rollbackIndex)
  .some((result) => result.command.includes('business.mjs') && effectiveExitCode(result) === 1);
const postRollback = opsResults.slice(rollbackIndex + 1);
const postRollbackHealthy = postRollback.some((result) => result.command.includes('health.mjs') && effectiveExitCode(result) === 0)
  && postRollback.some((result) => result.command.includes('business.mjs') && effectiveExitCode(result) === 0);
const runtimeState = JSON.parse(text(join(ops, 'runtime', 'current', 'runtime-state.json')));
check('O-03 controlled failure and rollback executed', badDeployIndex >= 0 && rollbackIndex > badDeployIndex && badBusinessFailed && postRollbackHealthy && runtimeState.version === 'v2' && runtimeState.rolledBack === true);

const paused = text(join(evidenceRoot, 'R06-last-message.txt'));
check('R-06 true external gap pauses once', paused.includes('已暂停') && paused.includes('唯一暂停原因') && paused.includes('恢复所需最小条件'));
check('R-06 read-only pause leaves fixture clean', git(join(casesRoot, 'R06-pause'), 'status', '--short') === '');

const p01 = join(casesRoot, 'P01-pm-healthy');
const p01Commands = commands('P01').join('\n');
const p01Output = text(join(evidenceRoot, 'P01-last-message.txt'));
check('P-01 healthy takeover applies PM identity and reads workbench', p01Output.includes('PM') && p01Commands.includes('当前工作台.md'));
check('P-01 healthy takeover skips document-governance entry', !p01Commands.includes('00-模板入口.md'));
check('P-01 healthy takeover remains read-only', git(p01, 'status', '--short') === '');

const p02 = join(casesRoot, 'P02-pm-empty');
const p02Commands = commands('P02').join('\n');
const p02Output = text(join(evidenceRoot, 'P02-last-message.txt'));
check('P-02 empty takeover enters document governance', p02Output.includes('PM') && p02Commands.includes('当前工作台.md') && p02Commands.includes('00-模板入口.md'));
check('P-02 empty takeover remains read-only', git(p02, 'status', '--short') === '');

const p03 = join(casesRoot, 'P03-pm-delegation');
const p03Commands = commands('P03').join('\n');
check('P-03 PM delegation does not load development Skill', !p03Commands.includes('task-dev'));
check('P-03 PM delegation does not implement', git(p03, 'status', '--short') === '');

for (const caseName of ['I03', 'R01', 'R02', 'R05-explicit', 'O01', 'R06', 'P01', 'P02', 'P03']) {
  const joined = commands(caseName).join('\n').replaceAll('/', '\\').toLowerCase();
  const forbiddenRoots = [liveProjectRoot, join(sourceCodexHome, 'skills')]
    .filter(Boolean)
    .map((path) => resolve(path).replaceAll('/', '\\').toLowerCase());
  check(`${caseName} avoids live project/global Skill paths`, forbiddenRoots.every((path) => !joined.includes(path)));
}

const summary = {
  checkedAt: new Date().toISOString(),
  runtimeRoot,
  assertions: results.length,
  passed: results.filter((result) => result.passed).length,
  failed: failures.length,
  results,
  failures,
};
if (writeSummary) {
  writeFileSync(join(evidenceRoot, 'final-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

if (failures.length) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
console.log(`isolated runtime acceptance passed: ${summary.passed}/${summary.assertions}${writeSummary ? '; summary updated' : '; read-only check'}`);
