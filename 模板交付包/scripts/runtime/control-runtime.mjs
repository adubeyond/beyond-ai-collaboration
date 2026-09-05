import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ProjectIdentityProvider } from './project-identity-provider.mjs';
import { WorkerResultReceiptStore } from './worker-result-receipts.mjs';
import { WorkbenchTransactionStore } from './workbench-transaction.mjs';

const ACTIONS = new Set([
  'project.resolve',
  'workbench.migrate',
  'workbench.register',
  'workbench.update',
  'workbench.pause',
  'workbench.snapshot',
  'workbench.inspect',
  'workbench.accept',
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

function roots(controlRoot, request, executionRoot) {
  const localRuntime = path.join(controlRoot, 'local', 'runtime');
  const codexHome = path.resolve(request.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  return {
    controlRoot,
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
    const operationKind = receipt.businessState === '已完成' ? 'accept' : 'pause';
    const operationId = `${operationKind}-${receipt.receiptId}`;
    const operation = state.operations?.[operationId] ?? null;
    const transaction = operationKind === 'accept' ? workbenchTransaction(config, operationId) : null;
    const historyRecord = transaction?.phase === 'completed' && typeof transaction.completedAt === 'string'
      ? store.history(transaction.completedAt.slice(0, 7)).records
        .find((record) => record.operationId === operationId) ?? null
      : null;
    const committedAcceptanceMatches = Boolean(operation && transaction?.phase === 'completed'
      && operation.inputDigest === transaction.inputDigest
      && JSON.stringify(operation.output) === JSON.stringify(transaction.output)
      && isDeepStrictEqual(historyRecord, operation.historyRecord)
      && historyRecord?.taskId === receipt.taskId
      && historyRecord.worker === transaction.output?.worker
      && historyRecord.status === '已完成');
    const workerMatches = !receipt.workerThreadId
      || activeTask?.worker === receipt.workerThreadId
      || transaction?.output?.worker === receipt.workerThreadId;
    let disposition = 'review-active-task';
    let reason = 'active-task-and-pending-receipt';

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
    const projectId = nonEmpty(input.projectId, 'projectId');
    projectIdentity(config).validateControlProject(projectId);
    const pending = workerResults(config).list({ projectId, taskId: nonEmpty(input.taskId, 'taskId') });
    if (pending.count !== 0) throw new Error('task closure requires zero pending Worker result receipts');
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
  if (input.businessState !== '已暂停' || input.status !== '已暂停') {
    throw new Error('pause action requires a paused Worker final');
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
    result: execute(action, request, roots(controlRoot, request, context?.executionRoot)),
  };
}

export const controlRuntimeActions = [...ACTIONS];
