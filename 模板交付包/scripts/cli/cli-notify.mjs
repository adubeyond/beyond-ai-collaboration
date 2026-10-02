import path from 'node:path';
import { sha256File } from './cli-task-store.mjs';

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
    const outcome = await host.send({ ownerThreadId: identity.ownerThreadId, prompt });
    return store.finishNotification(identity, runNumber, { ...outcome, sentAt: new Date().toISOString() });
  } catch (error) { return store.finishNotification(identity, runNumber, { status: 'unavailable', error: error.message }); }
}
