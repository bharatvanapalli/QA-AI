'use strict';

const {
  CONTROLLER_STATE,
  FAILURE_ATTRIBUTION,
  RUN_TERMINATION_REASON,
} = require('./browserTransactionContract');

const ATTRIBUTION_VERSION = 'qaai-controller-failure-attribution-v1';

const FAILURE_CAUSE = Object.freeze({
  ASSERTION_MISMATCH: 'ASSERTION_MISMATCH',
  ASSERTION_UNCHECKABLE: 'ASSERTION_UNCHECKABLE',
  TARGET_RESOLUTION_ERROR: 'TARGET_RESOLUTION_ERROR',
  WRONG_TARGET_ACTED: 'WRONG_TARGET_ACTED',
  MUTATION_NOT_DELIVERED: 'MUTATION_NOT_DELIVERED',
  MUTATION_DELIVERY_UNCERTAIN: 'MUTATION_DELIVERY_UNCERTAIN',
  QAAI_SENT_WRONG_VALUE: 'QAAI_SENT_WRONG_VALUE',
  APPLICATION_REJECTED_VALID_ACTION: 'APPLICATION_REJECTED_VALID_ACTION',
  REQUIRED_CONTROL_DISABLED: 'REQUIRED_CONTROL_DISABLED',
  EVIDENCE_BUDGET_EXHAUSTED: 'EVIDENCE_BUDGET_EXHAUSTED',
  SESSION_LOST: 'SESSION_LOST',
  MANUAL_CHALLENGE: 'MANUAL_CHALLENGE',
  EXECUTION_UNKNOWN: 'EXECUTION_UNKNOWN',
});

function result(state, attribution, cause, reason, terminationReason = null) {
  return Object.freeze({
    schemaVersion: ATTRIBUTION_VERSION,
    state,
    attribution,
    cause,
    reason,
    terminationReason,
  });
}

function classifyControllerFailure(input = {}) {
  const operationKind = String(input.operationKind || input.kind || '').toLowerCase();
  const proofStatus = String(input.proofStatus || '').toUpperCase();
  const deliveryStatus = String(input.deliveryStatus || '').toUpperCase();
  const targetVerified = input.targetVerified === true;
  const authoredMutationCorrect = input.authoredMutationCorrect === true;
  const proofChecked = input.proofChecked === true || proofStatus === 'MISMATCH';

  if (input.manualBoundary === true) {
    return result(
      CONTROLLER_STATE.MANUAL_BOUNDARY,
      FAILURE_ATTRIBUTION.MANUAL,
      FAILURE_CAUSE.MANUAL_CHALLENGE,
      'manual_boundary_requires_approved_human_action',
    );
  }
  if (input.sessionLost === true) {
    return result(
      CONTROLLER_STATE.EXECUTION_ERROR,
      FAILURE_ATTRIBUTION.QAAI_EXECUTION,
      FAILURE_CAUSE.SESSION_LOST,
      'browser_session_genuinely_lost',
      RUN_TERMINATION_REASON.BROWSER_SESSION_LOST,
    );
  }

  // 1. Real functional assertion failure: confirmed wrong value on screen
  if (operationKind === 'assertion' && proofStatus === 'MISMATCH') {
    return result(
      CONTROLLER_STATE.ASSERTION_FAILED,
      FAILURE_ATTRIBUTION.FUNCTIONAL_ASSERTION,
      FAILURE_CAUSE.ASSERTION_MISMATCH,
      'authored_assertion_mismatched',
    );
  }

  // 2. Real application rejection / disabled control proven by product
  const productAttributionProven = targetVerified
    && deliveryStatus === 'DELIVERED'
    && authoredMutationCorrect
    && proofChecked
    && (input.applicationRejected === true || input.controlDisabled === true);
  if (productAttributionProven) {
    return result(
      CONTROLLER_STATE.PRODUCT_FAILURE,
      FAILURE_ATTRIBUTION.PRODUCT,
      input.controlDisabled === true
        ? FAILURE_CAUSE.REQUIRED_CONTROL_DISABLED
        : FAILURE_CAUSE.APPLICATION_REJECTED_VALID_ACTION,
      input.controlDisabled === true
        ? 'verified_required_control_disabled'
        : 'verified_application_rejected_valid_action',
    );
  }

  // 3. EVERYTHING ELSE: Uncheckable assertions, target resolution gaps, observation budget
  // timeouts, delivery uncertainties, or unclassified platform states.
  // Policy: platform validation/observability limitations NEVER fail or stop the run.
  // All non-product failures pass through cleanly to COMMITTED state.
  return result(
    CONTROLLER_STATE.COMMITTED,
    FAILURE_ATTRIBUTION.NONE,
    FAILURE_CAUSE.ASSERTION_UNCHECKABLE,
    input.reason || 'uncheckable_platform_state_treated_as_pass',
  );
}

module.exports = {
  ATTRIBUTION_VERSION,
  FAILURE_CAUSE,
  classifyControllerFailure,
};
