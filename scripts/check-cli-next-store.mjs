import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliTaskStore, atomicJson, digest, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { currentProcessIdentity } from '../模板交付包/scripts/cli/process-identity.mjs';

const contract = { goal: 'deliver the isolated fixture', boundaries: 'only fixture files; no publication', acceptance: 'fixture acceptance succeeds', factEntries: ['fixture:facts'], skillEntries: [] };
const stage = { goal: 'create the fixture table', acceptance: 'table schema matches the approved fixture' };
const revised = { ...contract, boundaries: 'approved fixture code edits; no publication' };
function fixture(t, { firstStage } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-next-store-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('beyond-cli-next-store-'));
    fs.rmSync(resolved, { recursive: true });
  });
  const binding = { projectId: 'next-project', taskId: 'next-task', ownerThreadId: 'owner', ownerTurnId: 'start-turn', taskMode: 'assist', executionRoot: root, profilePath: path.join(root, 'profile.json'), contract: structuredClone(contract), configuration: { provider: 'codex', model: 'fixture-model', effort: 'high' } };
  const store = new CliTaskStore({ controlRoot: root }); store.create(binding);
  const firstOptions = { requestId: 'first', prompt: 'perform the current fixture step', expectedRunNumber: 0, expectedSessionId: null, ...(firstStage ? { stage: firstStage } : {}) };
  const first = store.beginRun(binding, firstOptions); store.bindSession(first, 'fixture-session');
  const next = { requestId: 'next', prompt: 'create the approved table next', stage: structuredClone(stage), expectedRunNumber: 1, expectedSessionId: 'fixture-session', ownerTurnId: 'queue-turn' };
  const finish = (run = first, status = 'completed') => store.finishRun(run, { status, sessionId: 'fixture-session', finalText: 'fixture result' });
  const reviewInput = (run = first, decision = 'continue') => ({ projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: binding.ownerThreadId, runNumber: run.runNumber, resultSha256: sha256File(run.resultPath), decision, evidenceLocator: 'fixture:review', conclusion: 'fixture checked', reviewedAt: '2026-10-16T01:00:00.000Z' });
  const review = (run = first, decision = 'continue') => store.recordReview(reviewInput(run, decision));
  const consume = (options = next) => ({ ...options, continuationId: options.requestId, ownerTurnId: 'resume-turn' });
  return { root, binding, store, first, firstOptions, next, finish, reviewInput, review, consume };
}
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).filter(name => fs.statSync(path.join(directory, name)).isFile()).sort().map(name => [name, sha256File(path.join(directory, name))]));
}
function noWrites(f, action, error) {
  const before = snapshot(f.store.taskDir(f.binding));
  assert.throws(action, error);
  assert.deepEqual(snapshot(f.store.taskDir(f.binding)), before);
}

