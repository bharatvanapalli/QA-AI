import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('generation route invariants', () => {
  it('does not directly create generated test cases in route files', () => {
    const routeFiles = [
      'server/routes/scenarios.js',
      'server/routes/agents.js',
      'server/routes/testCases.js',
    ];
    for (const file of routeFiles) {
      expect(read(file), `${file} must use the canonical case writer for generated/refined cases`).not.toMatch(/testCase\s*\.\s*create\s*\(/);
    }
  });

  it('does not destructively replace every project scenario/case in the agent generation path', () => {
    const agents = read('server/routes/agents.js');

    expect(agents).not.toMatch(/testScenario\s*\.\s*deleteMany\s*\(\s*\{\s*where:\s*\{\s*projectId:\s*project\.id\s*\}\s*\}/);
    expect(agents).not.toMatch(/testCase\s*\.\s*deleteMany\s*\(\s*\{\s*where:\s*\{\s*projectId:\s*project\.id\s*\}\s*\}/);
    expect(agents).toContain('promotionIssuesForGeneration');
  });

  it('does not force a fixed two-case minimum per generated scenario', () => {
    const architect = read('server/services/agents/architect.js');

    expect(architect).toContain('Case cardinality is coverage-driven');
    expect(architect).toContain('may contain exactly one test case');
    expect(architect).toContain('Do not force two cases for a scenario');
    expect(architect).not.toMatch(/contains multiple specific test cases/i);
    expect(architect).not.toMatch(/Each scenario:\s*2[\u2013-]5 test cases/i);
    expect(architect).not.toMatch(/Author\s+2[\u2013-]5 focused cases/i);
    expect(architect).not.toMatch(/test cases per scenario/i);
  });

  it('does not coverage-fill a single behavioral partition into multiple scenarios', () => {
    const architect = read('server/services/agents/architect.js');
    const scenarios = read('server/routes/scenarios.js');
    const compiler = read('server/services/generationCompiler.js');

    expect(architect).toContain('singleBehavioralPartition');
    expect(architect).not.toContain('strictOneCase');
    expect(scenarios).toContain('singleBehavioralPartition');
    expect(compiler).toContain('bindInlineProceduralRequirementData');
  });

  it('does not reuse insufficient site atlases as current generation context', () => {
    const scenarios = read('server/routes/scenarios.js');
    const planner = read('server/lib/crawlPlanner.js');

    expect(scenarios).toContain('sufficiency: latestCal.sufficiency');
    expect(planner).toContain("sufficiency === 'insufficient'");
    expect(planner).toContain('the existing atlas is insufficient');
  });

  it('keeps automatic crawling bounded and makes cancellation stop active execution', () => {
    const scenarios = read('server/routes/scenarios.js');
    const calibration = read('server/routes/calibration.js');
    const calibrator = read('server/services/agents/calibrator.js');
    const planner = read('server/lib/crawlPlanner.js');

    expect(planner).toContain("const CRAWL_SCOPE_ENTRY_PAGE = 'entry-page'");
    expect(planner).toContain("const CRAWL_SCOPE_SITE = 'site'");
    expect(scenarios).toContain('crawlPlanner.resolveCrawlScope(req.body?.crawlScope)');
    expect(scenarios).toContain('reuseFreshEntryPageAtlas');
    expect(calibration).toContain('crawlPlanner.resolveCrawlScope(crawlScope)');
    expect(scenarios).toContain('cancelRegistry.cancel(req.user.id, reason)');
    expect(calibrator).toContain('CALIBRATOR_BROWSER_SESSION_LOST');
    expect(calibrator).toContain('stopping instead of draining the remaining queue');
  });

  it('routes the Playwright JavaScript project option to the POM JavaScript adapter', () => {
    const outputFiles = read('server/routes/outputFiles.js');

    expect(outputFiles).toContain("'playwright-js': 'playwright-pom-js'");
    expect(outputFiles).not.toContain("'playwright-js': 'playwright-reference-js'");
  });

  it('wires Add scenario continuation through UI, route validation, and canonical persistence', () => {
    const ui = read('src/pages/TestCases.jsx');
    const scenarios = read('server/routes/scenarios.js');
    const contract = read('server/services/testCaseContract.js');
    const compiler = read('server/services/generationCompiler.js');

    expect(ui).toContain('continuationParentCaseId');
    expect(ui).toContain('Continue from an existing case/session');
    expect(ui).toContain("continuationSessionMode: continueFromCase ? 'continue_from_dependency' : null");
    expect(ui).toContain('scenarios={scenarios}');

    expect(scenarios).toContain('CONTINUATION_PARENT_NOT_CURRENT');
    expect(scenarios).toContain('guidanceRequestsContinuation');
    expect(scenarios).toContain('applyAppendContinuationContract');
    expect(scenarios).toContain('buildAppendScenarioRequest(project, requestBody)');
    expect(scenarios).toContain('const architectRequirements = appendDesignRequirement ? [appendDesignRequirement] : requirements');
    expect(scenarios).toContain('requirements: planningRequirements');
    expect(scenarios).toContain('extractProceduralFlowContract(planningRequirements)');
    expect(compiler).toContain('bindInlineProceduralRequirementData');
    expect(scenarios).toContain('result.scenarios = appendToCurrent ? gc.scenarios : gc.readyScenarios');
    expect(scenarios).toContain('appendDraftFallback');
    expect(scenarios).toContain('carrying ${notReadyCount} not-ready append candidate(s) into persistence for review');
    expect(scenarios).toContain("sessionMode: 'continue_from_dependency'");
    expect(scenarios).toContain("failurePolicy: 'block_dependents'");

    expect(contract).toContain('dependsOnIds: Array.isArray(c.dependsOnIds)');
    expect(contract).toContain('requiresStateContracts.length ? enc(requiresStateContracts) : null');
  });

  it('orders immutable understanding, data alignment, design planning, compilation, and persistence fail-closed', () => {
    const scenarios = read('server/routes/scenarios.js');
    const pipeline = read('server/services/canonicalGenerationPipeline.js');
    const agents = read('server/routes/agents.js');
    const stageNeedles = [
      'buildRequirementUnderstandingV1({',
      'loadGenerationTestDataContract({',
      'buildStoryDataAlignmentPlanV1({',
      'buildCaseContractPlanningBridge({',
      'buildTestDesignPlanV1({',
      'testDesignPlan: testDesignPlanV1',
      "require('../services/testDesignStepCompiler').compileCandidateSuite({",
      'canonicalGenerationPipeline.persistCases({',
    ];
    let cursor = -1;
    const stages = stageNeedles.map((needle) => {
      cursor = scenarios.indexOf(needle, cursor + 1);
      return cursor;
    });

    expect(stages.every((index) => index >= 0)).toBe(true);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(scenarios).toContain("requirementUnderstandingV1.status === 'degraded'");
    expect(scenarios).toContain('hasAuthoritativeCaseContracts');
    expect(scenarios).toContain("stopReason: 'authoritative_case_contract_v1'");
    expect(scenarios).toContain('appendDesignRequirement && Array.isArray(result.scenarios) && !hasAuthoritativeCaseContracts');
    const strictCompileStart = scenarios.indexOf("require('../services/testDesignStepCompiler').compileCandidateSuite({");
    const strictCompileEnd = scenarios.indexOf('});', strictCompileStart);
    expect(scenarios.slice(strictCompileStart, strictCompileEnd)).toContain('proceduralFlowContract');
    expect(scenarios.indexOf('await writeGenerationCoverage(tx, generation.id')).toBeLessThan(
      scenarios.indexOf('postPersistVerification = await verifyPersistedGenerationContract'),
    );
    expect(pipeline).toContain('assertImmutablePlanLineage(plan, options.cases)');
    expect(agents).toContain("code: 'CANONICAL_GENERATION_REQUIRED'");
  });

  it('preserves authoritative uploaded cases when strict compiler comparison only reports findings', () => {
    const scenarios = read('server/routes/scenarios.js');

    expect(scenarios).toContain('authoritative_case_contract_preserved_after_compiler_warning');
    expect(scenarios).toContain("mode: 'authoritative_case_contract_fallback'");
    expect(scenarios).toContain('preserving ${preservedCaseCount} source-authored case(s)');
    expect(scenarios).toContain('if (hasAuthoritativeCaseContracts && Array.isArray(result.scenarios) && result.scenarios.length)');
  });

  it('pins the mapping revision reviewed in the UI and blocks incomplete dataset contracts', () => {
    const ui = read('src/pages/RunSuite.jsx');
    const scenarios = read('server/routes/scenarios.js');
    const generationData = read('server/services/testDataGenerationContract.js');

    expect(ui).toContain('testDataMappingPins: Object.fromEntries');
    expect(ui).toContain('td.approvedMapping.id');
    expect(ui).toContain('Generation is blocked until this inventory reloads successfully.');
    expect(scenarios).toContain('mappingPins: req.body?.testDataMappingPins');
    expect(generationData).toContain("code: 'approved_mapping_pin_required'");
    expect(generationData).toContain("code: 'dataset_contract_incomplete'");
  });

  it('keeps strict append output complete and rolls back only the appended mutation on gate failure', () => {
    const scenarios = read('server/routes/scenarios.js');
    const rollback = read('server/services/appendGenerationRollback.js');

    expect(scenarios).toContain('const strictPlanBackedAppend = appendedToExisting && !!testDesignPlanV1');
    expect(scenarios).toContain('appendedToExisting && !strictPlanBackedAppend');
    expect(scenarios).toContain('countScenarioGenerationRelations(prisma');
    expect(scenarios).toContain('appendGenerationContractSnapshot({');
    expect(scenarios).toContain('rollbackAppendedGenerationMutation({');
    expect((scenarios.match(/rollbackAppendedGenerationMutation\(\{/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(scenarios).toContain('const rollbackAppendAtState = appendedToExisting');
    expect(scenarios).toContain('const rollbackCommittedAppend = rollbackAppendAtState');
    expect(scenarios).toContain('persistedGenerationCounts.scenarioCount');
    expect(scenarios).toContain('persistedGenerationCounts.caseCount');
    expect(scenarios).toContain('let persistTransactionCommitted = false');
    expect(scenarios).toContain('persistTransactionCommitted = true');
    expect(scenarios).toContain('if (appendedToExisting && persistTransactionCommitted)');
    expect(scenarios).toContain('if (rollbackCommittedAppend) await rollbackCommittedAppend()');
    expect(rollback).toContain("error.code = 'APPEND_ROLLBACK_CONCURRENT_MUTATION'");
    expect(scenarios).not.toContain('postPersistVerification.ok === false && !appendedToExisting');
    expect(scenarios).not.toContain('const promotionIssues = appendedToExisting ? []');

    const rollbackStart = rollback.indexOf('async function rollbackAppendedGenerationMutation');
    const caseDelete = rollback.indexOf('await tx.testCase.deleteMany', rollbackStart);
    const scenarioDelete = rollback.indexOf('await tx.testScenario.deleteMany', rollbackStart);
    expect(caseDelete).toBeGreaterThan(rollbackStart);
    expect(scenarioDelete).toBeGreaterThan(caseDelete);
  });

  it('keeps generation counters derived from persisted scenario and case relations', () => {
    const scenarios = read('server/routes/scenarios.js');
    const testCases = read('server/routes/testCases.js');
    const agents = read('server/routes/agents.js');
    const counts = read('server/services/scenarioGenerationCounts.js');

    expect(counts).toContain('countScenarioGenerationRelations');
    expect(counts).toContain('syncScenarioGenerationCounts');
    expect(counts).toContain('prismaClient.testScenario.count');
    expect(counts).toContain('prismaClient.testCase.count');
    expect(counts).toContain('scenarioGeneration.updateMany');

    expect(scenarios).toContain('_count: { select: { scenarios: true, cases: true } }');
    expect(scenarios).toContain('scenarioCount: _count.scenarios');
    expect(scenarios).toContain('caseCount: _count.cases');
    expect(scenarios).not.toContain('scenarioCount: { increment: created.length }');
    expect((scenarios.match(/syncScenarioGenerationCounts\(/g) || []).length).toBeGreaterThanOrEqual(4);

    const scenarioDelete = scenarios.indexOf("router.delete('/:id'");
    const targetedRegenerate = scenarios.indexOf("'/:id/regenerate'", scenarioDelete);
    const scenarioRestore = scenarios.indexOf("router.post('/:id/restore-latest'", targetedRegenerate);
    expect(scenarios.indexOf('await syncScenarioGenerationCounts(tx', scenarioDelete)).toBeLessThan(targetedRegenerate);
    expect(scenarios.indexOf('await syncScenarioGenerationCounts(tx', targetedRegenerate)).toBeLessThan(scenarioRestore);
    expect(scenarios.indexOf('await syncScenarioGenerationCounts(tx', scenarioRestore)).toBeGreaterThan(scenarioRestore);

    const caseDelete = testCases.indexOf("router.delete('/:tcId'");
    expect(testCases.indexOf('await prisma.$transaction(async (tx)', caseDelete)).toBeGreaterThan(caseDelete);
    expect(testCases.indexOf('await syncScenarioGenerationCounts(tx', caseDelete)).toBeGreaterThan(caseDelete);
    expect(agents).toContain('await syncScenarioGenerationCounts(tx');
  });

  it('allows whole leaf-scenario deletion while preserving dependency and cleanup invariants', () => {
    const scenarios = read('server/routes/scenarios.js');
    const deleteStart = scenarios.indexOf("router.delete('/:id'");
    const deleteEnd = scenarios.indexOf("'/:id/regenerate'", deleteStart);
    const deleteBlock = scenarios.slice(deleteStart, deleteEnd);

    expect(deleteStart).toBeGreaterThan(-1);
    expect(deleteBlock).not.toContain("mutationBlockedPayload(existing.generation, 'delete one scenario')");
    expect(deleteBlock).toContain('findScenarioDeletionBlockers');
    expect(deleteBlock).toContain('scenarioDeletionBlockedError');
    expect(deleteBlock).toContain('tx.generationGuidance.deleteMany');
    expect(deleteBlock).toContain('tx.projectActionMemory.deleteMany');
    expect(deleteBlock).toContain('tx.testCase.deleteMany');
    expect(deleteBlock).toContain('tx.testScenario.delete');
    expect(deleteBlock).toContain('syncScenarioGenerationCounts(tx');
    expect(deleteBlock).toContain("action: 'scenario.delete'");
  });

  it('preserves value-free DatasetCatalog history when appending into an existing generation', () => {
    const scenarios = read('server/routes/scenarios.js');

    expect(scenarios).toContain("datasetCatalogV1: historyFor('datasetCatalogV1')");
    expect(scenarios).toContain('contract.contractId || contract.catalogId || contract.planId || contract.revision');
    expect(scenarios).toContain('DatasetCatalogV1 contains immutable IDs, revisions, mapping refs, and');
  });
});
