import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const compiler = require('../../server/services/testDesignStepCompiler');

function findingsFor(steps) {
  const findings = [];
  compiler._private.validateCompiledStepSemantics(
    { planCaseId: 'plan-case-semantic-gate', steps },
    { planCaseId: 'plan-case-semantic-gate' },
    findings,
  );
  return findings;
}

describe('TestDesignStepCompiler executable semantic gate', () => {
  it('preserves compiler-owned ISO dates and advanced-control metadata during projection', () => {
    const compiled = compiler._private.compileSteps(
      {
        steps: [
          { action: 'Date', text: 'Select August 20, 2026', target: 'Early Pickup Date' },
          { action: 'Scroll', text: 'Scroll the Details section into view', target: 'Details section' },
          { action: 'Radio', text: 'Select Ship Date and Time', target: 'Ship Date and Time' },
          { action: 'Expand', text: 'Ensure Details is expanded', target: 'Details' },
        ],
      },
      {
        planCaseId: 'plan-case-control-projection',
        caseContractV1: {
          steps: [
            {
              id: 'date', ordinal: 1, type: 'Date', action: 'Date',
              text: 'Open the Early Pickup Date calendar and select August 20, 2026.',
              target: 'Early Pickup Date', value: '2026-08-20', controlKind: 'calendar',
            },
            {
              id: 'scroll', ordinal: 2, type: 'Scroll', action: 'Scroll',
              text: 'Scroll the Details section into view.', target: 'Details section',
              scrollMode: 'target', visibilityThreshold: 0.5,
            },
            {
              id: 'radio', ordinal: 3, type: 'Radio', action: 'Radio',
              text: 'Select Ship Date and Time.', target: 'Ship Date and Time',
              value: true, checked: true, idempotent: true,
            },
            {
              id: 'expand', ordinal: 4, type: 'Expand', action: 'Expand',
              text: 'Ensure Details is expanded.', target: 'Details',
              idempotent: true, expectedState: { property: 'expanded', equals: true },
            },
          ],
        },
      },
    );

    expect(compiled[0]).toMatchObject({ action: 'Date', value: '2026-08-20', controlKind: 'calendar' });
    expect(compiled[1]).toMatchObject({ action: 'Scroll', scrollMode: 'target', visibilityThreshold: 0.5 });
    expect(compiled[2]).toMatchObject({ action: 'Radio', value: true, checked: true, idempotent: true });
    expect(compiled[3]).toMatchObject({
      action: 'Expand',
      idempotent: true,
      expectedState: { property: 'expanded', equals: true },
    });
    expect(findingsFor(compiled)).toEqual([]);
  });

  it('projects WaitForState as non-verdict utility metadata on the next executable operation', () => {
    const compiled = compiler._private.compileSteps(
      {
        steps: [
          { action: 'WaitForState', text: 'Wait until the destination page is ready', target: 'destination page' },
          { action: 'Click', text: 'Click Continue', target: 'Continue button' },
        ],
      },
      {
        planCaseId: 'plan-case-wait-utility',
        caseContractV1: {
          steps: [
            {
              id: 'wait-ready', ordinal: 1, type: 'WaitForState', action: 'WaitForState',
              text: 'Wait until the destination page is ready.', target: 'destination page',
              sourceQuote: 'Wait until the destination page is ready.', sourceClauseRefs: ['clause-ready'],
            },
            {
              id: 'click-continue', ordinal: 2, type: 'Click', action: 'Click',
              text: 'Click Continue.', target: 'Continue button',
            },
          ],
        },
      },
    );

    expect(compiled[0]).toMatchObject({
      id: 'wait-ready',
      runtimeUtility: true,
      executionRole: 'synchronization',
      emitsStepVerdict: false,
      verdictPolicy: 'none',
      attachedToStepId: 'click-continue',
    });
    expect(compiled[1].preconditionWaitUtilities).toHaveLength(1);
    expect(compiled[1].preconditionWaitUtilities[0]).toMatchObject({
      waitStepId: 'wait-ready',
      sourceClauseRefs: ['clause-ready'],
      emitsStepVerdict: false,
    });
  });

  it('rejects compound assertions, imperative waits, inverted visibility, slash fragments, and invalid advanced controls', () => {
    const findings = findingsFor([
      {
        id: 'compound-assertion', ordinal: 1, action: 'AssertText',
        text: 'Open the Status dropdown, select Ready, and verify the selected value', expected: 'Ready',
      },
      {
        id: 'imperative-wait', ordinal: 2, action: 'WaitForState',
        text: 'Open the Status dropdown and wait until its options are visible',
      },
      {
        id: 'negative-visible', ordinal: 3, action: 'AssertVisible',
        text: 'Verify no required-field validation message is displayed',
      },
      {
        id: 'slash-fragment', ordinal: 4, action: 'AssertText',
        text: 'Verify the list contains Pre-Paid/Add', expected: '/Add',
      },
      {
        id: 'ambiguous-date', ordinal: 5, action: 'Date', target: 'Due date',
        text: 'Select 08/20/2026 in the Due date calendar', value: '08/20/2026',
      },
    ]);

    expect(findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'test_design_compound_assertion_action',
      'test_design_imperative_wait_action',
      'test_design_negative_visibility_channel',
      'test_design_embedded_path_fragment',
      'test_design_control_action_contract_invalid',
    ]));
    expect(findings.every((finding) => finding.stage === 'compiled_step_semantics')).toBe(true);
  });

  it('accepts ordered atomic actions and exact website-neutral control contracts', () => {
    const findings = findingsFor([
      { id: 'open', ordinal: 1, action: 'Click', text: 'Open the Status dropdown', target: 'Status dropdown' },
      { id: 'select', ordinal: 2, action: 'Select', text: 'Select Ready', target: 'Status', value: 'Ready' },
      { id: 'assert', ordinal: 3, action: 'AssertText', text: 'Verify the selected Status is Ready', expected: 'Ready' },
      { id: 'hidden', ordinal: 4, action: 'AssertHidden', text: 'Verify no validation message is displayed', target: 'validation message' },
      { id: 'scroll', ordinal: 5, action: 'Scroll', text: 'Scroll the Details section into view', target: 'Details section', scrollMode: 'target' },
      { id: 'date', ordinal: 6, action: 'Date', text: 'Select the Due date', target: 'Due date', value: '2026-08-20' },
      { id: 'radio', ordinal: 7, action: 'Radio', text: 'Select Ship date', target: 'Ship date' },
      { id: 'expand', ordinal: 8, action: 'Expand', text: 'Ensure Details is expanded', target: 'Details' },
    ]);

    expect(findings).toEqual([]);
  });
});
