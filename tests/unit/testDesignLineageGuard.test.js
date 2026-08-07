import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lineageGuard = require('../../server/services/testDesignLineageGuard');
const { assertImmutablePlanLineage } = require('../../server/services/canonicalGenerationPipeline')._private;
const stepCompiler = require('../../server/services/testDesignStepCompiler');

function plan() {
  return {
    planId: 'tdp_exact',
    revision: 'plan-revision-1',
    scenarios: [{
      planScenarioId: 'scenario-1',
      cases: [{ planCaseId: 'case-1', caseRevision: 'case-revision-1' }],
    }],
  };
}

function candidate(overrides = {}) {
  const row = {
    name: 'Pinned case',
    planCaseId: 'case-1',
    planRevision: 'plan-revision-1',
    caseRevision: 'case-revision-1',
    steps: [{ id: 'step-1', action: 'click', target: 'Save', ordinal: 1, dataRefs: [] }],
    declaredAssertions: [],
    oracles: [],
    qualityContract: {
      testDesignPlan: {
        planId: 'tdp_exact',
        revision: 'plan-revision-1',
        planCaseId: 'case-1',
        caseRevision: 'case-revision-1',
        ...overrides,
      },
    },
  };
  const compiledCaseRevision = stepCompiler.compiledCaseRevision(row);
  row.compiledCaseRevision = compiledCaseRevision;
  row.qualityContract.testDesignPlan.compiledCaseRevision = compiledCaseRevision;
  return row;
}

function persistedCase(overrides = {}) {
  const source = candidate();
  return {
    id: 'persisted-case-1',
    generationId: 'generation-1',
    qualityContractJson: JSON.stringify(source.qualityContract),
    ...overrides,
  };
}

describe('immutable test-design lineage guard', () => {
  it('recognizes a plan-backed generation and returns a fail-closed mutation response', () => {
    const generation = { coveragePlanJson: JSON.stringify({ testDesignPlanV1: plan() }) };

    expect(lineageGuard.isPlanBackedGeneration(generation)).toBe(true);
    expect(lineageGuard.mutationBlockedPayload(generation, 'refine one case')).toMatchObject({
      success: false,
      code: 'IMMUTABLE_TEST_DESIGN_REPLAN_REQUIRED',
      plan: { planId: 'tdp_exact', revision: 'plan-revision-1' },
    });
  });

  it('accepts only exact plan, case, and revision lineage', () => {
    expect(() => assertImmutablePlanLineage(plan(), [candidate()])).not.toThrow();
  });

  it('rejects missing lineage before persistence', () => {
    expect(() => assertImmutablePlanLineage(plan(), [{ name: 'Unplanned case' }]))
      .toThrowError(expect.objectContaining({ code: 'TEST_DESIGN_LINEAGE_INVALID' }));
  });

  it('rejects stale case revisions before persistence', () => {
    expect(() => assertImmutablePlanLineage(plan(), [candidate({ caseRevision: 'stale' })]))
      .toThrowError(expect.objectContaining({ code: 'TEST_DESIGN_LINEAGE_INVALID' }));
  });

  it('rejects semantic mutation even when plan and case lineage strings are unchanged', () => {
    const mutated = candidate();
    mutated.steps[0].target = 'Delete';

    expect(() => assertImmutablePlanLineage(plan(), [mutated]))
      .toThrowError(expect.objectContaining({ code: 'TEST_DESIGN_LINEAGE_INVALID' }));
  });

  it.each([
    ['authProfile', 'administrator'],
    ['credentialHint', 'invalid'],
    ['operations', [{ action: 'delete', target: 'Account' }]],
  ])('rejects a post-compile %s mutation that changes runtime behavior', (field, value) => {
    const mutated = candidate();
    mutated[field] = value;

    expect(() => assertImmutablePlanLineage(plan(), [mutated]))
      .toThrowError(expect.objectContaining({ code: 'TEST_DESIGN_LINEAGE_INVALID' }));
  });

  it('accepts exact persisted execution lineage for a plan-backed generation', () => {
    const generation = {
      id: 'generation-1',
      coveragePlanJson: JSON.stringify({ testDesignPlanV1: plan() }),
    };
    expect(lineageGuard.assertPersistedExecutionLineage(generation, [persistedCase()])).toMatchObject({
      ok: true,
      planBacked: true,
      executionAllowed: true,
      findings: [],
      diagnosticFindings: [],
    });
  });

  it('keeps legacy generations executable without inventing immutable lineage', () => {
    expect(lineageGuard.assertPersistedExecutionLineage({ id: 'legacy-generation' }, [{
      id: 'legacy-case',
      generationId: 'legacy-generation',
    }])).toMatchObject({ ok: true, planBacked: false });
  });

  it.each([
    ['stale plan revision', { qualityContractJson: JSON.stringify({ testDesignPlan: { ...candidate().qualityContract.testDesignPlan, revision: 'stale' } }) }, 'execution_case_lineage_mismatch'],
    ['stale case revision', { qualityContractJson: JSON.stringify({ testDesignPlan: { ...candidate().qualityContract.testDesignPlan, caseRevision: 'stale' } }) }, 'execution_case_lineage_mismatch'],
    ['missing compiled revision', { qualityContractJson: JSON.stringify({ testDesignPlan: { ...candidate().qualityContract.testDesignPlan, compiledCaseRevision: null } }) }, 'execution_compiled_case_revision_missing'],
    ['missing lineage', { qualityContractJson: null }, 'execution_case_lineage_missing'],
  ])('continues execution with diagnostics for %s', (_label, overrides, expectedCode) => {
    const generation = {
      id: 'generation-1',
      coveragePlanJson: JSON.stringify({ testDesignPlanV1: plan() }),
    };
    expect(lineageGuard.assertPersistedExecutionLineage(generation, [persistedCase(overrides)])).toMatchObject({
      ok: false,
      executionAllowed: true,
      blockingFindings: [],
      diagnosticFindings: expect.arrayContaining([expect.objectContaining({ code: expectedCode })]),
    });
  });

  it('still blocks a real cross-generation execution mismatch', () => {
    const generation = {
      id: 'generation-1',
      coveragePlanJson: JSON.stringify({ testDesignPlanV1: plan() }),
    };
    expect(() => lineageGuard.assertPersistedExecutionLineage(generation, [persistedCase({ generationId: 'generation-other' })]))
      .toThrowError(expect.objectContaining({ code: 'TEST_DESIGN_EXECUTION_LINEAGE_INVALID', status: 409 }));
  });

  it('wires immutable lineage validation into the shared agents execution chokepoint', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/agents.js'), 'utf8');
    const runner = source.slice(source.indexOf('async function runConductorWithRetries({'), source.indexOf('const execMode =', source.indexOf('async function runConductorWithRetries({')));
    expect(runner).toContain('assertPersistedExecutionLineage(');
    expect(runner).toContain('coveragePlanJson: true');
    expect(runner).toContain('lineageReport.diagnosticFindings');
  });
});
