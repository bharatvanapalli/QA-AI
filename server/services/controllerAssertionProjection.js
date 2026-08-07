'use strict';

const {
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
  createTerminalDecision,
} = require('./browserTransactionContract');

const ASSERTION_PROJECTION_VERSION = 'qaai-controller-assertion-projection-v1';

const EXACT_ASSERTION_ACTIONS = Object.freeze({
  AssertValue: new Set(['Fill', 'Type', 'Clear', 'Select', 'Date', 'DateTime', 'Time']),
  AssertText: new Set(['Fill', 'Type', 'Clear', 'Select', 'Date', 'DateTime', 'Time']),
  AssertSelected: new Set(['Select']),
  AssertDate: new Set(['Date', 'DateTime']),
  AssertTime: new Set(['Time', 'DateTime', 'Select']),
});

const EXACT_PROOF_REF_BY_ACTION = Object.freeze({
  Fill: /controller-dom-readback:text-input/i,
  Type: /controller-dom-readback:text-input/i,
  Clear: /controller-dom-readback:text-input/i,
  Select: /controller-selection-owner-readback/i,
  Date: /controller-dom-readback/i,
  DateTime: /controller-dom-readback/i,
  Time: /controller-dom-readback|controller-selection-owner-readback/i,
});

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function token(value) {
  return clean(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function targetName(identity = {}) {
  return clean(identity.accessibleName || identity.label || identity.name);
}

function sameScalar(left, right) {
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return left === right;
  }
  if (typeof left === 'number' || typeof right === 'number') {
    return Number.isFinite(Number(left))
      && Number.isFinite(Number(right))
      && Number(left) === Number(right);
  }
  return clean(left).normalize('NFKC') === clean(right).normalize('NFKC');
}

function sameContextValue(left, right) {
  const leftToken = token(left);
  const rightToken = token(right);
  if (!leftToken && !rightToken) return true;
  return Boolean(leftToken && rightToken && leftToken === rightToken);
}

function compatibleContextValue(left, right) {
  const leftToken = token(left);
  const rightToken = token(right);
  return !leftToken || !rightToken || leftToken === rightToken;
}

function sameFramePath(left, right) {
  const leftPath = Array.isArray(left) ? left.map(token).filter(Boolean) : [];
  const rightPath = Array.isArray(right) ? right.map(token).filter(Boolean) : [];
  if (!leftPath.length && !rightPath.length) return true;
  return leftPath.length === rightPath.length
    && leftPath.every((part, index) => part === rightPath[index]);
}

function compatibleFramePath(left, right) {
  const leftPath = Array.isArray(left) ? left.map(token).filter(Boolean) : [];
  const rightPath = Array.isArray(right) ? right.map(token).filter(Boolean) : [];
  return !leftPath.length || !rightPath.length || (
    leftPath.length === rightPath.length
      && leftPath.every((part, index) => part === rightPath[index])
  );
}

function explicitlyLinksAssertionToAction(assertion, action) {
  const sourceStepRef = clean(assertion?.sourceStepRef);
  if (sourceStepRef) return sourceStepRef === clean(action?.authoredStepId);
  const dependencies = new Set(
    (Array.isArray(assertion?.dependencies) ? assertion.dependencies : [])
      .map(clean)
      .filter(Boolean),
  );
  return dependencies.has(clean(action?.operationId))
    || dependencies.has(clean(action?.authoredStepId));
}

function exactTargetAliasMatch(assertion, action) {
  const assertionAliases = new Set(
    (Array.isArray(assertion?.targetAliases) ? assertion.targetAliases : [])
      .map(token)
      .filter(Boolean),
  );
  return (Array.isArray(action?.targetAliases) ? action.targetAliases : [])
    .map(token)
    .filter(Boolean)
    .some((alias) => assertionAliases.has(alias));
}

function exactSemanticTargetMatch(assertion, action) {
  const assertionIdentity = assertion?.targetIdentity || {};
  const actionIdentity = action?.targetIdentity || {};
  const assertionName = token(targetName(assertionIdentity));
  const actionName = token(targetName(actionIdentity));
  if (!assertionName || !actionName) return false;
  const exactName = assertionName === actionName;
  const protectedPasswordDescription = passwordTarget(action)
    && explicitlyLinksAssertionToAction(assertion, action)
    && (
      assertionName.includes(actionName)
      || exactTargetAliasMatch(assertion, action)
    );
  if (!exactName && !protectedPasswordDescription) return false;

  for (const field of ['role', 'controlType', 'section', 'form']) {
    const matched = protectedPasswordDescription
      ? compatibleContextValue(assertionIdentity[field], actionIdentity[field])
      : sameContextValue(assertionIdentity[field], actionIdentity[field]);
    if (!matched) return false;
  }
  if (protectedPasswordDescription) {
    if (!compatibleFramePath(assertionIdentity.framePath, actionIdentity.framePath)) return false;
  } else if (!sameFramePath(assertionIdentity.framePath, actionIdentity.framePath)) return false;

  const assertionBackendNodeId = clean(assertionIdentity.backendNodeId);
  const actionBackendNodeId = clean(actionIdentity.backendNodeId);
  if (
    assertionBackendNodeId
    && actionBackendNodeId
    && assertionBackendNodeId !== actionBackendNodeId
  ) return false;
  return true;
}

function assertionExpected(assertion) {
  const verify = assertion?.verify;
  if (verify && typeof verify === 'object') {
    for (const field of ['expected', 'value', 'text', 'selectedValue']) {
      if (Object.prototype.hasOwnProperty.call(verify, field)) return verify[field];
    }
  }
  const payload = assertion?.payload;
  if (payload && typeof payload === 'object') {
    for (const field of ['expected', 'value', 'text', 'selectedValue']) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) return payload[field];
    }
  }
  if (assertion && Object.prototype.hasOwnProperty.call(assertion, 'expected')) {
    return assertion.expected;
  }
  return undefined;
}

