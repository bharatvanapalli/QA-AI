import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const routePath = path.resolve(here, '../../server/routes/scenarios.js');

describe('Add Scenario semantic route integration', () => {
  it('returns an immutable preview before coverage or persistence', () => {
    const source = fs.readFileSync(routePath, 'utf8');
    const previewImport = source.indexOf("const { buildAddScenarioPreview } = require('../services/addScenarioPreview');");
    const plannerCall = source.indexOf('addScenarioSemanticPlanner.planAddScenario({');
    const strictValidator = source.indexOf('caseContractSemanticValidator.validateSemanticCaseContract(draft');
    const completenessRead = source.indexOf('semanticPlan && semanticPlan.sourceCompleteness', plannerCall);
    const completenessGate = source.indexOf('sourceCompleteness.complete !== true', completenessRead);
    const semanticEnvelopeRead = source.indexOf('const semanticEnvelope =', completenessGate);
    const previewBuild = source.indexOf('const preview = buildAddScenarioPreview({', semanticEnvelopeRead);
    const previewSnapshot = source.indexOf('reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {', previewBuild);
    const previewJobUpdate = source.indexOf('reliabilityJobs.updateScenarioGenerationJob(scenarioGenerationJob, {', previewSnapshot);
    const cancelClear = source.indexOf('cancelRegistry.clear(req.user.id);', previewJobUpdate);
    const previewWebSocket = source.indexOf("send('agent.phase.complete', {", cancelClear);
    const previewResponse = source.indexOf("mode: 'add_scenario_preview'", previewWebSocket);
    const coverageFreeze = source.indexOf('coveragePlan = coveragePlanner.buildCoveragePlanManifest({');
    const generationCreate = source.indexOf('prisma.scenarioGeneration.create({', coverageFreeze);
    const scenarioCreate = source.indexOf('tx.testScenario.create({', coverageFreeze);
    const casePersistence = source.indexOf('canonicalGenerationPipeline.persistCases({', coverageFreeze);

    expect(previewImport).toBeGreaterThan(0);
    expect(plannerCall).toBeGreaterThan(0);
    expect(strictValidator).toBeGreaterThan(plannerCall);
    expect(completenessRead).toBeGreaterThan(strictValidator);
    expect(completenessGate).toBeGreaterThan(completenessRead);
    expect(semanticEnvelopeRead).toBeGreaterThan(completenessGate);
    expect(previewBuild).toBeGreaterThan(semanticEnvelopeRead);
    expect(previewSnapshot).toBeGreaterThan(previewBuild);
    expect(previewJobUpdate).toBeGreaterThan(previewSnapshot);
    expect(cancelClear).toBeGreaterThan(previewJobUpdate);
    expect(previewWebSocket).toBeGreaterThan(cancelClear);
    expect(previewResponse).toBeGreaterThan(previewWebSocket);
    expect(coverageFreeze).toBeGreaterThan(previewResponse);
    expect(generationCreate).toBeGreaterThan(coverageFreeze);
    expect(scenarioCreate).toBeGreaterThan(generationCreate);
    expect(casePersistence).toBeGreaterThan(scenarioCreate);

    expect(source.slice(plannerCall, coverageFreeze)).toContain('sourceText: appendDesignText');
    expect(source.slice(plannerCall, coverageFreeze)).toContain('currentCases');
    expect(source.slice(plannerCall, coverageFreeze)).toContain('approvedDataMetadata');
    expect(source.slice(plannerCall, coverageFreeze)).toContain('capabilities:');
    expect(source.slice(plannerCall, coverageFreeze)).toContain('signal: cancelToken.signal');
    expect(source.slice(plannerCall, coverageFreeze)).toContain('maxSteps: 100');
    expect(source.slice(plannerCall, coverageFreeze)).toContain("if (err && err.code === 'CANCELLED' || isGenerationCancelled()) throw err;");
    expect(source.slice(plannerCall, coverageFreeze)).toContain("semanticPlanError.code = 'ADD_SCENARIO_SEMANTIC_CASE_REQUIRED'");
    expect(source.slice(plannerCall, coverageFreeze)).toContain("semanticPlanError.code = 'ADD_SCENARIO_SOURCE_INCOMPLETE'");
    expect(source.slice(plannerCall, coverageFreeze)).toContain('error: semanticPlanError');
    expect(source.slice(previewBuild, coverageFreeze)).toContain('reliabilityJobs.JOB_STATUS.READY_WITH_USER_DECISIONS');
    expect(source.slice(previewBuild, coverageFreeze)).toContain('reliabilityJobs.JOB_STATUS.AWAITING_USER_DECISION');
    expect(source.slice(previewBuild, coverageFreeze)).toContain("stage: 'add_scenario_preview'");
    expect(source.slice(previewBuild, coverageFreeze)).toContain("mode: 'add_scenario_preview'");
    expect(source.slice(previewBuild, coverageFreeze)).toContain('persisted: false');
    expect(source.slice(previewBuild, coverageFreeze)).toContain('preview,');
    expect(source.slice(previewBuild, coverageFreeze)).toContain('return res.json({');
    expect(source.slice(previewBuild, coverageFreeze)).not.toContain('prisma.scenarioGeneration.create');
    expect(source.slice(previewBuild, coverageFreeze)).not.toContain('tx.testScenario.create');
    expect(source.slice(previewBuild, coverageFreeze)).not.toContain('canonicalGenerationPipeline.persistCases');

    expect(source).toContain("err.code = 'ADD_SCENARIO_SEMANTIC_PROJECTION_FAILED'");
  });

  it('refines the registered draft exactly once and returns before coverage or persistence', () => {
    const source = fs.readFileSync(routePath, 'utf8');
    const registryImport = source.indexOf("const { addScenarioDraftRegistry } = require('../services/addScenarioDraftRegistry');");
    const intentImport = source.indexOf("const { planAddScenarioRefinementIntent } = require('../services/addScenarioRefinementIntentPlanner');");
    const refinerImport = source.indexOf("const { refineAddScenarioPreview } = require('../services/addScenarioPreviewRefinement');");
    const requestGuard = source.indexOf("code: 'ADD_SCENARIO_REFINEMENT_REQUEST_INVALID'");
    const refinementBranch = source.indexOf('if (refinementRequested) {', source.indexOf("typeof appendDesignText === 'string'"));
    const registryGet = source.indexOf('addScenarioDraftRegistry.get({', refinementBranch);
    const revisionGate = source.indexOf("code: 'ADD_SCENARIO_DRAFT_REVISION_STALE'", registryGet);
    const generationGate = source.indexOf("code: 'ADD_SCENARIO_DRAFT_GENERATION_STALE'", revisionGate);
    const intentCall = source.indexOf('await planAddScenarioRefinementIntent({', generationGate);
    const refineCall = source.indexOf('refineAddScenarioPreview({', intentCall);
    const registryUpdate = source.indexOf('addScenarioDraftRegistry.update({', refineCall);
    const refinedResponse = source.indexOf("mode: 'add_scenario_preview_refined'", registryUpdate);
    const normalPlanner = source.indexOf('addScenarioSemanticPlanner.planAddScenario({', refinedResponse);
    const initialRegistryPut = source.indexOf('addScenarioDraftRegistry.put({', normalPlanner);
    const initialPreviewResponse = source.indexOf("mode: 'add_scenario_preview'", initialRegistryPut);
    const coverageFreeze = source.indexOf('coveragePlan = coveragePlanner.buildCoveragePlanManifest({', initialPreviewResponse);

    expect(registryImport).toBeGreaterThan(0);
    expect(intentImport).toBeGreaterThan(registryImport);
    expect(refinerImport).toBeGreaterThan(intentImport);
    expect(requestGuard).toBeGreaterThan(refinerImport);
    expect(refinementBranch).toBeGreaterThan(requestGuard);
    expect(registryGet).toBeGreaterThan(refinementBranch);
    expect(revisionGate).toBeGreaterThan(registryGet);
    expect(generationGate).toBeGreaterThan(revisionGate);
    expect(intentCall).toBeGreaterThan(generationGate);
    expect(refineCall).toBeGreaterThan(intentCall);
    expect(registryUpdate).toBeGreaterThan(refineCall);
    expect(refinedResponse).toBeGreaterThan(registryUpdate);
    expect(normalPlanner).toBeGreaterThan(refinedResponse);
    expect(initialRegistryPut).toBeGreaterThan(normalPlanner);
    expect(initialPreviewResponse).toBeGreaterThan(initialRegistryPut);
    expect(coverageFreeze).toBeGreaterThan(initialPreviewResponse);

    const refinementSlice = source.slice(refinementBranch, normalPlanner);
    const requestGuardSlice = source.slice(source.indexOf('const refinementRequested = Boolean('), refinementBranch);
    expect(requestGuardSlice).toContain('requestBody.previewOnly !== true');
    expect(requestGuardSlice).toContain('requestBody.persist !== false');
    expect(refinementSlice).toContain('sourceDigest: draft.sourceDigest');
    expect(refinementSlice).toContain('revision: draft.revision');
    expect(refinementSlice).toContain('operationCatalog: buildAddScenarioRefinementCatalog(draft.preview)');
    expect(refinementSlice).toContain('expectedRevision: draft.revision');
    expect(refinementSlice).toContain('persisted: false');
    expect(refinementSlice).not.toContain('prisma.scenarioGeneration.create');
    expect(refinementSlice).not.toContain('tx.testScenario.create');
    expect(refinementSlice).not.toContain('canonicalGenerationPipeline.persistCases');

    const initialPreviewSlice = source.slice(initialRegistryPut, coverageFreeze);
    expect(initialPreviewSlice).toContain('originalSource: appendDesignText');
    expect(initialPreviewSlice).toContain('semanticPlan');
    expect(initialPreviewSlice).toContain('currentGenerationId');
    expect(initialPreviewSlice).toContain('draftId: registeredDraft && registeredDraft.draftId || null');
    expect(initialPreviewSlice).toContain('persisted: false');
  });

  it('approves only the registered draft through a provider-free authority boundary', () => {
    const source = fs.readFileSync(routePath, 'utf8');
    const approvalImport = source.indexOf("const { approveRegisteredAddScenarioDraft } = require('../services/addScenarioApproval');");
    const decorator = source.indexOf('function decorateAddScenarioDraftPreview(');
    const advertisedEndpoint = source.indexOf('`/projects/${encodeURIComponent(projectId)}/scenarios/drafts/${encodeURIComponent(draftId)}/approve`', decorator);
    const doublePrefixedEndpoint = source.indexOf('`/api/projects/${encodeURIComponent(projectId)}/scenarios/drafts/${encodeURIComponent(draftId)}/approve`', decorator);
    const approvalRoute = source.indexOf("'/drafts/:draftId/approve'", advertisedEndpoint);
    const ownershipCheck = source.indexOf('project = await getProject(req);', approvalRoute);
    const serviceCall = source.indexOf('await approveRegisteredAddScenarioDraft({', ownershipCheck);
    const approvalResponse = source.indexOf("mode: 'add_scenario_approved'", serviceCall);
    const conflictDraftLookup = source.indexOf('addScenarioDraftRegistry.get({', approvalResponse);
    const conflictPreview = source.indexOf('preview: currentPreview', conflictDraftLookup);
    const deleteRoute = source.indexOf("router.delete('/:id'", conflictPreview);

    expect(approvalImport).toBeGreaterThan(0);
    expect(advertisedEndpoint).toBeGreaterThan(decorator);
    expect(doublePrefixedEndpoint).toBe(-1);
    expect(approvalRoute).toBeGreaterThan(advertisedEndpoint);
    expect(ownershipCheck).toBeGreaterThan(approvalRoute);
    expect(serviceCall).toBeGreaterThan(ownershipCheck);
    expect(approvalResponse).toBeGreaterThan(serviceCall);
    expect(conflictDraftLookup).toBeGreaterThan(approvalResponse);
    expect(conflictPreview).toBeGreaterThan(conflictDraftLookup);
    expect(deleteRoute).toBeGreaterThan(conflictPreview);

    const approvalSlice = source.slice(approvalRoute, deleteRoute);
    expect(approvalSlice).toContain('requireCsrf');
    expect(approvalSlice).toContain('requestBody.sourceDigest || requestBody.previewDigest || requestBody.digest');
    expect(approvalSlice).toContain('generationId,');
    expect(approvalSlice).toContain('registry: addScenarioDraftRegistry');
    expect(approvalSlice).toContain('persisted: true');
    expect(approvalSlice).toContain('authority: {');
    expect(approvalSlice).toContain('persisted: false');
    expect(approvalSlice).toContain('preview: currentPreview');
    expect(approvalSlice).not.toContain('requestBody.steps');
    expect(approvalSlice).not.toContain('requestBody.cases');
    expect(approvalSlice).not.toContain('addScenarioSemanticPlanner.planAddScenario');
    expect(approvalSlice).not.toContain('planAddScenarioRefinementIntent');
  });
});
