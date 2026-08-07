'use strict';

const {
  OBSERVER_ROLE,
} = require('./browserTransactionAuthority');
const {
  RESOLUTION_STATUS,
  normalizeIdentity,
  resolveSemanticTarget,
} = require('./controllerSemanticResolver');
const {
  RECOVERY_ISSUE,
  createRecoveryDirective,
} = require('./controllerRecoveryDirectives');

const PROPOSAL_VERSION = 'qaai-controller-recovery-proposal-v1';

const PROPOSAL_KIND = Object.freeze({
  TARGET_REPAIR: 'TARGET_REPAIR',
  DISMISS_UNEXPECTED_UI: 'DISMISS_UNEXPECTED_UI',
  SWITCH_ADAPTER: 'SWITCH_ADAPTER',
  RESTORE_PREREQUISITE: 'RESTORE_PREREQUISITE',
  MANUAL_BOUNDARY: 'MANUAL_BOUNDARY',
});

const PROPOSAL_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  STALE: 'STALE',
});

const KIND_VALUES = new Set(Object.values(PROPOSAL_KIND));
const GENERIC_TARGET_WORDS = new Set([
  'button', 'control', 'field', 'input', 'link', 'menu', 'option', 'section',
  'tab', 'textbox', 'toggle',
]);

class ControllerRecoveryProposalError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerRecoveryProposalError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function factRefsOf(raw = {}) {
  return Object.freeze([
    ...new Set(
      (Array.isArray(raw.supportingFactRefs) ? raw.supportingFactRefs
        : Array.isArray(raw.factRefs) ? raw.factRefs
          : raw.factRef ? [raw.factRef]
            : [])
        .map(clean)
        .filter(Boolean),
    ),
  ]);
}

function semanticTokens(value) {
  return clean(value)
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !GENERIC_TARGET_WORDS.has(token));
}

function targetRepairPreservesAuthoredIntent(operation, proposedTarget) {
  const authored = normalizeIdentity(operation?.targetIdentity || {});
  const proposed = normalizeIdentity(proposedTarget || {});
  if (authored.role && proposed.role
    && authored.role.toLocaleLowerCase('en-US') !== proposed.role.toLocaleLowerCase('en-US')) {
    return false;
  }
  for (const field of ['form', 'section', 'controlType']) {
    if (authored[field] && proposed[field]
      && authored[field].toLocaleLowerCase('en-US') !== proposed[field].toLocaleLowerCase('en-US')) {
      return false;
    }
  }
  const authoredTokens = semanticTokens(authored.accessibleName);
  const proposedTokenList = semanticTokens(proposed.accessibleName);
  const proposedTokens = new Set(proposedTokenList);
  if (!authoredTokens.length) {
    return Boolean(authored.backendNodeId
      && proposed.backendNodeId
      && authored.backendNodeId === proposed.backendNodeId);
  }
  const sharedCount = authoredTokens.filter((token) => proposedTokens.has(token)).length;
  return sharedCount > 0
    && sharedCount / authoredTokens.length >= 0.5
    && sharedCount / Math.max(1, proposedTokenList.length) >= 0.75;
}

