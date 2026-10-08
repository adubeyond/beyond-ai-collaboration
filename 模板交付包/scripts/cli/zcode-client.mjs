import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliTaskStore, atomicJson, digest } from './cli-task-store.mjs';
import { readZcodeProfile, prepareZcodeTui } from './zcode-profile.mjs';
import { cliEnvironment, redact } from './native-cli-runner.mjs';

export function zcodeArguments(profile, binding) {
  // ZCode selects the model through its native session API, not Codex's --model flag.
  return [...profile.runner.args, '--cwd', binding.executionRoot, '--mode', 'yolo', ...(binding.sessionId ? ['--resume', binding.sessionId] : [])];
}
export function openZcodeWindow(store, binding) {
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const command = `$Host.UI.RawUI.WindowTitle = 'BEYOND - ZCode'; & ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --view ${quote(store.locator(binding))}`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const launch = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-EncodedCommand','${encoded}') -WindowStyle Normal -PassThru; $p.Id`;
  const answer = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (answer.status !== 0 || !/^\d+$/.test(answer.stdout.trim())) throw new Error('ZCode native window launch failed');
  return { windowPid: Number(answer.stdout.trim()), transport: 'external-native-terminal' };
}
export async function launchZcodeView(taskFile) {
  const binding = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  const store = new CliTaskStore({ controlRoot: path.resolve(path.dirname(taskFile), '../../../../..') });
  if (path.resolve(taskFile) !== store.locator(binding)) throw new Error('ZCode task locator mismatch');
  const endpoint = store.readJson(path.join(store.taskDir(binding), 'interactive.json'));
  if (endpoint.provider !== 'zcode' || endpoint.ownerThreadId !== binding.ownerThreadId || endpoint.status !== 'starting') throw new Error('ZCode launch is not awaiting a view');
  let code = 1, errorMessage = null;
  try {
    const profile = readZcodeProfile(store.readJson(path.join(store.runDir(binding, binding.runNumber), 'run.json')).profile ?? JSON.parse(fs.readFileSync(binding.profilePath, 'utf8')));
    if (digest(profile) !== endpoint.profileSha256) throw new Error('ZCode profile changed before view launch');
    const preload = prepareZcodeTui(profile, store.checkedPath(path.join(store.runDir(binding, binding.runNumber), 'zcode-tui'), { createDirectory: true }));
    const env = cliEnvironment('');
    env.BEYOND_ZCODE_CONNECTION = endpoint.connectionPath;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --import ${JSON.stringify(pathToFileURL(preload).href)}`;
    env.ZCODE_DISABLE_UPDATE_CHECK = '1';
    const args = zcodeArguments(profile, binding);
    const stderrPath = store.checkedPath(path.join(store.runDir(binding, binding.runNumber), 'stderr.log'));
    const child = spawn(profile.runner.command, args, { cwd: binding.executionRoot, env, stdio: ['inherit', 'inherit', 'pipe'] });
    let pendingError = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => {
      pendingError += text;
      let end;
      while ((end = pendingError.indexOf('\n')) >= 0) { const line = redact(pendingError.slice(0, end + 1)); pendingError = pendingError.slice(end + 1); fs.appendFileSync(stderrPath, line); process.stderr.write(line); }
      if (pendingError.length > 1024 * 1024) pendingError = '[oversized stderr line omitted]\n';
    });
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', status => resolve(status ?? 1)); });
    if (pendingError) { const line = redact(pendingError); fs.appendFileSync(stderrPath, line); process.stderr.write(line); }
    const startupError = store.checkedPath(path.join(store.runDir(binding, binding.runNumber), 'zcode-startup-error.json'));
    if (fs.existsSync(startupError)) errorMessage = redact(store.readJson(startupError).error);
  } catch (error) { errorMessage = redact(error.message); throw error;
  }
  finally { atomicJson(store.checkedPath(endpoint.viewExitPath), { launchId: endpoint.launchId, exitCode: code, error: errorMessage }); }
  return code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv[2] !== '--view' || !path.isAbsolute(process.argv[3] ?? '')) throw new Error('Use --view <task.json>'); process.exitCode = await launchZcodeView(process.argv[3]); }
  catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
