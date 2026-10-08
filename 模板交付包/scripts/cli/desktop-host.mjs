import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { validIdentifier } from './cli-task-store.mjs';
import { redact } from './native-cli-runner.mjs';
import { currentProcessIdentity, processIsGone } from './process-identity.mjs';

const tailLimit = 16 * 1024 * 1024;
export function desktopHome(env = process.env) {
  const home = env.CODEX_HOME || path.join(env.USERPROFILE || env.HOME || '', '.codex');
  if (!path.isAbsolute(home)) throw new Error('Desktop home absolute path required');
  return home;
}
function readRegion(file, start, length) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(length);
  try { return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, start)); } finally { fs.closeSync(fd); }
}
function sourceFacts(file, ownerThreadId) {
  const physical = fs.realpathSync(file);
  if (physical !== path.resolve(file)) throw new Error('source record linked identity is unsupported');
  const size = fs.statSync(file).size;
  const first = readRegion(file, 0, Math.min(size, 1024 * 1024)).toString('utf8').split('\n')[0];
  const metadata = JSON.parse(first);
  if (metadata.type !== 'session_meta' || metadata.payload?.id !== ownerThreadId) throw new Error('source record identity mismatch');
  const offset = Math.max(0, size - tailLimit), bytes = readRegion(file, offset, size - offset);
  const text = bytes.toString('utf8'), firstLine = offset ? text.indexOf('\n') + 1 : 0;
  const complete = text.slice(firstLine, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const starts = complete.filter(e => e.type === 'event_msg' && e.payload?.type === 'task_started');
  const turn = starts.at(-1)?.payload?.turn_id;
  if (!turn) throw new Error('current source turn cannot be verified in bounded records');
  return { ownerThreadId, ownerTurnId: validIdentifier(turn), sourceRecordPath: physical, offset, size, records: complete };
}
function findSource(env) {
  const owner = validIdentifier(env.CODEX_THREAD_ID);
  const home = desktopHome(env);
  const root = path.join(home, 'sessions');
  const matches = [];
  function walk(directory, depth) {
    if (depth > 4) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) walk(file, depth + 1);
      else if (item.isFile() && item.name.endsWith(`-${owner}.jsonl`)) matches.push(file);
    }
  }
  walk(root, 0);
  if (matches.length !== 1) throw new Error('current Desktop source record is not unique');
  return matches[0];
}
function discoverPlugin(root) {
  const base = path.basename(root) === 'codex-app-tools' ? root : path.join(root, 'codex-app-tools');
  const versions = fs.readdirSync(base, { withFileTypes: true }).filter(x => x.isDirectory() && /^\d+\.\d+\.\d+$/.test(x.name)).map(x => x.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!versions.length) throw new Error('Desktop app-tools plugin declaration missing');
  const directory = fs.realpathSync(path.join(base, versions[0]));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, '.codex-plugin/plugin.json'), 'utf8'));
  if (manifest.name !== 'codex-app-tools' || manifest.version !== versions[0] || typeof manifest.mcpServers !== 'string') throw new Error('Desktop plugin declaration mismatch');
  const configFile = path.resolve(directory, manifest.mcpServers);
  if (path.relative(directory, configFile).startsWith('..')) throw new Error('Desktop plugin config escapes declaration');
  const server = JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers?.codex_app;
  if (!server?.command || !Array.isArray(server.args) || server.args.some(x => typeof x !== 'string')) throw new Error('Desktop plugin MCP entry missing');
  if (server.cwd && fs.realpathSync(server.cwd) !== directory) throw new Error('Desktop plugin cwd mismatch');
  return { ...server, cwd: directory };
}
function validMessageTool(tool) {
  const schema = tool?.inputSchema;
  return tool?.name === 'send_message_to_thread' && schema?.type === 'object'
    && schema.properties?.threadId?.type === 'string' && schema.properties?.prompt?.type === 'string'
    && ['threadId', 'prompt'].every(key => schema.required?.includes(key))
    && schema.required.every(key => ['threadId', 'prompt'].includes(key));
}
async function unlinkProof(file) {
  // Windows can briefly keep a read/delete handle during competing stale-owner
  // recovery. Retry only this exact proof, never the notification or a new owner.
  for (let attempt = 0; ; attempt += 1) {
    try { fs.unlinkSync(file); return; }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 19) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
// Managers are separate processes. A promise mutex would not protect the Desktop
// conversation from simultaneous turn/start requests. Only delivery is serialized.
async function withOwnerSend(home, owner, action) {
  const canonical = fs.realpathSync(home);
  const key = crypto.createHash('sha256').update(JSON.stringify([process.platform === 'win32' ? canonical.toLowerCase() : canonical, owner])).digest('hex');
  const lock = path.join(os.tmpdir(), `beyond-cli-send-${key}.lock`);
  const token = crypto.randomUUID(), leaf = `${token}.json`, prepared = `${lock}.${token}`;
  fs.mkdirSync(prepared, { mode: 0o700 });
  try { fs.writeFileSync(path.join(prepared, leaf), JSON.stringify(currentProcessIdentity()), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (fs.existsSync(path.join(prepared, leaf))) fs.unlinkSync(path.join(prepared, leaf)); fs.rmdirSync(prepared); throw error; }
  let acquired = false, observed, nextProbe = 0, acquireDenials = 0;
  try {
    while (!acquired) {
      try { fs.renameSync(prepared, lock); acquired = true; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        if (!fs.existsSync(lock)) {
          // The previous owner can remove the directory between rename failing
          // and this check. Windows may retain its delete handle a little longer.
          if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code) && acquireDenials++ >= 19) throw error;
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        acquireDenials = 0;
        let entries;
        try {
          if (fs.lstatSync(lock).isSymbolicLink()) throw new Error('Desktop send gate linked path rejected');
          entries = fs.readdirSync(lock);
        } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (entries.length > 1 || (entries[0] && !/^[0-9a-f-]{36}\.json$/.test(entries[0]))) throw new Error('Desktop send gate ownership unverified');
        if (!entries.length) {
          try { fs.rmdirSync(lock); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(e.code)) throw e; await new Promise(resolve => setTimeout(resolve, 100)); }
          continue;
        }
        if (entries[0] && (observed !== entries[0] || Date.now() >= nextProbe)) {
          observed = entries[0]; nextProbe = Date.now() + 5000;
          try {
            if (!fs.lstatSync(path.join(lock, observed)).isFile() || fs.lstatSync(path.join(lock, observed)).isSymbolicLink()) throw new Error('Desktop send gate process proof rejected');
            const proof = JSON.parse(fs.readFileSync(path.join(lock, observed), 'utf8'));
            // The owner can exit during the platform's start-time query. Recheck
            // liveness rather than turn that ordinary release into a send failure.
            let gone;
            try { gone = processIsGone(proof); } catch { gone = processIsGone(proof); }
            if (gone) {
              // Delete only this owner's unique filename, then only an empty dir.
              // A competing recovery cannot remove a replacement owner's proof.
              await unlinkProof(path.join(lock, observed));
              try { fs.rmdirSync(lock); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(e.code)) throw e; }
              continue;
            }
          } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return await action(`${lock}.handoff.json`);
  } finally {
    const owned = acquired ? lock : prepared;
    await unlinkProof(path.join(owned, leaf));
    try { fs.rmdirSync(owned); } catch (error) { if (!acquired || !['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error.code)) throw error; }
  }
}
export function createDesktopHost({ env = process.env, pluginRoot, sourceRecordPath, requestTimeoutMs, messageTimeoutMs, handoffTimeoutMs = 60000 } = {}) {
  const environment = { ...env }, owner = validIdentifier(environment.CODEX_THREAD_ID);
  const home = desktopHome(environment);
  const source = sourceRecordPath || findSource(environment);
  const plugins = pluginRoot || path.join(home, 'plugins/cache/openai-bundled');
  function waitForSourceAdvance(afterTurnId) {
    return new Promise((resolve, reject) => {
      let watcher, timer, settled = false;
      function close(error) {
        if (settled) return;
        settled = true; watcher?.close(); clearTimeout(timer);
        error ? reject(error) : resolve();
      }
      function check() {
        try { if (sourceFacts(source, owner).ownerTurnId !== afterTurnId) close(); }
        catch (error) { close(error); }
      }
      try {
        // A successful MCP response can precede the new turn's persisted start.
        // Keep this owner's send slot until that handoff is actually observable.
        watcher = fs.watch(path.dirname(source), (_event, file) => { if (!file || String(file) === path.basename(source)) check(); });
        timer = setTimeout(() => close(new Error('Desktop notification handoff unverified; delivery unknown')), handoffTimeoutMs);
        check();
      } catch (error) { close(error); }
    });
  }
  async function withMcp(callback) {
    if (!environment.CODEX_APP_TOOLS_PIPE_PATH) throw new Error('Desktop inherited message transport unavailable');
    const entry = discoverPlugin(plugins);
    const child = spawn(entry.command, entry.args, { cwd: entry.cwd, env: { ...environment, ...entry.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map(); let next = 1, buffer = ''; const decoder = new StringDecoder('utf8');
    function rejectAll(error) { for (const p of pending.values()) p.reject(error); pending.clear(); }
    child.on('error', rejectAll); child.on('exit', code => rejectAll(new Error(`Desktop MCP exited ${code}`)));
    child.stdout.on('data', data => {
      buffer += decoder.write(data); let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
        try { const message = JSON.parse(line), p = pending.get(message.id); if (!p) continue; pending.delete(message.id); message.error ? p.reject(new Error(redact(message.error.message))) : p.resolve(message.result); }
        catch { rejectAll(new Error('Desktop MCP invalid response')); }
      }
    });
    child.stderr.resume(); child.stdin.on('error', rejectAll);
    const request = (method, params) => new Promise((resolve, reject) => {
      // Native steering can take 30s to reject. Do not abandon its observer at 20s.
      const timeout = method === 'tools/call' ? (messageTimeoutMs ?? requestTimeoutMs ?? 60000) : (requestTimeoutMs ?? 20000);
      const id = next++, timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop message timeout; delivery unknown')); }, timeout);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'beyond-cli-owner', version: '1.0.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return await callback(request);
    } finally { rejectAll(new Error('Desktop MCP closed')); child.stdin.end(); child.kill(); }
  }
  const host = {
    descriptor: { pluginRoot: plugins, sourceRecordPath: source, ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }), ...(messageTimeoutMs === undefined ? {} : { messageTimeoutMs }), handoffTimeoutMs },
    currentSource() {
      const facts = sourceFacts(source, owner);
      return { ownerThreadId: owner, ownerTurnId: facts.ownerTurnId, sourceRecordPath: facts.sourceRecordPath };
    },
    async checkCapability() {
      try { sourceFacts(source, owner); const available = await withMcp(async request => validMessageTool((await request('tools/list', {})).tools?.find(tool => tool.name === 'send_message_to_thread'))); return { available, reason: available ? null : 'Desktop message tool schema unsupported' }; }
      catch (error) { return { available: false, reason: redact(error.message) }; }
    },
    waitForSourceTurnEnd({ ownerThreadId, ownerTurnId, signal, allowAborted = false }) {
      if (ownerThreadId !== owner) return Promise.reject(new Error('source owner identity mismatch'));
      return new Promise((resolve, reject) => {
        let watcher, offset = 0, buffer = '', busy = false, again = false, settled = false; const decoder = new StringDecoder('utf8');
        function close(error) { if (settled) return; settled = true; watcher?.close(); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); }
        const abort = () => close(new Error('source observation aborted'));
        function parse(line) {
          if (!line.trim()) return;
          const value = JSON.parse(line);
          if (value.type === 'event_msg' && value.payload?.turn_id === ownerTurnId) {
            if (value.payload.type === 'task_complete') close();
            if (value.payload.type === 'turn_aborted') close(allowAborted ? undefined : new Error('source turn aborted; notification preserved'));
          }
        }
        function check() {
          if (settled) return; if (busy) { again = true; return; } busy = true;
          try {
            do {
              again = false; const size = fs.statSync(source).size;
              if (size < offset) throw new Error('source record truncated; end signal unverified');
              buffer += decoder.write(readRegion(source, offset, size - offset)); offset = size;
              let end; while (!settled && (end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); parse(line); }
            } while (again && !settled);
          } catch (error) { close(error); } finally { busy = false; }
        }
        try {
          if (signal?.aborted) return abort();
          // Subscribe before replay so completion written between the two cannot be lost.
          watcher = fs.watch(path.dirname(source), (_event, file) => { if (!file || String(file) === path.basename(source)) check(); });
          signal?.addEventListener('abort', abort, { once: true });
          const facts = sourceFacts(source, owner); offset = facts.size;
          const startExists = facts.records.some(e => e.type === 'event_msg' && e.payload?.type === 'task_started' && e.payload.turn_id === ownerTurnId);
          if (!startExists) throw new Error('source turn identity cannot be verified');
          for (const record of facts.records) { parse(JSON.stringify(record)); if (settled) break; }
          // The tail can contain an incomplete line; retain it for the next append.
          if (!settled) {
            const tail = readRegion(source, facts.offset, facts.size - facts.offset).toString('utf8');
            buffer = tail.slice(tail.lastIndexOf('\n') + 1); check();
          }
        } catch (error) { close(error); }
      });
    },
    async send({ ownerThreadId, prompt, beforeSend = () => true }) {
      if (ownerThreadId !== owner) throw new Error('Desktop notification owner identity mismatch');
      let attempted = false;
      try {
        return await withOwnerSend(home, owner, async handoffPath => {
          if (fs.existsSync(handoffPath)) {
            const stat = fs.lstatSync(handoffPath);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Desktop handoff proof path rejected');
            const proof = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
            if (proof.ownerThreadId !== owner || proof.sourceRecordPath !== source || !proof.afterTurnId) throw new Error('Desktop handoff proof identity mismatch');
            // A timed-out or dead sender may already have submitted a turn. Its
            // successor must not issue another turn/start against the old view.
            await waitForSourceAdvance(validIdentifier(proof.afterTurnId));
            await unlinkProof(handoffPath);
          }
          async function waitForCurrentEnd() {
            for (;;) {
              const facts = sourceFacts(source, owner);
              if (facts.records.some(e => e.type === 'event_msg' && e.payload?.turn_id === facts.ownerTurnId && ['task_complete', 'turn_aborted'].includes(e.payload.type))) return;
              await host.waitForSourceTurnEnd({ ownerThreadId: owner, ownerTurnId: facts.ownerTurnId, allowAborted: true });
            }
          }
          await waitForCurrentEnd();
          const answer = await withMcp(async request => {
            if (!validMessageTool((await request('tools/list', {})).tools?.find(tool => tool.name === 'send_message_to_thread'))) throw new Error('Desktop message schema changed');
            // The original dispatch turn may have ended while a newer foreground
            // turn started. Recheck after schema lookup and after waiting in queue.
            await waitForCurrentEnd();
            if (!beforeSend()) return null;
            const afterTurnId = sourceFacts(source, owner).ownerTurnId;
            fs.writeFileSync(handoffPath, JSON.stringify({ ownerThreadId: owner, sourceRecordPath: source, afterTurnId }), { flag: 'wx', mode: 0o600 });
            attempted = true;
            const reply = await request('tools/call', { name: 'send_message_to_thread', arguments: { threadId: owner, prompt }, _meta: { 'x-codex-turn-metadata': { thread_id: owner } } });
            if (!reply.isError) {
              await waitForSourceAdvance(afterTurnId);
              await unlinkProof(handoffPath);
            }
            return reply;
          });
          if (!answer) return { status: 'unavailable', error: 'Result already reviewed or superseded; no late action sent' };
          return answer.isError ? { status: 'delivery-unknown', error: 'Desktop rejected notification' } : { status: 'delivered' };
        });
      } catch (error) { return { status: attempted ? 'delivery-unknown' : 'unavailable', error: redact(error.message) }; }
    },
  };
  return host;
}
