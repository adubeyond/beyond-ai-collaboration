import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readClaudeHookText } from './claude-hook.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 50));
const splitBytes = text => {
  const bytes = Buffer.from(text), cuts = [];
  for (const character of ['推', '😀']) {
    const offset = bytes.indexOf(Buffer.from(character));
    for (let n = 1; n < Buffer.byteLength(character); n++) cuts.push(offset + n);
  }
  let start = 0;
  return [...cuts.sort((a, b) => a - b), bytes.length].map(end => { const chunk = bytes.subarray(start, end); start = end; return chunk; });
};

test('native hook stdin and HTTP preserve split Chinese and emoji without relaxing equality', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-claude-hook-stdin-'));
  const prompt = '批准推送中文😀\r\n' + '设计与验收内容'.repeat(10000);
  const received = [];
  const server = http.createServer(async (request, response) => {
    try { received.push(JSON.parse(await readClaudeHookText(request))); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); }
    catch { response.writeHead(400); response.end('{}'); }
  });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
    const actual = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('beyond-claude-hook-stdin-'));
    fs.rmSync(actual, { recursive: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const connection = path.join(root, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, token: crypto.randomUUID() }));
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'saved-session', prompt };
  const chunks = splitBytes(JSON.stringify(input));
  // The original per-Buffer conversion corrupts three- and four-byte characters.
  assert.notEqual(JSON.parse(chunks.map(chunk => chunk.toString()).join('')).prompt, prompt);
  child = spawn(process.execPath, [fileURLToPath(new URL('./claude-hook.mjs', import.meta.url)), 'UserPromptSubmit'],
    { cwd: root, env: { ...process.env, BEYOND_CLAUDE_HOOK_CONNECTION: connection }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  await pause();
  for (const chunk of chunks) { child.stdin.write(chunk); await pause(); }
  child.stdin.end();
  assert.equal(await closed, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {});
  assert.equal(received[0].input.prompt, prompt);

  // Exercise the same reader used by launchClaudeView with explicitly split HTTP writes.
  const request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/hook' });
  const completed = new Promise((resolve, reject) => { request.once('error', reject); request.once('response', response => { response.resume(); response.once('end', () => resolve(response.statusCode)); }); });
  for (const chunk of splitBytes(JSON.stringify({ input }))) { request.write(chunk); await pause(); }
  request.end();
  assert.equal(await completed, 200);
  assert.equal(received[1].input.prompt, prompt);
});

test('hook decoder retains the existing byte limit and stream failures', async () => {
  await assert.rejects(readClaudeHookText(Readable.from([Buffer.alloc(4 * 1024 * 1024 + 1, 65)])), /input too large/);
  const stream = new Readable({ read() { this.destroy(new Error('fixture read failed')); } });
  await assert.rejects(readClaudeHookText(stream), /fixture read failed/);
});
