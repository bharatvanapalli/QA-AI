import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const bridge = require('../../server/services/caseContractPlanningBridge');
const compiler = require('../../server/services/testDesignStepCompiler');

function sourceEvidence(quote, start = 0) {
  return {
    sourceQuote: quote,
    sourceSpan: { start, end: start + quote.length },
    sourceClauseRefs: ['clause-1'],
  };
}

describe('Add Scenario structured semantic projection', () => {
  it('preserves authored targets, values, selections, operands, and evidence without reparsing prose', () => {
    const fill = {
      id: 'step-fill',
      ordinal: 1,
      type: 'Fill',
      text: 'Put the uppercase value into it and continue.',
      targetIdentity: { kind: 'control', label: 'Owning organization', role: 'combobox', scope: 'General information' },
      value: 'NORTHSTAR',
      dataRefs: [],
      dependsOn: [],
      flowImpact: 'state_change',
      failureBehavior: 'stop_descendants',
      ...sourceEvidence('enter NORTHSTAR into Owning organization'),
    };
    const select = {
      id: 'step-select',
      ordinal: 2,
      type: 'Select',
      text: 'Choose the second result.',
      targetIdentity: { kind: 'option', label: 'Northstar Europe', role: 'option', scope: 'Owning organization suggestions' },
      selectionCriteria: { kind: 'ordinal', ordinal: 2, expectedLabel: 'Northstar Europe' },
      dataRefs: [],
      dependsOn: ['step-fill'],
      flowImpact: 'state_change',
      failureBehavior: 'stop_descendants',
      ...sourceEvidence('choose the second result', 41),
    };
    const assertions = [
      {
        id: 'assert-options',
        ordinal: 1,
        type: 'CollectionOrder',
        text: 'Verify the listed choices in order.',
        targetIdentity: { kind: 'collection', label: 'Equipment options', role: 'listbox', scope: 'Equipment' },
        comparator: 'exact_order',
        payload: {
          channel: 'collection',
          operands: [
            { role: 'actual', kind: 'collection', ref: 'Equipment options' },
            { role: 'expected', kind: 'collection', items: ['Rail', 'Parcel', 'Freight'] },
          ],
        },
        dataRefs: [],
        stepId: 'step-select',
        required: true,
        failureBehavior: 'continue',
        ...sourceEvidence('verify Rail, Parcel, Freight in this order', 66),
      },
      {
        id: 'assert-chronology',
        ordinal: 2,
        type: 'TemporalComparison',
        text: 'Verify the first appointment is before the second.',
        comparator: 'before',
        payload: {
          channel: 'temporal',
          operands: [
            { role: 'actual', kind: 'field_ref', ref: 'First appointment' },
            { role: 'comparison', kind: 'field_ref', ref: 'Second appointment' },
          ],
        },
        dataRefs: [],
        stepId: null,
        required: true,
        failureBehavior: 'continue',
        ...sourceEvidence('first appointment is before the second', 108),
      },
    ];
    const caseContract = {
      version: 'CaseContractV1',
      id: 'case-structured',
      name: 'Structured controls',
      intent: 'Exercise structured controls',
      initialState: { description: 'Authenticated workspace' },
      expectedFinalState: { description: 'Form remains populated' },
      sessionRequirement: { mode: 'continue_from_case', dependsOnCaseRefs: ['case-auth'], producesAuthenticatedState: false },
      dataBindings: [],
      dataRows: [],
      steps: [fill, select],
      assertions,
      unusedDataRefs: [],
    };
    const envelope = {
      version: 'CaseContractV1',
      source: { requirementIds: ['req-1'], digest: 'sha256-test' },
      partitioning: { caseCount: 1, dataRowsDoNotCreateCases: true },
      cases: [caseContract],
    };

    const bridged = bridge.buildCaseContractPlanningBridge({
      caseContractV1: envelope,
      coverageManifest: { version: 1, items: [] },
      caseContractPacks: [],
    });
    const pack = bridged.caseContractPacks[0];
    expect(pack.requiredActionSteps[0]).toMatchObject({
      targetIdentity: fill.targetIdentity,
      value: 'NORTHSTAR',
      sourceClauseRefs: ['clause-1'],
    });
    expect(pack.requiredActionSteps[1]).toMatchObject({
      targetIdentity: select.targetIdentity,
      selectionCriteria: select.selectionCriteria,
      dependsOn: ['step-fill'],
    });
    expect(pack.requiredOracles[0]).toMatchObject({
      kind: 'collection',
      target: 'Equipment options',
      expected: ['Rail', 'Parcel', 'Freight'],
      comparator: 'exact_order',
      payload: assertions[0].payload,
      sourceClauseRefs: ['clause-1'],
    });
    expect(pack.requiredOracles[1]).toMatchObject({
      kind: 'temporal',
      expected: null,
      comparator: 'before',
      payload: assertions[1].payload,
    });
    expect(pack.requiredOracles[1].expected).not.toBe(assertions[1].text);

    const projected = compiler._private.compileSteps({
      steps: [
        { type: 'Fill', target: 'capital letters, into the wrong field', value: 'WRONG' },
        { type: 'Select', target: 'the result', value: 'WRONG' },
      ],
    }, {
      planCaseId: 'plan-case-1',
      caseContractV1: caseContract,
    });
    expect(projected[0]).toMatchObject({
      target: 'Owning organization',
      element: 'Owning organization',
      targetIdentity: fill.targetIdentity,
      value: 'NORTHSTAR',
      sourceQuote: fill.sourceQuote,
      sourceSpan: fill.sourceSpan,
      sourceClauseRefs: ['clause-1'],
    });
    expect(projected[1]).toMatchObject({
      target: 'Northstar Europe',
      selectionCriteria: select.selectionCriteria,
      dependsOn: ['step-fill'],
      failureBehavior: 'stop_descendants',
    });
  });
});
