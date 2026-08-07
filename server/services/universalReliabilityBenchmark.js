'use strict';

const METRICS = Object.freeze({
  TARGET_IDENTITY: 'correct_target_identity',
  EXACTLY_ONE_DISPATCH: 'exactly_one_dispatch',
  FINAL_OWNER_VALUE: 'final_owner_value',
  POPUP_OWNERSHIP: 'popup_ownership',
  ASSERTION_TRUTH: 'assertion_truth',
  CONTINUATION: 'continuation',
  SESSION_IDENTITY: 'session_identity',
  SCRIPT_PARITY: 'script_parity',
});

const REQUIRED_FAMILIES = Object.freeze([
  'native_html',
  'aria_combobox',
  'custom_combobox',
  'autocomplete',
  'date_picker',
  'time_picker',
  'toggle',
  'accordion',
  'grid',
  'iframe',
  'shadow_dom',
  'delayed_evidence_loss',
  'dependent_grouped_cases',
]);

const DEFAULT_CHAOS_SEED_COUNT = 20;
const DEFAULT_REQUIRED_CONSECUTIVE_RUNS = 5;

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function normalizedScalar(value) {
  return clean(value).replace(/\s+/g, ' ').toLowerCase();
}

function identityKey(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return normalizedScalar(value);
  return stableJson({
    backendNodeId: value.backendNodeId ?? null,
    ref: clean(value.ref || value.elementRef || '') || null,
    role: normalizedScalar(value.role || value.type || '') || null,
    name: normalizedScalar(value.name || value.label || value.accessibleName || '') || null,
    framePath: Array.isArray(value.framePath) ? value.framePath.map(normalizedScalar) : [],
    shadowPath: Array.isArray(value.shadowPath) ? value.shadowPath.map(normalizedScalar) : [],
  });
}

function sameIdentity(expected, observed) {
  const left = identityKey(expected);
  const right = identityKey(observed);
  return !!left && !!right && left === right;
}

function sameValue(expected, observed) {
  if (Array.isArray(expected) || Array.isArray(observed)) {
    return stableJson(expected) === stableJson(observed);
  }
  if (expected && typeof expected === 'object') return stableJson(expected) === stableJson(observed);
  return clean(expected) === clean(observed);
}

function metricFinding(metric, status, code, details = {}) {
  return {
    metric,
    status,
    passed: status === 'passed',
    code,
    ...details,
  };
}

function notApplicable(metric) {
  return metricFinding(metric, 'not_applicable', 'metric_not_applicable');
}

function proofAvailable(evidence, metric) {
  return evidence?.proof?.[metric] === true;
}

function requireProof(evidence, metric, evaluator) {
  if (!proofAvailable(evidence, metric)) {
    return metricFinding(metric, 'failed', 'metric_proof_missing', {
      expected: evidence?.expected?.[metric] ?? null,
      observed: evidence?.observed?.[metric] ?? null,
    });
  }
  return evaluator();
}

function stateChangingDispatches(evidence) {
  const dispatches = Array.isArray(evidence?.observed?.dispatches)
    ? evidence.observed.dispatches
    : [];
  return dispatches.filter((dispatch) => dispatch && dispatch.stateChanging !== false);
}

function scoreTargetIdentity(evidence) {
  return requireProof(evidence, METRICS.TARGET_IDENTITY, () => {
    const expected = evidence.expected?.targetIdentity;
    const observed = evidence.observed?.targetIdentity;
    return sameIdentity(expected, observed)
      ? metricFinding(METRICS.TARGET_IDENTITY, 'passed', 'target_identity_exact', { expected, observed })
      : metricFinding(METRICS.TARGET_IDENTITY, 'failed', 'target_identity_mismatch', { expected, observed });
  });
}

function scoreExactlyOneDispatch(evidence) {
  return requireProof(evidence, METRICS.EXACTLY_ONE_DISPATCH, () => {
    const dispatches = stateChangingDispatches(evidence);
    return dispatches.length === 1
      ? metricFinding(METRICS.EXACTLY_ONE_DISPATCH, 'passed', 'one_state_change_dispatched', {
        dispatchCount: 1,
        actionOccurrenceId: dispatches[0].actionOccurrenceId || null,
      })
      : metricFinding(METRICS.EXACTLY_ONE_DISPATCH, 'failed', 'state_change_dispatch_count_mismatch', {
        expected: 1,
        observed: dispatches.length,
        actionOccurrenceIds: dispatches.map((entry) => entry.actionOccurrenceId || null),
      });
  });
}

