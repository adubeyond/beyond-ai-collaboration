// Explicit live test: real CLI providers and the real Desktop owner. Never run by CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDesktopHost } from '../模板交付包/scripts/cli/desktop-host.mjs';
import { launchCliRequest, readProfile } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { CliTaskStore, atomicJson, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { readInteractiveEndpoint } from '../模板交付包/scripts/cli/interactive-client.mjs';

const action = process.argv[2];
const option = name => { const at = process.argv.indexOf('--' + name); return at < 0 ? null : process.argv[at + 1]; };
const required = name => { const value = option(name); if (!value) throw new Error('--' + name + ' required'); return value; };
const providers = (option('providers') ?? 'codex,zcode,claude').split(',');
if (!providers.length || new Set(providers).size !== providers.length || providers.some(value => !['codex', 'zcode', 'claude'].includes(value))) throw new Error('Invalid provider selection');
const host = createDesktopHost(), source = host.currentSource();
const save = (root, leaf, value) => atomicJson(path.join(root, leaf), value);

if (action === 'dispatch') {
  if (!process.argv.includes('--allow-live-model')) throw new Error('Explicit --allow-live-model required');
  const profiles = Object.fromEntries(providers.map(provider => [provider, path.resolve(required(provider + '-profile'))]));
  for (const provider of providers) {
    const profile = readProfile(profiles[provider]);
    assert.equal(profile.provider ?? 'codex', provider);
    assert.equal(profile.mode, 'interactive');
    if (provider === 'claude') assert.equal(profile.permissionMode, 'bypassPermissions', 'This permission probe requires already authorized unattended full access');
  }
  if (!(await host.checkCapability()).available) throw new Error('Real Desktop notification capability unavailable');
  const executionParent = fs.realpathSync(required('execution-parent'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-concurrent-'));
  const controlRoot = path.join(root, 'control'), cases = {};
  fs.mkdirSync(path.join(controlRoot, 'local/projects'), { recursive: true });
  for (const provider of providers) {
    const executionRoot = fs.mkdtempSync(path.join(executionParent, 'beyond-' + provider + '-concurrent-'));
    const projectId = 'local-concurrent-' + provider, taskId = 'concurrent-' + provider + '-' + crypto.randomBytes(4).toString('hex');
    const nonce = crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(path.join(controlRoot, 'local/projects', projectId + '.md'), `---\nid: ${projectId}\npath: ${executionRoot}\nhost_id: local\ncodex_project_id: isolated-concurrent-project\n---\n`);
    fs.writeFileSync(path.join(executionRoot, 'AGENTS.md'), `<!-- BEYOND-CONTROL-ROOT: ${controlRoot.replaceAll('\\', '/')} -->\n<!-- BEYOND-PROJECT-ID: ${projectId} -->\nIsolated CLI test only. Read/edit only files in this test directory. No other projects, credentials, Git, network commands or installs. Do not modify tests. Use node --test calc.test.cjs. Do not create Desktop tasks or callbacks; the bridge handles notification.\n`);
    fs.writeFileSync(path.join(executionRoot, 'calc.cjs'), 'exports.add = (a, b) => a - b;\n');
    fs.writeFileSync(path.join(executionRoot, 'calc.test.cjs'), "const test=require('node:test'),assert=require('node:assert/strict'),{add}=require('./calc.cjs');\ntest('positive',()=>assert.equal(add(2,3),5));\ntest('negative',()=>assert.equal(add(-2,-3),-5));\n");
    cases[provider] = { provider, projectId, taskId, executionRoot, profilePath: profiles[provider], nonce, testSha256: sha256File(path.join(executionRoot, 'calc.test.cjs')) };
  }
  const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), root, controlRoot, source, cases, realDesktop: true, businessPolling: false };
  save(root, 'dispatch.json', manifest);
  // Independent native processes run concurrently; no result read or polling here.
  const launched = await Promise.all(providers.map(async provider => {
    const item = cases[provider], profile = readProfile(item.profilePath);
    const result = await launchCliRequest({ schemaVersion: 1, requestId: item.taskId + '-one', action: 'cli.start', input: {
      ...Object.fromEntries(['projectId', 'taskId', 'executionRoot', 'profilePath'].map(k => [k, item[k]])), ...source, taskMode: 'assist',
      configuration: { model: profile.model, effort: option(provider + '-effort') ?? profile.effort ?? (provider === 'zcode' ? null : 'medium') },
      contract: { goal: 'Repair and independently verify an isolated function, then prove same-session continuation after model/effort adjustment', boundaries: 'Only calc.cjs in this test directory may change. No other projects, credentials, Git, network commands, installs or manual callbacks.', acceptance: 'Both unchanged node tests pass; a later same-session turn recalls the private conversation token.', factEntries: [path.join(item.executionRoot, 'AGENTS.md')], skillEntries: [] },
      prompt: `这是隔离测试。请检查 calc.cjs，把加法函数的错误修正；只允许修改 calc.cjs，不改测试。实际运行 node --test calc.test.cjs，必须通过 2 项。记住只在本对话使用的口令 ${item.nonce}，不要将口令写进文件。完成后最终回复精确包含 CLI-CONCURRENT-${provider}-ROUND1=2/2。不要手动发回调，不要访问测试目录外的文件。`
    } }, { ...source, controlRoot, executionRoot: item.executionRoot, hostSpec: host.descriptor });
    save(root, provider + '-launch-1.json', { ...result, acceptedAt: new Date().toISOString() });
    return { provider, taskId: item.taskId, status: result.status, resultPath: result.resultPath };
  }));
  console.log(JSON.stringify({ probeRoot: root, source, launched, next: 'Finish foreground work and end this turn. Do not poll CLI results; consume genuine callbacks.' }));
} else {
  const root = fs.realpathSync(required('probe-root')), manifest = JSON.parse(fs.readFileSync(path.join(root, 'dispatch.json'), 'utf8'));
  assert.equal(source.ownerThreadId, manifest.source.ownerThreadId);
  const provider = required('provider'), item = manifest.cases[provider];
  if (!item) throw new Error('Unknown provider');
  const store = new CliTaskStore({ controlRoot: manifest.controlRoot });
  const identity = { projectId: item.projectId, taskId: item.taskId, ownerThreadId: source.ownerThreadId };
  const state = store.read(identity), result = store.readResult(identity, state.runNumber);
  const resultPath = path.join(store.runDir(identity, state.runNumber), 'result.json');
  const notificationPath = path.join(store.runDir(identity, state.runNumber), 'notification.json');
  const notification = fs.existsSync(notificationPath) ? store.readJson(notificationPath) : null;
  const context = { ...source, controlRoot: manifest.controlRoot, executionRoot: item.executionRoot, hostSpec: host.descriptor };
  if (action === 'inspect') {
    console.log(JSON.stringify({ provider, state: { status: state.status, sessionId: state.sessionId, runNumber: state.runNumber }, result, notification }));
  } else {
    const retry = action === 'retry';
    if (retry && result.status === 'unknown') {
      // Retry only a proved pre-submission initialization failure, not an
      // unexplained lost process that may have left business work running.
      assert.equal(provider, 'zcode');
      const dir = store.runDir(identity, state.runNumber);
      const startup = store.readJson(path.join(dir, 'zcode-startup-error.json'));
      const exited = store.readJson(path.join(dir, 'zcode-view-exit.json'));
      assert.equal(startup.error, result.error);
      assert.notEqual(exited.exitCode, 0);
      assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
      assert.equal(readInteractiveEndpoint(store, identity), null);
    } else assert.equal(result.status, retry ? 'failed' : 'completed');
    assert.equal(sha256File(path.join(item.executionRoot, 'calc.test.cjs')), item.testSha256);
    const tests = spawnSync(process.execPath, ['--test', 'calc.test.cjs'], { cwd: item.executionRoot, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.equal(notification?.status, 'delivered', 'Do not substitute manual inspection for automatic wakeup');
    const next = action === 'continue' || retry;
    if (!next && action !== 'accept') throw new Error('Expected inspect, continue, retry or accept');
    if (action === 'continue') assert.equal(state.runNumber, 1);
    else assert.ok(state.runNumber >= 2);
    if (!retry) assert.ok(result.finalText.includes(next ? `CLI-CONCURRENT-${provider}-ROUND1=2/2` : `CLI-CONCURRENT-${provider}-ROUND2=${item.nonce}`));
    if (state.runNumber >= 2) {
      const first = JSON.parse(fs.readFileSync(path.join(root, provider + '-verification-1.json'), 'utf8'));
      const resumed = JSON.parse(fs.readFileSync(path.join(root, provider + '-launch-' + state.runNumber + '.json'), 'utf8'));
      assert.equal(state.sessionId, first.sessionId);
      assert.equal(state.sessionId, resumed.expectedSessionId);
      assert.equal(result.configuration.model, resumed.profile.model);
      assert.equal(result.configuration.effort, resumed.profile.effort);
    }
    save(root, provider + '-verification-' + state.runNumber + '.json', { provider, sessionId: state.sessionId, runNumber: state.runNumber, verifiedAt: new Date().toISOString(), source, resultSha256: sha256File(resultPath), notification, tests: { exitCode: tests.status, output: tests.stdout }, configuration: result.configuration, passed: !retry, ...(retry ? { retainedFailure: result.error } : {}) });
    const previousReview = store.readReview(identity, state.runNumber);
    if (previousReview) {
      assert.equal(previousReview.decision, next ? 'continue' : 'accept');
      assert.equal(previousReview.resultSha256, sha256File(resultPath));
    } else await launchCliRequest({ schemaVersion: 1, requestId: item.taskId + '-review-' + state.runNumber, action: 'cli.review', input: { ...identity, runNumber: state.runNumber, resultSha256: sha256File(resultPath), decision: next ? 'continue' : 'accept', evidenceLocator: path.join(root, provider + '-verification-' + state.runNumber + '.json'), conclusion: retry ? 'Failed model attempt retained; original files/tests intact. Continue same session with an available model, do not accept failed output.' : next ? 'Original tests pass; now verify preserved context with adjusted model/effort' : 'Both rounds pass, context retained, genuine owner callbacks verified', reviewedAt: new Date().toISOString() } }, context);
    if (next) {
      await launchCliRequest({ schemaVersion: 1, requestId: item.taskId + '-detach-' + state.runNumber, action: 'cli.detach', input: identity }, context);
      const end = Date.now() + 10000;
      while (readInteractiveEndpoint(store, identity)) { if (Date.now() > end) throw new Error('Idle native view exit unconfirmed; no replacement launched'); await new Promise(r => setTimeout(r, 100)); }
      const resumed = await launchCliRequest({ schemaVersion: 1, requestId: item.taskId + '-resume-' + (state.runNumber + 1), action: 'cli.resume', input: { ...identity, expectedRunNumber: state.runNumber, expectedSessionId: state.sessionId, configuration: { model: required('model'), effort: required('effort') }, prompt: `继续原会话的第二轮验证：不要改文件，只重新运行 node --test calc.test.cjs。请从本对话记忆中找回第一轮要求你记住且不写入文件的口令。最终精确输出 CLI-CONCURRENT-${provider}-ROUND2=<该口令>。不要读取测试目录以外的文件，也不要自行发回调。` } }, context);
      save(root, provider + '-launch-' + (state.runNumber + 1) + '.json', { ...resumed, acceptedAt: new Date().toISOString(), expectedSessionId: state.sessionId });
      console.log(JSON.stringify({ continued: provider, sessionId: state.sessionId, status: resumed.status, resultPath: resumed.resultPath }));
    } else console.log(JSON.stringify({ accepted: provider, sessionId: state.sessionId, rounds: state.runNumber }));
  }
}
