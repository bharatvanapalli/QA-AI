import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const planner = require('../../server/services/addScenarioSemanticPlanner');
const semanticValidator = require('../../server/services/caseContractSemanticValidator');
const { buildSourceLedger } = require('../../server/services/addScenarioSourceLedger');

const PREDECESSOR_CASE_ID = 'case-authenticated-dashboard';

const target = (kind, label, role, scope) => ({
  kind, label, role, ...(scope ? { scope } : {}),
});

const action = (type, sourceQuote, targetIdentity, extras = {}) => ({
  type, sourceQuote, target: targetIdentity, ...extras,
});

const assertion = (type, sourceQuote, targetIdentity, extras = {}) => ({
  type, sourceQuote, target: targetIdentity, nonBlocking: false, ...extras,
});

function attachSourceClaims(source, plan) {
  const ledger = buildSourceLedger(source);
  const claimedUnits = new Set();
  const claims = [];
  const takeUnit = (quote) => {
    const unit = ledger.units.find((candidate) => (
      !claimedUnits.has(candidate.id)
      && source.slice(candidate.sourceSpan.start, candidate.sourceSpan.end) === quote
    ));
    if (!unit) throw new Error(`Complex acceptance sourceQuote did not resolve uniquely: ${quote}`);
    claimedUnits.add(unit.id);
    return unit;
  };

  plan.cases.forEach((caseIntent, caseIndex) => {
    caseIntent.actions.forEach((record, recordIndex) => {
      const unit = takeUnit(record.sourceQuote);
      if (record.condition) {
        claims.push({
          unitRef: unit.id,
          disposition: 'condition',
          sourceQuote: record.condition,
          caseIndex,
          recordKind: 'action',
          recordIndex,
        });
      }
      claims.push({
        unitRef: unit.id,
        disposition: 'action',
        sourceQuote: record.condition
          ? record.sourceQuote.slice(record.condition.length)
          : record.sourceQuote,
        caseIndex,
        recordKind: 'action',
        recordIndex,
      });
    });
    caseIntent.assertions.forEach((record, recordIndex) => {
      const unit = takeUnit(record.sourceQuote);
      claims.push({
        unitRef: unit.id,
        disposition: 'assertion',
        sourceQuote: record.sourceQuote,
        caseIndex,
        recordKind: 'assertion',
        recordIndex,
      });
    });
  });

  ledger.units.forEach((unit) => {
    if (claimedUnits.has(unit.id)) return;
    claims.push({
      unitRef: unit.id,
      disposition: 'metadata',
      sourceQuote: source.slice(unit.sourceSpan.start, unit.sourceSpan.end),
    });
  });
  plan.sourceClaims = claims;
}

