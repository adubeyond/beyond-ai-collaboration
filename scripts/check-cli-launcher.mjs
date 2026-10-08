import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliTaskStore, sha256File, digest } from '../模板交付包/scripts/cli/cli-task-store.mjs';
const bridge = () => import('../模板交付包/scripts/cli/cli-bridge.mjs');
const runner = () => import('../模板交付包/scripts/cli/native-cli-runner.mjs');

export function fixture(t, mode = 'ok') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-launch-'));
  const controlRoot = path.join(root, 'control'), executionRoot = path.join(root, 'project'), home = path.join(root, 'cli-home');
  fs.mkdirSync(path.join(controlRoot, 'local/projects'), { recursive: true }); fs.mkdirSync(executionRoot); fs.mkdirSync(home);
  const projectId = 'local-cli-test', ownerThreadId = 'desktop-owner', ownerTurnId = 'dispatch-turn';
  fs.writeFileSync(path.join(controlRoot, 'local/projects', `${projectId}.md`), `---\nid: ${projectId}\npath: ${executionRoot}\nhost_id: local\ncodex_project_id: desktop-project\n---\n`);
  fs.writeFileSync(path.join(executionRoot, 'AGENTS.md'), `<!-- BEYOND-CONTROL-ROOT: ../control -->\n<!-- BEYOND-PROJECT-ID: ${projectId} -->\n`);
  const fake = path.join(root, 'fake-cli.cjs'), gate = path.join(root, 'release');
  fs.writeFileSync(fake, `const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);const session=a.includes('resume')?a[a.indexOf('resume')+1]:'cli-session';fs.writeFileSync(path.join(process.cwd(),'args.json'),JSON.stringify({args:a,home:process.env.CODEX_HOME,key:process.env.OPENAI_API_KEY||null}));console.log(JSON.stringify({type:'thread.started',thread_id:session}));let p='';process.stdin.on('data',b=>p+=b);process.stdin.on('end',()=>{const finish=()=>{if(${JSON.stringify(mode)}==='fail'){console.log(JSON.stringify({type:'turn.failed',error:{message:'API rejected'}}));process.exitCode=1;}else{fs.writeFileSync(a[a.indexOf('--output-last-message')+1],a.includes('resume')?fs.readFileSync('first.txt','utf8')+'+second':'first');if(!a.includes('resume'))fs.writeFileSync('first.txt','first');console.error('metadata warning');console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));}};if(${JSON.stringify(mode)}==='gate'){const x=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(x);finish();}},10);}else finish();});`);
  const profilePath = path.join(root, 'profile.json'), profile = { schemaVersion: 1, runner: { command: process.execPath, args: [fake] }, codexHome: home, model: 'test-third-party' };
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  const binding = { projectId, taskId: 'one-goal', ownerThreadId, ownerTurnId, executionRoot, profilePath, taskMode: 'assist', contract: { goal: 'two round file', boundaries: 'temporary directory only', acceptance: 'second reads first', factEntries: [], skillEntries: [] } };
  const store = new CliTaskStore({ controlRoot });
  t.after(async () => { fs.writeFileSync(gate, 'release'); await new Promise(resolve => setTimeout(resolve, 150)); fs.rmSync(root, { recursive: true, force: true }); });
  const context = { controlRoot, executionRoot, ownerThreadId, ownerTurnId };
  return { root, controlRoot, executionRoot, binding, store, profile, profilePath, gate, context };
}
export async function until(condition, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) { const value = condition(); if (value) return value; if (Date.now() > end) throw new Error('fixture condition timed out'); await new Promise(r => setTimeout(r, 15)); }
}
test('launch-returns-before-terminal and thread-start-persists-before-exit', async t => {
  const { launchCliRequest } = await bridge(); const f = fixture(t, 'gate');
  const run = await launchCliRequest({ schemaVersion: 1, requestId: 'launch-first', action: 'cli.start', input: { ...f.binding, prompt: 'write first' } }, f.context);
  assert.equal(run.status, 'running');
  await until(() => f.store.read(f.binding).sessionId);
  assert.equal(f.store.read(f.binding).sessionId, 'cli-session');
  assert.equal(fs.existsSync(run.resultPath), false);
  fs.writeFileSync(f.gate, 'go');
  await until(() => fs.existsSync(run.resultPath));
  assert.equal(f.store.readResult(f.binding, 1).status, 'completed');
});
test('resume-uses-exact-session and second round really reads first artifact', async t => {
  const { launchCliRequest } = await bridge(); const f = fixture(t);
  const first = await launchCliRequest({ schemaVersion: 1, requestId: 'first', action: 'cli.start', input: { ...f.binding, prompt: 'first round' } }, f.context);
  await until(() => fs.existsSync(first.resultPath));
  f.store.recordReview({ ...f.binding, runNumber: 1, resultSha256: sha256File(first.resultPath), decision: 'continue', evidenceLocator: 'file:first.txt', conclusion: 'append second', reviewedAt: new Date().toISOString() });
  const second = await launchCliRequest({ schemaVersion: 1, requestId: 'second', action: 'cli.resume', input: { projectId: f.binding.projectId, taskId: f.binding.taskId, ownerThreadId: f.binding.ownerThreadId, prompt: 'append second', expectedRunNumber: 1, expectedSessionId: 'cli-session' } }, f.context);
  await until(() => fs.existsSync(second.resultPath));
  const args = JSON.parse(fs.readFileSync(path.join(f.executionRoot, 'args.json'))).args;
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'cli-session']);
  assert.equal(args.includes('--skip-git-repo-check'), true);
  assert.equal(args.includes('--last'), false);
  assert.equal(f.store.readResult(f.binding, 2).finalText, 'first+second');
});

