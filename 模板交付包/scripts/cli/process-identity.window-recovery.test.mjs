import assert from 'node:assert/strict';
import test from 'node:test';
import { initialRecoveryWindowIsGone, processIsGone } from './process-identity.mjs';

const completedAt = '2026-10-08T16:00:00.000Z';
const completedTicks = BigInt(Date.parse(completedAt)) * 10000n + 621355968000000000n;
const pid = 28640;
const processAt = (offset, executable = 'node.exe') => ({ pid, startedAt: (completedTicks + BigInt(offset)).toString(), path: `C:\\Program Files\\runtime\\${executable}` });
const esrch = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
const eperm = () => { throw Object.assign(new Error('access denied'), { code: 'EPERM' }); };
const registrationTimeout = 'Claude did not register its native session; inspect the visible window';
function options(proof = processAt(10001)) {
  return { signal: () => {}, readProcess: () => ({ ...proof }), platform: 'win32', legacyExitEvidence: { resultError: registrationTimeout, viewExitError: registrationTimeout } };
}
const legacy = (overrides = {}) => initialRecoveryWindowIsGone({ windowPid: pid }, completedAt, { ...options(), ...overrides });

test('legacy recovery accepts a different stable image born after result plus one millisecond', () => {
  let reads = 0;
  assert.equal(legacy({ readProcess: readPid => { assert.equal(readPid, pid); reads++; return processAt(10001); } }), true);
  assert.equal(reads, 2);
});
test('legacy recovery accepts real ESRCH without reading a replacement process', () => {
  assert.equal(legacy({ signal: esrch, legacyExitEvidence: undefined, readProcess: () => assert.fail('unexpected process read') }), true);
});
test('legacy reuse inference is limited to the exact native registration timeout in both saved errors', () => {
  for (const legacyExitEvidence of [undefined, {}, { resultError: 'fetch failed', viewExitError: registrationTimeout },
    { resultError: registrationTimeout, viewExitError: 'fetch failed' }, { resultError: 'unknown', viewExitError: 'unknown' }]) {
    assert.throws(() => legacy({ legacyExitEvidence, readProcess: () => assert.fail('unapproved inference must not read a replacement') }), /not authorized for this failure/);
  }
});
test('legacy recovery refuses an original Powershell image, even when it was born later', () => {
  for (const image of ['powershell.exe', 'PoWeRsHeLl.ExE']) assert.equal(legacy(options(processAt(50000, image))), false);
});
test('legacy recovery refuses earlier, equal, and one-millisecond boundary start times', () => {
  for (const offset of [-10000, 0, 9999, 10000]) assert.equal(legacy(options(processAt(offset))), false);
});
test('legacy recovery fails closed on access denial and unavailable path or start identity', () => {
  assert.throws(() => legacy({ signal: eperm }), /window liveness is unknown/);
  assert.throws(() => legacy({ readProcess: eperm }), /window identity is unavailable/);
  for (const proof of [{}, { ...processAt(50000), path: null }, { ...processAt(50000), path: 'node.exe' },
    { ...processAt(50000), path: 'C:\\runtime\\unknown' }, { ...processAt(50000), startedAt: null },
    { ...processAt(50000), startedAt: 'not-ticks' }, { ...processAt(50000), pid: pid + 1 }]) {
    assert.throws(() => legacy({ readProcess: () => proof }), /unstable or unavailable/);
  }
});
test('legacy recovery refuses PID reuse during the two reads', () => {
  for (const change of [p => ({ ...p, pid: pid + 1 }), p => ({ ...p, startedAt: processAt(60000).startedAt }), p => ({ ...p, path: 'C:\\other\\node.exe' })]) {
    let reads = 0;
    assert.throws(() => legacy({ readProcess: () => ++reads === 1 ? processAt(50000) : change(processAt(50000)) }), /unstable or unavailable/);
  }
});
test('legacy recovery rejects missing time and platforms without the Windows proof', () => {
  assert.throws(() => legacy({ platform: 'linux' }), /identity is unavailable/);
  for (const time of [undefined, null, 'invalid']) assert.throws(() => initialRecoveryWindowIsGone({ windowPid: pid }, time, options()), /identity is unavailable/);
});
test('window PID is required before any liveness probe', () => {
  for (const view of [null, {}, { windowPid: 0 }, { windowPid: -1 }, { windowPid: '28640' }]) {
    assert.throws(() => initialRecoveryWindowIsGone(view, completedAt, { signal: () => assert.fail('unexpected probe') }), /window proof unavailable/);
  }
});
test('saved window start identity uses existing process identity semantics, not the legacy heuristic', () => {
  const view = { windowPid: pid, windowStartedAt: '639270738422827219' };
  const injected = { ...options(), legacyExitEvidence: undefined, readProcess: () => assert.fail('legacy reader must not run') };
  assert.equal(initialRecoveryWindowIsGone(view, completedAt, { ...injected, readStart: () => view.windowStartedAt }), false);
  assert.equal(initialRecoveryWindowIsGone(view, completedAt, { ...injected, readStart: () => '639270738422827220' }), true);
  assert.equal(initialRecoveryWindowIsGone(view, completedAt, { ...injected, signal: esrch }), true);
  assert.throws(() => initialRecoveryWindowIsGone(view, completedAt, { ...injected, signal: eperm }), /liveness is unknown/);
  assert.throws(() => initialRecoveryWindowIsGone(view, completedAt, { ...injected, readStart: eperm }), /access denied/);
  for (const windowStartedAt of [null, '', 'not-ticks', 123, '0', '-123']) {
    assert.throws(() => initialRecoveryWindowIsGone({ ...view, windowStartedAt }, completedAt, injected), /saved window start proof unavailable/);
  }
});
test('existing manager identity detects a reused PID and still rejects a live original identity', () => {
  const proof = { pid: 28764, startedAt: 'old-manager-start' };
  assert.equal(processIsGone(proof, { signal: () => {}, readStart: () => 'OpenConsole-replacement-start' }), true);
  assert.equal(processIsGone(proof, { signal: () => {}, readStart: () => proof.startedAt }), false);
});