test('queue while running stores only one durable slot without changing current execution', t => {
  const f = fixture(t); f.store.setProcess(f.first, { ...currentProcessIdentity(), token: crypto.randomUUID() });
  const before = f.store.read(f.binding), runBefore = snapshot(f.store.runDir(f.binding, 1));
  const queued = f.store.queueContinuation(f.binding, f.next), after = f.store.read(f.binding);
  assert.equal(queued.status, 'pending'); assert.equal(queued.requestId, f.next.requestId);
  for (const key of ['status', 'runNumber', 'sessionId', 'processIdentity', 'managerPid', 'contract', 'effectiveContract', 'configuration', 'ownerTurnId', 'currentResultPath']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(snapshot(f.store.runDir(f.binding, 1)), runBefore);
  assert.deepEqual(after.continuations, [queued]);
  assert.equal(fs.existsSync(f.store.runDir(f.binding, 2)), false);
  assert.deepEqual(new CliTaskStore({ controlRoot: f.root }).readContinuation(f.binding, 1), queued);
  noWrites(f, () => f.store.beginRun(f.binding, f.consume()), /active run/);
});

test('queue retries are exact and replacement preserves superseded history', t => {
  const f = fixture(t), first = f.store.queueContinuation(f.binding, f.next), before = snapshot(f.store.taskDir(f.binding));
  assert.deepEqual(f.store.queueContinuation(f.binding, f.next), first);
  assert.deepEqual(f.store.queueContinuation(f.binding, { ...f.next, ownerTurnId: 'later-owner-turn' }), first);
  assert.equal(f.store.readContinuation(f.binding, 1).ownerTurnId, 'queue-turn');
  assert.deepEqual(snapshot(f.store.taskDir(f.binding)), before);
  for (const patch of [{ prompt: 'different' }, { stage: { ...stage, goal: 'different' } }, { expectedSessionId: 'different-session' }, { expectedRunNumber: 2 }]) noWrites(f, () => f.store.queueContinuation(f.binding, { ...f.next, ...patch }), /request conflict/);
  noWrites(f, () => f.store.queueContinuation(f.binding, { ...f.next, requestId: 'replacement' }), /replacement/);
  noWrites(f, () => f.store.queueContinuation(f.binding, { ...f.next, requestId: 'replacement', replacesRequestId: 'wrong' }), /replacement/);
  const options = { ...f.next, requestId: 'replacement', replacesRequestId: 'next', prompt: 'revised approved next step' };
  const replacement = f.store.queueContinuation(f.binding, options), history = f.store.read(f.binding).continuations;
  assert.equal(history.length, 2); assert.equal(history[0].status, 'superseded'); assert.equal(history[0].supersededBy, 'replacement');
  assert.deepEqual(f.store.readContinuation(f.binding, 1), replacement);
  assert.equal(f.store.queueContinuation(f.binding, f.next).status, 'superseded');
  assert.deepEqual(f.store.queueContinuation(f.binding, options), replacement);
  f.finish(); f.review();
  const run = f.store.beginRun(f.binding, f.consume(options));
  assert.equal(run.requestId, 'replacement'); assert.equal(run.runNumber, 2);
});

test('queue validates stage, owner, session, run, request IDs and forbids configuration overrides', t => {
  const f = fixture(t);
  for (const patch of [{ stage: undefined }, { stage: null }, { stage: { goal: 'x' } }, { stage: { ...stage, boundaries: 'wider' } }, { stage: { ...stage, acceptance: '' } }, { prompt: ' ' }, { ownerTurnId: undefined }, { expectedRunNumber: 0 }, { expectedRunNumber: 2 }, { expectedSessionId: 'wrong' }, { requestId: 'first' }, { configuration: {} }, { permissionMode: 'override' }]) noWrites(f, () => f.store.queueContinuation(f.binding, { ...f.next, ...patch }), /stage|prompt|identifier|run|session|fields/);
  noWrites(f, () => f.store.queueContinuation({ ...f.binding, ownerThreadId: 'other' }, f.next), /identity/);
  noWrites(f, () => f.store.readContinuation({ ...f.binding, ownerThreadId: 'other' }, 1), /identity/);
  assert.equal(f.store.readContinuation(f.binding, 1), null);
});

test('only exact reviewed continuation consumes the slot atomically and pins its stage', t => {
  const f = fixture(t); f.store.queueContinuation(f.binding, f.next); f.finish();
  noWrites(f, () => f.store.beginRun(f.binding, f.consume()), /review/);
  f.review();
  noWrites(f, () => f.store.beginRun(f.binding, { requestId: 'bypass', prompt: 'bypass', expectedRunNumber: 1, expectedSessionId: 'fixture-session' }), /pending continuation/);
  for (const patch of [{ requestId: 'wrong' }, { continuationId: 'wrong' }, { prompt: 'wrong' }, { stage: undefined }, { stage: { ...stage, goal: 'wrong' } }, { expectedRunNumber: 0 }, { expectedSessionId: 'wrong' }]) noWrites(f, () => f.store.beginRun(f.binding, { ...f.consume(), ...patch }), /continuation|stale run|session/);
  const oldRun = snapshot(f.store.runDir(f.binding, 1)), run = f.store.beginRun(f.binding, f.consume());
  assert.equal(run.runNumber, 2); assert.equal(run.sessionId, 'fixture-session'); assert.equal(run.continuationId, 'next');
  assert.equal(run.ownerTurnId, 'resume-turn'); assert.deepEqual(run.stage, stage); assert.deepEqual(run.effectiveContract, contract);
  const item = f.store.readContinuation(f.binding, 1);
  assert.equal(item.status, 'consumed'); assert.equal(item.targetRunNumber, 2); assert.equal(item.ownerTurnId, 'queue-turn');
  assert.deepEqual(snapshot(f.store.runDir(f.binding, 1)), oldRun);
  const before = snapshot(f.store.taskDir(f.binding));
  assert.deepEqual(f.store.beginRun(f.binding, f.consume()), run);
  assert.deepEqual(f.store.queueContinuation(f.binding, f.next), item);
  assert.deepEqual(snapshot(f.store.taskDir(f.binding)), before);
  assert.equal(fs.existsSync(f.store.runDir(f.binding, 3)), false);
});

for (const faultAt of ['afterRequest', 'afterRun', 'afterInput']) test(`continuation crash ${faultAt} replays the same intent exactly once`, t => {
  const f = fixture(t); f.store.queueContinuation(f.binding, f.next); f.finish(); f.review();
  const prior = snapshot(f.store.runDir(f.binding, 1));
  assert.throws(() => f.store.beginRun(f.binding, { ...f.consume(), faultAt }), /injected fault/);
  assert.equal(f.store.read(f.binding).runNumber, 1); assert.equal(f.store.readContinuation(f.binding, 1).status, 'pending');
  noWrites(f, () => f.store.beginRun(f.binding, { ...f.consume(), prompt: 'different' }), /request conflict/);
  noWrites(f, () => f.store.cancelContinuation(f.binding, { requestId: 'next', reason: 'late cancellation' }), /dispatch intent/);
  noWrites(f, () => f.store.queueContinuation(f.binding, { ...f.next, requestId: 'replacement', replacesRequestId: 'next' }), /dispatch intent/);
  const run = f.store.beginRun(f.binding, f.consume());
  assert.deepEqual(f.store.beginRun(f.binding, f.consume()), run);
  assert.equal(f.store.read(f.binding).runNumber, 2); assert.equal(f.store.readContinuation(f.binding, 1).targetRunNumber, 2);
  assert.equal(f.store.read(f.binding).continuations.length, 1); assert.deepEqual(snapshot(f.store.runDir(f.binding, 1)), prior);
});

test('pause retains the pending slot until an explicit continuation review', t => {
  const f = fixture(t); const item = f.store.queueContinuation(f.binding, f.next); f.finish(); f.review(f.first, 'pause');
  assert.deepEqual(f.store.readContinuation(f.binding, 1), item);
  noWrites(f, () => f.store.beginRun(f.binding, f.consume()), /review/);
  const review = { ...f.reviewInput(), supersedesReviewSha256: sha256File(path.join(f.store.runDir(f.binding, 1), 'review.json')), authorizationLocator: 'fixture:resume-authorized' };
  f.store.recordReview(review); assert.equal(f.store.beginRun(f.binding, f.consume()).runNumber, 2);
});

for (const decision of ['accept', 'close']) test(`${decision} review cancels pending and repeat repairs its state-write crash`, t => {
  const f = fixture(t); f.store.queueContinuation(f.binding, f.next); f.finish();
  const review = f.reviewInput(f.first, decision), rename = fs.renameSync;
  let failed = false;
  fs.renameSync = (source, destination) => {
    if (destination === f.store.locator(f.binding) && !failed) { failed = true; throw new Error('injected state write fault'); }
    return rename(source, destination);
  };
  try { assert.throws(() => f.store.recordReview(review), /state write fault/); }
  finally { fs.renameSync = rename; }
  assert.equal(f.store.readContinuation(f.binding, 1).status, 'pending');
  assert.deepEqual(f.store.readReview(f.binding, 1), review);
  assert.deepEqual(f.store.recordReview(review), review);
  assert.equal(f.store.readContinuation(f.binding, 1), null);
  const state = f.store.read(f.binding), cancelled = state.continuations[0];
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.reviewSha256, digest(review));
  assert.equal(state.status, 'completed'); assert.equal(state.runNumber, 1);
  const before = snapshot(f.store.taskDir(f.binding)); f.store.recordReview(review); assert.deepEqual(snapshot(f.store.taskDir(f.binding)), before);
  noWrites(f, () => f.store.queueContinuation(f.binding, { ...f.next, requestId: 'new' }), /final review/);
  noWrites(f, () => f.store.beginRun(f.binding, f.consume()), /continuation/);
});

