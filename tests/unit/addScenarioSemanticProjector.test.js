import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const projector = require('../../server/services/addScenarioSemanticProjector');
const validator = require('../../server/services/caseContractSemanticValidator');
const {
  buildSourceLedger,
  validateSourceLedgerClaims,
} = require('../../server/services/addScenarioSourceLedger');

function baseCase(overrides = {}) {
  return {
    key: 'case-main',
    name: 'Execute the authored flow',
    intent: 'Preserve and execute the authored behavior.',
    initialState: 'The starting page is available.',
    expectedFinalState: 'The authored outcome is checked.',
    session: { mode: 'fresh' },
    dependencies: [],
    failurePolicy: {
      default: 'stop_descendants',
      onAssertionFailure: 'continue_independent',
      onActionFailure: 'stop_descendants',
    },
    actions: [],
    assertions: [],
    ...overrides,
  };
}

function visibleAssertion(sourceQuote, overrides = {}) {
  return {
    key: 'completion-visible',
    type: 'AssertVisible',
    comparator: 'visible',
    text: 'Verify the completion marker is visible.',
    sourceQuote,
    target: { kind: 'region', label: 'completion marker', role: 'status' },
    ...overrides,
  };
}

function projectionError(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected semantic projection to fail.');
}

function exactClaim(source, unit, disposition, ref, relativeStart = 0, relativeEnd = unit.sourceQuote.length) {
  const sourceSpan = {
    start: unit.sourceSpan.start + relativeStart,
    end: unit.sourceSpan.start + relativeEnd,
  };
  return {
    unitRef: unit.id,
    disposition,
    sourceSpan,
    sourceQuote: source.slice(sourceSpan.start, sourceSpan.end),
    links: ['action', 'assertion', 'condition', 'data'].includes(disposition)
      ? [{ kind: disposition, ref }]
      : [],
  };
}

function exactLedgerAuthority(source, makeClaims) {
  const sourceLedgerV1 = buildSourceLedger(source);
  const sourceClaims = makeClaims(sourceLedgerV1);
  const literalUsages = sourceLedgerV1.literals.map((literal, index) => ({
    literalRef: literal.id,
    consumerRefs: [`compiler:literal:${index + 1}`],
  }));
  const sourceCompleteness = validateSourceLedgerClaims(sourceLedgerV1, source, {
    claims: sourceClaims,
    literalUsages,
  });
  return { sourceLedgerV1, sourceClaims, sourceCompleteness };
}

