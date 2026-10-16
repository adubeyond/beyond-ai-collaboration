// Explicit paid-provider test of current documents, not a Desktop callback test.
// Runs only new isolated sessions and never changes shared profiles or credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launchCliRequest, readProfile } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { CliTaskStore, atomicJson, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';

const option = name => {
  const at = process.argv.indexOf('--' + name);
  if (at < 0) return null;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error('--' + name + ' requires a value');
  return value;
};
const originalProfilePath = option('profile');
if (!originalProfilePath || !process.argv.includes('--allow-live-model')) throw new Error('Explicit --profile <file> --allow-live-model required');
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skillPath = path.join(repoRoot, '模板交付包/skills/task-dev/SKILL.md');
const originalProfile = JSON.parse(fs.readFileSync(path.resolve(originalProfilePath), 'utf8'));
const provider = originalProfile.provider ?? 'codex';
const coldResume = process.argv.includes('--cold-resume');
if (coldResume && provider !== 'codex') throw new Error('--cold-resume is Codex-only');
if (!['codex', 'claude', 'zcode'].includes(provider)) throw new Error('Expected one of codex, claude, zcode');
const profileKeys = provider === 'codex'
  ? ['schemaVersion', 'runner', 'codexHome', 'model', 'mode', 'effort', 'ui']
  : provider === 'claude'
    ? ['schemaVersion', 'provider', 'runner', 'model', 'effort', 'mode', 'ui', 'permissionMode']
    : ['schemaVersion', 'provider', 'runner', 'packageRoot', 'model', 'effort', 'mode', 'ui'];
assert.ok(Object.keys(originalProfile).every(key => profileKeys.includes(key)), 'Refuse copying credentials or undocumented profile fields');
assert.ok(Object.keys(originalProfile.runner ?? {}).every(key => ['command', 'args'].includes(key)), 'Refuse copying undocumented runner fields');
assert.ok(Array.isArray(originalProfile.runner?.args) && originalProfile.runner.args.every(value => typeof value === 'string' && !/(?:api[_-]?key|auth|provider|--config|--prompt|--json|--last|--resume|--ephemeral)/i.test(value)), 'Refuse copying credentials or runtime overrides in runner arguments');
// Validate ordinary profiles before creating a project. A stale Codex executable
// can be overridden explicitly in the private copy, never in shared settings.
const privateProfile = structuredClone(originalProfile);
if (option('codex-executable')) {
  if (provider !== 'codex') throw new Error('--codex-executable is Codex-only');
  privateProfile.runner = { ...privateProfile.runner, command: path.resolve(option('codex-executable')) };
}
assert.equal(privateProfile.mode, 'interactive', 'This test must exercise the native interactive adapter');
const requestedOutput = option('output');
const root = requestedOutput ? path.resolve(requestedOutput) : fs.mkdtempSync(path.join(os.tmpdir(), `beyond-${provider}-documents-`));
if (requestedOutput) {
  assert.equal(fs.existsSync(root), false, 'Output must be a new, unique directory; no earlier evidence is overwritten');
  fs.mkdirSync(root, { recursive: true });
}
const profilePath = path.join(root, 'profile.json');
// The product profile validator rejects credentials and arbitrary overrides.
atomicJson(profilePath, privateProfile);
const profile = readProfile(profilePath);
const executionParent = option('execution-parent');
const executionRoot = executionParent
  ? fs.mkdtempSync(path.join(fs.realpathSync(executionParent), `beyond-${provider}-documents-`))
  : path.join(root, 'project');
