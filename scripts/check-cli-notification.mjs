import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliTaskStore } from '../模板交付包/scripts/cli/cli-task-store.mjs';
const modules = async () => ({ ...await import('../模板交付包/scripts/cli/desktop-host.mjs'), ...await import('../模板交付包/scripts/cli/cli-notify.mjs') });
function fixture(t, schema = 'valid', reply = 'ok') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownerThreadId = 'owner-one', ownerTurnId = 'turn-one', sourceRecordPath = path.join(root, 'rollout-owner-one.jsonl');
  fs.writeFileSync(sourceRecordPath, JSON.stringify({ type: 'session_meta', payload: { id: ownerThreadId } })+'\n'+JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: ownerTurnId } })+'\n');
  const pluginRoot = path.join(root, 'plugins'), plugin = path.join(pluginRoot, 'codex-app-tools', '7.8.9'); fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'codex-app-tools', version: '7.8.9', mcpServers: './.mcp.json' }));
  const script = path.join(plugin, 'server.cjs'), calls = path.join(root, 'calls.jsonl');
  const inputSchema = { type: 'object', properties: { threadId: { type: 'string' }, [schema === 'valid' ? 'prompt' : 'message']: { type: 'string' } }, required: ['threadId', schema === 'valid' ? 'prompt' : 'message'] };
  fs.writeFileSync(script, `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{const r=JSON.parse(l);if(!r.id)return;let result={};if(r.method==='tools/list')result={tools:[{name:'send_message_to_thread',inputSchema:${JSON.stringify(inputSchema)}}]};if(r.method==='tools/call'){fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(r.params)+'\\n');if(${JSON.stringify(reply)}==='timeout')return;result=${reply === 'error' ? '{isError:true,content:[{type:"text",text:"denied"}]}' : '{content:[{type:"text",text:"ok"}]}' };}console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`);
  fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { codex_app: { command: process.execPath, args: [script], cwd: plugin } } }));
  const env = { ...process.env, CODEX_THREAD_ID: ownerThreadId, CODEX_APP_TOOLS_PIPE_PATH: 'test-inherited-transport' };
  const binding = { projectId: 'local-test', taskId: 'goal', ownerThreadId, ownerTurnId, executionRoot: root, profilePath: path.join(root, 'profile.json'), taskMode: 'assist', contract: { goal: 'temporary result', boundaries: 'temporary only', acceptance: 'evidence', factEntries: [], skillEntries: [] } };
  const store = new CliTaskStore({ controlRoot: root }); store.create(binding);
  const run = store.beginRun(binding, { requestId: 'start', prompt: 'do it', expectedRunNumber: 0, expectedSessionId: null });
  const finish = () => store.finishRun(run, { status: 'failed', exitCode: 1, finalText: '', error: 'before session' });
  const end = () => fs.appendFileSync(sourceRecordPath, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: ownerTurnId } })+'\n');
  return { root, ownerThreadId, ownerTurnId, sourceRecordPath, pluginRoot, env, binding, store, run, finish, end, calls };
}
const delay = ms => new Promise(r => setTimeout(r, ms));
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
