import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createSemanticPlanFromInterpretation, _private } = require('../../server/services/addScenarioInterpretationDraft');
const semanticValidator = require('../../server/services/caseContractSemanticValidator');

describe('reviewed Add Scenario interpretation draft', () => {
  it('preserves an actionable finding when an upstream projection error has none', () => {
    expect(_private.projectionFindings({ code: 'UPSTREAM_REJECTED', message: 'Projection rejected the reviewed operation.' })).toEqual([
      expect.objectContaining({
        path: '$.projection',
        code: 'UPSTREAM_REJECTED',
        message: 'Projection rejected the reviewed operation.',
        severity: 'error',
      }),
    ]);
  });

  it('rejects a reviewed projection when strict semantic validation fails', () => {
    const validationSpy = vi.spyOn(semanticValidator, 'validateSemanticCaseContract').mockReturnValue({
      ok: false,
      contract: { version: 'CaseContractV1', cases: [] },
      findings: [{ code: 'semantic_contract_steps_missing', severity: 'error', path: '$.cases' }],
    });
    try {
      expect(() => createSemanticPlanFromInterpretation({
        sourceText: '1. Click Continue.\n2. Verify Continue is visible.',
        interpretation: {
          title: 'Continue',
          intentSummary: 'Continue and verify the result.',
          session: { mode: 'fresh', initialState: 'Page is open', finalState: 'Continue is visible' },
          operations: [
            { kind: 'action', type: 'Click', target: 'Continue', reason: 'Step 1' },
            { kind: 'assertion', type: 'AssertVisible', target: 'Continue', reason: 'Step 2' },
          ],
        },
      })).toThrow(expect.objectContaining({
        code: 'ADD_SCENARIO_INTERPRETATION_DRAFT_INVALID',
        status: 422,
        findings: [{ code: 'semantic_contract_steps_missing', severity: 'error', path: '$.cases' }],
      }));
    } finally {
      validationSpy.mockRestore();
    }
  });

  it('compiles generic atomic actions and assertions into the existing CaseContractV1 boundary', () => {
    const sourceText = [
      '1. Continue from the authenticated dashboard.',
      '2. Open the Equipment dropdown.',
      '3. Select the third option, LTL.',
      '4. Verify that Equipment displays LTL.',
      '5. Open the Time Zone dropdown and select an option whose visible label contains Central.',
      '6. Verify that the selected Time Zone label contains Central.',
      '7. Verify that the Create Order control is visible and enabled.',
    ].join('\n');
    const interpretation = {
      title: 'Configure an order',
      intentSummary: 'Continue from login and configure order controls.',
      session: {
        mode: 'continue_from_previous_case',
        predecessorCaseId: 'case-login',
        initialState: 'Authenticated dashboard',
        finalState: 'Order form remains open',
      },
      operations: [
        { id: 'op-1', ordinal: 1, kind: 'action', type: 'Expand', target: 'Equipment dropdown', reason: 'Step 2' },
        { id: 'op-2', ordinal: 2, kind: 'action', type: 'Select', target: 'Equipment dropdown', selectionCriteria: { kind: 'ordinal', ordinal: 3, expectedText: 'LTL' }, reason: 'Step 3' },
        { id: 'op-3', ordinal: 3, kind: 'assertion', type: 'AssertValue', target: 'Equipment field', expected: 'LTL', reason: 'Step 4' },
        { id: 'op-4', ordinal: 4, kind: 'action', type: 'Expand', target: 'Time Zone dropdown', reason: 'Step 5' },
        { id: 'op-5', ordinal: 5, kind: 'action', type: 'Select', target: 'Time Zone dropdown', selectionCriteria: { kind: 'predicate', predicate: 'visible label contains Central' }, reason: 'Step 5' },
        { id: 'op-6', ordinal: 6, kind: 'assertion', type: 'AssertText', target: 'Time Zone field', expected: 'Central', reason: 'Step 6' },
        { id: 'op-7', ordinal: 7, kind: 'assertion', type: 'AssertVisible', target: 'Create Order control', reason: 'Step 7' },
        { id: 'op-8', ordinal: 8, kind: 'assertion', type: 'AssertEnabled', target: 'Create Order control', reason: 'Step 7' },
      ],
    };

    const semanticPlan = createSemanticPlanFromInterpretation({ sourceText, interpretation, predecessorCaseId: 'case-login' });
    const contract = semanticPlan.caseContractV1;
    expect(contract.version).toBe('CaseContractV1');
    expect(contract.cases).toHaveLength(1);
    expect(contract.cases[0].sessionRequirement).toMatchObject({ mode: 'continue_from_case', predecessorCaseId: 'case-login' });
    expect(contract.cases[0].steps.map((step) => step.type)).toEqual(['Expand', 'Select', 'Expand', 'Select']);
    expect(contract.cases[0].steps[1].selectionCriteria).toMatchObject({ kind: 'ordinal', ordinal: 3, expectedText: 'LTL' });
    expect(contract.cases[0].steps[3].selectionCriteria).toMatchObject({ kind: 'predicate', predicate: 'visible label contains Central' });
    expect(contract.cases[0].assertions.map((assertion) => assertion.type)).toEqual(['AssertValue', 'AssertText', 'AssertVisible', 'AssertEnabled']);
  });

  it('projects normalized collections, dates, predicate text, exact option clicks, and radio values', () => {
    const sourceText = [
      '1. Verify the list contains Alpha and Beta.',
      '2. Click the second option, Beta.',
      '3. Select Ship Date & Time if it is not already selected.',
      '4. Select August 20, 2026 in the Early Pickup Date calendar.',
      '5. Verify Early Pickup Date represents August 20, 2026.',
      '6. Select an available time zone whose visible label contains Central.',
      '7. Verify the selected label contains Central.',
    ].join('\n');
    const interpretation = {
      title: 'Generic complex control flow',
      intentSummary: 'Exercise a collection, option, radio, date, and predicate selection.',
      session: { mode: 'fresh', initialState: 'The form is open.', finalState: 'The values are selected and verified.' },
      operations: [
        { kind: 'assertion', type: 'AssertCollection', target: 'Option list', expected: 'List contains Alpha and Beta', reason: 'Step 1' },
        { kind: 'action', type: 'Click', target: 'Option list', selectionCriteria: { kind: 'ordinal', ordinal: 2, expectedText: 'Beta' }, reason: 'Step 2' },
        { kind: 'action', type: 'Radio', target: 'Ship Date & Time option', reason: 'Step 3' },
        { kind: 'action', type: 'Date', target: 'Early Pickup Date calendar', value: '08/20/2026', reason: 'Step 4' },
        { kind: 'assertion', type: 'AssertTemporal', target: 'Early Pickup Date field', expected: '08/20/2026', reason: 'Step 5' },
        { kind: 'action', type: 'Select', target: 'Time Zone dropdown', selectionCriteria: { kind: 'predicate', predicate: 'visible label contains Central' }, reason: 'Step 6' },
        { kind: 'assertion', type: 'AssertValue', target: 'Time Zone field', expected: 'Selected label contains Central', reason: 'Step 7' },
      ],
    };

    const result = createSemanticPlanFromInterpretation({ sourceText, interpretation });
    const testCase = result.caseContractV1.cases[0];
    expect(testCase.steps.map((step) => step.type)).toEqual(['Click', 'Radio', 'Date', 'Select']);
    expect(testCase.steps[0].targetIdentity.label).toBe('Beta');
    expect(testCase.steps[1].value).toBe('Ship Date & Time');
    expect(testCase.steps[2].value).toBe('2026-08-20');
    expect(testCase.assertions[0].payload.operands[1]).toMatchObject({ kind: 'collection', items: ['Alpha', 'Beta'] });
    expect(testCase.assertions[1]).toMatchObject({ type: 'AssertDate', comparator: 'equals' });
    expect(testCase.assertions[2]).toMatchObject({ type: 'AssertText', comparator: 'contains' });
    expect(testCase.assertions[2].payload.operands[1]).toMatchObject({ value: 'Central' });
  });

  it('projects date-value assertions and exact clock selections from generic model output', () => {
    const sourceText = [
      '1. Select 07:30 PM from the Appointment Time dropdown.',
      '2. Verify the Appointment Date field contains 10/31/2027.',
    ].join('\n');
    const interpretation = {
      title: 'Schedule an appointment',
      intentSummary: 'Set and verify generic temporal controls.',
      session: { mode: 'fresh', initialState: 'The scheduling form is open.', finalState: 'The schedule is populated.' },
      operations: [
        {
          kind: 'action', type: 'Select', target: 'Appointment Time dropdown',
          selectionCriteria: { kind: 'ordinal', ordinal: 7 },
          reason: 'Select 07:30 PM from the Appointment Time dropdown.',
        },
        {
          kind: 'assertion', type: 'AssertValue', target: 'Appointment Date field',
          expected: '10/31/2027', reason: 'Verify the Appointment Date field contains 10/31/2027.',
        },
      ],
    };

    const result = createSemanticPlanFromInterpretation({ sourceText, interpretation });
    const testCase = result.caseContractV1.cases[0];
    expect(testCase.steps[0]).toMatchObject({
      type: 'Select',
      selectionCriteria: { kind: 'exact_text', text: '07:30 PM' },
    });
    expect(testCase.assertions[0]).toMatchObject({ type: 'AssertDate', comparator: 'equals' });
    expect(testCase.assertions[0].payload.operands[1]).toMatchObject({ value: '2027-10-31' });
  });

  it('retains explicit action effects and delegates an immediately following wait as a generic click oracle', () => {
    const sourceText = [
      '1. Click Orders.',
      '2. Wait for the Orders page to become stable.',
      '3. Click Create Order.',
      '4. Wait for the Create New Order form to become stable.',
      '5. Verify the Create New Order heading is visible.',
    ].join('\n');
    const interpretation = {
      title: 'Continue through generic page transitions',
      intentSummary: 'Use approved waits as transition evidence.',
      session: { mode: 'fresh', initialState: 'The start page is open.', finalState: 'The destination form is visible.' },
      operations: [
        { id: 'op-1', kind: 'action', type: 'Click', target: 'Orders', reason: 'Step 1' },
        { id: 'op-2', kind: 'action', type: 'WaitForState', target: 'Orders page', expected: 'Orders page is stable', reason: 'Step 2' },
        { id: 'op-3', kind: 'action', type: 'Click', target: 'Create Order', expected: 'Create New Order begins loading', reason: 'Step 3' },
        { id: 'op-4', kind: 'action', type: 'WaitForState', target: 'Create New Order form', expected: 'Create New Order form is stable', reason: 'Step 4' },
        { id: 'op-5', kind: 'assertion', type: 'AssertVisible', target: 'Create New Order heading', reason: 'Step 5' },
      ],
    };

    const result = createSemanticPlanFromInterpretation({ sourceText, interpretation });
    const steps = result.caseContractV1.cases[0].steps;
    expect(steps[0]).toMatchObject({ type: 'Click', targetIdentity: { label: 'Orders' }, expected: 'Orders page is stable' });
    expect(steps[2]).toMatchObject({ type: 'Click', targetIdentity: { label: 'Create Order' }, expected: 'Create New Order begins loading' });
  });

  it('projects a reviewed long-flow fragment when repeated literals and paraphrased conditions make sentence evidence ambiguous', () => {
    const sourceText = [
      '1. If the Pickup section is collapsed, open it; otherwise leave it open.',
      '2. Select August 20, 2026 for the Early Date and verify the value.',
      '3. Select August 20, 2026 for the Late Date and verify the value.',
      '4. Verify the list contains Alpha and Beta, then continue on mismatch.',
    ].join('\n');
    const interpretation = {
      title: 'Review repeated temporal values',
      intentSummary: 'Open a section idempotently and verify repeated dates and a collection.',
      session: { mode: 'fresh', initialState: 'The form is open.', finalState: 'The reviewed values remain visible.' },
      operations: [
        {
          kind: 'action', type: 'Expand', target: 'Pickup section',
          condition: 'only if the Pickup section is currently collapsed', reason: 'Open the section only when needed.',
        },
        { kind: 'action', type: 'Date', target: 'Early Date calendar', value: '08/20/2026', reason: 'Choose the early date.' },
        { kind: 'assertion', type: 'AssertDate', target: 'Early Date field', expected: '08/20/2026', reason: 'Confirm the early date.' },
        { kind: 'action', type: 'Date', target: 'Late Date calendar', value: '08/20/2026', reason: 'Choose the late date.' },
        { kind: 'assertion', type: 'AssertDate', target: 'Late Date field', expected: '08/20/2026', reason: 'Confirm the late date.' },
        { kind: 'assertion', type: 'AssertCollection', target: 'Option list', expected: ['Alpha', 'Beta'], nonBlocking: true, reason: 'Confirm both options.' },
      ],
    };

    const result = createSemanticPlanFromInterpretation({ sourceText, interpretation });
    const testCase = result.caseContractV1.cases[0];
    expect(testCase.steps.map((step) => step.type)).toEqual(['Expand', 'Date', 'Date']);
    expect(testCase.steps[0].condition).toMatchObject({ kind: 'authored_predicate', comparator: 'satisfied' });
    expect(testCase.steps.slice(1).map((step) => step.value)).toEqual(['2026-08-20', '2026-08-20']);
    expect(testCase.assertions.map((assertion) => assertion.type)).toEqual(['AssertDate', 'AssertDate', 'AssertCollection']);
    expect(testCase.assertions[2].failureBehavior).toBe('continue_independent');
    for (const record of [...testCase.steps, ...testCase.assertions]) {
      expect(record.sourceSpan).toEqual(expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }));
    }
  });
});
