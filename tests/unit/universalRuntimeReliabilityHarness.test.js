import { describe, expect, it } from 'vitest';
import harness from '../../server/services/universalRuntimeReliabilityHarness.js';

describe('universal runtime reliability harness', () => {
  it('executes 20 evidence-loss runs without duplicate state-changing dispatches or false blocks', async () => {
    const result = await harness.runExactlyOnceChaosTransactions();

    expect(result.seedCount).toBe(20);
    expect(result.runs).toHaveLength(20);
    expect(result.passed).toBe(true);
    expect(result.zeroDuplicateStateChangingActions).toBe(true);
    expect(result.noFalseBlockFromTemporaryEvidenceLoss).toBe(true);
    expect(result.runs.every((run) => run.dispatchCount === 1)).toBe(true);
    expect(result.runs.every((run) => run.observationCount > run.config.lossCount)).toBe(true);
    expect(result.runs.every((run) => run.transactionStatus === 'committed')).toBe(true);
    expect(new Set(result.runs.map((run) => run.actionOccurrenceId)).size).toBe(20);
  });

  it('executes five dependent case chains with one session and faithful failed-assertion scripts', async () => {
    const result = await harness.runGroupedSessionRuntimeHarness();

    expect(result.runCount).toBe(5);
    expect(result.runs).toHaveLength(5);
    expect(result.passed).toBe(true);
    expect(result.requiredConsecutiveRunsMet).toBe(true);
    for (const run of result.runs) {
      expect(run).toMatchObject({
        passed: true,
        proofMode: 'runtime_harness',
        liveProof: false,
        createSessionCount: 1,
        actionDispatchCount: 1,
        sessionIdentityPreserved: true,
        validationContinued: true,
        scriptParityPassed: true,
        canonicalScriptLineCount: 2,
      });
    }
  });
});