test('explicit cancellation retains history and permits ordinary resume without rollback', t => {
  const f = fixture(t); f.store.queueContinuation(f.binding, f.next);
  const replacement = { ...f.next, requestId: 'replacement', replacesRequestId: 'next' };
  f.store.queueContinuation(f.binding, replacement);
  noWrites(f, () => f.store.cancelContinuation(f.binding, { requestId: 'replacement', reason: '' }), /reason/);
  noWrites(f, () => f.store.cancelContinuation({ ...f.binding, ownerThreadId: 'other' }, { requestId: 'replacement', reason: 'cancel' }), /identity/);
  noWrites(f, () => f.store.cancelContinuation(f.binding, { requestId: 'next', reason: 'cancel' }), /not pending/);
  const cancelled = f.store.cancelContinuation(f.binding, { requestId: 'replacement', reason: 'owner changed priority' });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(f.store.readContinuation(f.binding, 1), null);
  assert.deepEqual(f.store.read(f.binding).continuations.map(item => item.status), ['superseded', 'cancelled']);
  assert.deepEqual(f.store.cancelContinuation(f.binding, { requestId: 'replacement', reason: 'owner changed priority' }), cancelled);
  f.finish(); f.review();
  const run = f.store.beginRun(f.binding, { requestId: 'ordinary', prompt: 'ordinary approved step', expectedRunNumber: 1, expectedSessionId: 'fixture-session' });
  assert.equal(run.runNumber, 2); assert.equal(run.stage, undefined); assert.deepEqual(run.effectiveContract, contract);
});