function normalizeAgentProposal(raw = {}, {
  role,
  operation,
  browserEpoch,
  now = Date.now(),
  ttlMs = 2_000,
} = {}) {
  if (![OBSERVER_ROLE.HEALER, OBSERVER_ROLE.CRITIC].includes(role)) {
    throw new ControllerRecoveryProposalError(
      'Recovery proposals are accepted only from Healer or Critic.',
      'CONTROLLER_RECOVERY_PROPOSAL_ROLE_INVALID',
      { role: role || null },
    );
  }
  const operationId = clean(operation?.operationId);
  const actionOccurrenceId = clean(operation?.actionOccurrenceId);
  const epoch = clean(browserEpoch);
  const proposalKind = clean(raw.proposalKind || raw.kind).toUpperCase() || (
    role === OBSERVER_ROLE.HEALER
      ? PROPOSAL_KIND.TARGET_REPAIR
      : PROPOSAL_KIND.DISMISS_UNEXPECTED_UI
  );
  if (!operationId || !actionOccurrenceId || !epoch || !KIND_VALUES.has(proposalKind)) {
    throw new ControllerRecoveryProposalError(
      'Recovery proposal requires operation scope, browser epoch, and canonical proposal kind.',
      'CONTROLLER_RECOVERY_PROPOSAL_INPUT_INVALID',
      { operationId: operationId || null, browserEpoch: epoch || null, proposalKind: proposalKind || null },
    );
  }
  const targetInput = raw.targetIdentity || raw.target || raw.proposedTarget || null;
  const targetIdentity = targetInput ? normalizeIdentity(targetInput) : null;
  const supportingFactRefs = factRefsOf(raw);
  if (!supportingFactRefs.length) {
    throw new ControllerRecoveryProposalError(
      'Recovery proposal requires supporting browser evidence.',
      'CONTROLLER_RECOVERY_PROPOSAL_EVIDENCE_REQUIRED',
      { operationId, role, proposalKind },
    );
  }
  const proposedActionInput = raw.proposedAction && typeof raw.proposedAction === 'object'
    ? raw.proposedAction
    : {};
  const proposedAction = Object.freeze({
    type: clean(proposedActionInput.type || raw.actionType) || null,
    targetIdentity,
    selection: proposedActionInput.selection || raw.selection || null,
    valueRef: clean(proposedActionInput.valueRef || raw.valueRef) || null,
  });
  const issuedAtMs = Number(now);
  const boundedTtlMs = Math.max(100, Math.min(10_000, Math.trunc(Number(ttlMs) || 2_000)));
  return Object.freeze({
    schemaVersion: PROPOSAL_VERSION,
    proposalId: clean(raw.proposalId) || `proposal:${role.toLowerCase()}:${operationId}:${issuedAtMs}`,
    role,
    kind: 'proposal',
    proposalKind,
    operationId,
    actionOccurrenceId,
    browserEpoch: epoch,
    issuedAtMs,
    expiresAtMs: issuedAtMs + boundedTtlMs,
    observedUnexpectedState: clean(raw.observedUnexpectedState || raw.observation || raw.reason) || null,
    proposedAction,
    supportingFactRefs,
    mayMutateBrowser: false,
    mayChangeVerdict: false,
    mayStopExecution: false,
  });
}

function normalizeHealerProposal(raw, context) {
  return normalizeAgentProposal(raw, { ...context, role: OBSERVER_ROLE.HEALER });
}

function normalizeCriticProposal(raw, context) {
  return normalizeAgentProposal(raw, { ...context, role: OBSERVER_ROLE.CRITIC });
}

