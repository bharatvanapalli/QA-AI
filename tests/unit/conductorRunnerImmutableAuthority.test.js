import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import runnerModule from '../../server/services/agents/conductorRunner';

const { assertRunnerExecutionLineage } = runnerModule;

describe('single-controller runner authority', () => {
  it('has no agent revision or retry authority and enters the controller once', () => {
    const source = fs.readFileSync(
      path.resolve('server/services/agents/conductorRunner.js'),
      'utf8',
    );
    expect(runnerModule.applyAgentCaseRevision).toBeUndefined();
    expect(source).toContain("require('../controllerConductorRunner')");
    expect(source).toContain('return runControllerConductorOnce({');
    expect(source).not.toMatch(/\b(?:critic|supervisor)\.(?:run|review)\s*\(/i);
    expect((source.match(/return runControllerConductorOnce\(\{/g) || [])).toHaveLength(1);
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
