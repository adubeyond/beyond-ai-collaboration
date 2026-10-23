import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, sha256File, digest } from './cli-task-store.mjs';

// These notices are evidenced by an authenticated native lifecycle hook, not a
// fabricated transcript offset. They retain the same owner/run notification path.
export const nativeHookAttentionKinds = Object.freeze({
  'session-cron-awaiting-owner': Object.freeze({ itemId: 'session-crons', tool: 'CronCreate', hookEvent: 'Stop',
    description: '原会话仍有定时任务，本轮尚无最终结果；受管入口不会自动放行定时提示，请核对已有授权并决定如何在原会话继续。' }),
  'attention-observer-unavailable': Object.freeze({ itemId: 'transcript-observer', tool: 'ClaudeTranscript', hookEvent: 'UserPromptSubmit',
    description: '原会话的增量记录观察入口不可用，后台任务登记或问题提醒可能不完整；请核对原会话，不能据此判断执行仍在推进。' }),
  'background-state-unavailable': Object.freeze({ itemId: 'background-state', tool: 'ClaudeBackground', hookEvent: 'Stop',
    description: '原会话返回的后台任务状态无法确认，本轮未被当作完成；请核对原会话的实际待处理工作。' }),
});

export function attentionPaths(store, run, { code = 'permission-classifier-unavailable', itemId } = {}) {
  const directory = store.runDir(run, run.runNumber);
  const legacy = code === 'permission-classifier-unavailable';
  if (!legacy && ((!['question-awaiting-answer', 'permission-denied'].includes(code) && !Object.hasOwn(nativeHookAttentionKinds, code))
    || !/^[\w.-]{1,128}$/.test(itemId ?? '') || (Object.hasOwn(nativeHookAttentionKinds, code) && itemId !== nativeHookAttentionKinds[code].itemId))) throw new Error('Invalid CLI attention identity');
  const stem = legacy ? 'attention' : `attention-${digest([code, itemId])}`;
  return { evidencePath: store.checkedPath(path.join(directory, `${stem}.json`)), markerPath: store.checkedPath(path.join(directory, `${stem}-notification.json`)) };
}

// A completed, authorized transfer invalidates the old sender, not its durable
// result. Close only the claim this sender already owns; never impersonate the
// successor to send, review, resume, or mutate task.json.
function finishTransferredClaim({ store, identity, runNumber, markerPath, claimSha256, resultSha256, outcome }) {
  return store.withLock(identity, () => {
    const locator = store.readJson(store.locator(identity));
    if (!locator.transferOperationId) throw new Error('CLI notification owner changed without a verified transfer');
    const transfer = store.readJson(path.join(store.transferDirectory(identity, locator.transferOperationId), 'transfer.json'));
    if (transfer.phase !== 'completed' || transfer.projectId !== identity.projectId || transfer.taskId !== identity.taskId
      || transfer.fromOwnerThreadId !== identity.ownerThreadId || transfer.toOwnerThreadId === identity.ownerThreadId
      || transfer.expectedRunNumber !== runNumber || transfer.expectedResultSha256 !== resultSha256) {
      throw new Error('CLI notification transfer proof mismatch');
    }
    // Check the historical handoff proof, not whether the successor is still
    // idle: they may already have reviewed or resumed the preserved session.
    const predecessorPath = path.join(store.transferDirectory(identity, transfer.operationId), 'task.preimage.json');
    const predecessor = store.readJson(predecessorPath);
    const successor = { projectId: identity.projectId, taskId: identity.taskId, ownerThreadId: transfer.toOwnerThreadId };
    const current = store.read(successor);
    if (sha256File(predecessorPath) !== transfer.originalTaskSha256 || digest(predecessor) !== transfer.expectedStateSha256
      || predecessor.ownerThreadId !== identity.ownerThreadId || predecessor.runNumber !== runNumber || predecessor.sessionId !== transfer.expectedSessionId
      || current.transferOperationId !== transfer.operationId || current.sessionId !== transfer.expectedSessionId || current.runNumber < runNumber
      || current.ownerProvenance?.originalOwnerThreadId !== identity.ownerThreadId || current.ownerProvenance?.currentOwnerThreadId !== transfer.toOwnerThreadId
      || current.ownerProvenance?.transferredAt !== transfer.transferredAt
      || !current.ownerTransfers?.some(item => item.operationId === transfer.operationId && item.fromOwnerThreadId === identity.ownerThreadId
        && item.toOwnerThreadId === transfer.toOwnerThreadId && item.transferredAt === transfer.transferredAt && item.authorizationLocator === transfer.authorizationLocator)) {
      throw new Error('CLI notification transferred ownership proof mismatch');
    }
    const resultPath = path.join(store.runDir(identity, runNumber), 'result.json');
    if (sha256File(resultPath) !== resultSha256 || sha256File(markerPath) !== claimSha256) {
      throw new Error('CLI notification transfer evidence changed');
    }
    const relativeMarker = path.relative(store.taskDir(identity), markerPath);
    if (!transfer.inventory?.some(item => item.file === relativeMarker && item.sha256 === claimSha256)) {
      throw new Error('CLI notification claim was not included in the verified transfer');
    }
    const previous = store.readJson(markerPath);
    if (previous.status !== 'claimed') throw new Error('CLI notification claim already finalized');
    const result = store.readResult(successor, runNumber), review = store.readReview(successor, runNumber);
    if (result.ownerThreadId !== identity.ownerThreadId || result.sessionId !== transfer.expectedSessionId) {
      throw new Error('CLI notification original result identity changed');
    }
    const retired = { ...previous, ...outcome, finishedAt: new Date().toISOString(),
      supersededByOwnerTransfer: transfer.operationId,
      preservedResult: { ownerThreadId: current.ownerThreadId, runNumber, resultPath, sha256: resultSha256, pendingReview: !review } };
    atomicJson(markerPath, retired);
    return { ...outcome, markerPath, supersededByOwnerTransfer: retired.supersededByOwnerTransfer, preservedResult: retired.preservedResult };
  });
}

