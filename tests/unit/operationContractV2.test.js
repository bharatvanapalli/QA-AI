import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const operationContract = require('../../server/services/operationContractV2');

describe('OperationContractV2', () => {
  it('separates action identity from assertion step references', () => {
    const compiled = operationContract.compileOperationContractV2({
      id: 'login-case',
      steps: [{
        id: 'email-step',
        ordinal: 1,
        type: 'Fill',
        targetIdentity: { kind: 'field', label: 'Email address', role: 'textbox' },
        value: 'qa@example.test',
      }],
      assertions: [{
        id: 'email-visible',
        stepId: 'email-step',
        ordinal: 2,
        type: 'AssertVisible',
        targetIdentity: { kind: 'field', label: 'Email address', role: 'textbox' },
        comparator: 'visible',
      }],
    });

    expect(compiled.actions[0]).toMatchObject({
      operationId: 'action:login-case:email-step',
      authoredStepId: 'email-step',
      assertionId: null,
    });
    expect(compiled.assertions[0]).toMatchObject({
      operationId: 'assertion:login-case:email-visible',
      authoredStepId: null,
      assertionId: 'email-visible',
      sourceStepRef: 'email-step',
      nonBlocking: true,
    });
  });

  it('preserves authored assertion verification evidence and dependencies', () => {
    const compiled = operationContract.compileOperationContractV2({
      id: 'field-readback-case',
      steps: [{
        id: 'step.035',
        ordinal: 35,
        type: 'Fill',
        targetIdentity: { label: 'Pickup Number', role: 'textbox' },
        value: '7995145776',
        operationCheck: {
          condition: { value: '7995145776' },
        },
      }, {
        id: 'step.036',
        ordinal: 36,
        type: 'AssertText',
        targetIdentity: { label: 'Pickup Number', role: 'textbox' },
        verify: { kind: 'text', text: '7995145776' },
        dependsOn: ['step.035'],
      }],
    });

    expect(compiled.assertions[0]).toMatchObject({
      assertionId: 'step.036',
      verify: { kind: 'text', text: '7995145776' },
      dependencies: ['step.035'],
      nonBlocking: true,
    });
  });

  it('rejects missing targets instead of inheriting the previous control', () => {
    expect(() => operationContract.compileOperationContractV2({
      id: 'order-case',
      steps: [{
        id: 'order-number',
        type: 'Fill',
        targetIdentity: { label: 'Order Number', role: 'textbox' },
        value: '123',
      }, {
        id: 'pickup-number',
        type: 'Fill',
        value: '456',
      }],
    })).toThrowError(expect.objectContaining({
      code: 'OPERATION_CONTRACT_INVALID',
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'explicit_target_required' }),
      ]),
    }));
  });

  it('rejects assertion prose polluted into a select value', () => {
    expect(() => operationContract.compileOperationContractV2({
      id: 'timezone-case',
      steps: [{
        id: 'timezone',
        type: 'Select',
        targetIdentity: { label: 'Time Zone', role: 'combobox' },
        selectionCriteria: { kind: 'exact_text', text: 'Central, and verify that the order is ready' },
      }],
    })).toThrowError(expect.objectContaining({
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'selection_contains_assertion_prose' }),
      ]),
    }));
  });

  it('normalizes persisted Navigate, Select, and Radio value forms without weakening exact selection', () => {
    const compiled = operationContract.compileOperationContractV2({
      id: 'persisted-case',
      steps: [{
        id: 'navigate',
        type: 'Navigate',
        value: 'https://example.test/sign-in',
      }, {
        id: 'timezone',
        type: 'Select',
        target: 'Time Zone dropdown',
        value: 'Central Standard Time (CST)',
        selectionCriteria: {
          kind: 'predicate',
          predicate: 'visible label contains Central',
          expectedText: 'Central',
        },
      }, {
        id: 'direction',
        type: 'Radio',
        target: 'Inbound',
        value: true,
      }],
    });

    expect(compiled.actions[0].value).toBe('https://example.test/sign-in');
    expect(compiled.actions[1].selection).toEqual({
      kind: 'exact_text',
      value: 'Central Standard Time (CST)',
    });
    expect(compiled.actions[2].value).toBe(true);
  });

  it('routes an authored option click into the exact owner selection protocol', () => {
    const compiled = operationContract.compileOperationContractV2({
      id: 'autocomplete-case',
      steps: [{
        id: 'choose-organization',
        type: 'Click',
        targetIdentity: {
          accessibleName: 'second Owning Organization option, *SIGROUP-EUR SOURCE SYSTEM 01',
          role: 'option',
          section: 'General Information',
        },
      }],
    });

    expect(compiled.actions[0]).toMatchObject({
      type: 'Select',
      authoredType: 'Click',
      normalization: 'option_activation_to_select',
      targetIdentity: {
        accessibleName: 'Owning Organization',
        role: null,
        controlType: 'autocomplete',
        section: 'General Information',
      },
      selection: {
        kind: 'exact_text',
        value: '*SIGROUP-EUR SOURCE SYSTEM 01',
      },
    });
  });

  it('keeps an ordinary option-labelled click as a click when no exact selection is authored', () => {
    const compiled = operationContract.compileOperationContractV2({
      id: 'ordinary-click-case',
      steps: [{
        id: 'continue-option',
        type: 'Click',
        target: 'Continue option',
      }],
    });

    expect(compiled.actions[0]).toMatchObject({
      type: 'Click',
      authoredType: 'Click',
      normalization: null,
      targetIdentity: {
        accessibleName: 'Continue option',
      },
      selection: null,
    });
  });

  it('preserves authored action and inline assertion order and operation-check proof', () => {
    const compiled = operationContract.compileOperationContractV2({
      id: 'ordered-case',
      steps: [{
        id: 'fill-email',
        ordinal: 1,
        type: 'Fill',
        target: 'Email field',
        value: 'qa@example.test',
      }, {
        id: 'email-visible',
        ordinal: 2,
        type: 'AssertVisible',
        target: 'Email field',
      }, {
        id: 'continue',
        ordinal: 3,
        type: 'Click',
        target: 'Continue button',
        operationCheck: {
          kind: 'page_ready',
          target: 'Password page',
          condition: { text: 'Enter password' },
        },
      }, {
        id: 'optional-prompt',
        ordinal: 4,
        type: 'Click',
        target: 'Continue option',
        condition: { predicate: 'prompt visible', onFalse: 'skip' },
      }],
    });

    expect(compiled.operations.map((operation) => operation.operationId)).toEqual([
      'action:ordered-case:fill-email',
      'assertion:ordered-case:email-visible',
      'action:ordered-case:continue',
      'action:ordered-case:optional-prompt',
    ]);
    expect(compiled.operations[2].destination).toEqual({ text: 'Enter password' });
    expect(compiled.operations[3].optional).toBe(true);
    expect(compiled.operations.map((operation) => operation.dependencies)).toEqual([
      [],
      [],
      [],
      [],
    ]);
    expect(compiled.operations.map((operation) => operation.orderingPredecessor)).toEqual([
      null,
      'action:ordered-case:fill-email',
      'assertion:ordered-case:email-visible',
      'action:ordered-case:continue',
    ]);
  });

  it('normalizes exact owner identity without control wrapper words changing its name', () => {
    const compiled = operationContract.compileOperationContractV2({
      id: 'login-case',
      steps: [{
        id: 'sign-in',
        type: 'Click',
        targetIdentity: {
          kind: 'control',
          accessibleName: 'Sign in',
          role: 'button',
          section: 'Authentication form',
          framePath: ['top'],
          backendNodeId: 41,
        },
      }],
    });
    expect(compiled.actions[0].targetIdentity).toMatchObject({
      accessibleName: 'Sign in',
      role: 'button',
      section: 'Authentication form',
      framePath: ['top'],
      backendNodeId: '41',
    });
  });
});
