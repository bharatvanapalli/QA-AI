import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const planner = require('../../server/services/addScenarioSemanticPlanner');
const { buildSourceLedger } = require('../../server/services/addScenarioSourceLedger');

function sourceClaimsForPlan(source, plan) {
  const ledger = buildSourceLedger(source);
  const claims = [];
  const claimedUnits = new Set();
  const addRecordClaim = (record, disposition, caseIndex, recordKind, recordIndex) => {
    const matches = ledger.units.filter((unit) => {
      const exactUnit = source.slice(unit.sourceSpan.start, unit.sourceSpan.end);
      return exactUnit.includes(record.sourceQuote);
    });
    if (matches.length !== 1) throw new Error(`Test fixture sourceQuote did not resolve uniquely: ${record.sourceQuote}`);
    const unit = matches[0];
    claimedUnits.add(unit.id);
    claims.push({
      unitRef: unit.id,
      disposition,
      sourceQuote: record.sourceQuote,
      caseIndex,
      recordKind,
      recordIndex,
    });
  };
  plan.cases.forEach((caseIntent, caseIndex) => {
    caseIntent.actions.forEach((record, recordIndex) => addRecordClaim(record, 'action', caseIndex, 'action', recordIndex));
    caseIntent.assertions.forEach((record, recordIndex) => addRecordClaim(record, 'assertion', caseIndex, 'assertion', recordIndex));
  });
  (plan.unresolvedQuestions || []).forEach((question, unresolvedIndex) => {
    const matches = ledger.units.filter((unit) => source.slice(unit.sourceSpan.start, unit.sourceSpan.end).includes(question.sourceQuote));
    if (matches.length !== 1) throw new Error(`Test fixture unresolved sourceQuote did not resolve uniquely: ${question.sourceQuote}`);
    claimedUnits.add(matches[0].id);
    claims.push({
      unitRef: matches[0].id,
      disposition: 'unresolved',
      sourceQuote: question.sourceQuote,
      unresolvedIndex,
    });
  });
  ledger.units.forEach((unit) => {
    if (claimedUnits.has(unit.id)) return;
    claims.push({ unitRef: unit.id, disposition: 'metadata', sourceQuote: source.slice(unit.sourceSpan.start, unit.sourceSpan.end) });
  });
  return claims;
}

function semanticEnvelope(source, stepOverrides = {}) {
  const stepQuote = stepOverrides.sourceQuote || 'Click the Continue button.';
  const assertionQuote = 'Verify the Summary heading is visible.';
  const stepStart = source.indexOf(stepQuote);
  const assertionStart = source.indexOf(assertionQuote);
  return {
    version: 'CaseContractV1',
    partitioning: {
      mode: 'single_behavior_topology',
      explicitOneFlow: true,
      caseCount: 1,
      dataRowsDoNotCreateCases: true,
    },
    dataDictionary: [],
    dataRows: [],
    sourceClauses: [],
    unusedDataRefs: [],
    clarifications: [],
    sourceCoverage: [
      {
        sourceQuote: stepQuote,
        sourceSpan: { start: stepStart, end: stepStart + stepQuote.length },
        disposition: 'action',
        refId: 'case-1.step-1',
      },
      {
        sourceQuote: assertionQuote,
        sourceSpan: { start: assertionStart, end: assertionStart + assertionQuote.length },
        disposition: 'assertion',
        refId: 'case-1.assertion-1',
      },
    ],
    cases: [
      {
        version: 'CaseContractV1',
        id: 'case-1',
        name: 'Continue and observe the resulting heading',
        intent: 'Continue, then validate the authored visible state.',
        sourceQuote: source,
        sourceSpan: { start: 0, end: source.length },
        sourceClauseRefs: [],
        behavioralPartition: { ordinal: 1, reason: 'single_behavior_topology' },
        initialState: { description: null },
        expectedFinalState: { description: assertionQuote },
        sessionRequirement: { mode: 'fresh', predecessorCaseId: null },
        dependencies: [],
        failurePolicy: { default: 'stop_case' },
        dataBindings: [],
        dataRows: [],
        unusedDataRefs: [],
        steps: [
          {
            id: 'case-1.step-1',
            ordinal: 1,
            type: 'Click',
            text: stepQuote,
            sourceQuote: stepQuote,
            sourceSpan: { start: stepStart, end: stepStart + stepQuote.length },
            sourceClauseRefs: [],
            targetIdentity: {
              kind: 'control',
              label: 'Continue',
              role: 'button',
              controlType: 'button',
            },
            dataRefs: [],
            dependsOn: [],
            flowImpact: 'state_change',
            failureBehavior: 'stop_descendants',
            ...stepOverrides,
          },
        ],
        assertions: [
          {
            id: 'case-1.assertion-1',
            ordinal: 1,
            type: 'AssertVisible',
            text: assertionQuote,
            sourceQuote: assertionQuote,
            sourceSpan: { start: assertionStart, end: assertionStart + assertionQuote.length },
            sourceClauseRefs: [],
            targetIdentity: {
              kind: 'region',
              label: 'Summary heading',
              role: 'heading',
            },
            comparator: 'visible',
            payload: {
              channel: 'state',
              operands: [
                { role: 'actual', kind: 'target_property', property: 'visible' },
                { role: 'expected', kind: 'boolean', value: true },
              ],
            },
            dataRefs: [],
            stepId: 'case-1.step-1',
            required: true,
          },
        ],
      },
    ],
  };
}

