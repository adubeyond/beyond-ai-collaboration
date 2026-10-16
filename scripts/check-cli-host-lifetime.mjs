import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This is a synthetic, test-owned Job Object. It never closes Desktop or a production process.
// Win32 contract: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
const nativeSource = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class LifetimeOwnedProcess {
  public IntPtr Handle;
  public IntPtr Thread;
  public int Pid;
  public long Created;
  public string Image;
}
public static class LifetimeNative {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb;
    public string reserved, desktop, title;
    public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
    public ushort show, reservedBytes;
    public IntPtr reservedData, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr process, thread;
    public uint pid, threadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr buffer, uint length, out uint returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok, string operation) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
  static long Created(IntPtr handle) {
    long created, exited, kernel, user;
    Check(GetProcessTimes(handle, out created, out exited, out kernel, out user), "GetProcessTimes");
    return created;
  }
  static string Image(IntPtr handle) {
    uint length = 32768; var result = new StringBuilder((int)length);
    Check(QueryFullProcessImageNameW(handle, 0, result, ref length), "QueryFullProcessImageName");
    return result.ToString();
  }
  static void Verify(LifetimeOwnedProcess process) {
    if (process == null || process.Handle == IntPtr.Zero || process.Pid == Process.GetCurrentProcess().Id) throw new Exception("Not an owned child process");
    if (Created(process.Handle) != process.Created || !String.Equals(Image(process.Handle), process.Image, StringComparison.OrdinalIgnoreCase)) throw new Exception("Owned process identity changed");
  }
  public static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? 2 * slashes + 1 : slashes); slashes = 0; result.Append(c);
    }
    result.Append('\\', 2 * slashes); return result.Append('"').ToString();
  }
  public static IntPtr Job(bool allowBreakaway, string name) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, name); Check(job != IntPtr.Zero, "CreateJobObject");
    try {
      var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
      if (allowBreakaway) limits.Basic.Flags |= 0x0800; // BREAKAWAY_OK
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "SetInformationJobObject");
      return job;
    } catch { CloseHandle(job); throw; }
  }
  public static IntPtr OpenTestJob(string name) { IntPtr job = OpenJobObjectW(0x0004, false, name); Check(job != IntPtr.Zero, "Open test job for query only"); return job; }
  public static LifetimeOwnedProcess Start(string executable, string[] args, string cwd, bool breakaway) {
    var commandLine = new StringBuilder(Quote(executable)); foreach (string arg in args) commandLine.Append(" ").Append(Quote(arg));
    var startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    ProcessInfo info;
    uint flags = 0x08000000 | 0x00000004; // NO_WINDOW | SUSPENDED; assign and record identity before execution.
    if (breakaway) flags |= 0x01000000; // CREATE_BREAKAWAY_FROM_JOB
    Check(CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, cwd, ref startup, out info), "CreateProcess");
    var owned = new LifetimeOwnedProcess { Handle = info.process, Thread = info.thread, Pid = (int)info.pid };
    try { owned.Created = Created(owned.Handle); owned.Image = Image(owned.Handle); return owned; }
    catch { TerminateProcess(info.process, 92); CloseHandle(info.thread); CloseHandle(info.process); throw; }
  }
  public static LifetimeOwnedProcess Capture(int pid, string executable, string expectedCreated) {
    IntPtr handle = OpenProcess(0x00100000 | 0x1000 | 0x0001, false, pid); Check(handle != IntPtr.Zero, "OpenProcess owned fixture");
    var owned = new LifetimeOwnedProcess { Handle = handle, Pid = pid };
    try {
      owned.Created = Created(handle); owned.Image = Image(handle); Verify(owned);
      if (!String.IsNullOrEmpty(executable) && !String.Equals(Path.GetFullPath(owned.Image), Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase)) throw new Exception("Unexpected fixture executable");
      if (!String.IsNullOrEmpty(expectedCreated) && owned.Created.ToString() != expectedCreated) throw new Exception("Fixture process creation time mismatch");
      return owned;
    } catch { CloseHandle(handle); throw; }
  }
  public static void Assign(IntPtr job, LifetimeOwnedProcess process) { Verify(process); Check(AssignProcessToJobObject(job, process.Handle), "AssignProcessToJobObject"); }
  public static void Resume(LifetimeOwnedProcess process) {
    Verify(process); Check(ResumeThread(process.Thread) != UInt32.MaxValue, "ResumeThread"); CloseHandle(process.Thread); process.Thread = IntPtr.Zero;
  }
  public static bool Member(IntPtr job, LifetimeOwnedProcess process) { Verify(process); bool member; Check(IsProcessInJob(process.Handle, job, out member), "IsProcessInJob"); return member; }
  public static int[] Members(IntPtr job) {
    IntPtr buffer = Marshal.AllocHGlobal(4096);
    try {
      uint returned; Check(QueryInformationJobObject(job, 3, buffer, 4096, out returned), "QueryInformationJobObject process IDs");
      int count = Marshal.ReadInt32(buffer, 4); var result = new int[count];
      for (int index = 0; index < count; index++) result[index] = checked((int)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64());
      return result;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static bool Exited(LifetimeOwnedProcess process, uint milliseconds) {
    uint answer = WaitForSingleObject(process.Handle, milliseconds); if (answer == 0) return true; if (answer == 258) return false;
    throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
  }
  public static void CloseJob(IntPtr job) { if (job != IntPtr.Zero) Check(CloseHandle(job), "CloseHandle test job"); }
  public static void Release(LifetimeOwnedProcess process) {
    if (process == null) return;
    if (process.Thread != IntPtr.Zero) { CloseHandle(process.Thread); process.Thread = IntPtr.Zero; }
    if (process.Handle != IntPtr.Zero) { CloseHandle(process.Handle); process.Handle = IntPtr.Zero; }
  }
  public static void Cleanup(LifetimeOwnedProcess process) {
    if (process == null || process.Handle == IntPtr.Zero) return;
    try {
      if (!Exited(process, 0)) {
        try { Verify(process); Check(TerminateProcess(process.Handle, 93), "TerminateProcess verified fixture"); }
        catch { if (!Exited(process, 3000)) throw; } // The same captured handle can finish exiting during identity lookup.
        if (!Exited(process, 3000)) throw new Exception("Fixture process exit unconfirmed");
      }
    } finally { Release(process); }
  }
}
`;

const workerSource = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const [root, role, nonce, argument] = process.argv.slice(2);
const write = (name, data) => { const file = path.join(root, name); fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); };
write(role + '-ready.json', { role, nonce, pid: process.pid, argument, environment: process.env.BEYOND_LIFETIME_UNICODE });
const deadline = setTimeout(() => { clearInterval(waiting); process.exitCode = 72; }, 25000);
const waiting = setInterval(() => {
  const file = path.join(root, 'release.json'); if (!fs.existsSync(file)) return;
  const release = JSON.parse(fs.readFileSync(file, 'utf8')); if (release.nonce !== nonce) throw new Error('Wrong fixture release');
  clearInterval(waiting);
  setTimeout(() => { write(role + '-done.json', { role, nonce, pid: process.pid, argument, environment: process.env.BEYOND_LIFETIME_UNICODE, completedAt: new Date().toISOString(), jobClosedAt: release.jobClosedAt }); clearTimeout(deadline); }, 120);
}, 25);
`;

const breakawaySource = String.raw`
param([string]$FixtureRoot,[string]$NodeExecutable,[string]$Nonce,[string]$FixtureArgument)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -Path (Join-Path $FixtureRoot 'native.cs')
$owned = $null; $started = $false
try {
  $owned = [LifetimeNative]::Start($NodeExecutable, @((Join-Path $FixtureRoot 'worker.mjs'),$FixtureRoot,'breakaway',$Nonce,$FixtureArgument), $FixtureRoot, $true)
  $testJob = [LifetimeNative]::OpenTestJob('Local\BeyondLifetime-' + $Nonce)
  try {
    if ([LifetimeNative]::Member($testJob,$owned)) {
      $rejectedProof = @{pid=$owned.Pid;created=$owned.Created.ToString();nonce=$Nonce;terminatedBeforeResume=$false}
      [LifetimeNative]::Cleanup($owned); $owned = $null; $rejectedProof.terminatedBeforeResume = $true
      $rejectedProof | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $FixtureRoot 'breakaway-rejected-native.json') -Encoding UTF8
      throw 'Direct breakaway remains in the test Job; dispatch refused before worker execution'
    }
  }
  finally { [LifetimeNative]::CloseJob($testJob) }
  @{pid=$owned.Pid;created=$owned.Created.ToString();nonce=$Nonce} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $FixtureRoot 'breakaway-process.json') -Encoding UTF8
  [LifetimeNative]::Resume($owned); $started = $true
} finally {
  if ($started) { [LifetimeNative]::Release($owned) } else { [LifetimeNative]::Cleanup($owned) }
}
`;

function parentSource(launcherModule, allowBreakaway, fixtureArgument) {
  return `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { spawn } from 'node:child_process';
const [root, powershell, nonce] = process.argv.slice(2);
const launcherModule = ${JSON.stringify(launcherModule)};
const allowBreakaway = ${JSON.stringify(allowBreakaway)};
const fixtureArgument = ${JSON.stringify(fixtureArgument)};
process.env.BEYOND_LIFETIME_UNICODE = fixtureArgument;
const write = (name, data) => { const file = path.join(root, name); fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); };
let ordinary;
try {
  ordinary = spawn(process.execPath, [path.join(root, 'worker.mjs'), root, 'ordinary', nonce, fixtureArgument], { cwd: root, detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { ordinary.once('spawn', resolve); ordinary.once('error', reject); }); ordinary.unref();
  let candidate;
  if (launcherModule) {
    const originalSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (...args) => {
      const result = originalSpawnSync(...args);
      if (result.status !== 0) write('launcher-failure.json', { status: result.status, error: result.error?.message, stderr: String(result.stderr ?? '').slice(0, 4000) });
      return result;
    };
    syncBuiltinESMExports();
    const { launchIndependentNode } = await import(pathToFileURL(launcherModule).href);
    candidate = launchIndependentNode(path.join(root, 'worker.mjs'), [root, 'breakaway', nonce, fixtureArgument]);
    write('breakaway-process.json', { pid: candidate.pid, nonce, productStartedAt: candidate.startedAt });
  } else {
    const helper = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'breakaway.ps1'), root, process.execPath, nonce, fixtureArgument], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; helper.stdout.resume(); helper.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => { helper.once('error', reject); helper.once('exit', code => code === 0 ? resolve() : reject(new Error('Breakaway helper failed: ' + stderr))); });
    candidate = JSON.parse(fs.readFileSync(path.join(root, 'breakaway-process.json'), 'utf8').replace(/^\\uFEFF/, ''));
  }
  write('parent-ready.json', { nonce, pid: process.pid, ordinaryPid: ordinary.pid, breakawayPid: candidate.pid });
  setInterval(() => {}, 1000);
} catch (error) {
  if (!allowBreakaway && ordinary?.pid) { write('parent-rejected.json', { nonce, pid: process.pid, ordinaryPid: ordinary.pid, error: error.message }); setInterval(() => {}, 1000); }
  else { const diagnosticFile = path.join(root, 'launcher-failure.json'); const diagnostic = fs.existsSync(diagnosticFile) ? JSON.parse(fs.readFileSync(diagnosticFile, 'utf8')).stderr : ''; write('parent-error.json', { nonce, productLauncher: Boolean(launcherModule), error: error.stack + (diagnostic ? '\\nLauncher diagnostic: ' + diagnostic : '') }); process.exitCode = 73; }
}
`;
}

const harnessSource = String.raw`
param([string]$FixtureRoot,[string]$NodeExecutable,[string]$PowerShellExecutable,[string]$Nonce,[string]$BreakawayPolicy,[string]$ExpectedArgument)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -Path (Join-Path $FixtureRoot 'native.cs')
$allowBreakaway = $BreakawayPolicy -eq 'allow'
function Read-Fixture([string]$Name) { Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $FixtureRoot $Name) | ConvertFrom-Json }
function Wait-Fixture([string[]]$Names) {
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    if (Test-Path -LiteralPath (Join-Path $FixtureRoot 'parent-error.json')) { throw (Read-Fixture 'parent-error.json').error }
    $missing = @($Names | Where-Object { -not (Test-Path -LiteralPath (Join-Path $FixtureRoot $_)) })
    if ($missing.Count -eq 0) { return }
    Start-Sleep -Milliseconds 25
  } while ([DateTime]::UtcNow -lt $deadline)
  throw ('Fixture did not become ready: ' + ($missing -join ', '))
}
function Proof($Owned) { @{pid=$Owned.Pid;created=$Owned.Created.ToString();image=$Owned.Image} }
$job = [IntPtr]::Zero; $parent = $null; $ordinary = $null; $breakaway = $null; $helpers = @(); $answer = $null; $failure = $null; $cleanupConfirmed = $true
try {
  $job = [LifetimeNative]::Job($allowBreakaway,('Local\BeyondLifetime-' + $Nonce))
  $parent = [LifetimeNative]::Start($NodeExecutable,@((Join-Path $FixtureRoot 'parent.mjs'),$FixtureRoot,$PowerShellExecutable,$Nonce),$FixtureRoot,$false)
  [LifetimeNative]::Assign($job,$parent); [LifetimeNative]::Resume($parent)
  if (-not $allowBreakaway) {
    Wait-Fixture @('parent-rejected.json','ordinary-ready.json')
    $rejected = Read-Fixture 'parent-rejected.json'; $ordinaryReady = Read-Fixture 'ordinary-ready.json'
    if ($rejected.nonce -ne $Nonce -or $ordinaryReady.nonce -ne $Nonce -or $rejected.pid -ne $parent.Pid -or $rejected.ordinaryPid -ne $ordinaryReady.pid) { throw 'Rejected launch identity mismatch' }
    $ordinary = [LifetimeNative]::Capture([int]$rejected.ordinaryPid,$NodeExecutable,[string]$ordinaryReady.created)
    $before = @{parentInJob=[LifetimeNative]::Member($job,$parent);ordinaryInJob=[LifetimeNative]::Member($job,$ordinary)}
    if (-not $before.parentInJob -or -not $before.ordinaryInJob) { throw 'Denied fixture escaped its test job' }
    Start-Sleep -Milliseconds 250
    $members = @([LifetimeNative]::Members($job) | Sort-Object)
    $rejectedNative = $null; $expectedMembers = @($parent.Pid,$ordinary.Pid)
    if (Test-Path -LiteralPath (Join-Path $FixtureRoot 'breakaway-rejected-native.json')) {
      $rejectedNative = Read-Fixture 'breakaway-rejected-native.json'
      if ($rejectedNative.nonce -ne $Nonce -or -not $rejectedNative.terminatedBeforeResume) { throw 'Unverified rejected native process cleanup' }
      $expectedMembers += [int]$rejectedNative.pid
    }
    # A detached Windows child can also own a console host. Capture every extra
    # member of this exact test Job and prove it exits; never enumerate by name.
    foreach ($member in @($members | Where-Object { $_ -notin $expectedMembers })) {
      $helper = [LifetimeNative]::Capture([int]$member,$null,$null)
      if (-not [LifetimeNative]::Member($job,$helper)) { [LifetimeNative]::Release($helper); throw 'Fixture helper left its owned Job before capture' }
      if ([IO.Path]::GetFullPath($helper.Image) -eq [IO.Path]::GetFullPath($NodeExecutable)) { [LifetimeNative]::Release($helper); throw 'Rejected launcher left an unexpected Node worker' }
      $helpers += $helper
    }
    foreach ($name in @('breakaway-process.json','breakaway-ready.json','breakaway-done.json','ordinary-done.json')) {
      if (Test-Path -LiteralPath (Join-Path $FixtureRoot $name)) { throw ('Rejected launch produced a child or result: ' + $name) }
    }
    $closedAt = [DateTime]::UtcNow.ToString('o'); [LifetimeNative]::CloseJob($job); $job = [IntPtr]::Zero
    $parentExited = [LifetimeNative]::Exited($parent,5000); $ordinaryExited = [LifetimeNative]::Exited($ordinary,5000)
    if (-not $parentExited -or -not $ordinaryExited) { throw 'Denied fixture shutdown unconfirmed' }
    $helperProofs = @($helpers | ForEach-Object { if (-not [LifetimeNative]::Exited($_,5000)) { throw 'Owned fixture helper survived Job closure' }; $proof = Proof $_; $proof.exited = $true; $proof })
    $answer = @{kind='synthetic-test-job-denied';jobLimits=@('KILL_ON_JOB_CLOSE');before=$before;parent=(Proof $parent);ordinary=(Proof $ordinary);membersBeforeClose=$members;helpers=$helperProofs;rejectedNative=$rejectedNative;rejection=$rejected.error;jobClosedAt=$closedAt;after=@{parentExited=$parentExited;ordinaryExited=$ordinaryExited;ordinaryDone=$false;breakawayWorkerStarted=$false;breakawayDone=$false}}
  } else {
  Wait-Fixture @('parent-ready.json','ordinary-ready.json','breakaway-ready.json','breakaway-process.json')
  $ready = Read-Fixture 'parent-ready.json'; $ordinaryReady = Read-Fixture 'ordinary-ready.json'; $breakawayReady = Read-Fixture 'breakaway-ready.json'; $candidateProof = Read-Fixture 'breakaway-process.json'
  if ($ready.nonce -ne $Nonce -or $ordinaryReady.nonce -ne $Nonce -or $breakawayReady.nonce -ne $Nonce -or $candidateProof.nonce -ne $Nonce) { throw 'Fixture nonce mismatch' }
  if ($ordinaryReady.argument -ne $ExpectedArgument -or $breakawayReady.argument -ne $ExpectedArgument -or $ordinaryReady.environment -ne $ExpectedArgument -or $breakawayReady.environment -ne $ExpectedArgument) { throw 'Fixture Unicode argument or environment changed' }
  if ($ready.pid -ne $parent.Pid -or $ready.ordinaryPid -ne $ordinaryReady.pid -or $ready.breakawayPid -ne $breakawayReady.pid -or $ready.breakawayPid -ne $candidateProof.pid) { throw 'Fixture process identity mismatch' }
  if (@($ready.pid,$ready.ordinaryPid,$ready.breakawayPid | Select-Object -Unique).Count -ne 3) { throw 'Fixture processes are not distinct' }
  $ordinary = [LifetimeNative]::Capture([int]$ready.ordinaryPid,$NodeExecutable,[string]$ordinaryReady.created)
  $breakaway = [LifetimeNative]::Capture([int]$ready.breakawayPid,$NodeExecutable,[string]$breakawayReady.created)
  if ($candidateProof.created -and $candidateProof.created -ne $breakaway.Created.ToString()) { throw 'Native launcher creation proof mismatch' }
  if ($candidateProof.productStartedAt -and [DateTime]::FromFileTimeUtc($breakaway.Created).Ticks.ToString() -ne $candidateProof.productStartedAt) { throw 'Product launcher creation time proof mismatch' }
  $before = @{parentInJob=[LifetimeNative]::Member($job,$parent);ordinaryInJob=[LifetimeNative]::Member($job,$ordinary);breakawayInJob=[LifetimeNative]::Member($job,$breakaway)}
  $inAnyJob = [LifetimeNative]::Member([IntPtr]::Zero,$breakaway)
  if (-not $before.parentInJob -or -not $before.ordinaryInJob -or $before.breakawayInJob) { throw ('Unexpected job membership: ' + ($before | ConvertTo-Json -Compress)) }
  if ((Test-Path -LiteralPath (Join-Path $FixtureRoot 'ordinary-done.json')) -or (Test-Path -LiteralPath (Join-Path $FixtureRoot 'breakaway-done.json'))) { throw 'A worker completed before test-owned job closure' }
  $closedAt = [DateTime]::UtcNow.ToString('o')
  [LifetimeNative]::CloseJob($job); $job = [IntPtr]::Zero
  $parentExited = [LifetimeNative]::Exited($parent,5000); $ordinaryExited = [LifetimeNative]::Exited($ordinary,5000)
  if (-not $parentExited -or -not $ordinaryExited) { throw 'The isolated parent or ordinary detached child survived job closure' }
  $survived = -not [LifetimeNative]::Exited($breakaway,0)
  if (-not $survived) { throw 'The breakaway child exited before post-closure release' }
  @{nonce=$Nonce;jobClosedAt=$closedAt} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $FixtureRoot 'release.json.tmp') -Encoding ASCII
  Move-Item -LiteralPath (Join-Path $FixtureRoot 'release.json.tmp') -Destination (Join-Path $FixtureRoot 'release.json')
  Wait-Fixture @('breakaway-done.json')
  $done = Read-Fixture 'breakaway-done.json'
  if ($done.nonce -ne $Nonce -or $done.pid -ne $breakaway.Pid -or $done.jobClosedAt -ne $closedAt -or $done.argument -ne $ExpectedArgument) { throw 'Breakaway completion identity mismatch' }
  if (-not [LifetimeNative]::Exited($breakaway,5000)) { throw 'Completed breakaway worker did not exit' }
  $answer = @{kind='synthetic-test-job';jobLimits=@('KILL_ON_JOB_CLOSE','BREAKAWAY_OK');before=$before;breakawayInAnyJob=$inAnyJob;parent=(Proof $parent);ordinary=(Proof $ordinary);breakaway=(Proof $breakaway);jobClosedAt=$closedAt;after=@{parentExited=$parentExited;ordinaryExited=$ordinaryExited;ordinaryDone=(Test-Path -LiteralPath (Join-Path $FixtureRoot 'ordinary-done.json'));breakawaySurvivedClosure=$survived;breakawayExited=$true;breakawayDone=$done}}
  }
} catch {
  $failure = $_.Exception.ToString()
  if ($null -eq $breakaway -and (Test-Path -LiteralPath (Join-Path $FixtureRoot 'breakaway-ready.json'))) {
    try {
      $proof = Read-Fixture 'breakaway-ready.json'; if ($proof.nonce -ne $Nonce) { throw 'Failure diagnostic nonce mismatch' }
      $breakaway = [LifetimeNative]::Capture([int]$proof.pid,$NodeExecutable,[string]$proof.created)
      $diagnostic = @{pid=$breakaway.Pid;image=$breakaway.Image;testJob=[LifetimeNative]::Member($job,$breakaway);anyJob=[LifetimeNative]::Member([IntPtr]::Zero,$breakaway);candidateSessionId=([Diagnostics.Process]::GetProcessById($breakaway.Pid)).SessionId;harnessSessionId=([Diagnostics.Process]::GetCurrentProcess()).SessionId}
      $failure += '\nOwned worker diagnostic: ' + ($diagnostic | ConvertTo-Json -Compress)
    } catch { $failure += '\nOwned worker diagnostic unavailable: ' + $_.Exception.ToString() }
  }
}
finally {
  if ($job -ne [IntPtr]::Zero) { [LifetimeNative]::CloseJob($job); $job = [IntPtr]::Zero }
  # Recover only our nonce-bound child proof, never a name or arbitrary process tree.
  $recoveryFile = if (Test-Path -LiteralPath (Join-Path $FixtureRoot 'breakaway-ready.json')) { 'breakaway-ready.json' } else { 'breakaway-process.json' }
  if ($null -eq $breakaway -and (Test-Path -LiteralPath (Join-Path $FixtureRoot $recoveryFile))) {
    try { $proof = Read-Fixture $recoveryFile; if ($proof.nonce -ne $Nonce) { throw 'Cleanup nonce mismatch' }; $breakaway = [LifetimeNative]::Capture([int]$proof.pid,$NodeExecutable,[string]$proof.created) }
    catch { $cleanupConfirmed = $false; $failure = [string]$failure + '\nCleanup capture failed: ' + $_.Exception.ToString() }
  }
  foreach ($owned in (@($ordinary,$breakaway,$parent) + $helpers)) {
    try { [LifetimeNative]::Cleanup($owned) } catch { $cleanupConfirmed = $false; $failure = [string]$failure + '\nVerified fixture cleanup failed: ' + $_.Exception.ToString() }
  }
  @{nonce=$Nonce;confirmed=$cleanupConfirmed;completedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $FixtureRoot 'cleanup.json') -Encoding ASCII
}
if ($null -ne $failure) { [Console]::Error.WriteLine($failure); exit 1 }
$answer.cleaned = $true
[Console]::WriteLine(($answer | ConvertTo-Json -Depth 8 -Compress))
`;

function runPowerShell(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(`Isolated Job Object harness failed (${code}): ${stderr.trim()}`)));
  });
}

