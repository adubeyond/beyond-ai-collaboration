import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ProjectIdentityProvider } from './project-identity-provider.mjs';
import { WorkerResultReceiptStore } from './worker-result-receipts.mjs';
import { WorkbenchTransactionStore } from './workbench-transaction.mjs';
import { CliTaskStore } from '../cli/cli-task-store.mjs';

const ACTIONS = new Set([
  'project.resolve',
  'workbench.migrate',
  'workbench.register',
  'workbench.update',
  'workbench.pause',
  'workbench.snapshot',
  'workbench.inspect',
  'workbench.accept',
  'workbench.accept-cli',
  'workbench.close',
  'workbench.recover',
  'worker-result.enqueue',
  'worker-result.list',
  'worker-result.ack',
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function roots(controlRoot, request, executionRoot, ownerThreadId) {
  const localRuntime = path.join(controlRoot, 'local', 'runtime');
  const codexHome = path.resolve(request.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  return {
    controlRoot,
    ownerThreadId,
    executionRoot: executionRoot ? path.resolve(executionRoot) : null,
    codexHome,
    projectIdentityRoot: path.join(localRuntime, 'project-identity'),
    workbenchRoot: path.join(localRuntime, 'workbench'),
    workerResultRoot: path.join(localRuntime, 'worker-results'),
    viewPath: path.join(controlRoot, 'local', '当前工作台.md'),
    historyRoot: path.join(controlRoot, 'local', 'history', 'workbench'),
  };
}

function workbench(config) {
  return new WorkbenchTransactionStore({
    runtimeRoot: config.workbenchRoot,
    viewPath: config.viewPath,
    historyRoot: config.historyRoot,
  });
}

function activeWorkbenchTask(config, taskId) {
  const stateFile = path.join(config.workbenchRoot, 'workbench-state.json');
  if (!fs.existsSync(stateFile)) return null;
  if (!fs.existsSync(config.viewPath)) {
    throw new Error('workbench view is missing beside machine state');
  }
  const state = new WorkbenchTransactionStore({
    runtimeRoot: config.workbenchRoot,
    viewPath: config.viewPath,
    historyRoot: config.historyRoot,
    readOnly: true,
  }).snapshot();
  return state.tasks?.[taskId] ?? null;
}

function validateReceiptTaskIdentity(config, input) {
  const task = activeWorkbenchTask(config, input.taskId);
  if (!task) return;
  if (task.execution?.kind === 'cli') throw new Error('CLI intermediate results cannot use Worker receipts');
  if (input.sourceThreadId === task.worker) {
    throw new Error('sourceThreadId cannot equal the registered Worker');
  }
  if (input.workerThreadId !== undefined && input.workerThreadId !== task.worker) {
    throw new Error('workerThreadId does not match the registered Worker');
  }
}

function workerResults(config, options = {}) {
  return new WorkerResultReceiptStore({ runtimeRoot: config.workerResultRoot, ...options });
}

function projectIdentity(config) {
  return new ProjectIdentityProvider({
    controlRoot: config.controlRoot,
    runtimeRoot: config.projectIdentityRoot,
  });
}

function workbenchTransaction(config, operationId) {
  const file = path.join(config.workbenchRoot, 'transactions', `${operationId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read workbench transaction ${operationId}: ${error.message}`);
  }
}

function inspectWorkbench(config, rawInput) {
  const input = object(rawInput, 'workbench inspection');
  const projectId = nonEmpty(input.projectId, 'projectId');
  projectIdentity(config).validateControlProject(projectId);
  const filter = { projectId };
  if (input.taskId !== undefined) filter.taskId = nonEmpty(input.taskId, 'taskId');
  const pending = workerResults(config, { readOnly: true }).list(filter);
  const store = new WorkbenchTransactionStore({
    runtimeRoot: config.workbenchRoot,
    viewPath: config.viewPath,
    historyRoot: config.historyRoot,
    readOnly: true,
  });
  const state = store.snapshot();
  const recovery = store.recoveryStatus();
  const records = pending.records.map((receipt) => {
    const activeTask = state.tasks?.[receipt.taskId] ?? null;
    const closureId = `close-${receipt.receiptId}`;
    const closure = state.operations?.[closureId];
    const closureTransaction = workbenchTransaction(config, closureId);
    const closureHistory = closureTransaction?.kind === 'closed' && closureTransaction.phase === 'completed'
      ? store.history(closureTransaction.completedAt.slice(0, 7)).records
        .find((record) => record.operationId === closureId) : null;
    const cancelled = closureHistory?.cancelledReceipt;
    const closedReceiptMatches = Boolean(!activeTask && closureTransaction?.kind === 'closed'
      && closureTransaction.phase === 'completed'
      && (!closure || (closure.inputDigest === closureTransaction.inputDigest
        && isDeepStrictEqual(closure.output, closureTransaction.output)
        && isDeepStrictEqual(closureHistory, closure.historyRecord)))
      && closureTransaction.output?.status === '已关闭'
      && closureTransaction.output.taskId === receipt.taskId
      && closureHistory?.taskId === receipt.taskId && closureHistory.status === '已关闭'
      && closureHistory.worker === closureTransaction.output.worker
      && (!receipt.workerThreadId || receipt.workerThreadId === closureHistory.worker)
      && closureHistory.completedAt === closureTransaction.completedAt
      && isDeepStrictEqual(cancelled, receipt)
    );
    const operationKind = receipt.businessState === '已完成' ? 'accept' : 'pause';
    const operationId = `${operationKind}-${receipt.receiptId}`;
    const operation = state.operations?.[operationId] ?? null;
    const transaction = operationKind === 'accept' ? workbenchTransaction(config, operationId) : null;
    const matchingHistory = transaction?.phase === 'completed' && typeof transaction.completedAt === 'string'
      ? store.history(transaction.completedAt.slice(0, 7)).records
        .filter((record) => record.operationId === operationId)
      : [];
    const historyRecord = matchingHistory.length === 1 ? matchingHistory[0] : null;
    // operations is a bounded cache. A naturally evicted acceptance remains
    // provable by its completed transaction and unique durable history entry.
    // If either cache index still names it, however, all cached evidence must agree.
    const acceptanceStillCached = Object.hasOwn(state.operations ?? {}, operationId)
      || (state.operationOrder ?? []).includes(operationId);
    const committedAcceptanceMatches = Boolean(transaction?.phase === 'completed'
      && transaction.operationId === operationId
      && transaction.output?.operationId === operationId
      && transaction.output.archived === true
      && typeof transaction.inputDigest === 'string' && /^[a-f0-9]{64}$/.test(transaction.inputDigest)
      && Number.isInteger(transaction.output.stateRevision)
      && transaction.output.stateRevision > 0 && transaction.output.stateRevision <= state.revision
      && (!acceptanceStillCached || (operation
        && operation.inputDigest === transaction.inputDigest
        && isDeepStrictEqual(operation.output, transaction.output)
        && isDeepStrictEqual(historyRecord, operation.historyRecord)))
      && historyRecord?.taskId === receipt.taskId
      && historyRecord.operationId === operationId
      && historyRecord.worker === transaction.output?.worker
      && typeof historyRecord.worker === 'string' && historyRecord.worker.length > 0
      && historyRecord.completedAt === transaction.completedAt
      && Number.isFinite(Date.parse(transaction.completedAt))
      && historyRecord.status === '已完成');
    const workerMatches = !receipt.workerThreadId
      || activeTask?.worker === receipt.workerThreadId
      || transaction?.output?.worker === receipt.workerThreadId;
    let disposition = 'review-active-task';
    let reason = 'active-task-and-pending-receipt';

    if (closedReceiptMatches) {
      return { ...receipt, activeStatus: null, registeredWorker: closureTransaction.output.worker,
        expectedOperationId: closureId, disposition: 'ack-committed-receipt',
        reason: 'owner-closed-task-with-preserved-receipt' };
    }
    if (transaction && transaction.phase !== 'completed') {
      disposition = 'preserve-conflict';
      reason = 'matching-workbench-transaction-incomplete';
    } else if (operationKind === 'accept' && committedAcceptanceMatches
      && (transaction.kind ?? 'accepted') === 'accepted'
      && transaction.output?.taskId === receipt.taskId
      && transaction.output?.status === '已完成'
      && !activeTask && workerMatches) {
      disposition = 'ack-committed-receipt';
      reason = 'matching-workbench-operation-committed';
    } else if (operationKind === 'pause'
      && operation?.output?.taskId === receipt.taskId
      && operation.output.status === '已暂停'
      && activeTask?.status === '已暂停' && workerMatches) {
      disposition = 'ack-committed-receipt';
      reason = 'matching-workbench-operation-committed';
    } else if (!activeTask) {
      disposition = 'preserve-conflict';
      reason = 'active-task-missing-without-committed-operation';
    } else if (!workerMatches) {
      disposition = 'preserve-conflict';
      reason = 'registered-worker-mismatch';
    } else if (operation || transaction) {
      disposition = 'preserve-conflict';
      reason = 'workbench-state-conflicts-with-receipt';
    }

    return {
      ...receipt,
      activeStatus: activeTask?.status ?? null,
      registeredWorker: activeTask?.worker ?? transaction?.output?.worker ?? null,
      expectedOperationId: operationId,
      disposition,
      reason,
    };
  });
  const counts = {
    reviewActiveTask: records.filter((record) => record.disposition === 'review-active-task').length,
    ackCommittedReceipt: records.filter((record) => record.disposition === 'ack-committed-receipt').length,
    preserveConflict: records.filter((record) => record.disposition === 'preserve-conflict').length,
  };
  return {
    projectId,
    stateRevision: state.revision,
    activeTaskCount: Object.keys(state.tasks ?? {}).length,
    pendingReceiptCount: records.length,
    counts,
    viewMatchesState: recovery.viewMatchesState,
    pendingTransactions: recovery.pendingTransactions,
    records,
  };
}

function execute(action, request, config) {
  if (action === 'workbench.register' && request.input?.execution?.kind === 'cli') {
    const input = object(request.input, 'CLI registration');
    projectIdentity(config).validateControlProject(nonEmpty(input.projectId, 'projectId'));
    if (input.execution.ownerThreadId !== config.ownerThreadId) throw new Error('CLI registered owner identity mismatch');
    const locator = new CliTaskStore({ controlRoot: config.controlRoot }).locator({ ...input, ownerThreadId: input.execution.ownerThreadId });
    if (!path.isAbsolute(input.execution.stateLocator ?? '') || path.resolve(input.execution.stateLocator) !== locator) throw new Error('CLI state locator identity mismatch');
    return workbench(config).registerTask(input);
  }
  if (action === 'workbench.accept-cli') {
    const input = object(request.input, 'CLI result acceptance');
    projectIdentity(config).validateControlProject(nonEmpty(input.projectId, 'projectId'));
    if (input.ownerThreadId !== config.ownerThreadId) throw new Error('CLI acceptance owner identity mismatch');
    return workbench(config).consumeAcceptedCliResult(input);
  }
  if (['workbench.update', 'workbench.pause'].includes(action)) {
    const task = activeWorkbenchTask(config, request.input?.taskId);
    if (task?.execution?.kind === 'cli') {
      projectIdentity(config).validateControlProject(request.input.projectId);
      if (request.input.ownerThreadId !== config.ownerThreadId || request.input.ownerThreadId !== task.execution.ownerThreadId || request.input.projectId !== task.projectId) throw new Error('CLI update owner/project identity mismatch');
    }
  }
  if (action === 'project.resolve') {
    const input = object(request.input, 'project identity input');
    const executionRoot = nonEmpty(config.executionRoot, 'runtime executionRoot');
    return projectIdentity(config).resolve({ ...input, cwd: executionRoot });
  }
  if (action === 'worker-result.enqueue') {
    const input = object(request.input, 'Worker result receipt');
    if (input.projectRoute !== undefined) {
      projectIdentity(config).validateWorkerRoute(input.projectId, input.projectRoute, { executionRoot: config.executionRoot });
    } else projectIdentity(config).validateSameRootProject(input.projectId, { executionRoot: config.executionRoot });
    validateReceiptTaskIdentity(config, input);
    return workerResults(config).enqueue(input);
  }
  if (action === 'worker-result.list') {
    const input = object(request.input, 'Worker result receipt filter');
    projectIdentity(config).validateControlProject(nonEmpty(input.projectId, 'projectId'));
    return workerResults(config).list(input);
  }
  if (action === 'workbench.inspect') return inspectWorkbench(config, request.input);
  if (action === 'worker-result.ack') return workerResults(config).acknowledge(object(request.input, 'Worker result receipt acknowledgement'));
  if (action === 'workbench.close') {
    const input = object(request.input, 'task closure');
    if ('cancelledReceipt' in input) throw new Error('cancelledReceipt is supplied only by the runtime');
    const projectId = nonEmpty(input.projectId, 'projectId');
    projectIdentity(config).validateControlProject(projectId);
    const active = activeWorkbenchTask(config, input.taskId);
    const prior = !active && typeof input.closedAt === 'string'
      ? workbench(config).history(input.closedAt.slice(0, 7)).records.find(record => record.operationId === input.operationId) : null;
    const cliTask = active?.execution?.kind === 'cli' ? active : prior?.execution?.kind === 'cli' ? prior : null;
    if (cliTask) {
      if (input.ownerThreadId !== config.ownerThreadId || input.ownerThreadId !== cliTask.execution.ownerThreadId || projectId !== cliTask.projectId) throw new Error('CLI closure owner identity mismatch');
      if (input.pendingReceiptId !== undefined) throw new Error('CLI closure does not use Worker pending');
      return workbench(config).closeTask({ ...input, execution: cliTask.execution });
    }
    const pending = workerResults(config).list({ projectId, taskId: nonEmpty(input.taskId, 'taskId') });
    if (input.pendingReceiptId !== undefined) {
      const receiptId = nonEmpty(input.pendingReceiptId, 'pendingReceiptId');
      if (input.operationId !== `close-${receiptId}`) throw new Error('pending closure operationId must be close-<receiptId>');
      // Preserve the actual result in the close transaction, never accept it as completed work.
      // After ack, a retry reconstructs the same input from durable history.
      const store = workbench(config);
      const saved = pending.count === 0 && typeof input.closedAt === 'string'
        ? store.history(input.closedAt.slice(0, 7)).records
          .find((record) => record.operationId === input.operationId && record.status === '已关闭')?.cancelledReceipt
        : null;
      const receipt = pending.records[0] ?? saved;
      if (!receipt || receipt.receiptId !== receiptId || receipt.projectId !== projectId
        || receipt.taskId !== input.taskId || receipt.sourceThreadId !== input.closedBy
        || (receipt.workerThreadId && receipt.workerThreadId !== input.worker)) {
        throw new Error('pending closure receipt identity mismatch');
      }
      return store.closeTask({ ...input, cancelledReceipt: receipt });
    }
    if (pending.count !== 0) throw new Error('task closure requires pendingReceiptId for explicit cancellation with a pending result');
    return workbench(config).closeTask(input);
  }
  const store = workbench(config);
  if (action === 'workbench.migrate') return store.startupStatus();
  if (action === 'workbench.register') return store.registerTask(object(request.input, 'task registration'));
  if (action === 'workbench.update') return store.updateTask(object(request.input, 'task update'));
  if (action === 'workbench.snapshot') return store.updateProjectSnapshot(object(request.input, 'project snapshot'));
  if (action === 'workbench.accept') return store.consumeAcceptedResult(object(request.input, 'Worker final acceptance'));
  if (action === 'workbench.recover') return store.recover();
  const input = object(request.input, 'pause acceptance');
  if (input.businessState !== '已暂停') {
    throw new Error('workbench.pause input.businessState must be 已暂停; this is a request field error, not a Worker final lookup failure');
  }
  if (input.status !== '已暂停') {
    throw new Error('workbench.pause input.status must be 已暂停 (in addition to businessState); this is a request field error, not a Worker final lookup failure. Use the task update fields operationId, taskId, expectedStatus, progress, pause, result and updatedAt (ISO timestamp)');
  }
  return store.updateTask(input);
}

export function executeRuntimeRequest(rawRequest, context) {
  const request = object(rawRequest, 'runtime request');
  if (request.schemaVersion !== 1) throw new Error('unsupported runtime request schema');
  const action = nonEmpty(request.action, 'action');
  if (!ACTIONS.has(action)) throw new Error(`unsupported runtime action: ${action}`);
  let requestId;
  if (request.requestId !== undefined) requestId = nonEmpty(request.requestId, 'requestId');
  else if (action.startsWith('worker-result.') || action === 'workbench.inspect') {
    const input = object(request.input, 'runtime request identity input');
    const identity = [input.projectId, input.receiptId ?? input.taskId ?? 'all'].filter(Boolean).join(':');
    requestId = `${action}:${nonEmpty(String(identity), 'Worker result request identity')}`;
  } else requestId = nonEmpty(request.requestId, 'requestId');
  const controlRoot = path.resolve(nonEmpty(context?.controlRoot, 'controlRoot'));
  return {
    schemaVersion: 1,
    requestId,
    action,
    ok: true,
    result: execute(action, request, roots(controlRoot, request, context?.executionRoot, context?.ownerThreadId ?? process.env.CODEX_THREAD_ID)),
  };
}

export const controlRuntimeActions = [...ACTIONS];
