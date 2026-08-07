import { describe, expect, it } from 'vitest';
import { shouldShowDataRowUi } from '../../src/lib/dataRowPresentation';

describe('data row presentation', () => {
  it('keeps one pinned inline case instance internal to the UI', () => {
    expect(shouldShowDataRowUi({ dataSetName: 'InlineText', dataRowLabel: 'Row 1' }, 1)).toBe(false);
  });

  it('shows row identity for multiple inline case instances', () => {
    expect(shouldShowDataRowUi({ dataSetName: 'InlineText', dataRowLabel: 'Row 1' }, 2)).toBe(true);
  });

  it('shows an actual dataset even when it has one row', () => {
    expect(shouldShowDataRowUi({ dataSetName: 'AuthProfiles', dataRowLabel: 'valid_user' }, 1)).toBe(true);
  });
});