const controlRoot = path.join(root, 'control');
const docsRoot = path.join(executionRoot, 'docs/current');
const archiveRoot = path.join(executionRoot, 'docs/archive');
const supportRoot = path.join(executionRoot, 'support');
for (const directory of [docsRoot, archiveRoot, supportRoot, path.join(controlRoot, 'local/projects')]) fs.mkdirSync(directory, { recursive: true });
const projectId = 'local-document-probe-' + provider;
const taskId = 'documents-' + crypto.randomBytes(6).toString('hex');
const ownerThreadId = 'isolated-document-probe-owner', ownerTurnId = 'isolated-document-probe-turn';
const agentsPath = path.join(executionRoot, 'AGENTS.md');
const requirementsPath = path.join(docsRoot, 'requirements.md');
const designPath = path.join(docsRoot, 'design.md');
const linkedPath = path.join(supportRoot, 'current-reference.md');
const originalProfileHash = sha256File(path.resolve(originalProfilePath));
const skillHash = sha256File(skillPath);
const token = prefix => prefix + '-' + crypto.randomBytes(7).toString('hex');
const projectCode = token('PROJECT');
const rounds = [1, 2].map(number => ({
  number, requirementRevision: `REQ-R${number}`, designRevision: `DESIGN-R${number}`,
  requiredLabel: token('LABEL'), sourceTable: token('TABLE'), linkedMarker: token('REFERENCE')
}));
fs.writeFileSync(path.join(controlRoot, 'local/projects', projectId + '.md'), `---\nid: ${projectId}\npath: ${executionRoot}\nhost_id: local\ncodex_project_id: isolated-document-probe\n---\n`);
fs.writeFileSync(agentsPath, `<!-- BEYOND-CONTROL-ROOT: ${controlRoot.replaceAll('\\', '/')} -->\n<!-- BEYOND-PROJECT-ID: ${projectId} -->\n# 隔离资料接入测试\n项目识别码：${projectCode}\n只读理解当前需求和设计，不开发、不提交、不发布。当前依据是 docs/current/requirements.md 与 docs/current/design.md。docs/archive 仅是历史记录，不得替代当前修订。只允许读取本测试目录及任务点名的 task-dev Skill 和确实需要的相对 reference；禁止读取凭据、其他项目、其他会话。不要联网执行命令、安装依赖或手动发送回调。\n`);
function writeCurrent(item) {
  fs.writeFileSync(requirementsPath, `# 公告筛选需求\n状态：已确认，当前有效\n修订：${item.requirementRevision}\n交付：公告列表增加一个来源分类下拉框；当前界面标签必须为 ${item.requiredLabel}。本轮仅确认业务与技术依据，不开发。\n`);
  fs.writeFileSync(designPath, `# 公告筛选技术设计\n状态：已确认，当前有效\n修订：${item.designRevision}\n需求依据：[当前需求](requirements.md)\n来源分类从当前数据表 ${item.sourceTable} 读取；不得把选项硬编码在页面。\n关联资料：[来源分类约定](../../support/current-reference.md)。需要读取该文件核对关联标识，链接以本设计文件所在目录为基准。\n`);
  fs.writeFileSync(linkedPath, `# 来源分类约定\n状态：当前有效\n本修订关联标识：${item.linkedMarker}\n此文件是设计中的相对链接，并未列在派单 factEntries 中；请实际读取它再报告关联标识。\n`);
}
writeCurrent(rounds[0]);
const binding = {
  projectId, taskId, ownerThreadId, ownerTurnId, taskMode: 'assist', executionRoot, profilePath,
  contract: {
    goal: '在同一原生 CLI 会话中准确理解当前公告筛选需求、技术设计和复用的开发 Skill，并在资料更新后纠正旧认识。',
    boundaries: `只读 ${executionRoot} 内文件，以及明确提供的 ${skillPath} 和其必要 reference。不得修改文件、执行 Git、访问凭据、其他项目或其他会话，不安装依赖、不执行网络命令，不手动发送回调。`,
    acceptance: '两轮分别依据当前资料回答；保留同一 sessionId；当前修订替代旧修订；能沿设计文件相对链接找到关联资料；准确引用现有 Skill 的开发约束。',
    factEntries: [requirementsPath, designPath], skillEntries: [skillPath]
  }
};
const store = new CliTaskStore({ controlRoot });
const context = { controlRoot, executionRoot, ownerThreadId, ownerTurnId };
const identity = { projectId, taskId, ownerThreadId };
let sessionId = null, latestRun = null;
const evidence = [];
let coldRestartEvidence = null;
atomicJson(path.join(root, 'probe.json'), {
  schemaVersion: 1, provider, createdAt: new Date().toISOString(), executionRoot, controlRoot,
  projectId, taskId, originalProfilePath: path.resolve(originalProfilePath), originalProfileHash,
  configuration: { model: profile.model, effort: profile.effort ?? null },
  skillPath, skillHash, expected: rounds, projectCode,
  coldResume, scope: 'current document context and same-session refresh; no real Desktop notification claim'
});
console.log(JSON.stringify({ provider, probeRoot: root, executionRoot, model: profile.model, rounds: 2, actualDesktopNotification: false }));

