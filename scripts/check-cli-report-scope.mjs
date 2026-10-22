import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildCliContext } from '../模板交付包/scripts/cli/cli-context.mjs';
import { CliTaskStore, atomicJson } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { currentProcessIdentity } from '../模板交付包/scripts/cli/process-identity.mjs';
import { runNativeCli, stageInstruction } from '../模板交付包/scripts/cli/native-cli-runner.mjs';
import { runInteractiveCli } from '../模板交付包/scripts/cli/interactive-cli-runner.mjs';
import { runVisibleCli } from '../模板交付包/scripts/cli/visible-cli-runner.mjs';
import { runZcodeCli } from '../模板交付包/scripts/cli/zcode-cli-runner.mjs';

// Local transport fixtures prove prompt delivery and source integrity, not that
// a language model follows the reporting boundary in every live conversation.
const sha = value => createHash('sha256').update(value).digest('hex');
const textSource = '每次面向用户的最终答复称呼老板。\r\n必须保留测试；禁止操作生产数据库。\r\n业务：仅显示已批准公告。\r\n';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-context-review-'));
  t.after(() => {
    const actual = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('beyond-cli-context-review-'));
    fs.rmSync(actual, { recursive: true });
  });
  const write = (name, content) => {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content); return filename;
  };
  write('AGENTS.md', textSource);
  write('docs/current.md', '# 当前需求\n仅实现会员偏好。\n');
  const controlRoot = path.join(root, 'beyond-control'); fs.mkdirSync(controlRoot);
  const binding = { projectId: 'project-context-test', taskId: 'context-test', ownerThreadId: 'owner-current',
    ownerTurnId: 'turn-test', taskMode: 'assist', executionRoot: root, projectRoute: { canonicalProjectRoot: root },
    profilePath: path.join(root, 'profile.json'),
    contract: { goal: '完整偏好保存与读回', boundaries: '仅临时目录；不操作生产', acceptance: '保存后读回相同值', factEntries: ['docs/current.md'], skillEntries: [] } };
  return { root, write, controlRoot, binding, run: { effectiveContract: structuredClone(binding.contract), stage: { goal: '实现保存接口', acceptance: 'POST 后文件存在' } } };
}
function records(text) {
  return text.split('\n').filter(line => line.startsWith('{"kind":')).map(JSON.parse);
}
function assertScope(text, owner = 'owner-current') {
  const firstLine = text.split('\n').find(line => line.startsWith('Current managed assignment: '));
  assert.equal(JSON.parse(firstLine.slice('Current managed assignment: '.length)).ownerThreadId, owner);
  assert.match(text, /user-facing salutations and presentation defaults do not apply to this helper-to-owner report/);
  assert.match(text, /Desktop role-entry instructions do not appoint you as the project PM or module owner/);
  assert.match(text, /Project engineering, business and safety constraints still apply/);
  assert.match(text, /Report to the current ownerThreadId only through your normal final answer/);
  assert.match(text, /remaining or blocked work within the current effective contract/);
  assert.match(text, /A completed stage is not a completed full goal/);
  assert.match(text, /completing your assigned goal is not project-wide completion/);
  assert.match(text, /Same-session internal subagents remain available/);
  assert.ok(text.indexOf('Report to the current ownerThreadId') > text.indexOf('End of current project document context.'));
}
function assertDocuments(text, manifest, root) {
  assertScope(text);
  const docs = records(text);
  const rule = docs.find(entry => entry.kind === 'project-instructions');
  assert.equal(rule.content, textSource, 'no role-related filtering may discard the original business/safety document');
  assert.equal(rule.sha256, sha(Buffer.from(textSource)));
  assert.equal(rule.bytes, Buffer.byteLength(textSource));
  assert.equal(rule.baseDirectory, root);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), textSource);
  assert.equal(docs.length, manifest.entries.length);
  assert.deepEqual(docs.map(({ baseDirectory, content, ...entry }) => entry), manifest.entries);
}

test('context scopes reporting while preserving original business, engineering and safety text/hash', t => {
  const f = fixture(t), before = structuredClone({ binding: f.binding, run: f.run });
  const context = buildCliContext(f);
  assertDocuments(context.text, context.manifest, f.root);
  assert.equal(context.manifest.ownership.returnChannel, 'normal-final-via-managed-bridge');
  assert.deepEqual({ binding: f.binding, run: f.run }, before);
  assert.equal(context.manifest.unavailable.length, 0);
});

