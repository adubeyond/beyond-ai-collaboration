import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const moduleUrl = new URL('../模板交付包/scripts/cli/cli-task-store.mjs', import.meta.url);
const load = () => import(moduleUrl);
const id = { projectId: 'project-a', taskId: 'goal-a', ownerThreadId: 'thread-a' };
const binding = root => ({ ...id, ownerTurnId: 'turn-a', executionRoot: root, profilePath: path.join(root, 'profile.json'), taskMode: 'assist', contract: { goal: 'deliver a tested file', boundaries: 'temporary project only', acceptance: 'local tests pass', factEntries: [], skillEntries: [] } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const req = { requestId: 'first', prompt: 'make a file', expectedRunNumber: 0, expectedSessionId: null };
function finish(store, run, patch = {}) {
  return store.finishRun(run, { status: 'failed', exitCode: 1, finalText: '', error: 'spawn failed', ...patch });
}

test('first-run-can-fail-without-session and survives reopening', async t => {
  const { CliTaskStore } = await load();
  const root = fixture(t), store = new CliTaskStore({ controlRoot: root });
  store.create(binding(root));
  const run = store.beginRun(id, req);
  assert.equal(run.sessionId, null);
  finish(store, run);
  assert.equal(new CliTaskStore({ controlRoot: root }).readResult(id, 1).status, 'failed');
  assert.equal(store.read(id).runNumber, 1);
  assert.equal(store.read(id).managerPid, null);
});
test('same-request-replays while changed content conflicts without writes', async t => {
  const { CliTaskStore } = await load();
  const root = fixture(t), store = new CliTaskStore({ controlRoot: root });
  store.create(binding(root));
  const first = store.beginRun(id, req);
  assert.deepEqual(store.beginRun(id, req), first);
  const before = store.read(id);
  assert.throws(() => store.beginRun(id, { ...req, prompt: 'different' }), /conflict/);
  assert.deepEqual(store.read(id), before);
});
test('owner-project-session-mismatch-rejected and stale result cannot replace current', async t => {
  const { CliTaskStore, sha256File } = await load();
  const root = fixture(t), store = new CliTaskStore({ controlRoot: root });
  store.create(binding(root));
  const first = store.beginRun(id, req);
  store.bindSession(first, 'session-one');
  assert.throws(() => store.bindSession(first, 'session-other'), /session/);
  finish(store, first, { status: 'completed', exitCode: 0, finalText: 'partial' });
  assert.throws(() => store.readResult({ ...id, ownerThreadId: 'other' }, 1), /identity/);
  assert.throws(() => store.readResult({ ...id, projectId: 'project-b' }, 1), /not found/);
  store.recordReview({ ...id, runNumber: 1, resultSha256: sha256File(first.resultPath), decision: 'continue', evidenceLocator: 'file:partial', conclusion: 'missing test', reviewedAt: new Date().toISOString() });
  assert.throws(() => store.beginRun(id, { ...req, requestId: 'wrong', expectedRunNumber: 1, expectedSessionId: 'wrong' }), /session/);
  const second = store.beginRun(id, { ...req, requestId: 'second', expectedRunNumber: 1, expectedSessionId: 'session-one' });
  assert.equal(second.runNumber, 2);
  assert.throws(() => finish(store, first), /stale/);
  assert.equal(store.read(id).runNumber, 2);
});
test('review and notification cannot masquerade as each other or overwrite a different review', async t => {
  const { CliTaskStore, sha256File } = await load();
  const root = fixture(t), store = new CliTaskStore({ controlRoot: root });
  store.create(binding(root)); const run = store.beginRun(id, req); finish(store, run);
  assert.equal(store.claimNotification(id, 1).claimed, true);
  assert.equal(store.claimNotification(id, 1).claimed, false);
  store.finishNotification(id, 1, { status: 'delivery-unknown', error: 'timeout' });
  assert.equal(store.readReview(id, 1), null);
  const review = { ...id, runNumber: 1, resultSha256: sha256File(run.resultPath), decision: 'continue', evidenceLocator: 'file:failure', conclusion: 'fix invocation', reviewedAt: new Date().toISOString() };
  store.recordReview(review);
  assert.deepEqual(store.readReview(id, 1), review);
  assert.throws(() => store.recordReview({ ...review, conclusion: 'changed' }), /conflict/);
});
test('linked-directory-escape-rejected and unsafe identifiers cannot write', async t => {
  const { CliTaskStore } = await load();
  const root = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const store = new CliTaskStore({ controlRoot: root });
  assert.throws(() => store.create({ ...binding(root), taskId: '../escape' }), /identifier/);
  const base = path.join(root, 'local/runtime/cli-tasks'); fs.mkdirSync(base, { recursive: true });
  fs.symlinkSync(outside, path.join(base, 'project-a'), 'junction');
  assert.throws(() => store.create(binding(root)), /link|escape/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('different-concurrent-resume-rejected across two real processes', async t => {
  const { CliTaskStore, sha256File } = await load();
  const root = fixture(t), store = new CliTaskStore({ controlRoot: root });
  store.create(binding(root)); const first = store.beginRun(id, req); store.bindSession(first, 'session-one'); finish(store, first);
  store.recordReview({ ...id, runNumber: 1, resultSha256: sha256File(first.resultPath), decision: 'continue', evidenceLocator: 'file:failed', conclusion: 'fix', reviewedAt: new Date().toISOString() });
  const gate = path.join(root, 'gate');
  function child(n) {
    const script = `import fs from 'node:fs'; import {CliTaskStore} from ${JSON.stringify(moduleUrl.href)}; const s=new CliTaskStore({controlRoot:${JSON.stringify(root)}}); while(!fs.existsSync(${JSON.stringify(gate)})) await new Promise(r=>setTimeout(r,5)); try{s.beginRun(${JSON.stringify(id)},{requestId:'request-${n}',prompt:'correction-${n}',expectedRunNumber:1,expectedSessionId:'session-one'});process.stdout.write('won');}catch(e){process.stdout.write('rejected:'+e.message);}`;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script]);
    let out = ''; proc.stdout.on('data', b => out += b);
    return new Promise((resolve, reject) => { proc.on('error', reject); proc.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`child exited ${code}`))); });
  }
  const children = [child(1), child(2)]; fs.writeFileSync(gate, 'go');
  const results = await Promise.all(children);
  assert.equal(results.filter(x => x === 'won').length, 1);
  assert.equal(results.filter(x => x.startsWith('rejected:')).length, 1);
  assert.equal(store.read(id).runNumber, 2);
});