function compactSemanticPlan(source, overrides = {}) {
  const stepQuote = 'Click the Continue button.';
  const assertionQuote = 'Verify the Summary heading is visible.';
  const plan = {
    version: 'SemanticIntentPlanV1',
    unresolvedQuestions: [],
    cases: [{
      name: 'Continue and observe the resulting heading',
      intent: 'Continue, then validate the authored visible state.',
      initialState: 'The starting page is available.',
      expectedFinalState: assertionQuote,
      continuationIntent: {
        mode: 'fresh',
        predecessorCaseId: null,
        sameSession: false,
        reason: 'This authored flow starts independently.',
      },
      actions: [{
        type: 'Click',
        sourceQuote: stepQuote,
        target: { kind: 'control', label: 'Continue', role: 'button' },
      }],
      assertions: [{
        type: 'AssertVisible',
        sourceQuote: assertionQuote,
        target: { kind: 'region', label: 'Summary heading', role: 'heading' },
        nonBlocking: false,
      }],
      ...overrides,
    }],
  };
  plan.sourceClaims = sourceClaimsForPlan(source, plan);
  return plan;
}

function providerResponse(value, usage = null, stopReason = 'end_turn') {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    stop_reason: stopReason,
    ...(usage ? { usage } : {}),
  };
}

