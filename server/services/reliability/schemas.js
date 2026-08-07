'use strict';

const {
  SCHEMA_VERSION,
  CONTRACT_VERSION,
  CASE_RELIABILITY_STATUS,
  SUITE_RELIABILITY_STATUS,
  RELIABILITY_SEVERITY,
  DEFECT_RESOLUTION_STATUS,
  DEFECT_FAMILY,
  SCENARIO_ACTIONS,
  REPAIR_STOP_REASON,
  buildScenarioStep,
  buildBrowserActionBinding,
  buildRowExecutionPlan,
  buildDataLineage,
  buildOracle,
  buildStructuredOracles,
  buildCaseReliabilityArtifacts,
  collectScenarioReliabilityArtifacts,
} = require('./contracts');
const orchestrator = require('./orchestrator');
const jobs = require('./jobs');
const capabilityMap = require('./capabilityMap');
const benchmarkComparator = require('./benchmarkComparator');
const coverageIdentityMap = require('./coverageIdentityMap');
const scenarioGenerationStatus = require('./scenarioGenerationStatus');
const semanticFieldMapper = require('./semanticFieldMapper');

const schemaNames = Object.freeze([
  'ScenarioCase',
  'ScenarioStep',
  'RowExecutionPlan',
  'BrowserActionBinding',
  'ReliabilityDefect',
  'CaseReliabilityStatus',
  'SuiteReliabilityStatus',
  'Oracle',
  'DataLineage',
  'CoverageManifest',
  'ExampleMappingContract',
  'AppCapabilityMap',
  'RepairRound',
  'UserDecisionException',
  'ExecutionProof',
  'ScenarioGenerationJob',
  'ScenarioReliabilityReport',
  'ReliabilityAuditEvent',
]);

function baseArtifact(fields = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    ...fields,
  };
}

module.exports = {
  SCHEMA_VERSION,
  CONTRACT_VERSION,
  CASE_RELIABILITY_STATUS,
  SUITE_RELIABILITY_STATUS,
  RELIABILITY_SEVERITY,
  DEFECT_RESOLUTION_STATUS,
  DEFECT_FAMILY,
  SCENARIO_ACTIONS,
  REPAIR_STOP_REASON,
  schemaNames,
  baseArtifact,
  buildScenarioStep,
  buildBrowserActionBinding,
  buildRowExecutionPlan,
  buildDataLineage,
  buildOracle,
  buildStructuredOracles,
  buildCaseReliabilityArtifacts,
  collectScenarioReliabilityArtifacts,
  orchestrator,
  jobs,
  capabilityMap,
  benchmarkComparator,
  coverageIdentityMap,
  scenarioGenerationStatus,
  semanticFieldMapper,
};
