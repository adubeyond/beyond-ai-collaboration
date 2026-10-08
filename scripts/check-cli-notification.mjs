import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CliTaskStore, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
const modules = async () => ({ ...await import('../模板交付包/scripts/cli/desktop-host.mjs'), ...await import('../模板交付包/scripts/cli/cli-notify.mjs') });
function fixture(t, schema = 'valid', reply = 'ok', replyDelay = 0, { handoffDelay = 0, autoHandoff = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-notify-'));
  const actors = [];
  // The fake MCP child has just been killed; Windows can retain its cwd handle briefly.
  // Retry only this fixture's cleanup, without weakening any notification assertion.
  t.after(async () => {
    for (const actor of actors) if (actor.child.exitCode === null) actor.child.kill();
    await Promise.allSettled(actors.map(actor => actor.result));
    for (const owner of ['owner-one', 'owner-two']) {
      const canonical = process.platform === 'win32' ? fs.realpathSync(root).toLowerCase() : fs.realpathSync(root);
      const key = crypto.createHash('sha256').update(JSON.stringify([canonical, owner])).digest('hex');
      const proof = path.join(os.tmpdir(), `beyond-cli-send-${key}.lock.handoff.json`);
      if (fs.existsSync(proof)) fs.unlinkSync(proof);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const ownerThreadId = 'owner-one', ownerTurnId = 'turn-one', sourceRecordPath = path.join(root, 'rollout-owner-one.jsonl');
  fs.writeFileSync(sourceRecordPath, JSON.stringify({ type: 'session_meta', payload: { id: ownerThreadId } })+'\n'+JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: ownerTurnId } })+'\n');
  const pluginRoot = path.join(root, 'plugins'), plugin = path.join(pluginRoot, 'codex-app-tools', '7.8.9'); fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'codex-app-tools', version: '7.8.9', mcpServers: './.mcp.json' }));
  const script = path.join(plugin, 'server.cjs'), calls = path.join(root, 'calls.jsonl'), trace = path.join(root, 'trace.jsonl');
  const inputSchema = { type: 'object', properties: { threadId: { type: 'string' }, [schema === 'valid' ? 'prompt' : 'message']: { type: 'string' } }, required: ['threadId', schema === 'valid' ? 'prompt' : 'message'] };
  fs.writeFileSync(script, `const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});let sequence=0;rl.on('line',async l=>{const r=JSON.parse(l);if(!r.id)return;let result={};if(r.method==='tools/list')result={tools:[{name:'send_message_to_thread',inputSchema:${JSON.stringify(inputSchema)}}]};if(r.method==='tools/call'){fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(r.params)+'\\n');const log=phase=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({phase,pid:process.pid,owner:r.params.arguments.threadId})+'\\n');log('start');if(${JSON.stringify(reply)}==='timeout')return;await new Promise(resolve=>setTimeout(resolve,${replyDelay}));result=${reply === 'error' ? '{isError:true,content:[{type:"text",text:"denied"}]}' : '{content:[{type:"text",text:"ok"}]}' };if(${autoHandoff}&&!result.isError){const advance=()=>{const file=path.join(${JSON.stringify(root)},'rollout-'+r.params.arguments.threadId+'.jsonl'),turn='notification-'+process.pid+'-'+(++sequence);for(const type of ['task_started','task_complete'])fs.appendFileSync(file,JSON.stringify({type:'event_msg',payload:{type,turn_id:turn}})+'\\n');};if(${handoffDelay})setTimeout(advance,${handoffDelay});else advance();}log('end');}console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`);
  fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { codex_app: { command: process.execPath, args: [script], cwd: plugin } } }));
  const env = { ...Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'USERPROFILE', 'HOME', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), CODEX_HOME: root, CODEX_THREAD_ID: ownerThreadId, CODEX_APP_TOOLS_PIPE_PATH: 'test-inherited-transport' };
  const binding = { projectId: 'local-test', taskId: 'goal', ownerThreadId, ownerTurnId, executionRoot: root, profilePath: path.join(root, 'profile.json'), taskMode: 'assist', contract: { goal: 'temporary result', boundaries: 'temporary only', acceptance: 'evidence', factEntries: [], skillEntries: [] } };
  const store = new CliTaskStore({ controlRoot: root }); store.create(binding);
  const run = store.beginRun(binding, { requestId: 'start', prompt: 'do it', expectedRunNumber: 0, expectedSessionId: null });
  const finish = () => store.finishRun(run, { status: 'failed', exitCode: 1, finalText: '', error: 'before session' });
  const end = () => fs.appendFileSync(sourceRecordPath, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: ownerTurnId } })+'\n');
  return { root, ownerThreadId, ownerTurnId, sourceRecordPath, pluginRoot, env, binding, store, run, finish, end, calls, trace, actors };
}
const delay = ms => new Promise(r => setTimeout(r, ms));
const event = (f, type, turn_id) => fs.appendFileSync(f.sourceRecordPath, JSON.stringify({ type: 'event_msg', payload: { type, turn_id } })+'\n');
async function until(check) {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error('fixture condition timeout'); await delay(20); }
}
function actor(t, f, options = {}) {
  const script = path.join(f.root, 'sender.mjs');
  const module = pathToFileURL(path.resolve('模板交付包/scripts/cli/desktop-host.mjs')).href;
  const proofModule = pathToFileURL(path.resolve('模板交付包/scripts/cli/process-identity.mjs')).href;
  // Windows process-proof lookup starts PowerShell. Await that actual startup
  // event separately; notification-order assertions must not time its startup.
  fs.writeFileSync(script, `import { createDesktopHost } from ${JSON.stringify(module)}; import {currentProcessIdentity} from ${JSON.stringify(proofModule)}; currentProcessIdentity(); process.send({fixtureReady:true}); const f={...JSON.parse(process.argv[2]),env:process.env}; const result=await createDesktopHost(f).send({ownerThreadId:f.env.CODEX_THREAD_ID,prompt:'test-only'}); process.send(result);`);
  const child = fork(script, [JSON.stringify({ pluginRoot: f.pluginRoot, sourceRecordPath: f.sourceRecordPath, ...options })], { env: f.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error('fixture sender process-proof startup timeout')), 60000);
  ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));
  const result = new Promise((resolve, reject) => {
    let outcome, stderr = ''; child.stderr.on('data', data => stderr += data);
    child.on('message', value => { if (value.fixtureReady) readyResolve(); else outcome = value; });
    child.on('error', error => { readyReject(error); reject(error); });
    child.on('exit', code => {
      const error = new Error(`fixture sender exited ${code}: ${stderr}`);
      readyReject(error); code === 0 && outcome ? resolve(outcome) : reject(error);
    });
  });
  result.catch(() => {}); // Teardown after an earlier assertion must not leak a rejection.
  const instance = { child, result, ready }; f.actors.push(instance); return instance;
}

