import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
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

function workerResults(config) {
  return new WorkerResultReceiptStore({ runtimeRoot: config.workerResultRoot });
}

function projectIdentity(config) {
  return new ProjectIdentityProvider({
    controlRoot: config.controlRoot,
    runtimeRoot: config.projectIdentityRoot,
  });
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
  else if (action.startsWith('worker-result.')) {
    const input = object(request.input, 'Worker result request input');
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