test('managed stop cancels pending before publishing the stop request and preserves run input', t => {
  const f = fixture(t); f.store.setProcess(f.first, { ...currentProcessIdentity(), token: crypto.randomUUID() }); f.store.queueContinuation(f.binding, f.next);
  const before = snapshot(f.store.runDir(f.binding, 1)), state = f.store.read(f.binding);
  const stopped = f.store.requestStop(f.binding, { requestId: 'stop', reason: 'owner requests stop', expectedSessionId: 'fixture-session', stateSha256: digest(state) });
  assert.deepEqual(stopped, { status: 'stop-requested', runNumber: 1 });
  assert.equal(f.store.readContinuation(f.binding, 1), null);
  const after = f.store.read(f.binding); assert.equal(after.status, state.status); assert.deepEqual(after.processIdentity, state.processIdentity);
  assert.equal(after.continuations[0].status, 'cancelled'); assert.equal(after.continuations[0].stopRequestId, 'stop');
  for (const [name, hash] of Object.entries(before)) assert.equal(sha256File(path.join(f.store.runDir(f.binding, 1), name)), hash);
  const cancelledSnapshot = snapshot(f.store.taskDir(f.binding));
  assert.deepEqual(f.store.queueContinuation(f.binding, { ...f.next, ownerTurnId: 'after-stop-turn' }), after.continuations[0]);
  assert.equal(f.store.readContinuation(f.binding, 1), null);
  assert.deepEqual(snapshot(f.store.taskDir(f.binding)), cancelledSnapshot);
  f.finish(f.first, 'stopped'); f.review();
  noWrites(f, () => f.store.beginRun(f.binding, f.consume()), /continuation/);
  // Only a new explicit request can establish a new slot after stop; an old
  // request replay remains cancelled even when a later pending slot exists.
  const options = { ...f.next, requestId: 'new-after-stop', ownerTurnId: 'new-authorization-turn' };
  const newlyQueued = f.store.queueContinuation(f.binding, options), beforeReplay = snapshot(f.store.taskDir(f.binding));
  assert.deepEqual(f.store.queueContinuation(f.binding, { ...f.next, ownerTurnId: 'later-retry-turn' }), after.continuations[0]);
  assert.deepEqual(f.store.readContinuation(f.binding, 1), newlyQueued);
  assert.deepEqual(snapshot(f.store.taskDir(f.binding)), beforeReplay);
  const nextRun = f.store.beginRun(f.binding, f.consume(options));
  assert.equal(nextRun.requestId, 'new-after-stop'); assert.equal(nextRun.runNumber, 2);
  assert.deepEqual(f.store.read(f.binding).continuations.map(item => item.status), ['cancelled', 'consumed']);
});

