import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function terminalSequence(kind) {
  return [
    'finish-all-non-return-tools',
    'stabilize-and-draft-final',
    'send-native-wakeup-as-last-tool',
    `emit-${kind}-final-without-more-tools`,
  ];
}

function sweep(workers, consumed = new Set()) {
  return workers
    .filter((worker) => ['completed', 'paused'].includes(worker.status))
    .filter((worker) => !consumed.has(worker.threadId))
    .map((worker) => ({ threadId: worker.threadId, final: worker.final }));
}

function validTerminalTrace(events) {
  const wakeIndex = events.indexOf('send-native-wakeup');
  const finalIndex = events.indexOf('emit-final');
  if (wakeIndex < 1 || finalIndex !== wakeIndex + 1) return false;
  return events.slice(0, wakeIndex).every((event) => event !== 'business-tool-running')
    && events.slice(wakeIndex + 1).every((event) => !event.startsWith('business-tool'));
}

test('terminal return wakes the PM once without reading its state', () => {
  assert.deepEqual(terminalSequence('completed'), [
    'finish-all-non-return-tools',
    'stabilize-and-draft-final',
    'send-native-wakeup-as-last-tool',
    'emit-completed-final-without-more-tools',
  ]);
});

test('normal completion and abnormal pause both attempt return before emitting final', () => {
  assert.deepEqual(terminalSequence('paused-after-tool-failure'), [
    'finish-all-non-return-tools',
    'stabilize-and-draft-final',
    'send-native-wakeup-as-last-tool',
    'emit-paused-after-tool-failure-final-without-more-tools',
  ]);
});

test('observed early wake followed by more business tools is rejected', () => {
  assert.equal(validTerminalTrace([
    'draft-final',
    'send-native-wakeup',
    'business-tool-after-wakeup',
    'emit-final',
  ]), false);
  assert.equal(validTerminalTrace([
    'finish-business-tools',
    'draft-final',
    'send-native-wakeup',
    'emit-final',
  ]), true);
});

test('one coalesced callback still sweeps every completed Worker', () => {
  const workers = [
    { threadId: 'worker-a', status: 'completed', final: 'A' },
    { threadId: 'worker-b', status: 'completed', final: 'B' },
    { threadId: 'worker-c', status: 'paused', final: 'C' },
    { threadId: 'worker-d', status: 'active', final: null },
  ];
  assert.deepEqual(sweep(workers).map((item) => item.final), ['A', 'B', 'C']);
  assert.deepEqual(sweep(workers, new Set(['worker-b'])).map((item) => item.final), ['A', 'C']);
});

test('source rules use platform finals and remove the experimental delivery stack', () => {
  const agents = read('模板交付包/AGENTS.md');
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  const worker = read('模板交付包/skills/identity-worker/SKILL.md');
  const release = read('模板交付包/beyond-release.json');
  assert.match(agents, /扫描本PM已经登记的全部Worker任务/);
  assert.match(pm, /不能只看本次回调的发送者/);
  assert.match(worker, /不得从异常分支直接跳到final/);
  assert.match(worker, /不读取或判断来源PM忙闲/);
  assert.match(worker, /不调用`wait_threads`/);
  assert.match(worker, /直接按平台来源关系调用一次`send_message_to_thread`/);
  assert.match(worker, /只把已形成的final作为本轮最后一个动作输出/);
  assert.match(worker, /工具启动失败、缺失输出、权限或环境异常/);
  assert.match(worker, /不再复制终态正文到自建信箱/);
  for (const retired of ['terminal-provider', 'terminal-host-adapter', 'host-notify-dispatcher', 'installation-migration', 'codex-thread-delivery-provider']) {
    assert.doesNotMatch(release, new RegExp(retired));
  }
});

test('premature return cannot claim completion or allow later Worker tools', () => {
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  const worker = read('模板交付包/skills/identity-worker/SKILL.md');
  assert.doesNotMatch(worker, /当前Worker任务已结束，请扫描正式final/);
  assert.match(worker, /最后一次非回源工具调用已经结束/);
  assert.match(worker, /回源工具必须是本轮最后一次工具调用/);
  assert.match(worker, /回源工具返回后不得继续推理、发送过程消息或调用任何工具/);
  assert.match(pm, /仍在运行且没有可读final时保持`进行中`/);
  assert.match(pm, /本轮已经结束且没有可读final/);
  assert.match(pm, /用`workbench\.pause`一次记为`已暂停`/);
});

test('missing implementation or release steps stay with the original business result', () => {
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  assert.match(pm, /启动脚本、控制器、发布或复验任务前/);
  assert.match(pm, /新动作只是补齐原验收时恢复原 Worker/);
  assert.match(pm, /活动和暂停任务的业务结果与验收/);
});

test('runtime exposes only project identity and workbench actions', () => {
  const runtime = read('模板交付包/scripts/runtime/control-runtime.mjs');
  for (const retired of ['task.prepare', 'terminal.pending', 'migration.apply', 'notify']) {
    assert.doesNotMatch(runtime, new RegExp(retired.replace('.', '\\.')));
  }
  for (const current of ['project.resolve', 'workbench.migrate', 'workbench.register', 'workbench.pause', 'workbench.accept', 'workbench.recover']) {
    assert.match(runtime, new RegExp(current.replace('.', '\\.')));
  }
});
