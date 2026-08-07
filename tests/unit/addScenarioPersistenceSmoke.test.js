import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const prisma = require('../../server/prisma');
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');
const planningBridge = require('../../server/services/caseContractPlanningBridge');
const testDesignPlanV1 = require('../../server/services/testDesignPlanV1');
const stepCompiler = require('../../server/services/testDesignStepCompiler');
const architect = require('../../server/services/agents/architect');
const canonicalGenerationPipeline = require('../../server/services/canonicalGenerationPipeline');
const {
  ScenarioPersistenceContractError,
  normalizeScenarioPersistenceBatch,
  buildScenarioCreateData,
} = require('../../server/services/scenarioPersistenceContract');

function compileModulelessAddScenario() {
  const requirement = {
    id: 'add-scenario:persistence-smoke',
    source: 'add_scenario',
    title: 'Create a generic order',
    content: `
Scenario Title: Create a generic order

Inline Test Data:
Order Number = 007995145

Test Steps and Validations:
1. Enter 007995145 in the Order Number field.
2. Verify the Create Order heading is visible.
`,
  };
  const procedural = proceduralFlowContract.extractProceduralFlowContract([requirement]);
  const bridged = planningBridge.buildCaseContractPlanningBridge({
    proceduralFlowContract: procedural,
    coverageManifest: { version: 1, items: [] },
    caseContractPacks: [],
  });
  const plan = testDesignPlanV1.buildTestDesignPlanV1({
    coverageManifest: bridged.coverageManifest,
    caseContractPacks: bridged.caseContractPacks,
    requirements: [requirement],
  });
  const casePlan = plan.scenarios[0].cases[0];
  const candidate = architect.deterministicScenarioFromPack({
    ...bridged.caseContractPacks[0],
    planCaseId: casePlan.planCaseId,
  }, 'authoritative_case_contract_v1');
  const compiled = stepCompiler.compileCandidateSuite({
    testDesignPlan: plan,
    candidateScenarios: [candidate],
    proceduralFlowContract: procedural,
  });
  return { plan, candidate, compiledScenario: compiled.scenarios[0] };
}

describe('Add Scenario persistence smoke', () => {
  it('normalizes all required scenario metadata together and aggregates invalid rows', () => {
    const rows = normalizeScenarioPersistenceBatch([{
      name: 'Generic scenario',
      module: null,
      priority: null,
      category: null,
      rationale: null,
      cases: [{ module: 'Orders' }],
    }]);

    expect(rows[0].metadata).toMatchObject({
      name: 'Generic scenario',
      module: 'Orders',
      priority: 'P1',
      category: 'functional',
      source: 'agent',
    });
    expect(rows[0].metadata.rationale).toContain('Generic scenario');
    expect(() => normalizeScenarioPersistenceBatch([{}, { cases: [] }]))
      .toThrowError(ScenarioPersistenceContractError);
    try {
      normalizeScenarioPersistenceBatch([{}, { cases: [] }]);
    } catch (error) {
      expect(error.findings).toHaveLength(2);
      expect(error.findings.map((finding) => finding.scenarioIndex)).toEqual([0, 1]);
    }
  });

  it('persists the exact moduleless text-to-contract deterministic scenario and its cases', async () => {
    const { plan, candidate, compiledScenario } = compileModulelessAddScenario();
    expect(plan.scenarios[0].module).toBeNull();
    expect(candidate.module).toEqual(expect.any(String));
    expect(candidate.module.length).toBeGreaterThan(0);
    expect(compiledScenario.module).toBe(candidate.module);

    const persistenceRow = normalizeScenarioPersistenceBatch([compiledScenario])[0];
    for (const field of ['name', 'module', 'priority', 'category', 'rationale', 'source']) {
      expect(persistenceRow.metadata[field]).toEqual(expect.any(String));
      expect(persistenceRow.metadata[field].length).toBeGreaterThan(0);
    }

    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        email: `add-scenario-smoke-${suffix}@example.test`,
        passwordHash: 'test-only',
      },
    });
    try {
      const project = await prisma.project.create({
        data: { userId: user.id, name: `Add Scenario smoke ${suffix}` },
      });
      const generation = await prisma.scenarioGeneration.create({
        data: { projectId: project.id, version: 1, label: 'Add Scenario persistence smoke' },
      });
      const persisted = await prisma.$transaction(async (tx) => {
        const scenario = await tx.testScenario.create({
          data: buildScenarioCreateData({
            scenario: compiledScenario,
            metadata: persistenceRow.metadata,
            projectId: project.id,
            generationId: generation.id,
          }),
        });
        const cases = await canonicalGenerationPipeline.persistCases({
          prisma: tx,
          projectId: project.id,
          scenarioId: scenario.id,
          generationId: generation.id,
          moduleName: persistenceRow.metadata.module,
          cases: compiledScenario.cases,
          calibrationAtlas: null,
          approvedTestData: null,
          requireApprovedMapping: false,
          enterpriseMode: false,
          authProfileName: null,
          log: console,
          tag: '[add-scenario-persistence-smoke]',
        });
        return { scenario, cases };
      });

      expect(persisted.scenario).toMatchObject({
        projectId: project.id,
        generationId: generation.id,
        module: persistenceRow.metadata.module,
      });
      expect(persisted.cases).toHaveLength(compiledScenario.cases.length);
      expect(persisted.cases.length).toBeGreaterThan(0);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