function scoreFinalOwnerValue(evidence) {
  if (evidence.expected?.finalOwnerValue === undefined) return notApplicable(METRICS.FINAL_OWNER_VALUE);
  return requireProof(evidence, METRICS.FINAL_OWNER_VALUE, () => {
    const expected = evidence.expected.finalOwnerValue;
    const observed = evidence.observed?.finalOwnerValue;
    return sameValue(expected, observed)
      ? metricFinding(METRICS.FINAL_OWNER_VALUE, 'passed', 'owner_value_exact', { expected, observed })
      : metricFinding(METRICS.FINAL_OWNER_VALUE, 'failed', 'owner_value_mismatch', { expected, observed });
  });
}

function scorePopupOwnership(evidence) {
  if (evidence.expected?.popupOwnerIdentity === undefined) return notApplicable(METRICS.POPUP_OWNERSHIP);
  return requireProof(evidence, METRICS.POPUP_OWNERSHIP, () => {
    const expected = evidence.expected.popupOwnerIdentity;
    const observed = evidence.observed?.popupOwnerIdentity;
    return sameIdentity(expected, observed)
      ? metricFinding(METRICS.POPUP_OWNERSHIP, 'passed', 'popup_owner_exact', { expected, observed })
      : metricFinding(METRICS.POPUP_OWNERSHIP, 'failed', 'popup_owner_mismatch', { expected, observed });
  });
}

function scoreAssertionTruth(evidence) {
  return requireProof(evidence, METRICS.ASSERTION_TRUTH, () => {
    const expected = evidence.expected?.assertionTruth;
    const observed = evidence.observed?.assertionTruth;
    const exact = observed?.checked === true
      && typeof observed?.matched === 'boolean'
      && observed.matched === expected?.matched
      && (!expected?.channel || observed.channel === expected.channel);
    return exact
      ? metricFinding(METRICS.ASSERTION_TRUTH, 'passed', 'assertion_truth_exact', { expected, observed })
      : metricFinding(METRICS.ASSERTION_TRUTH, 'failed', 'assertion_truth_mismatch_or_unchecked', { expected, observed });
  });
}

function scoreContinuation(evidence) {
  return requireProof(evidence, METRICS.CONTINUATION, () => {
    const expected = evidence.expected?.continuation;
    const observed = evidence.observed?.continuation;
    const exact = observed
      && observed.continueExecution === expected?.continueExecution
      && observed.blockDependents === expected?.blockDependents
      && observed.stopRun === expected?.stopRun;
    return exact
      ? metricFinding(METRICS.CONTINUATION, 'passed', 'continuation_policy_exact', { expected, observed })
      : metricFinding(METRICS.CONTINUATION, 'failed', 'continuation_policy_mismatch', { expected, observed });
  });
}

function scoreSessionIdentity(evidence) {
  if (evidence.expected?.sessionIdentity === undefined) return notApplicable(METRICS.SESSION_IDENTITY);
  return requireProof(evidence, METRICS.SESSION_IDENTITY, () => {
    const expected = evidence.expected.sessionIdentity;
    const observed = evidence.observed?.sessionIdentity;
    return stableJson(expected) === stableJson(observed)
      ? metricFinding(METRICS.SESSION_IDENTITY, 'passed', 'session_identity_preserved', { expected, observed })
      : metricFinding(METRICS.SESSION_IDENTITY, 'failed', 'session_identity_mismatch', { expected, observed });
  });
}

function scoreScriptParity(evidence) {
  return requireProof(evidence, METRICS.SCRIPT_PARITY, () => {
    const expected = evidence.expected?.scriptParity;
    const observed = evidence.observed?.scriptParity;
    return stableJson(expected) === stableJson(observed)
      ? metricFinding(METRICS.SCRIPT_PARITY, 'passed', 'script_parity_exact', { expected, observed })
      : metricFinding(METRICS.SCRIPT_PARITY, 'failed', 'script_parity_mismatch', { expected, observed });
  });
}