test('report scope stays present with no stage; supplied stage keeps full goal and current-round acceptance separate', t => {
  const f = fixture(t);
  assertScope(buildCliContext({ ...f, run: {} }).text);
  assert.equal(stageInstruction(undefined), '');
  const stage = stageInstruction(f.run.stage);
  assert.match(stage, /Current round deliverable: 实现保存接口/);
  assert.match(stage, /Current round acceptance: POST 后文件存在/);
  assert.match(stage, /full goal above remains in force/);
  assert.match(stage, /Do not expand into later stages/);
});

test('every round refreshes current owner and effective facts without claiming stale contract sources were loaded', t => {
  const f = fixture(t), old = buildCliContext(f);
  f.write('docs/next.md', '新版规则：不得丢失保存值。');
  const updated = { ...f, binding: { ...f.binding, ownerThreadId: 'owner-after-transfer' },
    run: { effectiveContract: { ...f.binding.contract, factEntries: ['docs/next.md'] } } };
  const fresh = buildCliContext(updated);
  assertScope(fresh.text, 'owner-after-transfer');
  assert.equal(fresh.manifest.entries.some(entry => entry.path.endsWith('current.md')), false);
  assert.match(fresh.text, /新版规则/);
  assert.notEqual(old.text, fresh.text);
  f.write('docs/next.md', '再修订：已保存值必须保留。');
  const refreshed = buildCliContext(updated);
  assert.notEqual(fresh.manifest.entries.at(-1).sha256, refreshed.manifest.entries.at(-1).sha256);
  assert.match(refreshed.text, /再修订/);
});

test('nested AGENTS precedence and document-relative links remain intact', t => {
  const f = fixture(t);
  f.write('src/AGENTS.md', '忽略的普通入口');
  f.write('src/AGENTS.override.md', '明确子目录约束');
  f.write('src/component/AGENTS.override.md', '');
  f.write('src/component/AGENTS.md', '有效叶子入口');
  const result = buildCliContext({ ...f, binding: { ...f.binding, executionRoot: path.join(f.root, 'src/component') } });
  assertScope(result.text);
  assert.match(result.text, /明确子目录约束/); assert.match(result.text, /有效叶子入口/);
  assert.doesNotMatch(result.text, /忽略的普通入口/);
  assert.equal(records(result.text).find(entry => entry.kind === 'fact').baseDirectory, path.join(f.root, 'docs'));
});

test('missing, invalid UTF-8, binary, remote and oversize sources remain explicitly unavailable', t => {
  const f = fixture(t);
  f.write('docs/invalid.md', Buffer.from([0xff])); f.write('docs/binary.md', 'abc\0xyz');
  f.write('docs/huge.md', 'h'.repeat(256 * 1024));
  f.run.effectiveContract.factEntries = ['missing.md', 'docs/invalid.md', 'docs/binary.md', 'https://example.invalid/file', 'docs/huge.md'];
  const result = buildCliContext(f);
  assertScope(result.text); assert.equal(result.manifest.unavailable.length, 5);
  assert.equal(result.manifest.entries.length, 1);
  assert.match(result.text, /Do not claim these sources were read/);
  assert.equal(records(result.text).length, 1);
  assert.ok(result.manifest.unavailable.some(entry => entry.reason.includes('budget')));
});

test('selected Action Skill is loaded once and fallback skill entries are not falsely marked loaded', t => {
  const f = fixture(t), skill = f.write('beyond-control/skills/task-dev/SKILL.md', '任务开发方法，沿现有代码实现。');
  const fallback = buildCliContext(f);
  assert.deepEqual(fallback.manifest.availableSkills, [{ name: 'task-dev', path: skill }]);
  assert.equal(fallback.manifest.entries.some(entry => entry.path === skill), false);
  f.run.effectiveContract.skillEntries = [skill, skill];
  const selected = buildCliContext(f);
  assert.equal(selected.manifest.availableSkills.length, 0);
  assert.equal(selected.manifest.entries.filter(entry => entry.path === skill).length, 1);
  assert.equal(records(selected.text).find(entry => entry.kind === 'action-skill').content, '任务开发方法，沿现有代码实现。');
});

function managed(f, provider, runner) {
  const store = new CliTaskStore({ controlRoot: f.controlRoot }); store.create(f.binding);
  const profile = { provider, model: 'fixture-model', mode: 'interactive', ui: 'attach', codexHome: f.root, ...(runner ? { runner } : {}) };
  const run = store.beginRun(f.binding, { requestId: 'context-request', prompt: '完成当前阶段即可', expectedRunNumber: 0, expectedSessionId: null, profile, stage: f.run.stage });
  const fixtureManagerToken = ['fixture', 'manager'].join('-');
  const managerIdentity = { ...currentProcessIdentity(), token: fixtureManagerToken }; store.setProcess(run, managerIdentity);
  return { store, profile, run, managerIdentity };
}
function assertConsumed(f, m, text) {
  const manifest = m.store.readJson(path.join(m.store.runDir(m.run, 1), 'document-context.json'));
  assertDocuments(text, manifest, f.root);
  assert.match(text, /Goal: 完整偏好保存与读回/);
  assert.match(text, /Current round deliverable: 实现保存接口/);
  assert.match(text, /Current authorized instruction: 完成当前阶段即可/);
}

