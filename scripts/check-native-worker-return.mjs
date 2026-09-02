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
    'enqueue-frozen-final-once',
    'send-native-wakeup-as-last-tool',
    `emit-${kind}-final-without-more-tools`,
  ];
}

function reviewBoundary({ followupWithinSameAuthorizedResult }) {
  return followupWithinSameAuthorizedResult ? 'checkpoint' : 'completed';
}

function matchingActiveReceipts(receipts, activeTasks) {
  const activeByTask = new Map(activeTasks.map((task) => [task.taskId, task]));
  return receipts.filter((receipt) => {
    const task = activeByTask.get(receipt.taskId);
    if (!task) return false;
    if (receipt.projectId !== task.projectId || receipt.sourceThreadId !== task.sourceThreadId) return false;
    return !receipt.workerThreadId || receipt.workerThreadId === task.workerThreadId;
  });
}

function closeoutDecision({ matchingReceipt, finalReadable, finalConflict = false, independentEvidence, legacyTask = false }) {
  if (!matchingReceipt) {
    return legacyTask && finalReadable
      ? { reads: 1, waits: 0, action: 'accept', ack: false, truth: 'platform-final' }
      : { reads: 1, waits: 0, action: 'hold', ack: false, truth: null };
  }
  if (finalConflict || !independentEvidence) {
    return { reads: 1, waits: 0, action: 'hold', ack: false, truth: null };
  }
  return {
    reads: 1,
    waits: 0,
    action: 'accept',
    ack: true,
    truth: finalReadable ? 'platform-final' : 'receipt-fallback',
  };
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
    'enqueue-frozen-final-once',
    'send-native-wakeup-as-last-tool',
    'emit-completed-final-without-more-tools',
  ]);
});

test('normal completion and abnormal pause both attempt return before emitting final', () => {
  assert.deepEqual(terminalSequence('paused-after-tool-failure'), [
    'finish-all-non-return-tools',
    'stabilize-and-draft-final',
    'enqueue-frozen-final-once',
    'send-native-wakeup-as-last-tool',
    'emit-paused-after-tool-failure-final-without-more-tools',
  ]);
});

test('normal completion, true pause and abnormal terminal each freeze, enqueue, wake and emit exactly once', () => {
  for (const kind of ['completed', 'paused', 'abnormal']) {
    const sequence = terminalSequence(kind);
    for (const event of [
      'stabilize-and-draft-final',
      'enqueue-frozen-final-once',
      'send-native-wakeup-as-last-tool',
      `emit-${kind}-final-without-more-tools`,
    ]) {
      assert.equal(sequence.filter((item) => item === event).length, 1, `${kind}:${event}`);
    }
  }
});

