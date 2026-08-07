'use strict';

const readinessCompiler = require('./readinessCompiler');

const BULK_APPROVAL_DISPOSITION = Object.freeze({
  APPROVE: 'approve',
  BLOCKED: 'blocked',
  NOT_RUNNABLE: 'not_runnable',
});

/**
 * Fail-closed policy for automated/bulk promotion.
 *
 * A freshly compiled case may be bulk-approved only when it is both fully ready
 * and runnable. Explicit approval/readiness blockers take precedence over any
 * inconsistent eligibility fields; every other state requires human attention.
 */
function bulkApprovalDisposition(readiness) {
  if (
    readiness?.readinessStatus === readinessCompiler.READINESS_STATUS.BLOCKED
    || readiness?.approvalEligibility === readinessCompiler.APPROVAL_ELIGIBILITY.BLOCKED
  ) {
    return BULK_APPROVAL_DISPOSITION.BLOCKED;
  }

  if (
    readiness?.readinessStatus === readinessCompiler.READINESS_STATUS.READY
    && readiness?.runEligibility === readinessCompiler.RUN_ELIGIBILITY.ALLOWED
    && readiness?.approvalEligibility === readinessCompiler.APPROVAL_ELIGIBILITY.ELIGIBLE
  ) {
    return BULK_APPROVAL_DISPOSITION.APPROVE;
  }

  return BULK_APPROVAL_DISPOSITION.NOT_RUNNABLE;
}

function bulkApprovalReportEntry(testCase, readiness) {
  return {
    id: testCase?.id || null,
    name: testCase?.name || null,
    readinessStatus: readiness?.readinessStatus || null,
    approvalEligibility: readiness?.approvalEligibility || null,
    runEligibility: readiness?.runEligibility || null,
    reasons: Array.isArray(readiness?.readinessReasons) ? readiness.readinessReasons : [],
  };
}

module.exports = {
  BULK_APPROVAL_DISPOSITION,
  bulkApprovalDisposition,
  bulkApprovalReportEntry,
};
