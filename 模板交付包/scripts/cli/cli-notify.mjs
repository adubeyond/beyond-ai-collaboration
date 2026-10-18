import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, sha256File } from './cli-task-store.mjs';

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
export async function notifyOnAttention({ store, run, host, sourceEnd }) {
  const directory = store.runDir(run, run.runNumber);
  const evidencePath = store.checkedPath(path.join(directory, 'attention.json'));
  const markerPath = store.checkedPath(path.join(directory, 'attention-notification.json'));
  const eligible = () => {
    try {
      const state = store.currentRun(run), evidence = store.readJson(evidencePath);
      return state.status === 'running' && state.sessionId === evidence.sessionId
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
        const prompt = ['CLI_ATTENTION_REQUIRED（执行异常待负责人判断，不是终态）', `projectId=${run.projectId}`, `taskId=${run.taskId}`, `runNumber=${run.runNumber}`,
          '原会话连续遇到权限分类服务不可用，可能无法继续执行；尚无本轮最终结果。', `evidencePath=${evidencePath}`, `sha256=${sha256File(evidencePath)}`,
          '请核对当前用户目标、本轮证据与原会话现状，判断如何处理；保持当前主问题完整。此通知不授权停止、重建、切换模型或绕过权限，不代表完成、暂停或验收。'].join('\n');
        outcome = await host.send({ ownerThreadId: run.ownerThreadId, prompt, beforeSend: eligible });
      }
    }
  } catch (error) { outcome = { status: 'unavailable', error: error.message }; }
  const previous = store.readJson(markerPath);
  atomicJson(markerPath, { ...previous, ...outcome, finishedAt: new Date().toISOString() });
  return { ...outcome, markerPath };
}