// Optional adapter: an absolute module exporting launchIndependentNode(entry, args) -> { pid, startedAt }.
// The module is imported only by the test-owned parent and receives only the temporary worker fixture.
export async function runJobCloseHarness({ launcherModule = null, allowBreakaway = true } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows Job Object harness requires Windows');
  if (launcherModule !== null && (!path.isAbsolute(launcherModule) || !fs.statSync(launcherModule).isFile())) throw new Error('Absolute launcher module required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-host-lifetime-'));
  const temp = fs.realpathSync(os.tmpdir()), physical = fs.realpathSync(root);
  assert.equal(path.dirname(physical).toLowerCase(), temp.toLowerCase());
  assert.match(path.basename(physical), /^beyond-host-lifetime-/);
  const nonce = crypto.randomUUID();
  const fixtureArgument = '中文 含 空格 "quoted" 与尾斜杠\\';
  const powershell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  let safeToRemove = false;
  try {
    for (const [name, source] of [['native.cs', nativeSource], ['worker.mjs', workerSource], ['parent.mjs', parentSource(launcherModule, allowBreakaway, fixtureArgument)], ['breakaway.ps1', breakawaySource], ['harness.ps1', harnessSource]]) fs.writeFileSync(path.join(root, name), source);
    const result = await runPowerShell(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'harness.ps1'), root, process.execPath, powershell, nonce, allowBreakaway ? 'allow' : 'deny', fixtureArgument], root);
    safeToRemove = result.cleaned === true;
    return { ...result, launcher: launcherModule ?? 'test-only-PInvoke', fixtureDirectoryRemoved: safeToRemove };
  } catch (error) {
    const cleanupFile = path.join(root, 'cleanup.json');
    if (fs.existsSync(cleanupFile)) { const cleanup = JSON.parse(fs.readFileSync(cleanupFile, 'utf8')); safeToRemove = cleanup.nonce === nonce && cleanup.confirmed === true; }
    error.message += safeToRemove ? '; verified fixture processes exited; temporary directory cleaned' : `; fixture retained at ${root}`;
    throw error;
  } finally {
    if (safeToRemove) { assert.equal(fs.realpathSync(root), physical); fs.rmSync(physical, { recursive: true, force: false }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  test('isolated Windows job closure kills ordinary detached Node but not an explicit breakaway child', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
    const outcome = await runJobCloseHarness();
    assert.deepEqual(outcome.before, { parentInJob: true, ordinaryInJob: true, breakawayInJob: false });
    assert.equal(outcome.after.parentExited, true); assert.equal(outcome.after.ordinaryExited, true);
    assert.equal(outcome.after.ordinaryDone, false); assert.equal(outcome.after.breakawaySurvivedClosure, true);
    assert.equal(outcome.after.breakawayExited, true);
    assert.ok(Date.parse(outcome.after.breakawayDone.completedAt) >= Date.parse(outcome.jobClosedAt));
    assert.equal(outcome.cleaned, true); assert.equal(outcome.fixtureDirectoryRemoved, true);
    t.diagnostic(JSON.stringify(outcome));
  });
  test('direct CreateProcess refuses a job that forbids breakaway without child or result leakage', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
    const outcome = await runJobCloseHarness({ allowBreakaway: false });
    assert.match(outcome.rejection, /breakaway|CreateProcess/i);
    assert.deepEqual(outcome.before, { parentInJob: true, ordinaryInJob: true });
    const expectedMembers = [outcome.parent.pid, outcome.ordinary.pid, ...outcome.helpers.map(helper => helper.pid), ...(outcome.rejectedNative ? [outcome.rejectedNative.pid] : [])];
    assert.ok(outcome.membersBeforeClose.every(pid => expectedMembers.includes(pid)));
    assert.ok(outcome.helpers.every(helper => helper.exited));
    if (outcome.rejectedNative) assert.equal(outcome.rejectedNative.terminatedBeforeResume, true);
    assert.deepEqual(outcome.after, { parentExited: true, ordinaryExited: true, ordinaryDone: false, breakawayWorkerStarted: false, breakawayDone: false });
    assert.equal(outcome.cleaned, true); assert.equal(outcome.fixtureDirectoryRemoved, true);
    t.diagnostic(JSON.stringify(outcome));
  });
  test('product WMI launcher survives isolated host Job closure with exact Unicode arguments and environment', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
    const launcherModule = path.join(import.meta.dirname, '../模板交付包/scripts/cli/manager-launch.mjs');
    const outcome = await runJobCloseHarness({ launcherModule });
    assert.deepEqual(outcome.before, { parentInJob: true, ordinaryInJob: true, breakawayInJob: false });
    assert.equal(outcome.breakawayInAnyJob, false, 'product process must escape every containing Job, not only the test Job');
    assert.equal(outcome.after.parentExited, true); assert.equal(outcome.after.ordinaryExited, true);
    assert.equal(outcome.after.ordinaryDone, false); assert.equal(outcome.after.breakawaySurvivedClosure, true);
    assert.equal(outcome.after.breakawayExited, true);
    assert.equal(outcome.after.breakawayDone.argument, '中文 含 空格 "quoted" 与尾斜杠\\');
    assert.equal(outcome.after.breakawayDone.environment, outcome.after.breakawayDone.argument);
    assert.ok(Date.parse(outcome.after.breakawayDone.completedAt) >= Date.parse(outcome.jobClosedAt));
    assert.equal(outcome.cleaned, true); assert.equal(outcome.fixtureDirectoryRemoved, true);
    t.diagnostic(JSON.stringify(outcome));
  });
}
