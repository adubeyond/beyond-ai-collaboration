import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createTestWorkspace } from './lib/test-workspace.mjs';
import { CliTaskStore } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { executeRuntimeRequest } from '../模板交付包/scripts/runtime/control-runtime.mjs';
import { WorkbenchTransactionStore } from '../模板交付包/scripts/runtime/workbench-transaction.mjs';

// Runtime-action regression only: fixture evidence stands in for facts already
// checked by a PM. This does not test an agent decision or desktop delivery.
// No runner, CLI bridge, process launcher, acceptance or acknowledgement is used.
const projectId = 'shared-recovery-fixture';
const firstTime = '2026-10-18T00:54:00.000Z';
const recoveryTime = '2026-10-18T01:01:00.000Z';
const laterTime = '2026-10-18T01:10:00.000Z';
const allowedActions = new Set([
  'workbench.register', 'workbench.update', 'workbench.snapshot',
  'workbench.inspect', 'worker-result.enqueue', 'worker-result.list',
]);

function treeBytes(root) {
  const entries = {};
  if (!fs.existsSync(root)) return entries;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'fixture must not follow links');
      const relative = path.relative(root, file).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        entries[`${relative}/`] = null;
        visit(file);
      } else {
        assert.equal(entry.isFile(), true);
        entries[relative] = fs.readFileSync(file).toString('base64');
      }
    }
  }
  visit(root);
  return entries;
}