test('pending continuations prevent owner transfer and in-progress transfer prevents slot mutations', t => {
  const f = fixture(t); f.store.queueContinuation(f.binding, f.next); f.finish();
  const transfer = { operationId: 'handoff', projectId: f.binding.projectId, taskId: f.binding.taskId, taskMode: 'assist', fromOwnerThreadId: 'owner', toOwnerThreadId: 'successor', expectedRunNumber: 1, expectedSessionId: 'fixture-session', expectedStateSha256: digest(f.store.read(f.binding)), expectedResultSha256: sha256File(f.first.resultPath), authorizationLocator: 'fixture:transfer-authorized' };
  noWrites(f, () => f.store.beginTransfer(f.binding, transfer), /pending continuation/);
  const dir = f.store.transferDirectory(f.binding, 'handoff'); fs.mkdirSync(dir, { recursive: true }); atomicJson(path.join(dir, 'transfer.json'), { phase: 'authorized' });
  noWrites(f, () => f.store.queueContinuation(f.binding, f.next), /transfer pending/);
  noWrites(f, () => f.store.cancelContinuation(f.binding, { requestId: 'next', reason: 'cancel' }), /transfer pending/);
  noWrites(f, () => f.store.beginRun(f.binding, f.consume()), /transfer pending/);
});

test('authorized full contract can be queued without taking effect until matching reviewed consumption', t => {
  const f = fixture(t), options = { ...f.next, contract: structuredClone(revised), authorizationLocator: 'fixture:user-approved-edits' };
  const queued = f.store.queueContinuation(f.binding, options);
  assert.deepEqual(queued.contract, revised); assert.deepEqual(f.store.read(f.binding).effectiveContract, contract);
  noWrites(f, () => f.store.queueContinuation(f.binding, { ...f.next, contract: revised }), /authorization/);
  noWrites(f, () => f.store.queueContinuation(f.binding, f.next), /request conflict/);
  f.finish(); f.review();
  noWrites(f, () => f.store.beginRun(f.binding, f.consume()), /contract intent/);
  noWrites(f, () => f.store.beginRun(f.binding, { ...f.consume(options), authorizationLocator: 'fixture:other' }), /contract intent/);
  const run = f.store.beginRun(f.binding, f.consume(options));
  assert.deepEqual(run.effectiveContract, revised); assert.deepEqual(run.stage, stage);
  assert.equal(run.contractUpdate.authorizationLocator, options.authorizationLocator);
  assert.deepEqual(f.store.read(f.binding).contract, contract); assert.deepEqual(f.store.read(f.binding).effectiveContract, revised);
  assert.deepEqual(f.store.read(f.binding).configuration, f.binding.configuration);
});

