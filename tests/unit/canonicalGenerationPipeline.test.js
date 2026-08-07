import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const canonicalPipeline = require('../../server/services/canonicalGenerationPipeline');
const readiness = require('../../server/services/readinessCompiler');
const { encodeJson, decodeJson } = require('../../server/services/jsonField');
const testCaseContract = require('../../server/services/testCaseContract');
const stepCompiler = require('../../server/services/testDesignStepCompiler');

function runnableCase(id, name, overrides = {}) {
  return {
    id,
    projectId: 'project-1',
    name,
    type: 'functional',
    module: 'PIM',
    confidence: 90,
    status: 'pending',
    assertions: 'Employee saved',
    steps: encodeJson([{ order: 1, action: 'Click', target: 'Save' }]),
    declaredAssertions: encodeJson([
      { id: 'a1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Employee saved' } },
    ]),
    ...overrides,
  };
}

describe('canonical generation pipeline', () => {
  it('validates a reviewed append against its explicit server-built plan authority', async () => {
    const appendPlan = {
      planId: 'append-plan',
      revision: 'append-revision',
      scenarios: [{ cases: [{ planCaseId: 'append-case', caseRevision: 'append-case-revision' }] }],
    };
    const candidate = {
      name: 'Reviewed append case',
      steps: [{ id: 'step-1', action: 'click', target: 'Orders', ordinal: 1, dataRefs: [] }],
      declaredAssertions: [],
      oracles: [],
      qualityContract: {
        testDesignPlan: {
          planId: appendPlan.planId,
          revision: appendPlan.revision,
          planCaseId: 'append-case',
          caseRevision: 'append-case-revision',
        },
      },
    };
    candidate.compiledCaseRevision = stepCompiler.compiledCaseRevision(candidate);
    candidate.qualityContract.testDesignPlan.compiledCaseRevision = candidate.compiledCaseRevision;
    const oldPlan = {
      planId: 'current-plan',
      revision: 'current-revision',
      scenarios: [{ cases: [{ planCaseId: 'current-case', caseRevision: 'current-case-revision' }] }],
    };
    const persistSpy = vi.spyOn(testCaseContract, 'persistCases').mockResolvedValue([{ tc: { id: 'persisted-case' } }]);
    try {
      const result = await canonicalPipeline.persistCases({
        prisma: {
          scenarioGeneration: {
            findUnique: vi.fn(async () => ({
              id: 'generation-5',
              coveragePlanJson: encodeJson({ testDesignPlanV1: oldPlan }),
            })),
          },
        },
        generationId: 'generation-5',
        cases: [candidate],
        testDesignPlanAuthority: appendPlan,
      });

      expect(result).toEqual([{ tc: { id: 'persisted-case' } }]);
      expect(persistSpy).toHaveBeenCalledOnce();
    } finally {
      persistSpy.mockRestore();
    }
  });

  it('allows only an explicitly approved compiler fallback with a server-built plan authority', async () => {
    const appendPlan = {
      planId: 'append-plan',
      revision: 'append-revision',
      scenarios: [{ cases: [{ planCaseId: 'append-case', caseRevision: 'append-case-revision' }] }],
    };
    const unstampedReviewedCase = {
      name: 'Explicitly reviewed fallback case',
      steps: [{ id: 'step-1', action: 'click', target: 'Orders', ordinal: 1, dataRefs: [] }],
    };
    const persistSpy = vi.spyOn(testCaseContract, 'persistCases').mockResolvedValue([{ tc: { id: 'persisted-fallback' } }]);
    const prisma = {
      scenarioGeneration: {
        findUnique: vi.fn(async () => ({
          id: 'generation-5',
          coveragePlanJson: encodeJson({ testDesignPlanV1: { ...appendPlan, planId: 'old-plan' } }),
        })),
      },
    };
    try {
      await expect(canonicalPipeline.persistCases({
        prisma,
        generationId: 'generation-5',
        cases: [unstampedReviewedCase],
        testDesignPlanAuthority: appendPlan,
      })).rejects.toMatchObject({ code: 'TEST_DESIGN_LINEAGE_INVALID' });

      const result = await canonicalPipeline.persistCases({
        prisma,
        generationId: 'generation-5',
        cases: [unstampedReviewedCase],
        testDesignPlanAuthority: appendPlan,
        allowExplicitApprovalLineageOverride: true,
      });

      expect(result).toEqual([{ tc: { id: 'persisted-fallback' } }]);
      expect(persistSpy).toHaveBeenCalledOnce();
    } finally {
      persistSpy.mockRestore();
    }
  });

  it('resolves named dependencies through the shared service and recompiles readiness', async () => {
    const login = runnableCase('tc-login', 'Login as admin');
    const edit = runnableCase('tc-edit', 'Edit employee', { dependsOnNames: ['Login as admin'] });
    const updates = [];
    const prisma = {
      testCase: {
        findMany: async () => [login, edit],
        update: async ({ where, data }) => {
          updates.push({ id: where.id, data });
          const row = where.id === login.id ? login : edit;
          Object.assign(row, data);
          return row;
        },
      },
    };

    const result = await canonicalPipeline.resolveNamedDependenciesForCases({
      prisma,
      projectId: 'project-1',
      cases: [login, edit],
    });

    expect(result.updated).toBe(2);
    const editUpdate = updates.find((row) => row.id === 'tc-edit');
    expect(decodeJson(editUpdate.data.dependsOnIds, [])).toEqual(['tc-login']);
    expect(editUpdate.data.readinessStatus).toBe(readiness.READINESS_STATUS.READY);
    expect(editUpdate.data.sessionMode).toBe(readiness.SESSION_MODE.CONTINUE_FROM_DEPENDENCY);
    expect(editUpdate.data.failurePolicy).toBe(readiness.FAILURE_POLICY.BLOCK_DEPENDENTS);
  });

  it('persists refined cases through one service and writes readiness contract fields', async () => {
    const row = runnableCase('tc-refined', 'Original');
    const updates = [];
    const prisma = {
      testCase: {
        findUnique: async () => ({ ...row }),
        update: async ({ data }) => {
          updates.push(data);
          Object.assign(row, data);
          return { ...row };
        },
      },
    };

    const result = await canonicalPipeline.persistRefinedCase({
      prisma,
      testCaseId: row.id,
      data: { name: 'Refined case', status: 'pending' },
    });

    expect(result.testCase.name).toBe('Refined case');
    expect(result.readiness.readinessStatus).toBe(readiness.READINESS_STATUS.READY);
    expect(updates[0]).toMatchObject({
      name: 'Refined case',
      readinessStatus: readiness.READINESS_STATUS.READY,
      runEligibility: readiness.RUN_ELIGIBILITY.ALLOWED,
      readinessContractVersion: readiness.READINESS_CONTRACT_VERSION,
    });
  });

  it('rejects malformed refined steps before updating the case row', async () => {
    const row = runnableCase('tc-refined-bad', 'Original');
    const updates = [];
    const prisma = {
      testCase: {
        findUnique: async () => ({ ...row }),
        update: async ({ data }) => {
          updates.push(data);
          Object.assign(row, data);
          return { ...row };
        },
      },
    };

    await expect(canonicalPipeline.persistRefinedCase({
      prisma,
      testCaseId: row.id,
      data: { steps: { action: 'Click Save' } },
    })).rejects.toMatchObject({ code: 'REFINED_CASE_CONTRACT_INVALID' });

    expect(updates).toEqual([]);
  });
});
