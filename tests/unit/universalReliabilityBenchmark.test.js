import { describe, expect, it } from 'vitest';
import benchmark from '../../server/services/universalReliabilityBenchmark.js';

const {
  METRICS,
  REQUIRED_FAMILIES,
  buildUniversalBenchmarkCorpus,
  evaluateUniversalBenchmark,
  runDeterministicChaosBenchmark,
  evaluateGroupedRunAcceptance,
} = benchmark;

describe('universal reliability benchmark', () => {
  it('covers every required website-neutral control and continuity family', () => {
    const cases = buildUniversalBenchmarkCorpus();
    const result = evaluateUniversalBenchmark({ cases });

    expect(cases.map((entry) => entry.family)).toEqual(expect.arrayContaining(REQUIRED_FAMILIES));
    expect(result.corpusCoverage.missing).toEqual([]);
    expect(result.passed).toBe(true);
    expect(Object.keys(result.metricSummary)).toEqual(expect.arrayContaining(Object.values(METRICS)));
    expect(result.proof.fullyLive).toBe(false);
    expect(result.proof.finding).toBe('live_proof_not_supplied_for_every_case');
  });

  it('fails explicitly when a state-changing action is dispatched twice', () => {
    const cases = buildUniversalBenchmarkCorpus();
    cases[0].observed.dispatches.push({
      actionOccurrenceId: 'native-textbox:action:retry',
      stateChanging: true,
      status: 'dispatched',
    });

    const result = evaluateUniversalBenchmark({ cases });
    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        caseId: 'native-textbox',
        metric: METRICS.EXACTLY_ONE_DISPATCH,
        code: 'state_change_dispatch_count_mismatch',
        observed: 2,
      }),
    ]));
  });

  it('detects wrong target identity, popup owner, and final owner value independently', () => {
    const cases = buildUniversalBenchmarkCorpus();
    const dropdown = cases.find((entry) => entry.id === 'aria-combobox');
    dropdown.observed.targetIdentity = { role: 'textbox', name: 'Pickup number', framePath: ['main'], shadowPath: [] };
    dropdown.observed.popupOwnerIdentity = { role: 'combobox', name: 'Ship direction', framePath: ['main'], shadowPath: [] };
    dropdown.observed.finalOwnerValue = 'RR';

    const result = evaluateUniversalBenchmark({ cases });
    const codes = result.findings.filter((entry) => entry.caseId === dropdown.id).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining([
      'target_identity_mismatch',
      'popup_owner_mismatch',
      'owner_value_mismatch',
    ]));
  });

  it('does not let exact assertion failure hide behind successful continuation', () => {
    const cases = buildUniversalBenchmarkCorpus();
    const grid = cases.find((entry) => entry.family === 'grid');
    grid.observed.assertionTruth = { checked: true, matched: false, channel: 'scoped_collection' };
    grid.observed.continuation = { continueExecution: true, blockDependents: false, stopRun: false };

    const result = evaluateUniversalBenchmark({ cases });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseId: grid.id, metric: METRICS.ASSERTION_TRUTH, code: 'assertion_truth_mismatch_or_unchecked' }),
    ]));
    const continuation = result.cases.find((entry) => entry.id === grid.id).metrics
      .find((entry) => entry.metric === METRICS.CONTINUATION);
    expect(continuation.passed).toBe(true);
  });

  it('fails script parity and dependent session identity mismatches', () => {
    const cases = buildUniversalBenchmarkCorpus();
    const grouped = cases.find((entry) => entry.family === 'dependent_grouped_cases');
    grouped.observed.sessionIdentity = { ...grouped.observed.sessionIdentity, contextId: 'new-context' };
    grouped.observed.scriptParity = { ...grouped.observed.scriptParity, actionCount: 0 };

    const result = evaluateUniversalBenchmark({ cases });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseId: grouped.id, metric: METRICS.SESSION_IDENTITY, code: 'session_identity_mismatch' }),
      expect.objectContaining({ caseId: grouped.id, metric: METRICS.SCRIPT_PARITY, code: 'script_parity_mismatch' }),
    ]));
  });

  it('runs 20 deterministic delay and snapshot-loss seeds with no duplicate actions or false blocks', async () => {
    const result = await runDeterministicChaosBenchmark();

    expect(result.seedCount).toBe(20);
    expect(result.runs).toHaveLength(20);
    expect(result.simulationPassed).toBe(true);
    expect(result.zeroDuplicateStateChangingActions).toBe(true);
    expect(result.noFalseBlockFromTemporaryEvidenceLoss).toBe(true);
    expect(result.runs.every((run) => run.benchmarkPassed)).toBe(true);
    expect(result.runs.every((run) => run.zeroDuplicateStateChangingActions)).toBe(true);
    expect(result.runs.every((run) => run.noFalseBlockFromTemporaryEvidenceLoss)).toBe(true);
    expect(result.runs.every((run) => run.config.lossCount >= 1)).toBe(true);
    expect(result.runs.every((run) => run.benchmark.cases.some((testCase) => (
      testCase.id === 'delayed-proof' && testCase.passed
    )))).toBe(true);
    expect(result.liveAcceptanceEligible).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'live_proof_not_supplied_for_chaos_runs' }));
  });

  it('does not accept simulated runs as the five required live grouped runs', () => {
    const simulated = Array.from({ length: 5 }, () => ({
      proofMode: 'simulated',
      liveProof: false,
      benchmarkPassed: true,
      zeroDuplicateStateChangingActions: true,
      noFalseBlockFromTemporaryEvidenceLoss: true,
      sessionIdentityPreserved: true,
      scriptParityPassed: true,
    }));

    const result = evaluateGroupedRunAcceptance({ runs: simulated });
    expect(result.accepted).toBe(false);
    expect(result.maxConsecutive).toBe(0);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'live_proof_missing' }),
      expect.objectContaining({ code: 'required_consecutive_live_runs_not_met' }),
    ]));
  });

  it('requires five consecutive passing live grouped runs and resets after a failure', () => {
    const pass = {
      proofMode: 'live',
      liveProof: true,
      benchmarkPassed: true,
      zeroDuplicateStateChangingActions: true,
      noFalseBlockFromTemporaryEvidenceLoss: true,
      sessionIdentityPreserved: true,
      scriptParityPassed: true,
    };
    const fail = { ...pass, sessionIdentityPreserved: false };

    const fourThenFailure = evaluateGroupedRunAcceptance({ runs: [pass, pass, pass, pass, fail, pass] });
    expect(fourThenFailure.accepted).toBe(false);
    expect(fourThenFailure.maxConsecutive).toBe(4);

    const five = evaluateGroupedRunAcceptance({ runs: [pass, pass, pass, pass, pass] });
    expect(five.accepted).toBe(true);
    expect(five.maxConsecutive).toBe(5);
    expect(five.findings).toEqual([]);
  });

  it('reports missing metric proof as a failure instead of inferring success', () => {
    const cases = buildUniversalBenchmarkCorpus();
    delete cases[0].proof[METRICS.TARGET_IDENTITY];

    const result = evaluateUniversalBenchmark({ cases });
    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      caseId: 'native-textbox',
      metric: METRICS.TARGET_IDENTITY,
      code: 'metric_proof_missing',
    }));
  });
});