const METRIC_SCORERS = Object.freeze([
  scoreTargetIdentity,
  scoreExactlyOneDispatch,
  scoreFinalOwnerValue,
  scorePopupOwnership,
  scoreAssertionTruth,
  scoreContinuation,
  scoreSessionIdentity,
  scoreScriptParity,
]);

function scoreBenchmarkCase(evidence = {}) {
  const metrics = METRIC_SCORERS.map((score) => score(evidence));
  const applicable = metrics.filter((metric) => metric.status !== 'not_applicable');
  const passedCount = applicable.filter((metric) => metric.passed).length;
  const failed = applicable.filter((metric) => !metric.passed);
  return {
    id: clean(evidence.id) || 'unnamed-benchmark-case',
    family: clean(evidence.family) || 'unknown',
    passed: applicable.length > 0 && failed.length === 0,
    scorePercent: applicable.length ? Math.round((passedCount / applicable.length) * 100) : 0,
    metrics,
    findings: failed,
    proofMode: evidence.proofMode === 'live' ? 'live' : 'simulated',
    liveProof: evidence.proofMode === 'live' && evidence.liveProof === true,
  };
}

function evaluateUniversalBenchmark(input = {}) {
  const cases = Array.isArray(input.cases) ? input.cases : [];
  const results = cases.map(scoreBenchmarkCase);
  const presentFamilies = new Set(results.map((result) => result.family));
  const missingFamilies = REQUIRED_FAMILIES.filter((family) => !presentFamilies.has(family));
  const coverageFindings = missingFamilies.map((family) => ({
    metric: 'corpus_coverage',
    status: 'failed',
    passed: false,
    code: 'required_family_missing',
    family,
  }));
  const metricSummary = {};
  for (const metric of Object.values(METRICS)) {
    const entries = results.flatMap((result) => result.metrics.filter((entry) => entry.metric === metric));
    const applicable = entries.filter((entry) => entry.status !== 'not_applicable');
    metricSummary[metric] = {
      applicable: applicable.length,
      passed: applicable.filter((entry) => entry.passed).length,
      failed: applicable.filter((entry) => !entry.passed).length,
      status: applicable.length > 0 && applicable.every((entry) => entry.passed) ? 'passed' : 'failed',
    };
  }
  const findings = [...coverageFindings, ...results.flatMap((result) => result.findings.map((finding) => ({
    caseId: result.id,
    family: result.family,
    ...finding,
  })))];
  const liveCaseCount = results.filter((result) => result.liveProof).length;
  return {
    passed: cases.length > 0 && findings.length === 0,
    scorePercent: results.length
      ? Math.round(results.reduce((total, result) => total + result.scorePercent, 0) / results.length)
      : 0,
    cases: results,
    metricSummary,
    corpusCoverage: {
      required: [...REQUIRED_FAMILIES],
      present: [...presentFamilies],
      missing: missingFamilies,
      passed: missingFamilies.length === 0,
    },
    findings,
    proof: {
      liveCaseCount,
      totalCaseCount: results.length,
      fullyLive: results.length > 0 && liveCaseCount === results.length,
      finding: liveCaseCount === results.length && results.length > 0
        ? null
        : 'live_proof_not_supplied_for_every_case',
    },
  };
}

function identity(name, extras = {}) {
  return { role: 'control', name, framePath: ['main'], shadowPath: [], ...extras };
}

function proofFor(applicable) {
  return Object.fromEntries(applicable.map((metric) => [metric, true]));
}

function parityFor(id, assertions = 1) {
  return {
    actionCount: 1,
    assertionCount: assertions,
    locatorIdentities: [id],
    urlTransitions: [],
    failureBoundary: null,
  };
}

