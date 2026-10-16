import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
let current;
export function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid process PID');
  if (process.platform === 'win32') {
    // Query the same Process.StartTime directly. The Get-Process cmdlet path can
    // stall in a minimal host even when the underlying .NET query is available.
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !/^\d+$/.test(result.stdout.trim())) throw new Error('process start identity unavailable');
    return result.stdout.trim();
  }
  if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  throw new Error('process identity is unsupported on this host');
}
export function currentProcessIdentity() { return current ??= { pid: process.pid, startedAt: processStart(process.pid) }; }
export function processIsGone(identity, { signal = pid => process.kill(pid, 0), readStart = processStart } = {}) {
  if (!Number.isSafeInteger(identity?.pid) || identity.pid < 1 || !identity.startedAt) throw new Error('saved process proof unavailable');
  const gone = () => { try { signal(identity.pid); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw new Error('process liveness is unknown'); } };
  if (gone()) return true;
  // A reused PID belongs to another process; never signal or wait for that new process.
  try { return readStart(identity.pid) !== identity.startedAt; }
  catch (error) {
    // Exit can occur between the liveness check and reading the start identity.
    // Only a fresh ESRCH proves exit; access denial remains unknown, not gone.
    if (gone()) return true;
    throw error;
  }
}

function readWindowsProcess(pid) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; [ordered]@{pid=$p.Id; startedAt=$p.StartTime.ToUniversalTime().Ticks.ToString(); path=$p.Path} | ConvertTo-Json -Compress`],
  { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('CLI window identity is unavailable');
  try { return JSON.parse(result.stdout.trim()); }
  catch { throw new Error('CLI window identity is unavailable'); }
}

// Legacy windows lack a start identity. Use this only after the exact unbound r1
// result, review, launch exit, owner, profile and original prompt have been checked.
export function initialRecoveryWindowIsGone(view, completedAt, {
  signal = pid => process.kill(pid, 0), readStart = processStart,
  readProcess = readWindowsProcess, platform = process.platform, legacyExitEvidence,
} = {}) {
  const pid = view?.windowPid;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('CLI initial session recovery window proof unavailable');
  if (Object.hasOwn(view, 'windowStartedAt')) {
    if (typeof view.windowStartedAt !== 'string' || !/^[1-9]\d*$/.test(view.windowStartedAt)) throw new Error('CLI saved window start proof unavailable');
    return processIsGone({ pid, startedAt: view.windowStartedAt }, { signal, readStart });
  }
  try { signal(pid); }
  catch (error) { if (error.code === 'ESRCH') return true; throw new Error('CLI window liveness is unknown'); }
  const registrationTimeout = 'Claude did not register its native session; inspect the visible window';
  if (legacyExitEvidence?.resultError !== registrationTimeout || legacyExitEvidence?.viewExitError !== registrationTimeout) {
    throw new Error('CLI legacy window recovery is not authorized for this failure');
  }
  const completedMs = typeof completedAt === 'string' ? Date.parse(completedAt) : NaN;
  if (platform !== 'win32' || !Number.isSafeInteger(completedMs)) throw new Error('CLI legacy window identity is unavailable');
  const valid = value => value?.pid === pid && typeof value.startedAt === 'string' && /^\d+$/.test(value.startedAt)
    && typeof value.path === 'string' && path.win32.isAbsolute(value.path) && path.win32.extname(value.path).toLowerCase() === '.exe';
  let before, after;
  try { before = readProcess(pid); after = readProcess(pid); }
  catch { throw new Error('CLI legacy window identity is unavailable'); }
  if (!valid(before) || !valid(after) || before.startedAt !== after.startedAt
    || before.path.toLowerCase() !== after.path.toLowerCase()) throw new Error('CLI legacy window identity is unstable or unavailable');
  if (path.win32.basename(before.path).toLowerCase() === 'powershell.exe') return false;
  // The manager writes this fingerprint-bound result after the same launch's view
  // exit. A different image born strictly later cannot be that original window.
  const afterResultTicks = (BigInt(completedMs) + 1n) * 10000n + 621355968000000000n;
  return BigInt(before.startedAt) > afterResultTicks;
}
