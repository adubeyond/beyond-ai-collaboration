import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Probe executable availability, never a version allowlist or version range.
// Native session identity, handshake and delivery checks remain authoritative.
export function readClaudeProfile(profile) {
  const keys = ['schemaVersion', 'provider', 'runner', 'model', 'effort', 'mode', 'ui', 'permissionMode'];
  if (Object.keys(profile).some(k => !keys.includes(k)) || Object.keys(profile.runner ?? {}).some(k => !['command', 'args'].includes(k))) throw new Error('Claude profile cannot contain credentials or undocumented overrides');
  if (profile.schemaVersion !== 1 || profile.provider !== 'claude' || profile.mode !== 'interactive' || profile.ui !== 'window' || process.platform !== 'win32') throw new Error('Claude native adapter requires Windows interactive window mode');
  if (!path.isAbsolute(profile.runner?.command ?? '') || !fs.statSync(profile.runner.command).isFile() || path.extname(profile.runner.command).toLowerCase() !== '.exe' || !Array.isArray(profile.runner.args) || profile.runner.args.length || typeof profile.model !== 'string' || !profile.model.trim() || /[\r\n]/.test(profile.model)) throw new Error('Claude profile requires its native executable and an explicit model');
  if (!['dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'].includes(profile.permissionMode)) throw new Error('Claude permissionMode must be explicit');
  if (profile.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(profile.effort)) throw new Error('Claude effort unsupported by the native adapter');
  checkClaudeCapability(profile);
  return profile;
}
export function checkClaudeCapability(profile) {
  const version = spawnSync(profile.runner.command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (version.error || version.status !== 0 || typeof version.stdout !== 'string' || !version.stdout.trim()) throw new Error('Claude Code version probe failed; executable unavailable or returned no version information');
}
export function claudeArguments(profile, binding, settingsPath, sessionId) {
  return ['--model', profile.model, ...(profile.effort ? ['--effort', profile.effort] : []), '--permission-mode', profile.permissionMode, '--settings', settingsPath, '--name', `BEYOND-${binding.taskId}`, ...(binding.sessionId ? ['--resume', binding.sessionId] : ['--session-id', sessionId])];
}
