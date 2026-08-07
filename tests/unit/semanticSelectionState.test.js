import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  semanticSelectionRank,
  buildVirtualizedOptionSelectionFunction,
  buildBoundSelectionOwnerReadFunction,
  buildBoundPopupOwnershipReadFunction,
  evaluateSelectionOwnerReadback,
} = require('../../server/services/semanticSelectionState');

describe('semantic selection owner state', () => {
  it('builds one bounded owner-correlated virtualized option transaction', () => {
    const source = buildVirtualizedOptionSelectionFunction({
      expectedSelection: { kind: 'exact_text', value: 'Central' },
    });

    expect(source).toContain('"maxScrolls":24');
    expect(source).toContain('virtualized_selection_semantic_ambiguous');
    expect(source).toContain('scrollProgressCount');
    expect(source).toContain('popupOpenedByTransaction');
    expect(source).toContain('target.click()');
    expect(source).toContain('ownerMatched');
    expect(source).toContain('actionPerformed: true');
    expect(source).toContain('expectedSelectionMatched: true');
    expect(source).not.toMatch(/odyssey|sigroup|equipment|time zone/i);
    expect(() => Function(`return (${source});`)()).not.toThrow();
    expect(semanticSelectionRank('Central', '(UTC-06:00)US/Central')).toBe(1);
    expect(semanticSelectionRank('Central', '(UTC-06:00)Canada/Central')).toBe(1);
    expect(semanticSelectionRank('Central', '(UTC-05:00)US/Eastern')).toBe(0);
  });

  it('builds a read-only owner-bound probe that excludes popup option text', () => {
    const source = buildBoundSelectionOwnerReadFunction({
      expectedSelection: 'Choice Extended',
    });

    expect(source).toContain('exact_bound_selection_owner_value_observed');
    expect(source).toContain('excludedRoles');
    expect(source).toContain('relationIds.includes');
    expect(source).toContain('popupOpen');
    expect(source).toContain('controlledPopupCount');
    expect(source).toContain('ownedOptionNames');
    expect(source).toContain('invalid');
    expect(source).not.toContain('.click(');
    expect(source).not.toContain('dispatchEvent');
    expect(source).not.toMatch(/odyssey|sigroup|equipment|ship direction/i);
    expect(() => Function(`return (${source});`)()).not.toThrow();
  });

  it('builds a read-only popup ownership probe without requiring a selection value', () => {
    const source = buildBoundPopupOwnershipReadFunction();

    expect(source).toContain('exact_bound_popup_ownership_observed');
    expect(source).toContain('aria-controls');
    expect(source).toContain('aria-labelledby');
    expect(source).toContain('ownedOptionNames');
    expect(source).not.toContain('.click(');
    expect(source).not.toContain('dispatchEvent');
    expect(() => Function(`return (${source});`)()).not.toThrow();
  });

  it('does not commit an autocomplete query that is not the selected option', () => {
    expect(evaluateSelectionOwnerReadback({
      expectedSelection: 'Choice Extended',
      readback: {
        ok: true,
        values: [{ value: 'Choice', source: 'editable-owner-value' }],
        matched: false,
        popupOpen: true,
        invalid: false,
      },
    })).toEqual({
      valueMatched: false,
      ownerStateCommitted: false,
      reason: 'selection_owner_value_not_committed',
    });
  });

  it('does not commit an option merely because its popup is still open', () => {
    expect(evaluateSelectionOwnerReadback({
      expectedSelection: 'LTL',
      readback: {
        ok: true,
        values: [{ value: 'LTL', source: 'owner-rendered-text' }],
        matched: true,
        popupOpen: true,
        invalid: false,
      },
    })).toEqual({
      valueMatched: true,
      ownerStateCommitted: false,
      reason: 'selection_popup_still_open',
    });
  });

  it('commits the exact selected value while reporting application validation separately', () => {
    expect(evaluateSelectionOwnerReadback({
      expectedSelection: 'LTL',
      readback: {
        ok: true,
        values: [{ value: 'LTL', source: 'owner-rendered-text' }],
        matched: true,
        popupOpen: false,
        invalid: true,
      },
    })).toEqual({
      valueMatched: true,
      ownerStateCommitted: true,
      applicationValidationRejected: true,
      reason: 'selection_owner_value_committed_with_application_validation_error',
    });
  });

  it('commits only the exact closed and valid owner value', () => {
    expect(evaluateSelectionOwnerReadback({
      expectedSelection: 'Inbound',
      readback: {
        ok: true,
        values: [{ value: 'Inbound', source: 'owner-rendered-text' }],
        matched: true,
        popupOpen: false,
        invalid: false,
      },
    })).toEqual({
      valueMatched: true,
      ownerStateCommitted: true,
      reason: 'selection_owner_value_committed',
    });
  });

  it('commits a unique delimited semantic owner value after virtualized selection', () => {
    expect(evaluateSelectionOwnerReadback({
      expectedSelection: 'Central',
      readback: {
        ok: true,
        values: [{ value: '(UTC-06:00)US/Central', source: 'owner-rendered-text' }],
        matched: false,
        popupOpen: false,
        invalid: false,
      },
    })).toEqual({
      valueMatched: true,
      ownerStateCommitted: true,
      reason: 'selection_owner_value_committed',
    });
  });
});
