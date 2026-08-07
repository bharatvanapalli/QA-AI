import { describe, expect, it, vi } from 'vitest';
import runnerModule from '../../server/services/agents/conductorRunner';

const { applyAgentCaseRevision, assertRunnerExecutionLineage } = runnerModule;

describe('Conductor runner immutable approved-case authority', () => {
  it('keeps a plan-backed approved case byte-identical when Critic or Supervisor proposes a revision', async () => {
    const testCase = {
      id: 'case-immutable',
      status: 'approved',
      name: 'Authored case',
      steps: JSON.stringify([{ id: 'step-1', action: 'Fill', target: 'User name', value: 'literal-user' }]),
      assertions: 'Original assertion',
      qualityContractJson: JSON.stringify({
        testDesignPlan: {
          planId: 'plan-1', revision: 'plan-revision-1', planCaseId: 'plan-case-1', caseRevision: 'case-revision-1',
        },
      }),
    };
    const before = JSON.stringify(testCase);
    const client = { testCase: { update: vi.fn() } };
    const result = await applyAgentCaseRevision({
      testCase,
      revisedCase: { name: 'Model rewrite', steps: [{ action: 'Click', target: 'Wrong target' }], assertions: 'Changed' },
      client,
    });
    expect(result).toMatchObject({ applied: false, advisory: true, reason: 'immutable_test_design_plan' });
    expect(client.testCase.update).not.toHaveBeenCalled();
    expect(JSON.stringify(testCase)).toBe(before);
  });

  it('allows an approved persisted case with missing lineage and reports the diagnostic', async () => {
    const generation = {
      id: 'generation-1',
      projectId: 'project-1',
      coveragePlanJson: JSON.stringify({
        testDesignPlanV1: {
          planId: 'plan-1',
          revision: 'revision-1',
          scenarios: [{ cases: [{ planCaseId: 'plan-case-1', caseRevision: 'case-revision-1' }] }],
        },
      }),
    };
    const client = {
      scenarioGeneration: {
        findFirst: vi.fn().mockResolvedValue(generation),
      },
    };

    const result = await assertRunnerExecutionLineage({
      projectId: 'project-1',
      scenarios: [{ cases: [{ id: 'approved-case', generationId: 'generation-1', status: 'approved', qualityContractJson: null }] }],
      client,
    });

    expect(client.scenarioGeneration.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'generation-1', projectId: 'project-1' },
    }));
    expect(result).toMatchObject({
      ok: false,
      executionAllowed: true,
      blockingFindings: [],
      diagnosticFindings: [expect.objectContaining({ code: 'execution_case_lineage_missing', testCaseId: 'approved-case' })],
    });
  });

  it('rejects cases selected from multiple generations', async () => {
    await expect(assertRunnerExecutionLineage({
      projectId: 'project-1',
      scenarios: [{ cases: [
        { id: 'case-1', generationId: 'generation-1' },
        { id: 'case-2', generationId: 'generation-2' },
      ] }],
      client: { scenarioGeneration: { findFirst: vi.fn() } },
    })).rejects.toMatchObject({ code: 'GENERATION_MIXED_EXECUTION', status: 409 });
  });
});