describe('addScenarioSemanticPlanner', () => {
  it('sends the whole context through a provider-neutral JSON-only prompt and returns source-stamped metadata', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const compactPlan = compactSemanticPlan(source, {
      continuationIntent: {
        mode: 'continue',
        predecessorCaseId: 'existing-case',
        sameSession: true,
        reason: 'The supplied context explicitly continues existing-case.',
      },
    });
    const provider = {
      name: 'gemini',
      complete: vi.fn().mockResolvedValue(providerResponse(compactPlan, {
        input_tokens: 140,
        output_tokens: 90,
      })),
    };
    const onLog = vi.fn();

    const result = await planner.run({
      rawSource: source,
      provider: 'gemini',
      model: 'provider-model',
      apiKey: 'test-key',
      continuationContext: { requested: true, predecessorCaseId: 'existing-case' },
      currentCases: [{ id: 'existing-case', name: 'Existing case' }],
      approvedDataMetadata: { catalogId: 'catalog-1', fields: ['account'] },
      capabilities: [{ id: 'cap-1', role: 'button' }],
      guidance: 'Preserve one coherent flow.',
      onLog,
    }, { provider });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith('info', expect.stringContaining('complete authored source'));
    expect(onLog).toHaveBeenCalledWith('info', expect.stringContaining('validated after 1 attempt'));
    const call = provider.complete.mock.calls[0][0];
    expect(call.temperature).toBe(0.1);
    expect(call.maxTokens).toBe(6_000);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.system).toContain('Return ONLY one compact JSON object');
    expect(call.system).toContain('SemanticIntentPlanV1');
    expect(call.system).toContain('sourceQuote');
    expect(call.system).toContain('MODEL OWNS only authored meaning');
    expect(call.system).toContain('COMPILER OWNS all executable mechanics');
    expect(call.system).toContain('selection');
    expect(call.system).toContain('Cross-field temporal meaning uses comparison');
    expect(call.system).toContain('Split compound prose into atomic actions');
    expect(call.system).toContain('continuationIntent');
    expect(call.system).toContain('nonBlocking');
    expect(call.system).not.toContain('"comparator":');
    expect(call.system).not.toContain('"payload":');
    expect(call.system).not.toContain('"operands":');
    expect(call.messages[0].content).toContain(source);
    expect(call.messages[0].content).toContain('existing-case');
    expect(call.messages[0].content).toContain('catalog-1');
    expect(call.messages[0].content).toContain('cap-1');
    expect(call.messages[0].content).toContain('Preserve one coherent flow.');

    expect(result.envelope).toEqual(result.caseContractV1);
    expect(result).toMatchObject({
      status: 'ready',
      unresolved: false,
      preservePriorGeneration: false,
      semanticIntentPlanV1: compactPlan,
      unresolvedQuestions: [],
    });
    expect(result.envelope.source).toMatchObject({
      kind: 'add_scenario',
      originalLength: source.length,
    });
    expect(result.envelope.source.digest).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(result.envelope.cases[0].steps[0]).toMatchObject({
      ordinal: 1,
      type: 'Click',
      flowImpact: 'state_change',
    });
    expect(result.envelope.cases[0].sessionRequirement).toMatchObject({
      mode: 'continue_from_case',
      predecessorCaseId: 'existing-case',
    });
    expect(result.envelope.cases[0].assertions[0]).toMatchObject({
      ordinal: 1,
      type: 'AssertVisible',
      comparator: 'visible',
      payload: {
        channel: 'state',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'visible' },
          { role: 'expected', kind: 'boolean', value: true },
        ],
      },
    });
    expect(result.metadata).toMatchObject({
      provider: 'gemini',
      model: 'provider-model',
      attempts: 1,
      providerCallLimit: 1,
      repairCalls: 0,
      repaired: false,
      maxRepairCalls: 0,
      timeoutMode: 'provider_inactivity_and_wall_clock',
      overallTimeoutMs: 120_000,
      semanticPlanVersion: 'SemanticIntentPlanV1',
      projectionPlanVersion: 'AddScenarioSemanticPlanV1',
      usage: { input_tokens: 140, output_tokens: 90 },
    });
  });

  it('rejects compiler-owned provider mechanics before normalization and preserves the prior generation', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const intentPlan = compactSemanticPlan(source);
    intentPlan.repairCalls = 4;
    intentPlan.cases[0].session = { mode: 'provider_owned' };
    intentPlan.cases[0].actions[0].flowImpact = 'provider_owned';
    Object.assign(intentPlan.cases[0].actions[0].target, {
      sourceSpan: { start: 0, end: 1 },
      comparator: 'provider_owned',
      payload: { channel: 'provider_owned' },
      targetIdentity: { label: 'provider_owned' },
    });
    intentPlan.cases[0].assertions[0].condition = {
      kind: 'target_state',
      comparator: 'equals',
      operands: [{ kind: 'boolean', value: true }],
    };
    intentPlan.cases[0].assertions[0].relation = 'exact';
    intentPlan.cases[0].assertions[0].comparator = 'equals';
    intentPlan.cases[0].assertions[0].payload = { channel: 'provider_owned', operands: [] };
    Object.assign(intentPlan.cases[0].assertions[0].target, {
      sourceSpan: { start: 0, end: 1 },
      comparator: 'provider_owned',
      payload: { channel: 'provider_owned' },
      targetIdentity: { label: 'provider_owned' },
    });
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(intentPlan)),
    };

    const result = await planner.run({ rawSource: source }, { provider });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'unresolved',
      preservePriorGeneration: true,
      envelope: null,
      caseContractV1: null,
      metadata: {
        attempts: 1,
        providerCallLimit: 1,
        repairCalls: 0,
        diagnostics: {
          findingCodes: expect.arrayContaining([
            'semantic_intent_compiler_field_forbidden',
            'semantic_intent_field_unknown',
          ]),
        },
      },
    });
  });

  it('normalizes harmless representation aliases only after the raw ownership boundary passes', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const intentPlan = compactSemanticPlan(source);
    intentPlan.version = ' semantic intent plan v1 ';
    intentPlan.cases[0].name = '  Continue and observe the resulting heading  ';
    intentPlan.cases[0].continuationIntent.mode = ' FRESH ';
    intentPlan.cases[0].actions[0].type = ' click ';
    intentPlan.cases[0].actions[0].target = {
      kind: ' CONTROL ', label: ' Continue ', role: ' button ',
    };
    intentPlan.cases[0].assertions[0].type = ' assert visible ';
    intentPlan.cases[0].assertions[0].target = {
      kind: ' REGION ', label: ' Summary heading ', role: ' heading ',
    };
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(intentPlan)),
    };

    expect(planner._private.validateSemanticIntentOwnershipBoundary(intentPlan)).toEqual([]);
    const result = await planner.run({ rawSource: source }, { provider });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ready');
    expect(result.semanticIntentPlanV1).toMatchObject({
      version: 'SemanticIntentPlanV1',
      cases: [{
        name: 'Continue and observe the resulting heading',
        continuationIntent: { mode: 'fresh' },
        actions: [{
          type: 'Click',
          target: { kind: 'control', label: 'Continue', role: 'button' },
        }],
        assertions: [{
          type: 'AssertVisible',
          target: { kind: 'region', label: 'Summary heading', role: 'heading' },
        }],
      }],
    });
  });

  it('does not erase a nested forbidden field while normalizing otherwise harmless aliases', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const intentPlan = compactSemanticPlan(source);
    intentPlan.cases[0].actions[0].type = ' click ';
    intentPlan.cases[0].actions[0].target.kind = ' CONTROL ';
    intentPlan.cases[0].actions[0].target.ordinal = 2;
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(intentPlan)),
    };

    const ownershipFindings = planner._private.validateSemanticIntentOwnershipBoundary(intentPlan);
    expect(ownershipFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'semantic_intent_compiler_field_forbidden',
        path: '$.cases[0].actions[0].target.ordinal',
      }),
    ]));

    const result = await planner.run({ rawSource: source }, { provider });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('unresolved');
    expect(result.preservePriorGeneration).toBe(true);
    expect(result.metadata.diagnostics.findingCodes)
      .toContain('semantic_intent_compiler_field_forbidden');
  });

  it('preserves punctuation and whitespace inside exact non-temporal literals during normalization', async () => {
    const actionQuote = 'Enter ACME/West + COL (priority 007) in the Account field.';
    const assertionQuote = 'Verify the Account field equals ACME/West + COL (priority 007).';
    const source = `${actionQuote} ${assertionQuote}`;
    const intentPlan = {
      version: 'SemanticIntentPlanV1',
      unresolvedQuestions: [],
      cases: [{
        name: 'Preserve the exact authored account literal',
        intent: 'Enter and verify the exact authored account literal.',
        initialState: 'The Account field is available.',
        expectedFinalState: assertionQuote,
        continuationIntent: {
          mode: 'fresh', predecessorCaseId: null, sameSession: false, reason: 'The flow is independent.',
        },
        actions: [{
          type: 'Fill',
          sourceQuote: actionQuote,
          target: { kind: 'field', label: 'Account', role: 'textbox' },
          value: 'ACME/West + COL (priority 007)',
        }],
        assertions: [{
          type: 'AssertValue',
          sourceQuote: assertionQuote,
          target: { kind: 'field', label: 'Account', role: 'textbox' },
          expected: 'ACME/West + COL (priority 007)',
          relation: 'exact',
          nonBlocking: false,
        }],
      }],
    };
    intentPlan.sourceClaims = sourceClaimsForPlan(source, intentPlan);
    const normalized = planner._private.normalizeSemanticIntentPlanBoundary(intentPlan);

    expect(normalized.cases[0].actions[0].sourceQuote).toBe(actionQuote);
    expect(normalized.cases[0].actions[0].value).toBe('ACME/West + COL (priority 007)');
    expect(normalized.cases[0].assertions[0].sourceQuote).toBe(assertionQuote);
    expect(normalized.cases[0].assertions[0].expected).toBe('ACME/West + COL (priority 007)');
    expect(planner._private.validateSemanticIntentPlanBoundary(normalized, { sourceText: source })).toEqual([]);
  });

  it('canonicalizes semantic relation aliases without converting them into compiler comparators', () => {
    const actionQuote = 'Click the Workflow Stage control.';
    const assertionQuote = 'Verify the Workflow Stage options are Draft, Review, Approved in that exact order.';
    const source = `${actionQuote} ${assertionQuote}`;
    const intentPlan = compactSemanticPlan(source, {
      actions: [{
        type: 'Click',
        sourceQuote: actionQuote,
        target: { kind: 'control', label: 'Workflow Stage', role: 'button' },
      }],
      assertions: [{
        type: 'AssertCollection',
        sourceQuote: assertionQuote,
        target: { kind: 'collection', label: 'Workflow Stage options', role: 'listbox' },
        expected: ['Draft', 'Review', 'Approved'],
        relation: ' EXACT ORDER ',
        nonBlocking: false,
      }],
    });

    const normalized = planner._private.normalizeSemanticIntentPlanBoundary(intentPlan);

    expect(normalized.cases[0].assertions[0].relation).toBe('exact_order');
    expect(normalized.cases[0].assertions[0].relation).not.toBe('collection_exact_order');
    expect(planner._private.validateSemanticIntentPlanBoundary(normalized, { sourceText: source })).toEqual([]);
  });

  it('rejects an ambiguous authored date instead of choosing one canonical value', async () => {
    const actionQuote = 'Select August 20, 2026 or August 21, 2026 in the Pickup Date field.';
    const assertionQuote = 'Verify the Pickup Date field is visible.';
    const source = `${actionQuote} ${assertionQuote}`;
    const intentPlan = compactSemanticPlan(source, {
      actions: [{
        type: 'Date',
        sourceQuote: actionQuote,
        target: { kind: 'field', label: 'Pickup Date', role: 'textbox' },
        value: '2026-08-20',
      }],
      assertions: [{
        type: 'AssertVisible',
        sourceQuote: assertionQuote,
        target: { kind: 'field', label: 'Pickup Date', role: 'textbox' },
        nonBlocking: false,
      }],
    });
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(intentPlan)),
    };

    const result = await planner.run({ rawSource: source }, { provider });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('unresolved');
    expect(result.preservePriorGeneration).toBe(true);
    expect(result.metadata.diagnostics.findingCodes)
      .toContain('semantic_intent_temporal_value_ambiguous');
  });

  it('fails closed instead of converting a negative state assertion into a positive assertion', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const intentPlan = compactSemanticPlan(source);
    intentPlan.cases[0].assertions[0].relation = 'not_equal';
    intentPlan.cases[0].assertions[0].expected = false;
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(intentPlan)),
    };

    const result = await planner.run({ rawSource: source }, { provider });
    expect(result).toMatchObject({
      status: 'unresolved',
      preservePriorGeneration: true,
      metadata: { diagnostics: { findingCodes: expect.arrayContaining([
        'semantic_intent_relation_incompatible',
        'semantic_intent_state_expected_conflict',
      ]) } },
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('returns exact validation findings after one call without launching a semantic rewrite', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const firstDraft = compactSemanticPlan(source);
    const exactFindings = [{
      path: '$.cases[0].steps[0].targetIdentity',
      code: 'missing_target_identity',
      message: 'The target identity is missing.',
    }];
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(firstDraft, { input_tokens: 10, output_tokens: 5 })),
    };
    const validator = vi.fn().mockReturnValue({ ok: false, findings: exactFindings });

    const result = await planner.run({ rawSource: source, apiKey: 'test-key' }, {
      provider,
      validator,
    });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'unresolved',
      preservePriorGeneration: true,
      metadata: { diagnostics: { findingCodes: ['missing_target_identity'] } },
    });
  });

  it('fails unparseable output after one bounded call without a rewrite', async () => {
    const source = 'Click the Continue button.';
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse('not-json-at-all')),
    };

    const result = await planner.run({ rawSource: source }, { provider });
    expect(result).toMatchObject({
      status: 'unresolved',
      preservePriorGeneration: true,
      envelope: null,
      unresolvedQuestions: [expect.objectContaining({ code: 'semantic_output_not_single_json', blocking: true })],
      metadata: { diagnostics: {
        outputHash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
        outputCharacters: 'not-json-at-all'.length,
        parseable: false,
        parseError: 'missing',
        stopReason: 'end_turn',
        elapsedMs: expect.any(Number),
      } },
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('returns structured unresolved questions when required semantic cases are missing', async () => {
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse({ version: 'CaseContractV1' })),
    };

    const result = await planner.run({ rawSource: 'Perform the authored flow.' }, { provider });
    expect(result).toMatchObject({
      status: 'unresolved',
      preservePriorGeneration: true,
      metadata: { diagnostics: { findingCodes: expect.arrayContaining([
        'semantic_intent_cases_required',
      ]) } },
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('returns unresolved before parser recovery when the provider reports output-token truncation', async () => {
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse('{"version":"SemanticIntentPlanV1"', null, 'max_tokens')),
    };

    const result = await planner.run({ rawSource: 'Click the authored control.' }, { provider });
    expect(result).toMatchObject({
      status: 'unresolved',
      preservePriorGeneration: true,
      unresolvedQuestions: [expect.objectContaining({ code: 'semantic_output_incomplete' })],
      metadata: { diagnostics: {
        parseable: false,
        parseError: 'provider_output_limit',
        stopReason: 'max_tokens',
      } },
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('extracts exactly one complete semantic JSON object from harmless messy prose without a repair call', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const compactPlan = compactSemanticPlan(source);
    const output = `I reviewed the whole story.\n\`\`\`json\n${JSON.stringify(compactPlan)}\n\`\`\`\nThat is the complete plan.`;
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(output)),
    };

    const result = await planner.run({ rawSource: source }, { provider });

    expect(result).toMatchObject({
      status: 'ready',
      semanticIntentPlanV1: compactPlan,
      metadata: { attempts: 1, providerCallLimit: 1, repairCalls: 0 },
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('preserves an exact inline literal as value rather than inventing a data reference', async () => {
    const actionQuote = 'Enter Exact-01 in the Account field.';
    const assertionQuote = 'Verify the Account field equals Exact-01.';
    const source = `${actionQuote} ${assertionQuote}`;
    const compactPlan = {
      version: 'SemanticIntentPlanV1',
      unresolvedQuestions: [],
      cases: [{
        name: 'Enter the exact authored account',
        intent: 'Enter and validate the exact inline account literal.',
        initialState: 'The Account field is available.',
        expectedFinalState: 'The Account field contains Exact-01.',
        continuationIntent: {
          mode: 'fresh', predecessorCaseId: null, sameSession: false, reason: 'This is an independent authored flow.',
        },
        actions: [{
          type: 'Fill',
          sourceQuote: actionQuote,
          target: { kind: 'field', label: 'Account', role: 'textbox' },
          value: 'Exact-01',
        }],
        assertions: [{
          type: 'AssertValue',
          sourceQuote: assertionQuote,
          target: { kind: 'field', label: 'Account', role: 'textbox' },
          expected: 'Exact-01',
          relation: 'exact',
          nonBlocking: false,
        }],
      }],
    };
    compactPlan.sourceClaims = sourceClaimsForPlan(source, compactPlan);
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(compactPlan)),
    };

    const result = await planner.run({ rawSource: source }, { provider });

    expect(result.status).toBe('ready');
    expect(result.envelope.cases[0].steps[0]).toMatchObject({ value: 'Exact-01' });
    expect(result.envelope.cases[0].steps[0]).not.toHaveProperty('valueRef');
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('uses bounded safe existing context for authored continuation and omits duplicate legacy currentCases', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const predecessorCaseId = 'case-prior-profile';
    const sensitiveSentinel = 'Sensitive-Context-Sentinel-01!';
    const safeRef = 'credential:odyssey.standard-user.password';
    const compactPlan = compactSemanticPlan(source, {
      initialState: 'The authenticated Profile page from case-prior-profile is available.',
      continuationIntent: {
        mode: 'continue',
        predecessorCaseId,
        sameSession: true,
        reason: 'The existing context identifies the authenticated Profile page predecessor.',
      },
    });
    const existingScenarioContext = {
      version: 'ExistingScenarioContextV1',
      cases: [{
        id: predecessorCaseId,
        name: 'Open Profile',
        expectedFinalState: { page: 'Profile', authenticated: true },
        operations: [{ target: { kind: 'field', label: 'Password' }, value: sensitiveSentinel, valueRef: safeRef }],
        password: sensitiveSentinel,
      }],
      continuation: {
        requested: true,
        resolution: 'pending_state_validation',
        predecessorCaseId,
        sameSession: true,
      },
    };
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(compactPlan)),
    };

    const result = await planner.run({
      rawSource: source,
      existingScenarioContext,
      currentCases: existingScenarioContext.cases,
      continuationContext: { requested: true, predecessorCaseId },
    }, { provider });

    expect(result.status).toBe('ready');
    expect(result.envelope.cases[0].sessionRequirement).toMatchObject({
      mode: 'continue_from_case',
      predecessorCaseId,
    });
    const prompt = provider.complete.mock.calls[0][0].messages[0].content;
    expect(prompt.split(source)).toHaveLength(2);
    expect(prompt).not.toContain(sensitiveSentinel);
    expect(prompt).toContain(safeRef);
    const inputJson = prompt.split('INPUT_JSON:\n')[1].split('\nReturn JSON only.')[0];
    const parsedInput = JSON.parse(inputJson);
    expect(parsedInput.WHOLE_CONTEXT).not.toHaveProperty('currentCases');
    expect(parsedInput.WHOLE_CONTEXT.existingScenarioContext.version).toBe('ExistingScenarioContextV1');
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('rejects multiple complete JSON objects instead of selecting one or repairing', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const serialized = JSON.stringify(compactSemanticPlan(source));
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(`${serialized}\n${serialized}`)),
    };

    const result = await planner.run({ rawSource: source }, { provider });

    expect(result).toMatchObject({
      status: 'unresolved',
      preservePriorGeneration: true,
      metadata: { diagnostics: { parseError: 'multiple', objectCount: 2 } },
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('raises the bounded output budget for a source with up to 100 compact operations', async () => {
    const source = Array.from({ length: 100 }, (_, index) => `Click Control ${index + 1}.`).join(' ');
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse('not-json')),
    };

    const result = await planner.run({ rawSource: source }, { provider });

    expect(result.status).toBe('unresolved');
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(provider.complete.mock.calls[0][0].maxTokens).toBe(14_000);
    expect(result.metadata).toMatchObject({
      estimatedOperationCount: 100,
      maxSemanticOperations: 100,
      maxTokens: 14_000,
    });
  });

  it('accepts model-owned unresolved questions by array position and forwards them without compiler identities', () => {
    const ambiguityQuote = 'The relevant Owner is ambiguous.';
    const source = `Click the Continue button. Verify the Summary heading is visible. ${ambiguityQuote}`;
    const compactPlan = compactSemanticPlan(source);
    compactPlan.unresolvedQuestions = [{
      sourceQuote: ambiguityQuote,
      question: 'Which owner should be selected?',
      reason: 'The source does not identify one exact Owner option.',
      affectedRecord: { caseIndex: 0, kind: 'case' },
    }];
    compactPlan.sourceClaims = sourceClaimsForPlan(source, compactPlan);

    expect(planner._private.validateSemanticIntentPlanBoundary(compactPlan, { sourceText: source }))
      .toEqual([]);
    const compiled = planner._private.compileSemanticIntentPlan(compactPlan, {});
    expect(compiled.unresolvedQuestions).toEqual(compactPlan.unresolvedQuestions);
    expect(compiled.unresolvedQuestions[0]).not.toHaveProperty('id');
    expect(compiled.unresolvedQuestions[0]).not.toHaveProperty('ordinal');
  });

  it('preserves the prior generation when one unique middle action has no SourceLedger claim', async () => {
    const first = 'Click Alpha.';
    const omitted = 'Click the unique middle control.';
    const assertion = 'Verify Done is visible.';
    const source = `${first} ${omitted} ${assertion}`;
    const compactPlan = compactSemanticPlan(source, {
      actions: [{
        type: 'Click',
        sourceQuote: first,
        target: { kind: 'control', label: 'Alpha', role: 'button' },
      }],
      assertions: [{
        type: 'AssertVisible',
        sourceQuote: assertion,
        target: { kind: 'region', label: 'Done', role: 'status' },
        nonBlocking: false,
      }],
    });
    compactPlan.sourceClaims = compactPlan.sourceClaims
      .filter((claim) => claim.sourceQuote !== omitted);
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(compactPlan)),
    };

    const result = await planner.run({ rawSource: source }, { provider });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'unresolved',
      preservePriorGeneration: true,
      priorGenerationPreserved: true,
      caseContractV1: null,
      sourceCompleteness: { valid: false, complete: false },
    });
    expect(result.sourceCompleteness.findings.map((entry) => entry.code))
      .toContain('source_ledger_source_unit_omitted');
  });

  it('accepts complete atomic claims that partition one compound source unit without residual text', async () => {
    const source = 'Click Save and verify Success is visible.';
    const actionQuote = 'Click Save';
    const assertionQuote = 'verify Success is visible.';
    const ledger = buildSourceLedger(source);
    expect(ledger.units).toHaveLength(1);
    const compactPlan = {
      version: 'SemanticIntentPlanV1',
      unresolvedQuestions: [],
      cases: [{
        name: 'Save and verify success',
        intent: 'Save, then verify the success state.',
        initialState: 'The Save control is available.',
        expectedFinalState: 'Success is visible.',
        continuationIntent: {
          mode: 'fresh', predecessorCaseId: null, sameSession: false, reason: 'The flow is independent.',
        },
        actions: [{
          type: 'Click',
          sourceQuote: actionQuote,
          target: { kind: 'control', label: 'Save', role: 'button' },
        }],
        assertions: [{
          type: 'AssertVisible',
          sourceQuote: assertionQuote,
          target: { kind: 'region', label: 'Success', role: 'status' },
          nonBlocking: false,
        }],
      }],
      sourceClaims: [{
        unitRef: ledger.units[0].id,
        disposition: 'action',
        sourceQuote: actionQuote,
        caseIndex: 0,
        recordKind: 'action',
        recordIndex: 0,
      }, {
        unitRef: ledger.units[0].id,
        disposition: 'assertion',
        sourceQuote: ' and verify Success is visible.',
        caseIndex: 0,
        recordKind: 'assertion',
        recordIndex: 0,
      }],
    };
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(compactPlan)),
    };

    const result = await planner.run({ rawSource: source }, { provider });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ready');
    expect(result.sourceCompleteness).toMatchObject({ valid: true, complete: true, findings: [] });
    expect(result.sourceClaims).toHaveLength(2);
    expect(result.sourceClaims.map((claim) => claim.sourceSpan)).toEqual([
      { start: 0, end: actionQuote.length },
      { start: actionQuote.length, end: source.length },
    ]);
    expect(result.envelope).not.toHaveProperty('sourceLedgerV1');
    expect(result.envelope).not.toHaveProperty('sourceCompleteness');
  });

  it('honors cancellation before making a provider call', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = { name: 'claude', complete: vi.fn() };

    await expect(planner.run({
      rawSource: 'Click the authored control.',
      signal: controller.signal,
    }, { provider })).rejects.toMatchObject({
      code: 'CANCELLED',
      status: 499,
      attempts: 0,
    });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('propagates cancellation into an in-flight provider call', async () => {
    const controller = new AbortController();
    let providerSignal;
    const provider = {
      name: 'claude',
      complete: vi.fn((options) => {
        providerSignal = options.signal;
        return new Promise(() => {});
      }),
    };
    const pending = planner.run({
      rawSource: 'Click the authored control.',
      signal: controller.signal,
      stallTimeoutMs: 1_000,
    }, { provider });
    setTimeout(() => controller.abort(), 0);

    await expect(pending).rejects.toMatchObject({
      code: 'CANCELLED',
      status: 499,
      attempts: 1,
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(providerSignal.aborted).toBe(true);
  });

  it('aborts a hung provider after bounded provider inactivity', async () => {
    let providerSignal;
    const provider = {
      name: 'claude',
      complete: vi.fn((options) => {
        providerSignal = options.signal;
        return new Promise(() => {});
      }),
    };

    await expect(planner.run({
      rawSource: 'Click the authored control.',
      stallTimeoutMs: 20,
      heartbeatIntervalMs: 5,
    }, { provider })).rejects.toMatchObject({
      code: 'ADD_SCENARIO_SEMANTIC_PROVIDER_STALLED',
      status: 504,
      attempts: 1,
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(providerSignal.aborted).toBe(true);
  });

  it('aborts an active stream at the independent wall-clock deadline', async () => {
    let providerSignal;
    const provider = {
      name: 'claude',
      completeStream: vi.fn((options) => new Promise((resolve, reject) => {
        providerSignal = options.signal;
        const timer = setInterval(() => options.onText('{', '{'), 5);
        options.signal.addEventListener('abort', () => {
          clearInterval(timer);
          reject(new Error('aborted by deadline'));
        }, { once: true });
      })),
    };

    await expect(planner.run({
      rawSource: 'Click the authored control.',
      stallTimeoutMs: 1_000,
      overallTimeoutMs: 25,
      heartbeatIntervalMs: 5,
    }, { provider })).rejects.toMatchObject({
      code: 'ADD_SCENARIO_SEMANTIC_PROVIDER_DEADLINE',
      status: 504,
      attempts: 1,
    });
    expect(provider.completeStream).toHaveBeenCalledTimes(1);
    expect(providerSignal.aborted).toBe(true);
  });

  it('uses one upstream attempt and keeps async validation inside the total planner deadline', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue(providerResponse(compactSemanticPlan(source))),
    };
    const validator = vi.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, envelope: {} }), 60);
    }));

    await expect(planner.run({
      rawSource: source,
      stallTimeoutMs: 1_000,
      overallTimeoutMs: 25,
    }, { provider, validator })).rejects.toMatchObject({
      code: 'ADD_SCENARIO_SEMANTIC_PROVIDER_DEADLINE',
      status: 504,
      attempts: 1,
    });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(provider.complete.mock.calls[0][0]).toMatchObject({ maxRetries: 0 });
    expect(provider.complete.mock.calls[0][0].timeoutMs).toBeGreaterThan(0);
    expect(provider.complete.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(25);
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it('lets an active stream exceed one stall window and emits sanitized heartbeats', async () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const response = providerResponse(compactSemanticPlan(source));
    const onLog = vi.fn();
    const provider = {
      name: 'claude',
      completeStream: vi.fn((options) => new Promise((resolve) => {
        let ticks = 0;
        const timer = setInterval(() => {
          ticks += 1;
          options.onText('{', '{'.repeat(ticks));
          if (ticks === 5) {
            clearInterval(timer);
            resolve(response);
          }
        }, 10);
      })),
    };

    const result = await planner.run({
      rawSource: source,
      stallTimeoutMs: 20,
      heartbeatIntervalMs: 5,
      onLog,
    }, { provider });

    expect(result.caseContractV1.cases).toHaveLength(1);
    expect(provider.completeStream).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith('info', expect.stringContaining('still generating'));
    expect(onLog.mock.calls.flat().join(' ')).not.toContain(source);
    expect(result.metadata).toMatchObject({
      timeoutMode: 'provider_inactivity_and_wall_clock',
      overallTimeoutMs: 120_000,
      stallTimeoutMs: 20,
      heartbeatIntervalMs: 5,
    });
  });

  it('rejects source-span drift and an untyped Select criterion without guessing', () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const envelope = semanticEnvelope(source);
    envelope.cases[0].steps[0].type = 'Select';
    envelope.cases[0].steps[0].sourceQuote = 'different text';

    const result = planner.validateCaseContractV1(envelope, { sourceText: source });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'source_span_quote_mismatch' }),
      expect.objectContaining({ code: 'selection_criteria_required' }),
    ]));
  });

  it('keeps literal values scalar and requires bound valueRef lineage through dataRefs', () => {
    const assertionQuote = 'Verify the Summary heading is visible.';
    const literalStep = 'Enter Exact-01 into the Account field.';
    const literalSource = `${literalStep} ${assertionQuote}`;
    const literal = semanticEnvelope(literalSource, {
      sourceQuote: literalStep,
      type: 'Fill',
      text: literalStep,
      targetIdentity: { kind: 'field', label: 'Account', role: 'textbox' },
      value: 'Exact-01',
    });
    const boundStep = 'Enter the approved account into the Account field.';
    const boundSource = `${boundStep} ${assertionQuote}`;
    const bound = semanticEnvelope(boundSource, {
      sourceQuote: boundStep,
      type: 'Fill',
      text: boundStep,
      targetIdentity: { kind: 'field', label: 'Account', role: 'textbox' },
      valueRef: 'data.account',
      dataRefs: ['data.account'],
    });

    expect(planner.validateCaseContractV1(literal, { sourceText: literalSource }).ok).toBe(true);
    expect(planner.validateCaseContractV1(bound, { sourceText: boundSource }).ok).toBe(true);

    literal.cases[0].steps[0].value = 'a prose descriptor absent from source';
    bound.cases[0].steps[0].dataRefs = [];
    expect(planner.validateCaseContractV1(literal, { sourceText: literalSource }).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'literal_not_linked_to_step_source' })]));
    expect(planner.validateCaseContractV1(bound, { sourceText: boundSource }).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'value_ref_not_linked_to_data_refs' })]));
  });

  it('enforces typed collection and temporal assertion operands', () => {
    const source = 'Click the Continue button. Verify the Summary heading is visible.';
    const collection = semanticEnvelope(source);
    collection.cases[0].assertions[0].comparator = 'collection_exact_order';
    collection.cases[0].assertions[0].payload = {
      channel: 'collection',
      operands: [
        { role: 'actual', kind: 'reference', ref: 'visible-options' },
        { role: 'expected', kind: 'text', value: 'not-a-collection' },
      ],
    };
    const temporal = semanticEnvelope(source);
    temporal.cases[0].assertions[0].comparator = 'before';
    temporal.cases[0].assertions[0].payload = {
      channel: 'temporal',
      operands: [
        { role: 'actual', kind: 'text', value: 'first' },
        { role: 'expected', kind: 'text', value: 'second' },
      ],
    };

    expect(planner.validateCaseContractV1(collection, { sourceText: source }).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'collection_expected_invalid' })]));
    expect(planner.validateCaseContractV1(temporal, { sourceText: source }).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'temporal_operands_invalid' })]));
  });

  it('accepts a source-linked blocking clarification when genuine ambiguity prevents a safe case', () => {
    const source = 'Choose the relevant account.';
    const envelope = {
      version: 'CaseContractV1',
      partitioning: {
        mode: 'single_behavior_topology',
        explicitOneFlow: false,
        caseCount: 0,
        dataRowsDoNotCreateCases: true,
      },
      dataDictionary: [],
      dataRows: [],
      sourceClauses: [],
      unusedDataRefs: [],
      cases: [],
      clarifications: [{
        id: 'clarification-1',
        question: 'Which authored account should be selected?',
        reason: 'The source does not identify the account.',
        blocking: true,
        options: [],
        sourceQuote: source,
        sourceSpan: { start: 0, end: source.length },
      }],
      sourceCoverage: [{
        sourceQuote: source,
        sourceSpan: { start: 0, end: source.length },
        disposition: 'clarification',
        refId: 'clarification-1',
      }],
    };

    expect(planner.validateCaseContractV1(envelope, { sourceText: source })).toMatchObject({
      ok: true,
      findings: [],
    });
  });
});