function benchmarkFixture({
  id,
  family,
  target,
  finalOwnerValue,
  popupOwnerIdentity,
  sessionIdentity,
  assertionMatched = true,
  assertionChannel = 'dom_visible_text',
  proofMode = 'simulated',
  liveProof = false,
}) {
  const applicable = [
    METRICS.TARGET_IDENTITY,
    METRICS.EXACTLY_ONE_DISPATCH,
    METRICS.ASSERTION_TRUTH,
    METRICS.CONTINUATION,
    METRICS.SCRIPT_PARITY,
  ];
  if (finalOwnerValue !== undefined) applicable.push(METRICS.FINAL_OWNER_VALUE);
  if (popupOwnerIdentity !== undefined) applicable.push(METRICS.POPUP_OWNERSHIP);
  if (sessionIdentity !== undefined) applicable.push(METRICS.SESSION_IDENTITY);
  const scriptParity = parityFor(identityKey(target));
  return {
    id,
    family,
    proofMode,
    liveProof,
    expected: {
      targetIdentity: target,
      ...(finalOwnerValue !== undefined ? { finalOwnerValue } : {}),
      ...(popupOwnerIdentity !== undefined ? { popupOwnerIdentity } : {}),
      assertionTruth: { matched: assertionMatched, channel: assertionChannel },
      continuation: { continueExecution: true, blockDependents: false, stopRun: false },
      ...(sessionIdentity !== undefined ? { sessionIdentity } : {}),
      scriptParity,
    },
    observed: {
      targetIdentity: target,
      dispatches: [{ actionOccurrenceId: `${id}:action:1`, stateChanging: true, status: 'dispatched' }],
      ...(finalOwnerValue !== undefined ? { finalOwnerValue } : {}),
      ...(popupOwnerIdentity !== undefined ? { popupOwnerIdentity } : {}),
      assertionTruth: { checked: true, matched: assertionMatched, channel: assertionChannel },
      continuation: { continueExecution: true, blockDependents: false, stopRun: false },
      ...(sessionIdentity !== undefined ? { sessionIdentity } : {}),
      scriptParity,
      observationTrace: [{ available: true, matched: true }],
    },
    proof: proofFor(applicable),
  };
}

function buildUniversalBenchmarkCorpus(options = {}) {
  const proofMode = options.proofMode === 'live' ? 'live' : 'simulated';
  const liveProof = proofMode === 'live' && options.liveProof === true;
  const sharedSession = {
    browserId: 'browser-1',
    contextId: 'context-1',
    pageId: 'page-1',
    sessionToken: 'session-1',
  };
  const fixtures = [
    benchmarkFixture({ id: 'native-textbox', family: 'native_html', target: identity('Customer name', { role: 'textbox' }), finalOwnerValue: 'Ada', proofMode, liveProof }),
    benchmarkFixture({ id: 'aria-combobox', family: 'aria_combobox', target: identity('Equipment', { role: 'combobox' }), finalOwnerValue: 'LTL', popupOwnerIdentity: identity('Equipment', { role: 'combobox' }), proofMode, liveProof }),
    benchmarkFixture({ id: 'custom-combobox', family: 'custom_combobox', target: identity('Status', { role: 'combobox' }), finalOwnerValue: 'Active', popupOwnerIdentity: identity('Status', { role: 'combobox' }), proofMode, liveProof }),
    benchmarkFixture({ id: 'autocomplete', family: 'autocomplete', target: identity('Organization', { role: 'combobox' }), finalOwnerValue: 'North Region', popupOwnerIdentity: identity('Organization', { role: 'combobox' }), proofMode, liveProof }),
    benchmarkFixture({ id: 'date-picker', family: 'date_picker', target: identity('Start date', { role: 'textbox' }), finalOwnerValue: '2026-08-20', popupOwnerIdentity: identity('Start date', { role: 'textbox' }), proofMode, liveProof }),
    benchmarkFixture({ id: 'time-picker', family: 'time_picker', target: identity('Start time', { role: 'combobox' }), finalOwnerValue: '09:00', popupOwnerIdentity: identity('Start time', { role: 'combobox' }), proofMode, liveProof }),
    benchmarkFixture({ id: 'toggle', family: 'toggle', target: identity('Notifications', { role: 'switch' }), finalOwnerValue: true, proofMode, liveProof }),
    benchmarkFixture({ id: 'accordion', family: 'accordion', target: identity('Planning details', { role: 'button' }), finalOwnerValue: 'expanded', proofMode, liveProof }),
    benchmarkFixture({ id: 'grid', family: 'grid', target: identity('Orders grid', { role: 'grid' }), assertionChannel: 'scoped_collection', proofMode, liveProof }),
    benchmarkFixture({ id: 'iframe-control', family: 'iframe', target: identity('Payment method', { role: 'combobox', framePath: ['main', 'payment-frame'] }), finalOwnerValue: 'Invoice', popupOwnerIdentity: identity('Payment method', { role: 'combobox', framePath: ['main', 'payment-frame'] }), proofMode, liveProof }),
    benchmarkFixture({ id: 'shadow-control', family: 'shadow_dom', target: identity('Theme', { role: 'combobox', shadowPath: ['settings-shell'] }), finalOwnerValue: 'Dark', popupOwnerIdentity: identity('Theme', { role: 'combobox', shadowPath: ['settings-shell'] }), proofMode, liveProof }),
    benchmarkFixture({ id: 'delayed-proof', family: 'delayed_evidence_loss', target: identity('Delayed submit', { role: 'button' }), proofMode, liveProof }),
    benchmarkFixture({ id: 'dependent-cases', family: 'dependent_grouped_cases', target: identity('Continue workflow', { role: 'button' }), sessionIdentity: sharedSession, proofMode, liveProof }),
  ];
  return fixtures;
}

