import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, sha256File, digest } from './cli-task-store.mjs';

export function attentionPaths(store, run, { code = 'permission-classifier-unavailable', itemId } = {}) {
  const directory = store.runDir(run, run.runNumber);
  const legacy = code === 'permission-classifier-unavailable';
  if (!legacy && (!['question-awaiting-answer', 'permission-denied'].includes(code) || !/^[\w.-]{1,128}$/.test(itemId ?? ''))) throw new Error('Invalid CLI attention identity');
  const stem = legacy ? 'attention' : `attention-${digest([code, itemId])}`;
  return { evidencePath: store.checkedPath(path.join(directory, `${stem}.json`)), markerPath: store.checkedPath(path.join(directory, `${stem}-notification.json`)) };
}

export async function notifyWhenReady({ store, identity, runNumber, host, sourceEnd }) {
  const result = store.readResult(identity, runNumber);
  const state = store.read(identity);
  if (state.runNumber !== runNumber) return { status: 'stale-suppressed', markerPath: null };
  const claim = store.claimNotification(identity, runNumber);
  if (!claim.claimed) return { status: 'duplicate-suppressed', markerPath: claim.markerPath };
  try {
    await (sourceEnd ?? host.waitForSourceTurnEnd({ ownerThreadId: identity.ownerThreadId, ownerTurnId: state.ownerTurnId }));
    const current = store.read(identity);
    if (current.runNumber !== runNumber || store.readReview(identity, runNumber)) return store.finishNotification(identity, runNumber, { status: 'unavailable', error: 'Result already reviewed or superseded; no late action sent' });
    const capability = await host.checkCapability();
    if (!capability.available) return store.finishNotification(identity, runNumber, { status: 'unavailable', error: capability.reason });
    const resultPath = path.join(store.runDir(identity, runNumber), 'result.json');
    const prompt = ['CLI_RESULT_READY（本轮运行结果待负责人核验，不代表业务完成）', `projectId=${identity.projectId}`, `taskId=${identity.taskId}`, `runNumber=${runNumber}`, `status=${result.status}`, `resultPath=${resultPath}`, `sha256=${sha256File(resultPath)}`, '请定点核对本轮结果、业务证据和当前用户指令。目标未满足时纠正并续跑同一会话；保持当前主问题完整。不新开 CLI、不把本通知当 Worker 终态回执。'].join('\n');
    const beforeSend = () => store.read(identity).runNumber === runNumber && !store.readReview(identity, runNumber);
    const outcome = await host.send({ ownerThreadId: identity.ownerThreadId, prompt, beforeSend });
    return store.finishNotification(identity, runNumber, { ...outcome, ...(outcome.status === 'unavailable' ? {} : { sentAt: new Date().toISOString() }) });
  } catch (error) { return store.finishNotification(identity, runNumber, { status: 'unavailable', error: error.message }); }
}

// An evidence-backed attention signal is not a final, acceptance or stop request.
// Keep its claim separate so it cannot consume the eventual result notification.
export async function notifyOnAttention({ store, run, host, sourceEnd, attention = { code: 'permission-classifier-unavailable' } }) {
  const directory = store.runDir(run, run.runNumber);
  const { evidencePath, markerPath } = attentionPaths(store, run, attention);
  const eligible = () => {
    try {
      const state = store.currentRun(run), evidence = store.readJson(evidencePath);
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
        const description = attention.code === 'question-awaiting-answer'
          ? '原会话提出了需要回答的问题；请核对是否仍在等待，不能把运行中当作正在推进。'
          : attention.code === 'permission-denied'
            ? '原会话遇到明确权限拒绝；请核对其影响和当前是否仍受阻，不能自动批准或绕过拒绝。'
            : '原会话连续遇到权限分类服务不可用，可能无法继续执行；尚无本轮最终结果。';
        const prompt = ['CLI_ATTENTION_REQUIRED（执行异常或问题待负责人判断，不是终态）', `projectId=${run.projectId}`, `taskId=${run.taskId}`, `runNumber=${run.runNumber}`,
          description, `evidencePath=${evidencePath}`, `sha256=${sha256File(evidencePath)}`,
          '请沿证据定位原问题，核对当前目标和已有授权；在授权内完成技术核查与处理，需要新增业务决定或安全授权时向用户说明事实和建议，不原样转交未经核实的选项。保持当前主问题完整。此通知不授权停止、重建、切换模型、代替用户批准或绕过权限，不代表完成、暂停或验收。'].join('\n');
        outcome = await host.send({ ownerThreadId: run.ownerThreadId, prompt, beforeSend: eligible });
      }
    }
  } catch (error) { outcome = { status: 'unavailable', error: error.message }; }
  const previous = store.readJson(markerPath);
  atomicJson(markerPath, { ...previous, ...outcome, finishedAt: new Date().toISOString() });
  return { ...outcome, markerPath };
}