test('per-task model and effort persist across same-session resume without changing the shared profile', async t => {
  const { launchCliRequest } = await bridge(); const f = fixture(t);
  const original = fs.readFileSync(f.profilePath, 'utf8');
  const first = await launchCliRequest({ schemaVersion: 1, requestId: 'config-one', action: 'cli.start', input: { ...f.binding, prompt: 'first', configuration: { model: 'economy-model', effort: 'high' } } }, f.context);
  await until(() => fs.existsSync(first.resultPath));
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), original);
  assert.deepEqual(f.store.readResult(f.binding, 1).configuration, { provider: 'codex', model: 'economy-model', effort: 'high' });
  const savedFirst = f.store.readJson(path.join(f.store.runDir(f.binding, 1), 'run.json'));
  assert.equal(savedFirst.profile.model, 'economy-model');
  for (const [number, configuration, model, effort] of [[2, { model: 'stronger-model', effort: 'xhigh' }, 'stronger-model', 'xhigh'], [3, undefined, 'stronger-model', 'xhigh'], [4, { effort: null }, 'stronger-model', null]]) {
    f.store.recordReview({ ...f.binding, runNumber: number - 1, resultSha256: sha256File(path.join(f.store.runDir(f.binding, number - 1), 'result.json')), decision: 'continue', evidenceLocator: 'file:first.txt', conclusion: 'next part of same goal', reviewedAt: new Date().toISOString() });
    const next = await launchCliRequest({ schemaVersion: 1, requestId: 'config-' + number, action: 'cli.resume', input: { projectId: f.binding.projectId, taskId: f.binding.taskId, ownerThreadId: f.binding.ownerThreadId, prompt: 'continue', expectedRunNumber: number - 1, expectedSessionId: 'cli-session', ...(configuration ? { configuration } : {}) } }, f.context);
    await until(() => fs.existsSync(next.resultPath));
    const args = JSON.parse(fs.readFileSync(path.join(f.executionRoot, 'args.json'))).args;
    assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'cli-session']);
    assert.equal(args[args.indexOf('--model') + 1], model);
    assert.equal(args.includes(`model_reasoning_effort="${effort}"`), effort !== null);
    assert.equal(args.includes('approval_policy="never"'), true);
    assert.equal(args.includes('sandbox_mode="danger-full-access"'), true);
    assert.deepEqual(f.store.readResult(f.binding, number).configuration, { provider: 'codex', model, effort });
  }
  assert.equal(fs.readFileSync(f.profilePath, 'utf8'), original);
  assert.deepEqual(f.store.readJson(path.join(f.store.runDir(f.binding, 1), 'run.json')), savedFirst);
  const other = { ...f.binding, taskId: 'other-goal' };
  const otherRun = await launchCliRequest({ schemaVersion: 1, requestId: 'other', action: 'cli.start', input: { ...other, prompt: 'independent' } }, f.context);
  await until(() => fs.existsSync(otherRun.resultPath));
  assert.equal(f.store.readResult(other, 1).configuration.model, f.profile.model);
});

