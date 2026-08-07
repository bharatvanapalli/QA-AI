'use strict';

const {
  CONTROLLER_CAPABILITY,
  assertControllerAuthority,
} = require('./browserTransactionAuthority');

const RECOVERY_VERSION = 'qaai-controller-recovery-directive-v1';

const RECOVERY_ISSUE = Object.freeze({
  SNAPSHOT_TRANSIENT_EMPTY: 'SNAPSHOT_TRANSIENT_EMPTY',
  SNAPSHOT_CAPTURE_FAILED: 'SNAPSHOT_CAPTURE_FAILED',
  SNAPSHOT_STALE: 'SNAPSHOT_STALE',
  TARGET_STALE: 'TARGET_STALE',
  TARGET_UNRESOLVED: 'TARGET_UNRESOLVED',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  WRONG_ADAPTER: 'WRONG_ADAPTER',
  PREREQUISITE_ERASED: 'PREREQUISITE_ERASED',
  POPUP_LOST: 'POPUP_LOST',
  UNEXPECTED_BROWSER_STATE: 'UNEXPECTED_BROWSER_STATE',
  DELIVERY_UNCERTAIN: 'DELIVERY_UNCERTAIN',
  EVIDENCE_UNKNOWN: 'EVIDENCE_UNKNOWN',
  POSITIVE_NON_DELIVERY: 'POSITIVE_NON_DELIVERY',
  SESSION_LOST: 'SESSION_LOST',
  MANUAL_CHALLENGE: 'MANUAL_CHALLENGE',
});

const RECOVERY_DIRECTIVE = Object.freeze({
  REFRESH_SNAPSHOT: 'REFRESH_SNAPSHOT',
  RERESOLVE_SAME_TARGET: 'RERESOLVE_SAME_TARGET',
  CORRECT_ADAPTER: 'CORRECT_ADAPTER',
  RESTORE_PREREQUISITE_VALUE: 'RESTORE_PREREQUISITE_VALUE',
  REOPEN_ASSOCIATED_POPUP: 'REOPEN_ASSOCIATED_POPUP',
  REQUEST_HEALER_PROPOSAL: 'REQUEST_HEALER_PROPOSAL',
  REQUEST_CRITIC_PROPOSAL: 'REQUEST_CRITIC_PROPOSAL',
  ACCEPT_VERIFIED_TARGET: 'ACCEPT_VERIFIED_TARGET',
  APPLY_VERIFIED_PROPOSAL: 'APPLY_VERIFIED_PROPOSAL',
  OBSERVE_ONLY: 'OBSERVE_ONLY',
  RECOVER_SESSION: 'RECOVER_SESSION',
  PAUSE_MANUAL_BOUNDARY: 'PAUSE_MANUAL_BOUNDARY',
  TERMINATE_REQUIRED_MUTATION: 'TERMINATE_REQUIRED_MUTATION',
});

const MUTATING_DIRECTIVES = new Set([
  RECOVERY_DIRECTIVE.RESTORE_PREREQUISITE_VALUE,
  RECOVERY_DIRECTIVE.REOPEN_ASSOCIATED_POPUP,
  RECOVERY_DIRECTIVE.APPLY_VERIFIED_PROPOSAL,
]);

const ISSUE_VALUES = new Set(Object.values(RECOVERY_ISSUE));
const DIRECTIVE_VALUES = new Set(Object.values(RECOVERY_DIRECTIVE));
const authorizedDirectives = new WeakSet();

