'use strict';

const { decodeJson } = require('./jsonField');

const BLOCK_CODE = 'IMMUTABLE_TEST_DESIGN_REPLAN_REQUIRED';
const BLOCKING_EXECUTION_FINDING_CODES = new Set([
  'execution_generation_mismatch',
]);

function coverageManifestOf(value) {
  if (!value) return null;
  if (value.coveragePlanJson !== undefined) return decodeJson(value.coveragePlanJson, null);
  return decodeJson(value, null);
}

function immutablePlanOf(value) {
  const manifest = coverageManifestOf(value);
  const direct = manifest && manifest.testDesignPlanV1;
  if (direct && direct.planId && direct.revision) return direct;
  const history = manifest && manifest.contractHistory && manifest.contractHistory.testDesignPlanV1;
  if (!Array.isArray(history)) return null;
  return [...history].reverse().find((plan) => plan && plan.planId && plan.revision) || null;
}

function isPlanBackedGeneration(value) {
  return !!immutablePlanOf(value);
}

function caseLineageOf(value) {
  const quality = decodeJson(value && value.qualityContractJson !== undefined ? value.qualityContractJson : value, null);
  const lineage = quality && quality.testDesignPlan;
  return lineage && lineage.planId && lineage.revision && lineage.planCaseId && lineage.caseRevision
    ? lineage
    : null;
}

function isPlanBackedCase(value) {
  return !!caseLineageOf(value);
}

function planCaseMap(plan) {
  return new Map((Array.isArray(plan && plan.scenarios) ? plan.scenarios : [])
    .flatMap((scenario) => Array.isArray(scenario && scenario.cases) ? scenario.cases : [])
    .filter((casePlan) => casePlan && casePlan.planCaseId)
    .map((casePlan) => [String(casePlan.planCaseId), casePlan]));
}

function persistedExecutionLineageReport(generation, cases = []) {
  const plan = immutablePlanOf(generation);
  if (!plan) return { ok: true, planBacked: false, plan: null, findings: [] };
  const planned = planCaseMap(plan);
  const findings = [];
  const seenPlanCases = new Set();
  for (const testCase of Array.isArray(cases) ? cases : []) {
    const lineage = caseLineageOf(testCase);
    if (!lineage) {
      findings.push({ code: 'execution_case_lineage_missing', testCaseId: testCase && testCase.id || null });
      continue;
    }
    const casePlan = planned.get(String(lineage.planCaseId));
    for (const [field, expected] of [
      ['planId', plan.planId],
      ['revision', plan.revision],
      ['caseRevision', casePlan && casePlan.caseRevision],
    ]) {
      if (!casePlan || lineage[field] !== expected) {
        findings.push({
          code: 'execution_case_lineage_mismatch',
          testCaseId: testCase && testCase.id || null,
          planCaseId: lineage.planCaseId || null,
          field,
          expected: expected || null,
          actual: lineage[field] || null,
        });
      }
    }
    if (!lineage.compiledCaseRevision) {
      findings.push({
        code: 'execution_compiled_case_revision_missing',
        testCaseId: testCase && testCase.id || null,
        planCaseId: lineage.planCaseId || null,
      });
    }
    if (generation && generation.id && testCase && testCase.generationId !== generation.id) {
      findings.push({
        code: 'execution_generation_mismatch',
        testCaseId: testCase.id || null,
        expected: generation.id,
        actual: testCase.generationId || null,
      });
    }
    if (lineage.planCaseId) {
      if (seenPlanCases.has(lineage.planCaseId)) {
        findings.push({
          code: 'execution_plan_case_duplicate',
          testCaseId: testCase && testCase.id || null,
          planCaseId: lineage.planCaseId,
        });
      }
      seenPlanCases.add(lineage.planCaseId);
    }
  }
  return { ok: findings.length === 0, planBacked: true, plan, findings };
}

function classifyExecutionLineageReport(report) {
  const findings = Array.isArray(report && report.findings) ? report.findings : [];
  const blockingFindings = findings.filter((finding) => BLOCKING_EXECUTION_FINDING_CODES.has(finding && finding.code));
  const diagnosticFindings = findings.filter((finding) => !BLOCKING_EXECUTION_FINDING_CODES.has(finding && finding.code));
  return {
    ...report,
    executionAllowed: blockingFindings.length === 0,
    blockingFindings,
    diagnosticFindings,
  };
}

function assertPersistedExecutionLineage(generation, cases = []) {
  const report = classifyExecutionLineageReport(persistedExecutionLineageReport(generation, cases));
  if (report.executionAllowed) return report;
  const err = new Error('Execution refused because the selected cases do not match the immutable TestDesignPlan revision.');
  err.code = 'TEST_DESIGN_EXECUTION_LINEAGE_INVALID';
  err.status = 409;
  err.findings = report.blockingFindings;
  err.diagnosticFindings = report.diagnosticFindings;
  throw err;
}

function mutationBlockedPayload(value, action = 'mutate this generated test design') {
  const plan = immutablePlanOf(value);
  if (!plan) return null;
  return {
    success: false,
    code: BLOCK_CODE,
    message: `Cannot ${action} in place because this generation is pinned to an immutable TestDesignPlan. Create a new full generation so requirements, data alignment, cases, steps, and revisions are compiled together.`,
    plan: {
      planId: plan.planId,
      revision: plan.revision,
    },
  };
}

module.exports = {
  BLOCK_CODE,
  coverageManifestOf,
  immutablePlanOf,
  isPlanBackedGeneration,
  caseLineageOf,
  isPlanBackedCase,
  persistedExecutionLineageReport,
  classifyExecutionLineageReport,
  assertPersistedExecutionLineage,
  mutationBlockedPayload,
};
