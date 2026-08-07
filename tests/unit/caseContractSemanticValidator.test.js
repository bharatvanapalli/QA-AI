import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const semantic = require('../../server/services/caseContractSemanticValidator');

const TARGET = (label, role, scope, kind = 'control') => ({ kind, label, role, scope });

function fixture() {
  const quotes = [
    'Continue from the authenticated login case.',
    'Click Create Order.',
    'Enter SIGROUP, in capital letters, into the Owning Organization field.',
    'Verify the Owning Organization suggestions appear in this order: *SIGROUP SOURCE SYSTEM 01; *SIGROUP-EUR SOURCE SYSTEM 01.',
    'Choose the second suggestion, *SIGROUP-EUR SOURCE SYSTEM 01.',
    'Verify the selected Owning Organization is exactly *SIGROUP-EUR SOURCE SYSTEM 01.',
    'Scroll the References section into view.',
    'If Pickup and Delivery is collapsed, expand it.',
    'Set Early Pickup Date to 2026-08-20 and Early Pickup Time to 09:00.',
    'Set Late Pickup Time to 11:00.',
    'Verify Early Pickup Date/Time is before Late Pickup Date/Time.',
    'If Freight Term does not change to COL, record the failure and continue with the next independent step.',
  ];
  const sourceText = quotes.join(' ');
  const clause = (ordinal, disposition) => ({
    id: `source.clause.${String(ordinal).padStart(3, '0')}`,
    ordinal,
    disposition,
    sourceQuote: quotes[ordinal - 1],
  });
  const sourceRef = (ordinal) => [`source.clause.${String(ordinal).padStart(3, '0')}`];
  const step = (id, ordinal, type, text, quoteOrdinal, targetIdentity, dependsOn = [], extras = {}) => ({
    id,
    ordinal,
    type,
    text,
    sourceQuote: quotes[quoteOrdinal - 1],
    sourceClauseRefs: sourceRef(quoteOrdinal),
    targetIdentity,
    dataRefs: [],
    dependsOn,
    flowImpact: type === 'Scroll' ? 'context_change' : 'state_change',
    failureBehavior: 'stop_descendants',
    ...extras,
  });
  const assertion = (id, ordinal, type, text, quoteOrdinal, targetIdentity, comparator, payload, stepId = null, failureBehavior = 'stop_case') => ({
    id,
    ordinal,
    type,
    text,
    sourceQuote: quotes[quoteOrdinal - 1],
    sourceClauseRefs: sourceRef(quoteOrdinal),
    targetIdentity,
    comparator,
    payload,
    dataRefs: [],
    stepId,
    required: true,
    failureBehavior,
  });

  const steps = [
    step('case.step.001', 1, 'Click', 'Click Create Order.', 2, TARGET('Create Order', 'button', 'Orders page')),
    step('case.step.002', 2, 'Fill', 'Enter SIGROUP in Owning Organization.', 3, TARGET('Owning Organization', 'textbox', 'General Information section'), ['case.step.001'], { value: 'SIGROUP' }),
    step('case.step.003', 3, 'Select', 'Select the second Owning Organization suggestion.', 5, TARGET('Owning Organization suggestions', 'listbox', 'General Information section', 'collection'), ['case.step.002'], {
      selectionCriteria: { kind: 'ordinal', ordinal: 2, expectedText: '*SIGROUP-EUR SOURCE SYSTEM 01' },
    }),
    step('case.step.004', 4, 'Scroll', 'Scroll the References section into view.', 7, TARGET('References section', 'region', 'Create New Order form', 'region'), ['case.step.003']),
    step('case.step.005', 5, 'Expand', 'Expand Pickup and Delivery when collapsed.', 8, TARGET('Pickup and Delivery section', 'region', 'Create New Order form', 'region'), ['case.step.004'], {
      condition: { kind: 'target_state', comparator: 'equals', operands: [{ property: 'expanded' }, { value: false }] },
    }),
    step('case.step.006', 6, 'Date', 'Set Early Pickup Date.', 9, TARGET('Early Pickup Date', 'textbox', 'Planning Date/Time section', 'field'), ['case.step.005'], { value: '2026-08-20' }),
    step('case.step.007', 7, 'Time', 'Set Early Pickup Time.', 9, TARGET('Early Pickup Time', 'combobox', 'Planning Date/Time section', 'field'), ['case.step.006'], { value: '09:00' }),
    step('case.step.008', 8, 'Time', 'Set Late Pickup Time.', 10, TARGET('Late Pickup Time', 'combobox', 'Planning Date/Time section', 'field'), ['case.step.007'], { value: '11:00' }),
  ];

  const assertions = [
    assertion(
      'case.assertion.001',
      1,
      'AssertCollection',
      'Check the exact Owning Organization suggestion order.',
      4,
      TARGET('Owning Organization suggestions', 'listbox', 'General Information section', 'collection'),
      'collection_exact_order',
      {
        channel: 'collection',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'items' },
          { role: 'expected', kind: 'collection', items: ['*SIGROUP SOURCE SYSTEM 01', '*SIGROUP-EUR SOURCE SYSTEM 01'] },
        ],
      },
      'case.step.002',
    ),
    assertion(
      'case.assertion.002',
      2,
      'AssertSelected',
      'Check the selected Owning Organization.',
      6,
      TARGET('Owning Organization', 'combobox', 'General Information section', 'field'),
      'selected',
      {
        channel: 'state',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'selected' },
          { role: 'expected', kind: 'literal', value: '*SIGROUP-EUR SOURCE SYSTEM 01' },
        ],
      },
      'case.step.003',
    ),
    assertion(
      'case.assertion.003',
      3,
      'AssertTemporal',
      'Compare named pickup boundaries.',
      11,
      TARGET('Pickup planning boundaries', 'group', 'Planning Date/Time section', 'collection'),
      'before',
      {
        channel: 'temporal',
        operands: [
          { role: 'actual', kind: 'temporal_reference', name: 'Early Pickup Date/Time', ref: 'runtime:early-pickup-date-time' },
          { role: 'expected', kind: 'temporal_reference', name: 'Late Pickup Date/Time', ref: 'runtime:late-pickup-date-time' },
        ],
      },
      'case.step.008',
    ),
    assertion(
      'case.assertion.004',
      4,
      'AssertValue',
      'Check Freight Term after the dependent update.',
      12,
      TARGET('Freight Term', 'combobox', 'General Information section', 'field'),
      'equals',
      {
        channel: 'state',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'value' },
          { role: 'expected', kind: 'literal', value: 'COL' },
        ],
      },
      null,
      'continue_independent',
    ),
  ];

  const contract = {
    version: 'CaseContractV1',
    id: 'case.semantic.order',
    name: 'Create an order from a continued authenticated session',
    intent: 'Populate and validate the authored order fields without saving.',
    sourceQuote: sourceText,
    sourceClauses: [
      clause(1, 'metadata'), clause(2, 'action'), clause(3, 'action'),
      clause(4, 'assertion'), clause(5, 'action'), clause(6, 'assertion'),
      clause(7, 'action'), clause(8, 'action'), clause(9, 'action'),
      clause(10, 'action'), clause(11, 'assertion'), clause(12, 'mixed'),
    ],
    sessionRequirement: {
      mode: 'continue_from_case',
      predecessorCaseId: 'case.authenticated.login',
      dependsOnCaseRefs: ['case.authenticated.login'],
      sourceClauseRefs: sourceRef(1),
    },
    failurePolicy: {
      default: 'stop_descendants',
      onAssertionFailure: 'continue_independent',
      sourceClauseRefs: sourceRef(12),
    },
    steps,
    assertions,
    metadata: [],
    dataBindings: [],
    clarifications: [],
  };
  return { contract, sourceText, quotes };
}