export async function notifyWhenReady({ store, identity, runNumber, host, sourceEnd }) {
  const result = store.readResult(identity, runNumber);
  const state = store.read(identity);
  if (state.runNumber !== runNumber) return { status: 'stale-suppressed', markerPath: null };
  const claim = store.claimNotification(identity, runNumber);
  if (!claim.claimed) return { status: 'duplicate-suppressed', markerPath: claim.markerPath };
  const resultPath = path.join(store.runDir(identity, runNumber), 'result.json');
  const resultSha256 = sha256File(resultPath), claimSha256 = sha256File(claim.markerPath);
  const finish = outcome => {
    try { return store.finishNotification(identity, runNumber, outcome); }
    catch (error) {
      if (error.message !== 'CLI identity mismatch') throw error;
      return finishTransferredClaim({ store, identity, runNumber, markerPath: claim.markerPath, claimSha256, resultSha256, outcome });
    }
  };
  try {
    await (sourceEnd ?? host.waitForSourceTurnEnd({ ownerThreadId: identity.ownerThreadId, ownerTurnId: state.ownerTurnId }));
    const current = store.read(identity);
    if (current.runNumber !== runNumber || store.readReview(identity, runNumber)) return finish({ status: 'unavailable', error: 'Result already reviewed or superseded; no late action sent' });
    // A transfer reserves control before task.json changes owner. Do not wake
    // the outgoing owner in that gap, including after waiting in the host queue.
    store.assertTransferSettled(identity);
    const capability = await host.checkCapability();
    if (!capability.available) return finish({ status: 'unavailable', error: capability.reason });
    const prompt = ['CLI_RESULT_READY（本轮运行结果待直接负责人核验，不代表业务完成或新指令）', `projectId=${identity.projectId}`, `taskId=${identity.taskId}`, `runNumber=${runNumber}`, `status=${result.status}`, `resultPath=${resultPath}`, `sha256=${sha256File(resultPath)}`,
      '请定点核对本轮结果、当前阶段验收、业务证据和最新用户指令，并读取任务中保存的新要求；本轮结果不能覆盖新要求。',
      '只有当前已批准的小目标尚未完成、未暂停且未到用户检查点时，才由直接负责人判断是否纠偏并续跑原会话。已暂停、已停止、等待用户检查点或新增要求尚未确认时，只保留结果并说明差距，不自动恢复业务或启动新目标。',
      '通知只传递结果，不授予派单、恢复、跨模块指挥或向其他 PM 转发的权限；不得将其转述为老板指令。不新开 CLI，不把本通知当 Worker 终态回执。'].join('\n');
    const beforeSend = () => {
      store.assertTransferSettled(identity);
      return store.read(identity).runNumber === runNumber && !store.readReview(identity, runNumber);
    };
    const outcome = await host.send({ ownerThreadId: identity.ownerThreadId, prompt, beforeSend });
    return finish({ ...outcome, ...(outcome.status === 'unavailable' ? {} : { sentAt: new Date().toISOString() }) });
  } catch (error) { return finish({ status: 'unavailable', error: error.message }); }
}