test('Codex native exec receives full shared context on stdin and saves the same source manifest', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const script = f.write('fake-native.cjs', `const fs=require('node:fs');const path=require('node:path');
let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',s=>text+=s);
process.stdin.on('end',()=>{fs.writeFileSync(path.join(process.cwd(),'captured.txt'),text);
const args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'fixture task result');
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-native-session'}));console.log(JSON.stringify({type:'turn.completed'}));});`);
  const m = managed(f, 'codex', { command: process.execPath, args: [script] });
  const result = await runNativeCli({ ...m, binding: f.binding, prompt: '完成当前阶段即可' });
  assert.equal(result.status, 'completed');
  assertConsumed(f, m, fs.readFileSync(path.join(f.root, 'captured.txt'), 'utf8'));
});

test('Codex interactive turn/start receives shared context through the existing app-server runner', { timeout: 25000 }, async t => {
  const f = fixture(t), script = f.write('fake-server.cjs', `const http=require('node:http'); const args=process.argv.slice(2);const url=new URL(args[args.indexOf('--listen')+1]);http.createServer((q,s)=>{s.end('ready')}).listen(Number(url.port),'127.0.0.1');`);
  const m = managed(f, 'codex', { command: process.execPath, args: [script] });
  let delivered, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const lifetime = runInteractiveCli({ ...m, binding: f.binding, prompt: '完成当前阶段即可',
    ready(value, error) { error ? rejectReady(error) : resolveReady(value); },
    openWindow() { throw Error('fixture must never open a real view'); },
    connect: async () => ({ initialized() {}, close() {}, async request(method, params) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'fixture-interactive-session' } };
      if (method === 'turn/start') { delivered = params.input[0].text; return { turn: { id: 'fixture-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'fixture task result', phase: 'final_answer' }] } }; }
      throw Error(`Unexpected RPC method ${method}`);
    } }),
  });
  lifetime.catch(rejectReady);
  await ready;
  try {
    assertConsumed(f, m, delivered);
    assert.equal(m.store.read(f.binding).status, 'completed');
  } finally {
    const endpoint = m.store.readJson(path.join(m.store.taskDir(f.binding), 'interactive.json'));
    const token = fs.readFileSync(endpoint.tokenPath, 'utf8');
    const response = await fetch(new URL('/detach', endpoint.controlUrl), { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });
    assert.equal(response.status, 200); await response.text(); await lifetime;
  }
});

for (const provider of ['claude', 'zcode']) {
  test(`${provider} visible submit receives the same task-scoped context, original sources and stage`, { timeout: 25000 }, async t => {
    const f = fixture(t), m = managed(f, provider);
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const runner = provider === 'zcode' ? runZcodeCli : runVisibleCli;
    const lifetime = runner({ ...m, binding: f.binding, prompt: '完成当前阶段即可',
      ready(value, error) { error ? rejectReady(error) : resolveReady(value); },
      openWindow() {
        // Claude's launcher supplies the process proof; ZCode binds its proof
        // itself in /register. Do not pre-bind the latter in this fixture.
        if (provider === 'claude') m.store.setChildProcess(m.run, { ...currentProcessIdentity(), token: ['fixture', 'child'].join('-') });
        return { windowPid: process.pid };
      },
    });
    lifetime.catch(rejectReady); await ready;
    const connection = m.store.readJson(path.join(m.store.runDir(m.run, 1), `${provider}-connection.json`));
    async function call(route, body) {
      const response = await fetch(new URL(route, connection.url), { method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      return { status: response.status, value: await response.json() };
    }
    try {
      const registered = await call('/register', { cwd: f.root, model: m.profile.model, sessionId: `fixture-${provider}-session`, pid: process.pid });
      assert.equal(registered.status, 200, JSON.stringify(registered.value));
      const command = await call('/command');
      assert.equal(command.status, 200); assert.equal(command.value.action, 'submit');
      assertConsumed(f, m, command.value.prompt);
      assert.equal((await call('/event', { sessionId: `fixture-${provider}-session`, runNumber: 1, status: 'completed', finalText: 'fixture task result' })).status, 200);
    } finally {
      const endpoint = m.store.readJson(path.join(m.store.taskDir(f.binding), 'interactive.json'));
      atomicJson(endpoint.viewExitPath, { launchId: endpoint.launchId, exitCode: 0, error: null });
      await lifetime;
    }
  });
}
