import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// This adapter is deliberately opt-in: the upstream TUI is not a public machine API.
export const ZCODE_VERSION = '3.14.4-32';
const TUI_SHA256 = 'f906edf5fd6b4401e80d8572b889904f05bdf21fbefb98d21f2201bce87cd946';
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
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('ZCode adapter requires Node.js 24');
  const pkg = JSON.parse(fs.readFileSync(path.join(profile.packageRoot, 'package.json'), 'utf8'));
  const source = path.join(profile.packageRoot, 'vendor/node_modules/@zcode/tui/dist/index.js');
  if (pkg.name !== 'zcode-app-cli' || pkg.version !== ZCODE_VERSION || crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex') !== TUI_SHA256) throw new Error('ZCode TUI version/content changed; adapter revalidation required');
  return source;
}
export function prepareZcodeTui(profile, directory) {
  const source = checkZcodeCapability(profile);
  let text = fs.readFileSync(source, 'utf8');
  const once = (before, after) => {
    if (text.split(before).length !== 2) throw new Error('ZCode adapter patch target changed');
    text = text.replace(before, after);
  };
  once('from "@earendil-works/pi-tui";', `from ${JSON.stringify(pathToFileURL(path.join(profile.packageRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js')).href)};`);
  once('createRequire(import.meta.url)', `createRequire(${JSON.stringify(pathToFileURL(source).href)})`);
  once('if (this.sessionModelIssue) this.recoverSessionModel();\n\t\t\tawait this.done;', 'if (this.sessionModelIssue) this.recoverSessionModel();\n\t\t\tthis.__beyond = await attachZcode(this, this.options);\n\t\t\tawait this.done;');
  once('await new ZCodeTui(options).run();', 'const app = new ZCodeTui(options);\n\ttry { await app.run(); } finally { await app.__beyond?.close(); }');
  text = `import { attachZcode } from ${JSON.stringify(new URL('./zcode-tui-hook.mjs', import.meta.url).href)};\n` + text;
  fs.mkdirSync(directory, { recursive: true });
  const patched = path.join(directory, 'tui.mjs'), register = path.join(directory, 'register.mjs');
  fs.writeFileSync(patched, text, { mode: 0o600 });
  fs.writeFileSync(register, `import {registerHooks} from 'node:module';\nregisterHooks({resolve(s,c,next){return s==='@zcode/tui'?{url:${JSON.stringify(pathToFileURL(patched).href)},shortCircuit:true}:next(s,c);}});\n`, { mode: 0o600 });
  return register;
}
