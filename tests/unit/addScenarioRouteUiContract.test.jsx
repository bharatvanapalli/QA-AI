import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/apiClient';
import {
  buildAddScenarioApprovalRequest,
  formatAddScenarioFailure,
  isAddScenarioApprovalPersistenceConfirmed,
  isValidNewerAddScenarioPreview,
  normalizeAddScenarioPreviewPayload,
  summarizeAddScenarioPreviewChanges,
  validationSummaryForCase,
} from '../../src/pages/TestCases';

function read(relativePath) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('Add Scenario route and UI contract', () => {
  it('shows compiler code, report counts, and detailed finding codes', () => {
    const error = new ApiError(422, {
      code: 'TEST_DESIGN_STEP_COMPILATION_FAILED',
      message: 'Candidate steps do not conform to the immutable plan.',
      findings: [
        {
          code: 'inline_literal_boundary_violation',
          reason: 'A short inline value was substituted inside an ordinary word.',
          expected: 'whole authored value',
          actual: 'partial word match',
        },
        {
          code: 'metadata_became_executable',
          message: 'Failure policy text was emitted as a browser action.',
        },
      ],
      report: { compilerReport: { plannedCases: 1, compiledCases: 0 } },
    });

    const formatted = formatAddScenarioFailure(error);

    expect(formatted.title).toContain('TEST_DESIGN_STEP_COMPILATION_FAILED');
    expect(formatted.message).toContain('0 of 1 planned case(s) compiled');
    expect(formatted.message).toContain('inline_literal_boundary_violation');
    expect(formatted.message).toContain('whole authored value');
    expect(formatted.message).toContain('partial word match');
    expect(formatted.message).toContain('metadata_became_executable');
  });

  it('surfaces exact step binding diagnostics while redacting sensitive observed values', () => {
    const error = new ApiError(422, {
      code: 'TEST_DESIGN_STEP_COMPILATION_FAILED',
      message: 'Candidate steps do not conform to the immutable plan.',
      findings: [{
        code: 'test_design_step_data_binding_drift',
        stepOrdinal: 8,
        contractStepId: 'case_1_step_008',
        reason: 'candidate_explicit_value_not_authorized',
        detail: 'Candidate supplied an explicit value not authorized by the contract.',
        expectedDataRefs: ['data.password'],
        actualDataRefs: [],
        observedValues: ['NeverExposeThisValue'],
        authoredStep: { action: 'Fill', target: 'Account password', text: 'Enter the approved credential.' },
        candidateStep: { action: 'Fill', target: 'Account password', text: 'Enter NeverExposeThisValue.' },
        resolutionDecision: 'rejected_candidate_contradiction',
      }],
      report: { compilerReport: { plannedCases: 1, compiledCases: 0 } },
    });

    const formatted = formatAddScenarioFailure(error);

    expect(formatted.message).toContain('Step 8 (case_1_step_008)');
    expect(formatted.message).toContain('candidate_explicit_value_not_authorized');
    expect(formatted.message).toContain('expected refs=[data.password]');
    expect(formatted.message).toContain('authored {action=Fill, target=Account password}');
    expect(formatted.message).toContain('decision=rejected_candidate_contradiction');
    expect(formatted.message).toContain('observed values=[[redacted]]');
    expect(formatted.message).not.toContain('NeverExposeThisValue');
  });

  it('uses one prevalidated persistence contract in every TestScenario create path', () => {
    const route = read('server/routes/scenarios.js');
    const agentsRoute = read('server/routes/agents.js');
    const persistenceContract = read('server/services/scenarioPersistenceContract.js');
    const appendBlock = route.slice(
      route.indexOf('for (const persistenceRow of scenarioPersistenceRows)'),
      route.indexOf('createdScenarioIds.push'),
    );
    const regenerateBlock = route.slice(
      route.indexOf('for (const persistenceRow of replacementPersistenceRows)'),
      route.indexOf('// Enterprise Mode P1', route.indexOf('for (const persistenceRow of replacementPersistenceRows)')),
    );
    const fullGenerationBlock = agentsRoute.slice(
      agentsRoute.indexOf('for (const persistenceRow of scenarioPersistenceRows)'),
      agentsRoute.indexOf('// Enterprise Mode P1', agentsRoute.indexOf('for (const persistenceRow of scenarioPersistenceRows)')),
    );

    for (const block of [appendBlock, regenerateBlock, fullGenerationBlock]) {
      expect(block).toContain('data: buildScenarioCreateData({');
      expect(block).toContain('metadata: persistenceRow.metadata');
      expect(block).toContain('projectId: project.id');
    }
    expect((route.match(/moduleName: persistenceRow\.metadata\.module/g) || [])).toHaveLength(2);
    expect((agentsRoute.match(/moduleName: persistenceRow\.metadata\.module/g) || [])).toHaveLength(1);
    expect(route.indexOf('const scenarioPersistenceRows = normalizeScenarioPersistenceBatch(scenariosToPersist)'))
      .toBeLessThan(route.indexOf('const txState = await prisma.$transaction'));
    expect(route.indexOf('const replacementPersistenceRows = normalizeScenarioPersistenceBatch(replacements)'))
      .toBeLessThan(route.indexOf('await prisma.$transaction(async (tx)', route.indexOf('const replacementPersistenceRows')));
    expect(agentsRoute.indexOf('const scenarioPersistenceRows = normalizeScenarioPersistenceBatch(architectResult.scenarios)'))
      .toBeLessThan(agentsRoute.indexOf('const persistenceResult = await prisma.$transaction'));
    expect(persistenceContract).toContain('project: { connect: { id: normalizedProjectId } }');
    expect(persistenceContract).toContain('generation: { connect: { id: normalizedGenerationId } }');
    expect(route).toContain('sourceGrounding.ingestFirecrawlSourceArtifacts({\n            prisma,\n            projectId: project.id,');
  });

  it('keeps continuation and explicit atlas rebuild in the same append request', () => {
    const ui = read('src/pages/TestCases.jsx');

    expect(ui).toContain('continuationParentCaseId: continueFromCase ? selectedContinuation?.id || null : null');
    expect(ui).toContain("continuationSessionMode: continueFromCase ? 'continue_from_dependency' : null");
    expect(ui).toContain('forceAtlasRefresh,');
    expect(ui).toContain('forceAtlasRefresh: forceAtlasRefresh === true');
    expect(ui).toContain('Rebuild the site atlas before authoring');
    expect(ui).toContain('Off by default. Keep it off to reuse the current compatible atlas');
  });

  it('reuses a fresh compatible atlas for incremental authoring', () => {
    const route = read('server/routes/scenarios.js');

    expect(route).toContain('const reuseFreshAppendAtlas = appendToCurrent');
    expect(route).toContain('&& !explicitAtlasRefresh');
    expect(route).toContain("&& atlasSufficiency !== 'insufficient'");
    expect(route).toContain('&& atlasAgeMs <= AUTO_CRAWL_STALE_MS');
    expect(route).toContain('Using the existing fresh compatible site atlas for incremental Add Scenario authoring');
    expect(route).toContain(': plannedRefreshDecision;');
  });

  it('renders a bounded validation summary from structured declarations with a legacy fallback', () => {
    const legacyAssertions = Array.from(
      { length: 30 },
      (_, index) => `text Verify independent outcome ${index + 1} ${'x'.repeat(220)}`,
    ).join('; ');
    const structured = validationSummaryForCase({
      declaredAssertions: JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
        id: `assert-${index + 1}`,
        type: 'TEXT',
        payload: { expectedText: `Outcome ${index + 1}` },
      }))),
      assertions: legacyAssertions,
    });

    expect(structured.label).toBe('30 validations');
    expect(structured.details).toHaveLength(6);
    expect(structured.details.every((detail) => detail.length <= 180)).toBe(true);
    expect(structured.remainingCount).toBe(24);

    const fallback = validationSummaryForCase({
      declaredAssertions: 'malformed-json',
      assertions: 'visible Verify the page; ; text Verify the value\nnumber Verify the identifier',
    });
    expect(fallback.label).toBe('3 validations');
    expect(fallback.details).toHaveLength(3);

    const ui = read('src/pages/TestCases.jsx');
    expect(ui).toContain('<details className="group/validations');
    expect(ui).toContain('View details');
    expect(ui).toContain('Hide details');
    expect(ui).not.toContain('<p className="text-xs text-ink-500 mt-1 leading-relaxed">{tc.assertions}</p>');
  });

  it('normalizes a non-persisting Add Scenario draft for review without changing the generation', () => {
    const preview = normalizeAddScenarioPreviewPayload({
      status: 'preview',
      persisted: false,
      currentGenerationUnchanged: true,
      previewId: 'draft-1',
      revision: 'sha256-revision-1',
      digest: 'digest-1',
      approvalEligible: true,
      approval: { endpoint: '/scenario-drafts/draft-1/approve' },
      caseContractV1: {
        cases: [{
          name: 'Create a record in the authenticated session',
          intent: 'Continue from the approved login case and verify the saved record.',
          sessionRequirement: {
            mode: 'continue_from_case',
            predecessorCaseId: 'case-login',
            reason: 'The user is already authenticated.',
          },
          dataBindings: [{ name: 'Order Number', value: '007995145', classification: 'normal' }],
          steps: [{
            id: 'step-1',
            ordinal: 1,
            type: 'Fill',
            targetIdentity: { label: 'Order Number' },
            value: '007995145',
            sourceQuote: 'Enter 007995145 in Order Number.',
          }],
          assertions: [{
            id: 'assert-1',
            ordinal: 2,
            type: 'AssertText',
            targetIdentity: { label: 'Order Number' },
            expected: '007995145',
            comparator: 'equals',
          }],
        }],
        sourceCoverage: [{
          sourceClauseRef: 'source-1',
          disposition: 'action',
          sourceQuote: 'Enter 007995145 in Order Number.',
          refId: 'step-1',
        }],
        clarifications: [],
      },
    }, { originalDesign: 'messy authored paragraph', generationId: 'generation-current' });

    expect(preview.persisted).toBe(false);
    expect(preview.draftId).toBe('draft-1');
    expect(preview.revision).toBe('sha256-revision-1');
    expect(preview.currentGenerationUnchanged).toBe(true);
    expect(preview.generationId).toBe('generation-current');
    expect(preview.cases).toHaveLength(1);
    expect(preview.cases[0].session.sameSession).toBe(true);
    expect(preview.cases[0].session.predecessorCaseId).toBe('case-login');
    expect(preview.cases[0].dataBindings[0].value).toBe('007995145');
    expect(preview.cases[0].actions[0]).toMatchObject({ type: 'Fill', target: 'Order Number', value: '007995145' });
    expect(preview.cases[0].assertions[0]).toMatchObject({ type: 'AssertText', expected: '007995145', comparator: 'equals' });
    expect(preview.sourceCoverage[0].sourceQuote).toContain('007995145');
    expect(preview.approval.enabled).toBe(true);
  });

  it('maps the live AddScenarioPreviewV1 shape including nested cases and structured review issues', () => {
    const preview = normalizeAddScenarioPreviewPayload({
      mode: 'add_scenario_preview',
      persisted: false,
      generationId: 'generation-current',
      preview: {
        version: 'AddScenarioPreviewV1',
        previewId: 'preview-live-1',
        revision: 'sha256-live-revision',
        status: 'needs_review',
        approvalEligible: false,
        persistence: { status: 'not_persisted', currentGenerationId: 'generation-current' },
        source: {
          coverage: [{ sourceClauseRef: 'clause-1', disposition: 'action', sourceQuote: 'Fill 007.' }],
          completeness: { totalUnits: 2, claimedUnits: 1, unresolved: 1, complete: false },
        },
        scenarios: [{
          name: 'Nested live scenario',
          cases: [{
            id: 'case-live-1',
            name: 'Nested live case',
            continuation: { mode: 'continue_from_case', predecessorCaseId: 'case-login' },
            inlineLiterals: [{ recordId: 'step-live-1', field: 'value', value: '007', classification: 'normal' }],
            steps: [{ id: 'step-live-1', ordinal: 1, type: 'Fill', targetIdentity: { label: 'Code' }, value: '007' }],
            assertions: [],
          }],
        }],
        clarifications: {
          questions: [{ id: 'question-1', question: 'Which Save button?', reason: 'Two controls match.', blocking: true }],
          findings: [{ code: 'source_gap', detail: 'One clause is unresolved.', severity: 'error' }],
          error: null,
        },
      },
    });

    expect(preview).toMatchObject({
      draftId: 'preview-live-1',
      revision: 'sha256-live-revision',
      persisted: false,
      currentGenerationUnchanged: true,
      generationId: 'generation-current',
    });
    expect(preview.cases).toHaveLength(1);
    expect(preview.cases[0].session.sameSession).toBe(true);
    expect(preview.cases[0].dataBindings[0]).toMatchObject({ name: 'value', value: '007' });
    expect(preview.clarifications.map((item) => item.question)).toEqual([
      'Which Save button?',
      'One clause is unresolved.',
    ]);
    expect(preview.coverage).toMatchObject({ total: 2, covered: 1, unresolved: 1 });
  });

  it('does not mislabel a legacy persisted Add Scenario response as a draft preview', () => {
    expect(normalizeAddScenarioPreviewPayload({
      success: true,
      generationId: 'generation-persisted',
      scenarios: [{ id: 'scenario-1' }],
      stats: { scenarios: 1, cases: 1 },
    })).toBeNull();
  });

  it('enables an advertised approval endpoint and builds the exact revision-bound payload', () => {
    const endpoint = '/projects/project-1/scenario-drafts/draft-approve/approve';
    const preview = normalizeAddScenarioPreviewPayload({
      mode: 'add_scenario_preview',
      persisted: false,
      generationId: 'generation-current',
      preview: {
        version: 'AddScenarioPreviewV1',
        previewId: 'draft-approve',
        revision: 'sha256-approve',
        digest: 'sha256-source',
        approvalEligible: true,
        approval: { endpoint },
        persistence: { status: 'not_persisted', currentGenerationId: 'generation-current' },
        scenarios: [{
          name: 'Draft scenario',
          cases: [{ id: 'case-1', name: 'Draft case', steps: [], assertions: [] }],
        }],
        clarifications: { questions: [], findings: [], error: null },
      },
    });

    expect(preview.approval).toMatchObject({ endpoint, enabled: true });
    expect(buildAddScenarioApprovalRequest(preview, 'generation-current')).toEqual({
      draftId: 'draft-approve',
      revision: 'sha256-approve',
      sourceDigest: 'sha256-source',
      generationId: 'generation-current',
    });
  });

  it('accepts only explicit persistence confirmation from an approval response', () => {
    expect(isAddScenarioApprovalPersistenceConfirmed({ persisted: true })).toBe(true);
    expect(isAddScenarioApprovalPersistenceConfirmed({ persistence: { status: 'persisted' } })).toBe(true);
    expect(isAddScenarioApprovalPersistenceConfirmed({
      persisted: false,
      code: 'ADD_SCENARIO_DRAFT_REVISION_STALE',
    })).toBe(false);
    expect(isAddScenarioApprovalPersistenceConfirmed({
      preview: { persistence: { status: 'not_persisted' } },
    })).toBe(false);
  });

  it('turns reviewable semantic findings into clarification-first preview state', () => {
    const preview = normalizeAddScenarioPreviewPayload({
      code: 'ADD_SCENARIO_SEMANTIC_OUTPUT_INVALID',
      message: 'The provider output needs review.',
      findings: [{
        code: 'semantic_intent_target_underspecified',
        message: 'Choose which Save control the authored step means.',
        blocking: true,
        sourceQuote: 'Click Save.',
      }],
    });

    expect(preview).not.toBeNull();
    expect(preview.cases).toEqual([]);
    expect(preview.clarifications).toHaveLength(1);
    expect(preview.clarifications[0]).toMatchObject({
      question: 'Choose which Save control the authored step means.',
      blocking: true,
    });
    expect(preview.approval.enabled).toBe(false);
  });

  it('accepts only a newer revision of the same non-persisted draft and summarizes exact changes', () => {
    const current = normalizeAddScenarioPreviewPayload({
      status: 'preview', persisted: false, currentGenerationUnchanged: true,
      previewId: 'draft-safe', revision: 'sha256-old', generationId: 'generation-1',
      cases: [{ id: 'case-1', steps: [
        { id: 'step-1', type: 'Fill', target: 'Email', value: 'a@example.test' },
        { id: 'step-2', type: 'Click', target: 'Continue' },
      ], assertions: [] }],
    });
    const newer = normalizeAddScenarioPreviewPayload({
      status: 'preview', persisted: false, currentGenerationUnchanged: true,
      previewId: 'draft-safe', revision: 'sha256-new', generationId: 'generation-1',
      cases: [{ id: 'case-1', steps: [
        { id: 'step-1', type: 'Fill', target: 'Email', value: 'b@example.test' },
        { id: 'step-2', type: 'Click', target: 'Continue' },
        { id: 'step-3', type: 'Click', target: 'Confirm' },
      ], assertions: [] }],
    });
    const stale = { ...newer, revision: 'sha256-old' };
    const wrongDraft = { ...newer, draftId: 'draft-other' };
    const persisted = { ...newer, persisted: true };

    expect(isValidNewerAddScenarioPreview(current, newer)).toBe(true);
    expect(isValidNewerAddScenarioPreview(current, stale)).toBe(false);
    expect(isValidNewerAddScenarioPreview(current, wrongDraft)).toBe(false);
    expect(isValidNewerAddScenarioPreview(current, persisted)).toBe(false);

    const changes = summarizeAddScenarioPreviewChanges(current, newer);
    expect(changes.changed.map((entry) => entry.disposition).sort()).toEqual(['added', 'modified']);
    expect(changes.preserved).toHaveLength(1);
    expect(changes.preserved[0].label).toContain('Continue');
  });

  it('wires preview-only generation and explicit review controls in the Tests UI', () => {
    const ui = read('src/pages/TestCases.jsx');

    expect(ui).toContain('previewOnly: true');
    expect(ui).toContain('persist: false');
    expect(ui).toContain("reviewMode: 'preview'");
    expect(ui).toContain('Current generation remains unchanged until this draft is explicitly approved.');
    expect(ui).toContain('Review scenario draft');
    expect(ui).toContain('Discard');
    expect(ui).toContain('Refine');
    expect(ui).toContain('Approve');
    expect(ui).toContain('const approvalEndpoint = addScenarioPreview?.approval?.endpoint;');
    expect(ui).toContain('const approvalRequest = buildAddScenarioApprovalRequest(addScenarioPreview, currentGenerationId);');
    expect(ui).toContain('api.post(approvalEndpoint, approvalRequest)');
    expect(ui).toContain('if (!isAddScenarioApprovalPersistenceConfirmed(res))');
    expect(ui).toContain('The reviewed draft was retained.');
    expect(ui).toContain('previewId: currentPreview.draftId');
    expect(ui).toContain('previewRevision: currentPreview.revision');
    expect(ui).toContain('refinementGuidance: refinementGuidance.trim()');
    expect(ui).toContain('isValidNewerAddScenarioPreview(currentPreview, nextPreview)');
    expect(ui).toContain('Refinement changes');
    expect(ui).toContain('changed /');
    expect(ui).toContain('preserved');

    const approvalHandler = ui.slice(
      ui.indexOf('const handleApproveAddScenarioPreview = useCallback'),
      ui.indexOf('const handleApproveAll = useCallback'),
    );
    const persistenceIndex = approvalHandler.indexOf('if (!isAddScenarioApprovalPersistenceConfirmed(res))');
    const refreshIndex = approvalHandler.indexOf('await refreshGenerations()');
    const reloadIndex = approvalHandler.indexOf('const reloaded = await load()');
    const closeIndex = approvalHandler.indexOf('setAddScenarioPreview(null)');
    expect(persistenceIndex).toBeGreaterThanOrEqual(0);
    expect(persistenceIndex).toBeLessThan(refreshIndex);
    expect(refreshIndex).toBeLessThan(reloadIndex);
    expect(reloadIndex).toBeLessThan(closeIndex);
    expect(approvalHandler).toContain("approvalPersisted\n          ? 'Scenario saved; refresh needed'");
    expect(approvalHandler).not.toContain('setAddScenarioPreview(nextPreview)');
    expect(approvalHandler).not.toContain('switchGeneration(');
    expect(approvalHandler).not.toContain('previewDigest:');

    const interpretationApprovalHandler = ui.slice(
      ui.indexOf('const handleApproveInterpretationPreview = useCallback'),
      ui.indexOf('const handleAddScenario = useCallback'),
    );
    const interpretationPersistence = interpretationApprovalHandler.indexOf('if (!isAddScenarioApprovalPersistenceConfirmed(approvalResult))');
    const interpretationRefresh = interpretationApprovalHandler.indexOf('await refreshGenerations()');
    const interpretationReload = interpretationApprovalHandler.indexOf('const reloaded = await load()');
    const interpretationClose = interpretationApprovalHandler.indexOf('setInterpretationPreview(null)');
    expect(interpretationPersistence).toBeGreaterThanOrEqual(0);
    expect(interpretationPersistence).toBeLessThan(interpretationRefresh);
    expect(interpretationRefresh).toBeLessThan(interpretationReload);
    expect(interpretationReload).toBeLessThan(interpretationClose);
    expect(ui).toContain('await api.post(`/projects/${current.id}/agents/execute`, { runMode, generationId: executionGenerationId });');
  });

  it('does not report a metadata-only scenario job resume as successful recovery', () => {
    const route = read('server/routes/scenarios.js');
    expect(route).toContain('const resumed = await reliabilityJobs.resumeScenarioGenerationJob(');
    expect(route).toContain('if (recovery.resumeAccepted !== true)');
    expect(route).toContain("code: recovery.code || 'SCENARIO_GENERATION_RESUME_UNAVAILABLE'");
    expect(route).toContain("return res.status(409).json({");
  });
});
