import { describe, expect, it } from 'vitest';
import probe from '../../server/services/assertionStateProbe';

function runCollectionProbe(element) {
  return Function('return ' + probe.COLLECTION_STATE_FUNCTION)()(element);
}

describe('typed assertion state probe', () => {
  it('extracts target identity without website vocabulary', () => {
    expect(probe.targetDescriptor({ type: 'NUMBER', payload: { target: { role: 'cell', name: 'Total' } } }))
      .toEqual({ role: 'cell', name: 'Total' });
    expect(probe.TABLE_STATE_FUNCTION).not.toMatch(/odyssey|microsoft|google/i);
  });

  it('preserves structured table evidence', () => {
    const table = { headers: ['Name', 'Amount'], rows: [['A', '10']], rowCount: 1 };
    expect(probe.actualFromEvidence({ type: 'TABLE' }, table)).toBe(table);
  });

  it('maps exact attributes and boolean states', () => {
    expect(probe.actualFromEvidence({ type: 'ATTRIBUTE', payload: { name: 'data-state' } }, { attributes: { 'data-state': 'ready' } }))
      .toMatchObject({ attribute: 'data-state', value: 'ready' });
    expect(probe.actualFromEvidence({ type: 'CHECKED' }, { checked: true })).toEqual({ checked: true });
  });

  it('uses a form control value when a text assertion targets an input', () => {
    expect(probe.actualFromEvidence(
      { type: 'TEXT' },
      { text: '', actualValue: '007995145' },
      { text: 'unrelated page text' },
    )).toBe('007995145');
  });

  it('normalizes authored assertion wrappers without website vocabulary', () => {
    expect(probe.normalizeTargetName('visible text "Workspace ready"')).toBe('Workspace ready');
    expect(probe.normalizeTargetName('through secure input readback that the Account secret field'))
      .toBe('Account secret field');
  });

  it('extracts the target-scoped visible option collection from a snapshot', () => {
    const snapshot = [
      '- combobox "Equipment" [expanded] [ref=equipment]',
      '  - listbox "" [ref=equipment-list]',
      '    - option "RR" [ref=rr]',
      '    - option "LCL" [ref=lcl]',
      '    - option "LTL" [ref=ltl]',
      '    - option "TL" [ref=tl]',
      '    - option "FCL" [ref=fcl]',
    ].join('\n');

    expect(probe.snapshotCollectionState(snapshot, 'Equipment option list')).toMatchObject({
      found: true,
      items: ['RR', 'LCL', 'LTL', 'TL', 'FCL'],
      count: 5,
    });
  });

  it('marks an empty DOM collection as uncheckable', () => {
    document.body.innerHTML = '<ul aria-label="Primary choices"></ul>';

    expect(runCollectionProbe(document.querySelector('ul'))).toEqual({
      found: false,
      uncheckable: true,
      items: [],
      count: 0,
      reason: 'collection_items_not_observed',
    });
  });

  it('does not adopt a sole unscoped group for a named target', () => {
    const snapshot = [
      '- region "Secondary controls"',
      '  - listbox "Secondary choices" [ref=secondary-list]',
      '    - option "Choice Alpha" [ref=alpha]',
    ].join('\n');

    expect(probe.snapshotCollectionState(snapshot, 'Primary choices')).toEqual({
      found: false,
      uncheckable: true,
      items: [],
      count: 0,
      reason: 'collection_target_not_observed',
    });
  });

  it('preserves positively scoped no-results content', () => {
    const snapshot = [
      '- region "Search panel"',
      '  - listbox "Search results" [ref=search-results]',
      '    - status "No results found"',
    ].join('\n');

    expect(probe.snapshotCollectionState(snapshot, 'Search results')).toMatchObject({
      found: true,
      items: ['No results found'],
      count: 1,
      reason: 'collection_scoped_to_target',
    });
  });
});
