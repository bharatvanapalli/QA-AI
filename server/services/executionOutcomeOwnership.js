'use strict';

/**
 * Classify who owns a failed browser operation.
 *
 * This boundary is deliberately fail-closed: an operation that QAAI could not
 * prove is an execution uncertainty, not evidence that the product is broken.
 * A product-owned failure requires an explicit typed signal or positive
 * browser evidence of rejection. Assertion mismatches are passed explicitly by
 * the caller and remain product/functional outcomes.
 */

const QAAI_UNCERTAINTY_TYPES = new Set([
  'execution_error',
  'qaai_execution_error',
  'qaai_execution_uncertainty',
  'automation_error',
  'infrastructure_error',
  'dispatch_failed',
  'evidence_missing',
  'snapshot_unavailable',
  'session_dead',
  'locator_resolution_failed',
  'selector_resolution_failed',
  'target_resolution_failed',
  'ambiguous_target',
  'transition_evidence_inconclusive',
]);

const PRODUCT_EVIDENCE_TYPES = new Set([
  'product_rejection',
  'application_rejected',
  'business_rule_rejected',
  'validation_rejected',
  'website_error_observed',
]);

const UNCERTAINTY_TEXT = /\b(?:time(?:d)?[ -]?out|timeout|stale|detached|ambiguous|equal[- ]score|unconfirmed|inconclusive|unavailable|not available|could not (?:safely )?(?:resolve|confirm|locate)|unable to (?:resolve|confirm|locate)|no[_ -]?(?:clickable|active|unique|matching)[_ -]?(?:control|element|target|field)?|not uniquely (?:and safely )?resolved|locator|selector|snapshot|evidence[_ -]?missing|session[_ -]?(?:dead|unavailable)|dispatch[_ -]?failed|target[_ -]?resolution)\b/i;

function token(value) {
  return String(value || '').trim().toLowerCase();
}

function diagnosticText(input = {}) {
  const values = [
    input.failureType,
    input.reason,
    input.error,
    input.observedState,
    input.actual,
  ];
  if (input.evidence != null) {
    try {
      values.push(typeof input.evidence === 'string' ? input.evidence : JSON.stringify(input.evidence));
    } catch (_) { /* diagnostic serialization must never affect execution */ }
  }
  return values.filter(Boolean).join(' ').slice(0, 12000);
}

function hasPositiveProductEvidence(input = {}, failureType = '') {
  if (input.assertionMismatch === true
    || input.observedProductRejection === true
    || input.productFailureEvidence === true
    || input.evidence?.productRejected === true
    || input.evidence?.applicationRejected === true
    || input.evidence?.businessRuleRejected === true
    || input.evidence?.validationRejected === true
    || input.evidence?.websiteErrorObserved === true) return true;
  return PRODUCT_EVIDENCE_TYPES.has(failureType);
}

function classifyActionFailureOwnership(input = {}) {
  const failureType = token(input.failureType || input.failureKind);
  const diagnostic = diagnosticText(input);
  const explicitQaai = input.executionError === true
    || input.qaaiExecutionError === true
    || token(input.failureOwner) === 'qaai'
    || QAAI_UNCERTAINTY_TYPES.has(failureType);
  const uncertain = explicitQaai || UNCERTAINTY_TEXT.test(diagnostic);

  // Uncertainty always wins over a generic/product label. A caller must not
  // turn an unconfirmed browser observation into a website defect merely by
  // naming it "product_failure".
  if (uncertain) {
    return {
      executionError: true,
      failureOwner: 'qaai',
      failureType: failureType && QAAI_UNCERTAINTY_TYPES.has(failureType)
        ? failureType
        : 'qaai_execution_uncertainty',
    };
  }

  if (hasPositiveProductEvidence(input, failureType)) {
    return {
      executionError: false,
      failureOwner: 'product',
      failureType: failureType || 'product_failure',
    };
  }

  return {
    executionError: true,
    failureOwner: 'qaai',
    failureType: 'qaai_execution_uncertainty',
  };
}

module.exports = {
  classifyActionFailureOwnership,
  QAAI_UNCERTAINTY_TYPES,
  PRODUCT_EVIDENCE_TYPES,
};
