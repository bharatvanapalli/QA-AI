import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  calendarChoiceAliases,
  buildCalendarChoiceFunction,
  buildCalendarCommitFunction,
  buildCalendarModeFunction,
  buildBoundTemporalOwnerReadFunction,
  buildTimeOwnerOpenFunction,
  buildTimeOptionSelectionFunction,
  buildTemporalOwnerReadFunction,
} = require('../../server/services/semanticTemporalSelection');

describe('semantic temporal selection', () => {
  it('normalizes exact calendar values without site selectors', () => {
    expect(calendarChoiceAliases('year', '2026')).toEqual(['2026']);
    expect(calendarChoiceAliases('month', '08')).toEqual(['August', 'Aug']);
    expect(calendarChoiceAliases('day', '20')).toEqual(['20']);
  });

  it('builds a unique visible-dialog transaction and rejects invalid values', () => {
    const source = buildCalendarChoiceFunction({ kind: 'year', value: '2026' });
    expect(source).toContain('"aliases":["2026"]');
    expect(source).toContain('calendar_choice_ambiguous');
    expect(source).toContain('calendar_choice_not_found');
    expect(source).not.toContain('Odyssey');
    expect(buildCalendarModeFunction({ kind: 'month' })).toContain(
      '"aliases":["Choose Month","Select Month","Month"]',
    );
    expect(() => buildCalendarChoiceFunction({ kind: 'month', value: '19' })).toThrow();
  });

  it('builds a read-only exact temporal owner value probe', () => {
    const probe = buildTemporalOwnerReadFunction({
      accessibleName: 'Early Pickup Date and Time',
    });

    expect(probe).toContain('exact_temporal_owner_read');
    expect(probe).toContain('candidateCount');
    expect(probe).toContain('valueCandidateCount');
    expect(probe).toContain('...deepElements(owner)');
    expect(probe).toContain('aria-labelledby');
    expect(probe).not.toContain('.click(');
    expect(probe).not.toContain('dispatchEvent');
  });

  it('builds an exact owner-first calendar commit transaction', () => {
    const commit = buildCalendarCommitFunction({
      accessibleName: 'Early Pickup Date and Time',
      expectedDate: '2026-08-20',
    });

    expect(commit).toContain('exact_calendar_owner_already_committed');
    expect(commit).toContain('exact_calendar_commit_observed');
    expect(commit).toContain('"confirmAliases":["OK","Apply","Done","Select","Confirm","Save"]');
    expect(commit).not.toContain('Odyssey');
  });

  it('builds bound temporal readback and bounded virtualized time selection', () => {
    const read = buildBoundTemporalOwnerReadFunction({ valueKind: 'time' });
    const open = buildTimeOwnerOpenFunction({ expectedTime: '09:00 AM' });
    const select = buildTimeOptionSelectionFunction({
      expectedTime: '09:00 AM',
      revealOnly: true,
    });

    expect(read).toContain('exact_bound_temporal_owner_read');
    expect(read).toContain('"valueKind":"time"');
    expect(read).toContain('semanticTimes');
    expect(read).toContain('fieldValue(node), identityText(node)');
    expect(open).toContain('exact_time_field_clicked');
    expect(open).toContain('resolveTimeField');
    expect(open).toContain('isInteractive');
    expect(open).toContain('controlShapes');
    expect(() => Function(`return (${read});`)()).not.toThrow();
    expect(() => Function(`return (${open});`)()).not.toThrow();
    expect(select).toContain('"maxScrolls":12');
    expect(select).toContain('"revealOnly":true');
    expect(select).toContain('exact_time_option_revealed');
    expect(select).toContain('exact_time_option_committed');
    expect(select).toContain('scrollHeight');
    expect(select).toContain('scrollable.scrollTop = 0');
    expect(select).toContain('observedValues');
    expect(select).toContain('scrollableCount');
    expect(select).toContain('scanCount');
    expect(select).toContain('controlledTimeSurfaces');
    expect(select).toContain('fallbackTimeSurfaceCount');
    expect(select).toContain('const findSurfaces');
    expect(select).toContain('popup.surfaces.length === 0');
    expect(select).toContain('popupOpenedByTransaction');
    expect(select).toContain('timeField.click()');
    expect(select).toContain('visible(actionOwner(node))');
    expect(select).toContain('exactByOwner');
    expect(select.indexOf('const actionOwner')).toBeGreaterThanOrEqual(0);
    expect(select.indexOf('const actionOwner')).toBeLessThan(
      select.indexOf('visible(actionOwner(node))'),
    );
    expect(() => Function(`return (${select});`)()).not.toThrow();
    expect(select).not.toContain('Odyssey');
  });
});