function deterministicChaosConfig(seed) {
  let state = (Number(seed) >>> 0) || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const lossCount = 1 + Math.floor(next() * 3);
  const delayedObservationCount = lossCount + 1 + Math.floor(next() * 3);
  const delayMs = 20 + Math.floor(next() * 481);
  return {
    seed: Number(seed),
    lossCount,
    delayedObservationCount,
    delayMs,
  };
}

function applyChaosToCorpus(cases, config) {
  return cases.map((fixture, index) => {
    const lossCount = fixture.family === 'delayed_evidence_loss'
      ? config.lossCount + 1
      : (index + config.seed) % 3 === 0 ? config.lossCount : 0;
    const unavailable = Array.from({ length: lossCount }, (_, attempt) => ({
      attempt,
      available: false,
      matched: false,
      reason: 'temporary_snapshot_unavailable',
      delayMs: config.delayMs,
    }));
    return {
      ...fixture,
      observed: {
        ...fixture.observed,
        observationTrace: [
          ...unavailable,
          { attempt: unavailable.length, available: true, matched: true, reason: 'canonical_proof_observed' },
        ],
        continuation: { continueExecution: true, blockDependents: false, stopRun: false },
      },
      chaos: { ...config, temporaryEvidenceLossCount: lossCount },
    };
  });
}

async function runDeterministicChaosBenchmark(options = {}) {
  const seedCount = Number.isFinite(Number(options.seedCount))
    ? Math.max(1, Math.floor(Number(options.seedCount)))
    : DEFAULT_CHAOS_SEED_COUNT;
  const startSeed = Number.isFinite(Number(options.startSeed)) ? Math.floor(Number(options.startSeed)) : 1;
  const runs = [];
  for (let offset = 0; offset < seedCount; offset += 1) {
    const config = deterministicChaosConfig(startSeed + offset);
    const baseCorpus = buildUniversalBenchmarkCorpus({ proofMode: 'simulated', liveProof: false });
    const supplied = typeof options.executeSeed === 'function'
      ? await options.executeSeed({ config, cases: baseCorpus })
      : { cases: applyChaosToCorpus(baseCorpus, config), proofMode: 'simulated', liveProof: false };
    const cases = Array.isArray(supplied?.cases) ? supplied.cases : [];
    const proofMode = supplied?.proofMode === 'live' ? 'live' : 'simulated';
    const liveProof = proofMode === 'live' && supplied?.liveProof === true;
    const normalizedCases = cases.map((fixture) => ({ ...fixture, proofMode, liveProof }));
    const benchmark = evaluateUniversalBenchmark({ cases: normalizedCases });
    const duplicateFindings = benchmark.findings.filter((finding) => finding.metric === METRICS.EXACTLY_ONE_DISPATCH);
    const falseBlockFindings = normalizedCases.filter((fixture) => {
      const hadTemporaryLoss = fixture.observed?.observationTrace?.some((entry) => entry.available === false);
      return hadTemporaryLoss && fixture.observed?.continuation?.blockDependents === true;
    });
    runs.push({
      seed: config.seed,
      config,
      proofMode,
      liveProof,
      benchmark,
      benchmarkPassed: benchmark.passed,
      zeroDuplicateStateChangingActions: duplicateFindings.length === 0,
      noFalseBlockFromTemporaryEvidenceLoss: falseBlockFindings.length === 0,
      findings: [
        ...benchmark.findings,
        ...falseBlockFindings.map((fixture) => ({
          caseId: fixture.id,
          metric: METRICS.CONTINUATION,
          status: 'failed',
          code: 'temporary_evidence_loss_caused_false_block',
        })),
        ...(!liveProof ? [{
          metric: 'live_proof',
          status: 'failed',
          code: 'live_proof_not_supplied',
        }] : []),
      ],
    });
  }
  const simulationPassed = runs.every((run) => run.benchmarkPassed
    && run.zeroDuplicateStateChangingActions
    && run.noFalseBlockFromTemporaryEvidenceLoss);
  return {
    seedCount,
    runs,
    simulationPassed,
    zeroDuplicateStateChangingActions: runs.every((run) => run.zeroDuplicateStateChangingActions),
    noFalseBlockFromTemporaryEvidenceLoss: runs.every((run) => run.noFalseBlockFromTemporaryEvidenceLoss),
    liveAcceptanceEligible: runs.every((run) => run.liveProof),
    findings: [
      ...(!simulationPassed ? [{ status: 'failed', code: 'chaos_simulation_failed' }] : []),
      ...(!runs.every((run) => run.liveProof) ? [{ status: 'failed', code: 'live_proof_not_supplied_for_chaos_runs' }] : []),
    ],
  };
}

