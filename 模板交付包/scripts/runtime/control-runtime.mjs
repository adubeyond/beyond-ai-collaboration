import os from 'node:os';
import path from 'node:path';
import { ProjectIdentityProvider } from './project-identity-provider.mjs';
import { WorkbenchTransactionStore } from './workbench-transaction.mjs';

const ACTIONS = new Set([
  'project.resolve',
  'workbench.migrate',
  'workbench.register',
  'workbench.update',
  'workbench.pause',
  'workbench.snapshot',
  'workbench.accept',
  'workbench.recover',
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function roots(controlRoot, request) {
  const localRuntime = path.join(controlRoot, 'local', 'runtime');
  const codexHome = path.resolve(request.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  return {
    controlRoot,
    codexHome,
    projectIdentityRoot: path.join(localRuntime, 'project-identity'),
    workbenchRoot: path.join(localRuntime, 'workbench'),
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

function execute(action, request, config) {
  if (action === 'project.resolve') {
    return new ProjectIdentityProvider({
      controlRoot: config.controlRoot,
      runtimeRoot: config.projectIdentityRoot,
    }).resolve(object(request.input, 'project identity input'));
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
  const requestId = nonEmpty(request.requestId, 'requestId');
  const action = nonEmpty(request.action, 'action');
  if (!ACTIONS.has(action)) throw new Error(`unsupported runtime action: ${action}`);
  const controlRoot = path.resolve(nonEmpty(context?.controlRoot, 'controlRoot'));
  return { schemaVersion: 1, requestId, action, ok: true, result: execute(action, request, roots(controlRoot, request)) };
}

export const controlRuntimeActions = [...ACTIONS];
