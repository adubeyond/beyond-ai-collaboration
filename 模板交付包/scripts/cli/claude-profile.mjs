import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Completion hooks are documented; interactive message injection is version-specific.
export const CLAUDE_VERSION = '2.1.294';
export function readClaudeProfile(profile) {
  const keys = ['schemaVersion', 'provider', 'runner', 'model', 'effort', 'mode', 'ui', 'permissionMode'];
  if (Object.keys(profile).some(k => !keys.includes(k)) || Object.keys(profile.runner ?? {}).some(k => !['command', 'args'].includes(k))) throw new Error('Claude profile cannot contain credentials or undocumented overrides');
  if (profile.schemaVersion !== 1 || profile.provider !== 'claude' || profile.mode !== 'interactive' || profile.ui !== 'window' || process.platform !== 'win32') throw new Error('Claude native adapter requires Windows interactive window mode');
  if (!path.isAbsolute(profile.runner?.command ?? '') || !fs.statSync(profile.runner.command).isFile() || path.extname(profile.runner.command).toLowerCase() !== '.exe' || !Array.isArray(profile.runner.args) || profile.runner.args.length || typeof profile.model !== 'string' || !profile.model.trim() || /[\r\n]/.test(profile.model)) throw new Error('Claude profile requires its native executable and an explicit model');
  if (!['dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'].includes(profile.permissionMode)) throw new Error('Claude permissionMode must be explicit');
  if (profile.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(profile.effort)) throw new Error('Claude effort unsupported by the pinned native CLI');
  checkClaudeCapability(profile);
  return profile;
}
export function checkClaudeCapability(profile) {
  const version = spawnSync(profile.runner.command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (version.status !== 0 || version.stdout.trim() !== `${CLAUDE_VERSION} (Claude Code)`) throw new Error('Claude Code version changed or unavailable; interactive adapter revalidation required');
}
export function claudeArguments(profile, binding, settingsPath, sessionId) {
  return ['--model', profile.model, ...(profile.effort ? ['--effort', profile.effort] : []), '--permission-mode', profile.permissionMode, '--settings', settingsPath, '--name', `BEYOND-${binding.taskId}`, ...(binding.sessionId ? ['--resume', binding.sessionId] : ['--session-id', sessionId])];
}
