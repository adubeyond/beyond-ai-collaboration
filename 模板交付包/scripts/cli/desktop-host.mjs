import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { validIdentifier } from './cli-task-store.mjs';
import { redact } from './native-cli-runner.mjs';

const tailLimit = 16 * 1024 * 1024;
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
  const home = env.CODEX_HOME || path.join(env.USERPROFILE || env.HOME || '', '.codex');
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
export function createDesktopHost({ env = process.env, pluginRoot, sourceRecordPath, requestTimeoutMs = 20000 } = {}) {
  const environment = { ...env }, owner = validIdentifier(environment.CODEX_THREAD_ID);
  const home = environment.CODEX_HOME || path.join(environment.USERPROFILE || environment.HOME || '', '.codex');
  const source = sourceRecordPath || findSource(environment);
  const plugins = pluginRoot || path.join(home, 'plugins/cache/openai-bundled');
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
      const id = next++, timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop message timeout; delivery unknown')); }, requestTimeoutMs);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'beyond-cli-owner', version: '1.0.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return await callback(request);
    } finally { rejectAll(new Error('Desktop MCP closed')); child.stdin.end(); child.kill(); }
  }
  return {
    descriptor: { pluginRoot: plugins, sourceRecordPath: source },
    currentSource() {
      const facts = sourceFacts(source, owner);
      return { ownerThreadId: owner, ownerTurnId: facts.ownerTurnId, sourceRecordPath: facts.sourceRecordPath };
    },
    async checkCapability() {
      try { sourceFacts(source, owner); const available = await withMcp(async request => validMessageTool((await request('tools/list', {})).tools?.find(tool => tool.name === 'send_message_to_thread'))); return { available, reason: available ? null : 'Desktop message tool schema unsupported' }; }
      catch (error) { return { available: false, reason: redact(error.message) }; }
    },
    waitForSourceTurnEnd({ ownerThreadId, ownerTurnId, signal }) {
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
            if (value.payload.type === 'turn_aborted') close(new Error('source turn aborted; notification preserved'));
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
    async send({ ownerThreadId, prompt }) {
      if (ownerThreadId !== owner) throw new Error('Desktop notification owner identity mismatch');
      try {
        const answer = await withMcp(async request => {
          if (!validMessageTool((await request('tools/list', {})).tools?.find(tool => tool.name === 'send_message_to_thread'))) throw new Error('Desktop message schema changed');
          return request('tools/call', { name: 'send_message_to_thread', arguments: { threadId: owner, prompt }, _meta: { 'x-codex-turn-metadata': { thread_id: owner } } });
        });
        return answer.isError ? { status: 'delivery-unknown', error: 'Desktop rejected notification' } : { status: 'delivered' };
      } catch (error) { return { status: 'delivery-unknown', error: redact(error.message) }; }
    },
  };
}
