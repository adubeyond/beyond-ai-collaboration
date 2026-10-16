import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cliEnvironment } from './native-cli-runner.mjs';

const canonical = (file, platform = process.platform) => platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const same = (left, right, platform) => typeof left === 'string' && typeof right === 'string' && canonical(left, platform) === canonical(right, platform);

// Recognize only the two observed Desktop-owned layouts. Custom installations
// keep their explicitly configured command; neither PATH nor project files are searched.
export function isDesktopCodexCommand(command, {
  platform = process.platform, localAppData = process.env.LOCALAPPDATA,
  programFiles = process.env.ProgramW6432 ?? process.env.ProgramFiles,
} = {}) {
  if (platform !== 'win32' || typeof command !== 'string' || !path.isAbsolute(command)) return false;
  const relative = root => path.relative(path.resolve(root), path.resolve(command)).replaceAll('\\', '/');
  if (localAppData && /^[0-9a-f]{8,64}\/codex\.exe$/i.test(relative(path.join(localAppData, 'OpenAI/Codex/bin')))) return true;
  return Boolean(programFiles && /^OpenAI\.Codex_[^/]+\/app\/resources\/codex\.exe$/i.test(relative(path.join(programFiles, 'WindowsApps'))));
}

export function probeCodexExecutable(command, profile) {
  const invoke = args => spawnSync(command, args, { env: cliEnvironment(profile.codexHome), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 });
  const valid = (result, flags) => !result.error && result.status === 0 && typeof result.stdout === 'string' && flags.every(flag => result.stdout.includes(flag));
  const version = invoke(['--version']);
  if (!valid(version, []) || !/^codex-cli\s+\S+/i.test(version.stdout.trim())) return false;
  if (profile.mode === 'interactive') {
    return valid(invoke(['app-server', '--help']), ['--listen', '--ws-auth', '--ws-token-file'])
      && valid(invoke(['--help']), ['--remote', '--remote-auth-token-env', '--no-alt-screen']);
  }
  return valid(invoke(['exec', '--help']), ['--json', '--output-last-message', '--model']);
}

export function registeredDesktopCodex() {
  if (process.platform !== 'win32') return [];
  const shell = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = [
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
    "$beyondPackages=@(Get-AppxPackage -Name 'OpenAI.Codex');",
    "$beyondCandidates=@($beyondPackages | ForEach-Object {",
    "$beyondExe=Join-Path $_.InstallLocation 'app/resources/codex.exe';",
    "if(Test-Path -LiteralPath $beyondExe -PathType Leaf){",
    "$beyondSignature=Get-AuthenticodeSignature -LiteralPath $beyondExe;",
    "[pscustomobject]@{command=$beyondExe;signatureValid=($beyondSignature.Status -eq 'Valid');publisher=$beyondSignature.SignerCertificate.Subject}",
    "}}); ConvertTo-Json -InputObject $beyondCandidates -Compress",
  ].join(' ');
  // A Node process launched by PowerShell Core can inherit its incompatible
  // module search path. Use only this system shell's own modules for the query.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  env.PSModulePath = path.join(path.dirname(shell), 'Modules');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 });
  if (result.error || result.status !== 0) return [];
  try { const rows = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()); return Array.isArray(rows) ? rows : []; } catch { return []; }
}

export function resolveCodexExecutable(profile, options = {}) {
  const { liveEndpoint = null, probe = probeCodexExecutable, registered = registeredDesktopCodex } = options;
  const command = profile.runner.command;
  const automatic = profile.runner.args.length === 0 && isDesktopCodexCommand(command, options);
  if (liveEndpoint && !liveEndpoint.provider && profile.mode === 'interactive') {
    // The caller has already verified both saved process identities. Preserve
    // their exact profile fingerprint, even if an upgrade removed the old file.
    // Every non-command field is still checked by the existing full-profile hash.
    if (same(command, liveEndpoint.command, options.platform) || (automatic && isDesktopCodexCommand(liveEndpoint.command, options))) {
      return { command: liveEndpoint.command, pinned: true };
    }
  }
  if (!automatic) return { command, pinned: false };
  const usable = candidate => {
    try {
      return fs.statSync(candidate).isFile() && isDesktopCodexCommand(fs.realpathSync(candidate), options) && probe(candidate, profile);
    } catch { return false; }
  };
  if (usable(command)) return { command, pinned: false };
  // Registration is the source of the current package, not hash-directory order
  // or timestamps. Ambiguous registrations never select an arbitrary version.
  const candidates = registered().filter(row => row.signatureValid === true && /(?:^|,\s*)(?:CN|O)=(?:"OpenAI OpCo, LLC"|OpenAI OpCo|OpenAI)(?:,|$)/i.test(row.publisher ?? '')
    && isDesktopCodexCommand(row.command, options));
  const distinct = [...new Map(candidates.map(row => [canonical(row.command), row.command])).values()];
  if (distinct.length !== 1 || !usable(distinct[0])) throw new Error('No compatible Codex CLI in the current signed Desktop installation; original sessions and results are unchanged');
  return { command: distinct[0], pinned: false };
}