test('review wording does not hide the terminal boundary of a design-only task', () => {
  assert.equal(reviewBoundary({ followupWithinSameAuthorizedResult: false }), 'completed');
  assert.equal(reviewBoundary({ followupWithinSameAuthorizedResult: true }), 'checkpoint');
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

test('one callback selects every matching active receipt without scanning unrelated Workers', () => {
  const activeTasks = [
    { projectId: 'project-a', taskId: 'task-a', sourceThreadId: 'pm-a', workerThreadId: 'worker-a' },
    { projectId: 'project-a', taskId: 'task-c', sourceThreadId: 'pm-a', workerThreadId: 'worker-c' },
  ];
  const receipts = [
    { projectId: 'project-a', taskId: 'task-a', sourceThreadId: 'pm-a', workerThreadId: 'worker-a' },
    { projectId: 'project-a', taskId: 'task-b', sourceThreadId: 'pm-a', workerThreadId: 'worker-b' },
    { projectId: 'project-a', taskId: 'task-c', sourceThreadId: 'wrong-pm', workerThreadId: 'worker-c' },
    { projectId: 'project-a', taskId: 'task-c', sourceThreadId: 'pm-a', workerThreadId: 'worker-c' },
  ];
  assert.deepEqual(matchingActiveReceipts(receipts, activeTasks).map((item) => item.taskId), ['task-a', 'task-c']);
});

test('matching pending closes with zero wait only after independent evidence is complete', () => {
  assert.deepEqual(closeoutDecision({ matchingReceipt: true, finalReadable: true, independentEvidence: true }), {
    reads: 1, waits: 0, action: 'accept', ack: true, truth: 'platform-final',
  });
  assert.deepEqual(closeoutDecision({ matchingReceipt: true, finalReadable: false, independentEvidence: true }), {
    reads: 1, waits: 0, action: 'accept', ack: true, truth: 'receipt-fallback',
  });
  assert.deepEqual(closeoutDecision({ matchingReceipt: true, finalReadable: false, independentEvidence: false }), {
    reads: 1, waits: 0, action: 'hold', ack: false, truth: null,
  });
  assert.deepEqual(closeoutDecision({ matchingReceipt: true, finalReadable: true, finalConflict: true, independentEvidence: true }), {
    reads: 1, waits: 0, action: 'hold', ack: false, truth: null,
  });
  assert.deepEqual(closeoutDecision({ matchingReceipt: false, finalReadable: true, independentEvidence: true, legacyTask: false }), {
    reads: 1, waits: 0, action: 'hold', ack: false, truth: null,
  });
  assert.deepEqual(closeoutDecision({ matchingReceipt: false, finalReadable: true, independentEvidence: true, legacyTask: true }), {
    reads: 1, waits: 0, action: 'accept', ack: false, truth: 'platform-final',
  });
});

test('source rules use one frozen final with a short-lived receipt and no experimental delivery stack', () => {
  const agents = read('模板交付包/AGENTS.md');
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  const lifecycle = read('模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md');
  const worker = read('模板交付包/skills/identity-worker/SKILL.md');
  const release = read('模板交付包/beyond-release.json');
  assert.match(pm, /只执行一次`worker-result\.list`/);
  assert.match(pm, /只(?:对)?(?:与)?活动任务匹配的登记Worker(?:各)?(?:定点)?读取一次|只读取匹配活动任务的登记Worker一次/);
  assert.match(lifecycle, /不扫描无关Worker/);
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
  assert.match(worker, /检查点先按任务的`结果与验收 \+ 对象与边界`判断/);
  assert.match(worker, /实现、发布或后续动作明确不在本任务范围/);
  assert.match(worker, /才是非终态用户检查点/);
  assert.match(pm, /Worker交付后必须作为`已完成`终态回到PM/);
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
  assert.match(lifecycle, /匹配回执存在时不得调用正时长`wait_threads`/);
  assert.match(lifecycle, /回执只能恢复同一份冻结正文，不能单独证明业务完成/);
  assert.match(lifecycle, /没有回执的新任务不得沿用原生final绕过终态协议/);
  assert.match(lifecycle, /缺少`projectRoute`，这是派单纠正，不是业务暂停或终态/);
  assert.match(lifecycle, /保持同一活动任务为`进行中`/);
  assert.match(lifecycle, /不得执行`workbench\.pause \/ workbench\.accept \/ worker-result\.ack`/);
  assert.match(worker, /读取业务文件或调用业务工具前即停止业务动作/);
  assert.match(worker, /不执行`worker-result\.enqueue`/);
  assert.match(worker, /收到精确route后由同一Worker继续原任务/);
  assert.doesNotMatch(lifecycle, /wait_threads\(timeoutMs=/);
  assert.match(lifecycle, /执行线程未形成正式结果/);
  assert.match(lifecycle, /`workbench\.pause`一次把业务任务记为`已暂停`/);
});

test('missing implementation or release steps stay with the original business result', () => {
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  assert.match(pm, /同一结果的检查点、返工和补验收沿用原Worker/);
  assert.match(pm, /同一结果恢复或补充原Worker/);
  assert.match(pm, /只有新的独立结果才新建/);
});

test('runtime exposes project identity, workbench and short-lived Worker result actions', () => {
  const runtime = read('模板交付包/scripts/runtime/control-runtime.mjs');
  for (const retired of ['task.prepare', 'terminal.pending', 'migration.apply', 'notify']) {
    assert.doesNotMatch(runtime, new RegExp(retired.replace('.', '\\.')));
  }
  for (const current of ['project.resolve', 'worker-result.enqueue', 'worker-result.list', 'worker-result.ack', 'workbench.migrate', 'workbench.register', 'workbench.pause', 'workbench.accept', 'workbench.close', 'workbench.recover']) {
    assert.match(runtime, new RegExp(current.replace('.', '\\.')));
  }
});

test('owner-authorized closure is separate from completion, pause and Worker receipts', () => {
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  const lifecycle = read('模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md');
  const runtime = read('模板交付包/scripts/runtime/control-runtime.mjs');
  assert.match(pm, /只有老板明确要求关闭、取消、不再做、以另一任务替代/);
  assert.match(pm, /沉默、闲置、失败、失联、超时或缺少结果都不能推断关闭/);
  assert.match(lifecycle, /登记Worker已经不在运行/);
  assert.match(lifecycle, /该任务没有pending回执/);
  assert.match(lifecycle, /关闭不调用`workbench\.accept`/);
  assert.match(lifecycle, /不生成或消费Worker回执/);
  assert.match(runtime, /task closure requires zero pending Worker result receipts/);
});

test('readable platform final stays authoritative without byte-for-byte receipt equality', () => {
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  const pmLifecycle = read('模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md');
  assert.match(pm, /平台final可读时它仍是正式真值/);
  assert.match(pm, /不要求措辞逐字一致/);
  assert.match(pm, /新任务无回执不得验收/);
  assert.match(pmLifecycle, /措辞、格式或详略不同本身不阻止验收/);
  assert.match(pmLifecycle, /两者存在实质矛盾时保持未验收并退回原Worker/);
  assert.doesNotMatch(pmLifecycle, /正文指纹一致/);
});

test('an injected delegation cannot replace the active user request', () => {
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  const lifecycle = read('模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md');
  assert.match(pm, /`<codex_delegation>`、Worker回调或其他任务消息是追加并发输入/);
  assert.match(pm, /不是老板撤回或替换当前问题/);
  assert.match(pm, /任何回调都不得打断前台回答/);
  assert.match(pm, /final先完整回答老板请求的全部事项/);
  assert.match(pm, /多条回调不得覆盖或遗漏/);
  assert.match(lifecycle, /一条或多条回调及其他`<codex_delegation>`注入PM正在回答老板请求的同一turn/);
  assert.match(lifecycle, /不得丢弃、重启、截断或改写已经开始处理的请求/);
  assert.match(lifecycle, /最终答复必须先给出老板该请求全部事项的完整结果或准确未完成说明/);
  assert.match(lifecycle, /后一条回调不能覆盖前一条/);
});

test('Worker completion always reports its PM while nonterminal supervision stays separate', () => {
  const pm = read('模板交付包/skills/identity-pm/SKILL.md');
  const worker = read('模板交付包/skills/identity-worker/SKILL.md');
  assert.match(worker, /Worker把正式任务做完后必须向唯一来源PM报告一次/);
  assert.match(worker, /来源PM正在回答老板、暂时忙碌或可能延后处理，都不能成为跳过终态回执或原生回调的理由/);
  assert.match(worker, /这种说明不执行`worker-result\.enqueue`/);
  assert.match(worker, /普通里程碑、方法选择和可自行闭环的问题留在当前Worker/);
  assert.match(pm, /PM督导只在明确检查点或需要项目全貌裁决主线、其他任务或共享对象时发生/);
  assert.match(pm, /任务保持`进行中`，不使用终态回执、`pause`或`accept`/);
});