test('task-selected configuration survives shared default changes and rejects invalid or concurrent overrides', async t => {
  const { launchCliRequest } = await bridge(); const f = fixture(t, 'gate');
  const base = { schemaVersion: 1, requestId: 'configured-start', action: 'cli.start', input: { ...f.binding, prompt: 'first' } };
  for (const configuration of [null, [], { model: '' }, { model: 'x\ny' }, { effort: 'unlimited' }, { permissionMode: 'new-authority' }, { api_key: 'secret' }]) {
    await assert.rejects(() => launchCliRequest({ ...base, input: { ...base.input, configuration } }, f.context), /configuration|effort|model/);
    assert.equal(fs.existsSync(f.store.locator(f.binding)), false);
  }
  const first = await launchCliRequest(base, f.context);
  await until(() => f.store.read(f.binding).sessionId);
  await assert.rejects(() => launchCliRequest({ ...base, input: { ...base.input, configuration: { model: 'conflicting' } } }, f.context), /request conflict/);
  const resume = { schemaVersion: 1, requestId: 'next', action: 'cli.resume', input: { projectId: f.binding.projectId, taskId: f.binding.taskId, ownerThreadId: f.binding.ownerThreadId, prompt: 'continue', expectedRunNumber: 1, expectedSessionId: 'cli-session' } };
  await assert.rejects(() => launchCliRequest({ ...resume, input: { ...resume.input, configuration: { model: 'different', effort: 'high' } } }, f.context), /active run/);
  assert.equal(f.store.read(f.binding).runNumber, 1);
  fs.writeFileSync(f.gate, 'go'); await until(() => fs.existsSync(first.resultPath));
  f.store.recordReview({ ...f.binding, runNumber: 1, resultSha256: sha256File(first.resultPath), decision: 'continue', evidenceLocator: 'file:first.txt', conclusion: 'continue original configuration', reviewedAt: new Date().toISOString() });
  fs.writeFileSync(f.profilePath, JSON.stringify({ ...f.profile, model: 'new-global-default', effort: 'ultra' }));
  const second = await launchCliRequest(resume, f.context); await until(() => fs.existsSync(second.resultPath));
  assert.deepEqual(f.store.readResult(f.binding, 2).configuration, { provider: 'codex', model: f.profile.model, effort: null });
});
test('spawn-failure-retained with null session and exactly one terminal callback', async t => {
  const { runNativeCli } = await runner(); const f = fixture(t); f.store.create(f.binding);
  const run = f.store.beginRun(f.binding, { requestId: 'failure', prompt: 'start', expectedRunNumber: 0, expectedSessionId: null });
  let notified = 0;
  const result = await runNativeCli({ binding: f.binding, run, profile: { ...f.profile, runner: { command: path.join(f.root, 'absent.exe'), args: [] } }, prompt: 'start', store: f.store, onTerminal: () => { notified++; } });
  assert.equal(result.status, 'failed'); assert.equal(result.sessionId, null); assert.equal(notified, 1);
});
test('event-failure-not-completed; stderr warning does not block real success', async t => {
  const { runNativeCli } = await runner();
  for (const [mode, expected] of [['fail', 'failed'], ['ok', 'completed']]) {
    const f = fixture(t, mode); f.store.create(f.binding); const run = f.store.beginRun(f.binding, { requestId: mode, prompt: 'go', expectedRunNumber: 0, expectedSessionId: null });
    const result = await runNativeCli({ binding: f.binding, run, profile: f.profile, prompt: 'go', store: f.store }); assert.equal(result.status, expected);
  }
});
test('profile-does-not-leak-or-fallback and wrong owner rejected before writes', async t => {
  const { launchCliRequest } = await bridge(); const f = fixture(t);
  const request = { schemaVersion: 1, requestId: 'one', action: 'cli.start', input: { ...f.binding, prompt: 'go' } };
  await assert.rejects(() => launchCliRequest(request, { ...f.context, ownerThreadId: 'another' }), /identity/);
  assert.equal(fs.existsSync(f.store.locator(f.binding)), false);
  fs.writeFileSync(f.profilePath, JSON.stringify({ ...f.profile, OPENAI_API_KEY: 'SHOULD-NOT-BE-SAVED' }));
  await assert.rejects(() => launchCliRequest(request, f.context), /credential|profile/);
  assert.equal(fs.existsSync(f.store.locator(f.binding)), false);
});
test('stop-only-owned-process rejects wrong fingerprint without stopping the CLI', async t => {
  const { launchCliRequest } = await bridge(); const f = fixture(t, 'gate');
  const first = await launchCliRequest({ schemaVersion: 1, requestId: 'one', action: 'cli.start', input: { ...f.binding, prompt: 'go' } }, f.context);
  await until(() => f.store.read(f.binding).sessionId);
  await assert.rejects(() => launchCliRequest({ schemaVersion: 1, requestId: 'stop-wrong', action: 'cli.stop', input: { ...f.binding, stateSha256: 'wrong', reason: 'user stopped' } }, f.context), /fingerprint/);
  assert.equal(fs.existsSync(first.resultPath), false);
  const state = f.store.read(f.binding);
  const answer = await launchCliRequest({ schemaVersion: 1, requestId: 'stop-right', action: 'cli.stop', input: { ...f.binding, stateSha256: digest(state), expectedSessionId: state.sessionId, reason: 'user stopped' } }, f.context);
  assert.equal(answer.status, 'stop-requested');
  await until(() => fs.existsSync(first.resultPath)); assert.equal(f.store.readResult(f.binding, 1).status, 'stopped');
});