test('separate managers serialize same-owner delivery; no overlapping MCP calls', async t => {
  const f = fixture(t, 'valid', 'ok', 250); f.end();
  const senders = Array.from({ length: 3 }, () => actor(t, f));
  for (const result of await Promise.all(senders.map(s => s.result))) assert.equal(result.status, 'delivered', JSON.stringify(result));
  const phases = fs.readFileSync(f.trace, 'utf8').trim().split('\n').map(line => JSON.parse(line).phase);
  assert.deepEqual(phases, ['start', 'end', 'start', 'end', 'start', 'end']);
});

test('different owners do not block each other while one owner is busy', async t => {
  const { createDesktopHost } = await modules(); const f = fixture(t);
  const other = { ...f, sourceRecordPath: path.join(f.root, 'rollout-owner-two.jsonl'), env: { ...f.env, CODEX_THREAD_ID: 'owner-two' } };
  fs.writeFileSync(other.sourceRecordPath, JSON.stringify({ type: 'session_meta', payload: { id: 'owner-two' } })+'\n');
  event(other, 'task_started', 'turn-other'); event(other, 'task_complete', 'turn-other');
  let done = false;
  const waiting = createDesktopHost(f).send({ ownerThreadId: f.ownerThreadId, prompt: 'first' }).then(result => { done = true; return result; });
  const result = await createDesktopHost(other).send({ ownerThreadId: 'owner-two', prompt: 'second' });
  assert.equal(result.status, 'delivered'); assert.equal(done, false);
  f.end(); assert.equal((await waiting).status, 'delivered');
});

test('a newer foreground turn blocks notification even though dispatch turn ended', async t => {
  const { createDesktopHost, notifyWhenReady } = await modules(); const f = fixture(t); f.end(); f.finish(); event(f, 'task_started', 'foreground-two');
  let done = false;
  const waiting = notifyWhenReady({ store: f.store, identity: f.binding, runNumber: 1, host: createDesktopHost(f) }).then(result => { done = true; return result; });
  await delay(200); assert.equal(done, false); assert.equal(fs.existsSync(f.calls), false);
  event(f, 'task_complete', 'foreground-two'); assert.equal((await waiting).status, 'delivered');
});

