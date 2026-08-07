'use strict';

const {
  SCHEMA_VERSION,
  CONTRACT_VERSION,
  CASE_RELIABILITY_STATUS,
  SUITE_RELIABILITY_STATUS,
  RELIABILITY_SEVERITY,
  DEFECT_RESOLUTION_STATUS,
  countCases,
} = require('./contracts');

const CLOSED_RESOLUTIONS = new Set([
  DEFECT_RESOLUTION_STATUS.AUTO_REPAIRED,
  DEFECT_RESOLUTION_STATUS.DISMISSED,
  DEFECT_RESOLUTION_STATUS.SUPERSEDED,
]);

function isOpenDefect(defect) {
  if (!defect) return false;
  if (CLOSED_RESOLUTIONS.has(defect.resolutionStatus)) return false;
  return true;
}

function isUserAccepted(defect) {
  return !!defect && defect.resolutionStatus === DEFECT_RESOLUTION_STATUS.USER_ACCEPTED;
}

function defectAppliesToCase(defect, scenarioCase) {
  if (!defect || !scenarioCase) return true;
  if (!defect.caseId) return true;
  return defect.caseId === scenarioCase.id;
}

function deriveCaseReliabilityStatus(scenarioCase = {}, defects = []) {
  const relevant = (Array.isArray(defects) ? defects : []).filter((d) => defectAppliesToCase(d, scenarioCase));
  const open = relevant.filter(isOpenDefect);

  if (open.some((d) => d.severity === RELIABILITY_SEVERITY.CRITICAL)) {
    return CASE_RELIABILITY_STATUS.NEEDS_REPAIR;
  }
  if (open.some((d) => d.severity === RELIABILITY_SEVERITY.REPAIR_REQUIRED)) {
    return CASE_RELIABILITY_STATUS.NEEDS_REPAIR;
  }
  if (open.some((d) => d.severity === RELIABILITY_SEVERITY.USER_DECISION_REQUIRED)) {
    return CASE_RELIABILITY_STATUS.NEEDS_USER_DECISION;
  }
  if (relevant.some(isUserAccepted)) {
    return CASE_RELIABILITY_STATUS.ACCEPTED_EXCEPTION;
  }
  if (relevant.some((d) => d && d.resolutionStatus === DEFECT_RESOLUTION_STATUS.AUTO_REPAIRED)) {
    return CASE_RELIABILITY_STATUS.REPAIRED_RELIABLE;
  }
  if (scenarioCase && scenarioCase.reliabilityStatus === CASE_RELIABILITY_STATUS.LEGACY_UNVERIFIED) {
    return CASE_RELIABILITY_STATUS.LEGACY_UNVERIFIED;
  }
  return CASE_RELIABILITY_STATUS.RELIABLE;
}

function hasPositiveNumber(summary, keys) {
  if (!summary || typeof summary !== 'object') return false;
  return keys.some((key) => Number(summary[key] || 0) > 0);
}

function coverageIncomplete(summary) {
  if (!summary || typeof summary !== 'object') return false;
  if (summary.ok === false) return true;
  if (Number(summary.missingRequired || 0) > 0) return true;
  const required = Number(summary.required || 0);
  const covered = Number(summary.covered || 0);
  return required > 0 && covered < required;
}

function canPromoteToReliable(report = {}) {
  const unresolved = Array.isArray(report.unresolvedDefects) ? report.unresolvedDefects.filter(isOpenDefect) : [];
  if (unresolved.some((d) => d.severity === RELIABILITY_SEVERITY.CRITICAL
    || d.severity === RELIABILITY_SEVERITY.REPAIR_REQUIRED
    || d.severity === RELIABILITY_SEVERITY.USER_DECISION_REQUIRED)) {
    return false;
  }
  if (Number(report.acceptedExceptionCases || 0) > 0) return false;
  if (Array.isArray(report.unresolvedExceptions) && report.unresolvedExceptions.length > 0) return false;
  if (coverageIncomplete(report.coverageSummary)) return false;
  if (hasPositiveNumber(report.stepShapeSummary, ['invalid', 'malformed', 'doubleEncoded'])) return false;
  if (hasPositiveNumber(report.dataBindingSummary, ['missing', 'unapproved', 'unresolved', 'tokenCollisions'])) return false;
  if (hasPositiveNumber(report.oracleSummary, ['missingRequired', 'weak'])) return false;
  if (hasPositiveNumber(report.browserActionSummary, ['unregistered', 'nonExportableRequired'])) return false;
  if (hasPositiveNumber(report.appCapabilitySummary, ['missing', 'stale', 'missing_app_capability', 'stale_app_capability'])) return false;
  return true;
}