function operationBudgetFixture(actionCount, assertionCount) {
  const actionQuote = 'Click Create Order.';
  const assertionQuote = 'Verify Create Order is visible.';
  const sourceText = `${actionQuote} ${assertionQuote}`;
  const steps = Array.from({ length: actionCount }, (_, index) => ({
    id: `budget.step.${String(index + 1).padStart(3, '0')}`,
    ordinal: index + 1,
    type: 'Click',
    text: actionQuote,
    sourceQuote: actionQuote,
    sourceClauseRefs: ['budget.clause.action'],
    targetIdentity: TARGET(`Create Order ${index + 1}`, 'button', 'Orders page'),
    dataRefs: [],
    dependsOn: [],
    flowImpact: 'state_change',
    failureBehavior: 'stop_descendants',
  }));
  const assertions = Array.from({ length: assertionCount }, (_, index) => ({
    id: `budget.assertion.${String(index + 1).padStart(3, '0')}`,
    ordinal: index + 1,
    type: 'AssertVisible',
    text: assertionQuote,
    sourceQuote: assertionQuote,
    sourceClauseRefs: ['budget.clause.assertion'],
    targetIdentity: TARGET(`Create Order ${index + 1}`, 'button', 'Orders page'),
    comparator: 'visible',
    payload: {
      channel: 'state',
      operands: [
        { role: 'actual', kind: 'target_property', property: 'visible' },
        { role: 'expected', kind: 'boolean', value: true },
      ],
    },
    dataRefs: [],
    stepId: null,
    required: true,
    failureBehavior: 'stop_case',
  }));
  return {
    sourceText,
    contract: {
      version: 'CaseContractV1',
      id: 'case.semantic.operation-budget',
      name: 'Semantic operation budget boundary',
      intent: 'Exercise the exact combined semantic operation budget.',
      sourceQuote: sourceText,
      sourceClauses: [
        { id: 'budget.clause.action', ordinal: 1, disposition: 'action', sourceQuote: actionQuote },
        { id: 'budget.clause.assertion', ordinal: 2, disposition: 'assertion', sourceQuote: assertionQuote },
      ],
      sessionRequirement: { mode: 'fresh', dependsOnCaseRefs: [], sourceClauseRefs: ['budget.clause.action'] },
      failurePolicy: { default: 'stop_descendants', onAssertionFailure: 'stop_case', sourceClauseRefs: ['budget.clause.action'] },
      steps,
      assertions,
      metadata: [],
      dataBindings: [],
      clarifications: [],
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

function findingCodes(result) {
  return new Set(result.findings.map((finding) => finding.code));
}

describe('caseContractSemanticValidator', () => {
  it('links canonical temporal values only to one unambiguous authored display value', () => {
    expect(semantic.isSourceLinkedStepValue('Date', '2026-08-20', 'Select August 20, 2026 (08/20/2026).')).toBe(true);
    expect(semantic.isSourceLinkedStepValue('Date', '2026-08-20', 'Select August 21, 2026.')).toBe(false);
    expect(semantic.isSourceLinkedStepValue('Date', '2027-02-03', 'Select 02/03/2027.')).toBe(false);
    expect(semantic.isSourceLinkedStepValue('Time', '00:00', 'Select 12:00 AM.')).toBe(true);
    expect(semantic.isSourceLinkedStepValue('Time', '12:00', 'Select 12:00 PM.')).toBe(true);
    expect(semantic.isSourceLinkedStepValue('Time', '12:00', 'Select 12:00 AM.')).toBe(false);
    expect(semantic.isSourceLinkedStepValue('DateTime', '2026-08-20T09:00', 'August 20, 2026 at 9:00 AM.')).toBe(false);
    expect(semantic.isSourceLinkedStepValue('DateTime', '2026-08-20T09:00Z', 'August 20, 2026 at 9:00 AM UTC.')).toBe(true);
    expect(semantic.isSourceLinkedStepValue('DateTime', '2026-08-20T09:00:00Z', 'Use 2026-08-20T09:00:00Z.')).toBe(true);
  });

  it('rejects an invented canonical expected date in a temporal assertion', () => {
    const { contract, sourceText, quotes } = fixture();
    contract.assertions[0] = {
      ...contract.assertions[0],
      type: 'AssertDate',
      text: 'Verify Early Pickup Date.',
      sourceQuote: quotes[8],
      sourceClauseRefs: ['source.clause.009'],
      targetIdentity: TARGET('Early Pickup Date', 'textbox', 'Planning Date/Time section', 'field'),
      comparator: 'equals',
      payload: {
        channel: 'temporal',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'value' },
          { role: 'expected', kind: 'temporal', temporalType: 'date', value: '2026-08-21' },
        ],
      },
    };
    const codes = findingCodes(semantic.validateSemanticCaseContract(contract, { sourceText }));
    expect(codes.has(semantic.FINDING_CODES.VALUE_NOT_SOURCE_LINKED)).toBe(true);
  });

  it('validates a CaseContractV1 envelope while preserving strict per-case semantics', () => {
    const { contract, sourceText } = fixture();
    const sourceClauses = contract.sourceClauses;
    const caseContract = clone(contract);
    delete caseContract.sourceClauses;
    const envelope = {
      version: 'CaseContractV1',
      sourceClauses,
      cases: [caseContract],
      clarifications: [],
    };

    const result = semantic.validateSemanticCaseContractEnvelope(envelope, { sourceText, maxSteps: 100 });
    expect(result).toMatchObject({ ok: true, findings: [] });
    expect(result.contract.cases).toHaveLength(1);
    expect(result.contract.cases[0].steps).toHaveLength(contract.steps.length);
    expect(result.contract.cases[0].assertions).toHaveLength(contract.assertions.length);
    expect(result.contract.sourceClauses).toHaveLength(sourceClauses.length);
  });

  it('rejects clarification-only and zero-case envelopes instead of allowing fallback', () => {
    const { contract, sourceText } = fixture();
    const result = semantic.validateSemanticCaseContractEnvelope({
      version: 'CaseContractV1',
      sourceClauses: contract.sourceClauses,
      cases: [],
      clarifications: [{ id: 'clarification.blocking', blocking: true, question: 'Which control?', reason: 'Ambiguous target', options: [] }],
    }, { sourceText, maxSteps: 100 });
    const codes = findingCodes(result);
    expect(result.ok).toBe(false);
    expect(codes.has(semantic.FINDING_CODES.STEPS_MISSING)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.CLARIFICATION_REQUIRED)).toBe(true);
  });

  it('normalizes exact quote offsets and harmless display whitespace while preserving a valid messy-story semantic contract', () => {
    const { contract, sourceText, quotes } = fixture();
    contract.steps[1].type = ' fill ';
    contract.steps[1].targetIdentity.label = '  Owning Organization  ';
    contract.steps[1].sourceQuote = `  ${contract.steps[1].sourceQuote}  `;

    const normalized = semantic.normalizeSemanticCaseContract(contract, { sourceText });
    expect(normalized.steps[1]).toMatchObject({
      type: 'Fill',
      targetIdentity: { label: 'Owning Organization', role: 'textbox', scope: 'General Information section' },
      sourceQuote: quotes[2],
      sourceSpan: { start: sourceText.indexOf(quotes[2]), end: sourceText.indexOf(quotes[2]) + quotes[2].length },
    });
    expect(normalized.sourceClauses.every((entry) => Number.isInteger(entry.sourceSpan.start))).toBe(true);
    expect(semantic.validateSemanticCaseContract(contract, { sourceText })).toMatchObject({ ok: true, findings: [] });
    expect(semantic.assertSemanticCaseContract(contract, { sourceText }).id).toBe(contract.id);
  });

  it('canonicalizes recoverable provider representation without changing semantic order or identities', () => {
    const { contract, sourceText } = fixture();
    const expectedStepIds = contract.steps.map((step) => step.id);
    const expectedAssertionIds = contract.assertions.map((assertion) => assertion.id);
    contract.sourceClauses.forEach((clause, index) => { clause.ordinal = (index + 1) * 10; });
    contract.steps.forEach((step, index) => { step.ordinal = (index + 1) * 10; });
    contract.assertions.forEach((assertion, index) => { assertion.ordinal = (index + 1) * 10; });
    contract.sourceClauses[1].disposition = 'browser action';
    contract.steps[0].type = 'click-control';
    contract.steps[0].flowImpact = 'State Change';
    delete contract.steps[0].failureBehavior;
    contract.steps[0].targetIdentity = {
      kind: 'CONTROL',
      label: '',
      role: '',
      scope: '',
      description: 'Create Order',
    };
    contract.assertions[0].comparator = 'collection exact order';
    contract.assertions[0].payload.channel = 'COLLECTION';
    contract.assertions[0].payload.operands[0].kind = 'target property';

    const sourceClauses = contract.sourceClauses;
    const caseContract = clone(contract);
    delete caseContract.sourceClauses;
    const result = semantic.validateSemanticCaseContract({
      version: 'CaseContractV1',
      sourceClauses,
      cases: [caseContract],
      clarifications: [],
    }, { sourceText, maxSteps: 100 });

    expect(result).toMatchObject({ ok: true, findings: [] });
    expect(result.contract.sourceClauses.map((clause) => clause.ordinal)).toEqual(
      result.contract.sourceClauses.map((_, index) => index + 1),
    );
    expect(result.contract.sourceClauses[1].disposition).toBe('action');
    expect(result.contract.cases[0].steps.map((step) => step.id)).toEqual(expectedStepIds);
    expect(result.contract.cases[0].assertions.map((assertion) => assertion.id)).toEqual(expectedAssertionIds);
    expect(result.contract.cases[0].steps[0]).toMatchObject({
      ordinal: 1,
      type: 'Click',
      flowImpact: 'state_change',
      failureBehavior: 'stop_descendants',
      targetIdentity: { kind: 'control', description: 'Create Order' },
    });
    expect(result.contract.cases[0].assertions[0]).toMatchObject({
      ordinal: 1,
      comparator: 'collection_exact_order',
      payload: { channel: 'collection' },
    });
    expect(result.contract.cases[0].assertions[0].payload.operands[0].kind).toBe('target_property');
  });

  it('keeps genuinely missing target meaning and unknown action types fail-closed', () => {
    const { contract, sourceText } = fixture();
    contract.steps[0].type = 'DoSomethingSmart';
    contract.steps[0].targetIdentity = { kind: 'control', label: '', role: '', scope: '' };
    const result = semantic.validateSemanticCaseContract(contract, { sourceText });
    const codes = findingCodes(result);
    expect(codes.has(semantic.FINDING_CODES.STEP_TYPE_UNSUPPORTED)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.TARGET_IDENTITY_INVALID)).toBe(true);
  });

  it('rejects the persisted target/value contamination class and legacy prose targets', () => {
    const { contract, sourceText } = fixture();
    contract.steps[1].targetIdentity.label = 'capital letters, into the Owning Organization';
    contract.steps[1].target = 'Click the Owning Organization field';
    const result = semantic.validateSemanticCaseContract(contract, { sourceText });
    expect(findingCodes(result)).toEqual(expect.objectContaining(new Set([
      semantic.FINDING_CODES.TARGET_IDENTITY_PROSE,
      semantic.FINDING_CODES.LEGACY_TARGET_FORBIDDEN,
    ])));
  });

  it('rejects assertion prose and unresolved selected-time/value pronouns', () => {
    const { contract, sourceText } = fixture();
    contract.assertions[1].payload.operands[1].value = 'Verify the selected time';
    const result = semantic.validateSemanticCaseContract(contract, { sourceText });
    const codes = findingCodes(result);
    expect(codes.has(semantic.FINDING_CODES.ASSERTION_EXPECTED_INSTRUCTION)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.UNRESOLVED_REFERENCE)).toBe(true);
  });

  it('requires exact collection arrays and two distinctly named temporal operands', () => {
    const { contract, sourceText } = fixture();
    contract.assertions[0].payload.operands[1] = {
      role: 'expected',
      kind: 'text',
      value: 'first A, second B',
    };
    contract.assertions[2].comparator = 'equals';
    contract.assertions[2].payload.operands = [
      { role: 'actual', kind: 'temporal_reference', name: 'the selected time', ref: 'runtime:first' },
      { role: 'expected', kind: 'temporal_reference', name: 'the selected time', ref: 'runtime:second' },
    ];
    const result = semantic.validateSemanticCaseContract(contract, { sourceText });
    const codes = findingCodes(result);
    expect(codes.has(semantic.FINDING_CODES.COLLECTION_EXPECTED_ARRAY)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.TEMPORAL_COMPARATOR_INVALID)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.UNRESOLVED_REFERENCE)).toBe(true);
  });

  it('keeps visibility and enablement separate and rejects hidden double negatives', () => {
    const { contract, sourceText } = fixture();
    Object.assign(contract.assertions[0], {
      type: 'AssertVisible',
      comparator: 'enabled',
      payload: {
        channel: 'state',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'enabled' },
          { role: 'expected', kind: 'boolean', value: true },
        ],
      },
    });
    Object.assign(contract.assertions[1], {
      type: 'AssertHidden',
      comparator: 'hidden',
      targetIdentity: TARGET('no required-field validation message', 'alert', 'Planning Date/Time section', 'region'),
      payload: {
        channel: 'state',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'visible' },
          { role: 'expected', kind: 'boolean', value: false },
        ],
      },
    });
    const codes = findingCodes(semantic.validateSemanticCaseContract(contract, { sourceText }));
    expect(codes.has(semantic.FINDING_CODES.VISIBILITY_ENABLEMENT_CONFLATED)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.HIDDEN_TARGET_DOUBLE_NEGATIVE)).toBe(true);
  });

  it('requires canonical date, time, and timezone-qualified datetime literals', () => {
    const { contract, sourceText } = fixture();
    contract.steps[5].value = 'August 20, 2026';
    contract.steps[6].value = '09:00 AM';
    contract.steps[7].type = 'DateTime';
    contract.steps[7].value = '2026-08-20 11:00';
    const codes = findingCodes(semantic.validateSemanticCaseContract(contract, { sourceText }));
    expect(codes.has(semantic.FINDING_CODES.DATE_NOT_CANONICAL)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.TIME_NOT_CANONICAL)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.DATETIME_NOT_CANONICAL)).toBe(true);
  });

  it('rejects missing or ambiguous action values, bad selection criteria, and compound action/assertion text', () => {
    const { contract, sourceText } = fixture();
    delete contract.steps[1].value;
    contract.steps[2].selectionCriteria = { kind: 'ordinal', ordinal: 0 };
    contract.steps[2].value = '*SIGROUP-EUR SOURCE SYSTEM 01';
    contract.steps[3].type = 'DoEverything';
    contract.steps[3].text = 'Scroll the section, click its header, and verify it is visible.';
    const codes = findingCodes(semantic.validateSemanticCaseContract(contract, { sourceText }));
    expect(codes.has(semantic.FINDING_CODES.VALUE_REQUIRED)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.SELECTION_INVALID)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.STEP_TYPE_UNSUPPORTED)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.STEP_NOT_ATOMIC)).toBe(true);
  });

  it('requires existing, backward, duplicate-free, acyclic dependencies', () => {
    const { contract, sourceText } = fixture();
    contract.steps[0].dependsOn = ['case.step.002'];
    contract.steps[1].dependsOn = ['case.step.001'];
    contract.steps[2].dependsOn = ['case.step.missing', 'case.step.missing'];
    delete contract.steps[3].dependsOn;
    const codes = findingCodes(semantic.validateSemanticCaseContract(contract, { sourceText }));
    expect(codes.has(semantic.FINDING_CODES.DEPENDENCY_FORWARD)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.DEPENDENCY_CYCLE)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.DEPENDENCY_MISSING)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.DEPENDENCY_DUPLICATE)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.DEPENDENCIES_INVALID)).toBe(true);
  });

  it('fails for uncovered, duplicated, unrepresented, or clarification-blocked source clauses', () => {
    const baseline = fixture();

    const uncovered = clone(baseline.contract);
    uncovered.sourceClauses.splice(3, 1);
    uncovered.sourceClauses.forEach((entry, index) => { entry.ordinal = index + 1; });
    expect(findingCodes(semantic.validateSemanticCaseContract(uncovered, { sourceText: baseline.sourceText })).has(
      semantic.FINDING_CODES.SOURCE_TEXT_UNCOVERED,
    )).toBe(true);

    const duplicated = clone(baseline.contract);
    duplicated.sourceClauses.splice(4, 0, { ...clone(duplicated.sourceClauses[3]), id: 'source.clause.duplicate' });
    duplicated.sourceClauses.forEach((entry, index) => { entry.ordinal = index + 1; });
    const duplicateCodes = findingCodes(semantic.validateSemanticCaseContract(duplicated, { sourceText: baseline.sourceText }));
    expect(duplicateCodes.has(semantic.FINDING_CODES.SOURCE_SPAN_DUPLICATE)).toBe(true);
    expect(duplicateCodes.has(semantic.FINDING_CODES.SOURCE_SPAN_OVERLAP)).toBe(true);

    const omitted = clone(baseline.contract);
    omitted.assertions.shift();
    omitted.assertions.forEach((entry, index) => { entry.ordinal = index + 1; });
    expect(findingCodes(semantic.validateSemanticCaseContract(omitted, { sourceText: baseline.sourceText })).has(
      semantic.FINDING_CODES.SOURCE_CLAUSE_OMITTED,
    )).toBe(true);

    const blocked = clone(baseline.contract);
    blocked.assertions.shift();
    blocked.assertions.forEach((entry, index) => { entry.ordinal = index + 1; });
    blocked.sourceClauses[3].disposition = 'clarification';
    blocked.clarifications = [{
      id: 'case.clarification.001',
      ordinal: 1,
      question: 'Which exact option ordering is required?',
      reason: 'The source ordering cannot be resolved.',
      blocking: true,
      options: [],
      sourceQuote: baseline.quotes[3],
      sourceClauseRefs: ['source.clause.004'],
    }];
    expect(findingCodes(semantic.validateSemanticCaseContract(blocked, { sourceText: baseline.sourceText })).has(
      semantic.FINDING_CODES.CLARIFICATION_REQUIRED,
    )).toBe(true);
  });

  it('rejects an envelope when a globally authored clause is omitted by every case', () => {
    const { contract, sourceText } = fixture();
    contract.assertions.shift();
    contract.assertions.forEach((entry, index) => { entry.ordinal = index + 1; });
    const sourceClauses = contract.sourceClauses;
    delete contract.sourceClauses;

    const result = semantic.validateSemanticCaseContractEnvelope({
      version: 'CaseContractV1',
      sourceClauses,
      cases: [contract],
      clarifications: [],
    }, { sourceText });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: semantic.FINDING_CODES.SOURCE_CLAUSE_OMITTED,
        path: '$.sourceClauses[3]',
        evidence: 'source.clause.004',
      }),
    ]));
  });

  it('rejects one evidence span that claims multiple unrelated source clauses', () => {
    const { contract, sourceText } = fixture();
    contract.assertions[0].sourceClauseRefs.push('source.clause.006');

    const result = semantic.validateSemanticCaseContract(contract, { sourceText });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: semantic.FINDING_CODES.SOURCE_ENTITY_LINK_MISMATCH,
        path: '$.assertions[0].sourceSpan',
        evidence: { mismatchedRefs: ['source.clause.006'] },
      }),
    ]));
  });

  it('requires stable ids, explicit session/failure policy, and reference-only sensitive values', () => {
    const { contract, sourceText } = fixture();
    contract.steps[1].id = contract.assertions[0].id;
    contract.sessionRequirement = { mode: 'continue_from_case', sourceClauseRefs: ['source.clause.001'] };
    contract.failurePolicy.default = 'guess_and_continue';
    contract.steps[1].targetIdentity.label = 'Password';
    contract.steps[1].value = 'Raw-Secret-123';
    const codes = findingCodes(semantic.validateSemanticCaseContract(contract, { sourceText }));
    expect(codes.has(semantic.FINDING_CODES.ID_DUPLICATE)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.SESSION_REQUIREMENT_INVALID)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.FAILURE_POLICY_INVALID)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.SENSITIVE_LITERAL)).toBe(true);
  });

  it('blocks 81-step-style inflation through explicit budgets and duplicate semantic-step detection', () => {
    const { contract, sourceText } = fixture();
    const duplicate = clone(contract.steps[0]);
    duplicate.id = 'case.step.duplicate';
    duplicate.ordinal = contract.steps.length + 1;
    contract.steps.push(duplicate);
    const codes = findingCodes(semantic.validateSemanticCaseContract(contract, {
      sourceText,
      maxSteps: contract.steps.length - 1,
    }));
    expect(codes.has(semantic.FINDING_CODES.STEP_LIMIT_EXCEEDED)).toBe(true);
    expect(codes.has(semantic.FINDING_CODES.DUPLICATE_STEP)).toBe(true);
  });

  it('accepts exactly 100 combined browser actions and assertions', () => {
    const { contract, sourceText } = operationBudgetFixture(47, 53);
    const result = semantic.validateSemanticCaseContract(contract, { sourceText, maxSteps: 100 });
    expect(result.ok).toBe(true);
    expect(findingCodes(result).has(semantic.FINDING_CODES.STEP_LIMIT_EXCEEDED)).toBe(false);
  });

  it('rejects 101 combined operations with exact action and assertion counts', () => {
    const { contract, sourceText } = operationBudgetFixture(47, 54);
    const result = semantic.validateSemanticCaseContract(contract, { sourceText, maxSteps: 100 });
    const finding = result.findings.find((entry) => entry.code === semantic.FINDING_CODES.STEP_LIMIT_EXCEEDED);
    expect(result.ok).toBe(false);
    expect(finding).toMatchObject({
      path: '$.steps',
      evidence: { maxSteps: 100, actual: 101, actionCount: 47, assertionCount: 54 },
    });

    const envelopeCase = clone(contract);
    const sourceClauses = envelopeCase.sourceClauses;
    delete envelopeCase.sourceClauses;
    const envelopeResult = semantic.validateSemanticCaseContractEnvelope({
      version: 'CaseContractV1',
      sourceClauses,
      cases: [envelopeCase],
      clarifications: [],
    }, { sourceText, maxSteps: 100 });
    expect(envelopeResult.findings.find((entry) => entry.path === '$.cases'
      && entry.code === semantic.FINDING_CODES.STEP_LIMIT_EXCEEDED)).toMatchObject({
      evidence: { maxSteps: 100, actual: 101, actionCount: 47, assertionCount: 54 },
    });
  });

  it('keeps legacy small semantic cases within the combined operation budget', () => {
    const { contract, sourceText } = fixture();
    const result = semantic.validateSemanticCaseContract(contract, { sourceText, maxSteps: 100 });
    expect(result.ok).toBe(true);
    expect(findingCodes(result).has(semantic.FINDING_CODES.STEP_LIMIT_EXCEEDED)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['fractional', 100.5],
    ['zero', 0],
    ['negative', -1],
  ])('falls back to the 100-operation default for %s maxSteps in standalone and envelope validation', (_label, maxSteps) => {
    const { contract, sourceText } = operationBudgetFixture(47, 54);
    const result = semantic.validateSemanticCaseContract(contract, { sourceText, maxSteps });
    expect(result.findings.find((entry) => entry.path === '$.steps'
      && entry.code === semantic.FINDING_CODES.STEP_LIMIT_EXCEEDED)).toMatchObject({
      evidence: { maxSteps: 100, actual: 101, actionCount: 47, assertionCount: 54 },
    });

    const envelopeCase = clone(contract);
    const sourceClauses = envelopeCase.sourceClauses;
    delete envelopeCase.sourceClauses;
    const envelopeResult = semantic.validateSemanticCaseContractEnvelope({
      version: 'CaseContractV1',
      sourceClauses,
      cases: [envelopeCase],
      clarifications: [],
    }, { sourceText, maxSteps });
    expect(envelopeResult.findings.find((entry) => entry.path === '$.cases'
      && entry.code === semantic.FINDING_CODES.STEP_LIMIT_EXCEEDED)).toMatchObject({
      evidence: { maxSteps: 100, actual: 101, actionCount: 47, assertionCount: 54 },
    });
  });
});
