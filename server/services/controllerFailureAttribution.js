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
  if (operationKind === 'assertion') {
    return result(
      CONTROLLER_STATE.ASSERTION_FAILED,
      FAILURE_ATTRIBUTION.FUNCTIONAL_ASSERTION,
      proofStatus === 'MISMATCH'
        ? FAILURE_CAUSE.ASSERTION_MISMATCH
        : FAILURE_CAUSE.ASSERTION_UNCHECKABLE,
      proofStatus === 'MISMATCH'
        ? 'authored_assertion_mismatched'
        : 'authored_assertion_could_not_be_proven',
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
  if (input.targetStatus && String(input.targetStatus).toUpperCase() !== 'RESOLVED') {
    return result(
      CONTROLLER_STATE.EXECUTION_ERROR,
      FAILURE_ATTRIBUTION.QAAI_EXECUTION,
      FAILURE_CAUSE.TARGET_RESOLUTION_ERROR,
      `semantic_target_${String(input.targetStatus).toLowerCase()}`,
    );
  }
  if (input.wrongTargetActed === true) {
    return result(
      CONTROLLER_STATE.EXECUTION_ERROR,
      FAILURE_ATTRIBUTION.QAAI_EXECUTION,
      FAILURE_CAUSE.WRONG_TARGET_ACTED,
      'qaai_acted_on_wrong_semantic_owner',
    );
  }
  if (input.authoredMutationCorrect === false) {
    return result(
      CONTROLLER_STATE.EXECUTION_ERROR,
      FAILURE_ATTRIBUTION.QAAI_EXECUTION,
      FAILURE_CAUSE.QAAI_SENT_WRONG_VALUE,
      'qaai_mutation_did_not_match_authored_operation',
    );
  }
  if (deliveryStatus === 'NOT_DELIVERED' || input.positiveNonDelivery === true) {
    return result(
      CONTROLLER_STATE.EXECUTION_ERROR,
      FAILURE_ATTRIBUTION.QAAI_EXECUTION,
      FAILURE_CAUSE.MUTATION_NOT_DELIVERED,
      'required_mutation_positively_not_delivered',
      input.required === false
        ? null
        : RUN_TERMINATION_REASON.REQUIRED_MUTATION_PROVEN_UNDELIVERED,
    );
  }
  if (deliveryStatus === 'DELIVERY_UNCERTAIN' && proofStatus !== 'MISMATCH') {
    return result(
      CONTROLLER_STATE.EXECUTION_ERROR,
      FAILURE_ATTRIBUTION.QAAI_EXECUTION,
      FAILURE_CAUSE.MUTATION_DELIVERY_UNCERTAIN,
      'delivery_uncertain_after_bounded_reconciliation',
    );
  }

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
  if (proofStatus === 'UNKNOWN' || input.observationBudgetExhausted === true) {
    return result(
      CONTROLLER_STATE.EXECUTION_ERROR,
      FAILURE_ATTRIBUTION.QAAI_EXECUTION,
      FAILURE_CAUSE.EVIDENCE_BUDGET_EXHAUSTED,
      'bounded_evidence_reconciliation_exhausted',
    );
  }
  return result(
    CONTROLLER_STATE.EXECUTION_ERROR,
    FAILURE_ATTRIBUTION.QAAI_EXECUTION,
    FAILURE_CAUSE.EXECUTION_UNKNOWN,
    'browser_transaction_failed_without_proven_product_attribution',
  );
}

module.exports = {
  ATTRIBUTION_VERSION,
  FAILURE_CAUSE,
  classifyControllerFailure,
};