function evaluateGroupedRunAcceptance(options = {}) {
  const runs = Array.isArray(options.runs) ? options.runs : [];
  const requiredConsecutive = Number.isFinite(Number(options.requiredConsecutive))
    ? Math.max(1, Math.floor(Number(options.requiredConsecutive)))
    : DEFAULT_REQUIRED_CONSECUTIVE_RUNS;
  let consecutive = 0;
  let maxConsecutive = 0;
  const findings = [];
  const runResults = runs.map((run, index) => {
    const reasons = [];
    if (run?.proofMode !== 'live' || run?.liveProof !== true) reasons.push('live_proof_missing');
    if (run?.benchmarkPassed !== true) reasons.push('benchmark_failed');
    if (run?.zeroDuplicateStateChangingActions !== true) reasons.push('duplicate_state_change_detected');
    if (run?.noFalseBlockFromTemporaryEvidenceLoss !== true) reasons.push('temporary_evidence_false_block');
    if (run?.sessionIdentityPreserved !== true) {
      reasons.push(run?.sessionIdentityPreserved === false
        ? 'dependent_session_identity_mismatch'
        : 'dependent_session_identity_proof_missing');
    }
    if (run?.scriptParityPassed !== true) {
      reasons.push(run?.scriptParityPassed === false
        ? 'script_parity_failed'
        : 'script_parity_proof_missing');
    }
    const passed = reasons.length === 0;
    consecutive = passed ? consecutive + 1 : 0;
    maxConsecutive = Math.max(maxConsecutive, consecutive);
    if (!passed) findings.push(...reasons.map((code) => ({ runIndex: index, status: 'failed', code })));
    return { index, passed, reasons, consecutiveAtRun: consecutive };
  });
  const accepted = maxConsecutive >= requiredConsecutive;
  if (!accepted) {
    findings.push({
      status: 'failed',
      code: 'required_consecutive_live_runs_not_met',
      requiredConsecutive,
      maxConsecutive,
    });
  }
  return {
    accepted,
    requiredConsecutive,
    maxConsecutive,
    runResults,
    findings,
  };
}

module.exports = {
  METRICS,
  REQUIRED_FAMILIES,
  DEFAULT_CHAOS_SEED_COUNT,
  DEFAULT_REQUIRED_CONSECUTIVE_RUNS,
  identityKey,
  scoreBenchmarkCase,
  evaluateUniversalBenchmark,
  buildUniversalBenchmarkCorpus,
  deterministicChaosConfig,
  applyChaosToCorpus,
  runDeterministicChaosBenchmark,
  evaluateGroupedRunAcceptance,
};
