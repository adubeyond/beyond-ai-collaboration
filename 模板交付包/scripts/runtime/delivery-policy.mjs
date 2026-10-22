// Delivery metadata extends the existing task/receipt lifecycle. It neither
// authenticates a user's authorization nor starts, wakes or resumes any actor.
import { isDeepStrictEqual } from 'node:util';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const id = value => typeof value === 'string' && ID.test(value)
  && !Object.hasOwn(Object.prototype, value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const unique = values => new Set(values).size === values.length;
const consumerKey = item => JSON.stringify([item?.taskId, item?.contractLocator]);

export function validateDeliveryContract(task) {
  if (!Object.hasOwn(task, 'deliveryContract')) return;
  const contract = task.deliveryContract;
  const owner = task.execution?.kind === 'cli' ? task.execution.ownerThreadId : task.worker;
  if (!object(contract) || contract.schemaVersion !== 1 || !id(task.projectId)
    || !text(contract.outcome) || !text(contract.requirementsLocator) || !text(contract.designLocator)
    || (Object.hasOwn(contract, 'designRevision') && !text(contract.designRevision))
    || contract.resultOwnerThreadId !== owner || !id(contract.acceptanceOwnerThreadId)
    || !Array.isArray(contract.scope) || !contract.scope.length || !contract.scope.every(text)
    || !Array.isArray(contract.outOfScope) || !contract.outOfScope.every(text)) {
    throw new Error('invalid delivery contract or result owner');
  }
  if (task.execution?.kind === 'cli' && contract.acceptanceOwnerThreadId !== owner) {
    throw new Error('CLI delivery acceptance must use its existing owner review');
  }
  if (task.execution?.kind !== 'cli' && contract.acceptanceOwnerThreadId === owner) {
    throw new Error('formal desktop delivery cannot use its executor as acceptance owner');
  }
  if (!object(contract.authorization)
    || !['user-message', 'approved-plan'].includes(contract.authorization.source)
    || !text(contract.authorization.locator)) {
    throw new Error('delivery contract requires a traceable authorization source, not an authorized boolean');
  }
  if (!Array.isArray(contract.criteria) || !contract.criteria.length
    || contract.criteria.some(item => !object(item) || !id(item.id) || !text(item.expected))
    || !unique(contract.criteria.map(item => item.id))) {
    throw new Error('delivery criteria must be nonempty and uniquely identified');
  }
  if (Object.hasOwn(contract, 'providedContracts')
    && (!Array.isArray(contract.providedContracts) || !contract.providedContracts.length
      || contract.providedContracts.some(item => !object(item) || !text(item.contractLocator)
        || (Object.hasOwn(item, 'contractRevision') && !text(item.contractRevision)))
      || !unique(contract.providedContracts.map(item => item.contractLocator)))) {
    throw new Error('invalid provided delivery contracts');
  }
  // Only final-acceptance dependencies belong here. Reading a stable interface
  // or integrating a verified partial artifact never requires producer closure.
  if (!Array.isArray(contract.consumes)
    || contract.consumes.some(item => !object(item) || !id(item.taskId)
      || item.taskId === task.taskId || !text(item.contractLocator)
      || (Object.hasOwn(item, 'contractRevision') && !text(item.contractRevision)))
    || !unique(contract.consumes.map(consumerKey))) {
    throw new Error('invalid delivery consumer inputs');
  }
}

export function validateDeliveryAcceptance(task, input, committedResult) {
  if (!Object.hasOwn(task, 'deliveryContract')) return;
  validateDeliveryContract(task);
  const contract = task.deliveryContract, evidence = input.deliveryEvidence;
  if (!isDeepStrictEqual(input.expectedDeliveryContract, contract)) {
    throw new Error('delivery acceptance contract changed; reread the agreed contract before review');
  }
  if (input.acceptedBy !== contract.acceptanceOwnerThreadId) {
    throw new Error('delivery acceptance owner mismatch');
  }
  if (!object(evidence) || !Array.isArray(evidence.criteria)
    || evidence.criteria.length !== contract.criteria.length
    || evidence.criteria.some(item => !object(item) || !id(item.id)
      || !text(item.observed) || !text(item.evidenceLocator))
    || !unique(evidence.criteria.map(item => item.id))
    || contract.criteria.some(item => !evidence.criteria.some(actual => actual.id === item.id))) {
    throw new Error('delivery acceptance requires observed evidence for every agreed criterion');
  }
  if (!Array.isArray(evidence.consumedResults)
    || evidence.consumedResults.length !== contract.consumes.length
    || !unique(evidence.consumedResults.map(consumerKey))) {
    throw new Error('delivery acceptance requires the exact consumed result set');
  }
  const producerSnapshots = new Map();
  for (const dependency of contract.consumes) {
    const consumed = evidence.consumedResults.find(item => consumerKey(item) === consumerKey(dependency));
    if (!object(consumed) || !id(consumed.operationId)
      || consumed.contractLocator !== dependency.contractLocator
      || consumed.contractRevision !== dependency.contractRevision || !text(consumed.resultLocator)) {
      throw new Error('delivery consumed contract or result identity mismatch');
    }
    const snapshot = producerSnapshots.get(dependency.taskId);
    if (snapshot && (snapshot.operationId !== consumed.operationId || snapshot.resultLocator !== consumed.resultLocator)) {
      throw new Error('multiple interfaces must use the same accepted producer snapshot');
    }
    producerSnapshots.set(dependency.taskId, consumed);
    const accepted = committedResult(consumed.operationId);
    if (!accepted || accepted.taskId !== dependency.taskId || accepted.projectId !== task.projectId
      || accepted.status !== '已完成' || accepted.result !== consumed.resultLocator) {
      throw new Error('delivery input is not a committed accepted result in this project');
    }
    // Compare against the immutable accepted producer snapshot, not a current
    // task or two mutually agreeing consumer strings. Optional revisions must
    // agree on all three sides; missing revision is not proof of a requested one.
    const provided = accepted.deliveryContract?.providedContracts ?? [{
      contractLocator: accepted.deliveryContract?.designLocator,
      contractRevision: accepted.deliveryContract?.designRevision,
    }];
    if (!provided.some(item => item.contractLocator === dependency.contractLocator
      && item.contractRevision === dependency.contractRevision)) {
      throw new Error('delivery consumed contract does not match the accepted producer contract identity');
    }
  }
  if (contract.consumes.length && !text(evidence.integrationEvidenceLocator)) {
    throw new Error('delivery composition requires integration evidence; component completion alone is insufficient');
  }
}

export function planDeliveryContinuation(state, previous, nextTaskId) {
  const next = state.tasks[nextTaskId];
  const reasons = [];
  if (!previous || previous.status !== '已完成') reasons.push('previous-goal-not-accepted');
  else if (!previous.deliveryContract) reasons.push('previous-goal-machine-evidence-missing');
  if (!next?.deliveryContract) reasons.push('next-goal-not-registered-with-contract');
  if (next?.deliveryContract) {
    validateDeliveryContract(next);
    if (previous?.projectId !== undefined && previous.projectId !== next.projectId) reasons.push('project-mismatch');
  }
  if (state.projectSnapshot?.status === '已暂停') reasons.push('project-paused');
  if (state.projectSnapshot?.status === '已完成') reasons.push('project-marked-completed');
  if (next && next.status !== '进行中') reasons.push('next-goal-paused');
  return {
    disposition: reasons.length ? 'held' : 'ready-for-owner-review',
    reasons,
    nextTaskId,
    nextOwnerThreadId: next?.deliveryContract?.resultOwnerThreadId ?? null,
    authorizationSource: next?.deliveryContract?.authorization ?? null,
    requiresAuthorityCheck: true,
    dispatch: false,
  };
}