function operationCheckExpected(action) {
  const operationCheck = action?.operationCheck;
  if (!operationCheck || typeof operationCheck !== 'object') return undefined;
  const candidates = [
    operationCheck.condition?.value,
    operationCheck.condition?.expected,
    operationCheck.expected?.value,
    operationCheck.expected,
    operationCheck.value,
  ];
  return candidates.find((value) => value !== undefined);
}

function actionCommittedValue(action) {
  if (action?.type === 'Select') {
    return action.selection?.value
      ?? action.selection?.label
      ?? action.selection?.text
      ?? action.value;
  }
  return action?.value;
}

function passwordTarget(action) {
  const identity = action?.targetIdentity || {};
  return ['password', 'secret'].includes(token(
    identity.controlType || identity.inputType || identity.type,
  )) || /\b(?:password|passcode|secret)\b/i.test(targetName(identity));
}

function protectedPasswordAssertion(assertion, action) {
  if (assertion?.type !== 'AssertText' || !passwordTarget(action)) return false;
  const expected = assertion?.expected;
  if (expected == null) return false;
  return /\b(?:populated|non empty|nonempty|masked|protected|value present|entered)\b/i
    .test(clean(typeof expected === 'object'
      ? expected.kind || expected.state || expected.effect
      : expected));
}

function exactExpectedMatch(assertion, action) {
  if (passwordTarget(action)) {
    // Secure controls are projected only from explicit protected-state
    // semantics. Never inspect or compare verify.text/action plaintext.
    return protectedPasswordAssertion(assertion, action);
  }
  const expected = assertionExpected(assertion);
  const actual = actionCommittedValue(action);
  const checkExpected = operationCheckExpected(action);
  if (expected !== undefined) {
    return actual !== undefined && sameScalar(expected, actual);
  }
  return checkExpected !== undefined
    && actual !== undefined
    && sameScalar(checkExpected, actual);
}

function exactCommittedProof(action, decision) {
  if (decision?.state !== CONTROLLER_STATE.COMMITTED) return false;
  if (passwordTarget(action)) {
    return /^matched:protected-(?:ack|input-event)$/i.test(clean(decision.reason))
      && Array.isArray(decision.proofRefs)
      && decision.proofRefs.length > 0;
  }
  const matcher = EXACT_PROOF_REF_BY_ACTION[action?.type];
  if (!matcher) return false;
  const proofRefs = Array.isArray(decision.proofRefs) ? decision.proofRefs : [];
  return proofRefs.some((proofRef) => matcher.test(clean(proofRef)));
}

function actionSupportsAssertion(action, assertion) {
  return EXACT_ASSERTION_ACTIONS[assertion?.type]?.has(action?.type) === true;
}

