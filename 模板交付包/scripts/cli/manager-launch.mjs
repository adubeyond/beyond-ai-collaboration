import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function windowsArgument(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}
function windowsPowerShell() {
  if (!path.isAbsolute(process.env.SystemRoot ?? '')) throw new Error('Windows system directory unavailable');
  return path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
}

// detached/unref do not escape a Desktop's nested kill-on-close Jobs. Use the
// local Windows process provider as the launcher, under the same user/session,
// without installing a service, elevating, or leaving an attached fallback.
export function launchIndependentNode(entry, args = []) {
  if (process.platform !== 'win32') throw new Error('Independent Windows launcher requires Windows');
  if (!path.isAbsolute(entry) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Invalid independent manager command');
  const command = [process.execPath, entry, ...args].map(windowsArgument).join(' ');
  const encoded = Buffer.from(JSON.stringify({ executable: process.execPath, command, cwd: process.cwd() }), 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
# Set the module path before invoking any module-dependent cmdlet.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class BeyondIndependentProcess {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool contained);
  public static string Verify(int pid, string file) {
    using (var process = Process.GetProcessById(pid)) {
      bool contained;
      if (!String.Equals(process.MainModule.FileName, file, StringComparison.OrdinalIgnoreCase)
          || process.SessionId != Process.GetCurrentProcess().SessionId
          || !IsProcessInJob(process.Handle, IntPtr.Zero, out contained) || contained)
        throw new InvalidOperationException("Independent manager identity or Job isolation unverified; dispatch refused");
      return process.StartTime.ToUniversalTime().Ticks.ToString();
    }
  }
}
'@
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.CreateFlags = [uint32](0x01000000 -bor 0x08000000 -bor 0x00000200 -bor 0x00000400)
$startup.ShowWindow = [uint16]0
$startup.WinstationDesktop = 'winsta0\\default'
# Environment stays in memory, never on the command line or in a request file.
$startup.EnvironmentVariables = [string[]](Get-ChildItem Env: | ForEach-Object { $_.Name + '=' + $_.Value })
$created = ([wmiclass]'Win32_Process').Create($spec.command, $spec.cwd, $startup)
if ($created.ReturnValue -ne 0) { throw ('Local Windows process provider refused launch: ' + $created.ReturnValue) }
$createdProcess = [wmi]('Win32_Process.Handle="' + $created.ProcessId + '"')
$owner = $createdProcess.GetOwnerSid()
if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Independent manager user mismatch; dispatch refused' }
$started = [BeyondIndependentProcess]::Verify([int]$created.ProcessId, $spec.executable)
[ordered]@{pid=[int]$created.ProcessId;startedAt=$started} | ConvertTo-Json -Compress`;
  const launched = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  if (launched.status !== 0) throw new Error('Independent CLI manager launch unconfirmed; local Windows process provider and same-user Job isolation are required. Inspect this run before recovery.');
  let identity;
  try { identity = JSON.parse(launched.stdout.trim()); } catch { throw new Error('Independent CLI manager process proof unavailable; inspect this run before recovery'); }
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 1 || !/^[1-9]\d*$/.test(identity.startedAt)) throw new Error('Invalid independent manager process proof');
  return identity;
}

function readMessages(socket, consume, fail) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', data => {
    try {
      buffer += data;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) throw new Error('CLI manager bootstrap exceeds size limit');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        consume(JSON.parse(line));
      }
    } catch (error) { fail(error); }
  });
}

export async function startWindowsManager(entry, payload, persistIdentity, { timeoutMs = 15000 } = {}) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const address = `\\\\.\\pipe\\beyond-cli-manager-${crypto.randomUUID()}`;
  const server = net.createServer();
  let identity, peer, finished = false, timer;
  const sockets = new Set();
  return new Promise((resolve, reject) => {
    function finish(error, value) {
      if (finished) return; finished = true; clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      if (server.listening) server.close();
      if (error) reject(error); else resolve(value);
    }
    server.on('error', finish);
    server.on('connection', socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.on('error', error => { if (socket === peer) finish(error); else socket.destroy(); });
      readMessages(socket, message => {
        if (socket !== peer) {
          if (peer || message.type !== 'hello' || message.nonce !== nonce || message.pid !== identity?.pid) { socket.destroy(); return; }
          peer = socket;
          socket.write(JSON.stringify({ ...payload, managerIdentity: identity }) + '\n');
        } else if (['accepted', 'rejected'].includes(message.type)) {
          finish(message.type === 'rejected' ? new Error(message.error) : null, message);
        }
      }, error => finish(error));
      socket.on('close', () => { if (socket === peer && !finished) finish(new Error('CLI manager startup disconnected; inspect this run before recovery')); });
    });
    server.listen(address, () => {
      try {
        identity = { ...launchIndependentNode(entry, ['--manager-pipe', address, nonce]), token: crypto.randomUUID() };
        // Save ownership immediately, not after a potentially delayed handshake.
        persistIdentity(identity);
        timer = setTimeout(() => finish(new Error('CLI manager startup unconfirmed; inspect this run before recovery')), timeoutMs);
      } catch (error) { finish(error); }
    });
  });
}

export function receiveWindowsManager(address, nonce, { timeoutMs = 30000 } = {}) {
  if (!/^\\\\\.\\pipe\\beyond-cli-manager-[0-9a-f-]{36}$/.test(address ?? '') || !/^[a-f0-9]{64}$/.test(nonce ?? '')) throw new Error('Invalid CLI manager bootstrap channel');
  return new Promise((resolve, reject) => {
    let received = false;
    const socket = net.connect(address);
    const timer = setTimeout(() => fail(new Error('CLI manager bootstrap timed out before dispatch')), timeoutMs);
    function fail(error) { clearTimeout(timer); socket.destroy(); if (!received) reject(error); }
    socket.once('connect', () => {
      try { socket.write(JSON.stringify({ type: 'hello', nonce, pid: process.pid }) + '\n'); }
      catch (error) { fail(error); }
    });
    socket.on('error', fail);
    socket.on('close', () => { if (!received) fail(new Error('CLI manager caller exited before dispatch')); });
    readMessages(socket, payload => {
      if (received) return;
      const proof = payload.managerIdentity;
      const actual = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', `[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      if (proof?.pid !== process.pid || actual.status !== 0 || actual.stdout.trim() !== proof.startedAt) throw new Error('CLI manager bootstrap process proof mismatch');
      received = true; clearTimeout(timer);
      // After dispatch this pipe is only a readiness receipt, never a lifeline.
      resolve({ payload, send: message => { if (!socket.destroyed) socket.end(JSON.stringify(message) + '\n'); } });
    }, fail);
  });
}
