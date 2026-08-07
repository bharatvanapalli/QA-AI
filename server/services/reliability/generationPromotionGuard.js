'use strict';

function clauseHasExecutableSignal(clause) {
  if (!clause || clause.testable === false) return false;
  return Boolean(
    clause.behaviourText
      || clause.text
      || clause.description
      || clause.excerpt
      || clause.title
  );
}

function countTestableClauses(clauses = []) {
  return Array.isArray(clauses)
    ? clauses.filter(clauseHasExecutableSignal).length
    : 0;
}

function scenarioFloorForClauses(clauses = [], options = {}) {
  const count = countTestableClauses(clauses);
  if (!count) return 0;
  const maxFloor = Number.isFinite(options.maxFloor) ? options.maxFloor : 15;
  const clausesPerScenario = Number.isFinite(options.clausesPerScenario)
    ? Math.max(1, options.clausesPerScenario)
    : 8;
  return Math.min(Math.max(1, Math.ceil(count / clausesPerScenario)), maxFloor);
}

function normalizeMissingRequired(validation = {}) {
  const direct = Array.isArray(validation.missingRequired) ? validation.missingRequired : [];
  if (direct.length) return direct;
  const findings = Array.isArray(validation.findings) ? validation.findings : [];
  return findings
    .filter((finding) => finding && finding.code === 'coverage_required_missing')
    .map((finding) => ({
      manifestItemId: finding.manifestItemId,
      coverageRef: finding.coverageRef,
      id: finding.id,
      type: finding.type,
    }));
}

function missingRequiredId(item) {
  if (!item || typeof item !== 'object') return String(item || '');
  return item.manifestItemId || item.coverageRef || item.id || item.title || '';
}

function promotionIssuesForGeneration({
  scenarios = [],
  coverageValidation = null,
  requirementClauses = [],
  options = {},
} = {}) {
  const issues = [];
  const scenarioCount = Array.isArray(scenarios) ? scenarios.length : 0;
  const authoritativeAuthoredCases = options.authoritativeAuthoredCases === true;
  if (authoritativeAuthoredCases) return issues;
  const proceduralOneCase = options.proceduralOneCase === true || options.allowSingleProceduralFlow === true;
  const minScenarios = proceduralOneCase ? 0 : scenarioFloorForClauses(requirementClauses, options);

  if (minScenarios && scenarioCount < minScenarios) {
    issues.push({
      code: 'scenario_floor_shortfall',
      severity: 'error',
      message: `Generated ${scenarioCount} scenario(s), below the required floor of ${minScenarios}.`,
      evidence: {
        scenarioCount,
        minScenarios,
        testableClauses: countTestableClauses(requirementClauses),
      },
    });
  }

  const validation = coverageValidation || {};
  const missingRequired = normalizeMissingRequired(validation);
  if (validation && validation.ok === false) {
    issues.push({
      code: 'coverage_validation_failed',
      severity: 'error',
      message: 'Coverage validation did not pass for the generated suite.',
      evidence: {
        ok: validation.ok,
        missingRequiredCount: missingRequired.length,
        summary: validation.summary || null,
      },
    });
  }

  if (missingRequired.length) {
    issues.push({
      code: 'coverage_required_missing',
      severity: 'error',
      message: `${missingRequired.length} required coverage item(s) remain missing.`,
      evidence: {
        missingRequired: missingRequired.map(missingRequiredId).filter(Boolean).slice(0, 25),
      },
    });
  }

  return issues;
}

module.exports = {
  countTestableClauses,
  scenarioFloorForClauses,
  promotionIssuesForGeneration,
};