class ControllerRecoveryDirectiveError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerRecoveryDirectiveError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function directiveForIssue(issue) {
  switch (issue) {
    case RECOVERY_ISSUE.SNAPSHOT_TRANSIENT_EMPTY:
    case RECOVERY_ISSUE.SNAPSHOT_CAPTURE_FAILED:
      return RECOVERY_DIRECTIVE.REFRESH_SNAPSHOT;
    case RECOVERY_ISSUE.SNAPSHOT_STALE:
    case RECOVERY_ISSUE.TARGET_STALE:
      return RECOVERY_DIRECTIVE.RERESOLVE_SAME_TARGET;
    case RECOVERY_ISSUE.TARGET_UNRESOLVED:
    case RECOVERY_ISSUE.TARGET_AMBIGUOUS:
      return RECOVERY_DIRECTIVE.REQUEST_HEALER_PROPOSAL;
    case RECOVERY_ISSUE.WRONG_ADAPTER:
      return RECOVERY_DIRECTIVE.CORRECT_ADAPTER;
    case RECOVERY_ISSUE.PREREQUISITE_ERASED:
      return RECOVERY_DIRECTIVE.RESTORE_PREREQUISITE_VALUE;
    case RECOVERY_ISSUE.POPUP_LOST:
      return RECOVERY_DIRECTIVE.REOPEN_ASSOCIATED_POPUP;
    case RECOVERY_ISSUE.UNEXPECTED_BROWSER_STATE:
      return RECOVERY_DIRECTIVE.REQUEST_CRITIC_PROPOSAL;
    case RECOVERY_ISSUE.DELIVERY_UNCERTAIN:
    case RECOVERY_ISSUE.EVIDENCE_UNKNOWN:
      return RECOVERY_DIRECTIVE.OBSERVE_ONLY;
    case RECOVERY_ISSUE.POSITIVE_NON_DELIVERY:
      return RECOVERY_DIRECTIVE.TERMINATE_REQUIRED_MUTATION;
    case RECOVERY_ISSUE.SESSION_LOST:
      return RECOVERY_DIRECTIVE.RECOVER_SESSION;
    case RECOVERY_ISSUE.MANUAL_CHALLENGE:
      return RECOVERY_DIRECTIVE.PAUSE_MANUAL_BOUNDARY;
    default:
      return null;
  }
}

function createRecoveryDirective({
  operation,
  issue,
  browserEpoch = null,
  attempt = 1,
  maxAttempts = 3,
  reason = null,
  proposal = null,
} = {}) {
  const operationId = clean(operation?.operationId);
  const actionOccurrenceId = clean(operation?.actionOccurrenceId);
  const normalizedIssue = clean(issue).toUpperCase();
  if (!operationId || !actionOccurrenceId || !ISSUE_VALUES.has(normalizedIssue)) {
    throw new ControllerRecoveryDirectiveError(
      'Recovery directive requires operation identity and a canonical issue.',
      'CONTROLLER_RECOVERY_INPUT_INVALID',
      { operationId: operationId || null, actionOccurrenceId: actionOccurrenceId || null, issue: normalizedIssue || null },
    );
  }
  const ordinal = Math.max(1, Math.trunc(Number(attempt) || 1));
  const budget = Math.max(1, Math.min(10, Math.trunc(Number(maxAttempts) || 3)));
  if (ordinal > budget) {
    throw new ControllerRecoveryDirectiveError(
      'Recovery directive budget is exhausted.',
      'CONTROLLER_RECOVERY_BUDGET_EXHAUSTED',
      { operationId, attempt: ordinal, maxAttempts: budget },
    );
  }
  const directive = proposal && normalizedIssue !== RECOVERY_ISSUE.MANUAL_CHALLENGE
    ? clean(proposal.proposalKind).toUpperCase() === 'TARGET_REPAIR'
      ? RECOVERY_DIRECTIVE.ACCEPT_VERIFIED_TARGET
      : RECOVERY_DIRECTIVE.APPLY_VERIFIED_PROPOSAL
    : directiveForIssue(normalizedIssue);
  if (!DIRECTIVE_VALUES.has(directive)) {
    throw new ControllerRecoveryDirectiveError(
      'No deterministic recovery directive exists for this issue.',
      'CONTROLLER_RECOVERY_DIRECTIVE_UNAVAILABLE',
      { operationId, issue: normalizedIssue },
    );
  }
  const mayMutateBrowser = MUTATING_DIRECTIVES.has(directive);
  return Object.freeze({
    schemaVersion: RECOVERY_VERSION,
    directiveId: `recovery:${operationId}:${directive}:${ordinal}`,
    operationId,
    actionOccurrenceId,
    issue: normalizedIssue,
    directive,
    browserEpoch: clean(browserEpoch) || null,
    attempt: ordinal,
    maxAttempts: budget,
    reason: clean(reason) || null,
    proposal,
    mayMutateBrowser,
    mayRedispatchOriginalOccurrence: false,
    requiresNewOccurrence: mayMutateBrowser,
  });
}

