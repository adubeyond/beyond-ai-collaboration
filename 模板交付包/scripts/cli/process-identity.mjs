import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
let current;
export function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid process PID');
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !/^\d+$/.test(result.stdout.trim())) throw new Error('process start identity unavailable');
    return result.stdout.trim();
  }
  if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  throw new Error('process identity is unsupported on this host');
}
export function currentProcessIdentity() { return current ??= { pid: process.pid, startedAt: processStart(process.pid) }; }
export function processIsGone(identity) {
  if (!Number.isSafeInteger(identity?.pid) || identity.pid < 1 || !identity.startedAt) throw new Error('saved process proof unavailable');
  try { process.kill(identity.pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; throw new Error('process liveness is unknown'); }
  // A reused PID belongs to another process; never signal or wait for that new process.
  return processStart(identity.pid) !== identity.startedAt;
}