function deriveSuiteReliabilityStatus(report = {}) {
  if (report.status === SUITE_RELIABILITY_STATUS.LEGACY_UNVERIFIED) return SUITE_RELIABILITY_STATUS.LEGACY_UNVERIFIED;
  const unresolved = Array.isArray(report.unresolvedDefects) ? report.unresolvedDefects.filter(isOpenDefect) : [];
  if (unresolved.some((d) => d.severity === RELIABILITY_SEVERITY.CRITICAL
    || d.severity === RELIABILITY_SEVERITY.REPAIR_REQUIRED)) {
    return SUITE_RELIABILITY_STATUS.NEEDS_REPAIR;
  }
  if (unresolved.some((d) => d.severity === RELIABILITY_SEVERITY.USER_DECISION_REQUIRED)
    || (Array.isArray(report.unresolvedExceptions) && report.unresolvedExceptions.length)) {
    return SUITE_RELIABILITY_STATUS.NEEDS_USER_DECISION;
  }
  if (Number(report.acceptedExceptionCases || 0) > 0) {
    return SUITE_RELIABILITY_STATUS.READY_WITH_USER_DECISIONS;
  }
  return canPromoteToReliable(report) ? SUITE_RELIABILITY_STATUS.READY : SUITE_RELIABILITY_STATUS.NEEDS_REPAIR;
}

function deriveExecutionReliabilityStatus(proofs = []) {
  const rows = Array.isArray(proofs) ? proofs : [];
  if (!rows.length) return 'not_run';
  if (rows.some((proof) => proof && (proof.status === 'failed' || proof.status === 'flaky_warning'))) {
    return 'execution_issues_found';
  }
  if (rows.some((proof) => proof && proof.mode === 'full_proof' && proof.status === 'passed')) {
    return 'full_proof_passed';
  }
  if (rows.some((proof) => proof && proof.mode === 'dry_run' && proof.status === 'passed')) {
    return 'dry_run_passed';
  }
  return 'not_run';
}

function createScenarioReliabilityReport({
  generationId = null,
  scenarios = [],
  defects = [],
  coverageSummary = {},
  repairRounds = [],
  unresolvedExceptions = [],
  stepShapeSummary = {},
  dataBindingSummary = {},
  rowCoverageSummary = {},
  semanticQualitySummary = {},
  appCapabilitySummary = {},
  browserActionSummary = {},
  oracleSummary = {},
  executionProofSummary = {},
  reliabilityArtifacts = [],
  repairTasks = [],
  repairAuditEvents = [],
  repairStopReason = undefined,
  repairRoundsUsed = 0,
  tokensUsed = 0,
  wallClockMs = 0,
  toolCallsUsed = 0,
  skippedRepairsDueToBudget = 0,
  repairBudget = null,
  tokenBudgetStatus = undefined,
} = {}) {
  const allDefects = Array.isArray(defects) ? defects : [];
  const unresolvedDefects = allDefects.filter(isOpenDefect);
  const cases = (Array.isArray(scenarios) ? scenarios : []).flatMap((scenario) => (
    Array.isArray(scenario && scenario.cases) ? scenario.cases : []
  ));
  const statuses = cases.map((scenarioCase) => deriveCaseReliabilityStatus(scenarioCase, allDefects));
  const report = {
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    generationId,
    status: SUITE_RELIABILITY_STATUS.PREVIEW,
    totalCases: countCases(scenarios),
    reliableCases: statuses.filter((s) => s === CASE_RELIABILITY_STATUS.RELIABLE).length,
    repairedCases: statuses.filter((s) => s === CASE_RELIABILITY_STATUS.REPAIRED_RELIABLE).length,
    needsRepairCases: statuses.filter((s) => s === CASE_RELIABILITY_STATUS.NEEDS_REPAIR).length,
    needsUserDecisionCases: statuses.filter((s) => s === CASE_RELIABILITY_STATUS.NEEDS_USER_DECISION).length,
    acceptedExceptionCases: statuses.filter((s) => s === CASE_RELIABILITY_STATUS.ACCEPTED_EXCEPTION).length,
    coverageSummary,
    dataBindingSummary,
    stepShapeSummary,
    rowCoverageSummary,
    semanticQualitySummary,
    appCapabilitySummary,
    browserActionSummary,
    oracleSummary,
    executionProofSummary,
    reliabilityArtifacts: Array.isArray(reliabilityArtifacts) ? reliabilityArtifacts : [],
    repairTasks: Array.isArray(repairTasks) ? repairTasks : [],
    repairAuditEvents: Array.isArray(repairAuditEvents) ? repairAuditEvents : [],
    repairRounds: Array.isArray(repairRounds) ? repairRounds : [],
    repairStopReason,
    unresolvedDefects,
    unresolvedExceptions: Array.isArray(unresolvedExceptions) ? unresolvedExceptions : [],
    repairRoundsUsed,
    tokensUsed,
    wallClockMs,
    toolCallsUsed,
    skippedRepairsDueToBudget,
    repairBudget,
    tokenBudgetStatus: tokenBudgetStatus || (repairBudget && repairBudget.tokenBudgetStatus) || undefined,
  };
  report.status = deriveSuiteReliabilityStatus(report);
  return report;
}

module.exports = {
  isOpenDefect,
  deriveCaseReliabilityStatus,
  deriveSuiteReliabilityStatus,
  deriveExecutionReliabilityStatus,
  canPromoteToReliable,
  createScenarioReliabilityReport,
};
