import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const temporal = require('../../server/services/calendarTimeTransaction');
const { createUniversalControl } = require('../../server/services/universalControlModel');

function popupControl(kind, label) {
  const isDate = kind === 'date';
  const controlType = isDate ? 'date_picker' : kind === 'time' ? 'time_picker' : 'combobox';
  const action = kind === 'timezone' ? 'select' : kind;
  const owner = {
    ref: `${kind}-owner`,
    role: 'combobox',
    label,
    visible: true,
    enabled: true,
  };
  return createUniversalControl({
    controlType,
    requestedAction: action,
    requestedTarget: label,
    ownerElement: owner,
    interactionElement: {
      ref: `${kind}-trigger`,
      role: 'button',
      label: isDate ? `Open ${label} calendar` : `Open ${label}`,
      visible: true,
      enabled: true,
    },
    popupElement: {
      ref: `${kind}-popup`,
      role: isDate ? 'dialog' : 'listbox',
      label: isDate ? `${label} calendar` : `${label} options`,
      visible: false,
    },
    optionContainer: {
      ref: `${kind}-options`,
      role: isDate ? 'grid' : 'listbox',
      label: `${label} options`,
      visible: false,
    },
    valueElement: owner,
    relationships: {
      ownerToTrigger: 'associated trigger',
      ownerToPopup: 'aria-controls',
      popupToOptions: 'owned option container',
    },
  });
}

function nativeControl(kind, label) {
  const owner = {
    ref: `${kind}-native`,
    tag: 'input',
    inputType: kind,
    label,
    visible: true,
    enabled: true,
    editable: true,
  };
  return createUniversalControl({
    controlType: `${kind}_input`,
    requestedAction: kind,
    requestedTarget: label,
    ownerElement: owner,
    interactionElement: owner,
    valueElement: owner,
  });
}

function identity(overrides = {}) {
  return {
    runId: 'run-temporal',
    caseId: 'case-schedule',
    stepId: 'step-temporal',
    sequenceIndex: 7,
    sleep: async () => {},
    ...overrides,
  };
}

describe('calendarTimeTransaction normalization and chronology', () => {
  it('normalizes the four pickup/delivery dates and times and proves exact chronology', () => {
    const points = [
      { id: 'early-pickup', date: 'August 20, 2026', time: '09:00 AM' },
      { id: 'late-pickup', date: '08/20/2026', time: '11:00 AM' },
      { id: 'early-delivery', date: '2026-08-21', time: '01:00 PM' },
      { id: 'late-delivery', date: '21 August 2026', time: '03:00 PM' },
    ];

    expect(points.map((point) => temporal.normalizeDateValue(point.date))).toEqual([
      '2026-08-20',
      '2026-08-20',
      '2026-08-21',
      '2026-08-21',
    ]);
    expect(points.map((point) => temporal.normalizeTimeValue(point.time))).toEqual([
      '09:00',
      '11:00',
      '13:00',
      '15:00',
    ]);
    expect(temporal.validateChronology(points)).toMatchObject({
      ok: true,
      code: 'chronology_exact',
      relationships: [
        { left: 'early-pickup', right: 'late-pickup', before: true },
        { left: 'late-pickup', right: 'early-delivery', before: true },
        { left: 'early-delivery', right: 'late-delivery', before: true },
      ],
    });
  });

  it('derives month movement deterministically without guessing day positions', () => {
    expect(temporal.deriveMonthYearNavigation('November 2025', '2026-02-14')).toEqual([
      { kind: 'calendar_navigate_month', direction: 'next', expectedMonth: '2025-12' },
      { kind: 'calendar_navigate_month', direction: 'next', expectedMonth: '2026-01' },
      { kind: 'calendar_navigate_month', direction: 'next', expectedMonth: '2026-02' },
    ]);
    const yearAware = temporal.deriveMonthYearNavigation('2024-11', '2026-02-14', { supportsYearSelection: true });
    expect(yearAware[0]).toEqual({ kind: 'calendar_select_year', year: 2026, expectedYear: 2026 });
    expect(yearAware.slice(1)).toHaveLength(9);
    expect(yearAware.slice(1).every((action) => action.direction === 'previous')).toBe(true);
    expect(yearAware.at(-1)).toEqual({
      kind: 'calendar_navigate_month',
      direction: 'previous',
      expectedMonth: '2026-02',
    });
  });
});