function waitFor(check, timeout = 240000) {
  return new Promise((resolve, reject) => {
    let timer, watcher;
    const finish = (error, value) => { clearTimeout(timer); watcher?.close(); error ? reject(error) : resolve(value); };
    const inspect = () => { try { const value = check(); if (value) finish(null, value); } catch (error) { finish(error); } };
    watcher = fs.watch(controlRoot, { recursive: true }, inspect);
    timer = setTimeout(() => finish(new Error('Native result timeout; evidence retained. No process was killed and no replacement session was started.')), timeout);
    inspect();
  });
}
function answerObject(text) {
  const stripped = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(stripped); } catch { throw new Error('Expected a JSON answer object; original final retained for inspection'); }
}
function normalized(file) { return path.resolve(file).replaceAll('\\', '/').toLowerCase(); }
function assertAnswer(answer, expected) {
  for (const key of ['requirementRevision', 'designRevision', 'requiredLabel', 'sourceTable', 'linkedMarker']) assert.equal(answer[key], expected[key], `Current document answer mismatch: ${key}`);
  assert.equal(answer.projectCode, projectCode, 'Root project entry was not used');
  assert.ok(Array.isArray(answer.devConstraints), 'Expected exact short quotations from the real development Skill');
  const constraints = answer.devConstraints.join('\n');
  assert.ok(constraints.includes('只读解释、代码定位和修改建议不会自动获得写入权'), 'Missing the Skill read-only authority constraint');
  assert.ok(constraints.includes('不静默覆盖用户或其他任务的变化'), 'Missing the Skill existing-change protection');
  assert.ok(Array.isArray(answer.sourcePaths), 'Expected the actual source file paths');
  const cited = new Set(answer.sourcePaths.filter(x => typeof x === 'string').map(normalized));
  for (const required of [agentsPath, requirementsPath, designPath, linkedPath, skillPath]) assert.ok(cited.has(normalized(required)), 'Missing source path: ' + required);
  if (expected.number === 2) {
    const current = JSON.stringify(answer);
    for (const key of ['requiredLabel', 'sourceTable', 'linkedMarker']) assert.ok(!current.includes(rounds[0][key]), 'Stale first-round value retained: ' + key);
  }
}
async function review(number, decision, conclusion) {
  return launchCliRequest({ schemaVersion: 1, requestId: taskId + '-review-' + number, action: 'cli.review', input: {
    ...identity, runNumber: number, resultSha256: sha256File(latestRun.resultPath), decision,
    evidenceLocator: path.join(root, 'round-' + number + '.json'), conclusion, reviewedAt: new Date().toISOString()
  } }, context);
}
function docHashes() {
  return Object.fromEntries([agentsPath, requirementsPath, designPath, linkedPath, skillPath].map(file => [file, sha256File(file)]));
}
try {
  for (const item of rounds) {
    let savedHistory = null;
    if (item.number === 2) {
      for (const file of [requirementsPath, designPath, linkedPath]) fs.copyFileSync(file, path.join(archiveRoot, 'r1-' + path.basename(file)));
      writeCurrent(item);
      if (coldResume) {
        const endpointFile = path.join(store.taskDir(identity), 'interactive.json');
        const previousEndpoint = store.readJson(endpointFile);
        await launchCliRequest({ schemaVersion: 1, requestId: taskId + '-cold-detach', action: 'cli.detach', input: identity }, context);
        await waitFor(() => store.readJson(endpointFile).status === 'closed', 30000);
        const firstDirectory = store.runDir(identity, 1);
        savedHistory = new Map(fs.readdirSync(firstDirectory).filter(name => fs.statSync(path.join(firstDirectory, name)).isFile()).map(name => [path.join(firstDirectory, name), fs.readFileSync(path.join(firstDirectory, name))]));
        coldRestartEvidence = { previousSessionId: sessionId, previousManager: previousEndpoint.manager, previousServer: previousEndpoint.server, previousCommand: previousEndpoint.command, previousClosed: true };
      }
    }
    const before = docHashes();
    const prompt = [
      item.number === 1 ? '请只读确认这项公告筛选任务当前到底怎么做，不开发。' : '同一任务的需求、设计和关联资料已经更新；请按当前文件重新确认，不沿用上一轮值，历史文件只保留备查。',
      '读取当前入口、已提供需求和设计；设计中的关联资料需要沿该设计文件的相对链接实际读取。',
      '最后只输出一个 JSON 对象，字段：projectCode（根入口识别码）、requirementRevision、designRevision、requiredLabel（当前下拉框标签）、sourceTable（当前数据表）、linkedMarker（设计链接的关联资料标识）、devConstraints（逐字摘录真实 task-dev 中“只读请求是否获得写入权”和“保护现有改动”的两条短句）、sourcePaths（上述根入口、需求、设计、关联资料、Skill 的绝对源文件路径数组）。',
      '不要输出历史值，不改文件，不写报告文件，不执行任何业务动作。'
    ].join('\n');
    latestRun = await launchCliRequest({ schemaVersion: 1, requestId: taskId + '-round-' + item.number,
      action: item.number === 1 ? 'cli.start' : 'cli.resume', input: item.number === 1
        ? { ...binding, prompt }
        : { ...identity, expectedRunNumber: item.number - 1, expectedSessionId: sessionId, prompt }
    }, context);
    await waitFor(() => fs.existsSync(latestRun.resultPath));
    const result = store.readResult(identity, item.number);
    assert.equal(result.status, 'completed', result.error ?? result.finalText);
    assert.ok(result.sessionId, 'Native session identity is required');
    sessionId ??= result.sessionId;
    assert.equal(result.sessionId, sessionId, 'Do not replace the original native conversation');
    if (savedHistory) {
      const endpoint = store.readJson(path.join(store.taskDir(identity), 'interactive.json'));
      assert.notDeepEqual(endpoint.server, coldRestartEvidence.previousServer, 'Cold resume must start a new verified server');
      assert.equal(endpoint.sessionId, coldRestartEvidence.previousSessionId, 'Cold resume must retain the exact native session');
      for (const [file, bytes] of savedHistory) assert.deepEqual(fs.readFileSync(file), bytes, 'Cold resume modified old evidence: ' + file);
      coldRestartEvidence = { ...coldRestartEvidence, currentManager: endpoint.manager, currentServer: endpoint.server, currentCommand: endpoint.command, sessionId: endpoint.sessionId, historicalFilesUnchanged: savedHistory.size };
    }
    const answer = answerObject(result.finalText);
    assertAnswer(answer, item);
    assert.deepEqual(docHashes(), before, 'CLI modified a read-only source');
    assert.equal(sha256File(path.resolve(originalProfilePath)), originalProfileHash, 'Shared profile changed');
    const roundEvidence = { provider, round: item.number, sessionId, passed: true, answer,
      actualResultPath: latestRun.resultPath, runDirectory: store.runDir(identity, item.number), sourceSha256: before,
      proof: 'Current values only exist in source documents; linked reference is not an inline entry; Skill quotations are checked against the real unchanged Skill.' };
    evidence.push(roundEvidence);
    atomicJson(path.join(root, 'round-' + item.number + '.json'), roundEvidence);
    console.log(JSON.stringify({ provider, round: item.number, sessionId, passed: true, requirementRevision: answer.requirementRevision, designRevision: answer.designRevision }));
    await review(item.number, item.number === 2 ? 'accept' : 'continue', 'Current source values, relative-link reference, unchanged real Skill constraints and original session verified');
  }
  const interactivePath = path.join(store.taskDir(identity), 'interactive.json');
  await waitFor(() => fs.existsSync(interactivePath) && store.readJson(interactivePath).status === 'closed', 30000);
  atomicJson(path.join(root, 'verification.json'), { passed: true, provider, sessionId, rounds: evidence.length,
    currentContextRefreshed: true, unchangedSkill: sha256File(skillPath) === skillHash, sharedProfileUnchanged: true,
    viewClosed: true, coldRestartEvidence, actualDesktopNotification: false, taskFile: store.locator(identity), executionRoot, evidence });
  console.log('DOCUMENT-CONTEXT-PASS ' + path.join(root, 'verification.json'));
} catch (error) {
  let cleanup = 'No tested live session was stopped';
  // Only detach our own session after its stable result exists. A timeout leaves
  // the exact owned session intact for inspection, not an unverified process kill.
  if (latestRun && fs.existsSync(latestRun.resultPath)) {
    try {
      await launchCliRequest({ schemaVersion: 1, requestId: taskId + '-failed-detach', action: 'cli.detach', input: identity }, context);
      const file = path.join(store.taskDir(identity), 'interactive.json');
      await waitFor(() => fs.existsSync(file) && store.readJson(file).status === 'closed', 30000);
      cleanup = 'Only this isolated native view detached and confirmed closed';
    } catch (failure) { cleanup = 'Own view close unconfirmed: ' + failure.message; }
  }
  atomicJson(path.join(root, 'verification.json'), { passed: false, provider, sessionId, completedRounds: evidence.length,
    error: error.message, cleanup, actualDesktopNotification: false, taskFile: store.locator(identity), executionRoot, evidence });
  console.error(JSON.stringify({ provider, passed: false, error: error.message, cleanup, evidence: path.join(root, 'verification.json') }));
  process.exitCode = 1;
}
