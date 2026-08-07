import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { buildAddScenarioPreview } = require('../../server/services/addScenarioPreview');
const { createAddScenarioDraftRegistry } = require('../../server/services/addScenarioDraftRegistry');
const testDesignStepCompiler = require('../../server/services/testDesignStepCompiler');
const caseContractSemanticValidator = require('../../server/services/caseContractSemanticValidator');
const architect = require('../../server/services/agents/architect');
const declaredAssertions = require('../../server/lib/declaredAssertions');
const {
  approveRegisteredAddScenarioDraft,
  _private: { authoritativeSourceOfDraft, compileApprovedDraft },
} = require('../../server/services/addScenarioApproval');

const SOURCE = [
  'Continue in the current authenticated session.',
  'Fill Order Number with 007995145.',
  'Verify that the Order Number equals 007995145.',
].join('\n');

function sourceClauses(sourceText, dispositions) {
  let offset = 0;
  return sourceText.split('\n').map((sourceQuote, index) => {
    const start = offset;
    offset += sourceQuote.length + 1;
    return {
      id: `source.${index + 1}`,
      ordinal: index + 1,
      disposition: dispositions[index],
      sourceQuote,
      sourceSpan: { start, end: start + sourceQuote.length },
    };
  });
}

function targetIdentity(label, role, kind = 'control', scope = 'Order form') {
  return { kind, label, role, scope };
}

function semanticPlan() {
  const fill = 'Fill Order Number with 007995145.';
  const assertion = 'Verify that the Order Number equals 007995145.';
  return {
    sourceCompleteness: { complete: true, findings: [], consumedSourceUnitIds: ['source.1', 'source.2', 'source.3'] },
    caseContractV1: {
      version: 'CaseContractV1',
      sourceClauses: sourceClauses(SOURCE, ['metadata', 'action', 'assertion']),
      cases: [{
        id: 'case.order',
        name: 'Continue order creation',
        intent: 'Populate one order number.',
        sourceQuote: SOURCE,
        initialState: { description: 'Authenticated dashboard', sourceClauseRefs: ['source.1'] },
        expectedFinalState: { description: 'Order form populated', sourceClauseRefs: ['source.3'] },
        sessionRequirement: {
          mode: 'continue_from_case',
          predecessorCaseId: 'case.login',
          dependsOnCaseRefs: ['case.login'],
          sourceClauseRefs: ['source.1'],
        },
        failurePolicy: { default: 'stop_descendants', sourceClauseRefs: ['source.3'] },
        steps: [{
          id: 'step.fill-order',
          ordinal: 1,
          type: 'Fill',
          text: fill,
          targetIdentity: targetIdentity('Order Number', 'textbox', 'field'),
          value: '007995145',
          sourceQuote: fill,
          sourceClauseRefs: ['source.2'],
          dataRefs: [],
          dependsOn: [],
          flowImpact: 'state_change',
          failureBehavior: 'stop_descendants',
        }],
        assertions: [{
          id: 'assert.order-number',
          ordinal: 1,
          type: 'AssertValue',
          text: assertion,
          targetIdentity: targetIdentity('Order Number', 'textbox', 'field'),
          comparator: 'equals',
          payload: {
            channel: 'state',
            operands: [
              { role: 'actual', kind: 'target_property', property: 'value' },
              { role: 'expected', kind: 'literal', value: '007995145' },
            ],
          },
          sourceQuote: assertion,
          sourceClauseRefs: ['source.3'],
          dataRefs: [],
          stepId: 'step.fill-order',
          required: true,
          failureBehavior: 'stop_case',
        }],
        metadata: [],
        dataBindings: [],
        clarifications: [],
      }],
    },
  };
}

function authority(plan = semanticPlan()) {
  const preview = buildAddScenarioPreview({
    projectId: 'project-1',
    currentGenerationId: 'generation-5',
    sourceText: SOURCE,
    semanticPlan: plan,
  });
  const registry = createAddScenarioDraftRegistry();
  const stored = registry.put({
    userId: 'user-1',
    projectId: 'project-1',
    preview,
    revision: preview.revision,
    sourceDigest: preview.source.digest,
    originalSource: SOURCE,
    semanticPlan: plan,
    currentGenerationId: 'generation-5',
  });
  return { registry, draft: stored.draft, preview };
}