describe('calendar date selection safeguards', () => {
  it('rejects a date intent resolved to an unrelated textbox owner before dispatch', async () => {
    const owner = {
      ref: 'pickup-number',
      tag: 'input',
      inputType: 'text',
      role: 'textbox',
      label: 'Pickup Number',
      visible: true,
      enabled: true,
    };
    const wrong = createUniversalControl({
      controlType: 'date_picker',
      requestedAction: 'date',
      requestedTarget: 'Early Pickup Date',
      ownerElement: owner,
      interactionElement: owner,
      valueElement: owner,
    });

    expect(temporal.validateTemporalControl(wrong, 'date')).toMatchObject({
      ok: false,
      code: 'temporal_control_identity_mismatch',
    });
    const dispatch = vi.fn();
    const result = await temporal.executeDateTransaction(identity({
      control: wrong,
      expectedDate: '2026-08-20',
      dispatch,
      observe: async () => ({}),
    }));
    expect(result).toMatchObject({ ok: false, code: 'temporal_control_identity_mismatch' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a disabled current-month day even when an enabled duplicate day is visible', () => {
    const result = temporal.findExactCalendarDay([
      { ref: 'previous-month-20', day: 20, date: '2026-07-20', currentMonth: false, visible: true, enabled: true },
      { ref: 'current-month-20', day: 20, date: '2026-08-20', currentMonth: true, visible: true, disabled: true },
      { ref: 'next-month-20', day: 20, date: '2026-09-20', currentMonth: false, visible: true, enabled: true },
    ], '2026-08-20');

    expect(result).toEqual({ ok: false, code: 'calendar_day_disabled', targetDate: '2026-08-20' });
  });

  it('does not select an enabled same-number day from an adjacent month', () => {
    const result = temporal.findExactCalendarDay([
      { ref: 'previous-month-20', day: 20, currentMonth: false, visible: true, enabled: true },
      { ref: 'next-month-20', day: 20, currentMonth: false, visible: true, enabled: true },
    ], '2026-08-20');

    expect(result).toEqual({ ok: false, code: 'calendar_day_wrong_month', targetDate: '2026-08-20' });
  });

  it('opens once, observes repeatedly, selects the exact date once, and reads back the owner', async () => {
    const control = popupControl('date', 'Early Pickup Date');
    let open = false;
    let selected = null;
    let selectionObservations = 0;
    const dispatch = vi.fn(async (command) => {
      if (command.kind === 'open_temporal_popup') open = true;
      if (command.kind === 'select_calendar_date') selected = command.value;
      return { delivered: true };
    });
    const observe = vi.fn(async ({ phase }) => {
      if (phase === 'select-date') {
        selectionObservations += 1;
        return { ownerValue: selectionObservations >= 3 ? selected : null, popupOpen: open };
      }
      return {
        ownerValue: null,
        popupOpen: open,
        visibleMonth: '2026-08',
        options: [
          { ref: 'day-20', role: 'gridcell', label: '20', date: '2026-08-20', currentMonth: true, visible: true, enabled: true },
        ],
      };
    });

    const result = await temporal.executeDateTransaction(identity({
      control,
      expectedDate: '08/20/2026',
      dispatch,
      observe,
      maxObservationAttempts: 5,
    }));

    expect(result).toMatchObject({ ok: true, expectedDate: '2026-08-20' });
    expect(dispatch.mock.calls.map(([command]) => command.kind)).toEqual([
      'open_temporal_popup',
      'select_calendar_date',
    ]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(selectionObservations).toBe(3);
    expect(result.transactions.filter((item) => item?.transaction).every((item) => item.transaction.dispatchAttemptCount === 1)).toBe(true);
  });

  it('sets a native date exactly once and accepts locale display readback', async () => {
    let value = '';
    const dispatch = vi.fn(async (command) => {
      value = '20/08/2026';
      expect(command).toMatchObject({ kind: 'set_native_date', value: '2026-08-20' });
      return { delivered: true };
    });

    const result = await temporal.executeDateTransaction(identity({
      control: nativeControl('date', 'Pickup Date'),
      expectedDate: 'August 20, 2026',
      dateOrder: 'DMY',
      dispatch,
      observe: async () => ({ ownerValue: value }),
    }));

    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

describe('time and timezone transactions', () => {
  it('sets a native time exactly once and normalizes its owner readback', async () => {
    let value = '';
    const dispatch = vi.fn(async (command) => {
      value = '13:00';
      expect(command).toMatchObject({ kind: 'set_native_time', value: '13:00' });
      return { delivered: true };
    });

    const result = await temporal.executeTimeTransaction(identity({
      control: nativeControl('time', 'Early Delivery Time'),
      expectedTime: '01:00 PM',
      dispatch,
      observe: async () => ({ ownerValue: value }),
    }));

    expect(result).toMatchObject({ ok: true, expectedTime: '13:00' });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('selects an exact semantic time option once after the popup is already open', async () => {
    const control = popupControl('time', 'Late Pickup Time');
    let selected = '';
    const dispatch = vi.fn(async (command) => {
      selected = command.value;
      return { delivered: true };
    });
    const observe = async () => ({
      popupOpen: true,
      ownerValue: selected,
      options: [
        { ref: 'time-09', label: '09:00 AM', visible: true, enabled: true },
        { ref: 'time-11', label: '11:00 AM', visible: true, enabled: true },
      ],
    });

    const result = await temporal.executeTimeTransaction(identity({
      control,
      expectedTime: '11:00 AM',
      dispatch,
      observe,
    }));

    expect(result).toMatchObject({ ok: true, expectedTime: '11:00' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0]).toMatchObject({ kind: 'select_time', value: '11:00' });
  });

  it('selects an available timezone whose visible label contains a generic criterion', async () => {
    const control = popupControl('timezone', 'Early Pickup Time Zone');
    let open = false;
    let selected = '';
    const dispatch = vi.fn(async (command) => {
      if (command.kind === 'open_temporal_popup') open = true;
      if (command.kind === 'select_timezone') selected = command.value;
      return { delivered: true };
    });
    const observe = async () => ({
      popupOpen: open,
      ownerValue: selected,
      options: [
        { ref: 'zone-east', label: 'Eastern Time', visible: true, enabled: true },
        { ref: 'zone-central', label: 'Central Standard Time', visible: true, enabled: true },
        { ref: 'zone-west', label: 'Pacific Time', visible: true, enabled: true },
      ],
    });

    const result = await temporal.executeTimezoneTransaction(identity({
      control,
      contains: 'Central',
      dispatch,
      observe,
    }));

    expect(result).toMatchObject({
      ok: true,
      criterion: 'Central',
      selectedLabel: 'Central Standard Time',
    });
    expect(dispatch.mock.calls.map(([command]) => command.kind)).toEqual([
      'open_temporal_popup',
      'select_timezone',
    ]);
    expect(dispatch.mock.calls[1][0]).toMatchObject({
      criterion: { kind: 'label_contains', expectedText: 'Central' },
    });
  });
});
