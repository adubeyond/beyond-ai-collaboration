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

const CALLBACK_SETTLE_LIMIT_MS = 30_000;

function settleCallbackSender(finalDelayMs, finalStatus = 'completed') {
  const waitCount = finalDelayMs > 0 ? 1 : 0;
  if (finalDelayMs <= CALLBACK_SETTLE_LIMIT_MS) {
    return { waitCount, status: finalStatus, finalReadable: true };
  }
  return { waitCount, status: 'active', finalReadable: false };
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

test('one bounded callback wait closes normal final-delivery races', () => {
  for (const delayMs of [0, 5_000, 15_000, 29_000]) {
    assert.deepEqual(settleCallbackSender(delayMs), {
      waitCount: delayMs > 0 ? 1 : 0,
      status: 'completed',
      finalReadable: true,
    });
  }
  assert.deepEqual(settleCallbackSender(15_000, 'paused'), {
    waitCount: 1,
    status: 'paused',
    finalReadable: true,
  });
});

test('bounded callback wait neither polls nor accepts a late missing final', () => {
  assert.deepEqual(settleCallbackSender(30_001), {
    waitCount: 1,
    status: 'active',
    finalReadable: false,
  });
});

test('source rules use one frozen final with a short-lived receipt and no experimental delivery stack', () => {
  const agents = read('模板交付包/AGENTS.md');
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  const lifecycle = read('模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md');
  const worker = read('模板交付包/skills/identity-worker/SKILL.md');
  const release = read('模板交付包/beyond-release.json');
  assert.match(pm, /扫描工作台登记的全部Worker/);
  assert.match(lifecycle, /再扫描全部登记Worker/);
  assert.match(worker, /不得从异常分支直接跳到final/);
  assert.match(worker, /不读取或判断来源PM忙闲/);
  assert.match(worker, /不调用`wait_threads`/);
  assert.match(worker, /回源目标只取当前平台任务包装提供的`source_thread_id`/);
  assert.match(worker, /当前Worker `threadId`不是回源目标/);
  assert.match(worker, /从`ALL_TOOLS`发现规范工具`codex_app__send_message_to_thread`/);
  assert.match(worker, /顶层未显示不等于工具不存在/);
  assert.match(worker, /执行一次`worker-result\.enqueue`/);
  assert.match(worker, /直接向唯一来源调用一次/);
  assert.match(worker, /只把已冻结的同一份final作为本轮最后一个动作输出/);
  assert.match(worker, /工具启动失败、缺失输出、权限或环境异常/);
  assert.match(worker, /不是第二种业务真值、消息历史或长期证据/);
  assert.match(lifecycle, /工作台提交或删除失败时保留回执/);
  assert.doesNotMatch(agents, /send_message_to_thread|wait_threads/);
  for (const retired of ['terminal-provider', 'terminal-host-adapter', 'host-notify-dispatcher', 'installation-migration', 'codex-thread-delivery-provider']) {
    assert.doesNotMatch(release, new RegExp(retired));
  }
});

test('premature return cannot claim completion or allow later Worker tools', () => {
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  const lifecycle = read('模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md');
  const worker = read('模板交付包/skills/identity-worker/SKILL.md');
  assert.doesNotMatch(worker, /当前Worker任务已结束，请扫描正式final/);
  assert.match(worker, /最后一次业务工具调用已经结束/);
  assert.match(worker, /回源工具必须是本轮最后一次工具调用/);
  assert.match(worker, /回源工具返回后不得继续推理、发送过程消息或调用任何工具/);
  assert.match(lifecycle, /仍在运行且没有可读final/);
  assert.match(lifecycle, /wait_threads\(timeoutMs=30000\)/);
  assert.match(lifecycle, /只对该来源调用一次/);
  assert.match(lifecycle, /不得循环/);
  assert.match(lifecycle, /执行线程未形成正式结果/);
  assert.match(lifecycle, /`workbench\.pause`一次把业务任务记为`已暂停`/);
});

test('missing implementation or release steps stay with the original business result', () => {
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  assert.match(pm, /同一结果的检查点、返工和补齐验收继续使用原Worker/);
  assert.match(pm, /同一结果恢复或补充原Worker/);
  assert.match(pm, /只有新的独立结果才新建/);
});

test('runtime exposes project identity, workbench and short-lived Worker result actions', () => {
  const runtime = read('模板交付包/scripts/runtime/control-runtime.mjs');
  for (const retired of ['task.prepare', 'terminal.pending', 'migration.apply', 'notify']) {
    assert.doesNotMatch(runtime, new RegExp(retired.replace('.', '\\.')));
  }
  for (const current of ['project.resolve', 'worker-result.enqueue', 'worker-result.list', 'worker-result.ack', 'workbench.migrate', 'workbench.register', 'workbench.pause', 'workbench.accept', 'workbench.recover']) {
    assert.match(runtime, new RegExp(current.replace('.', '\\.')));
  }
});

test('readable platform final stays authoritative without byte-for-byte receipt equality', () => {
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  const pmLifecycle = read('模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md');
  assert.match(pm, /平台final可读时它仍是正式真值/);
  assert.match(pm, /不要求措辞逐字一致/);
  assert.match(pmLifecycle, /措辞、格式或详略不同本身不阻止验收/);
  assert.match(pmLifecycle, /两者存在实质矛盾时保持未验收并退回原Worker/);
  assert.doesNotMatch(pmLifecycle, /正文指纹一致/);
});
