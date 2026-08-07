import { describe, expect, it } from 'vitest';
import stepShape from '../../server/lib/stepShape.js';

describe('step shape normalization', () => {
  it('upgrades Fill steps with values to deterministic value verification', () => {
    const step = stepShape.normaliseStepShape({
      action: 'Fill',
      element: 'Username textbox',
      value: 'Admin',
      verify: { kind: 'none' },
    }, 1);

    expect(step.verify).toEqual({
      kind: 'value',
      field: { name: 'Username textbox', role: 'textbox' },
      equals: 'Admin',
    });
  });

  it('upgrades legacy Type steps without verify to value verification', () => {
    const step = stepShape.normaliseStepShape({
      action: 'Type',
      target: 'Password textbox',
      value: 'admin123',
    }, 2);

    expect(step.verify?.kind).toBe('value');
    expect(step.verify?.field).toEqual({ name: 'Password textbox', role: 'textbox' });
    expect(step.verify?.equals).toBe('admin123');
  });

  it('upgrades Select steps with values to selected verification', () => {
    const step = stepShape.normaliseStepShape({
      action: 'Select',
      element: 'Status dropdown',
      value: 'Enabled',
      verify: { kind: 'none' },
    }, 3);

    expect(step.verify).toEqual({
      kind: 'selected',
      control: { name: 'Status dropdown', role: 'combobox' },
      value: 'Enabled',
    });
  });

  it('preserves explicit non-none verification', () => {
    const step = stepShape.normaliseStepShape({
      action: 'Fill',
      element: 'Username textbox',
      value: 'Admin',
      verify: { kind: 'visible', element: { role: 'button', name: 'Login' } },
    }, 4);

    expect(step.verify).toEqual({ kind: 'visible', element: { role: 'button', name: 'Login' } });
  });

  it('normalizes persisted JSON-string steps instead of dropping them', () => {
    const steps = stepShape.normaliseSteps(JSON.stringify([
      { action: 'Navigate', value: 'https://example.test/login' },
      { action: 'Fill', target: 'Username textbox', value: 'Admin' },
    ]));

    expect(steps).toHaveLength(2);
    expect(steps[0].action).toBe('Navigate');
    expect(steps[0].value).toBe('https://example.test/login');
    expect(steps[1].element).toBe('Username textbox');
  });

  it('normalizes double-encoded persisted steps instead of returning a string', () => {
    const once = JSON.stringify([
      { action: 'Click', target: 'Save button' },
    ]);
    const twice = JSON.stringify(once);
    const steps = stepShape.normaliseSteps(twice);

    expect(steps).toHaveLength(1);
    expect(steps[0].action).toBe('Click');
    expect(steps[0].element).toBe('Save button');
  });

  it('preserves arbitrary authored wait timing and recovery in prompt serialization', () => {
    const authoredWait = {
      timeoutMs: 31429,
      refreshAfterMs: 8237,
      pollIntervalMs: 317,
      stableObservations: 3,
      recovery: {
        action: 'reload_current_page',
        maxAttempts: 2,
        retryAfterMs: 419,
        waitUntil: 'domcontentloaded',
        authoredMetadata: { reason: 'generic recovery policy' },
      },
    };

    const [serialized] = stepShape.serialiseStepsForPrompt([{
      action: 'Wait',
      element: 'Records table',
      waitContract: authoredWait,
    }]);

    expect(serialized.waitContract).toEqual(authoredWait);
    expect(stepShape.normaliseStepShape(serialized).waitContract).toEqual(authoredWait);
  });

  it('preserves typed selection and conditional-action contracts for runtime execution', () => {
    const exactSelect = stepShape.normaliseStepShape({
      action: 'Select',
      element: 'Equipment dropdown',
      text: 'Select the third Equipment option, LTL',
      selectionCriteria: { kind: 'exact_text', text: 'LTL' },
    }, 1);
    const containsSelect = stepShape.normaliseStepShape({
      action: 'Select',
      element: 'Time Zone dropdown',
      selectionCriteria: { kind: 'predicate', predicate: 'visible label contains Central' },
    }, 2);
    const conditionalExpand = stepShape.normaliseStepShape({
      action: 'Expand',
      element: 'Pickup and Delivery section',
      condition: { kind: 'state', state: 'collapsed' },
    }, 3);

    expect(exactSelect.selectionCriteria).toEqual({ kind: 'exact_text', text: 'LTL' });
    expect(exactSelect.value).toBeNull();
    expect(containsSelect.selectionCriteria).toEqual({
      kind: 'predicate', predicate: 'visible label contains Central',
    });
    expect(conditionalExpand.condition).toEqual({ kind: 'state', state: 'collapsed' });
    expect(stepShape.serialiseStepForPrompt(exactSelect).selectionCriteria).toEqual({
      kind: 'exact_text', text: 'LTL',
    });
    expect(stepShape.serialiseStepForPrompt(conditionalExpand).condition).toEqual({
      kind: 'state', state: 'collapsed',
    });
  });

  it('preserves boolean and numeric authored values through runtime normalization and prompts', () => {
    const radio = stepShape.normaliseStepShape({
      action: 'Radio',
      element: 'Ship Date & Time',
      value: true,
      expected: true,
    }, 1);
    const count = stepShape.normaliseStepShape({
      action: 'Verify',
      element: 'Result count',
      expected: 65,
    }, 2);

    expect(radio.value).toBe(true);
    expect(radio.expected).toBe(true);
    expect(stepShape.serialiseStepForPrompt(radio)).toMatchObject({ value: true, expected: true });
    expect(count.expected).toBe(65);
    expect(stepShape.serialiseStepForPrompt(count).expected).toBe(65);
  });

  it('preserves natural-language user instructions instead of silently dropping them', () => {
    const [step] = stepShape.normaliseSteps([
      'Choose the latest active invoice and ensure it opens correctly.',
    ]);

    expect(step.action).toBe('Choose');
    expect(step.authoredText).toBe('Choose the latest active invoice and ensure it opens correctly.');
    expect(step.executionMode).toBe('semantic');
    expect(step.semanticInstruction).toBe(true);
    expect(stepShape.serialiseStepForPrompt(step)).toMatchObject({
      action: 'Choose',
      authoredText: 'Choose the latest active invoice and ensure it opens correctly.',
      executionMode: 'semantic',
      semanticInstruction: true,
    });
  });

  it('keeps authored whitespace byte-for-byte while using cleaned text for inference', () => {
    const authoredText = '  Click   Save,\nthen verify the employee row.  ';
    const [step] = stepShape.normaliseSteps([authoredText]);

    expect(step.action).toBe('Click');
    expect(step.authoredText).toBe(authoredText);
    expect(stepShape.serialiseStepForPrompt(step).authoredText).toBe(authoredText);
  });

  it('preserves interpretation, logical identity, atomic actions, and observation-only diagnostics', () => {
    const step = stepShape.normaliseStepShape({
      id: 'step-user-3',
      logicalStepId: 'logical-user-3',
      order: 3,
      authoredText: 'Click Save and verify the employee was created.',
      interpretation: {
        action: 'Click',
        target: 'Save button',
        validation: 'Employee was created',
      },
      atomicActions: [
        { action: 'Click', target: 'Save button' },
        { action: 'Verify', target: 'employee-created result' },
      ],
      interpretationDiagnostics: [
        { code: 'compound_instruction_split', severity: 'info', blocking: false },
      ],
    }, 3);

    expect(step.contractStepId).toBe('step-user-3');
    expect(step.logicalStepId).toBe('logical-user-3');
    expect(step.action).toBe('Click');
    expect(step.element).toBe('Save button');
    expect(step.expected).toBe('Employee was created');
    expect(step.atomicActions).toHaveLength(2);
    expect(step.interpretationDiagnostics[0].blocking).toBe(false);
    expect(stepShape.serialiseStepForPrompt(step).authoredText).toBe(
      'Click Save and verify the employee was created.',
    );
  });
});
