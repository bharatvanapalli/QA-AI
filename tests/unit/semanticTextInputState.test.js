import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  valuesMatch,
  buildBoundTextInputReadFunction,
  evaluateTextInputReadback,
} = require('../../server/services/semanticTextInputState');

describe('semantic text input owner state', () => {
  it('builds a read-only probe for one exact bound editable owner', () => {
    const source = buildBoundTextInputReadFunction({
      expectedValue: 'expected input',
      actionType: 'Fill',
    });

    expect(source).toContain('bound_text_input_owner_ambiguous');
    expect(source).toContain('text_input_owner_value_committed');
    expect(source).toContain('ownerStateCommitted');
    expect(source).toContain('stableAcrossSettle');
    expect(source).toContain('ownerConnected');
    expect(source).not.toContain('.click(');
    expect(source).not.toContain('dispatchEvent');
    expect(source).not.toMatch(/odyssey|pickup number|sigroup|equipment/i);
    expect(() => Function(`return (${source});`)()).not.toThrow();
  });

  it('normalizes formatted numeric input without accepting partial numbers', () => {
    expect(valuesMatch('7995145776', '(799) 514-5776')).toBe(true);
    expect(valuesMatch('7995145776', '7995145')).toBe(false);
  });

  it('does not commit a delivered fill when the exact owner remains empty', () => {
    expect(evaluateTextInputReadback({
      expectedValue: '7995145776',
      readback: {
        ok: true,
        matched: false,
        ownerStateCommitted: false,
        valuePresent: false,
      },
    })).toEqual({
      valueMatched: false,
      ownerStateCommitted: false,
      reason: 'text_input_owner_value_not_committed',
    });
  });

  it('commits only the exact bound owner value', () => {
    expect(evaluateTextInputReadback({
      expectedValue: '7995145776',
      readback: {
        ok: true,
        matched: true,
        ownerStateCommitted: true,
        valuePresent: true,
      },
    })).toEqual({
      valueMatched: true,
      ownerStateCommitted: true,
      reason: 'text_input_owner_value_committed',
    });
  });

  it('does not commit a transient value before framework settle', () => {
    expect(evaluateTextInputReadback({
      expectedValue: '7995145776',
      readback: {
        ok: true,
        matched: true,
        ownerStateCommitted: false,
        stableAcrossSettle: false,
        ownerConnected: true,
        reason: 'text_input_owner_value_settling',
      },
    })).toEqual({
      valueMatched: true,
      ownerStateCommitted: false,
      reason: 'text_input_owner_value_settling',
    });
  });
});
