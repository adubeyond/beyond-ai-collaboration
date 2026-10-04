// Maintainer-only opt-in live probe. Uses an existing API home, never creates credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { launchCliRequest } from '../模板交付包/scripts/cli/cli-bridge.mjs';
import { CliTaskStore, sha256File } from '../模板交付包/scripts/cli/cli-task-store.mjs';
import { executeRuntimeRequest } from '../模板交付包/scripts/runtime/control-runtime.mjs';
import { createDesktopHost } from '../模板交付包/scripts/cli/desktop-host.mjs';

const action = process.argv[2], arg = flag => process.argv[process.argv.indexOf(flag) + 1];
const host = createDesktopHost(), source = host.currentSource();
const root = action === 'start' ? fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-native-live-')) : path.resolve(arg('--root'));
const controlRoot = path.join(root, 'control'), executionRoot = path.join(root, 'project');
const store = action === 'start' ? null : new CliTaskStore({ controlRoot });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const context = { controlRoot, executionRoot, ...source, hostSpec: host.descriptor };
const call = (name, input, requestId) => launchCliRequest({ schemaVersion: 1, requestId, action: name, input }, context);
const runtime = (name, input, requestId) => executeRuntimeRequest({ schemaVersion: 1, requestId, action: name, input }, context);

if (action === 'start') {
  const profilePath = path.resolve(arg('--profile')); assert.ok(fs.existsSync(profilePath));
  fs.mkdirSync(path.join(controlRoot, 'local/projects'), { recursive: true }); fs.mkdirSync(executionRoot);
  const projectId = 'local-native-live';
  fs.writeFileSync(path.join(controlRoot, `local/projects/${projectId}.md`), `---\nid: ${projectId}\npath: ${executionRoot}\nhost_id: local\ncodex_project_id: live-probe\n---\n`);
  fs.writeFileSync(path.join(executionRoot, 'AGENTS.md'), `<!-- BEYOND-CONTROL-ROOT: ../control -->\n<!-- BEYOND-PROJECT-ID: ${projectId} -->\nOnly this isolated arithmetic probe is authorized. Do not read or change other projects, Git, services, auth or configuration. Use native commands when explicitly requested.\n`);
  fs.writeFileSync(path.join(executionRoot, 'context.md'), 'Memory code: BEYOND-NATIVE-310.\n');
  const binding = { projectId, taskId: 'native-live-arithmetic', ownerThreadId: source.ownerThreadId, ownerTurnId: source.ownerTurnId, taskMode: 'formal', executionRoot, profilePath, contract: { goal: 'Verify native interactive CLI, real command, exact artifact and same-session continuation', boundaries: 'Only the isolated project. No Git/network/service/auth changes or Desktop callbacks from CLI. Read context.md, execute arithmetic and write only answer.txt when requested.', acceptance: 'Real command exits zero; answer.txt matches; next round retains the memory code; owner evaluates result and accepts exactly once.', factEntries: [path.join(executionRoot, 'context.md')], skillEntries: [] } };
  const preparedStore = new CliTaskStore({ controlRoot });
  runtime('workbench.register', { projectId, taskId: binding.taskId, task: binding.contract.goal, execution: { kind: 'cli', ownerThreadId: source.ownerThreadId, stateLocator: preparedStore.locator(binding) }, status: '进行中', progress: 'Isolated native CLI probe', pause: '无', updatedAt: new Date().toISOString() }, 'register-native-live');
  write(path.join(root, 'probe.json'), { binding, root });
  const result = await call('cli.start', { ...binding, prompt: 'Read context.md, remember the memory code, execute exactly one command node -p "1+1", then create only answer.txt with the exact text "1+1=2\\n". Verify it. Final exactly: NATIVE-310-ROUND1=2;MEMORY=BEYOND-NATIVE-310. Do not call Desktop or worker-result tools.' }, 'native-live-first');
  console.log(JSON.stringify({ root, ...result }));
} else {
  const { binding } = read(path.join(root, 'probe.json'));
  assert.equal(binding.ownerThreadId, source.ownerThreadId);
  const state = store.read(binding);
  if (action === 'inspect') {
    const result = store.readResult(binding, state.runNumber);
    assert.equal(result.status, 'completed', result.error);
    assert.match(result.finalText, /MEMORY=BEYOND-NATIVE-310/);
    const events = fs.readFileSync(result.eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const commands = events.filter(e => e.method === 'item/completed' && e.params?.item?.type === 'commandExecution').map(e => e.params.item);
    assert.ok(commands.length > 0); assert.ok(commands.every(e => e.exitCode === 0));
    assert.equal(fs.readFileSync(path.join(executionRoot, 'answer.txt'), 'utf8').replaceAll('\r\n', '\n'), state.runNumber === 1 ? '1+1=2\n' : '1+1=2\n2+3=5\n');
    console.log(JSON.stringify({ root, runNumber: state.runNumber, sessionId: state.sessionId, status: state.status, commandCount: commands.length, finalText: result.finalText, notification: fs.existsSync(path.join(store.runDir(binding, state.runNumber), 'notification.json')) ? read(path.join(store.runDir(binding, state.runNumber), 'notification.json')).status : null }));
  } else if (action === 'resume') {
    const result = store.readResult(binding, state.runNumber);
    if (!store.readReview(binding, state.runNumber)) store.recordReview({ projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: source.ownerThreadId, runNumber: state.runNumber, resultSha256: sha256File(state.currentResultPath), decision: 'continue', evidenceLocator: path.join(executionRoot, 'answer.txt'), conclusion: 'Round one verified; test same-session continuation', reviewedAt: new Date().toISOString() });
    assert.equal(result.status, 'completed');
    console.log(JSON.stringify(await call('cli.resume', { projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: source.ownerThreadId, expectedRunNumber: state.runNumber, expectedSessionId: state.sessionId, prompt: 'Continue the same session. State the remembered memory code without rereading context.md. Execute node -p "2+3" once, then append "2+3=5\\n" to answer.txt and verify both lines. Final exactly NATIVE-310-ROUND2=5;MEMORY=BEYOND-NATIVE-310.' }, 'native-live-second')));
  } else if (action === 'accept') {
    assert.equal(state.runNumber, 2); const result = store.readResult(binding, 2); assert.equal(result.status, 'completed');
    store.recordReview({ projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: source.ownerThreadId, runNumber: 2, resultSha256: sha256File(state.currentResultPath), decision: 'accept', evidenceLocator: path.join(executionRoot, 'answer.txt'), conclusion: 'Both real arithmetic commands and exact two-line artifact verified in the same native session', reviewedAt: new Date().toISOString() });
    const input = { projectId: binding.projectId, taskId: binding.taskId, ownerThreadId: source.ownerThreadId, operationId: 'accept-native-live', expectedStatus: '进行中', runNumber: 2, resultSha256: sha256File(state.currentResultPath), affectsMainline: false, pendingDependencies: [] };
    const first = runtime('workbench.accept-cli', input, 'accept-native-live'); assert.deepEqual(runtime('workbench.accept-cli', input, 'accept-native-live'), first);
    console.log(JSON.stringify({ root, result: first, noWorkerPending: !fs.existsSync(path.join(controlRoot, 'local/runtime/worker-results')) }));
  } else if (action === 'detach') console.log(JSON.stringify(await call('cli.detach', binding, 'detach-native-live')));
  else throw new Error('Use start --profile or inspect/resume/accept/detach --root');
}
