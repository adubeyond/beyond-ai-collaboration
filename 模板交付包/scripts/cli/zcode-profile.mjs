import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { redact } from './native-cli-runner.mjs';

// The private TUI is opt-in. Check its integration surface, not its release label.
export function readZcodeProfile(profile) {
  const keys = ['schemaVersion', 'provider', 'runner', 'packageRoot', 'model', 'effort', 'mode', 'ui'];
  if (Object.keys(profile).some(k => !keys.includes(k)) || Object.keys(profile.runner ?? {}).some(k => !['command', 'args'].includes(k))) throw new Error('ZCode profile cannot contain credentials or undocumented overrides');
  if (profile.schemaVersion !== 1 || profile.provider !== 'zcode' || profile.mode !== 'interactive' || profile.ui !== 'window' || process.platform !== 'win32') throw new Error('ZCode native adapter requires Windows interactive window mode');
  if (!path.isAbsolute(profile.runner?.command ?? '') || !fs.statSync(profile.runner.command).isFile() || !Array.isArray(profile.runner.args) || profile.runner.args.some(a => typeof a !== 'string' || /(?:api[_-]?key|auth|--last|--prompt|--resume|--json)/i.test(a)) || !path.isAbsolute(profile.packageRoot ?? '') || typeof profile.model !== 'string' || !profile.model.trim()) throw new Error('invalid ZCode profile');
  if (profile.effort !== undefined && (typeof profile.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(profile.effort))) throw new Error('invalid ZCode effort');
  checkZcodeCapability(profile);
  return profile;
}
export function checkZcodeCapability(profile) {
  return compatibleTui(profile).source;
}
function unavailable(capability) {
  return new Error(`ZCode adapter capability unavailable: ${capability}`);
}
function syntaxValid(text) {
  // Parse only; never import or execute upstream code. Parser failures are not
  // evidence of a code position, so distinguish SyntaxError from process errors.
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: text, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.signal || (result.status !== 0 && !(result.status === 1 && /SyntaxError:/.test(result.stderr)))) throw unavailable('JavaScript syntax checker');
  return result.status === 0;
}
function compatibleTui(profile) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('ZCode adapter requires Node.js 24');
  const pkg = JSON.parse(fs.readFileSync(path.join(profile.packageRoot, 'package.json'), 'utf8'));
  const source = path.join(profile.packageRoot, 'vendor/node_modules/@zcode/tui/dist/index.js');
  const renderer = path.join(profile.packageRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js');
  if (pkg.name !== 'zcode-app-cli') throw unavailable('expected zcode-app-cli package');
  for (const [file, label] of [[source, 'native TUI source'], [renderer, 'TUI renderer dependency']]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw unavailable(label);
  }
  let text = fs.readFileSync(source, 'utf8');
  if (!syntaxValid(text)) throw unavailable('native TUI JavaScript syntax');
  const once = (label, pattern, replacement) => {
    const matches = [...text.matchAll(pattern)].filter(match => {
      // A raw NUL after the leading keyword is invalid in executable code, but
      // valid in comments/string/template text/regex literals. Use Node's parser
      // rather than treating text inside those literals as an integration point.
      const position = match.index + match[0].match(/^\w+/)[0].length;
      return !syntaxValid(text.slice(0, position) + '\0' + text.slice(position));
    });
    if (matches.length !== 1) throw unavailable(`${label} must have exactly one integration point`);
    const match = matches[0], value = typeof replacement === 'function' ? replacement(match[0]) : replacement;
    text = text.slice(0, match.index) + value + text.slice(match.index + match[0].length);
  };
  once('TUI renderer import', /(?<![\p{ID_Continue}$\u200C\u200D.])from\s*(['"])@earendil-works\/pi-tui\1\s*;/gu,
    () => `from ${JSON.stringify(pathToFileURL(renderer).href)};`);
  once('original package dependency resolution', /(?<![\p{ID_Continue}$\u200C\u200D.])createRequire\s*\(\s*import\.meta\.url\s*\)/gu,
    () => `createRequire(${JSON.stringify(pathToFileURL(source).href)})`);
  once('ready-session hook', /(?<![\p{ID_Continue}$\u200C\u200D.])if\s*\(\s*this\.sessionModelIssue\s*\)\s*(?:this\.recoverSessionModel\s*\(\s*\)\s*;|\{\s*this\.recoverSessionModel\s*\(\s*\)\s*;\s*\})\s*await\s+this\.done\s*;/gu,
    match => match.replace(/await\s+this\.done\s*;/, `guardZcodeRuntimeCapability(this, this.options, ${profile.effort !== undefined});\nthis.__beyond = await attachZcode(this, this.options);\nawait this.done;`));
  once('native run lifecycle', /(?<![\p{ID_Continue}$\u200C\u200D.])await\s+new\s+ZCodeTui\s*\(\s*options\s*\)\s*\.\s*run\s*\(\s*\)\s*;/gu,
    'const __beyondApp = new ZCodeTui(options);\ntry { await __beyondApp.run(); } finally { await __beyondApp.__beyond?.close(); }');
  text = `import { attachZcode } from ${JSON.stringify(new URL('./zcode-tui-hook.mjs', import.meta.url).href)};\nimport { guardZcodeRuntimeCapability } from ${JSON.stringify(import.meta.url)};\n` + text;
  if (!syntaxValid(text)) throw unavailable('generated TUI JavaScript syntax');
  return { source, text };
}
export function assertZcodeRuntimeCapability(app, options, requireEffort = false) {
  // Check real objects before the existing hook changes models, registers or submits.
  for (const name of ['submit', 'finishTurn', 'onEvent', 'handleResult', 'requestForegroundTurnInterrupt', 'stop']) {
    if (typeof app?.[name] !== 'function') throw unavailable(`native app.${name}()`);
  }
  if (typeof options?.setTransientModel !== 'function') throw unavailable('session model selection');
  if (requireEffort && typeof options.submitPrompt !== 'function') throw unavailable('session effort selection');
  if (options.getMainSessionId !== undefined && typeof options.getMainSessionId !== 'function') throw unavailable('session identity getter');
  let sessionId;
  try { sessionId = options.getMainSessionId?.() ?? app.sessionId; }
  catch { throw unavailable('session identity lookup'); }
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw unavailable('original session identity');
  if (typeof app.primaryTurnActive !== 'boolean' || !Number.isInteger(app.activeSubmissions) || app.activeSubmissions < 0) throw unavailable('native busy state');
  if (typeof app.turnAssistantText !== 'string' && typeof app.pendingTurnNotificationDetail !== 'string') throw unavailable('native result text');
}
export function guardZcodeRuntimeCapability(app, options, requireEffort = false) {
  try { assertZcodeRuntimeCapability(app, options, requireEffort); }
  catch (error) {
    // Preserve pre-hook failures in the same per-run channel the unchanged
    // native hook uses; the owner must not receive only a generic window exit.
    const connection = JSON.parse(fs.readFileSync(process.env.BEYOND_ZCODE_CONNECTION, 'utf8'));
    if (connection.startupErrorPath) fs.writeFileSync(connection.startupErrorPath, JSON.stringify({ error: redact(error.message).slice(0, 2000) }), { flag: 'wx', mode: 0o600 });
    throw error;
  }
}
export function prepareZcodeTui(profile, directory) {
  const { text } = compatibleTui(profile);
  fs.mkdirSync(directory, { recursive: true });
  const patched = path.join(directory, 'tui.mjs'), register = path.join(directory, 'register.mjs');
  fs.writeFileSync(patched, text, { mode: 0o600 });
  fs.writeFileSync(register, `import {registerHooks} from 'node:module';\nregisterHooks({resolve(s,c,next){return s==='@zcode/tui'?{url:${JSON.stringify(pathToFileURL(patched).href)},shortCircuit:true}:next(s,c);}});\n`, { mode: 0o600 });
  return register;
}
