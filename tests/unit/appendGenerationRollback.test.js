import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const rollback = require('../../server/services/appendGenerationRollback');

describe('append generation scoped rollback', () => {
  it('deletes appended cases before scenarios and restores the exact generation contract snapshot', async () => {
    const calls = [];
    const tx = {
      testCase: { deleteMany: vi.fn(async (args) => { calls.push(['cases', args]); }) },
      testScenario: { deleteMany: vi.fn(async (args) => { calls.push(['scenarios', args]); }) },
      scenarioGeneration: { update: vi.fn(async (args) => { calls.push(['generation', args]); }) },
    };
    const prismaClient = {
      $transaction: vi.fn(async (work) => work(tx)),
    };
    const snapshot = rollback.appendGenerationContractSnapshot({
      id: 'generation-a',
      projectId: 'project-a',
      isCurrent: true,
      scenarioCount: 4,
      caseCount: 9,
      coveragePlanJson: '{"plan":"before"}',
      coverageValidationJson: '{"validation":"before"}',
      coverageRepairJson: '{"repair":"before"}',
    });

    await rollback.rollbackAppendedGenerationMutation({
      prismaClient,
      projectId: 'project-a',
      generationId: 'generation-a',
      snapshot,
      caseIds: ['case-2', 'case-1', 'case-2'],
      scenarioIds: ['scenario-1', 'scenario-1'],
    });

    expect(calls.map(([kind]) => kind)).toEqual(['cases', 'scenarios', 'generation']);
    expect(calls[0][1].where).toEqual({
      id: { in: ['case-2', 'case-1'] },
      projectId: 'project-a',
      generationId: 'generation-a',
    });
    expect(calls[1][1].where.id.in).toEqual(['scenario-1']);
    expect(calls[2][1]).toEqual({
      where: { id: 'generation-a' },
      data: {
        scenarioCount: 4,
        caseCount: 9,
        coveragePlanJson: '{"plan":"before"}',
        coverageValidationJson: '{"validation":"before"}',
        coverageRepairJson: '{"repair":"before"}',
      },
    });
  });

  it('rejects a rollback snapshot from another project or generation', async () => {
    const prismaClient = { $transaction: vi.fn() };
    await expect(rollback.rollbackAppendedGenerationMutation({
      prismaClient,
      projectId: 'project-a',
      generationId: 'generation-a',
      snapshot: { id: 'generation-a', projectId: 'project-b' },
    })).rejects.toMatchObject({ code: 'APPEND_ROLLBACK_SNAPSHOT_MISSING' });
    expect(prismaClient.$transaction).not.toHaveBeenCalled();
  });

  it('claims the exact committed append state before deleting rows', async () => {
    const calls = [];
    const tx = {
      testCase: { deleteMany: vi.fn(async () => { calls.push('cases'); }) },
      testScenario: { deleteMany: vi.fn(async () => { calls.push('scenarios'); }) },
      scenarioGeneration: {
        updateMany: vi.fn(async (args) => { calls.push('claim'); return { count: 1, args }; }),
        update: vi.fn(),
      },
    };
    const prismaClient = { $transaction: vi.fn(async (work) => work(tx)) };
    const snapshot = rollback.appendGenerationContractSnapshot({
      id: 'generation-a', projectId: 'project-a', scenarioCount: 4, caseCount: 9,
      coveragePlanJson: '{"plan":"before"}', coverageValidationJson: null, coverageRepairJson: null,
    });

    await rollback.rollbackAppendedGenerationMutation({
      prismaClient,
      projectId: 'project-a',
      generationId: 'generation-a',
      snapshot,
      scenarioIds: ['scenario-new'],
      caseIds: ['case-new'],
      expectedState: {
        scenarioCount: 5,
        caseCount: 10,
        coveragePlanJson: '{"plan":"after"}',
        coverageValidationJson: null,
        coverageRepairJson: null,
      },
    });

    expect(calls).toEqual(['claim', 'cases', 'scenarios']);
    expect(tx.scenarioGeneration.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'generation-a', projectId: 'project-a', scenarioCount: 5, caseCount: 10,
        coveragePlanJson: '{"plan":"after"}',
      }),
    }));
    expect(tx.scenarioGeneration.update).not.toHaveBeenCalled();
  });

  it('refuses to clobber a generation changed by another append', async () => {
    const tx = {
      testCase: { deleteMany: vi.fn() },
      testScenario: { deleteMany: vi.fn() },
      scenarioGeneration: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prismaClient = { $transaction: vi.fn(async (work) => work(tx)) };
    const snapshot = rollback.appendGenerationContractSnapshot({
      id: 'generation-a', projectId: 'project-a', scenarioCount: 4, caseCount: 9,
    });

    await expect(rollback.rollbackAppendedGenerationMutation({
      prismaClient,
      projectId: 'project-a',
      generationId: 'generation-a',
      snapshot,
      scenarioIds: ['scenario-new'],
      caseIds: ['case-new'],
      expectedState: { scenarioCount: 5, caseCount: 10 },
    })).rejects.toMatchObject({ code: 'APPEND_ROLLBACK_CONCURRENT_MUTATION' });

    expect(tx.testCase.deleteMany).not.toHaveBeenCalled();
    expect(tx.testScenario.deleteMany).not.toHaveBeenCalled();
  });
});