test('queued send waits for the handling turn started by the preceding notification', async t => {
  const { createDesktopHost } = await modules(); const f = fixture(t, 'valid', 'ok', 250, { autoHandoff: false }); f.end();
  const send = prompt => createDesktopHost(f).send({ ownerThreadId: f.ownerThreadId, prompt });
  const first = send('first');
  await until(() => fs.existsSync(f.calls)); event(f, 'task_started', 'notification-turn');
  const second = send('second'); assert.equal((await first).status, 'delivered');
  await delay(200); assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
  event(f, 'task_complete', 'notification-turn');
  await until(() => fs.readFileSync(f.calls, 'utf8').trim().split('\n').length === 2);
  event(f, 'task_started', 'next-notification-turn'); event(f, 'task_complete', 'next-notification-turn');
  assert.equal((await second).status, 'delivered');
});

test('successful response before persisted turn start does not release owner send slot', async t => {
  const f = fixture(t, 'valid', 'ok', 0, { autoHandoff: false }); f.end();
  const first = actor(t, f), second = actor(t, f);
  await Promise.all([first.ready, second.ready]);
  await until(() => fs.existsSync(f.trace) && fs.readFileSync(f.trace, 'utf8').includes('"end"'));
  await delay(100);
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
  event(f, 'task_started', 'persisted-first-handoff'); event(f, 'task_complete', 'persisted-first-handoff');
  await until(() => fs.readFileSync(f.calls, 'utf8').trim().split('\n').length === 2);
  event(f, 'task_started', 'persisted-second-handoff'); event(f, 'task_complete', 'persisted-second-handoff');
  assert.equal((await first.result).status, 'delivered'); assert.equal((await second.result).status, 'delivered');
});

test('unobserved successful handoff preserves a gate across independent manager processes', async t => {
  const f = fixture(t, 'valid', 'ok', 0, { autoHandoff: false }); f.end();
  const first = await actor(t, f, { handoffTimeoutMs: 150 }).result;
  assert.equal(first.status, 'delivery-unknown'); assert.match(first.error, /handoff unverified/);
  const second = await actor(t, f, { handoffTimeoutMs: 150 }).result;
  assert.equal(second.status, 'unavailable');
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
  event(f, 'task_started', 'late-notification-turn'); event(f, 'task_complete', 'late-notification-turn');
  const third = actor(t, f, { handoffTimeoutMs: 1500 });
  await third.ready;
  await until(() => fs.readFileSync(f.calls, 'utf8').trim().split('\n').length === 2);
  event(f, 'task_started', 'next-turn'); event(f, 'task_complete', 'next-turn');
  assert.equal((await third.result).status, 'delivered');
});

test('aborted newer foreground releases waiting notification; aborted dispatch does not', async t => {
  const { createDesktopHost, notifyWhenReady } = await modules(); const f = fixture(t); f.end(); f.finish(); event(f, 'task_started', 'foreground-two');
  const waiting = notifyWhenReady({ store: f.store, identity: f.binding, runNumber: 1, host: createDesktopHost(f) });
  await delay(200); assert.equal(fs.existsSync(f.calls), false);
  event(f, 'turn_aborted', 'foreground-two'); assert.equal((await waiting).status, 'delivered');
  const aborted = fixture(t); aborted.finish(); event(aborted, 'turn_aborted', aborted.ownerTurnId);
  assert.equal((await notifyWhenReady({ store: aborted.store, identity: aborted.binding, runNumber: 1, host: createDesktopHost(aborted) })).status, 'unavailable');
  assert.equal(fs.existsSync(aborted.calls), false);
});

test('already reviewed result is not sent after foreground wait', async t => {
  const { createDesktopHost, notifyWhenReady } = await modules(); const f = fixture(t); f.end(); f.finish(); event(f, 'task_started', 'foreground-two');
  const waiting = notifyWhenReady({ store: f.store, identity: f.binding, runNumber: 1, host: createDesktopHost(f) });
  await delay(200);
  f.store.recordReview({ ...f.binding, runNumber: 1, decision: 'close', conclusion: 'handled during foreground', evidenceLocator: 'fixture-only', resultSha256: sha256File(f.run.resultPath), reviewedAt: new Date().toISOString() });
  event(f, 'task_complete', 'foreground-two');
  assert.equal((await waiting).status, 'unavailable'); assert.equal(fs.existsSync(f.calls), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.store.runDir(f.binding, 1), 'notification.json'))).sentAt, undefined);
});

