import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkZcodeCapability, prepareZcodeTui, assertZcodeRuntimeCapability } from '../模板交付包/scripts/cli/zcode-profile.mjs';

// A real importable synthetic TUI. No CLI, credentials, network or user sessions.
const nativeSource = `import { createRequire } from 'node:module';
import { Renderer } from '@earendil-works/pi-tui';
const require = createRequire(import.meta.url);
export const marker = require('./marker.cjs');
class ZCodeTui {
  constructor(options) {
    this.options = options; this.sessionId = 'same-original-session';
    this.primaryTurnActive = false; this.activeSubmissions = 0;
    this.turnAssistantText = ''; this.pendingTurnNotificationDetail = '';
    this.done = Promise.resolve(); this.renderer = new Renderer();
    if (options.invalidate) this[options.invalidate] = null;
  }
  async run() {
    if (this.sessionModelIssue) this.recoverSessionModel();
    await this.done;
  }
  async submit() { this.options.onSubmit?.(); }
  finishTurn() {}
  onEvent() {}
  async handleResult(value) { Object.assign(this, value); }
  requestForegroundTurnInterrupt() {}
  stop() {}
  recoverSessionModel() {}
}
export async function runTui(options) { await new ZCodeTui(options).run(); }
`;
function fixture(t, text = nativeSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-zcode-capability-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('beyond-zcode-capability-'));
    fs.rmSync(root, { recursive: true });
  });
  const packageRoot = path.join(root, 'upstream');
  const source = path.join(packageRoot, 'vendor/node_modules/@zcode/tui/dist/index.js');
  const renderer = path.join(packageRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js');
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(path.dirname(renderer), { recursive: true });
  const pkg = path.join(packageRoot, 'package.json');
  fs.writeFileSync(pkg, JSON.stringify({ name: 'zcode-app-cli', version: 'future', type: 'module' }));
  fs.writeFileSync(path.join(packageRoot, 'node_modules/@earendil-works/pi-tui/package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(renderer, 'export class Renderer {}\n');
  fs.writeFileSync(source, text); fs.writeFileSync(path.join(path.dirname(source), 'marker.cjs'), "module.exports = 'original-package-dependency';\n");
  const output = path.join(root, 'task-copy');
  return { root, packageRoot, source, renderer, pkg, output, profile: { packageRoot } };
}
function rejectsWithoutOutput(f, pattern) {
  const before = fs.readFileSync(f.source, 'utf8');
  assert.throws(() => checkZcodeCapability(f.profile), pattern);
  assert.throws(() => prepareZcodeTui(f.profile, f.output), pattern);
  assert.equal(fs.existsSync(f.output), false);
  assert.equal(fs.readFileSync(f.source, 'utf8'), before);
}

test('version labels and unrelated source changes never gate a compatible TUI', t => {
  const f = fixture(t);
  for (const version of ['3.14.4-32', '3.14.4-33', '4.0.0', '42.0.0-preview', 'development', null]) {
    fs.writeFileSync(f.pkg, JSON.stringify({ name: 'zcode-app-cli', version, type: 'module' }));
    fs.writeFileSync(f.source, nativeSource + `\n// Unrelated release change: ${version}\nconst unrelated = ${JSON.stringify(version)};\n`);
    assert.equal(checkZcodeCapability(f.profile), f.source);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('whitespace, quote and braced recovery formatting remain compatible', t => {
  const text = nativeSource.replace("from '@earendil-works/pi-tui';", 'from "@earendil-works/pi-tui" ;')
    .replace('createRequire(import.meta.url)', 'createRequire ( import.meta.url )')
    .replace('if (this.sessionModelIssue) this.recoverSessionModel();\n    await this.done;', 'if ( this.sessionModelIssue ) { this.recoverSessionModel ( ); }\r\n await this.done ;')
    .replace('await new ZCodeTui(options).run();', 'await new ZCodeTui ( options ) . run ( ) ;');
  const f = fixture(t, text); assert.equal(checkZcodeCapability(f.profile), f.source);
  const preload = prepareZcodeTui(f.profile, f.output);
  assert.equal(fs.existsSync(preload), true); assert.equal(fs.readFileSync(f.source, 'utf8'), text);
});

const anchors = [
  ["from '@earendil-works/pi-tui';", 'TUI renderer import',
    s => s.replace("import { Renderer } from '@earendil-works/pi-tui';", 'const Renderer = class {};'),
    s => s + "\nimport { Renderer as OtherRenderer } from '@earendil-works/pi-tui';"],
  ['createRequire(import.meta.url)', 'original package dependency resolution',
    s => s.replace('createRequire(import.meta.url)', '(() => null)'),
    s => s + '\ncreateRequire(import.meta.url);'],
  ['if (this.sessionModelIssue) this.recoverSessionModel();\n    await this.done;', 'ready-session hook'],
  ['await new ZCodeTui(options).run();', 'native run lifecycle']
];
for (const [anchor, label, remove, duplicate] of anchors) {
  test(`missing ${label} rejects before writing any generated files`, t => {
    const f = fixture(t, remove ? remove(nativeSource) : nativeSource.replace(anchor, ''));
    rejectsWithoutOutput(f, new RegExp(label + ' must have exactly one'));
  });
  test(`ambiguous ${label} rejects instead of guessing a patch target`, t => {
    const f = fixture(t, duplicate ? duplicate(nativeSource) : nativeSource.replace(anchor, anchor + '\n' + anchor));
    rejectsWithoutOutput(f, new RegExp(label + ' must have exactly one'));
  });
  test(`comment or string-only ${label} is not a real capability`, t => {
    const absent = remove ? remove(nativeSource) : nativeSource.replace(anchor, '');
    const f = fixture(t, absent + '\n/* ' + anchor + ' */\nconst documentation = ' + JSON.stringify(anchor) + ';');
    rejectsWithoutOutput(f, new RegExp(label + ' must have exactly one'));
  });
}

test('literal and comment copies of anchors neither fake nor duplicate real capabilities', t => {
  const singleLine = anchors.map(([a]) => a.replace(/\s+/g, ' '));
  const text = nativeSource + '\n' + singleLine.map(a =>
    '// ' + a + '\n/* ' + a + ' */\nvoid ' + JSON.stringify(a) + ';\nvoid `' + a + '`;'
  ).join('\n') + '\nvoid /createRequire(import.meta.url)/;\nvoid /\\createRequire(import.meta.url)/u;';
  const f = fixture(t, text);
  assert.equal(checkZcodeCapability(f.profile), f.source);
  prepareZcodeTui(f.profile, f.output);
  const patched = fs.readFileSync(path.join(f.output, 'tui.mjs'), 'utf8');
  assert.equal(patched.split('guardZcodeRuntimeCapability(this, this.options').length - 1, 1);
  assert.equal(patched.split('this.__beyond = await attachZcode').length - 1, 1);
  assert.ok(singleLine.every(a => patched.includes('// ' + a)));
  assert.equal(fs.readFileSync(f.source, 'utf8'), text);
});

test('regex-only dependency anchor cannot pass and nested template expressions remain real code', t => {
  const noRequire = nativeSource.replace('createRequire(import.meta.url)', '(() => null)');
  const falseAnchor = fixture(t, noRequire + '\nvoid /\\createRequire(import.meta.url)/u;');
  rejectsWithoutOutput(falseAnchor, /original package dependency resolution must have exactly one/);
  const nested = fixture(t, nativeSource.replace('const require = createRequire(import.meta.url);',
    'const require = (() => null); void `outer ${`inner ${createRequire(import.meta.url)}`}`;'));
  assert.equal(checkZcodeCapability(nested.profile), nested.source);
  const division = fixture(t, nativeSource.replace('const require = createRequire(import.meta.url);',
    'const require = (() => null); void (2 / createRequire(import.meta.url));'));
  assert.equal(checkZcodeCapability(division.profile), division.source);
});

test('identifier suffixes and unrelated property methods are not dependency integration points', t => {
  const helpers = ['custom', '$', '任务', '\u{10400}', 'a\u200C'].map(prefix =>
    `const ${prefix}createRequire = x => x; ${prefix}createRequire(import.meta.url);`
  ).join('\n') + '\nconst helper = { createRequire: x => x }; helper.createRequire(import.meta.url);';
  const f = fixture(t, nativeSource + '\n' + helpers);
  assert.equal(checkZcodeCapability(f.profile), f.source);
  prepareZcodeTui(f.profile, f.output);
  assert.ok(fs.readFileSync(path.join(f.output, 'tui.mjs'), 'utf8').includes(helpers));
  const missing = fixture(t, nativeSource.replace('createRequire(import.meta.url)', '(() => null)') + '\n' + helpers);
  rejectsWithoutOutput(missing, /original package dependency resolution must have exactly one/);
});

test('a failed syntax-check process cannot be mistaken for executable integration code', t => {
  const f = fixture(t);
  t.mock.property(process, 'execPath', path.join(f.root, 'missing-node.exe'));
  rejectsWithoutOutput(f, /JavaScript syntax checker/);
});

test('wrong package, absent native source and missing renderer report actual missing capability', t => {
  const f = fixture(t);
  fs.writeFileSync(f.pkg, JSON.stringify({ name: 'other', version: '3.14.4-32' }));
  rejectsWithoutOutput(f, /expected zcode-app-cli/);
  fs.writeFileSync(f.pkg, JSON.stringify({ name: 'zcode-app-cli' }));
  fs.unlinkSync(f.renderer); rejectsWithoutOutput(f, /renderer dependency/);
  fs.unlinkSync(f.source);
  assert.throws(() => checkZcodeCapability(f.profile), /native TUI source/);
  assert.throws(() => prepareZcodeTui(f.profile, f.output), /native TUI source/);
  assert.equal(fs.existsSync(f.output), false);
});

test('invalid generated JavaScript rejects without executing source or producing a partial copy', t => {
  const f = fixture(t, nativeSource + '\nexport const broken = ;');
  rejectsWithoutOutput(f, /JavaScript syntax/);
});

function runtime() {
  const calls = { model: 0, submit: 0 };
  const app = { sessionId: 'same-original-session', primaryTurnActive: false, activeSubmissions: 0, turnAssistantText: '',
    submit() { calls.submit++; }, finishTurn() {}, onEvent() {}, handleResult() {}, requestForegroundTurnInterrupt() {}, stop() {} };
  const options = { setTransientModel() { calls.model++; } };
  return { app, options, calls };
}
test('actual objects allow native session fallback and only require effort selection when requested', () => {
  const f = runtime(); assert.doesNotThrow(() => assertZcodeRuntimeCapability(f.app, f.options));
  assert.throws(() => assertZcodeRuntimeCapability(f.app, f.options, true), /effort selection/);
  f.options.submitPrompt = () => {};
  assert.doesNotThrow(() => assertZcodeRuntimeCapability(f.app, f.options, true));
  f.options.getMainSessionId = () => f.app.sessionId;
  assert.doesNotThrow(() => assertZcodeRuntimeCapability(f.app, f.options));
  assert.deepEqual(f.calls, { model: 0, submit: 0 });
});
test('missing and noncallable native methods reject before any model or business action', () => {
  for (const name of ['submit', 'finishTurn', 'onEvent', 'handleResult', 'requestForegroundTurnInterrupt', 'stop']) {
    for (const value of [undefined, 'function-looking text']) {
      const f = runtime(); f.app[name] = value;
      assert.throws(() => assertZcodeRuntimeCapability(f.app, f.options), new RegExp(`app.${name}`));
      assert.deepEqual(f.calls, { model: 0, submit: 0 });
    }
  }
});
test('model, identity, busy and result capabilities are checked without demanding nonempty results', () => {
  const cases = [
    [f => { f.options.setTransientModel = null; }, /model selection/],
    [f => { f.options.getMainSessionId = 'not callable'; }, /identity getter/],
    [f => { f.options.getMainSessionId = () => { throw Error('fixture'); }; }, /identity lookup/],
    [f => { f.app.sessionId = ''; }, /original session identity/],
    [f => { f.app.primaryTurnActive = undefined; }, /busy state/],
    [f => { f.app.activeSubmissions = -1; }, /busy state/],
    [f => { f.app.activeSubmissions = NaN; }, /busy state/],
    [f => { f.app.turnAssistantText = undefined; }, /result text/]
  ];
  for (const [change, error] of cases) { const f = runtime(); change(f); assert.throws(() => assertZcodeRuntimeCapability(f.app, f.options), error); assert.deepEqual(f.calls, { model: 0, submit: 0 }); }
  const f = runtime(); delete f.app.turnAssistantText; f.app.pendingTurnNotificationDetail = '';
  assert.doesNotThrow(() => assertZcodeRuntimeCapability(f.app, f.options));
});

async function generated(t, { invalidate, effort } = {}) {
  const f = fixture(t); if (effort) f.profile.effort = effort;
  const before = [f.pkg, f.source, f.renderer].map(p => fs.readFileSync(p, 'utf8'));
  const calls = []; let selections = 0, submissions = 0;
  const connection = path.join(f.root, 'connection.json');
  const startupErrorPath = path.join(f.root, 'zcode-startup-error.json');
  fs.writeFileSync(connection, JSON.stringify({ url: 'http://127.0.0.1:1/', token: 'test', model: 'fixture/model', startupErrorPath, ...(effort ? { effort } : {}) }));
  const previousConnection = process.env.BEYOND_ZCODE_CONNECTION;
  process.env.BEYOND_ZCODE_CONNECTION = connection;
  t.after(() => { if (previousConnection === undefined) delete process.env.BEYOND_ZCODE_CONNECTION; else process.env.BEYOND_ZCODE_CONNECTION = previousConnection; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/command') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true }));
    calls.push({ route, body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  prepareZcodeTui(f.profile, f.output);
  const module = await import(pathToFileURL(path.join(f.output, 'tui.mjs')).href);
  assert.equal(module.marker, 'original-package-dependency');
  const options = { invalidate, workspaceDirectory: f.root, setTransientModel: async model => { selections++; return { model }; }, onSubmit: () => { submissions++; } };
  const action = module.runTui(options);
  if (invalidate || effort) {
    const expected = invalidate ? new RegExp(`app.${invalidate}`) : /effort selection/;
    await assert.rejects(action, expected);
    assert.match(JSON.parse(fs.readFileSync(startupErrorPath, 'utf8')).error, expected);
  } else {
    await action;
    assert.equal(fs.existsSync(startupErrorPath), false);
  }
  assert.deepEqual([f.pkg, f.source, f.renderer].map(p => fs.readFileSync(p, 'utf8')), before);
  return { calls, selections, submissions };
}
test('generated TUI imports original dependencies and connects the unchanged hook to the original session', async t => {
  const f = await generated(t);
  assert.equal(f.selections, 1); assert.equal(f.submissions, 0);
  assert.deepEqual(f.calls.map(c => c.route), ['/register', '/ended']);
  assert.ok(f.calls.every(c => c.body.sessionId === 'same-original-session'));
});
test('generated TUI runtime rejection occurs before model changes, registration or submission', async t => {
  const f = await generated(t, { invalidate: 'finishTurn' });
  assert.deepEqual(f, { calls: [], selections: 0, submissions: 0 });
});
test('generated effort request cannot bypass the runtime capability check', async t => {
  const f = await generated(t, { effort: 'high' });
  assert.deepEqual(f, { calls: [], selections: 0, submissions: 0 });
});