function complexFixture() {
  const ordersPage = 'Orders page';
  const form = 'Create New Order form';
  const general = 'General Information section';
  const planning = 'Planning Date/Time section';
  const actions = [
    action('Click', 'Click the Orders control in the navigation menu.', target('control', 'Orders', 'button', 'navigation menu')),
    action('WaitForState', 'Wait for the Orders page to become stable.', target('page', 'Orders page', 'document')),
    action('Click', 'Click the Create Order control.', target('control', 'Create Order', 'button', ordersPage)),
    action('WaitForState', 'Wait for the Create New Order form to become stable.', target('page', 'Create New Order form', 'document')),
    action('Fill', 'Enter 007995145 in the Order Number field.', target('field', 'Order Number', 'textbox', general), { value: '007995145' }),
    action('Fill', 'Enter SIGROUP in the Owning Organization field.', target('field', 'Owning Organization', 'combobox', general), { value: 'SIGROUP' }),
    action('WaitForState', 'Wait for the Owning Organization suggestion list to become visible and stable.', target('collection', 'Owning Organization suggestions', 'listbox', general)),
    action('Select', 'Select the second Owning Organization suggestion, *SIGROUP-EUR SOURCE SYSTEM 01.', target('field', 'Owning Organization', 'combobox', general), {
      selection: { kind: 'ordinal', ordinal: 2, text: '*SIGROUP-EUR SOURCE SYSTEM 01' },
    }),
    action('Click', 'Open the Equipment dropdown.', target('field', 'Equipment', 'combobox', general)),
    action('WaitForState', 'Wait for the Equipment option list to become visible and stable.', target('collection', 'Equipment options', 'listbox', general)),
    action('Select', 'Select LTL from the Equipment dropdown.', target('field', 'Equipment', 'combobox', general), { selection: { kind: 'exact_text', text: 'LTL' } }),
    action('Click', 'Open the Ship Direction dropdown.', target('field', 'Ship Direction', 'combobox', general)),
    action('WaitForState', 'Wait for the Ship Direction options to become visible.', target('collection', 'Ship Direction options', 'listbox', general)),
    action('Select', 'Select Inbound from the Ship Direction dropdown.', target('field', 'Ship Direction', 'combobox', general), { selection: { kind: 'exact_text', text: 'Inbound' } }),
    action('Click', 'Open the Freight Term dropdown.', target('field', 'Freight Term', 'combobox', general)),
    action('WaitForState', 'Wait for the Freight Term options to become visible and stable.', target('collection', 'Freight Term options', 'listbox', general)),
    action('Select', 'Select Collect from the Freight Term dropdown.', target('field', 'Freight Term', 'combobox', general), { selection: { kind: 'exact_text', text: 'Collect' } }),
    action('Scroll', 'Scroll the References section into view.', target('region', 'References section', 'region', form)),
    action('Fill', 'Enter 7995145776 in the Pickup Number field.', target('field', 'Pickup Number', 'textbox', 'References section'), { value: '7995145776' }),
    action('Scroll', 'Scroll the Pickup and Delivery section into view.', target('region', 'Pickup and Delivery section', 'region', form)),
    action('Expand', 'If the Pickup and Delivery section is collapsed, expand it.', target('region', 'Pickup and Delivery section', 'region', form)),
    action('Scroll', 'Scroll the Planning Date/Time section into view.', target('region', 'Planning Date/Time section', 'region', 'Pickup and Delivery section')),
    action('Radio', 'Select Ship Date & Time if it is not already selected.', target('field', 'Ship Date & Time', 'radio', planning)),
  ];

  const schedule = [
    ['Early Pickup', 'August 20, 2026', '09:00 AM'],
    ['Late Pickup', 'August 20, 2026', '11:00 AM'],
    ['Early Delivery', 'August 21, 2026', '01:00 PM'],
    ['Late Delivery', 'August 21, 2026', '03:00 PM'],
  ];
  for (const [name, date, time] of schedule) {
    actions.push(
      action('Click', `Open the ${name} Date calendar.`, target('field', `${name} Date`, 'textbox', planning)),
      action('Date', `Select ${date} in the ${name} Date calendar.`, target('field', `${name} Date`, 'textbox', planning), { value: date }),
      action('Click', `Open the ${name} Time dropdown.`, target('field', `${name} Time`, 'combobox', planning)),
      action('Select', `Select ${time} from the ${name} Time dropdown.`, target('field', `${name} Time`, 'combobox', planning), { selection: { kind: 'exact_text', text: time } }),
      action('Click', `Open the ${name} Time Zone dropdown.`, target('field', `${name} Time Zone`, 'combobox', planning)),
      action('Select', `Select an option whose visible label contains Central from the ${name} Time Zone dropdown.`, target('field', `${name} Time Zone`, 'combobox', planning), { selection: { kind: 'predicate', predicate: 'visible label contains Central' } }),
    );
  }

  const assertions = [
    assertion('AssertVisible', 'Verify the Orders page is displayed.', target('page', 'Orders page', 'document')),
    assertion('AssertEnabled', 'Verify the Create Order control is enabled.', target('control', 'Create Order', 'button', ordersPage)),
    assertion('AssertVisible', 'Verify the Create New Order heading is visible.', target('region', 'Create New Order heading', 'heading', form)),
    assertion('AssertVisible', 'Verify the General Information section is visible.', target('region', 'General Information section', 'region', form)),
    assertion('AssertValue', 'Verify the Order Number equals 007995145.', target('field', 'Order Number', 'textbox', general), { expected: '007995145', relation: 'equals' }),
    assertion('AssertCollection', 'Verify the Owning Organization suggestions are exactly *SIGROUP SOURCE SYSTEM 01 then *SIGROUP-EUR SOURCE SYSTEM 01.', target('collection', 'Owning Organization suggestions', 'listbox', general), { expected: ['*SIGROUP SOURCE SYSTEM 01', '*SIGROUP-EUR SOURCE SYSTEM 01'], relation: 'exact_order' }),
    assertion('AssertValue', 'Verify the Owning Organization equals *SIGROUP-EUR SOURCE SYSTEM 01.', target('field', 'Owning Organization', 'combobox', general), { expected: '*SIGROUP-EUR SOURCE SYSTEM 01', relation: 'equals' }),
    assertion('AssertCollection', 'Verify the Equipment options are exactly RR, LCL, LTL, TL, FCL in that order.', target('collection', 'Equipment options', 'listbox', general), { expected: ['RR', 'LCL', 'LTL', 'TL', 'FCL'], relation: 'exact_order' }),
    assertion('AssertValue', 'Verify the Equipment field equals LTL.', target('field', 'Equipment', 'combobox', general), { expected: 'LTL', relation: 'equals' }),
    assertion('AssertCollection', 'Verify the Ship Direction options contain Outbound and Inbound.', target('collection', 'Ship Direction options', 'listbox', general), { expected: ['Outbound', 'Inbound'], relation: 'contains_all' }),
    assertion('AssertValue', 'Verify the Ship Direction field equals Inbound.', target('field', 'Ship Direction', 'combobox', general), { expected: 'Inbound', relation: 'equals' }),
    assertion('AssertValue', 'Verify the Freight Term field automatically equals COL; record a functional failure and continue if it does not.', target('field', 'Freight Term', 'combobox', general), { expected: 'COL', relation: 'equals', nonBlocking: true }),
    assertion('AssertCollection', 'Verify the Freight Term options contain Pre-Paid, Collect, Pre-Paid/Add, Third Party, No Charge, and COL.', target('collection', 'Freight Term options', 'listbox', general), { expected: ['Pre-Paid', 'Collect', 'Pre-Paid/Add', 'Third Party', 'No Charge', 'COL'], relation: 'contains_all' }),
    assertion('AssertValue', 'Verify the Freight Term field equals Collect.', target('field', 'Freight Term', 'combobox', general), { expected: 'Collect', relation: 'equals' }),
    assertion('AssertValue', 'Verify the Pickup Number equals 7995145776.', target('field', 'Pickup Number', 'textbox', 'References section'), { expected: '7995145776', relation: 'equals' }),
    assertion('AssertVisible', 'Verify the References section is visible.', target('region', 'References section', 'region', form)),
    assertion('AssertVisible', 'Verify the Planning Date/Time section is visible.', target('region', 'Planning Date/Time section', 'region', 'Pickup and Delivery section')),
    assertion('AssertSelected', 'Verify the Ship Date & Time option is selected.', target('field', 'Ship Date & Time', 'radio', planning)),
  ];

  for (const [name, date, time] of schedule) {
    assertions.push(
      assertion('AssertDate', `Verify the ${name} Date equals ${date}.`, target('field', `${name} Date`, 'textbox', planning), { expected: date, relation: 'equals' }),
      assertion('AssertText', `Verify the ${name} Time equals ${time}.`, target('field', `${name} Time`, 'combobox', planning), { expected: time, relation: 'equals' }),
      assertion('AssertText', `Verify the ${name} Time Zone contains Central.`, target('field', `${name} Time Zone`, 'combobox', planning), { expected: 'Central', relation: 'contains' }),
    );
  }

  for (const [left, right] of [
    ['Early Pickup Date/Time', 'Late Pickup Date/Time'],
    ['Late Pickup Date/Time', 'Early Delivery Date/Time'],
    ['Early Delivery Date/Time', 'Late Delivery Date/Time'],
  ]) {
    assertions.push(assertion(
      'AssertTemporal',
      `Verify ${left} is before ${right}.`,
      target('collection', 'Planning Date/Time boundaries', 'group', planning),
      { comparison: { left, relation: 'before', right, temporalType: 'datetime' } },
    ));
  }
  assertions.push(assertion(
    'AssertHidden',
    'Verify no required-field validation message is displayed for the completed Planning Date/Time fields.',
    target('collection', 'required-field validation messages', 'alert', planning),
  ));

  expect(actions).toHaveLength(47);
  expect(assertions).toHaveLength(34);
  const source = [...actions, ...assertions].map((entry) => entry.sourceQuote).join(' ');
  return {
    source,
    plan: {
      version: 'SemanticIntentPlanV1',
      unresolvedQuestions: [],
      cases: [{
        name: 'Create an order and validate complex controls',
        intent: 'Continue from the authenticated dashboard and validate the complete order form flow.',
        initialState: 'The authenticated dashboard is available.',
        expectedFinalState: 'The order form remains populated and independently validated.',
        continuationIntent: {
          mode: 'continue',
          predecessorCaseId: PREDECESSOR_CASE_ID,
          sameSession: true,
          reason: 'Continue in the authenticated dashboard session required by this authored flow.',
        },
        actions,
        assertions,
      }],
    },
  };
}