function validateProposalForDirective(directive, {
  browserEpoch,
  now = Date.now(),
} = {}) {
  if (!directive.proposal) return;
  const proposal = directive.proposal;
  if (proposal.kind !== 'proposal'
    || proposal.mayMutateBrowser !== false
    || proposal.mayChangeVerdict !== false
    || proposal.mayStopExecution !== false) {
    throw new ControllerRecoveryDirectiveError(
      'Recovery proposal is not proposal-only.',
      'CONTROLLER_RECOVERY_PROPOSAL_INVALID',
      { directiveId: directive.directiveId },
    );
  }
  if (proposal.operationId && clean(proposal.operationId) !== directive.operationId) {
    throw new ControllerRecoveryDirectiveError(
      'Recovery proposal belongs to a different operation.',
      'CONTROLLER_RECOVERY_PROPOSAL_SCOPE_MISMATCH',
      { directiveId: directive.directiveId },
    );
  }
  const expectedEpoch = clean(browserEpoch || directive.browserEpoch);
  const proposalEpoch = clean(proposal.browserEpoch);
  if (expectedEpoch && proposalEpoch && expectedEpoch !== proposalEpoch) {
    throw new ControllerRecoveryDirectiveError(
      'Recovery proposal belongs to a stale browser epoch.',
      'CONTROLLER_RECOVERY_PROPOSAL_EPOCH_STALE',
      { directiveId: directive.directiveId, expectedEpoch, proposalEpoch },
    );
  }
  if (proposal.expiresAtMs != null && Number(now) > Number(proposal.expiresAtMs)) {
    throw new ControllerRecoveryDirectiveError(
      'Recovery proposal expired before controller authorization.',
      'CONTROLLER_RECOVERY_PROPOSAL_EXPIRED',
      { directiveId: directive.directiveId },
    );
  }
}

function authorizeRecoveryDirective({
  authority,
  directive,
  browserEpoch = null,
  now = Date.now(),
} = {}) {
  if (!directive || directive.schemaVersion !== RECOVERY_VERSION) {
    throw new ControllerRecoveryDirectiveError(
      'Controller can authorize only typed recovery directives.',
      'CONTROLLER_RECOVERY_DIRECTIVE_REQUIRED',
    );
  }
  if (authorizedDirectives.has(directive)) {
    throw new ControllerRecoveryDirectiveError(
      'Recovery directive is single-use.',
      'CONTROLLER_RECOVERY_DIRECTIVE_REUSED',
      { directiveId: directive.directiveId },
    );
  }
  const capability = directive.mayMutateBrowser
    ? CONTROLLER_CAPABILITY.AUTHORIZE_REDISPATCH
    : CONTROLLER_CAPABILITY.DECIDE_CONTINUATION;
  const authorization = assertControllerAuthority(authority, capability);
  validateProposalForDirective(directive, { browserEpoch, now });
  authorizedDirectives.add(directive);
  return Object.freeze({
    schemaVersion: RECOVERY_VERSION,
    directiveId: directive.directiveId,
    operationId: directive.operationId,
    directive: directive.directive,
    capability: authorization.capability,
    mayMutateBrowser: directive.mayMutateBrowser,
    originalOccurrenceId: directive.actionOccurrenceId,
    recoveryOccurrenceId: directive.mayMutateBrowser
      ? `${directive.actionOccurrenceId}:recovery:${directive.directive.toLowerCase()}:${directive.attempt}`
      : null,
    mayRedispatchOriginalOccurrence: false,
    authorizedAtMs: Number(now),
  });
}

module.exports = {
  RECOVERY_VERSION,
  RECOVERY_ISSUE,
  RECOVERY_DIRECTIVE,
  MUTATING_DIRECTIVES,
  ControllerRecoveryDirectiveError,
  directiveForIssue,
  createRecoveryDirective,
  validateProposalForDirective,
  authorizeRecoveryDirective,
};
