// Explicit, paid-provider smoke test. Never part of unattended product tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launchCliRequest, readProfile } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { CliTaskStore, atomicJson, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';

const index = process.argv.indexOf('--profile');
if (index < 0 || !process.argv.includes('--allow-live-model')) throw new Error('Explicit --profile <file> --allow-live-model required');
const profilePath = path.resolve(process.argv[index + 1]), provider = readProfile(profilePath).provider;
if (!['zcode', 'claude'].includes(provider)) throw new Error('This probe requires an explicit ZCode or Claude profile');
const root = fs.mkdtempSync(path.join(os.tmpdir(), `beyond-${provider}-real-`));
const parentIndex = process.argv.indexOf('--execution-parent');
const executionRoot = parentIndex < 0 ? path.join(root, 'project') : fs.mkdtempSync(path.join(fs.realpathSync(process.argv[parentIndex + 1]), 'beyond-cli-probe-'));
const controlRoot = path.join(root, 'control');
fs.mkdirSync(path.join(controlRoot, 'local/projects'), { recursive: true }); fs.mkdirSync(executionRoot, { recursive: true });
const projectId = 'local-zcode-probe', ownerThreadId = 'isolated-probe-owner', ownerTurnId = 'isolated-probe-turn';
fs.writeFileSync(path.join(controlRoot, 'local/projects', projectId + '.md'), `---\nid: ${projectId}\npath: ${executionRoot}\nhost_id: local\ncodex_project_id: isolated-zcode-project\n---\n`);
fs.writeFileSync(path.join(executionRoot, 'AGENTS.md'), `<!-- BEYOND-CONTROL-ROOT: ${controlRoot.replaceAll('\\', '/')} -->\n<!-- BEYOND-PROJECT-ID: ${projectId} -->\nTemporary test only. Work only in this directory. Do not read credentials, other projects or Git. No network commands or dependency installation. Use node --test calc.test.cjs.\n`);
fs.writeFileSync(path.join(executionRoot, 'calc.cjs'), 'exports.add = (a, b) => a - b;\n');
fs.writeFileSync(path.join(executionRoot, 'calc.test.cjs'), "const test=require('node:test'),assert=require('node:assert/strict'),{add}=require('./calc.cjs');\ntest('adds integers',()=>assert.equal(add(2,3),5));\ntest('adds negatives',()=>assert.equal(add(-2,-3),-5));\n");
const source = path.join(executionRoot, 'calc.cjs'), before = sha256File(source), testHash = sha256File(path.join(executionRoot, 'calc.test.cjs'));
const binding = { projectId, taskId: 'review-fix-verify', ownerThreadId, ownerTurnId, taskMode: 'assist', executionRoot, profilePath, contract: { goal: 'Review, repair, and verify the isolated addition function', boundaries: 'Only this temporary project. No other projects, credentials, Git, installs or network commands. Do not edit tests. No Desktop callbacks; managed bridge owns notifications.', acceptance: 'Find the actual addition bug, minimally fix calc.cjs, pass the unchanged two node tests', factEntries: [path.join(executionRoot, 'AGENTS.md')], skillEntries: [] } };
const store = new CliTaskStore({ controlRoot }), context = { controlRoot, executionRoot, ownerThreadId, ownerTurnId };
let sessionId = null, latestRun;
console.log(JSON.stringify({ probeRoot: root, profileModel: readProfile(profilePath).model, notificationMode: 'not-live-desktop; separately simulated in unit tests' }));
function watchFor(check, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const done = () => { try { const value = check(); if (value) { clearTimeout(timer); watcher.close(); resolve(value); } } catch (e) { clearTimeout(timer); watcher.close(); reject(e); } };
    const watcher = fs.watch(controlRoot, { recursive: true }, done), timer = setTimeout(() => { watcher.close(); reject(new Error('Native result timeout; inspect preserved probeRoot before retrying')); }, timeout);
    done();
  });
}
async function review(number, decision, conclusion) { await launchCliRequest({ schemaVersion: 1, requestId: 'review-' + number, action: 'cli.review', input: { projectId, taskId: binding.taskId, ownerThreadId, runNumber: number, resultSha256: sha256File(latestRun.resultPath), decision, evidenceLocator: 'file:' + executionRoot, conclusion, reviewedAt: new Date().toISOString() } }, context); }
try {
  assert.equal(spawnSync(process.execPath, ['--test', 'calc.test.cjs'], { cwd: executionRoot, encoding: 'utf8' }).status, 1);
  const prompts = [
    '第一轮只读审查：读取 calc.cjs 和 calc.test.cjs，运行 node --test calc.test.cjs，指出导致失败的具体错误。不要修复。回复简短中文，包含 REVIEW-FOUND。',
    '第二轮：沿用刚才会话中的判断，仅修复 calc.cjs 的加法错误，不改测试。运行 node --test calc.test.cjs，完成后报告真实结果，包含 FIX-DONE。',
    '第三轮只读复核：重新检查当前实现并运行原测试，确认确实修好且两个测试通过。不要改任何文件。最终包含 VERIFY-PASS，并说出之前修的是哪个错误。'
  ];
  for (let i = 0; i < prompts.length; i++) {
    latestRun = await launchCliRequest({ schemaVersion: 1, requestId: 'live-round-' + (i + 1), action: i === 0 ? 'cli.start' : 'cli.resume', input: i === 0 ? { ...binding, prompt: prompts[i] } : { projectId, taskId: binding.taskId, ownerThreadId, expectedRunNumber: i, expectedSessionId: sessionId, prompt: prompts[i] } }, context);
    await watchFor(() => fs.existsSync(latestRun.resultPath));
    const result = store.readResult(binding, i + 1); assert.equal(result.status, 'completed', result.error ?? result.finalText);
    sessionId ??= result.sessionId; assert.equal(result.sessionId, sessionId);
    assert.match(result.finalText, new RegExp(['REVIEW-FOUND', 'FIX-DONE', 'VERIFY-PASS'][i]));
    assert.equal(sha256File(path.join(executionRoot, 'calc.test.cjs')), testHash);
    if (i === 0) assert.equal(sha256File(source), before);
    else assert.equal(spawnSync(process.execPath, ['--test', 'calc.test.cjs'], { cwd: executionRoot, encoding: 'utf8' }).status, 0);
    console.log(JSON.stringify({ round: i + 1, sessionId, status: result.status, finalText: result.finalText }));
    await review(i + 1, i === 2 ? 'accept' : 'continue', i === 0 ? 'Review did not modify source; original two tests fail as expected' : 'Independent original two tests passed; test hash unchanged');
    if (i === 1 && process.argv.includes('--exercise-reopen')) {
      await launchCliRequest({ schemaVersion: 1, requestId: 'reopen-probe-detach', action: 'cli.detach', input: { projectId, taskId: binding.taskId, ownerThreadId } }, context);
      await watchFor(() => store.readJson(path.join(store.taskDir(binding), 'interactive.json')).status === 'closed', 30000);
      console.log('Native window closed; next round must resume the exact saved session');
    }
  }
  await watchFor(() => store.readJson(path.join(store.taskDir(binding), 'interactive.json')).status === 'closed', 30000);
  atomicJson(path.join(root, 'verification.json'), { passed: true, sessionId, rounds: 3, reopenedSameSession: process.argv.includes('--exercise-reopen'), unchangedTests: true, independentTests: '2/2', nativeVisibleWindow: true, actualDesktopNotification: false, taskFile: store.locator(binding) });
  console.log(`REAL-${provider.toUpperCase()}-PASS ` + path.join(root, 'verification.json'));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
  if (latestRun && fs.existsSync(latestRun.resultPath)) await launchCliRequest({ schemaVersion: 1, requestId: 'failed-probe-detach', action: 'cli.detach', input: { projectId, taskId: binding.taskId, ownerThreadId } }, context).catch(() => {});
}
