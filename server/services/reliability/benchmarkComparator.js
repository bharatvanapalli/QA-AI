'use strict';

const {
  collectScenarioReliabilityDefects,
  fieldPresentInSteps,
  normalizeStepsInput,
  buildStructuredOracles,
} = require('./contracts');
const {
  buildCoverageIdentityMap,
  caseMatchesCoverage,
  coverageAliasesFor,
  resolveCoverageRef,
} = require('./coverageIdentityMap');

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return Array.from(new Set(arr(values).map(clean).filter(Boolean)));
}

function phase45Of(caseObj = {}) {
  const quality = caseObj.qualityContract && typeof caseObj.qualityContract === 'object' ? caseObj.qualityContract : {};
  return quality.phase45 && typeof quality.phase45 === 'object' ? quality.phase45 : {};
}

function coverageRefsOf(caseObj = {}) {
  const phase45 = phase45Of(caseObj);
  return unique([
    ...arr(caseObj.coverageRefs),
    ...arr(caseObj.requirementRefs),
    ...arr(phase45.coverageRefs),
    ...arr(phase45.coverageAliases),
  ]);
}

function allCases(scenarios = []) {
  const rows = [];
  for (const scenario of arr(scenarios)) {
    for (const caseObj of arr(scenario && scenario.cases)) {
      rows.push({ scenario, caseObj });
    }
  }
  return rows;
}

function casesForCoverageRef(scenarios, coverageRef, identityMap) {
  return allCases(scenarios)
    .filter(({ caseObj }) => (
      coverageRefsOf(caseObj).includes(coverageRef)
      || caseMatchesCoverage(caseObj, coverageRef, identityMap)
    ));
}

function oracleMatches(actual = {}, expected = {}) {
  if (!actual || !expected) return false;
  if (expected.kind && actual.kind !== expected.kind) return false;
  if (expected.target && !clean(actual.target).toLowerCase().includes(clean(expected.target).toLowerCase())) return false;
  return true;
}

function rowIntentMatches(caseObj = {}, intent) {
  if (!intent) return true;
  const binding = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : {};
  const phase45 = phase45Of(caseObj);
  const rowPlan = caseObj.rowExecutionPlan && typeof caseObj.rowExecutionPlan === 'object'
    ? caseObj.rowExecutionPlan
    : (binding.rowExecutionPlan && typeof binding.rowExecutionPlan === 'object'
      ? binding.rowExecutionPlan
      : (phase45.rowExecutionPlan && typeof phase45.rowExecutionPlan === 'object' ? phase45.rowExecutionPlan : {}));
  const haystack = [
    caseObj.name,
    caseObj.caseIntent,
    caseObj.intent,
    binding.intent,
    binding.rowIntent,
    binding.rowSelector,
    arr(binding.rowIntents).join(' '),
    arr(caseObj.rowIntents).join(' '),
    arr(rowPlan.rowIntents).join(' '),
    arr(rowPlan.rows).map((row) => row && (row.intent || row.rowIntent || row.caseIntent)).join(' '),
    arr(binding.rows).map((row) => row && (row.intent || row.caseIntent || row.rowIntent)).join(' '),
  ].map(clean).join(' ').toLowerCase();
  return haystack.includes(clean(intent).toLowerCase());
}

