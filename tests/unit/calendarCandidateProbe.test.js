import { describe, expect, it } from 'vitest';
import probe from '../../server/services/calendarCandidateProbe';

describe('calendar candidate probe', () => {
  it('contains no provider or website vocabulary', () => {
    expect(probe.CALENDAR_CANDIDATE_FUNCTION).not.toMatch(/microsoft|odyssey|google|salesforce/i);
    expect(probe.CALENDAR_CANDIDATE_FUNCTION).toContain('data-date');
    expect(probe.CALENDAR_CANDIDATE_FUNCTION).toContain('data-current-month');
    expect(probe.CALENDAR_CANDIDATE_FUNCTION).toContain('dayInteractionOwner');
    expect(probe.CALENDAR_CANDIDATE_FUNCTION).toContain('[role="gridcell"], td');
  });

  it('attaches an accessibility ref only on an exact unique role/name match', () => {
    const candidates = [{ role: 'gridcell', name: '9 November 2027', dateParts: { year: 2027, month: 11, day: 9 } }];
    expect(probe.attachSnapshotRefs(candidates, '- gridcell "9 November 2027" [ref=e9]'))
      .toMatchObject([{ ref: 'e9' }]);
  });

  it('bridges a uniquely exposed calendar day across compatible accessibility roles', () => {
    const candidates = [{ role: 'gridcell', name: '20', dateParts: { year: 2026, month: 8, day: 20 } }];
    expect(probe.attachSnapshotRefs(candidates, '- generic "20" [ref=e20]'))
      .toMatchObject([{ ref: 'e20' }]);
  });

  it('fails closed by withholding a ref for duplicate live identities', () => {
    const candidates = [{ role: 'button', name: 'Advance', direction: 'forward' }];
    const snapshot = '- button "Advance" [ref=e1]\n- button "Advance" [ref=e2]';
    expect(probe.attachSnapshotRefs(candidates, snapshot)[0]).not.toHaveProperty('ref');
  });
});