describe('addScenarioSemanticProjector', () => {
  it('projects compact collection and temporal semantics into a strict CaseContractV1', () => {
    const source = [
      'Open the Equipment dropdown.',
      'Verify the options are RR, LCL, and LTL in that order.',
      'Verify Early Pickup Date/Time is before Late Pickup Date/Time.',
    ].join(' ');
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'open-equipment',
          type: 'Click',
          text: 'Open the Equipment dropdown.',
          sourceQuote: 'Open the Equipment dropdown.',
          target: { kind: 'field', label: 'Equipment', role: 'combobox', scope: 'General Information' },
        }],
        assertions: [
          {
            key: 'equipment-options',
            type: 'AssertCollection',
            text: 'Verify the Equipment option order.',
            sourceQuote: 'Verify the options are RR, LCL, and LTL in that order.',
            target: { kind: 'collection', label: 'Equipment options', role: 'listbox', scope: 'General Information' },
            comparator: 'collection_exact_order',
            expected: ['RR', 'LCL', 'LTL'],
            stepRef: 'open-equipment',
          },
          {
            key: 'pickup-order',
            type: 'AssertTemporal',
            text: 'Verify Early Pickup precedes Late Pickup.',
            sourceQuote: 'Verify Early Pickup Date/Time is before Late Pickup Date/Time.',
            target: { kind: 'collection', label: 'Pickup planning boundaries', description: 'Named pickup date and time fields' },
            comparator: 'before',
            operands: [
              { role: 'actual', kind: 'temporal_reference', name: 'Early Pickup Date/Time', ref: 'runtime:early-pickup-date-time' },
              { role: 'expected', kind: 'temporal_reference', name: 'Late Pickup Date/Time', ref: 'runtime:late-pickup-date-time' },
            ],
            stepRef: 'open-equipment',
          },
        ],
      })],
    };

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    const result = validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 });

    expect(result).toMatchObject({ ok: true, findings: [] });
    expect(envelope.cases[0].steps[0]).toMatchObject({
      ordinal: 1,
      type: 'Click',
      flowImpact: 'state_change',
      failureBehavior: 'stop_descendants',
    });
    expect(envelope.cases[0].assertions[0].payload.operands[1]).toEqual({
      role: 'expected', kind: 'collection', items: ['RR', 'LCL', 'LTL'],
    });
    expect(envelope.cases[0].assertions[1].payload.channel).toBe('temporal');
  });

  it('expands an 81-operation compact plan deterministically within the 100-step budget', () => {
    const actionQuotes = Array.from({ length: 80 }, (_, index) => `Click control ${index + 1}.`);
    const assertionQuote = 'Verify the completion marker is visible.';
    const source = [...actionQuotes, assertionQuote].join(' ');
    const actions = actionQuotes.map((sourceQuote, index) => ({
      key: `action-${index + 1}`,
      type: 'Click',
      text: sourceQuote,
      sourceQuote,
      target: { kind: 'control', label: `control ${index + 1}`, role: 'button', scope: 'authored flow' },
      dependsOn: index ? [`action-${index}`] : [],
    }));
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions,
        assertions: [{
          key: 'completion-visible',
          type: 'AssertVisible',
          comparator: 'visible',
          text: assertionQuote,
          sourceQuote: assertionQuote,
          target: { kind: 'region', label: 'completion marker', role: 'status', scope: 'authored flow' },
          stepRef: 'action-80',
        }],
      })],
    };

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    const result = validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 });

    expect(result).toMatchObject({ ok: true, findings: [] });
    expect(envelope.cases[0].steps).toHaveLength(80);
    expect(envelope.cases[0].steps.map((step) => step.ordinal)).toEqual(
      Array.from({ length: 80 }, (_, index) => index + 1),
    );
    expect(envelope.cases[0].steps[79].dependsOn).toEqual([envelope.cases[0].steps[78].id]);
    expect(JSON.stringify(plan).length).toBeLessThan(JSON.stringify(envelope).length);
  });

  it('owns invalid flowImpact, preserves Select meaning, and expands exact evidence to include the literal', () => {
    const actionQuote = 'Choose NORTHSTAR from the Owning organization list.';
    const assertionQuote = 'Verify the completion marker is visible.';
    const source = `${actionQuote} ${assertionQuote}`;
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'choose-organization',
          type: 'Select',
          text: actionQuote,
          sourceQuote: 'Choose',
          target: { kind: 'field', label: 'Owning organization', role: 'combobox' },
          selection: { kind: 'exact_value', value: 'NORTHSTAR' },
          flowImpact: 'mutates the website',
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'choose-organization' })],
      })],
    };

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    const step = envelope.cases[0].steps[0];
    const result = validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 });

    expect(result).toMatchObject({ ok: true, findings: [] });
    expect(step).toMatchObject({
      type: 'Select',
      sourceQuote: actionQuote,
      flowImpact: 'state_change',
      selectionCriteria: { kind: 'exact_value', value: 'NORTHSTAR' },
    });
    expect(step).not.toHaveProperty('value');
  });

  it('rejects selection on a value-bearing action instead of migrating it into value', () => {
    const actionQuote = 'Enter NORTHSTAR in the Account field.';
    const assertionQuote = 'Verify the completion marker is visible.';
    const source = `${actionQuote} ${assertionQuote}`;
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'enter-account',
          type: 'Fill',
          text: actionQuote,
          sourceQuote: actionQuote,
          target: { kind: 'field', label: 'Account', role: 'textbox' },
          selection: { kind: 'exact_text', text: 'NORTHSTAR' },
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'enter-account' })],
      })],
    };

    const error = projectionError(() => projector.projectSemanticPlan(plan, { sourceText: source }));
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '$.cases[0].actions[0].selection',
        code: 'semantic_plan_selection_for_non_select',
        evidence: 'Fill',
      }),
      expect.objectContaining({ code: 'semantic_plan_action_value_missing' }),
    ]));
  });

  it('rejects selection on Click instead of retyping the authored action', () => {
    const actionQuote = 'Choose NORTHSTAR from the Account list.';
    const assertionQuote = 'Verify the completion marker is visible.';
    const source = `${actionQuote} ${assertionQuote}`;
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'choose-account',
          type: 'Click',
          text: actionQuote,
          sourceQuote: actionQuote,
          target: { kind: 'option', label: 'NORTHSTAR', role: 'option', scope: 'Account list' },
          selection: { kind: 'exact_text', text: 'NORTHSTAR' },
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'choose-account' })],
      })],
    };

    const error = projectionError(() => projector.projectSemanticPlan(plan, { sourceText: source }));
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '$.cases[0].actions[0].selection',
        code: 'semantic_plan_selection_for_non_select',
        evidence: 'Click',
      }),
    ]));
  });

  it('fails locally rather than guessing a missing required value or an unlinked literal', () => {
    const assertionQuote = 'Verify the completion marker is visible.';
    const missingValueQuote = 'Enter the approved account in the Account field.';
    const missingValueSource = `${missingValueQuote} ${assertionQuote}`;
    const missingValuePlan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'enter-account', type: 'Fill', text: missingValueQuote, sourceQuote: missingValueQuote,
          target: { kind: 'field', label: 'Account', role: 'textbox' },
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'enter-account' })],
      })],
    };
    const missingValueError = projectionError(() => projector.projectSemanticPlan(missingValuePlan, { sourceText: missingValueSource }));

    const absentLiteralQuote = 'Enter an account in the Account field.';
    const absentLiteralSource = `${absentLiteralQuote} ${assertionQuote}`;
    const absentLiteralPlan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'enter-account', type: 'Fill', text: absentLiteralQuote, sourceQuote: absentLiteralQuote,
          target: { kind: 'field', label: 'Account', role: 'textbox' }, value: 'NORTHSTAR',
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'enter-account' })],
      })],
    };
    const absentLiteralError = projectionError(() => projector.projectSemanticPlan(absentLiteralPlan, { sourceText: absentLiteralSource }));

    expect(missingValueError).toMatchObject({ code: 'ADD_SCENARIO_SEMANTIC_PROJECTION_INVALID' });
    expect(missingValueError.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_plan_action_value_missing' }),
    ]));
    expect(absentLiteralError.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_plan_source_quote_literal_mismatch' }),
    ]));
  });

  it('atomizes a shared compound source only when every action and assertion is modeled separately', () => {
    const source = 'Open the Equipment dropdown, select LTL, and verify the selected value is visible.';
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [
          {
            key: 'open-equipment', type: 'Click', text: source, sourceQuote: source,
            target: { kind: 'field', label: 'Equipment', role: 'combobox' },
          },
          {
            key: 'select-equipment', type: 'Select', text: source, sourceQuote: source,
            target: { kind: 'option', label: 'LTL', role: 'option', scope: 'Equipment' },
            selection: { kind: 'exact_text', text: 'LTL' }, dependsOn: ['open-equipment'],
          },
        ],
        assertions: [visibleAssertion(source, {
          key: 'selection-visible', text: 'Verify the selected value is visible.',
          target: { kind: 'option', label: 'LTL', role: 'option', scope: 'Equipment' },
          stepRef: 'select-equipment',
        })],
      })],
    };

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    const result = validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 });

    expect(result).toMatchObject({ ok: true, findings: [] });
    expect(envelope.cases[0].steps.map((step) => step.text)).toEqual([
      'Open the Equipment dropdown',
      'select LTL',
    ]);

    const collapsedPlan = structuredClone(plan);
    collapsedPlan.cases[0].actions = [collapsedPlan.cases[0].actions[0]];
    const error = projectionError(() => projector.projectSemanticPlan(collapsedPlan, { sourceText: source }));
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_plan_action_not_atomic' }),
    ]));
  });

  it('omits empty conditions and preserves complete or explicitly authored conditions', () => {
    const actionQuote = 'Open the Details section.';
    const assertionQuote = 'Verify the completion marker is visible.';
    const source = `${actionQuote} when ready. ${assertionQuote}`;
    const makePlan = (condition) => ({
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'open-details', type: 'Click', text: actionQuote, sourceQuote: actionQuote,
          target: { kind: 'region', label: 'Details', role: 'region' }, condition,
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'open-details' })],
      })],
    });

    const emptyEnvelope = projector.projectSemanticPlan(makePlan({}), { sourceText: source });
    expect(emptyEnvelope.cases[0].steps[0]).not.toHaveProperty('condition');

    const condition = {
      kind: 'target_state', comparator: 'equals', operands: [{ property: 'expanded' }, { value: false }],
    };
    const completeEnvelope = projector.projectSemanticPlan(makePlan(condition), { sourceText: source });
    expect(completeEnvelope.cases[0].steps[0].condition).toEqual(condition);
    expect(validator.validateSemanticCaseContract(completeEnvelope, { sourceText: source, maxSteps: 100 }))
      .toMatchObject({ ok: true, findings: [] });

    const authoredEnvelope = projector.projectSemanticPlan(makePlan('when ready'), { sourceText: source });
    expect(authoredEnvelope.cases[0].steps[0].condition).toEqual({
      kind: 'authored_predicate',
      comparator: 'satisfied',
      operands: [{ kind: 'text', value: 'when ready' }],
      sourceQuote: 'when ready',
      sourceSpan: {
        start: source.indexOf('when ready'),
        end: source.indexOf('when ready') + 'when ready'.length,
      },
    });
    expect(validator.validateSemanticCaseContract(authoredEnvelope, { sourceText: source, maxSteps: 100 }))
      .toMatchObject({ ok: true, findings: [] });
  });

  it('rejects parallel Select value authorities instead of discarding either meaning', () => {
    const actionQuote = 'Choose NORTHSTAR from the Account list.';
    const assertionQuote = 'Verify the completion marker is visible.';
    const source = `${actionQuote} ${assertionQuote}`;
    const makePlan = (value) => ({
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'choose-account', type: 'Select', text: actionQuote, sourceQuote: actionQuote,
          target: { kind: 'option', label: 'NORTHSTAR', role: 'option' },
          selection: { kind: 'exact_text', text: 'NORTHSTAR' }, value,
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'choose-account' })],
      })],
    });

    for (const [value, sourceText] of [['NORTHSTAR', source], ['OTHER', `${source} OTHER`]]) {
      const error = projectionError(() => projector.projectSemanticPlan(makePlan(value), { sourceText }));
      expect(error.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'semantic_plan_select_value_forbidden' }),
      ]));
    }
  });

  it('accepts one high-level Select for incidental open-and-choose choreography', () => {
    const actionQuote = 'Open the Equipment dropdown and select LTL.';
    const assertionQuote = 'Verify the Equipment field displays LTL.';
    const source = `${actionQuote} ${assertionQuote}`;
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'equipment', type: 'Select', sourceQuote: actionQuote,
          target: { kind: 'field', label: 'Equipment', role: 'combobox' },
          selection: { kind: 'exact_text', text: 'LTL' },
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'equipment' })],
      })],
    };
    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    expect(envelope.cases[0].steps[0].text).toMatch(/^select\b/i);
    expect(validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 }))
      .toMatchObject({ ok: true, findings: [] });
  });

  it('accepts a canonical Date backed by one authored display date', () => {
    const actionQuote = 'Open the Early Pickup Date calendar and select August 20, 2026.';
    const assertionQuote = 'Verify the Early Pickup Date is populated.';
    const source = `${actionQuote} ${assertionQuote}`;
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'early-date', type: 'Date', sourceQuote: actionQuote,
          target: { kind: 'field', label: 'Early Pickup Date', role: 'textbox' }, value: '2026-08-20',
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'early-date' })],
      })],
    };
    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    expect(envelope.cases[0].steps[0]).toMatchObject({ type: 'Date', value: '2026-08-20' });
    expect(validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 }))
      .toMatchObject({ ok: true, findings: [] });
  });

  it('keeps a generic multi-action Click fail-closed', () => {
    const actionQuote = 'Open the menu and click Submit.';
    const assertionQuote = 'Verify the confirmation is visible.';
    const source = `${actionQuote} ${assertionQuote}`;
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'submit', type: 'Click', sourceQuote: actionQuote,
          target: { kind: 'control', label: 'Submit', role: 'button' },
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'submit' })],
      })],
    };
    const error = projectionError(() => projector.projectSemanticPlan(plan, { sourceText: source }));
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_plan_action_not_atomic' }),
    ]));
  });

  it('preserves authored action type, target, selection, and comparison meaning exactly', () => {
    const clickQuote = 'Choose NORTHSTAR from the Account list.';
    const selectQuote = 'Select 09:00 AM from the Early Pickup Time dropdown.';
    const assertionQuote = 'Verify the status message contains Ready.';
    const source = [clickQuote, selectQuote, assertionQuote].join(' ');
    const clickTarget = { kind: 'control', label: 'Account list', role: 'listbox' };
    const selectTarget = { kind: 'option', label: '09:00', role: 'option' };
    const selection = { kind: 'exact_text', text: '09:00' };
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [
          {
            key: 'choose-account', type: 'Click', sourceQuote: clickQuote,
            target: clickTarget,
          },
          {
            key: 'pickup-time', type: 'Select', sourceQuote: selectQuote,
            target: selectTarget,
            selection,
          },
        ],
        assertions: [{
          key: 'status-ready', type: 'AssertText', sourceQuote: assertionQuote,
          target: { kind: 'region', label: 'status message', role: 'status' },
          comparator: 'contains', expected: 'Ready', stepRef: 'pickup-time',
        }],
      })],
    };

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    const result = validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 });
    const [click, select] = envelope.cases[0].steps;

    expect(result).toMatchObject({ ok: true, findings: [] });
    expect(click.type).toBe('Click');
    expect(click.targetIdentity).toEqual(clickTarget);
    expect(select.type).toBe('Select');
    expect(select.targetIdentity).toEqual(selectTarget);
    expect(select.selectionCriteria).toEqual(selection);
    expect(envelope.cases[0].assertions[0].comparator).toBe('contains');
  });

  it('maps planner-normalized unresolved questions to deterministic preview clarifications by array position', () => {
    const actionQuote = 'Click the Continue button.';
    const assertionQuote = 'Verify the Home page is visible.';
    const source = `${actionQuote} ${assertionQuote}`;
    const unresolvedQuestions = [
      {
        sourceQuote: actionQuote,
        question: 'Which starting state is required?',
        reason: 'The case-level state is ambiguous.',
        affectedRecord: { caseIndex: 0, kind: 'case' },
        id: 'model-id-must-not-survive', ordinal: 99, blocking: false, options: ['guess'],
      },
      {
        sourceQuote: actionQuote,
        question: 'Which Continue control is intended?',
        reason: 'The action target needs clarification.',
        affectedRecord: { caseIndex: 0, kind: 'action', recordIndex: 0 },
      },
      {
        sourceQuote: assertionQuote,
        question: 'Which Home signal is authoritative?',
        reason: 'The final assertion signal is ambiguous.',
        affectedRecord: { caseIndex: 0, kind: 'assertion', recordIndex: 0 },
      },
    ];
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      unresolvedQuestions,
      cases: [baseCase({
        actions: [{
          key: 'continue', type: 'Click', sourceQuote: actionQuote,
          target: { kind: 'control', label: 'Continue button', role: 'button' },
        }],
        assertions: [visibleAssertion(assertionQuote, {
          key: 'home-visible', stepRef: 'continue',
          target: { kind: 'page', label: 'Home page', role: 'main' },
        })],
      })],
    };

    const first = projector.projectSemanticPlan(plan, { sourceText: source });
    const second = projector.projectSemanticPlan(plan, { sourceText: source });

    expect(second.clarifications).toEqual(first.clarifications);
    expect(first.clarifications).toHaveLength(3);
    expect(first.clarifications.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
    expect(first.clarifications.map((entry) => entry.affectedRecord)).toEqual([
      { caseIndex: 0, kind: 'case' },
      { caseIndex: 0, kind: 'action', recordIndex: 0 },
      { caseIndex: 0, kind: 'assertion', recordIndex: 0 },
    ]);
    expect(first.clarifications[0]).toMatchObject({
      blocking: true,
      options: [],
      sourceQuote: actionQuote,
      sourceSpan: { start: 0, end: actionQuote.length },
      sourceClauseRefs: ['source.clause.add-scenario'],
    });
    expect(first.clarifications[0].id).not.toBe('model-id-must-not-survive');
    expect(first.sourceCoverage.filter((entry) => entry.disposition === 'clarification'))
      .toEqual(first.clarifications.map((entry) => ({
        sourceQuote: entry.sourceQuote,
        sourceSpan: entry.sourceSpan,
        disposition: 'clarification',
        refId: entry.id,
      })));
  });

  it('rejects an incompatible comparison instead of replacing it with a default', () => {
    const actionQuote = 'Open the Pickup Date panel.';
    const assertionQuote = 'Verify the Pickup Date equals August 20, 2026.';
    const source = `${actionQuote} ${assertionQuote}`;
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'open-date', type: 'Click', sourceQuote: actionQuote,
          target: { kind: 'region', label: 'Pickup Date panel', role: 'region' },
        }],
        assertions: [{
          key: 'pickup-date', type: 'AssertDate', sourceQuote: assertionQuote,
          target: { kind: 'field', label: 'Pickup Date', role: 'textbox' },
          comparator: 'contains', expected: 'August 20, 2026', stepRef: 'open-date',
        }],
      })],
    };

    const error = projectionError(() => projector.projectSemanticPlan(plan, { sourceText: source }));
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '$.cases[0].assertions[0].comparator',
        code: 'semantic_plan_assertion_relation_incompatible',
        evidence: { type: 'AssertDate', comparator: 'contains' },
      }),
    ]));
  });

  it('uses unique full action evidence when a short selection phrase repeats', () => {
    const genericQuote = 'select an available option whose visible label contains Central';
    const earlyQuote = `Open the Early Pickup Time Zone dropdown and ${genericQuote}.`;
    const lateQuote = `Open the Late Pickup Time Zone dropdown and ${genericQuote}.`;
    const assertionQuote = 'Verify that Planning Date and Time is visible.';
    const source = [earlyQuote, lateQuote, assertionQuote].join(' ');
    const select = (key, text, target) => ({
      key, type: 'Select', text, sourceQuote: genericQuote,
      target: { kind: 'control', label: target, role: 'combobox' },
      selection: { kind: 'predicate', predicate: 'visible label contains Central' },
    });
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [
          select('early-zone', earlyQuote, 'Early Pickup Time Zone dropdown'),
          select('late-zone', lateQuote, 'Late Pickup Time Zone dropdown'),
        ],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'late-zone' })],
      })],
    };

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    expect(envelope.cases[0].steps.map((step) => step.sourceQuote)).toEqual([earlyQuote, lateQuote]);
    expect(validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 }))
      .toMatchObject({ ok: true, findings: [] });
  });

  it('allocates repeated identical actions to distinct source occurrences and rejects missing records', () => {
    const actionQuote = 'Click Save.';
    const assertionQuote = 'Verify that the confirmation is visible.';
    const source = `${actionQuote} ${actionQuote} ${assertionQuote}`;
    const action = (key) => ({
      key, type: 'Click', text: actionQuote, sourceQuote: actionQuote,
      target: { kind: 'control', label: 'Save', role: 'button' },
    });
    const makePlan = (actions) => ({
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions,
        assertions: [visibleAssertion(assertionQuote, { stepRef: actions[actions.length - 1].key })],
      })],
    });

    const envelope = projector.projectSemanticPlan(makePlan([action('save-1'), action('save-2')]), { sourceText: source });
    expect(envelope.cases[0].steps[0].sourceSpan).not.toEqual(envelope.cases[0].steps[1].sourceSpan);
    expect(validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 }))
      .toMatchObject({ ok: true, findings: [] });

    const error = projectionError(() => projector.projectSemanticPlan(makePlan([action('save-1')]), { sourceText: source }));
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_plan_source_cardinality_mismatch' }),
    ]));
  });

  it('rejects inferred target and conflicting temporal value repairs', () => {
    const earlyQuote = 'Open the Early Pickup Date calendar and select August 20, 2026.';
    const assertionQuote = 'Verify that the Early Pickup Date is populated.';
    const source = [earlyQuote, assertionQuote].join(' ');
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'early-date', type: 'Date', text: earlyQuote, sourceQuote: earlyQuote,
          target: { kind: 'control', role: 'textbox' },
          value: '2026-08-21',
        }],
        assertions: [visibleAssertion(assertionQuote, { stepRef: 'early-date' })],
      })],
    };

    const error = projectionError(() => projector.projectSemanticPlan(plan, { sourceText: source }));
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_plan_target_underspecified' }),
      expect.objectContaining({ code: 'semantic_plan_temporal_value_conflict' }),
    ]));
  });

  it('builds assertion mechanics while retaining formatting-only Date and Time canonicalization', () => {
    const dateAction = 'Enter August 20, 2026 in the Pickup Date field.';
    const timeAction = 'Enter 9:00 AM in the Pickup Time field.';
    const dateAssertion = 'Verify the Pickup Date equals August 20, 2026.';
    const countAssertion = 'Verify the option count is at least 3.';
    const source = [dateAction, timeAction, dateAssertion, countAssertion].join(' ');
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [
          {
            key: 'pickup-date', type: 'Date', sourceQuote: dateAction,
            text: 'Open a calendar, click an unrelated day, and verify it.',
            target: { kind: 'field', label: 'Pickup Date', role: 'textbox' },
            value: 'August 20, 2026',
          },
          {
            key: 'pickup-time', type: 'Time', sourceQuote: timeAction,
            target: { kind: 'field', label: 'Pickup Time', role: 'textbox' },
            value: '9:00 AM', dependsOn: ['pickup-date'],
          },
        ],
        assertions: [
          {
            key: 'pickup-date-value', type: 'AssertDate', sourceQuote: dateAssertion,
            text: 'Click something and verify a different value.',
            target: { kind: 'field', label: 'Pickup Date', role: 'textbox' },
            comparator: 'equals', expected: 'August 20, 2026',
            actual: { role: 'provider_actual', kind: 'text', value: 'wrong' },
            payload: { channel: 'text', operands: [{ role: 'wrong', kind: 'text', value: 'wrong' }] },
            stepRef: 'pickup-date',
          },
          {
            key: 'option-count', type: 'AssertCollection', sourceQuote: countAssertion,
            target: { kind: 'collection', label: 'option count', role: 'listbox' },
            comparator: 'count_at_least', expected: 3,
            payload: { channel: 'state', operands: [] }, stepRef: 'pickup-time',
          },
        ],
      })],
    };

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    const result = validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 });
    const [date, time] = envelope.cases[0].steps;
    const [dateCheck, countCheck] = envelope.cases[0].assertions;

    expect(result).toMatchObject({ ok: true, findings: [] });
    expect(date).toMatchObject({ text: dateAction, value: '2026-08-20' });
    expect(time).toMatchObject({ value: '09:00' });
    expect(dateCheck).toMatchObject({
      text: dateAssertion,
      comparator: 'equals',
      payload: {
        channel: 'temporal',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'value' },
          { role: 'expected', kind: 'temporal', temporalType: 'date', value: '2026-08-20' },
        ],
      },
    });
    expect(dateCheck.payload).not.toEqual(plan.cases[0].assertions[0].payload);
    expect(countCheck).toMatchObject({
      comparator: 'count_at_least',
      payload: {
        channel: 'collection',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'count' },
          { role: 'expected', kind: 'count', value: 3 },
        ],
      },
    });
  });

  it('preserves compiler-owned ordered temporal operands exactly', () => {
    const actionQuote = 'Open the Scheduling panel.';
    const assertionQuote = 'Verify Early Pickup Date/Time is before Late Pickup Date/Time.';
    const source = `${actionQuote} ${assertionQuote}`;
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'open-scheduling', type: 'Click', sourceQuote: actionQuote,
          target: { kind: 'region', label: 'Scheduling panel', role: 'region' },
        }],
        assertions: [{
          key: 'pickup-order', type: 'AssertTemporal', sourceQuote: assertionQuote,
          target: { kind: 'collection', label: 'Pickup boundaries' }, comparator: 'before',
          operands: [
            { role: 'actual', kind: 'temporal_reference', name: 'Early Pickup Date/Time', ref: 'Early Pickup Date/Time' },
            { role: 'expected', kind: 'temporal_reference', name: 'Late Pickup Date/Time', ref: 'Late Pickup Date/Time' },
          ],
          payload: { channel: 'text', operands: [] }, stepRef: 'open-scheduling',
        }],
      })],
    };

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    const assertion = envelope.cases[0].assertions[0];

    expect(validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 }))
      .toMatchObject({ ok: true, findings: [] });
    expect(assertion.payload).toEqual({
      channel: 'temporal',
      operands: [
        { role: 'actual', kind: 'temporal_reference', name: 'Early Pickup Date/Time', ref: 'Early Pickup Date/Time' },
        { role: 'expected', kind: 'temporal_reference', name: 'Late Pickup Date/Time', ref: 'Late Pickup Date/Time' },
      ],
    });
  });

  it('canonicalizes one authored DateTime with an explicit timezone as formatting only', () => {
    const actionQuote = 'Open the Scheduling panel.';
    const assertionQuote = 'Verify the scheduled timestamp equals August 20, 2026 at 9:00 AM UTC.';
    const source = `${actionQuote} ${assertionQuote}`;
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'open-scheduling', type: 'Click', sourceQuote: actionQuote,
          target: { kind: 'region', label: 'Scheduling panel', role: 'region' },
        }],
        assertions: [{
          key: 'scheduled-timestamp', type: 'AssertDateTime', sourceQuote: assertionQuote,
          target: { kind: 'field', label: 'scheduled timestamp', role: 'textbox' },
          comparator: 'equals', expected: 'August 20, 2026 at 9:00 AM UTC',
          payload: { channel: 'text', operands: [] }, stepRef: 'open-scheduling',
        }],
      })],
    };

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source });
    const assertion = envelope.cases[0].assertions[0];

    expect(validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 }))
      .toMatchObject({ ok: true, findings: [] });
    expect(assertion).toMatchObject({
      comparator: 'equals',
      payload: {
        channel: 'temporal',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'value' },
          { role: 'expected', kind: 'temporal', temporalType: 'datetime', value: '2026-08-20T09:00Z' },
        ],
      },
    });
  });

  it('projects complete exact ledger claims into per-record clauses without leaking compiler authority', () => {
    const source = [
      'Scenario:',
      'Order Reference = ABC-42',
      'Click Continue.',
      'Verify Ready is visible.',
    ].join('\n');
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [{
          key: 'continue', type: 'Click', sourceQuote: 'Click Continue.',
          target: { kind: 'control', label: 'Continue', role: 'button' },
        }],
        assertions: [visibleAssertion('Verify Ready is visible.', {
          key: 'ready', stepRef: 'continue', target: { kind: 'region', label: 'Ready', role: 'status' },
        })],
      })],
    };
    const authority = exactLedgerAuthority(source, (ledger) => [
      exactClaim(source, ledger.units[0], 'metadata', 'scenario'),
      exactClaim(source, ledger.units[1], 'data', 'order-reference'),
      exactClaim(source, ledger.units[2], 'action', 'continue'),
      exactClaim(source, ledger.units[3], 'assertion', 'ready'),
    ]);
    expect(authority.sourceCompleteness).toMatchObject({ valid: true, complete: true, findings: [] });

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source, ...authority });
    const [projectedCase] = envelope.cases;
    const actionClause = envelope.sourceClauses.find((clause) => clause.disposition === 'action');
    const assertionClause = envelope.sourceClauses.find((clause) => clause.disposition === 'assertion');

    expect(envelope.sourceClauses).toHaveLength(4);
    expect(projectedCase.steps[0].sourceClauseRefs).toEqual([actionClause.id]);
    expect(projectedCase.assertions[0].sourceClauseRefs).toEqual([assertionClause.id]);
    expect(projectedCase.metadata).toHaveLength(1);
    expect(projectedCase.dataBindings).toHaveLength(1);
    expect(envelope.sourceCoverage.map((entry) => entry.disposition)).toEqual(['metadata', 'data', 'action', 'assertion']);
    expect(envelope).not.toHaveProperty('sourceLedgerV1');
    expect(envelope).not.toHaveProperty('sourceClaims');
    expect(envelope).not.toHaveProperty('sourceCompleteness');
    expect(validator.validateSemanticCaseContract(envelope, { sourceText: source, maxSteps: 100 }))
      .toMatchObject({ ok: true, findings: [] });
  });

  it('rejects a missing unique middle instruction even when the ledger report itself is complete', () => {
    const source = [
      'Click Alpha.',
      'Click the unique middle control.',
      'Click Omega.',
      'Verify Ready is visible.',
    ].join('\n');
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [
          { key: 'alpha', type: 'Click', sourceQuote: 'Click Alpha.', target: { kind: 'control', label: 'Alpha', role: 'button' } },
          { key: 'omega', type: 'Click', sourceQuote: 'Click Omega.', target: { kind: 'control', label: 'Omega', role: 'button' } },
        ],
        assertions: [visibleAssertion('Verify Ready is visible.', { key: 'ready', stepRef: 'omega' })],
      })],
    };
    const authority = exactLedgerAuthority(source, (ledger) => [
      exactClaim(source, ledger.units[0], 'action', 'alpha'),
      exactClaim(source, ledger.units[1], 'action', 'middle-record-not-emitted'),
      exactClaim(source, ledger.units[2], 'action', 'omega'),
      exactClaim(source, ledger.units[3], 'assertion', 'ready'),
    ]);
    expect(authority.sourceCompleteness.complete).toBe(true);

    const error = projectionError(() => projector.projectSemanticPlan(plan, { sourceText: source, ...authority }));
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'source_claim_record_unknown' }),
    ]));
  });

  it('projects one compound ledger unit into separate atomic action and assertion records', () => {
    const source = 'Open the Priority dropdown, select High, and verify High is selected.';
    const open = 'Open the Priority dropdown,';
    const select = ' select High,';
    const verify = ' and verify High is selected.';
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [
          { key: 'open-priority', type: 'Click', sourceQuote: open, target: { kind: 'field', label: 'Priority', role: 'combobox' } },
          {
            key: 'select-high', type: 'Select', sourceQuote: select,
            target: { kind: 'field', label: 'Priority', role: 'combobox' },
            selectionCriteria: { kind: 'exact_text', text: 'High' }, dependsOn: ['open-priority'],
          },
        ],
        assertions: [{
          key: 'high-selected', type: 'AssertSelected', comparator: 'selected', sourceQuote: verify,
          target: { kind: 'option', label: 'High', role: 'option' }, stepRef: 'select-high',
        }],
      })],
    };
    const authority = exactLedgerAuthority(source, (ledger) => {
      const unit = ledger.units[0];
      return [
        exactClaim(source, unit, 'action', 'open-priority', 0, open.length),
        exactClaim(source, unit, 'action', 'select-high', open.length, open.length + select.length),
        exactClaim(source, unit, 'assertion', 'high-selected', open.length + select.length, source.length),
      ];
    });
    expect(authority.sourceCompleteness).toMatchObject({ valid: true, complete: true });

    const envelope = projector.projectSemanticPlan(plan, { sourceText: source, ...authority });
    expect(envelope.sourceClauses).toHaveLength(3);
    expect(envelope.cases[0].steps).toHaveLength(2);
    expect(envelope.cases[0].assertions).toHaveLength(1);
    expect(new Set(envelope.sourceCoverage.map((entry) => entry.refId)).size).toBe(3);
  });

  it('keeps repeated identical units linked to their explicit transient records', () => {
    const source = ['Click Refresh.', 'Click Refresh.', 'Verify Ready is visible.'].join('\n');
    const plan = {
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [
          { key: 'refresh-1', type: 'Click', sourceQuote: 'Click Refresh.', target: { kind: 'control', label: 'Refresh', role: 'button' } },
          { key: 'refresh-2', type: 'Click', sourceQuote: 'Click Refresh.', target: { kind: 'control', label: 'Refresh', role: 'button' }, dependsOn: ['refresh-1'] },
        ],
        assertions: [visibleAssertion('Verify Ready is visible.', { key: 'ready', stepRef: 'refresh-2' })],
      })],
    };
    const authority = exactLedgerAuthority(source, (ledger) => [
      exactClaim(source, ledger.units[0], 'action', 'refresh-1'),
      exactClaim(source, ledger.units[1], 'action', 'refresh-2'),
      exactClaim(source, ledger.units[2], 'assertion', 'ready'),
    ]);
    const envelope = projector.projectSemanticPlan(plan, { sourceText: source, ...authority });
    const [first, second] = envelope.cases[0].steps;

    expect(first.sourceSpan).not.toEqual(second.sourceSpan);
    expect(first.sourceClauseRefs).not.toEqual(second.sourceClauseRefs);
    expect(envelope.sourceCoverage.slice(0, 2).map((entry) => entry.refId)).toEqual([first.id, second.id]);
  });

  it('rejects wrong-kind, conflicting, and unresolved ledger authorities', () => {
    const source = ['Click Continue.', 'Click Cancel.', 'Verify Ready is visible.'].join('\n');
    const makePlan = () => ({
      version: 'AddScenarioSemanticPlanV1',
      cases: [baseCase({
        actions: [
          { key: 'continue', type: 'Click', sourceQuote: 'Click Continue.', target: { kind: 'control', label: 'Continue', role: 'button' } },
          { key: 'cancel', type: 'Click', sourceQuote: 'Click Cancel.', target: { kind: 'control', label: 'Cancel', role: 'button' } },
        ],
        assertions: [visibleAssertion('Verify Ready is visible.', { key: 'ready', stepRef: 'cancel' })],
      })],
    });
    const wrongKind = exactLedgerAuthority(source, (ledger) => [
      exactClaim(source, ledger.units[0], 'assertion', 'continue'),
      exactClaim(source, ledger.units[1], 'action', 'cancel'),
      exactClaim(source, ledger.units[2], 'action', 'ready'),
    ]);
    const wrongKindError = projectionError(() => projector.projectSemanticPlan(makePlan(), { sourceText: source, ...wrongKind }));
    expect(wrongKindError.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'source_claim_record_kind_mismatch' }),
    ]));

    const conflict = exactLedgerAuthority(source, (ledger) => [
      exactClaim(source, ledger.units[0], 'action', 'continue'),
      exactClaim(source, ledger.units[1], 'action', 'continue'),
      exactClaim(source, ledger.units[2], 'assertion', 'ready'),
    ]);
    const conflictError = projectionError(() => projector.projectSemanticPlan(makePlan(), { sourceText: source, ...conflict }));
    expect(conflictError.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'source_claim_record_conflict' }),
      expect.objectContaining({ code: 'source_claim_executable_omitted' }),
    ]));

    const unresolved = exactLedgerAuthority(source, (ledger) => [
      exactClaim(source, ledger.units[0], 'action', 'continue'),
      exactClaim(source, ledger.units[1], 'action', 'cancel'),
      exactClaim(source, ledger.units[2], 'unresolved', 'ready'),
    ]);
    expect(unresolved.sourceCompleteness).toMatchObject({ valid: true, complete: false });
    const unresolvedError = projectionError(() => projector.projectSemanticPlan(makePlan(), { sourceText: source, ...unresolved }));
    expect(unresolvedError.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'source_completeness_invalid' }),
      expect.objectContaining({ code: 'source_claim_unresolved' }),
    ]));
  });
});
