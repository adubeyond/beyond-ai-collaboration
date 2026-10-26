import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliTaskStore, atomicJson, digest, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { launchCliRequest } from '../模板交付包/scripts/cli/cli-bridge.mjs';

const contract = {
  goal: 'Deliver the complete isolated business outcome, including continued input and recovery',
  boundaries: 'Only this temporary fixture; preserve source identity and existing persisted evidence',
  acceptance: 'Actual delivery and recovery evidence; a stage is not completion of the whole goal',
  factEntries: ['fixture-facts'], skillEntries: [],
};
const firstStage = { goal: 'Inspect the first bounded window', acceptance: 'Retain the first stable result' };
const nextStage = { goal: 'Repair and verify the next bounded window', acceptance: 'Show continued input and persisted recovery' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function isolatedHostEnvironment(source = process.env, platform = process.platform) {
  const keys = ['PATH', 'Path', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec',
    'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA', 'ALLUSERSPROFILE', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'];
  const env = Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  // powershell.exe is Windows PowerShell, not the invoking pwsh's module host.
  // Keep its system modules available without inheriting user/plugin modules.
  if (platform === 'win32') env.PSModulePath = path.win32.join(source.SystemRoot ?? source.windir, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return env;
}
test('isolated desktop environment preserves OS startup inputs without credentials or live routing', () => {
  const source = { SystemRoot: 'fixture-system', APPDATA: 'fixture-roaming', LOCALAPPDATA: 'fixture-local',
    PATH: 'fake-path', TEMP: 'fake-temp', PSModulePath: 'untrusted-pwsh-module',
    OPENAI_API_KEY: 'fake-key', ANTHROPIC_API_KEY: 'fake-key', GH_TOKEN: 'fake-token', NODE_OPTIONS: 'fake-preload',
    CODEX_HOME: 'live-home', CODEX_THREAD_ID: 'live-owner', CODEX_APP_TOOLS_PIPE_PATH: 'live-pipe' };
  const env = isolatedHostEnvironment(source, 'win32');
  assert.deepEqual(Object.keys(env).sort(), ['SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'TEMP', 'PSModulePath'].sort());
  assert.equal(env.PSModulePath, path.win32.join(source.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'));
  for (const key of ['SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'TEMP']) assert.equal(env[key], source[key]);
  const routed = { ...env, CODEX_HOME: 'fixture-home', CODEX_THREAD_ID: 'fixture-owner', CODEX_APP_TOOLS_PIPE_PATH: 'fixture-pipe' };
  assert.equal(routed.CODEX_HOME, 'fixture-home'); assert.equal(routed.CODEX_THREAD_ID, 'fixture-owner'); assert.equal(routed.CODEX_APP_TOOLS_PIPE_PATH, 'fixture-pipe');
});
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('isolated next-bridge fixture timed out');
    await wait(20);
  }
}

function committedFixtureResult(store, binding, number) {
  const lock = path.join(store.taskDir(binding), '.lock');
  const file = path.join(store.runDir(binding, number), 'result.json');
  if (fs.existsSync(lock) || !fs.existsSync(file)) return null;
  const result = store.readResult(binding, number), state = store.read(binding);
  // finishRun publishes result.json before committing task.json and releasing
  // its lock. The fixture may review only the completed transaction, not that
  // intermediate file. Read/identity failures remain visible to the test.
  if (state.runNumber !== number || state.currentResultPath !== file
    || state.sessionId !== result.sessionId || state.status !== result.status
    || fs.existsSync(lock)) return null;
  return result;
}

function fixture(t, { notifications = false, entryPoint = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-next-bridge-'));
  const controlRoot = path.join(root, 'control'), executionRoot = path.join(root, 'project');
  const home = path.join(root, 'cli-home'), profilePath = path.join(root, 'profile.json');
  for (const directory of [path.join(controlRoot, 'local/projects'), executionRoot, home]) fs.mkdirSync(directory, { recursive: true });
  const binding = {
    projectId: 'next-project', taskId: 'whole-goal', ownerThreadId: 'next-owner', ownerTurnId: 'dispatch-turn',
    executionRoot, profilePath, taskMode: 'assist', contract: structuredClone(contract),
  };
  fs.writeFileSync(path.join(controlRoot, 'local/projects', binding.projectId + '.md'),
    `---\nid: ${binding.projectId}\npath: ${executionRoot}\nhost_id: local\ncodex_project_id: fixture-project\n---\n`);
  fs.writeFileSync(path.join(executionRoot, 'AGENTS.md'),
    `<!-- BEYOND-CONTROL-ROOT: ../control -->\n<!-- BEYOND-PROJECT-ID: ${binding.projectId} -->\n`);
  const fake = path.join(root, 'fake-native.cjs');
  // The real manager/runner builds argv and writes stdin. Only the model process is fake.
  fs.writeFileSync(fake, `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),final=args[args.indexOf('--output-last-message')+1];
const runNumber=Number(path.basename(path.dirname(final)));
const session=args.includes('resume')?args[args.indexOf('resume')+1]:'same-native-session';
console.log(JSON.stringify({type:'thread.started',thread_id:session}));
let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
  const capture=path.join(process.cwd(),'native-'+runNumber+'.json');
  fs.writeFileSync(capture+'.tmp',JSON.stringify({args,prompt,session,runNumber,pid:process.pid}));
  fs.renameSync(capture+'.tmp',capture);
  console.log(JSON.stringify({type:'fixture.input.ready',runNumber}));
  const timer=setInterval(()=>{
    if(!fs.existsSync(path.join(${JSON.stringify(root)},'release-'+runNumber))&&!fs.existsSync(path.join(${JSON.stringify(root)},'release-all')))return;
    clearInterval(timer);fs.writeFileSync(final,'stable fixture result '+runNumber);
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
  },15);
});
`);
  const profile = { schemaVersion: 1, runner: { command: process.execPath, args: [fake] }, codexHome: home, model: 'fixture-default', effort: 'medium' };
  atomicJson(profilePath, profile);
  const store = new CliTaskStore({ controlRoot });
  const context = { controlRoot, executionRoot, ownerThreadId: binding.ownerThreadId, ownerTurnId: binding.ownerTurnId };
  const source = entryPoint ? path.join(root, 'sessions', 'rollout-' + binding.ownerThreadId + '.jsonl') : path.join(root, 'owner.jsonl');
  const calls = path.join(root, 'callbacks.jsonl');
  const event = (type, turn_id = binding.ownerTurnId) => fs.appendFileSync(source, JSON.stringify({ type: 'event_msg', payload: { type, turn_id } }) + '\n');
  if (notifications) {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, JSON.stringify({ type: 'session_meta', payload: { id: binding.ownerThreadId } }) + '\n');
    event('task_started');
    const pluginRoot = entryPoint ? path.join(root, 'plugins/cache/openai-bundled') : path.join(root, 'plugins');
    const plugin = path.join(pluginRoot, 'codex-app-tools', '1.0.0');
    fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
    atomicJson(path.join(plugin, '.codex-plugin/plugin.json'), { name: 'codex-app-tools', version: '1.0.0', mcpServers: './.mcp.json' });
    const server = path.join(plugin, 'server.cjs');
    fs.writeFileSync(server, `
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;let result={};
if(q.method==='tools/list')result={tools:[{name:'send_message_to_thread',inputSchema:{type:'object',properties:{threadId:{type:'string'},prompt:{type:'string'}},required:['threadId','prompt']}}]};
if(q.method==='tools/call'){
  fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(q.params)+'\\n');
  const turn='fixture-notification-'+process.pid;
  for(const type of ['task_started','task_complete'])fs.appendFileSync(${JSON.stringify(source)},JSON.stringify({type:'event_msg',payload:{type,turn_id:turn}})+'\\n');
  result={content:[{type:'text',text:'fixture delivered'}]};
}console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});
`);
    atomicJson(path.join(plugin, '.mcp.json'), { mcpServers: { codex_app: { command: process.execPath, args: [server], cwd: plugin } } });
    const env = isolatedHostEnvironment();
    context.hostSpec = { env: { ...env, CODEX_HOME: root, CODEX_THREAD_ID: binding.ownerThreadId, CODEX_APP_TOOLS_PIPE_PATH: 'isolated-fake-transport' }, pluginRoot, sourceRecordPath: source, handoffTimeoutMs: 5000 };
  }
  const identity = Object.fromEntries(['projectId', 'taskId', 'ownerThreadId'].map(key => [key, binding[key]]));
  const request = (action, requestId, input = {}) => ({ schemaVersion: 1, requestId, action, input: { ...identity, ...input } });
  const send = (action, requestId, input) => launchCliRequest(request(action, requestId, input), context);
  let entrySequence = 0;
  const entryProbe = path.join(root, 'entry-probe.cjs');
  if (entryPoint) {
    assert.equal(notifications, true, 'entrypoint fixture requires its isolated desktop environment');
    const scripts = path.join(controlRoot, 'scripts');
    fs.mkdirSync(path.join(scripts, 'runtime'), { recursive: true });
    // Only executable bridge dependencies are copied, never the repository or business tree.
    fs.cpSync(fileURLToPath(new URL('../模板交付包/scripts/cli/', import.meta.url)), path.join(scripts, 'cli'), { recursive: true });
    for (const file of ['project-identity-provider.mjs', 'workbench-transaction.mjs', 'delivery-policy.mjs']) {
      fs.copyFileSync(fileURLToPath(new URL('../模板交付包/scripts/runtime/' + file, import.meta.url)), path.join(scripts, 'runtime', file));
    }
    // Trace only this fixture's subprocess boundaries. No argv, environment or
    // subprocess output is logged; keep the real commands and deadlines intact.
    fs.writeFileSync(entryProbe, `
const cp = require('node:child_process'), path = require('node:path');
const original = cp.spawnSync, started = Date.now();
const report = data => process.stderr.write(JSON.stringify({fixtureEntry: true, elapsedMs: Date.now() - started, ...data}) + '\\n');
report({phase: 'started'});
cp.spawnSync = function(command, ...args) {
  const at = Date.now(), executable = path.basename(String(command));
  report({phase: 'subprocess-start', executable});
  try { const result = original.call(this, command, ...args); report({phase: 'subprocess-end', executable, durationMs: Date.now() - at, status: result.status, error: result.error?.code}); return result; }
  catch (error) { report({phase: 'subprocess-throw', executable, durationMs: Date.now() - at, error: error.code}); throw error; }
};
require('node:module').syncBuiltinESMExports();
process.on('beforeExit', () => report({phase: 'beforeExit', resources: process.getActiveResourcesInfo()}));
`);
  }
  async function sendEntry(action, requestId, input) {
    assert.equal(entryPoint, true);
    const file = path.join(root, 'entry-request-' + (++entrySequence) + '.json');
    atomicJson(file, request(action, requestId, input));
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', entryProbe, path.join(controlRoot, 'scripts/cli/cli-bridge.mjs'), '--request', file], {
        cwd: executionRoot, env: context.hostSpec.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', expired = false;
      const timer = setTimeout(() => { expired = true; child.kill(); }, 20000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, expired }); });
    });
    const observed = {
      action, requestId, code: outcome.code, expired: outcome.expired,
      responseWritten: outcome.stdout.trim().startsWith('{'), trace: outcome.stderr.trim(),
      queueSaved: fs.existsSync(store.locator(binding)) && store.read(binding).continuations?.some(item => item.requestId === requestId),
      lockPresent: fs.existsSync(path.join(store.taskDir(binding), '.lock')),
    };
    // Emit compact evidence before cleanup even on a failed test, instead of
    // discarding the only distinction between startup, command and exit stalls.
    t.diagnostic(JSON.stringify(observed));
    assert.equal(outcome.expired, false, 'isolated CLI bridge entry timed out: ' + JSON.stringify(observed));
    assert.equal(outcome.code, 0, outcome.stderr);
    const response = JSON.parse(outcome.stdout.trim());
    assert.equal(response.ok, true); return response.result;
  }
  const capture = number => {
    const file = path.join(executionRoot, 'native-' + number + '.json');
    const events = path.join(store.runDir(binding, number), 'events.jsonl');
    // A native capture alone precedes the manager's session registration. The
    // next event is logged only after thread.started/bindSession has returned.
    // This fixture barrier tests replay after startup, not incidental lock timing.
    if (!fs.existsSync(file) || !fs.existsSync(events)) return null;
    const rows = fs.readFileSync(events, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
    if (!rows.some(row => row.type === 'fixture.input.ready' && row.runNumber === number)) return null;
    const state = store.read(binding);
    assert.equal(state.sessionId, 'same-native-session');
    assert.ok(state.runNumber >= number);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const captures = () => fs.readdirSync(executionRoot).filter(name => /^native-\d+\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(executionRoot, name), 'utf8')));
  const callbackRows = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const release = number => fs.writeFileSync(path.join(root, 'release-' + number), 'release');
  const result = number => {
    const file = path.join(store.runDir(binding, number), 'result.json');
    return fs.existsSync(file) ? store.readResult(binding, number) : null;
  };
  const reviewInput = (number = 1, decision = 'continue') => ({
    runNumber: number, resultSha256: sha256File(path.join(store.runDir(binding, number), 'result.json')),
    decision, evidenceLocator: 'fixture:stable-result-' + number, conclusion: 'Owner checked this exact stable result', reviewedAt: '2026-10-16T08:00:00.000Z',
  });
  const queue = (requestId = 'next', extra = {}) => send('cli.queue', requestId, {
    prompt: 'Implement the next authorized bounded step', stage: nextStage, expectedRunNumber: 1, expectedSessionId: 'same-native-session', ...extra,
  });
  async function start() {
    const first = await send('cli.start', 'start', { ...binding, prompt: 'Inspect and retain first evidence', stage: firstStage, configuration: { model: 'chosen-fixture-model', effort: 'high' } });
    await until(() => capture(1));
    return first;
  }
  async function finish(number) {
    release(number);
    const value = await until(() => committedFixtureResult(store, binding, number));
    assert.equal(value.status, 'completed', 'fixture manager must finish successfully: ' + JSON.stringify(value));
    return value;
  }
  t.after(async () => {
    fs.writeFileSync(path.join(root, 'release-all'), 'release');
    if (notifications) {
      const last = fs.readFileSync(source, 'utf8').trim().split('\n').map(line => JSON.parse(line)).findLast(row => row.type === 'event_msg' && row.payload?.type === 'task_started');
      event('task_complete', last?.payload.turn_id ?? binding.ownerTurnId);
    }
    if (fs.existsSync(store.locator(binding))) {
      const current = store.read(binding);
      if (current.runNumber && captures().some(row => row.runNumber === current.runNumber)) await until(() => result(current.runNumber));
      if (notifications && current.runNumber) await until(() => {
        for (let n = 1; n <= current.runNumber; n++) {
          if (!result(n)) continue;
          const file = path.join(store.runDir(binding, n), 'notification.json');
          if (!fs.existsSync(file) || store.readJson(file).status === 'claimed') return false;
        }
        return true;
      });
    }
    await wait(100);
    const physical = fs.realpathSync(root);
    assert.equal(path.dirname(physical).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(physical).startsWith('beyond-cli-next-bridge-'));
    fs.rmSync(physical, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { root, binding, identity, context, store, profile, profilePath, request, send, sendEntry, start, finish, capture, captures, result, reviewInput, queue, callbackRows, event };
}

test('fixture finish barrier requires the same committed run and released write lock', async t => {
  const f = fixture(t);
  f.store.create(f.binding);
  const first = f.store.beginRun(f.binding, { requestId: 'barrier-first', prompt: 'isolated transaction proof',
    expectedRunNumber: 0, expectedSessionId: null, profile: f.profile });
  f.store.bindSession(first, 'same-native-session');
  const probe = number => committedFixtureResult(f.store, f.binding, number);
  assert.equal(probe(1), null, 'no result is not a finished transaction');
  assert.throws(() => f.store.finishRun(first, { status: 'completed', finalText: 'first stable result' },
    { faultAt: 'afterResult' }), /injected fault afterResult/);
  assert.equal(f.result(1).status, 'completed');
  assert.equal(f.store.read(f.binding).currentResultPath, null);
  assert.equal(probe(1), null, 'a published result with uncommitted task state cannot release finish');
  f.store.reconcileResult(f.binding, digest(f.store.read(f.binding)));
  const completed = f.result(1), bytes = fs.readFileSync(first.resultPath);
  f.store.withLock(f.binding, () => {
    assert.equal(f.store.read(f.binding).currentResultPath, first.resultPath);
    assert.equal(probe(1), null, 'even matching committed state must wait for the writer lock');
  });
  assert.deepEqual(probe(1), completed, 'commit plus lock release satisfies the barrier');
  fs.writeFileSync(first.resultPath, '{');
  assert.throws(() => probe(1), SyntaxError, 'malformed persisted evidence is not swallowed as pending');
  fs.writeFileSync(first.resultPath, bytes);
  f.store.recordReview({ ...f.identity, ...f.reviewInput() });
  const second = f.store.beginRun(f.binding, { requestId: 'barrier-second', prompt: 'next isolated transaction',
    expectedRunNumber: 1, expectedSessionId: 'same-native-session', profile: f.profile });
  assert.equal(probe(1), null, 'the retained prior result cannot finish a different current run');
  f.store.finishRun(second, { status: 'completed', finalText: 'second stable result' });
  assert.equal(probe(1), null, 'a later committed run is not proof that the requested run is current');
  assert.equal(probe(2).runNumber, 2);
  assert.deepEqual(fs.readFileSync(first.resultPath), bytes, 'prior evidence stays unchanged');
});

function preservedRun(f, number) {
  return Object.fromEntries(['run.json', 'input.json', 'result.json'].map(name => [name, fs.readFileSync(path.join(f.store.runDir(f.binding, number), name), 'utf8')]));
}
function assertPrompt(capture, stage) {
  assert.ok(capture.prompt.includes(contract.goal), 'native stdin retains the full business goal');
  assert.ok(capture.prompt.includes(contract.boundaries));
  assert.ok(capture.prompt.includes(contract.acceptance));
  assert.ok(capture.prompt.includes(stage.goal), 'native stdin carries the current stage goal');
  assert.ok(capture.prompt.includes(stage.acceptance), 'native stdin carries the current stage acceptance');
  assert.equal(capture.args[capture.args.indexOf('--model') + 1], 'chosen-fixture-model');
  assert.ok(capture.args.includes('model_reasoning_effort="high"'));
}

test('busy queue, explicit replacement and duplicate review launch one same-session stage with one notification per result', { timeout: 60000 }, async t => {
  const f = fixture(t, { notifications: true }); await f.start();
  assertPrompt(f.capture(1), firstStage);
  const firstInput = fs.readFileSync(path.join(f.store.runDir(f.binding, 1), 'input.json'), 'utf8');
  const firstRun = fs.readFileSync(path.join(f.store.runDir(f.binding, 1), 'run.json'), 'utf8');
  const pending = await f.queue();
  assert.equal(pending.status, 'pending'); assert.equal(pending.requestId, 'next');
  assert.deepEqual(await f.queue(), pending);
  for (const forbidden of [{ configuration: { model: 'other-model' } }, { permissionMode: 'new-authority' }]) {
    await assert.rejects(() => f.queue('forbidden', forbidden), /only|unsupported|configuration|field/i);
  }
  await assert.rejects(() => f.queue('another'), /pending|replace|continuation|conflict/i);
  await assert.rejects(() => f.queue('next', { prompt: 'changed intent' }), /conflict/i);
  const replacementStage = { goal: 'Use the explicitly replaced bounded step', acceptance: 'Replacement evidence matches the same full goal' };
  const replacement = await f.queue('replacement', { replacesRequestId: 'next', prompt: 'Use replacement instruction', stage: replacementStage });
  assert.equal(replacement.status, 'pending');
  assert.equal((await f.queue()).status, 'superseded', 'replaying the old queue must not revive it');
  assert.equal(f.store.read(f.binding).continuations.find(item => item.requestId === 'next').supersededBy, 'replacement');
  assert.equal(f.store.read(f.binding).runNumber, 1); assert.equal(f.captures().length, 1);
  assert.equal(f.result(1), null); assert.equal(f.callbackRows().length, 0);
  assert.equal(fs.readFileSync(path.join(f.store.runDir(f.binding, 1), 'input.json'), 'utf8'), firstInput);
  assert.equal(fs.readFileSync(path.join(f.store.runDir(f.binding, 1), 'run.json'), 'utf8'), firstRun);
  await f.finish(1); await wait(100);
  assert.equal(f.callbackRows().length, 0, 'result notification must wait for the owner foreground turn');
  f.event('task_complete');
  await until(() => f.callbackRows().length === 1);
  await until(() => f.store.readJson(path.join(f.store.runDir(f.binding, 1), 'notification.json')).status === 'delivered');
  const before = preservedRun(f, 1), review = f.reviewInput();
  const answer = await f.send('cli.review', 'review-first', review);
  assert.equal(answer.continuation.runNumber, 2); assert.equal(answer.continuation.requestId, 'replacement');
  await until(() => f.capture(2));
  assertPrompt(f.capture(2), replacementStage);
  assert.equal(f.capture(2).prompt.includes(firstStage.goal), false);
  assert.deepEqual(f.capture(2).args.slice(0, 3), ['exec', 'resume', 'same-native-session']);
  assert.ok(f.capture(2).prompt.includes('Use replacement instruction'));
  const second = f.store.readJson(path.join(f.store.runDir(f.binding, 2), 'run.json'));
  assert.deepEqual(second.stage, replacementStage); assert.deepEqual(second.effectiveContract, contract);
  assert.deepEqual(f.store.read(f.binding).contract, contract);
  const replay = await f.send('cli.review', 'review-first-again', review);
  assert.equal(replay.continuation.runNumber, 2); assert.equal(replay.continuation.requestId, 'replacement');
  await assert.rejects(() => f.send('cli.review', 'changed-review', { ...review, conclusion: 'Different historical review' }), /review.*conflict|conflict.*review/i);
  assert.deepEqual(preservedRun(f, 1), before);
  assert.equal(f.captures().length, 2); assert.equal(f.store.read(f.binding).runNumber, 2);
  await f.finish(2); await until(() => f.callbackRows().length === 2);
  await until(() => f.store.readJson(path.join(f.store.runDir(f.binding, 2), 'notification.json')).status === 'delivered');
  const late = await f.send('cli.review', 'review-first-late', review);
  assert.equal(late.continuation.runNumber, 2);
  await wait(100); assert.equal(f.captures().length, 2); assert.equal(f.callbackRows().length, 2);
  assert.ok(f.callbackRows().every(row => row.arguments.threadId === f.binding.ownerThreadId));
  assert.deepEqual(preservedRun(f, 1), before);
});

test('queued continuation survives profile validation failure and retries the saved review without a second run', { timeout: 40000 }, async t => {
  const f = fixture(t); await f.start(); await f.queue(); await f.finish(1);
  const review = f.reviewInput(), originalProfile = fs.readFileSync(f.profilePath, 'utf8');
  atomicJson(f.profilePath, { ...f.profile, unsupportedOverride: true });
  await assert.rejects(() => f.send('cli.review', 'review-fails-profile', review), /profile|override/i);
  assert.equal(f.store.readReview(f.binding, 1).decision, 'continue');
  assert.equal(f.store.read(f.binding).runNumber, 1);
  assert.equal(f.store.read(f.binding).continuations.find(item => item.requestId === 'next').status, 'pending');
  assert.equal(f.captures().length, 1);
  fs.writeFileSync(f.profilePath, originalProfile);
  const resumed = await f.send('cli.review', 'review-retry-profile', review);
  assert.equal(resumed.continuation.runNumber, 2); await until(() => f.capture(2));
  await f.send('cli.review', 'review-retry-profile-again', review);
  assert.equal(f.store.read(f.binding).runNumber, 2); assert.equal(f.captures().length, 2);
  assertPrompt(f.capture(2), nextStage); await f.finish(2);
});

test('interruption after the real beginRun commit resumes that same saved run instead of allocating another', { timeout: 40000 }, async t => {
  const f = fixture(t); await f.start(); await f.queue(); await f.finish(1);
  const review = f.reviewInput(), original = CliTaskStore.prototype.beginRun;
  let interrupted = false;
  CliTaskStore.prototype.beginRun = function (identity, options) {
    const run = original.call(this, identity, options);
    if (!interrupted && options.requestId === 'next') { interrupted = true; throw new Error('fixture interrupted after real beginRun commit'); }
    return run;
  };
  try { await assert.rejects(() => f.send('cli.review', 'review-before-interruption', review), /fixture interrupted/); }
  finally { CliTaskStore.prototype.beginRun = original; }
  assert.equal(interrupted, true); assert.equal(f.store.read(f.binding).runNumber, 2);
  assert.equal(f.store.read(f.binding).status, 'starting'); assert.equal(f.captures().length, 1);
  const saved = fs.readFileSync(path.join(f.store.runDir(f.binding, 2), 'run.json'), 'utf8');
  const answer = await f.send('cli.review', 'review-after-interruption', review);
  assert.equal(answer.continuation.runNumber, 2); await until(() => f.capture(2));
  await f.send('cli.review', 'review-after-interruption-again', review);
  assert.equal(f.store.read(f.binding).runNumber, 2); assert.equal(f.captures().length, 2);
  assert.equal(fs.readFileSync(path.join(f.store.runDir(f.binding, 2), 'run.json'), 'utf8'), saved);
  await f.finish(2);
});

for (const decision of ['pause', 'accept', 'close']) test(`${decision} review does not launch queued work and retains explicit continuation history`, { timeout: 30000 }, async t => {
  const f = fixture(t); await f.start(); await f.queue(); await f.finish(1);
  const answer = await f.send('cli.review', 'review-' + decision, f.reviewInput(1, decision));
  assert.equal(answer.continuation, undefined); assert.equal(f.store.read(f.binding).runNumber, 1);
  const item = f.store.read(f.binding).continuations.find(row => row.requestId === 'next');
  assert.equal(item.status, decision === 'pause' ? 'pending' : 'cancelled');
  if (decision === 'pause') {
    const cancelled = await f.send('cli.cancel-next', 'cancel-next', { continuationId: 'next', reason: 'Owner withdrew the queued step' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.reason, 'Owner withdrew the queued step');
    assert.deepEqual(await f.send('cli.cancel-next', 'cancel-next-replay', { continuationId: 'next', reason: 'Owner withdrew the queued step' }), cancelled);
  }
  await wait(80); assert.equal(f.captures().length, 1);
});

test('explicit stop interrupts only the active fixture process and never auto-dispatches its pending step', { timeout: 30000 }, async t => {
  const f = fixture(t); await f.start(); await f.queue();
  const state = f.store.read(f.binding);
  const answer = await f.send('cli.stop', 'stop', { stateSha256: digest(state), expectedSessionId: state.sessionId, reason: 'Owner explicitly stopped this fixture' });
  assert.equal(answer.status, 'stop-requested');
  await until(() => f.result(1)); assert.equal(f.result(1).status, 'stopped');
  assert.equal(f.store.read(f.binding).continuations.find(item => item.requestId === 'next').status, 'cancelled');
  assert.equal(f.store.readContinuation(f.binding, 1), null);
  await wait(100); assert.equal(f.store.read(f.binding).runNumber, 1); assert.equal(f.captures().length, 1);
});

test('queued authorized contract changes only the next run and keeps original artifacts and model selection', { timeout: 40000 }, async t => {
  const f = fixture(t); await f.start();
  const changedContract = { ...contract, goal: 'Deliver the newly authorized complete goal', acceptance: 'Verify the newly authorized whole outcome' };
  await assert.rejects(() => f.queue('missing-authorization', { contract: changedContract }), /authorization/i);
  const queued = await f.queue('authorized-next', { contract: changedContract, authorizationLocator: 'fixture:owner-approved-complete-goal' });
  assert.deepEqual(queued.contract, changedContract);
  assert.deepEqual(f.store.read(f.binding).effectiveContract, contract, 'busy queue cannot rewrite the active contract');
  assert.equal(f.capture(1).prompt.includes(changedContract.goal), false);
  await f.finish(1); const before = preservedRun(f, 1);
  const answer = await f.send('cli.review', 'authorized-review', f.reviewInput());
  assert.equal(answer.continuation.runNumber, 2); await until(() => f.capture(2));
  const submitted = f.capture(2);
  assert.ok(submitted.prompt.includes(changedContract.goal));
  assert.ok(submitted.prompt.includes(changedContract.acceptance));
  assert.equal(submitted.prompt.includes(contract.goal), false);
  assert.ok(submitted.prompt.includes(nextStage.goal));
  assert.ok(submitted.prompt.includes(nextStage.acceptance));
  assert.deepEqual(submitted.args.slice(0, 3), ['exec', 'resume', 'same-native-session']);
  assert.equal(submitted.args[submitted.args.indexOf('--model') + 1], 'chosen-fixture-model');
  assert.deepEqual(f.store.read(f.binding).contract, contract);
  assert.deepEqual(f.store.read(f.binding).effectiveContract, changedContract);
  const second = f.store.readJson(path.join(f.store.runDir(f.binding, 2), 'run.json'));
  assert.equal(second.contractUpdate.authorizationLocator, 'fixture:owner-approved-complete-goal');
  assert.deepEqual(preservedRun(f, 1), before); await f.finish(2);
});

test('continue review without queued work remains review-only; explicit resume still carries the supplied stage', { timeout: 40000 }, async t => {
  const f = fixture(t); await f.start(); await f.finish(1);
  let resolved = 0;
  const review = await launchCliRequest(f.request('cli.review', 'ordinary-review', f.reviewInput()), {
    ...f.context, ownerTurnId: undefined,
    resolveLaunchContext: async () => { resolved++; throw new Error('A review-only operation must not resolve launch transport'); },
  });
  assert.equal(resolved, 0);
  assert.equal(review.continuation, undefined); assert.equal(f.store.read(f.binding).runNumber, 1);
  const next = await f.send('cli.resume', 'ordinary-resume', { prompt: 'Continue the explicit bounded step', stage: nextStage, expectedRunNumber: 1, expectedSessionId: 'same-native-session' });
  assert.equal(next.runNumber, 2); await until(() => f.capture(2)); assertPrompt(f.capture(2), nextStage);
  await f.finish(2); assert.equal(f.store.read(f.binding).sessionId, 'same-native-session');
});

test('CLI entry review discovers the current owner turn and resumes queued work with isolated native notifications', { timeout: 60000 }, async t => {
  const f = fixture(t, { notifications: true, entryPoint: true }); await f.start();
  const input = { prompt: 'Continue from the command-line review entry', stage: nextStage, expectedRunNumber: 1, expectedSessionId: 'same-native-session' };
  const queued = await f.sendEntry('cli.queue', 'entry-next', input);
  assert.equal(queued.ownerTurnId, 'dispatch-turn');
  f.event('task_complete'); f.event('task_started', 'queue-retry-turn');
  const replayed = await f.sendEntry('cli.queue', 'entry-next', input);
  assert.deepEqual(replayed, queued, 'new currentSource turn does not change an identical queued intent');
  assert.equal(f.captures().length, 1);
  await f.finish(1); await wait(100);
  assert.equal(f.callbackRows().length, 0, 'new foreground turn also blocks the first result notification');
  f.event('task_complete', 'queue-retry-turn');
  await until(() => f.callbackRows().length === 1);
  await until(() => f.store.readJson(path.join(f.store.runDir(f.binding, 1), 'notification.json')).status === 'delivered');
  const before = preservedRun(f, 1), review = f.reviewInput();
  f.event('task_started', 'review-foreground-turn');
  const answer = await f.sendEntry('cli.review', 'entry-review', review);
  assert.equal(answer.continuation.runNumber, 2); assert.equal(answer.continuation.requestId, 'entry-next');
  await until(() => f.capture(2));
  const second = f.store.readJson(path.join(f.store.runDir(f.binding, 2), 'run.json'));
  assert.equal(second.ownerTurnId, 'review-foreground-turn', 'auto-resume binds the actual review foreground, not the old queue origin');
  assertPrompt(f.capture(2), nextStage);
  assert.deepEqual(f.capture(2).args.slice(0, 3), ['exec', 'resume', 'same-native-session']);
  assert.deepEqual(preservedRun(f, 1), before);
  await f.finish(2); await wait(100);
  assert.equal(f.callbackRows().length, 1, 'the resumed manager waits for its real source foreground to finish');
  f.event('task_complete', 'review-foreground-turn');
  await until(() => f.callbackRows().length === 2);
  await until(() => f.store.readJson(path.join(f.store.runDir(f.binding, 2), 'notification.json')).status === 'delivered');
  const repeated = await f.sendEntry('cli.review', 'entry-review-again', review);
  assert.equal(repeated.continuation.runNumber, 2);
  assert.equal(f.captures().length, 2); assert.equal(f.callbackRows().length, 2);
});

test('review race: a queue committed after the initial next read but before review persistence is dispatched', { timeout: 40000 }, async t => {
  const f = fixture(t); await f.start(); await f.finish(1);
  const before = preservedRun(f, 1), review = f.reviewInput();
  const originalRead = CliTaskStore.prototype.readContinuation, originalReview = CliTaskStore.prototype.recordReview;
  let sawEmptyRead = false, injected = false;
  let resolved = 0;
  const lazyContext = { ...f.context, ownerTurnId: undefined, resolveLaunchContext: async () => {
    resolved++;
    return { ownerThreadId: f.binding.ownerThreadId, ownerTurnId: 'lazy-review-current-turn' };
  } };
  CliTaskStore.prototype.readContinuation = function (identity, number) {
    const next = originalRead.call(this, identity, number);
    if (!injected && identity.taskId === f.binding.taskId && number === 1 && next === null) sawEmptyRead = true;
    return next;
  };
  CliTaskStore.prototype.recordReview = function (input) {
    if (!injected && input.taskId === f.binding.taskId && input.runNumber === 1) {
      injected = true;
      // A separate store commits the actual queue before this store commits the review.
      // No result is mocked: queue validation, persistence and all later launch steps are real.
      const concurrent = new CliTaskStore({ controlRoot: f.context.controlRoot });
      concurrent.queueContinuation(f.binding, {
        requestId: 'interleaved-next', prompt: 'Queue committed between the review read and commit', stage: nextStage,
        expectedRunNumber: 1, expectedSessionId: 'same-native-session', ownerTurnId: 'concurrent-queue-turn',
      });
    }
    return originalReview.call(this, input);
  };
  let answer;
  try { answer = await launchCliRequest(f.request('cli.review', 'interleaved-review', review), lazyContext); }
  finally { CliTaskStore.prototype.readContinuation = originalRead; CliTaskStore.prototype.recordReview = originalReview; }
  assert.equal(injected, true);
  assert.equal(f.store.readReview(f.binding, 1).decision, 'continue');
  assert.equal(f.store.read(f.binding).runNumber, 2,
    `a committed queue must not remain stranded after its continue review (empty pre-commit read=${sawEmptyRead})`);
  assert.equal(answer.continuation.requestId, 'interleaved-next');
  assert.equal(resolved, 1, 'launch context is resolved after the real continuation is discovered');
  assert.equal(f.store.readJson(path.join(f.store.runDir(f.binding, 2), 'run.json')).ownerTurnId, 'lazy-review-current-turn');
  await until(() => f.capture(2)); assertPrompt(f.capture(2), nextStage);
  assert.deepEqual(f.capture(2).args.slice(0, 3), ['exec', 'resume', 'same-native-session']);
  const again = await launchCliRequest(f.request('cli.review', 'interleaved-review-replay', review), lazyContext);
  assert.equal(again.continuation.runNumber, 2); assert.equal(f.captures().length, 2);
  assert.equal(resolved, 1, 'replaying an already dispatched review does not resolve launch transport again');
  assert.deepEqual(preservedRun(f, 1), before); await f.finish(2);
});

test('queue race: a previously committed continue review dispatches a newly saved queue exactly once', { timeout: 40000 }, async t => {
  const f = fixture(t); await f.start(); await f.finish(1);
  const before = preservedRun(f, 1), review = f.reviewInput();
  const reviewed = await f.send('cli.review', 'review-before-queue', review);
  assert.equal(reviewed.continuation, undefined); assert.equal(f.store.read(f.binding).runNumber, 1);
  const reviewFile = path.join(f.store.runDir(f.binding, 1), 'review.json');
  const reviewBytes = fs.readFileSync(reviewFile, 'utf8');
  await f.queue('late-next');
  assert.equal(f.store.read(f.binding).runNumber, 2, 'a late queue consumes the existing continue decision without another review request');
  await until(() => f.capture(2)); assertPrompt(f.capture(2), nextStage);
  assert.deepEqual(f.capture(2).args.slice(0, 3), ['exec', 'resume', 'same-native-session']);
  await f.queue('late-next');
  const repeatedReview = await f.send('cli.review', 'review-before-queue-replay', review);
  assert.equal(repeatedReview.continuation.runNumber, 2);
  assert.equal(f.store.read(f.binding).runNumber, 2); assert.equal(f.captures().length, 2);
  assert.equal(fs.readFileSync(reviewFile, 'utf8'), reviewBytes, 'queue must use, not manufacture or replace, the saved approval');
  assert.deepEqual(preservedRun(f, 1), before); await f.finish(2);
  await f.queue('late-next');
  assert.equal(f.store.read(f.binding).runNumber, 2); assert.equal(f.captures().length, 2);
});

for (const historicalStatus of ['cancelled', 'superseded']) test(`replaying a ${historicalStatus} queue cannot dispatch a different pending item under an existing review`, { timeout: 40000 }, async t => {
  const f = fixture(t); await f.start(); await f.queue('historical-next'); await f.finish(1);
  if (historicalStatus === 'cancelled') await f.send('cli.cancel-next', 'cancel-historical', { continuationId: 'historical-next', reason: 'Owner withdrew this historical instruction' });
  const freshInput = {
    prompt: 'A distinct newly authorized pending instruction', stage: nextStage,
    expectedRunNumber: 1, expectedSessionId: 'same-native-session',
    ...(historicalStatus === 'superseded' ? { replacesRequestId: 'historical-next' } : {}),
  };
  // Arrange the competing process's durable state without invoking bridge auto-dispatch.
  // The actual stores still validate and persist both the new intent and exact approval.
  const concurrent = new CliTaskStore({ controlRoot: f.context.controlRoot });
  concurrent.queueContinuation(f.binding, { ...freshInput, requestId: 'fresh-next', ownerTurnId: 'fresh-queue-turn' });
  const review = f.request('cli.review', 'saved-review', f.reviewInput()).input;
  concurrent.recordReview(review);
  let resolved = 0;
  f.context.resolveLaunchContext = async () => { resolved++; return { ownerThreadId: f.binding.ownerThreadId, ownerTurnId: 'actual-fresh-launch-turn' }; };
  const old = await f.queue('historical-next');
  assert.equal(old.status, historicalStatus); assert.equal(old.continuation, undefined);
  assert.equal(resolved, 0, 'an obsolete request is not a dispatch trigger for somebody else\'s pending item');
  assert.equal(f.store.read(f.binding).runNumber, 1); assert.equal(f.captures().length, 1);
  assert.equal(f.store.readContinuation(f.binding, 1).requestId, 'fresh-next');
  assert.equal(f.store.readContinuation(f.binding, 1).status, 'pending');
  const fresh = await f.send('cli.queue', 'fresh-next', freshInput);
  assert.equal(fresh.continuation.runNumber, 2); assert.equal(fresh.continuation.requestId, 'fresh-next');
  await until(() => f.capture(2)); assertPrompt(f.capture(2), nextStage);
  assert.ok(f.capture(2).prompt.includes(freshInput.prompt));
  assert.equal(resolved, 1); assert.equal(f.captures().length, 2);
  await f.finish(2);
});