function compareExpectedItem(scenarios, expected = {}, context = {}) {
  const identityMap = context.coverageIdentityMap || buildCoverageIdentityMap(context.coverageManifest || context.manifest || { items: context.expectedItems || [expected] });
  const requestedCoverageRef = expected.coverageRef || expected.manifestItemId || expected.id;
  const coverageRef = resolveCoverageRef(requestedCoverageRef, identityMap);
  const matches = casesForCoverageRef(scenarios, requestedCoverageRef, identityMap);
  const failures = [];
  if (!matches.length) {
    failures.push({
      code: 'benchmark_missing_coverage_ref',
      coverageRef: requestedCoverageRef,
      resolvedCoverageRef: coverageRef,
      aliases: coverageAliasesFor(requestedCoverageRef, identityMap),
      message: `No generated case cites coverageRef "${requestedCoverageRef}".`,
    });
    return failures;
  }
  const coverageManifest = {
    items: [{
      manifestItemId: coverageRef,
      coverageRef,
      benchmarkAliases: coverageAliasesFor(requestedCoverageRef, identityMap),
      requiredFields: arr(expected.requiredFields),
      requiredOracles: arr(expected.requiredOracles),
    }],
  };
  const caseDefects = matches.flatMap(({ scenario, caseObj }) => collectScenarioReliabilityDefects([
    { ...scenario, cases: [caseObj] },
  ], {
    ...context,
    coverageManifest,
  }));
  for (const field of arr(expected.requiredFields)) {
    const fieldCovered = matches.some(({ caseObj }) => {
      const normalized = normalizeStepsInput(caseObj.steps, { allowSingletonObject: false });
      return normalized.ok && fieldPresentInSteps(field, normalized.steps);
    });
    if (!fieldCovered) {
      failures.push({
        code: 'benchmark_missing_required_field',
        coverageRef,
        field,
        message: `Required field "${field}" is not exercised for "${coverageRef}".`,
      });
    }
  }
  for (const expectedOracle of arr(expected.requiredOracles)) {
    const matchedOracle = matches.some(({ caseObj }) => (
      buildStructuredOracles(caseObj).some((oracle) => oracleMatches(oracle, expectedOracle))
    ));
    if (!matchedOracle) {
      failures.push({
        code: 'benchmark_missing_required_oracle',
        coverageRef,
        oracle: expectedOracle,
        message: `Required oracle ${expectedOracle.kind || '*'}:${expectedOracle.target || '*'} is missing for "${coverageRef}".`,
      });
    }
  }
  for (const intent of arr(expected.dataRowIntents)) {
    if (!matches.some(({ caseObj }) => rowIntentMatches(caseObj, intent))) {
      failures.push({
        code: 'benchmark_missing_row_intent',
        coverageRef,
        intent,
        message: `Required data row intent "${intent}" is missing for "${coverageRef}".`,
      });
    }
  }
  const blockingDefects = caseDefects.filter((defect) => [
    'missing_required_story_field',
    'weak_oracle',
    'missing_structured_oracle',
    'verify_kind_none',
    'missing_row_execution_plan',
    'silent_row_skip',
    'token_collision',
    'coverage_owner_unknown',
    'wrong_coverage_owner',
    'unregistered_browser_action',
  ].includes(defect.code));
  for (const defect of blockingDefects) {
    failures.push({
      code: 'benchmark_contract_defect',
      coverageRef,
      defectCode: defect.code,
      message: defect.message,
      evidence: defect.evidence,
    });
  }
  return failures;
}

function compareScenarioBenchmark({ scenarios = [], expected = {}, context = {} } = {}) {
  const expectedItems = arr(expected.items || expected.requiredCoverage || expected);
  const coverageIdentityMap = context.coverageIdentityMap || buildCoverageIdentityMap(context.coverageManifest || context.manifest || { items: expectedItems });
  const failures = expectedItems.flatMap((item) => compareExpectedItem(scenarios, item, {
    ...context,
    coverageIdentityMap,
    expectedItems,
  }));
  return {
    schemaVersion: expected.schemaVersion || 'qaai.reliability.benchmark.v1',
    benchmarkId: expected.id || expected.name || 'benchmark',
    ok: failures.length === 0,
    expectedItems: expectedItems.length,
    failures,
  };
}

function compareNegativeRegression({ scenarios = [], regression = {}, context = {} } = {}) {
  const defects = collectScenarioReliabilityDefects(scenarios, context);
  const defectCodes = new Set(defects.map((defect) => defect.code));
  const expectedCodes = arr(regression.expectedDefectCodes || regression.defectCodes);
  const missing = expectedCodes.filter((code) => !defectCodes.has(code));
  return {
    id: regression.id || regression.name || 'negative_regression',
    ok: missing.length === 0,
    expectedDefectCodes: expectedCodes,
    actualDefectCodes: Array.from(defectCodes).sort(),
    missingDefectCodes: missing,
  };
}

function compareNegativeRegressions({ fixtures = [], context = {} } = {}) {
  const results = arr(fixtures).map((fixture) => compareNegativeRegression({
    scenarios: fixture.scenarios || [],
    regression: fixture,
    context: {
      ...context,
      ...(fixture.context || {}),
    },
  }));
  return {
    ok: results.every((result) => result.ok),
    results,
  };
}

module.exports = {
  compareScenarioBenchmark,
  compareNegativeRegression,
  compareNegativeRegressions,
};
