import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliTaskStore } from './cli-task-store.mjs';
import { processIsGone } from './process-identity.mjs';
import { cliEnvironment, redact } from './native-cli-runner.mjs';

export function projectTrustOverride(root) {
  const physical = fs.realpathSync(root);
  const canonical = process.platform === 'win32' ? physical.toLowerCase() : physical;
  // CLI dotted overrides split keys literally; quoted paths there become the wrong key.
  // Parse the path as a TOML inline-table string key instead. This is invocation-local.
  return `projects={${JSON.stringify(canonical)}={trust_level="trusted"}}`;
}

export function readInteractiveEndpoint(store, identity) {
  const file = store.checkedPath(path.join(store.taskDir(identity), 'interactive.json'));
  if (!fs.existsSync(file)) return null;
  const record = store.readJson(file);
  if (record.ownerThreadId !== identity.ownerThreadId || record.projectId !== identity.projectId || record.taskId !== identity.taskId) throw new Error('Interactive owner mismatch');
  if (record.status === 'closed') return null;
  if (processIsGone(record.manager) && processIsGone(record.server)) return null;
  if (processIsGone(record.manager) || processIsGone(record.server)) throw new Error('Interactive process state unconfirmed; recover only after both saved processes exit');
  const url = new URL(record.controlUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') throw new Error('Invalid interactive control endpoint');
  return record;
}
export async function callInteractive(store, identity, action, input = {}) {
  const endpoint = readInteractiveEndpoint(store, identity);
  if (!endpoint) return null;
  const token = fs.readFileSync(store.checkedPath(endpoint.tokenPath), 'utf8').trim();
  const response = await fetch(new URL(action, endpoint.controlUrl), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Interactive request rejected');
  return body;
}
export function openInteractiveWindow(store, identity) {
  if (process.platform !== 'win32') throw new Error('Automatic visible window requires Windows; run interactive-client.mjs --attach in your own terminal');
  const file = store.locator(identity), script = fileURLToPath(import.meta.url);
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const command = `$Host.UI.RawUI.WindowTitle = 'BEYOND - Native Codex CLI'; & ${quote(process.execPath)} ${quote(script)} --attach ${quote(file)}`;
  // A visible window is requested by the native-interactive route; all background helpers stay hidden.
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const launch = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NoExit','-EncodedCommand','${encoded}') -WindowStyle Normal -PassThru; $p.Id`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', env: cliEnvironment(''), timeout: 10000 });
  if (result.status !== 0 || !/^\d+$/.test(result.stdout.trim())) throw new Error('Native terminal window launch failed');
  return { windowPid: Number(result.stdout.trim()), transport: 'external-native-terminal' };
}
export async function attachInteractive(taskFile) {
  const state = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  const controlRoot = path.resolve(path.dirname(taskFile), '../../../../..'), store = new CliTaskStore({ controlRoot });
  if (path.resolve(taskFile) !== store.locator(state)) throw new Error('Interactive task locator mismatch');
  const endpoint = readInteractiveEndpoint(store, state);
  if (!endpoint || !endpoint.sessionId || endpoint.sessionId !== store.read(state).sessionId) throw new Error('Interactive session unavailable');
  const env = cliEnvironment(endpoint.codexHome); env.TERM = 'xterm-256color';
  env.BEYOND_NATIVE_REMOTE_TOKEN = fs.readFileSync(store.checkedPath(endpoint.tokenPath), 'utf8').trim();
  // The owner already authorized this exact execution root. Do not prompt the user to trust it again.
  const trust = projectTrustOverride(endpoint.executionRoot);
  // Remote resume rejects permission overrides; the authenticated server/thread sets never/full-access.
  const child = spawn(endpoint.command, [...endpoint.args, '-c', trust, '--remote', endpoint.wsUrl, '--remote-auth-token-env', 'BEYOND_NATIVE_REMOTE_TOKEN', '--no-alt-screen', '-C', endpoint.executionRoot, 'resume', endpoint.sessionId], { cwd: endpoint.executionRoot, env, stdio: 'inherit' });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  // Closing the view does not interrupt an active business turn. It retires an idle helper.
  await callInteractive(store, state, 'detach', { viewExitCode: exit ?? 1 }).catch(() => {});
  return exit ?? 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv[2] !== '--attach' || !path.isAbsolute(process.argv[3] ?? '')) throw new Error('Use --attach <absolute task.json>'); process.exitCode = await attachInteractive(process.argv[3]); }
  catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