function verifyRecoveryProposal({
  proposal,
  operation,
  browserEpoch,
  candidates = [],
  evidenceFactRefs = [],
  allowedProposalKinds = Object.values(PROPOSAL_KIND),
  now = Date.now(),
} = {}) {
  if (!proposal || proposal.schemaVersion !== PROPOSAL_VERSION || proposal.kind !== 'proposal') {
    throw new ControllerRecoveryProposalError(
      'Controller verification requires a typed recovery proposal.',
      'CONTROLLER_RECOVERY_PROPOSAL_REQUIRED',
    );
  }
  const operationId = clean(operation?.operationId);
  const epoch = clean(browserEpoch);
  if (proposal.operationId !== operationId
    || proposal.browserEpoch !== epoch
    || Number(now) > Number(proposal.expiresAtMs)) {
    return Object.freeze({
      schemaVersion: PROPOSAL_VERSION,
      status: PROPOSAL_STATUS.STALE,
      proposal,
      reason: proposal.operationId !== operationId
        ? 'proposal_operation_scope_stale'
        : proposal.browserEpoch !== epoch
          ? 'proposal_browser_epoch_stale'
          : 'proposal_expired',
      targetResolution: null,
    });
  }
  if (!allowedProposalKinds.includes(proposal.proposalKind)) {
    return Object.freeze({
      schemaVersion: PROPOSAL_VERSION,
      status: PROPOSAL_STATUS.REJECTED,
      proposal,
      reason: 'proposal_kind_not_allowed_for_operation',
      targetResolution: null,
    });
  }
  if (proposal.proposalKind === PROPOSAL_KIND.MANUAL_BOUNDARY) {
    return Object.freeze({
      schemaVersion: PROPOSAL_VERSION,
      status: PROPOSAL_STATUS.VERIFIED,
      proposal,
      reason: 'manual_boundary_proposal_verified',
      targetResolution: null,
    });
  }
  const availableFactRefs = new Set([
    ...(Array.isArray(evidenceFactRefs) ? evidenceFactRefs : []),
    ...(Array.isArray(candidates) ? candidates : []).flatMap((candidate) => (
      Array.isArray(candidate?.factRefs)
        ? candidate.factRefs
        : candidate?.factRef ? [candidate.factRef] : []
    )),
  ].map(clean).filter(Boolean));
  if (!proposal.supportingFactRefs.some((factRef) => availableFactRefs.has(clean(factRef)))) {
    return Object.freeze({
      schemaVersion: PROPOSAL_VERSION,
      status: PROPOSAL_STATUS.REJECTED,
      proposal,
      reason: 'proposal_supporting_evidence_not_in_current_snapshot',
      targetResolution: null,
    });
  }
  if (!proposal.proposedAction.targetIdentity) {
    return Object.freeze({
      schemaVersion: PROPOSAL_VERSION,
      status: PROPOSAL_STATUS.REJECTED,
      proposal,
      reason: 'proposal_target_identity_missing',
      targetResolution: null,
    });
  }
  if (proposal.proposalKind === PROPOSAL_KIND.TARGET_REPAIR
    && !targetRepairPreservesAuthoredIntent(operation, proposal.proposedAction.targetIdentity)) {
    return Object.freeze({
      schemaVersion: PROPOSAL_VERSION,
      status: PROPOSAL_STATUS.REJECTED,
      proposal,
      reason: 'proposal_changes_authored_target_identity',
      targetResolution: null,
    });
  }
  const targetResolution = resolveSemanticTarget({
    targetIdentity: proposal.proposedAction.targetIdentity,
    candidates,
    browserEpoch: epoch,
  });
  if (targetResolution.status !== RESOLUTION_STATUS.RESOLVED) {
    return Object.freeze({
      schemaVersion: PROPOSAL_VERSION,
      status: PROPOSAL_STATUS.REJECTED,
      proposal,
      reason: `proposal_target_${targetResolution.status.toLowerCase()}`,
      targetResolution,
    });
  }
  return Object.freeze({
    schemaVersion: PROPOSAL_VERSION,
    status: PROPOSAL_STATUS.VERIFIED,
    proposal,
    reason: 'proposal_semantically_verified',
    targetResolution,
    factRefs: Object.freeze([
      ...new Set([...proposal.supportingFactRefs, ...targetResolution.factRefs]),
    ]),
  });
}

function recoveryDirectiveFromVerifiedProposal({
  verifiedProposal,
  operation,
  attempt = 1,
  maxAttempts = 3,
} = {}) {
  if (verifiedProposal?.status !== PROPOSAL_STATUS.VERIFIED) {
    throw new ControllerRecoveryProposalError(
      'Only a controller-verified proposal may become a recovery directive.',
      'CONTROLLER_RECOVERY_PROPOSAL_NOT_VERIFIED',
    );
  }
  const issue = verifiedProposal.proposal.role === OBSERVER_ROLE.HEALER
    ? RECOVERY_ISSUE.TARGET_UNRESOLVED
    : verifiedProposal.proposal.proposalKind === PROPOSAL_KIND.MANUAL_BOUNDARY
      ? RECOVERY_ISSUE.MANUAL_CHALLENGE
      : RECOVERY_ISSUE.UNEXPECTED_BROWSER_STATE;
  return createRecoveryDirective({
    operation,
    issue,
    browserEpoch: verifiedProposal.proposal.browserEpoch,
    attempt,
    maxAttempts,
    reason: verifiedProposal.reason,
    proposal: verifiedProposal.proposal,
  });
}

module.exports = {
  PROPOSAL_VERSION,
  PROPOSAL_KIND,
  PROPOSAL_STATUS,
  ControllerRecoveryProposalError,
  normalizeAgentProposal,
  normalizeHealerProposal,
  normalizeCriticProposal,
  verifyRecoveryProposal,
  recoveryDirectiveFromVerifiedProposal,
  semanticTokens,
  targetRepairPreservesAuthoredIntent,
};
