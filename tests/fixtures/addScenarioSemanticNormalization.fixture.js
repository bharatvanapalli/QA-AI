const BASE_FAILURE_POLICY = Object.freeze({
  default: 'stop_descendants',
  onAssertionFailure: 'continue_independent',
  onActionFailure: 'stop_descendants',
});

function baseCase(overrides = {}) {
  return {
    key: 'case-normalization',
    name: 'Exercise website-neutral semantic normalization',
    intent: 'Preserve authored meaning while canonicalizing formatting only.',
    initialState: 'The generic form is available.',
    expectedFinalState: 'The authored operation and validation are complete.',
    session: { mode: 'fresh' },
    dependencies: [],
    failurePolicy: { ...BASE_FAILURE_POLICY },
    actions: [],
    assertions: [],
    ...overrides,
  };
}

function planFor(testCase) {
  return {
    version: 'AddScenarioSemanticPlanV1',
    cases: [testCase],
  };
}

export function buildHarmlessAliasFixture() {
  const actionQuote = 'Click the Continue control.';
  const assertionQuote = 'Verify the ready marker is visible.';
  return {
    sourceText: `${actionQuote} ${assertionQuote}`,
    plan: planFor(baseCase({
      actions: [{
        key: 'continue',
        type: '  cLiCk  ',
        text: `  ${actionQuote}  `,
        sourceQuote: actionQuote,
        target: {
          kind: '  CONTROL  ',
          label: '  Continue  ',
          role: '  button  ',
          scope: '  Main form  ',
        },
        flowImpact: '  State Change  ',
        failureBehavior: '  Stop Descendants  ',
      }],
      assertions: [{
        key: 'ready-visible',
        type: '  assert visible  ',
        text: `  ${assertionQuote}  `,
        sourceQuote: assertionQuote,
        target: {
          kind: '  REGION  ',
          label: '  ready marker  ',
          role: '  status  ',
        },
        comparator: '  VISIBLE  ',
        stepRef: 'continue',
        failureBehavior: '  Continue Independent  ',
      }],
    })),
  };
}

export function buildCanonicalTemporalFixture() {
  const dateQuote = 'Enter August 20, 2026 in the Pickup Date field.';
  const timeQuote = 'Enter 9:00 AM in the Pickup Time field.';
  const dateAssertionQuote = 'Verify the Pickup Date equals August 20, 2026.';
  const timeAssertionQuote = 'Verify the Pickup Time equals 9:00 AM.';
  return {
    sourceText: [dateQuote, timeQuote, dateAssertionQuote, timeAssertionQuote].join(' '),
    plan: planFor(baseCase({
      actions: [
        {
          key: 'pickup-date', type: ' date ', sourceQuote: dateQuote,
          target: { kind: ' field ', label: ' Pickup Date ', role: ' textbox ' },
          value: 'August 20, 2026',
        },
        {
          key: 'pickup-time', type: ' TIME ', sourceQuote: timeQuote,
          target: { kind: ' FIELD ', label: ' Pickup Time ', role: ' combobox ' },
          value: '9:00 AM', dependsOn: ['pickup-date'],
        },
      ],
      assertions: [
        {
          key: 'pickup-date-value', type: ' assert date ', sourceQuote: dateAssertionQuote,
          target: { kind: ' field ', label: ' Pickup Date ', role: ' textbox ' },
          comparator: ' EQUALS ', expected: 'August 20, 2026', stepRef: 'pickup-date',
        },
        {
          key: 'pickup-time-value', type: ' ASSERT TIME ', sourceQuote: timeAssertionQuote,
          target: { kind: ' FIELD ', label: ' Pickup Time ', role: ' combobox ' },
          comparator: ' equals ', expected: '9:00 AM', stepRef: 'pickup-time',
        },
      ],
    })),
  };
}

export function buildExactLiteralFixture() {
  const routingCode = 'ACME/West + COL (priority 007)';
  const freightTerm = 'Pre-Paid/Add';
  const fillQuote = `Enter ${routingCode} in the Routing Code field.`;
  const selectQuote = `Select ${freightTerm} from the Freight Term dropdown.`;
  const assertionQuote = `Verify the Routing Code equals ${routingCode}.`;
  return {
    routingCode,
    freightTerm,
    sourceText: [fillQuote, selectQuote, assertionQuote].join(' '),
    plan: planFor(baseCase({
      actions: [
        {
          key: 'routing-code', type: 'Fill', sourceQuote: fillQuote,
          target: { kind: 'field', label: 'Routing Code', role: 'textbox' },
          value: routingCode,
        },
        {
          key: 'freight-term', type: 'Select', sourceQuote: selectQuote,
          target: { kind: 'field', label: 'Freight Term', role: 'combobox' },
          selectionCriteria: { kind: ' exact text ', text: freightTerm },
          dependsOn: ['routing-code'],
        },
      ],
      assertions: [{
        key: 'routing-value', type: 'AssertText', sourceQuote: assertionQuote,
        target: { kind: 'field', label: 'Routing Code', role: 'textbox' },
        comparator: 'equals', expected: routingCode, stepRef: 'routing-code',
      }],
    })),
  };
}

export function buildAmbiguousDateFixture() {
  const actionQuote = 'Enter August 20, 2026 or August 21, 2026 in the Pickup Date field.';
  const assertionQuote = 'Verify the Pickup Date field is visible.';
  return {
    sourceText: `${actionQuote} ${assertionQuote}`,
    plan: planFor(baseCase({
      actions: [{
        key: 'pickup-date', type: 'Date', sourceQuote: actionQuote,
        target: { kind: 'field', label: 'Pickup Date', role: 'textbox' },
        value: 'August 20, 2026',
      }],
      assertions: [{
        key: 'pickup-date-visible', type: 'AssertVisible', sourceQuote: assertionQuote,
        target: { kind: 'field', label: 'Pickup Date', role: 'textbox' },
        comparator: 'visible', stepRef: 'pickup-date',
      }],
    })),
  };
}

export function buildMeaningChangeFixture() {
  const actionQuote = 'Click the Delivery Method control.';
  const assertionQuote = 'Verify the ready marker is visible.';
  return {
    sourceText: `${actionQuote} ${assertionQuote}`,
    plan: planFor(baseCase({
      actions: [{
        key: 'delivery-method', type: 'Click', sourceQuote: actionQuote,
        target: { kind: 'control', label: 'Delivery Method', role: 'button' },
        selectionCriteria: { kind: 'exact_text', text: 'Express' },
      }],
      assertions: [{
        key: 'ready-visible', type: 'AssertVisible', sourceQuote: assertionQuote,
        target: { kind: 'region', label: 'ready marker', role: 'status' },
        comparator: 'equals', stepRef: 'delivery-method',
      }],
    })),
  };
}

export function buildSourceLiteralDriftFixture() {
  const actionQuote = 'Enter ACME/West in the Routing Code field.';
  const assertionQuote = 'Verify the Routing Code field is visible.';
  return {
    sourceText: `${actionQuote} ${assertionQuote}`,
    plan: planFor(baseCase({
      actions: [{
        key: 'routing-code', type: 'Fill', sourceQuote: actionQuote,
        target: { kind: 'field', label: 'Routing Code', role: 'textbox' },
        value: 'ACME/East',
      }],
      assertions: [{
        key: 'routing-visible', type: 'AssertVisible', sourceQuote: assertionQuote,
        target: { kind: 'field', label: 'Routing Code', role: 'textbox' },
        comparator: 'visible', stepRef: 'routing-code',
      }],
    })),
  };
}