function operationOrder(operationContract) {
  return (Array.isArray(operationContract?.operations)
    ? operationContract.operations
    : [])
    .slice()
    .sort((left, right) => Number(left?.ordinal || 0) - Number(right?.ordinal || 0));
}

function candidateActions({
  assertion,
  operationContract,
  priorOperationResults,
}) {
  const ordered = operationOrder(operationContract);
  const assertionIndex = ordered.findIndex((operation) => (
    operation?.operationId === assertion?.operationId
  ));
  const resultByOperationId = new Map(
    (Array.isArray(priorOperationResults) ? priorOperationResults : [])
      .map((result) => [result?.operationId, result?.terminalDecision]),
  );
  const actions = ordered.filter((operation, index) => (
    index < assertionIndex
      && operation?.kind === 'action'
      && resultByOperationId.has(operation.operationId)
  ));

  const sourceStepRef = clean(assertion?.sourceStepRef);
  if (sourceStepRef) {
    return actions.filter((action) => clean(action.authoredStepId) === sourceStepRef);
  }

  const dependencies = new Set(
    (Array.isArray(assertion?.dependencies) ? assertion.dependencies : [])
      .map(clean)
      .filter(Boolean),
  );
  if (dependencies.size) {
    return actions.filter((action) => (
      dependencies.has(clean(action.operationId))
        || dependencies.has(clean(action.authoredStepId))
    ));
  }

  const immediatelyPrevious = assertionIndex > 0 ? ordered[assertionIndex - 1] : null;
  return immediatelyPrevious?.kind === 'action'
    && resultByOperationId.has(immediatelyPrevious.operationId)
    ? [immediatelyPrevious]
    : [];
}

function projectAssertionDecision({
  assertion,
  decision,
  operationContract,
  priorOperationResults,
} = {}) {
  if (assertion?.kind !== 'assertion' || !decision) {
    return Object.freeze({
      projected: false,
      reason: 'assertion_projection_not_applicable',
      terminalDecision: decision || null,
    });
  }
  if (decision.state === CONTROLLER_STATE.COMMITTED) {
    return Object.freeze({
      projected: false,
      reason: 'fresh_browser_assertion_already_matched',
      terminalDecision: decision,
    });
  }
  if (
    decision.state === CONTROLLER_STATE.MANUAL_BOUNDARY
    || decision.state === CONTROLLER_STATE.CANCELLED
    || decision.continuation?.terminationReason
  ) {
    return Object.freeze({
      projected: false,
      reason: 'assertion_projection_forbidden_for_terminal_boundary',
      terminalDecision: decision,
    });
  }

  const resultByOperationId = new Map(
    (Array.isArray(priorOperationResults) ? priorOperationResults : [])
      .map((result) => [result?.operationId, result?.terminalDecision]),
  );
  const exactAction = candidateActions({
    assertion,
    operationContract,
    priorOperationResults,
  }).find((action) => {
    const actionDecision = resultByOperationId.get(action.operationId);
    return actionSupportsAssertion(action, assertion)
      && exactSemanticTargetMatch(assertion, action)
      && exactExpectedMatch(assertion, action)
      && exactCommittedProof(action, actionDecision);
  });

  if (!exactAction) {
    return Object.freeze({
      projected: false,
      reason: 'no_exact_committed_action_evidence',
      terminalDecision: decision,
    });
  }

  const actionDecision = resultByOperationId.get(exactAction.operationId);
  const terminalDecision = createTerminalDecision({
    operationId: assertion.operationId,
    actionOccurrenceId: assertion.actionOccurrenceId,
    operationKind: assertion.kind,
    state: CONTROLLER_STATE.COMMITTED,
    commitDisposition: COMMIT_DISPOSITION.ALREADY_SATISFIED,
    reason: 'assertion_matched_by_exact_committed_action_evidence',
    proofRefs: actionDecision.proofRefs,
  });
  return Object.freeze({
    schemaVersion: ASSERTION_PROJECTION_VERSION,
    projected: true,
    reason: terminalDecision.reason,
    evidenceOperationId: exactAction.operationId,
    replacedFreshDecisionState: decision.state,
    terminalDecision,
  });
}

module.exports = {
  ASSERTION_PROJECTION_VERSION,
  exactSemanticTargetMatch,
  exactExpectedMatch,
  exactCommittedProof,
  explicitlyLinksAssertionToAction,
  projectAssertionDecision,
};