function fixture() {
  // The shared helper owns and identity-checks one OS temporary directory before
  // cleanup, including when an assertion fails. No real project path is accepted.
  const root = createTestWorkspace('beyond-shared-recovery-');
  const local = path.join(root, 'local');
  fs.mkdirSync(path.join(local, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(local, 'projects', `${projectId}.md`),
    `---\nid: ${projectId}\npath: ${root}\nhost_id: local\ncodex_project_id: fixture-desktop\n---\n`);
  fs.writeFileSync(path.join(root, 'AGENTS.md'),
    `<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: ${projectId} -->\n`);
  fs.writeFileSync(path.join(local, '当前工作台.md'), '# Fixture workbench\n\nUser-owned notes remain intact.\n');
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(evidenceRoot);
  const oldDecision = path.join(evidenceRoot, 'pm-old-pause-not-adopted.md');
  fs.writeFileSync(oldDecision,
    'Fixture PM decision: the old first-run pause is not adopted. Keep its pending receipt as evidence; both business tasks remain active.\n');
  const evidenceA = path.join(evidenceRoot, 'task-a-recovery.md');
  const evidenceB = path.join(evidenceRoot, 'task-b-recovery.md');
  fs.writeFileSync(evidenceA, 'Fixture verified fact: A access restored; build/typecheck passed; B contract remains outstanding.\n');
  fs.writeFileSync(evidenceB, 'Fixture verified fact: B access restored; implementation and contract validation still in progress.\n');

  const actions = [];
  const context = { controlRoot: root, executionRoot: root, ownerThreadId: 'pm-fixture' };
  function call(action, input) {
    assert.ok(allowedActions.has(action), `unexpected action: ${action}`);
    actions.push(action);
    return executeRuntimeRequest({
      schemaVersion: 1, requestId: `fixture-${actions.length}`, action, input,
      codexHome: path.join(root, 'isolated-codex-home'),
    }, context).result;
  }
  function store() {
    return new WorkbenchTransactionStore({
      runtimeRoot: path.join(local, 'runtime', 'workbench'),
      viewPath: path.join(local, '当前工作台.md'),
      historyRoot: path.join(local, 'history', 'workbench'), readOnly: true,
    });
  }

  // Only local store metadata is seeded. beginRun records an intent; no manager,
  // native session, prompt dispatch, network request or child process is started.
  const cli = new CliTaskStore({ controlRoot: root });
  const bindings = {};
  for (const suffix of ['a', 'b']) {
    const taskId = `task-${suffix}`;
    const profile = { provider: 'claude', mode: 'interactive', model: `fixture-model-${suffix}` };
    const profilePath = path.join(root, `profile-${suffix}.json`);
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n');
    const binding = {
      projectId, taskId, ownerThreadId: `worker-${suffix}`, ownerTurnId: `turn-${suffix}`,
      executionRoot: root, profilePath, taskMode: 'assist',
      contract: { goal: `business result ${suffix}`, boundaries: 'temporary fixture only',
        acceptance: 'business result checked separately', factEntries: [], skillEntries: [] },
    };
    bindings[suffix] = binding;
    cli.create(binding);
    const run = cli.beginRun(binding, {
      requestId: `initial-${suffix}`, prompt: 'fixture metadata only; never dispatched',
      expectedRunNumber: 0, expectedSessionId: null, profile,
    });
    cli.bindSession(run, `fixture-session-${suffix}`);
    call('workbench.register', {
      projectId, taskId, task: `Business task ${suffix.toUpperCase()}`, worker: `worker-${suffix}`,
      status: '进行中', progress: `${suffix.toUpperCase()} shared access blocked; original Worker continues diagnosis`,
      pause: `Not paused; old pause not adopted: ${oldDecision}`, result: cli.locator(binding), updatedAt: firstTime,
    });
  }
  call('workbench.snapshot', {
    operationId: 'initial-summary', expectedSnapshot: null, status: '进行中',
    mainline: 'Deliver A and B business results', problem: 'A and B shared access blocked',
    evidence: oldDecision, next: 'Original Workers continue within their existing sessions', updatedAt: firstTime,
  });
  // Rejection is PM evidence, not an invented receipt state. The real receipt
  // schema remains unchanged and is deliberately never accepted or acknowledged.
  call('worker-result.enqueue', {
    projectId, taskId: 'task-b', sourceThreadId: 'pm-fixture', workerThreadId: 'worker-b',
    businessState: '已暂停', finalText: '已暂停\nOld first-run access failure; no session was bound at that earlier time.',
    createdAt: '2026-10-17T16:55:53.538Z',
  });
  const initial = store().snapshot();
  const immutableRoots = [path.join(local, 'runtime', 'cli-tasks'), path.join(local, 'runtime', 'worker-results'), evidenceRoot];
  const immutableBytes = immutableRoots.map(treeBytes);
  const profiles = ['a', 'b'].map(suffix => fs.readFileSync(path.join(root, `profile-${suffix}.json`)));
  return { root, local, call, store, cli, bindings, actions, initial, evidenceA, evidenceB,
    immutableRoots, immutableBytes, profiles };
}

function updateA(f) {
  const update = {
    projectId, operationId: 'recover-a', taskId: 'task-a', expectedStatus: '进行中', status: '进行中',
    progress: 'A access restored; build/typecheck passed; still awaiting B contract',
    pause: 'Not paused; B shared access remains blocked', result: f.evidenceA, updatedAt: recoveryTime,
  };
  const taskResult = f.call('workbench.update', update);
  const snapshot = {
    operationId: 'partial-recovery-summary', expectedSnapshot: f.store().snapshot().projectSnapshot,
    status: '进行中', mainline: 'Deliver A and B business results',
    problem: 'A access restored; B shared access remains blocked; B contract outstanding',
    evidence: f.evidenceA, next: 'A waits for contract; original B Worker continues diagnosis in the same session',
    decision: 'No new session, model switch or acceptance', updatedAt: recoveryTime,
  };
  const snapshotResult = f.call('workbench.snapshot', snapshot);
  return { update, taskResult, snapshot, snapshotResult };
}

function assertPreserved(f) {
  for (const [index, root] of f.immutableRoots.entries()) {
    assert.deepEqual(treeBytes(root), f.immutableBytes[index], `untouched evidence: ${root}`);
  }
  for (const [index, suffix] of ['a', 'b'].entries()) {
    const state = f.cli.read(f.bindings[suffix]);
    assert.equal(state.sessionId, `fixture-session-${suffix}`);
    assert.equal(state.runNumber, 1);
    assert.equal(state.taskMode, 'assist');
    assert.equal(state.currentResultPath, null);
    assert.equal(state.managerPid, null);
    const run = JSON.parse(fs.readFileSync(path.join(f.cli.runDir(f.bindings[suffix], 1), 'run.json'), 'utf8'));
    assert.equal(run.profile.model, `fixture-model-${suffix}`);
    assert.deepEqual(fs.readFileSync(state.profilePath), f.profiles[index]);
  }
  const pending = f.call('worker-result.list', { projectId, taskId: 'task-b' });
  assert.equal(pending.count, 1);
  assert.equal(pending.records[0].businessState, '已暂停');
  assert.equal(pending.records[0].createdAt, '2026-10-17T16:55:53.538Z');
  const store = f.store();
  assert.equal(store.history('2026-10').records.length, 0);
  assert.equal(store.snapshot().recentMainlineResults.length, 0);
  assert.deepEqual(Object.values(store.snapshot().tasks).map(task => task.status), ['进行中', '进行中']);
  assert.deepEqual(store.recoveryStatus().pendingTransactions, []);
  assert.equal(store.recoveryStatus().viewMatchesState, true);
  assert.match(store.view(), /User-owned notes remain intact\./);
  assert.match(store.view(), new RegExp(`机器状态修订：${store.snapshot().revision}。`));
  const inspection = f.call('workbench.inspect', { projectId });
  assert.equal(inspection.activeTaskCount, 2);
  assert.equal(inspection.pendingReceiptCount, 1);
  assert.equal(inspection.viewMatchesState, true);
  assert.equal(f.actions.some(action => /accept|pause|ack|^cli\./.test(action)), false);
}

test('partial shared recovery updates A and its summary without clearing B or consuming an old pause', () => {
  const f = fixture();
  updateA(f);
  const state = f.store().snapshot();
  assert.equal(state.revision, f.initial.revision + 2);
  assert.deepEqual(state.tasks['task-b'], f.initial.tasks['task-b']);
  assert.equal(state.tasks['task-a'].worker, 'worker-a');
  assert.equal(state.tasks['task-a'].status, '进行中');
  assert.match(state.tasks['task-a'].progress, /A access restored/);
  assert.match(state.projectSnapshot.problem, /B shared access remains blocked/);
  assert.match(f.store().view(), /A access restored/);
  assert.match(f.store().view(), /B shared access remains blocked/);
  assertPreserved(f);
});

test('same operation replay is byte-stable and changed reuse is rejected', () => {
  const f = fixture();
  const recovered = updateA(f);
  const before = treeBytes(f.root);
  assert.deepEqual(f.call('workbench.update', recovered.update), recovered.taskResult);
  // Replay retains its old expectedSnapshot; the committed operation wins before
  // the snapshot CAS check, exactly as the existing runtime contract specifies.
  assert.deepEqual(f.call('workbench.snapshot', recovered.snapshot), recovered.snapshotResult);
  assert.deepEqual(treeBytes(f.root), before);
  assert.throws(() => f.call('workbench.update', { ...recovered.update, progress: 'different payload' }), /operation id reused with different input/);
  assert.throws(() => f.call('workbench.snapshot', { ...recovered.snapshot, problem: 'different payload' }), /operation id reused with different input/);
  assert.deepEqual(treeBytes(f.root), before);
  assertPreserved(f);
});

test('later B recovery refreshes B and the project snapshot while business work and CLI ownership continue', () => {
  const f = fixture();
  updateA(f);
  const afterA = f.store().snapshot();
  f.call('workbench.update', {
    projectId, operationId: 'recover-b', taskId: 'task-b', expectedStatus: '进行中', status: '进行中',
    progress: 'B access restored; implementation and contract validation in progress',
    pause: 'Not paused; business acceptance outstanding', result: f.evidenceB, updatedAt: laterTime,
  });
  f.call('workbench.snapshot', {
    operationId: 'both-recovered-summary', expectedSnapshot: afterA.projectSnapshot, status: '进行中',
    mainline: 'Deliver A and B business results', problem: 'Shared access restored for A and B; B contract validation outstanding',
    evidence: `${f.evidenceA}; ${f.evidenceB}`, next: 'Original Workers complete contract integration and business acceptance',
    decision: 'No acceptance implied by infrastructure recovery', updatedAt: laterTime,
  });
  const state = f.store().snapshot();
  assert.equal(state.revision, afterA.revision + 2);
  assert.deepEqual(state.tasks['task-a'], afterA.tasks['task-a']);
  assert.equal(state.tasks['task-b'].worker, 'worker-b');
  assert.match(state.tasks['task-b'].progress, /B access restored/);
  assert.equal(state.projectSnapshot.status, '进行中');
  assert.match(state.projectSnapshot.problem, /contract validation outstanding/);
  assert.match(f.store().view(), /Shared access restored for A and B/);
  assertPreserved(f);
});

test('unknown task, task-state mismatch and stale or absent snapshot CAS leave all fixture bytes unchanged', () => {
  const f = fixture();
  const recovered = updateA(f);
  const before = treeBytes(f.root);
  const failures = [
    ['workbench.update', { ...recovered.update, operationId: 'unknown-task', taskId: 'not-registered' }, /active task is missing/],
    ['workbench.update', { ...recovered.update, operationId: 'wrong-task-state', expectedStatus: '已暂停' }, /unexpected task state/],
    ['workbench.snapshot', { ...recovered.snapshot, operationId: 'stale-snapshot' }, /project snapshot changed/],
  ];
  const { expectedSnapshot, ...withoutSnapshot } = recovered.snapshot;
  failures.push(['workbench.snapshot', { ...withoutSnapshot, operationId: 'missing-snapshot' }, /expectedSnapshot is required/]);
  for (const [action, input, expectedError] of failures) {
    assert.throws(() => f.call(action, input), expectedError);
    assert.deepEqual(treeBytes(f.root), before, `${input.operationId} must not commit or alter other evidence`);
  }
  assertPreserved(f);
});