test('old requests retain their fingerprint and optional stage only changes its run snapshot', t => {
  const f = fixture(t);
  const saved = f.store.readJson(path.join(f.store.taskDir(f.binding), 'requests/first.json'));
  assert.equal(saved.fingerprint, digest(f.firstOptions)); assert.equal(f.first.stage, undefined);
  f.finish(); f.review();
  const options = { requestId: 'ordinary-stage', prompt: 'finish one approved phase', expectedRunNumber: 1, expectedSessionId: 'fixture-session', stage };
  const run = f.store.beginRun(f.binding, options);
  assert.deepEqual(run.stage, stage); assert.deepEqual(run.effectiveContract, contract);
  assert.equal(f.store.read(f.binding).stage, undefined); assert.equal(f.store.read(f.binding).continuations, undefined);
  assert.equal(f.store.readJson(path.join(f.store.taskDir(f.binding), 'requests/ordinary-stage.json')).fingerprint, digest(options));
  assert.deepEqual(f.store.beginRun(f.binding, options), run);
  noWrites(f, () => f.store.beginRun(f.binding, { ...options, stage: { ...stage, goal: 'changed' } }), /request conflict/);
});

test('first-run stage is an immutable snapshot and queued legacy initial contract cannot roll back effective scope', t => {
  const f = fixture(t, { firstStage: stage });
  assert.deepEqual(f.first.stage, stage);
  assert.equal(f.store.readJson(path.join(f.store.taskDir(f.binding), 'requests/first.json')).fingerprint, digest(f.firstOptions));
  f.finish(); f.review();
  const updated = f.store.beginRun(f.binding, { requestId: 'approved-update', prompt: 'approved fixture change', expectedRunNumber: 1, expectedSessionId: 'fixture-session', ownerTurnId: 'authorized-turn', contract: revised, authorizationLocator: 'fixture:authorization' });
  const options = { ...f.next, expectedRunNumber: 2, contract: structuredClone(contract) };
  const item = f.store.queueContinuation(f.binding, options);
  assert.equal(item.contract, undefined); assert.equal(item.authorizationLocator, undefined);
  assert.deepEqual(f.store.read(f.binding).effectiveContract, revised);
  f.finish(updated); f.review(updated);
  const run = f.store.beginRun(f.binding, f.consume(options));
  assert.equal(run.runNumber, 3); assert.deepEqual(run.effectiveContract, revised); assert.deepEqual(run.stage, stage);
  assert.equal(run.contractUpdate, undefined); assert.deepEqual(f.store.read(f.binding).contract, contract);
});

test('queued authorized contract remains deferred across a partial begin and retains its original authority on replay', t => {
  const f = fixture(t), options = { ...f.next, contract: revised, authorizationLocator: 'fixture:authorization' };
  f.store.queueContinuation(f.binding, options); f.finish(); const review = f.review();
  assert.throws(() => f.store.beginRun(f.binding, { ...f.consume(options), faultAt: 'afterInput' }), /injected fault/);
  assert.deepEqual(f.store.read(f.binding).effectiveContract, contract); assert.equal(f.store.readContinuation(f.binding, 1).status, 'pending');
  const run = f.store.beginRun(f.binding, f.consume(options));
  assert.deepEqual(run.contractUpdate, { authorizationLocator: options.authorizationLocator, previousRunNumber: 1, previousContractSha256: digest(contract), reviewSha256: digest(review) });
  assert.deepEqual(f.store.read(f.binding).effectiveContract, revised); assert.equal(f.store.readContinuation(f.binding, 1).status, 'consumed');
});