function database(initialState = {}) {
  let state = {
    coveragePlanJson: initialState.coveragePlanJson || null,
    scenarioIds: [...(initialState.scenarioIds || [])],
    caseIds: [...(initialState.caseIds || [])],
  };
  let transactionCalls = 0;
  let scenarioSequence = state.scenarioIds.length;
  let caseSequence = state.caseIds.length;
  const prisma = {
    scenarioGeneration: {
      findFirst: vi.fn(async ({ where }) => (
        where.projectId === 'project-1' && where.isCurrent === true
          ? { id: 'generation-5', coveragePlanJson: state.coveragePlanJson }
          : null
      )),
    },
    $transaction: vi.fn(async (work) => {
      transactionCalls += 1;
      const working = JSON.parse(JSON.stringify(state));
      const tx = {
        __working: working,
        scenarioGeneration: {
          findFirst: vi.fn(async ({ where }) => (
            where.projectId === 'project-1' && where.isCurrent === true
              ? { id: 'generation-5', projectId: 'project-1', isCurrent: true, coveragePlanJson: working.coveragePlanJson }
              : null
          )),
          updateMany: vi.fn(async ({ where, data }) => {
            if (where.id !== 'generation-5'
              || where.projectId !== 'project-1'
              || where.isCurrent !== true
              || where.coveragePlanJson !== working.coveragePlanJson) return { count: 0 };
            if (Object.prototype.hasOwnProperty.call(data, 'coveragePlanJson')) working.coveragePlanJson = data.coveragePlanJson;
            return { count: 1 };
          }),
        },
        testScenario: {
          create: vi.fn(async () => {
            const id = `scenario-${++scenarioSequence}`;
            working.scenarioIds.push(id);
            return { id };
          }),
        },
      };
      const result = await work(tx);
      state = working;
      return result;
    }),
  };
  const persistCases = vi.fn(async ({ prisma: tx, cases }) => cases.map((source) => {
    const id = `case-${++caseSequence}`;
    tx.__working.caseIds.push(id);
    return { tc: { id }, source, dependsOnNames: [] };
  }));
  const syncScenarioGenerationCounts = vi.fn(async (tx) => ({
    scenarioCount: tx.__working.scenarioIds.length,
    caseCount: tx.__working.caseIds.length,
  }));
  return {
    prisma,
    persistCases,
    syncScenarioGenerationCounts,
    state: () => JSON.parse(JSON.stringify(state)),
    transactionCalls: () => transactionCalls,
  };
}

function request(draft) {
  return {
    userId: 'user-1',
    projectId: 'project-1',
    draftId: draft.draftId,
    revision: draft.revision,
    sourceDigest: draft.sourceDigest,
    generationId: 'generation-5',
  };
}