// An evidence-backed attention signal is not a final, acceptance or stop request.
// Keep its claim separate so it cannot consume the eventual result notification.
export async function notifyOnAttention({ store, run, host, sourceEnd, attention = { code: 'permission-classifier-unavailable' } }) {
  const directory = store.runDir(run, run.runNumber);
  const { evidencePath, markerPath } = attentionPaths(store, run, attention);
  const eligible = () => {
    try {
      const state = store.currentRun(run), evidence = store.readJson(evidencePath);
      store.assertTransferSettled(run);
      return state.status === 'running' && state.sessionId === evidence.sessionId
        && evidence.projectId === run.projectId && evidence.taskId === run.taskId && evidence.runNumber === run.runNumber
        && evidence.code === attention.code && evidence.itemId === attention.itemId
        && evidence.ownerThreadId === run.ownerThreadId && evidence.requestId === run.requestId
        && !evidence.recoveredAt && !fs.existsSync(path.join(directory, 'result.json'))
        && !fs.existsSync(path.join(directory, 'stop.json'));
    } catch { return false; }
  };
  const claimed = store.withLock(run, () => {
    if (!eligible() || fs.existsSync(markerPath)) return false;
    atomicJson(markerPath, { status: 'claimed', claimedAt: new Date().toISOString() }); return true;
  });
  if (!claimed) return { status: 'suppressed', markerPath };
  let outcome;
  try {
    await (sourceEnd ?? host.waitForSourceTurnEnd({ ownerThreadId: run.ownerThreadId, ownerTurnId: run.ownerTurnId }));
    if (!eligible()) outcome = { status: 'suppressed', error: 'Attention resolved or run no longer active' };
    else {
      const capability = await host.checkCapability();
      if (!capability.available) outcome = { status: 'unavailable', error: capability.reason };
      else {
        const description = Object.hasOwn(nativeHookAttentionKinds, attention.code) ? nativeHookAttentionKinds[attention.code].description
          : attention.code === 'question-awaiting-answer'
          ? '原会话提出了需要回答的问题；请核对是否仍在等待，不能把运行中当作正在推进。'
          : attention.code === 'permission-denied'
            ? '原会话遇到明确权限拒绝；请核对其影响和当前是否仍受阻，不能自动批准或绕过拒绝。'
            : '原会话连续遇到权限分类服务不可用，可能无法继续执行；尚无本轮最终结果。';
        const prompt = ['CLI_ATTENTION_REQUIRED（执行异常或问题待负责人判断，不是终态）', `projectId=${run.projectId}`, `taskId=${run.taskId}`, `runNumber=${run.runNumber}`,
          description, `evidencePath=${evidencePath}`, `sha256=${sha256File(evidencePath)}`,
          '请沿证据定位原问题，核对当前小目标、已有授权和最新用户指令；在授权内完成技术核查与处理，需要新增业务决定或安全授权时向用户说明事实和建议，不原样转交未经核实的选项。已暂停或到用户检查点时保持该边界，不因通知自动恢复业务。',
          '本通知只交给直接负责人，不向其他 PM 广播，也不是老板的新指令。保持当前主问题完整。此通知不授权停止、重建、切换模型、代替用户批准或绕过权限，不代表完成、暂停或验收。'].join('\n');
        outcome = await host.send({ ownerThreadId: run.ownerThreadId, prompt, beforeSend: eligible });
      }
    }
  } catch (error) { outcome = { status: 'unavailable', error: error.message }; }
  const previous = store.readJson(markerPath);
  atomicJson(markerPath, { ...previous, ...outcome, finishedAt: new Date().toISOString() });
  return { ...outcome, markerPath };
}