test('message timeout can outlast discovery timeout without terminating the observer', async t => {
  const { createDesktopHost } = await modules(); const f = fixture(t, 'valid', 'ok', 300); f.end();
  const host = createDesktopHost({ ...f, requestTimeoutMs: 150, messageTimeoutMs: 1500 });
  assert.equal((await host.send({ ownerThreadId: f.ownerThreadId, prompt: 'test' })).status, 'delivered');
});

test('rejected delivery releases the lock but cannot reuse the unadvanced source turn', async t => {
  const { createDesktopHost } = await modules(); const f = fixture(t, 'valid', 'error'); f.end();
  const host = createDesktopHost({ ...f, handoffTimeoutMs: 150 });
  assert.equal((await host.send({ ownerThreadId: f.ownerThreadId, prompt: 'first' })).status, 'delivery-unknown');
  assert.equal((await host.send({ ownerThreadId: f.ownerThreadId, prompt: 'second' })).status, 'unavailable');
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
  event(f, 'task_started', 'recovered-turn'); event(f, 'task_complete', 'recovered-turn');
  assert.equal((await host.send({ ownerThreadId: f.ownerThreadId, prompt: 'second' })).status, 'delivery-unknown');
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 2);
});

test('manager exit releases a stale owner gate without deleting another owner proof', async t => {
  const f = fixture(t, 'valid', 'ok', 500); f.end();
  const first = actor(t, f); first.result.catch(() => {});
  await first.ready;
  await until(() => fs.existsSync(f.trace));
  const firstMcpPid = JSON.parse(fs.readFileSync(f.trace, 'utf8').trim().split('\n')[0]).pid;
  first.child.kill(); await first.result.catch(() => {});
  // A killed sender's native call may still be accepted. Only an observed source
  // advance, not process death alone, makes another notification safe to start.
  await until(() => {
    if (fs.readFileSync(f.trace, 'utf8').includes('"end"')) return true;
    try { process.kill(firstMcpPid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  });
  event(f, 'task_started', 'recovered-manager-turn'); event(f, 'task_complete', 'recovered-manager-turn');
  const senders = Array.from({ length: 3 }, () => actor(t, f));
  for (const outcome of await Promise.all(senders.map(s => s.result))) assert.equal(outcome.status, 'delivered', JSON.stringify(outcome));
  // Windows may terminate the fake MCP with its killed parent; Linux may let
  // that call finish. Assert all three surviving calls, not a global suffix.
  const phases = fs.readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse).filter(item => item.pid !== firstMcpPid).map(item => item.phase);
  assert.deepEqual(phases, ['start', 'end', 'start', 'end', 'start', 'end']);
});
test('result first waits for source end; failure without session notifies only once', async t => {
  const { createDesktopHost, notifyWhenReady } = await modules(); const f = fixture(t);
  const host = createDesktopHost(f); assert.equal((await host.checkCapability()).available, true);
  const waiting = host.waitForSourceTurnEnd(f); f.finish();
  const notification = notifyWhenReady({ store: f.store, identity: f.binding, runNumber: 1, host, sourceEnd: waiting });
  await delay(40); assert.equal(fs.existsSync(f.calls), false); f.end();
  assert.equal((await notification).status, 'delivered');
  assert.equal((await notifyWhenReady({ store: f.store, identity: f.binding, runNumber: 1, host })).status, 'duplicate-suppressed');
  const call = JSON.parse(fs.readFileSync(f.calls, 'utf8').trim());
  assert.deepEqual(Object.keys(call.arguments).sort(), ['prompt', 'threadId']);
  assert.equal(call.arguments.threadId, f.ownerThreadId); assert.match(call.arguments.prompt, /CLI_RESULT_READY/);
  assert.equal(call._meta['x-codex-turn-metadata'].thread_id, f.ownerThreadId);
  assert.equal(f.store.readReview(f.binding, 1), null);
  assert.equal(fs.existsSync(path.join(f.root, 'local/runtime/worker-results')), false);
});
test('source first and split UTF8 completion lines survive replay and duplicate file events', async t => {
  const { createDesktopHost, notifyWhenReady } = await modules(); const f = fixture(t); const host = createDesktopHost(f);
  const wait = host.waitForSourceTurnEnd(f);
  const line = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: f.ownerTurnId, note: '完成' } })+'\n');
  fs.appendFileSync(f.sourceRecordPath, line.subarray(0, line.length-4)); await delay(20); fs.appendFileSync(f.sourceRecordPath, line.subarray(line.length-4)); await wait;
  f.finish(); assert.equal((await notifyWhenReady({ store: f.store, identity: f.binding, runNumber: 1, host })).status, 'delivered');
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
});
test('turn already ended before subscribing is not lost and current source rejects another thread', async t => {
  const { createDesktopHost } = await modules(); const f = fixture(t); const host = createDesktopHost(f);
  assert.equal(host.currentSource().ownerTurnId, f.ownerTurnId); f.end(); await host.waitForSourceTurnEnd(f);
  assert.throws(() => createDesktopHost({ ...f, env: { ...f.env, CODEX_THREAD_ID: 'another' } }).currentSource(), /identity/);
});
test('plugin version discovered from declaration; mismatched schema is unavailable', async t => {
  const { createDesktopHost } = await modules(); const f = fixture(t, 'wrong');
  assert.equal((await createDesktopHost(f).checkCapability()).available, false);
});
test('delivery timeout is recorded unknown and cannot be blindly resent', async t => {
  const { createDesktopHost, notifyWhenReady } = await modules(); const f = fixture(t, 'valid', 'timeout'); f.end(); f.finish();
  const host = createDesktopHost({ ...f, requestTimeoutMs: 100 });
  const result = await notifyWhenReady({ store: f.store, identity: f.binding, runNumber: 1, host });
  assert.equal(result.status, 'delivery-unknown');
  assert.equal((await notifyWhenReady({ store: f.store, identity: f.binding, runNumber: 1, host })).status, 'duplicate-suppressed');
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
});
test('aborted source observer releases resources without sending', async t => {
  const { createDesktopHost } = await modules(); const f = fixture(t); const abort = new AbortController();
  const promise = createDesktopHost(f).waitForSourceTurnEnd({ ...f, signal: abort.signal }); abort.abort();
  await assert.rejects(promise, /abort/i); assert.equal(fs.existsSync(f.calls), false);
});
test('a completion partly present before subscribing is still recognized after the remainder arrives', async t => {
  const { createDesktopHost } = await modules(); const f = fixture(t);
  const line = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: f.ownerTurnId, note: '完成' } })+'\n');
  const cut = line.indexOf(Buffer.from('完成')) + 1;
  fs.appendFileSync(f.sourceRecordPath, line.subarray(0, cut));
  const waiting = createDesktopHost(f).waitForSourceTurnEnd(f);
  fs.appendFileSync(f.sourceRecordPath, line.subarray(cut));
  await waiting;
});
test('first background launch binds notification before fast CLI completion, without later attach', async t => {
  const { createDesktopHost } = await modules();
  const { launchCliRequest } = await import('../模板交付包/scripts/cli/cli-bridge.mjs');
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'local/projects'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'local/projects/local-test.md'), `---\nid: local-test\npath: ${f.root}\nhost_id: local\ncodex_project_id: desktop-test\n---\n`);
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), '<!-- BEYOND-CONTROL-ROOT: . -->\n<!-- BEYOND-PROJECT-ID: local-test -->\n');
  const home = path.join(f.root, 'cli-home'); fs.mkdirSync(home);
  const fake = path.join(f.root, 'fast.cjs'); fs.writeFileSync(fake, `const fs=require('node:fs');const a=process.argv;console.log(JSON.stringify({type:'thread.started',thread_id:'first-session'}));process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(a[a.indexOf('--output-last-message')+1],'first result');console.log(JSON.stringify({type:'turn.completed'}));});`);
  fs.writeFileSync(f.binding.profilePath, JSON.stringify({ schemaVersion: 1, runner: { command: process.execPath, args: [fake] }, codexHome: home, model: 'test-model' }));
  const host = createDesktopHost(f), binding = { ...f.binding, taskId: 'first-live' };
  const run = await launchCliRequest({ schemaVersion: 1, requestId: 'first', action: 'cli.start', input: { ...binding, prompt: 'go' } }, { controlRoot: f.root, executionRoot: f.root, ownerThreadId: f.ownerThreadId, ownerTurnId: f.ownerTurnId, hostSpec: { ...host.descriptor, env: f.env } });
  const deadline = Date.now()+10000;
  while (!fs.existsSync(run.resultPath)) { if (Date.now()>deadline) throw new Error('first CLI timeout'); await delay(20); }
  assert.equal(fs.existsSync(f.calls), false); f.end();
  const marker = path.join(f.store.runDir(binding, 1), 'notification.json');
  while (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker)).status==='claimed') { if (Date.now()>deadline) throw new Error('first notification timeout'); await delay(20); }
  assert.equal(JSON.parse(fs.readFileSync(marker)).status, 'delivered');
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
});