describe('Add Scenario registered-draft approval', () => {
  it('compiles refined drafts from their exact authoritative source and keeps original source for unrefined drafts', () => {
    const refinement = 'Change Pickup Number to 7995145888.';
    expect(authoritativeSourceOfDraft({
      originalSource: SOURCE,
      semanticPlan: { authoritativeSourceText: `${SOURCE}\n${refinement}` },
    })).toBe(`${SOURCE}\n${refinement}`);
    expect(authoritativeSourceOfDraft({ originalSource: SOURCE, semanticPlan: {} })).toBe(SOURCE);
  });

  it('preserves generic complex action values and assertion semantics through the approval compiler', () => {
    const complexSource = [
      'Continue in the current authenticated session.',
      'Select Ship Date & Time in Delivery mode when it is not selected.',
      'Select Early date 2026-08-20.',
      'Select Early time 09:00.',
      'Select the Time zone option whose label contains Central.',
      'Expand Details when it is collapsed.',
      'Verify Continue is enabled.',
      'Verify Options are exactly Alpha, Beta in that order.',
      'Verify Early date equals 2026-08-20.',
      'Verify Early pickup 2026-08-20T09:00:00Z is before Late pickup 2026-08-20T11:00:00Z.',
    ].join('\n');
    const plan = semanticPlan();
    plan.authoritativeSourceText = complexSource;
    plan.caseContractV1.sourceClauses = sourceClauses(complexSource, [
      'metadata', 'action', 'action', 'action', 'action', 'action',
      'assertion', 'assertion', 'assertion', 'assertion',
    ]);
    const contractCase = plan.caseContractV1.cases[0];
    contractCase.sourceQuote = complexSource;
    contractCase.initialState = { description: 'Authenticated dashboard', sourceClauseRefs: ['source.1'] };
    contractCase.expectedFinalState = { description: 'Complex controls validated', sourceClauseRefs: ['source.10'] };
    contractCase.sessionRequirement.sourceClauseRefs = ['source.1'];
    contractCase.failurePolicy.sourceClauseRefs = ['source.10'];
    contractCase.steps = [
      {
        id: 'step.radio', ordinal: 1, type: 'Radio', text: 'Select Ship Date & Time in Delivery mode.',
        sourceQuote: complexSource.split('\n')[1], sourceClauseRefs: ['source.2'],
        targetIdentity: targetIdentity('Delivery mode', 'radio'), value: 'Ship Date & Time',
        condition: {
          kind: 'target_state', comparator: 'not_equals',
          operands: [{ property: 'selected' }, { value: true }],
        },
        dataRefs: [], dependsOn: [], flowImpact: 'state_change', failureBehavior: 'stop_descendants',
      },
      {
        id: 'step.date', ordinal: 2, type: 'Date', text: 'Select Early date 2026-08-20.',
        sourceQuote: complexSource.split('\n')[2], sourceClauseRefs: ['source.3'],
        targetIdentity: targetIdentity('Early date', 'combobox', 'field'), value: '2026-08-20',
        dataRefs: [], dependsOn: ['step.radio'], flowImpact: 'state_change', failureBehavior: 'stop_descendants',
      },
      {
        id: 'step.time', ordinal: 3, type: 'Time', text: 'Select Early time 09:00.',
        sourceQuote: complexSource.split('\n')[3], sourceClauseRefs: ['source.4'],
        targetIdentity: targetIdentity('Early time', 'combobox', 'field'), value: '09:00',
        dataRefs: [], dependsOn: ['step.date'], flowImpact: 'state_change', failureBehavior: 'stop_descendants',
      },
      {
        id: 'step.select', ordinal: 4, type: 'Select', text: 'Select the Time zone option whose label contains Central.',
        sourceQuote: complexSource.split('\n')[4], sourceClauseRefs: ['source.5'],
        targetIdentity: targetIdentity('Time zone', 'combobox', 'field'),
        selectionCriteria: { kind: 'predicate', predicate: 'label contains Central' },
        dataRefs: [], dependsOn: ['step.time'], flowImpact: 'state_change', failureBehavior: 'stop_descendants',
      },
      {
        id: 'step.expand', ordinal: 5, type: 'Expand', text: 'Expand Details when it is collapsed.',
        sourceQuote: complexSource.split('\n')[5], sourceClauseRefs: ['source.6'],
        targetIdentity: targetIdentity('Details', 'region', 'region'),
        condition: {
          kind: 'target_state', comparator: 'equals',
          operands: [{ property: 'expanded' }, { value: false }],
        },
        dataRefs: [], dependsOn: ['step.select'], flowImpact: 'state_change', failureBehavior: 'stop_descendants',
      },
    ];
    contractCase.assertions = [
      {
        id: 'assert.enabled', ordinal: 1, type: 'AssertEnabled', text: complexSource.split('\n')[6],
        sourceQuote: complexSource.split('\n')[6], sourceClauseRefs: ['source.7'],
        targetIdentity: targetIdentity('Continue', 'button'), comparator: 'enabled',
        payload: { channel: 'state', operands: [
          { role: 'actual', kind: 'target_property', property: 'enabled' },
          { role: 'expected', kind: 'boolean', value: true },
        ] },
        dataRefs: [], stepId: 'step.expand', required: true, failureBehavior: 'stop_case',
      },
      {
        id: 'assert.collection', ordinal: 2, type: 'AssertCollection', text: complexSource.split('\n')[7],
        sourceQuote: complexSource.split('\n')[7], sourceClauseRefs: ['source.8'],
        targetIdentity: targetIdentity('Options', 'listbox', 'collection'), comparator: 'collection_exact_order',
        payload: { channel: 'collection', operands: [
          { role: 'actual', kind: 'target_property', property: 'items' },
          { role: 'expected', kind: 'collection', items: ['Alpha', 'Beta'] },
        ] },
        dataRefs: [], stepId: 'step.select', required: true, failureBehavior: 'continue_independent',
      },
      {
        id: 'assert.date', ordinal: 3, type: 'AssertDate', text: complexSource.split('\n')[8],
        sourceQuote: complexSource.split('\n')[8], sourceClauseRefs: ['source.9'],
        targetIdentity: targetIdentity('Early date', 'textbox', 'field'), comparator: 'equals',
        payload: { channel: 'temporal', operands: [
          { role: 'actual', kind: 'target_property', property: 'value' },
          { role: 'expected', kind: 'literal', value: '2026-08-20' },
        ] },
        dataRefs: [], stepId: 'step.date', required: true, failureBehavior: 'stop_case',
      },
      {
        id: 'assert.temporal', ordinal: 4, type: 'AssertTemporal', text: complexSource.split('\n')[9],
        sourceQuote: complexSource.split('\n')[9], sourceClauseRefs: ['source.10'],
        targetIdentity: targetIdentity('Early versus late', 'group', 'collection'), comparator: 'before',
        payload: { channel: 'temporal', operands: [
          { role: 'actual', kind: 'temporal', name: 'Early pickup', temporalType: 'datetime', value: '2026-08-20T09:00:00Z' },
          { role: 'expected', kind: 'temporal', name: 'Late pickup', temporalType: 'datetime', value: '2026-08-20T11:00:00Z' },
        ] },
        dataRefs: [], stepId: 'step.time', required: true, failureBehavior: 'continue_independent',
      },
    ];

    const compiled = compileApprovedDraft({
      projectId: 'project-1',
      draft: { originalSource: SOURCE, semanticPlan: plan },
      existingManifest: {},
    });
    const compiledCase = compiled.scenarios[0].cases[0];

    expect(compiledCase.sessionMode).toBe('continue_from_dependency');
    expect(compiledCase.dependsOnIds).toEqual(['case.login']);
    expect(compiledCase.failurePolicy).toBe('stop_descendants');

    expect(compiledCase.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'step.radio', action: 'Radio', value: 'Ship Date & Time', condition: expect.any(Object) }),
      expect.objectContaining({ id: 'step.date', action: 'Date', value: '2026-08-20' }),
      expect.objectContaining({ id: 'step.time', action: 'Time', value: '09:00' }),
      expect.objectContaining({ id: 'step.select', action: 'Select', selectionCriteria: { kind: 'predicate', predicate: 'label contains Central' } }),
      expect.objectContaining({ id: 'step.expand', action: 'Expand', condition: expect.any(Object) }),
    ]));
    expect(compiledCase.declaredAssertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'assert.enabled', semanticType: 'AssertEnabled', comparator: 'enabled' }),
      expect.objectContaining({ id: 'assert.collection', semanticType: 'AssertCollection', expected: ['Alpha', 'Beta'] }),
      expect.objectContaining({ id: 'assert.date', semanticType: 'AssertDate', expected: '2026-08-20' }),
      expect.objectContaining({ id: 'assert.temporal', semanticType: 'AssertTemporal', comparator: 'before' }),
    ]));
    const normalizedAssertions = declaredAssertions.normalizeForCase(compiledCase.declaredAssertions, {
      projectId: 'project-1',
      scenarioId: 'scenario-1',
      caseId: compiledCase.id,
    });
    expect(normalizedAssertions.issues).toEqual([]);
    expect(normalizedAssertions.normalized.every((assertion) => assertion.parseFailed !== true)).toBe(true);
  });

  it('compiles and persists the registered authority once, then replays the durable result', async () => {
    const { registry, draft } = authority();
    const db = database();
    const dependencies = {
      prisma: db.prisma,
      registry,
      persistCases: db.persistCases,
      syncScenarioGenerationCounts: db.syncScenarioGenerationCounts,
    };

    const first = await approveRegisteredAddScenarioDraft(request(draft), dependencies);
    const second = await approveRegisteredAddScenarioDraft(request(draft), dependencies);

    expect(first).toMatchObject({
      success: true,
      persisted: true,
      generationId: 'generation-5',
      scenarioCountCreated: 1,
      caseCountCreated: 1,
    });
    expect(second).toEqual(first);
    expect(db.state().scenarioIds).toHaveLength(1);
    expect(db.state().caseIds).toHaveLength(1);
    expect(db.persistCases).toHaveBeenCalledTimes(1);
    expect(db.transactionCalls()).toBe(1);
    expect(JSON.parse(db.state().coveragePlanJson)).toMatchObject({
      testDesignPlanV1: { version: 'TestDesignPlanV1' },
      addScenarioApprovalLedger: { version: 'AddScenarioApprovalLedgerV1' },
    });
  });

  it('repairs and revalidates an approved scenario before persistence when the first strict compilation rejects it', async () => {
    const { registry, draft } = authority();
    const db = database();
    const normalizedAuthority = caseContractSemanticValidator.validateSemanticCaseContract(
      draft.semanticPlan.caseContractV1,
      { sourceText: SOURCE, maxSteps: 100 },
    ).contract.cases[0];
    const realScenario = architect.deterministicScenarioFromPack.bind(architect);
    const architectSpy = vi.spyOn(architect, 'deterministicScenarioFromPack')
      .mockImplementationOnce((pack, reason) => {
        const scenario = realScenario(pack, reason);
        scenario.cases[0].steps[0].value = 'unauthorized-candidate-drift';
        return scenario;
      });
    const compileSpy = vi.spyOn(testDesignStepCompiler, 'compileCandidateSuite');

    try {
      const result = await approveRegisteredAddScenarioDraft(request(draft), {
        prisma: db.prisma,
        registry,
        persistCases: db.persistCases,
        syncScenarioGenerationCounts: db.syncScenarioGenerationCounts,
      });

      expect(result).toMatchObject({
        success: true,
        persisted: true,
        scenarioCountCreated: 1,
        caseCountCreated: 1,
      });
      expect(db.state().scenarioIds).toHaveLength(1);
      expect(db.state().caseIds).toHaveLength(1);
      expect(compileSpy).toHaveBeenCalledTimes(2);
      const persistenceInput = db.persistCases.mock.calls[0][0];
      expect(persistenceInput).toEqual(expect.objectContaining({
        allowExplicitApprovalLineageOverride: false,
        testDesignPlanAuthority: expect.objectContaining({
          planId: expect.any(String),
          revision: expect.any(String),
        }),
      }));
      expect(persistenceInput.testDesignPlanAuthority.scenarios[0].cases[0].caseContractV1)
        .toEqual(normalizedAuthority);
      expect(persistenceInput.cases[0].caseContractV1).toEqual(normalizedAuthority);
      expect(JSON.stringify({
        cases: persistenceInput.cases,
        testDesignPlanAuthority: persistenceInput.testDesignPlanAuthority,
      })).not.toContain('unauthorized-candidate-drift');
      const ledgerEntries = Object.values(
        JSON.parse(db.state().coveragePlanJson).addScenarioApprovalLedger.entries,
      );
      expect(ledgerEntries).toHaveLength(1);
      expect(ledgerEntries[0]).toMatchObject({
        compilerDiagnostics: {
          ok: true,
          repairedBeforePersistence: true,
          repairSource: 'immutable_test_design_plan_case_contract_v1',
          originalFindings: expect.any(Array),
        },
      });
      expect(ledgerEntries[0].compilerDiagnostics.originalFindings.length).toBeGreaterThan(0);
      expect(JSON.stringify(ledgerEntries[0])).not.toContain('userApprovedOverride');
    } finally {
      compileSpy.mockRestore();
      architectSpy.mockRestore();
    }
  });

  it('rejects invalid approved authority before persistence', async () => {
    const invalidPlan = semanticPlan();
    invalidPlan.caseContractV1.cases[0].steps = [];
    const { registry, draft } = authority(invalidPlan);
    const db = database();

    await expect(approveRegisteredAddScenarioDraft(request(draft), {
      prisma: db.prisma,
      registry,
      persistCases: db.persistCases,
      syncScenarioGenerationCounts: db.syncScenarioGenerationCounts,
    })).rejects.toMatchObject({
      code: 'ADD_SCENARIO_APPROVAL_CONTRACT_INVALID',
      status: 422,
    });

    expect(db.persistCases).not.toHaveBeenCalled();
    expect(db.state()).toEqual({ coveragePlanJson: null, scenarioIds: [], caseIds: [] });
  });

  it('rejects blocking interpretation diagnostics before compilation or persistence', async () => {
    const plan = semanticPlan();
    plan.approvalDiagnostics = [{
      code: 'semantic_plan_authored_value_lost',
      severity: 'error',
      detail: 'The reviewed value was not preserved.',
    }];
    const { registry, draft } = authority(plan);
    const db = database();
    const compileSpy = vi.spyOn(testDesignStepCompiler, 'compileCandidateSuite');
    try {
      await expect(approveRegisteredAddScenarioDraft(request(draft), {
        prisma: db.prisma,
        registry,
        persistCases: db.persistCases,
        syncScenarioGenerationCounts: db.syncScenarioGenerationCounts,
      })).rejects.toMatchObject({
        code: 'ADD_SCENARIO_APPROVAL_DIAGNOSTICS_INVALID',
        status: 422,
        findings: [expect.objectContaining({ code: 'semantic_plan_authored_value_lost' })],
      });
      expect(compileSpy).not.toHaveBeenCalled();
      expect(db.persistCases).not.toHaveBeenCalled();
    } finally {
      compileSpy.mockRestore();
    }
  });

  it('never treats a falsy non-error throw as authority for deterministic repair', () => {
    const compileSpy = vi.spyOn(testDesignStepCompiler, 'compileCandidateSuite')
      .mockImplementationOnce(() => { throw null; });
    let caught = Symbol('not-thrown');
    try {
      compileApprovedDraft({
        projectId: 'project-1',
        draft: { originalSource: SOURCE, semanticPlan: semanticPlan() },
        existingManifest: {},
      });
    } catch (error) {
      caught = error;
    } finally {
      expect(compileSpy).toHaveBeenCalledTimes(1);
      compileSpy.mockRestore();
    }
    expect(caught).toBeNull();
  });

  it('fails closed when strict compilation also rejects the plan-authority repair', () => {
    const failure = () => new testDesignStepCompiler.TestDesignStepCompilationError(
      'Injected strict failure.',
      [{ code: 'injected_strict_failure', severity: 'error' }],
    );
    const compileSpy = vi.spyOn(testDesignStepCompiler, 'compileCandidateSuite')
      .mockImplementation(() => { throw failure(); });
    try {
      expect(() => compileApprovedDraft({
        projectId: 'project-1',
        draft: { originalSource: SOURCE, semanticPlan: semanticPlan() },
        existingManifest: {},
      })).toThrow(expect.objectContaining({
        code: 'ADD_SCENARIO_APPROVAL_REPAIR_FAILED',
        status: 422,
        repairFindings: [expect.objectContaining({ code: 'injected_strict_failure' })],
      }));
      expect(compileSpy).toHaveBeenCalledTimes(2);
    } finally {
      compileSpy.mockRestore();
    }
  });

  it('appends the explicitly approved scenario beside the existing case without replacing it', async () => {
    const { registry, draft } = authority();
    const db = database({
      scenarioIds: ['scenario-s1'],
      caseIds: ['case-c1'],
    });

    const result = await approveRegisteredAddScenarioDraft(request(draft), {
      prisma: db.prisma,
      registry,
      persistCases: db.persistCases,
      syncScenarioGenerationCounts: db.syncScenarioGenerationCounts,
    });

    expect(result).toMatchObject({
      persisted: true,
      scenarioCountCreated: 1,
      caseCountCreated: 1,
    });
    expect(db.state().scenarioIds).toEqual(['scenario-s1', 'scenario-2']);
    expect(db.state().caseIds).toEqual(['case-c1', 'case-2']);
    expect(db.persistCases).toHaveBeenCalledWith(expect.objectContaining({
      testDesignPlanAuthority: expect.objectContaining({
        planId: expect.any(String),
        revision: expect.any(String),
      }),
    }));
  });

  it('ignores a stale browser generation identity and persists into the server current generation', async () => {
    const { registry, draft } = authority();
    const db = database({ scenarioIds: ['scenario-s1'], caseIds: ['case-c1'] });

    const result = await approveRegisteredAddScenarioDraft({
      ...request(draft),
      generationId: 'stale-browser-generation',
    }, {
      prisma: db.prisma,
      registry,
      persistCases: db.persistCases,
      syncScenarioGenerationCounts: db.syncScenarioGenerationCounts,
    });

    expect(result).toMatchObject({
      success: true,
      persisted: true,
      generationId: 'generation-5',
    });
    expect(db.state().scenarioIds).toEqual(['scenario-s1', 'scenario-2']);
    expect(db.state().caseIds).toEqual(['case-c1', 'case-2']);
  });

  it('reconciles simultaneous duplicate approvals to one immutable persistence result', async () => {
    const { registry, draft } = authority();
    const db = database();
    let releasePersist;
    const persistBarrier = new Promise((resolve) => { releasePersist = resolve; });
    const persistCases = vi.fn(async (input) => {
      await persistBarrier;
      return db.persistCases(input);
    });
    const dependencies = {
      prisma: db.prisma,
      registry,
      persistCases,
      syncScenarioGenerationCounts: db.syncScenarioGenerationCounts,
    };

    const firstPromise = approveRegisteredAddScenarioDraft(request(draft), dependencies);
    await vi.waitFor(() => {
      expect(registry.get({ userId: 'user-1', projectId: 'project-1', draftId: draft.draftId }).draft.approval.status)
        .toBe('approving');
    });
    const duplicatePromise = approveRegisteredAddScenarioDraft(request(draft), dependencies);
    releasePersist();
    const [first, duplicate] = await Promise.all([firstPromise, duplicatePromise]);

    expect(duplicate).toEqual(first);
    expect(persistCases).toHaveBeenCalledTimes(1);
    expect(db.state().scenarioIds).toHaveLength(1);
    expect(db.state().caseIds).toHaveLength(1);
    expect(db.transactionCalls()).toBe(1);
  });

  it('replays the durable database ledger after the process-local registry is lost', async () => {
    const { registry, draft } = authority();
    const db = database();
    const dependencies = {
      prisma: db.prisma,
      registry,
      persistCases: db.persistCases,
      syncScenarioGenerationCounts: db.syncScenarioGenerationCounts,
    };
    const first = await approveRegisteredAddScenarioDraft(request(draft), dependencies);
    const restartedRegistry = createAddScenarioDraftRegistry();

    const replay = await approveRegisteredAddScenarioDraft(request(draft), {
      ...dependencies,
      registry: restartedRegistry,
    });

    expect(replay).toEqual({ ...first, replayed: true });
    expect(db.persistCases).toHaveBeenCalledTimes(1);
    expect(db.transactionCalls()).toBe(1);
    expect(db.state().scenarioIds).toHaveLength(1);
    expect(db.state().caseIds).toHaveLength(1);
  });

  it('rejects stale authority before opening a transaction', async () => {
    const { registry, draft } = authority();
    const db = database();
    await expect(approveRegisteredAddScenarioDraft({
      ...request(draft),
      revision: 'stale-revision',
    }, {
      prisma: db.prisma,
      registry,
      persistCases: db.persistCases,
      syncScenarioGenerationCounts: db.syncScenarioGenerationCounts,
    })).rejects.toMatchObject({ code: 'ADD_SCENARIO_DRAFT_REVISION_STALE', status: 409 });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rolls back a failed write and leaves the draft retryable', async () => {
    const { registry, draft } = authority();
    const db = database();
    const failingPersist = vi.fn(async () => {
      throw new Error('injected persistence failure');
    });
    const base = {
      prisma: db.prisma,
      registry,
      syncScenarioGenerationCounts: db.syncScenarioGenerationCounts,
    };
    await expect(approveRegisteredAddScenarioDraft(request(draft), {
      ...base,
      persistCases: failingPersist,
    })).rejects.toThrow('injected persistence failure');
    expect(db.state()).toEqual({ coveragePlanJson: null, scenarioIds: [], caseIds: [] });

    const retried = await approveRegisteredAddScenarioDraft(request(draft), {
      ...base,
      persistCases: db.persistCases,
    });
    expect(retried.persisted).toBe(true);
    expect(db.state().scenarioIds).toHaveLength(1);
    expect(db.state().caseIds).toHaveLength(1);
  });
});
