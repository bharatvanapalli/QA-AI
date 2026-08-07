'use strict';

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

const USER_STATUS = Object.freeze({
  GOOD_TO_RUN: 'Good to run',
  NEEDS_DATA_CHOICE: 'Needs data choice',
  NEEDS_APP_CLARIFICATION: 'Needs app clarification',
  REPAIR_RETRY_NEEDED: 'Repair retry needed',
});

const DATA_CODES = new Set([
  'proposed_data_mapping',
  'missing_approved_data',
  'needs_data_choice',
]);

const APP_CODES = new Set([
  'missing_app_capability',
  'stale_app_capability',
  'non_exportable_action',
]);

const REPAIR_CODES = new Set([
  'coverage_missing_required',
  'coverage_required_missing',
  'coverage_owner_unknown',
  'wrong_coverage_owner',
  'missing_required_story_field',
  'token_collision',
  'weak_oracle',
  'verify_kind_none',
  'missing_structured_oracle',
  'missing_data_lineage',
  'missing_row_execution_plan',
  'silent_row_skip',
  'unregistered_browser_action',
  'repair_introduced_regression',
  'llm_repair_failed',
]);

function defectsForCase(defects = [], scenarioCase = {}) {
  const caseId = scenarioCase.id || scenarioCase.caseId;
  if (!caseId) return arr(defects);
  return arr(defects).filter((defect) => defect && defect.caseId === caseId);
}

function computeScenarioGenerationStatus(caseContracts = {}, defects = []) {
  const scopedDefects = Array.isArray(caseContracts)
    ? arr(defects)
    : defectsForCase(defects, caseContracts);
  const open = scopedDefects.filter((defect) => defect && clean(defect.resolutionStatus) !== 'auto_repaired');

  if (open.some((defect) => clean(defect.severity) === 'critical' || REPAIR_CODES.has(defect.code))) {
    return USER_STATUS.REPAIR_RETRY_NEEDED;
  }
  if (open.some((defect) => DATA_CODES.has(defect.code) || clean(defect.family) === 'data_binding')) {
    return USER_STATUS.NEEDS_DATA_CHOICE;
  }
  if (open.some((defect) => APP_CODES.has(defect.code) || clean(defect.family) === 'app_capability')) {
    return USER_STATUS.NEEDS_APP_CLARIFICATION;
  }
  if (open.some((defect) => clean(defect.severity) === 'repair_required')) {
    return USER_STATUS.REPAIR_RETRY_NEEDED;
  }
  if (open.some((defect) => clean(defect.severity) === 'user_decision_required')) {
    return USER_STATUS.NEEDS_APP_CLARIFICATION;
  }
  return USER_STATUS.GOOD_TO_RUN;
}

module.exports = {
  USER_STATUS,
  computeScenarioGenerationStatus,
};
