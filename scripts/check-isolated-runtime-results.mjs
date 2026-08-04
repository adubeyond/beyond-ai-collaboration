import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const sourceCodexHome = process.env.BEYOND_SOURCE_CODEX_HOME;
const liveProjectRoot = process.env.BEYOND_LIVE_PROJECT_ROOT;
const caseRuntimeRoots = JSON.parse(process.env.BEYOND_CASE_RUNTIME_ROOTS ?? '{}');
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

function runtimeForCase(caseName) {
  const root = caseRuntimeRoots[caseName] ?? runtimeRoot;
  if (!isAbsolute(root)) throw new Error(`case runtime root must be absolute: ${caseName}`);
  return root;
}

function caseDirectory(caseName, directory) {
  return join(runtimeForCase(caseName), 'cases', directory);
}

function evidenceFile(caseName, suffix = 'last-message.txt') {
  return join(runtimeForCase(caseName), 'evidence', `${caseName}-${suffix}`);
}

function commands(caseName) {
  return text(join(runtimeForCase(caseName), 'evidence', `${caseName}-events.jsonl`))
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
  return text(join(runtimeForCase(caseName), 'evidence', `${caseName}-events.jsonl`))
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
for (const [caseName, root] of Object.entries(caseRuntimeRoots)) {
  if (JSON.stringify(skillManifest(join(root, 'codex-home', 'skills'))) !== JSON.stringify(installedNow)) {
    throw new Error(`case runtime Skills differ from the primary runtime: ${caseName}`);
  }
}
for (const removedPath of [
  ['task-dev', 'references', 'implementation-debugging-and-repair.md'],
  ['identity-pm', 'references', 'cross-task-coordination-and-review.md'],
  ['task-ops', 'references', 'git-worktree-and-resource-closeout.md'],
]) {
  check(`I-02 removed reference absent: ${removedPath.at(-1)}`, !existsSync(join(runtimeRoot, 'codex-home', 'skills', ...removedPath)));
}

const discovery = text(evidenceFile('I03'));
check('I-03 all six Skills discovered', skills.every((skill) => discovery.includes(skill)));

const r01 = caseDirectory('R01', 'R01-direct');
check('R-01 only target files changed', git(r01, 'diff', '--name-only').split(/\r?\n/).sort().join('|') === 'src/calc.js|test/calc.test.js');
check('R-01 no Git commit', git(r01, 'rev-list', '--count', 'HEAD') === '1');
check('R-01 no worktree created', git(r01, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length === 1);

const r02 = join(runtimeForCase('R02'), 'cases', 'R02-worker');
check('R-02 task commit exact', git(r02, 'show', '--format=', '--name-only', 'HEAD').trim() === 'src/normalizeLabel.js');
check('R-02 unrelated dirty change preserved', git(r02, 'status', '--short').trim() === 'M notes/unrelated.txt');
const r02Commands = commands('R02').join('\n');
const r02CommandsNormalized = r02Commands.replace(/[\\/]+/g, '/');
const r02RouteIsExplicit = text(join(repositoryRoot, 'scripts', 'run-isolated-runtime-test.mjs')).includes('prompt: `$identity-worker $task-dev\\n');
check('R-02 explicit Worker and development route stays in one task', r02RouteIsExplicit && /node --test (?:\.\/)?test\/normalizeLabel\.test\.js/.test(r02CommandsNormalized) && r02CommandsNormalized.includes('npm test') && !r02CommandsNormalized.includes('identity-pm'));
check('R-02 local commit does not load ops', !r02Commands.includes('task-ops'));

const r05 = caseDirectory('R05-explicit', 'R05-explicit-design');
const r05Commands = commands('R05-explicit').join('\n');
check('R-05 design-dev-test chain loaded', ['identity-worker', 'task-design', 'task-dev', 'task-test'].every((name) => r05Commands.includes(name)));
check('R-05 avoids PM and ops', !r05Commands.includes('identity-pm') && !r05Commands.includes('task-ops'));
check('R-05 clean exact delivery', git(r05, 'status', '--short') === '' && git(r05, 'show', '--format=', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean).sort().join('|') === 'src/orderSummary.js|src/pricing.js|test/orderSummary.test.js');

const d01 = caseDirectory('D01', 'D01-design-correction');
const d01Design = text(join(d01, 'docs', 'design', 'jilin-collector.md'));
const d01Commands = commands('D01').join('\n').replaceAll('\\', '/');
const d01Output = text(evidenceFile('D01'));
check('D-01 loads Worker, design Skill and complex-design reference', ['identity-worker', 'task-design', 'complex-design-document-and-implementation.md'].every((name) => d01Commands.includes(name)));
check('D-01 stays in design without PM or downstream Skills', ['identity-pm', 'task-dev', 'task-test', 'task-ops'].every((name) => !d01Commands.includes(name)));
check('D-01 updates only the existing active design', git(d01, 'diff', '--name-only').trim().replaceAll('\\', '/') === 'docs/design/jilin-collector.md' && git(d01, 'rev-list', '--count', 'HEAD') === '1');
check('D-01 separates investigation evidence from implementation', /((接口|API|内部 JSON).{0,40}(不得|禁止|不作为|不使用|不采用)|(不得|禁止|不作为|不使用|不采用).{0,40}(接口|API|内部 JSON))/i.test(d01Design));
check('D-01 preserves business identity and use boundaries', /(顶级|一级)站点/.test(d01Design) && /最新.{0,30}历史|历史.{0,30}最新/.test(d01Design) && /(同一|共用|复用).{0,20}(机制|链路|采集)/.test(d01Design) && /(只|仅).{0,8}(写入|进入|入).{0,8}(来源库|源库)/.test(d01Design) && /(不.{0,4}展示|禁止.{0,8}展示|展示.{0,12}(关闭|另行))/i.test(d01Design));
check('D-01 gives implementation, test, release and rollback paths', ['实现', '测试', '发布', '回退'].every((name) => d01Design.includes(name)));
check('D-01 states current behavior is unchanged', /当前用户页面.{0,12}(系统业务流程|业务流程|业务操作).{0,8}(尚未|没有|未).{0,4}变化/.test(`${d01Design}\n${d01Output}`));
check('D-01 final response is a short pointer, not duplicated design', d01Output.includes('docs/design/jilin-collector.md') && d01Output.length < 1800, `chars=${d01Output.length}`);

const r07 = caseDirectory('R07', 'R07-method-priority');
check('R-07 direct-evidence fix commits only source', git(r07, 'show', '--format=', '--name-only', 'HEAD').trim() === 'src/formatCode.js');
check('R-07 existing test remains unchanged', git(r07, 'diff', 'HEAD^', 'HEAD', '--name-only', '--', 'test').trim() === '');
check('R-07 no worktree created', git(r07, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length === 1);
const r07Commands = commands('R07').join('\n');
check('R-07 keeps control in Worker', r07Commands.includes('identity-worker') && r07Commands.includes('task-dev') && !r07Commands.includes('identity-pm') && !r07Commands.includes('task-ops'));
check('R-07 avoids review-helper-worktree control paths', !/cross-task-coordination|collaboration-and-rework|worktree\s+add|reviewer/i.test(r07Commands));
const r07TestRuns = (r07Commands.match(/npm test/g) ?? []).length;
check('R-07 uses bounded result-oriented test runs', r07TestRuns >= 1 && r07TestRuns <= 2, `runs=${r07TestRuns}`);
check('R-07 completes instead of pausing for method gates', !text(evidenceFile('R07')).includes('已暂停'));

const r08 = caseDirectory('R08', 'R08-production-baseline');
const r08Commands = commands('R08').join('\n').replaceAll('\\', '/');
const explicitDevelopmentRoutes = text(join(repositoryRoot, 'scripts', 'run-isolated-runtime-test.mjs')).match(/prompt: `\$identity-worker \$task-dev\\n/g) ?? [];
const r08Changed = git(r08, 'diff', '--name-only', 'production-v1..HEAD').split(/\r?\n/).filter(Boolean).sort();
check('R-08 creates the authorized hotfix branch from production baseline', git(r08, 'branch', '--show-current') === 'codex/hotfix-production-v1' && git(r08, 'merge-base', '--is-ancestor', 'production-v1', 'HEAD') === '');
check('R-08 excludes the unrelated next-release file', !existsSync(join(r08, 'src', 'unrelated-next-release.js')));
check('R-08 exact delivery changes the shared source and only related tests', r08Changed.includes('src/companyRelations.js') && r08Changed.includes('test/companyRelations.test.js') && r08Changed.every((path) => ['src/companyRelations.js', 'test/companyRelations.test.js', 'test/companyExport.test.js'].includes(path)), r08Changed.join('|'));
check('R-08 runs target and adjacent-consumer regression', r08Commands.includes('npm test') || (r08Commands.includes('companyRelations.test.js') && r08Commands.includes('companyExport.test.js')));
check('R-08 explicitly starts Worker and development method without PM or ops', explicitDevelopmentRoutes.length >= 2 && !r08Commands.includes('identity-pm') && !r08Commands.includes('task-ops/SKILL.md'));
check('R-08 leaves a clean committed candidate', git(r08, 'status', '--short') === '' && git(r08, 'rev-list', '--count', 'production-v1..HEAD') === '1');
check('R-08 does not create a worktree', git(r08, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length === 1);
check('R-08 resulting production-baseline candidate passes all tests', execFileSync(process.execPath, ['--test'], { cwd: r08, encoding: 'utf8' }).includes('pass'));

const r09 = caseDirectory('R09', 'R09-test-denominator');
const r09Commands = commands('R09').join('\n').replaceAll('\\', '/');
const r09Results = commandResults('R09');
const r09Output = text(evidenceFile('R09'));
check('R-09 runs offline, scoped, live-boundary and global-gate evidence', ['npm test', 'check-task-candidate.mjs', 'check-live-canary.mjs', 'check-global-gate.mjs'].every((value) => r09Commands.includes(value)));
check('R-09 preserves the complete three-category denominator', /3\s*\/\s*3|三类.{0,24}(全部|尝试|真实路径)|总数.{0,12}3|分母.{0,8}3|attempted.{0,8}3/i.test(r09Output) && (/2\s*\/\s*3|2.{0,8}(通过|成功).{0,12}1.{0,8}(失败|不通过)|passed.{0,8}2.{0,16}failed.{0,8}1/i.test(r09Output) || ['notice', 'result', 'detail'].every((name) => r09Output.includes(name)) && /detail.{0,24}(失败|不通过)/i.test(r09Output)));
check('R-09 does not let offline green override the failed live boundary', /离线|单元|npm test/.test(r09Output) && /不通过/.test(r09Output) && /detail|详情/.test(r09Output));
check('R-09 separates task candidate from the non-green global gate', /任务候选|局部|范围/.test(r09Output) && /全仓|全局/.test(r09Output) && /(仍|保持).{0,8}(失败|非绿|不通过)|全仓.{0,16}(失败|非绿|不通过)/.test(r09Output));
check('R-09 same Worker testing is not independent testing', /(不是|不算|不构成|不得称为|不称为).{0,12}独立测试|独立测试.{0,12}(不是|不算|不构成)/.test(r09Output));
check('R-09 remains read-only and does not pause the business task', git(r09, 'status', '--short') === '' && !r09Output.includes('已暂停'));
check('R-09 captures the expected mixed exit codes', r09Results.some((result) => result.command.includes('check-task-candidate.mjs') && effectiveExitCode(result) === 0) && r09Results.some((result) => result.command.includes('check-live-canary.mjs') && effectiveExitCode(result) === 1) && r09Results.some((result) => result.command.includes('check-global-gate.mjs') && effectiveExitCode(result) === 1));

const ops = caseDirectory('O01', 'O01-ops');
const opsCommandsText = commands('O01').join('\n').replaceAll('\\', '/');
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
check('O-04 production path does not return to PM', !opsCommandsText.includes('identity-pm'));
for (const relativePath of [
  'task-ops/SKILL.md',
  'task-ops/references/capability-and-runbook.md',
  'task-ops/references/production-release-and-convergence.md',
  'task-ops/references/incident-recovery-and-evidence.md',
]) {
  const reads = opsCommandsText.split(relativePath).length - 1;
  check(`O-04 production path reads ${relativePath} at most once`, reads <= 1, `reads=${reads}`);
}

const sshFacts = caseDirectory('O02', 'O02-ssh-facts');
const sshCommandList = commands('O02');
const sshCommandsText = sshCommandList.join('\n').replace(/[\\/]+/g, '/');
const sshOutput = text(evidenceFile('O02'));
const explicitOpsRoutes = text(join(repositoryRoot, 'scripts', 'run-isolated-runtime-test.mjs')).match(/prompt: `\$identity-worker \$task-ops\\n/g) ?? [];
check('O-05 SSH conflict explicitly starts Worker and ops method, then reads runbook rule', explicitOpsRoutes.length >= 3 && sshCommandsText.includes('task-ops/references/capability-and-runbook.md') && !sshCommandsText.includes('identity-pm'));
check('O-05 resolves the exact canonical SSH alias locally', sshCommandList.some((command) => /\bssh(?:\.exe)?\s/.test(command) && /\s-F\s+[^\r\n]*ssh_config/i.test(command) && /\s-G\b/.test(command) && /\blc-SA5212M5\b/.test(command)));
check('O-05 selects configured host and account', sshOutput.includes('lc-SA5212M5') && sshOutput.includes('192.0.2.100') && /\blc\b/.test(sshOutput));
check('O-05 reuses existing identity entry instead of asking for password', /IdentityFile|密钥|私钥|凭据入口/.test(sshOutput) && /(不需要|无需|不应|不能).*密码/.test(sshOutput));
check('O-05 does not accept either stale IP as the current target', !/当前[^。\n]*(192\.0\.2\.112|198\.51\.100\.195)/.test(sshOutput));
const sshInvocations = sshCommandList.filter((command) => /-Command\s+["']?ssh(?:\.exe)?\s/i.test(command));
check('O-05 remains read-only and offline', git(sshFacts, 'status', '--short') === '' && sshInvocations.length > 0 && sshInvocations.every((command) => /\s-G\b|\s-V\b/i.test(command)));

const paused = text(evidenceFile('R06'));
check('R-06 true external gap pauses once', paused.includes('已暂停') && paused.includes('唯一暂停原因') && paused.includes('恢复所需最小条件'));
check('R-06 read-only pause leaves fixture clean', git(caseDirectory('R06', 'R06-pause'), 'status', '--short') === '');

const p01 = caseDirectory('P01', 'P01-pm-healthy');
const p01Commands = commands('P01').join('\n');
const p01Output = text(evidenceFile('P01'));
check('P-01 healthy takeover applies PM identity and reads workbench', p01Output.includes('PM') && p01Commands.includes('当前工作台.md'));
check('P-01 healthy takeover skips document-governance entry', !p01Commands.includes('00-模板入口.md'));
check('P-01 healthy takeover remains read-only', git(p01, 'status', '--short') === '');

const p02 = caseDirectory('P02', 'P02-pm-empty');
const p02Commands = commands('P02').join('\n');
const p02Output = text(evidenceFile('P02'));
check('P-02 empty takeover enters document governance', p02Output.includes('PM') && p02Commands.includes('当前工作台.md') && p02Commands.includes('00-模板入口.md'));
check('P-02 empty takeover remains read-only', git(p02, 'status', '--short') === '');

const p03 = caseDirectory('P03', 'P03-pm-delegation');
const p03Commands = commands('P03').join('\n');
const p03Output = text(evidenceFile('P03'));
check('P-03 PM delegation does not load development Skill', !p03Commands.includes('task-dev'));
check('P-03 PM delegation does not implement', git(p03, 'status', '--short') === '');
check('P-03 explicit team request needs no second confirmation', /(直接|立即).*(建立|创建)|无需.*确认|不再.*确认|不需要.*询问|不必.*询问/.test(p03Output));
check('P-03 task packet stays at business contract level', ['业务结果', '范围', '验收'].every((name) => p03Output.includes(name)));

const p04 = caseDirectory('P04', 'P04-document-migration');
const p04Commands = commands('P04').join('\n').replace(/[\\/]+/g, '/');
const p04Output = text(evidenceFile('P04'));
check('P-04 reads both legacy and migrated nested entries', p04Commands.includes('legacy-module/AGENTS.md') && p04Commands.includes('migrated-module/AGENTS.md'));
check('P-04 preserves project facts and removes old gates', p04Output.includes('保留') && /迁出|移除/.test(p04Output) && p04Output.includes('工作台') && /固定阶段|阶段门禁/.test(p04Output));
check('P-04 keeps migration out of ordinary task path', /普通.*不.*重复|普通.*无需.*重复|不进入.*普通/.test(p04Output));
check('P-04 does not load Action Skills', ['task-design', 'task-dev', 'task-test', 'task-ops'].every((name) => !p04Commands.includes(name)));
check('P-04 remains read-only', git(p04, 'status', '--short') === '');

const p05 = caseDirectory('P05', 'P05-checkpoint-resume');
const p05Commands = commands('P05').join('\n');
const p05Output = text(evidenceFile('P05'));
const runtimeDriver = text(join(repositoryRoot, 'scripts', 'run-isolated-runtime-test.mjs'));
const p05ExplicitPmRoute = /name:\s*'P05'[\s\S]{0,240}prompt:\s*`使用\$identity-pm/.test(runtimeDriver);
check('P-05 checkpoint route explicitly starts PM and reads workbench', p05ExplicitPmRoute && p05Commands.includes('当前工作台.md'));
check('P-05 resumes the registered Worker', p05Output.includes('worker-design-001') && /恢复|继续|原.*Worker|同一.*Worker/.test(p05Output));
check('P-05 does not create an implementation Worker', /(不需要|无需|不得|不应|不能).{0,24}(新建|建立|创建|第二个).{0,12}(Worker|任务)/.test(p05Output));
check('P-05 remains read-only', git(p05, 'status', '--short') === '');

const p06 = caseDirectory('P06', 'P06-candidate-isolation');
const p06Commands = commands('P06').join('\n');
const p06Output = text(evidenceFile('P06'));
check('P-06 candidate isolation reads workbench and cross-task mechanism', p06Commands.includes('当前工作台.md') && p06Commands.includes('03-跨任务协同与共享对象机制.md'));
check('P-06 keeps the proposal unconfirmed', /候选|讨论|尚未确认|待.*确认|确认前/.test(p06Output));
check('P-06 does not change active task control before confirmation', /(不能|不得|不应|不可以|无需).{0,28}(强制前置|撤销|暂停|改变)/.test(p06Output));
check('P-06 asks for the missing business decision', /确认|决定/.test(p06Output));
check('P-06 remains read-only', git(p06, 'status', '--short') === '');

for (const caseName of ['I03', 'R01', 'R02', 'R05-explicit', 'D01', 'R07', 'R08', 'R09', 'O01', 'O02', 'R06', 'P01', 'P02', 'P03', 'P04', 'P05', 'P06']) {
  const joined = commands(caseName).join('\n').replaceAll('/', '\\').toLowerCase();
  const forbiddenRoots = [liveProjectRoot, join(sourceCodexHome, 'skills')]
    .filter(Boolean)
    .map((path) => resolve(path).replaceAll('/', '\\').toLowerCase());
  check(`${caseName} avoids live project/global Skill paths`, forbiddenRoots.every((path) => !joined.includes(path)));
}

const summary = {
  checkedAt: new Date().toISOString(),
  runtimeRoot,
  caseRuntimeRoots,
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