describe('Add Scenario complex semantic acceptance', () => {
  it('compiles 81 source-grounded operations in one bounded model call and passes the strict route validator', async () => {
    const { source, plan } = complexFixture();
    attachSourceClaims(source, plan);
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(plan) }],
        stop_reason: 'end_turn',
      }),
    };
    const startedAt = Date.now();
    const result = await planner.run({
      rawSource: source,
      provider,
      model: 'recorded-acceptance',
      continuationContext: {
        requested: true,
        predecessorCaseId: PREDECESSOR_CASE_ID,
        currentGenerationId: 'generation-current',
      },
      currentCases: [{ id: PREDECESSOR_CASE_ID }],
    }, {
      provider,
      validator: (draft, context) => {
        const validation = semanticValidator.validateSemanticCaseContract(draft, {
          sourceText: context.sourceText,
          maxSteps: 100,
        });
        return { ok: validation.ok, envelope: validation.contract, findings: validation.findings };
      },
    });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result.metadata).toMatchObject({ attempts: 1, providerCallLimit: 1, repairCalls: 0 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.caseContractV1).not.toBeNull();
    const contract = result.caseContractV1;
    expect(contract.cases).toHaveLength(1);
    const [compiledCase] = contract.cases;
    expect(compiledCase.steps).toHaveLength(47);
    expect(compiledCase.assertions).toHaveLength(34);
    expect(compiledCase.steps.length + compiledCase.assertions.length).toBe(81);
    expect(compiledCase.steps.find((step) => step.targetIdentity.label === 'Order Number')).toMatchObject({ type: 'Fill', value: '007995145' });
    expect(compiledCase.steps.find((step) => step.targetIdentity.label === 'Owning Organization' && step.type === 'Fill')).toMatchObject({ value: 'SIGROUP' });
    expect(compiledCase.steps.find((step) => step.targetIdentity.label === 'Pickup Number')).toMatchObject({ value: '7995145776' });
    expect(compiledCase.steps.filter((step) => step.type === 'Date').map((step) => step.value))
      .toEqual(['2026-08-20', '2026-08-20', '2026-08-21', '2026-08-21']);
    expect(compiledCase.assertions.filter((check) => check.type === 'AssertTemporal')).toHaveLength(3);
    expect(compiledCase.assertions.at(-1)).toMatchObject({ type: 'AssertHidden', comparator: 'hidden' });
    expect(JSON.stringify(contract)).not.toContain('{{');
    expect(semanticValidator.validateSemanticCaseContract(contract, { sourceText: source, maxSteps: 100 }))
      .toMatchObject({ ok: true, findings: [] });
  });
});
