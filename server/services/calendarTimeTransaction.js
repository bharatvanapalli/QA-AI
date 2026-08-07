'use strict';

const {
  createUniversalControl,
  compareSemanticIdentity,
  identityTokens,
  inferControlType,
} = require('./universalControlModel');
const { resolveControlAdapter } = require('./controlAdapterRegistry');
const {
  coordinateActionTransaction,
  OUTCOME_KIND,
} = require('./actionTransactionCoordinator');

const SCHEMA = 'qaai_calendar_time_transaction_v1';
const RUNTIME_TRACKER_SCHEMA = 'qaai_temporal_runtime_tracker_v1';
const RUNTIME_STATES = Object.freeze({
  READY: 'READY',
  OPENING: 'OPENING',
  OPEN: 'OPEN',
  POSITIONING: 'POSITIONING',
  SELECTING: 'SELECTING',
  VALUE_COMMITTED: 'VALUE_COMMITTED',
});
const DATE_TYPES = new Set(['date_input', 'date_picker']);
const TIME_TYPES = new Set(['time_input', 'time_picker']);
const ZONE_TYPES = new Set(['native_select', 'combobox', 'listbox', 'autocomplete']);
const DATE_WORDS = new Set(['date', 'day', 'calendar']);
const TIME_WORDS = new Set(['time', 'clock']);
const ZONE_WORDS = new Set(['zone', 'timezone']);
const MONTHS = Object.freeze([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]);

function clean(value, max = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function timestamp(now = Date.now) {
  const value = typeof now === 'function' ? now() : now;
  return new Date(Number.isFinite(Number(value)) ? Number(value) : Date.now()).toISOString();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function validDateParts(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoDate(year, month, day) {
  if (!validDateParts(year, month, day)) return null;
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

function normalizeDateValue(value, options = {}) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  const text = clean(value, 160);
  if (!text) return null;

  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) {
    const order = clean(options.dateOrder || options.localeOrder || 'MDY', 8).toUpperCase();
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    if (order === 'DMY') return isoDate(year, second, first);
    return isoDate(year, first, second);
  }

  match = text.toLowerCase().match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})$/);
  if (match) {
    const month = MONTHS.indexOf(match[1]) + 1;
    return isoDate(Number(match[3]), month, Number(match[2]));
  }

  match = text.toLowerCase().match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)[,]?\s+(\d{4})$/);
  if (match) {
    const month = MONTHS.indexOf(match[2]) + 1;
    return isoDate(Number(match[3]), month, Number(match[1]));
  }

  return null;
}

function normalizeTimeValue(value) {
  const text = clean(value, 80).toUpperCase();
  if (!text) return null;
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute < 0 || minute > 59) return null;
  if (match[4]) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (match[4] === 'PM') hour += 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

function parseMonthIdentity(value) {
  const text = clean(value, 100).toLowerCase();
  if (!text) return null;
  let match = text.match(/^(\d{4})[-/](\d{1,2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? { year, month, isoMonth: `${year}-${pad2(month)}` } : null;
  }
  match = text.match(/^([a-z]+)\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]) + 1;
  const year = Number(match[2]);
  return month > 0 ? { year, month, isoMonth: `${year}-${pad2(month)}` } : null;
}

function addMonths(monthIdentity, delta) {
  const total = monthIdentity.year * 12 + monthIdentity.month - 1 + delta;
  const year = Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12 + 1;
  return { year, month, isoMonth: `${year}-${pad2(month)}` };
}

function deriveMonthYearNavigation(currentMonth, targetDate, options = {}) {
  const current = parseMonthIdentity(currentMonth);
  const normalizedTarget = normalizeDateValue(targetDate, options);
  if (!current) throw new Error('calendar_visible_month_invalid');
  if (!normalizedTarget) throw new Error('calendar_target_date_invalid');
  const [year, month] = normalizedTarget.split('-').map(Number);
  const delta = (year - current.year) * 12 + (month - current.month);
  const maxMonths = Math.max(1, Number(options.maxMonths || 240));
  if (Math.abs(delta) > maxMonths) throw new Error('calendar_navigation_out_of_range');

  const actions = [];
  if (options.supportsYearSelection === true && year !== current.year) {
    actions.push({ kind: 'calendar_select_year', year, expectedYear: year });
    const monthDelta = month - current.month;
    for (let index = 0; index < Math.abs(monthDelta); index += 1) {
      actions.push({
        kind: 'calendar_navigate_month',
        direction: monthDelta > 0 ? 'next' : 'previous',
        expectedMonth: addMonths({ year, month: current.month }, (monthDelta > 0 ? 1 : -1) * (index + 1)).isoMonth,
      });
    }
    return actions;
  }

  for (let index = 0; index < Math.abs(delta); index += 1) {
    actions.push({
      kind: 'calendar_navigate_month',
      direction: delta > 0 ? 'next' : 'previous',
      expectedMonth: addMonths(current, (delta > 0 ? 1 : -1) * (index + 1)).isoMonth,
    });
  }
  return actions;
}

function optionLabel(option) {
  return clean(option?.label || option?.accessibleName || option?.text || option?.name || option?.value, 240);
}

function optionVisible(option) {
  return option?.visible !== false && option?.hidden !== true;
}

function optionEnabled(option) {
  return option?.enabled !== false && option?.disabled !== true && option?.ariaDisabled !== true;
}

function dateIdentityOfOption(option, options = {}) {
  const explicit = normalizeDateValue(option?.date || option?.isoDate || option?.value, options);
  if (explicit) return explicit;
  const year = Number(option?.year);
  const month = Number(option?.month);
  const day = Number(option?.day ?? option?.dayOfMonth);
  return isoDate(year, month, day);
}

function findExactCalendarDay(options, targetDate, settings = {}) {
  const target = normalizeDateValue(targetDate, settings);
  if (!target) return { ok: false, code: 'calendar_target_date_invalid' };
  const targetDay = Number(target.slice(8, 10));
  const visible = (Array.isArray(options) ? options : []).filter(optionVisible);
  const exact = visible.filter((option) => dateIdentityOfOption(option, settings) === target);
  const candidates = exact.length > 0
    ? exact
    : visible.filter((option) => Number(option?.day ?? option?.dayOfMonth ?? optionLabel(option)) === targetDay
      && option?.currentMonth === true);
  const enabled = candidates.filter(optionEnabled);
  if (enabled.length === 1) return { ok: true, code: 'calendar_day_exact', option: enabled[0], targetDate: target };
  if (enabled.length > 1) return { ok: false, code: 'calendar_day_ambiguous', targetDate: target, candidateCount: enabled.length };
  if (candidates.length > 0) return { ok: false, code: 'calendar_day_disabled', targetDate: target };
  const sameNumber = visible.filter((option) => Number(option?.day ?? option?.dayOfMonth ?? optionLabel(option)) === targetDay);
  if (sameNumber.length > 0) return { ok: false, code: 'calendar_day_wrong_month', targetDate: target };
  return { ok: false, code: 'calendar_day_not_found', targetDate: target };
}

function findExactTimeOption(options, targetTime) {
  const target = normalizeTimeValue(targetTime);
  if (!target) return { ok: false, code: 'time_target_invalid' };
  const matches = (Array.isArray(options) ? options : [])
    .filter(optionVisible)
    .filter((option) => normalizeTimeValue(option?.value || optionLabel(option)) === target);
  const enabled = matches.filter(optionEnabled);
  if (enabled.length === 1) return { ok: true, code: 'time_option_exact', option: enabled[0], targetTime: target };
  if (enabled.length > 1) return { ok: false, code: 'time_option_ambiguous', targetTime: target };
  if (matches.length > 0) return { ok: false, code: 'time_option_disabled', targetTime: target };
  return { ok: false, code: 'time_option_not_found', targetTime: target };
}

function findTimezoneOption(options, criterion) {
  const expected = clean(criterion?.text || criterion?.expectedText || criterion, 160);
  if (!expected) return { ok: false, code: 'timezone_criterion_missing' };
  const needle = expected.toLocaleLowerCase();
  const matches = (Array.isArray(options) ? options : [])
    .filter(optionVisible)
    .filter(optionEnabled)
    .map((option, index) => ({ option, index, label: optionLabel(option) }))
    .filter((entry) => entry.label.toLocaleLowerCase().includes(needle))
    .sort((left, right) => {
      const leftExact = left.label.toLocaleLowerCase() === needle ? 0 : 1;
      const rightExact = right.label.toLocaleLowerCase() === needle ? 0 : 1;
      return leftExact - rightExact || left.label.length - right.label.length || left.index - right.index;
    });
  if (!matches.length) return { ok: false, code: 'timezone_option_not_found', criterion: expected };
  return { ok: true, code: 'timezone_option_contains', option: matches[0].option, label: matches[0].label, criterion: expected };
}

function resolvedLabels(control) {
  return [
    ...(control?.ownerElement?.labels || []),
    ...(control?.interactionElement?.labels || []),
    ...(control?.valueElement?.labels || []),
  ].map((value) => clean(value, 240)).filter(Boolean);
}

function hasWord(labels, words) {
  const tokens = new Set(identityTokens(labels.join(' ')));
  const normalized = labels.join(' ').toLocaleLowerCase();
  return [...words].some((word) => tokens.has(word) || normalized.includes(word));
}

function semanticCoverage(control) {
  const requested = identityTokens(control?.requestedTarget);
  if (!requested.length) return 1;
  const actual = new Set(identityTokens(resolvedLabels(control).join(' ')));
  const overlap = requested.filter((token) => actual.has(token)).length;
  return overlap / requested.length;
}

function validateTemporalControl(input, intentKind) {
  const control = input?.schema ? input : createUniversalControl(input || {});
  if (!control.ownerElement || !control.interactionElement || !control.valueElement) {
    return { ok: false, code: 'temporal_control_nodes_missing', control };
  }
  const semantic = compareSemanticIdentity(control);
  if (!semantic.ok || semanticCoverage(control) < 0.75) {
    return { ok: false, code: 'temporal_control_identity_mismatch', control, semantic };
  }

  const labels = resolvedLabels(control);
  const ownerActualType = inferControlType({
    ...(control.ownerElement || {}),
    type: control.ownerElement?.inputType,
  });
  let allowed;
  let words;
  if (intentKind === 'date') {
    allowed = DATE_TYPES;
    words = DATE_WORDS;
  } else if (intentKind === 'time') {
    allowed = TIME_TYPES;
    words = TIME_WORDS;
  } else {
    allowed = ZONE_TYPES;
    words = ZONE_WORDS;
  }
  if (!allowed.has(control.controlType)) {
    return { ok: false, code: 'temporal_control_type_mismatch', control, ownerActualType };
  }

  const nativeExpected = intentKind === 'date' ? 'date_input' : intentKind === 'time' ? 'time_input' : 'native_select';
  const native = control.controlType === nativeExpected;
  if (native && ownerActualType !== nativeExpected) {
    return { ok: false, code: 'temporal_native_owner_mismatch', control, ownerActualType };
  }
  if (!native) {
    const hasTemporalIdentity = hasWord(labels, words);
    const distinctTrigger = control.interactionElement?.ref !== control.ownerElement?.ref;
    const hasOwnerRelationship = !!clean(control.relationships?.ownerToTrigger || control.relationships?.ownerToPopup, 120);
    if (!hasTemporalIdentity || (!distinctTrigger && !hasOwnerRelationship && !control.popupElement)) {
      return { ok: false, code: 'temporal_popup_owner_mismatch', control, ownerActualType };
    }
  }

  const adapter = resolveControlAdapter({ actionKind: intentKind === 'timezone' ? 'select' : intentKind, controlType: control.controlType });
  if (!adapter.ok) return { ok: false, code: adapter.code, control, adapter };
  return { ok: true, code: 'temporal_control_identity_matched', control, adapter: adapter.adapter, native };
}

function observationData(observation) {
  return observation?.data && typeof observation.data === 'object' ? observation.data : observation || {};
}

function ownerValue(observation) {
  const data = observationData(observation);
  return data.ownerValue
    ?? data.selectedValue
    ?? data.selectedLabel
    ?? data.owner?.selectedValue
    ?? data.owner?.displayedValue
    ?? data.owner?.value
    ?? data.valueNode?.selectedValue
    ?? data.valueNode?.displayedValue
    ?? data.valueNode?.value
    ?? data.valueElement?.value
    ?? data.ownerElement?.value
    ?? data.control?.valueElement?.value
    ?? data.control?.ownerElement?.value
    ?? null;
}

function popupOpen(observation) {
  const data = observationData(observation);
  return data.popupOpen === true
    || data.popupElement?.visible === true
    || data.optionContainer?.visible === true
    || data.ownerElement?.expanded === true
    || data.control?.ownerElement?.expanded === true;
}

function visibleMonth(observation) {
  const data = observationData(observation);
  return data.visibleMonth || data.calendar?.visibleMonth || data.popupElement?.visibleMonth || null;
}

function visibleOptions(observation) {
  const data = observationData(observation);
  return data.options || data.visibleOptions || data.calendar?.days || data.optionContainer?.options || [];
}

function transactionContext(input, phase, action) {
  return {
    runId: input.runId || 'unbound-run',
    caseId: input.caseId || 'unbound-case',
    stepId: `${input.stepId || 'temporal-step'}:${phase}`,
    sequenceIndex: Number.isInteger(input.sequenceIndex) ? input.sequenceIndex : 0,
    actionOccurrenceId: input.actionOccurrenceId ? `${input.actionOccurrenceId}:${phase}` : undefined,
    action,
    mutating: true,
  };
}

async function coordinatedMutation(input, phase, command, provePostcondition, preState) {
  const persist = typeof input.persistTransaction === 'function'
    ? (transaction) => input.persistTransaction({ phase, transaction })
    : undefined;
  return coordinateActionTransaction({
    ...transactionContext(input, phase, command),
    capturePreState: async () => preState ?? input.observe({ phase: `${phase}:pre`, attempt: 0 }),
    dispatch: async () => input.dispatch(command),
    observe: async ({ attempt }) => input.observe({ phase, attempt, command }),
    provePostcondition: ({ observation }) => provePostcondition(observationData(observation)),
    persist,
    maxDispatchAttempts: 1,
    maxObservationAttempts: Math.max(1, Number(input.maxObservationAttempts || 6)),
    observationIntervalMs: Math.max(0, Number(input.observationIntervalMs || 0)),
    sleep: input.sleep,
    now: input.now,
  });
}

function matchedProof(matched, reason, terminal = false) {
  return { matched, checked: true, terminal: matched || terminal, reason };
}

async function ensurePopupOpen(input, control, initialObservation) {
  if (popupOpen(initialObservation)) return { skipped: true, reason: 'popup_already_open', observation: initialObservation };
  const command = { kind: 'open_temporal_popup', target: control.interactionElement, owner: control.ownerElement };
  return coordinatedMutation(input, 'open-popup', command, (observation) => matchedProof(
    popupOpen(observation),
    popupOpen(observation) ? 'popup_open_exact' : 'popup_not_open',
  ), initialObservation);
}

async function navigateCalendar(input, control, targetDate, startObservation) {
  let observation = startObservation;
  const navigation = deriveMonthYearNavigation(visibleMonth(observation), targetDate, input);
  const transactions = [];
  for (let index = 0; index < navigation.length; index += 1) {
    const action = navigation[index];
    const phase = `navigate-${index + 1}`;
    const command = { ...action, target: control.interactionElement, popup: control.popupElement };
    const result = await coordinatedMutation(input, phase, command, (current) => {
      if (action.kind === 'calendar_select_year') {
        const month = parseMonthIdentity(visibleMonth(current));
        return matchedProof(month?.year === action.expectedYear, month?.year === action.expectedYear ? 'calendar_year_exact' : 'calendar_year_pending');
      }
      const currentMonth = parseMonthIdentity(visibleMonth(current));
      return matchedProof(currentMonth?.isoMonth === action.expectedMonth, currentMonth?.isoMonth === action.expectedMonth ? 'calendar_month_exact' : 'calendar_month_pending');
    }, observation);
    transactions.push(result);
    if (result.outcome?.outcomeKind !== OUTCOME_KIND.SUCCESS) return { ok: false, code: 'calendar_navigation_unproven', transactions, observation };
    observation = await input.observe({ phase: `${phase}:committed`, attempt: 0, command });
  }
  return { ok: true, code: 'calendar_positioned', transactions, observation };
}

async function executeDateTransaction(input = {}) {
  if (typeof input.observe !== 'function' || typeof input.dispatch !== 'function') throw new TypeError('observe and dispatch hooks are required');
  const identity = validateTemporalControl(input.control, 'date');
  if (!identity.ok) return { ok: false, code: identity.code, control: identity.control };
  const expectedDate = normalizeDateValue(input.expectedDate ?? input.value, input);
  if (!expectedDate) return { ok: false, code: 'calendar_target_date_invalid', control: identity.control };
  const control = identity.control;
  const initial = await input.observe({ phase: 'date:pre', attempt: 0 });

  if (identity.native) {
    const command = { kind: 'set_native_date', target: control.interactionElement, value: expectedDate };
    const transaction = await coordinatedMutation(input, 'set-native-date', command, (observation) => {
      const actual = normalizeDateValue(ownerValue(observation), input);
      return matchedProof(actual === expectedDate, actual === expectedDate ? 'owner_date_exact' : 'owner_date_mismatch', actual != null);
    }, initial);
    return { ok: transaction.outcome?.outcomeKind === OUTCOME_KIND.SUCCESS, code: transaction.outcome?.reason, expectedDate, control, transactions: [transaction] };
  }

  const open = await ensurePopupOpen(input, control, initial);
  if (!open.skipped && open.outcome?.outcomeKind !== OUTCOME_KIND.SUCCESS) {
    return { ok: false, code: 'calendar_popup_not_open', expectedDate, control, transactions: [open] };
  }
  let openedObservation = await input.observe({ phase: 'calendar:open', attempt: 0 });
  const navigation = await navigateCalendar(input, control, expectedDate, openedObservation);
  if (!navigation.ok) return { ok: false, code: navigation.code, expectedDate, control, transactions: [open, ...navigation.transactions] };
  openedObservation = navigation.observation;
  const day = findExactCalendarDay(visibleOptions(openedObservation), expectedDate, input);
  if (!day.ok) return { ok: false, code: day.code, expectedDate, control, transactions: [open, ...navigation.transactions] };
  const command = { kind: 'select_calendar_date', target: day.option, owner: control.ownerElement, value: expectedDate };
  const selected = await coordinatedMutation(input, 'select-date', command, (observation) => {
    const actual = normalizeDateValue(ownerValue(observation), input);
    return matchedProof(actual === expectedDate, actual === expectedDate ? 'owner_date_exact' : 'owner_date_mismatch', actual != null);
  }, openedObservation);
  return {
    ok: selected.outcome?.outcomeKind === OUTCOME_KIND.SUCCESS,
    code: selected.outcome?.reason,
    expectedDate,
    selectedOption: day.option,
    control,
    transactions: [open, ...navigation.transactions, selected],
  };
}

async function executeTimeTransaction(input = {}) {
  if (typeof input.observe !== 'function' || typeof input.dispatch !== 'function') throw new TypeError('observe and dispatch hooks are required');
  const identity = validateTemporalControl(input.control, 'time');
  if (!identity.ok) return { ok: false, code: identity.code, control: identity.control };
  const expectedTime = normalizeTimeValue(input.expectedTime ?? input.value);
  if (!expectedTime) return { ok: false, code: 'time_target_invalid', control: identity.control };
  const control = identity.control;
  const initial = await input.observe({ phase: 'time:pre', attempt: 0 });

  if (identity.native) {
    const command = { kind: 'set_native_time', target: control.interactionElement, value: expectedTime };
    const transaction = await coordinatedMutation(input, 'set-native-time', command, (observation) => {
      const actual = normalizeTimeValue(ownerValue(observation));
      return matchedProof(actual === expectedTime, actual === expectedTime ? 'owner_time_exact' : 'owner_time_mismatch', actual != null);
    }, initial);
    return { ok: transaction.outcome?.outcomeKind === OUTCOME_KIND.SUCCESS, code: transaction.outcome?.reason, expectedTime, control, transactions: [transaction] };
  }

  const open = await ensurePopupOpen(input, control, initial);
  if (!open.skipped && open.outcome?.outcomeKind !== OUTCOME_KIND.SUCCESS) {
    return { ok: false, code: 'time_popup_not_open', expectedTime, control, transactions: [open] };
  }
  const opened = await input.observe({ phase: 'time:open', attempt: 0 });
  const option = findExactTimeOption(visibleOptions(opened), expectedTime);
  if (!option.ok) return { ok: false, code: option.code, expectedTime, control, transactions: [open] };
  const command = { kind: 'select_time', target: option.option, owner: control.ownerElement, value: expectedTime };
  const selected = await coordinatedMutation(input, 'select-time', command, (observation) => {
    const actual = normalizeTimeValue(ownerValue(observation));
    return matchedProof(actual === expectedTime, actual === expectedTime ? 'owner_time_exact' : 'owner_time_mismatch', actual != null);
  }, opened);
  return { ok: selected.outcome?.outcomeKind === OUTCOME_KIND.SUCCESS, code: selected.outcome?.reason, expectedTime, selectedOption: option.option, control, transactions: [open, selected] };
}

async function executeTimezoneTransaction(input = {}) {
  if (typeof input.observe !== 'function' || typeof input.dispatch !== 'function') throw new TypeError('observe and dispatch hooks are required');
  const identity = validateTemporalControl(input.control, 'timezone');
  if (!identity.ok) return { ok: false, code: identity.code, control: identity.control };
  const criterion = clean(input.contains ?? input.criterion?.expectedText ?? input.criterion, 160);
  if (!criterion) return { ok: false, code: 'timezone_criterion_missing', control: identity.control };
  const control = identity.control;
  const initial = await input.observe({ phase: 'timezone:pre', attempt: 0 });
  let open = { skipped: true, reason: 'native_select' };
  if (control.controlType !== 'native_select') {
    open = await ensurePopupOpen(input, control, initial);
    if (!open.skipped && open.outcome?.outcomeKind !== OUTCOME_KIND.SUCCESS) {
      return { ok: false, code: 'timezone_popup_not_open', criterion, control, transactions: [open] };
    }
  }
  const opened = control.controlType === 'native_select' ? initial : await input.observe({ phase: 'timezone:open', attempt: 0 });
  const option = findTimezoneOption(visibleOptions(opened), criterion);
  if (!option.ok) return { ok: false, code: option.code, criterion, control, transactions: [open] };
  const command = {
    kind: control.controlType === 'native_select' ? 'select_native_timezone' : 'select_timezone',
    target: option.option,
    owner: control.ownerElement,
    value: option.label,
    criterion: { kind: 'label_contains', expectedText: criterion },
  };
  const selected = await coordinatedMutation(input, 'select-timezone', command, (observation) => {
    const actual = clean(ownerValue(observation), 240);
    const matched = actual.toLocaleLowerCase().includes(criterion.toLocaleLowerCase());
    return matchedProof(matched, matched ? 'owner_timezone_contains' : 'owner_timezone_mismatch', !!actual);
  }, opened);
  return { ok: selected.outcome?.outcomeKind === OUTCOME_KIND.SUCCESS, code: selected.outcome?.reason, criterion, selectedLabel: option.label, selectedOption: option.option, control, transactions: [open, selected] };
}

function temporalInstant(input = {}, options = {}) {
  const date = normalizeDateValue(input.date, options);
  const time = normalizeTimeValue(input.time);
  if (!date || !time) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const offsetMinutes = Number.isFinite(Number(input.offsetMinutes)) ? Number(input.offsetMinutes) : 0;
  return Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000;
}

function compareTemporal(left, right, options = {}) {
  const leftInstant = temporalInstant(left, options);
  const rightInstant = temporalInstant(right, options);
  if (leftInstant == null || rightInstant == null) return { ok: false, code: 'temporal_value_invalid', comparison: null };
  return { ok: true, code: 'temporal_values_comparable', comparison: Math.sign(leftInstant - rightInstant), leftInstant, rightInstant };
}

function validateChronology(points, options = {}) {
  const list = Array.isArray(points) ? points : [];
  if (list.length < 2) return { ok: false, code: 'chronology_requires_two_points', relationships: [] };
  const relationships = [];
  for (let index = 0; index < list.length - 1; index += 1) {
    const comparison = compareTemporal(list[index], list[index + 1], options);
    const before = comparison.ok && comparison.comparison < 0;
    relationships.push({
      left: clean(list[index]?.id || `point-${index + 1}`, 120),
      right: clean(list[index + 1]?.id || `point-${index + 2}`, 120),
      before,
      comparison,
    });
  }
  return { ok: relationships.every((item) => item.before), code: relationships.every((item) => item.before) ? 'chronology_exact' : 'chronology_mismatch', relationships };
}

function createTemporalRuntimeTracker(input = {}) {
  const intentKind = clean(input.intentKind || input.kind, 40).toLowerCase();
  if (!['date', 'time', 'timezone'].includes(intentKind)) {
    throw new TypeError('intentKind must be date, time, or timezone');
  }
  const expected = intentKind === 'date'
    ? normalizeDateValue(input.expected ?? input.expectedDate ?? input.value, input)
    : intentKind === 'time'
      ? normalizeTimeValue(input.expected ?? input.expectedTime ?? input.value)
      : clean(input.expected ?? input.contains ?? input.criterion ?? input.value, 240);
  if (!expected) throw new TypeError(`valid ${intentKind} expected value is required`);

  const context = {
    intentKind,
    expected,
    matchMode: clean(input.matchMode || (intentKind === 'timezone' ? 'contains' : 'exact'), 40).toLowerCase(),
    state: RUNTIME_STATES.READY,
    stateHistory: [RUNTIME_STATES.READY],
    evidenceLedger: [],
    control: null,
    controlValidation: null,
    finalProof: null,
  };
  const append = (type, phase, evidence = null) => {
    context.evidenceLedger.push({
      sequence: context.evidenceLedger.length,
      at: timestamp(input.now || Date.now),
      type,
      phase,
      attemptStatus: 'canonical',
      evidence,
    });
  };
  const transition = (state, evidence = null) => {
    if (context.stateHistory.at(-1) !== state) context.stateHistory.push(state);
    context.state = state;
    append('state_transition', state, evidence);
  };
  const allowedTypes = intentKind === 'date' ? DATE_TYPES
    : intentKind === 'time' ? new Set([...TIME_TYPES, ...ZONE_TYPES])
      : ZONE_TYPES;

  return {
    intentKind,
    expected,
    acceptControl(controlInput) {
      const control = controlInput?.schema ? controlInput : createUniversalControl(controlInput || {});
      const semantic = compareSemanticIdentity(control);
      const typeMatched = allowedTypes.has(control.controlType);
      const validation = {
        ok: semantic.ok === true && typeMatched,
        code: semantic.ok !== true
          ? 'temporal_control_identity_mismatch'
          : typeMatched ? 'temporal_control_identity_matched' : 'temporal_control_type_mismatch',
        semantic,
        controlType: control.controlType,
      };
      context.control = control;
      context.controlValidation = validation;
      append('control_identity', 'resolve', validation);
      return validation;
    },
    recordResolution(phaseId, resolution = null) {
      append('resolution', clean(phaseId, 120) || 'unknown', resolution);
    },
    beforeDispatch(phaseId, resolution = null) {
      const id = clean(phaseId, 120).toLowerCase();
      if (id.includes('open')) transition(RUNTIME_STATES.OPENING, resolution);
      else if (id.includes('position') || id.includes('navigate')) transition(RUNTIME_STATES.POSITIONING, resolution);
      else transition(RUNTIME_STATES.SELECTING, resolution);
    },
    afterDispatch(phaseId, dispatched = null) {
      const id = clean(phaseId, 120).toLowerCase();
      append('dispatch', id || 'unknown', dispatched);
      if (id.includes('open')) transition(RUNTIME_STATES.OPEN, dispatched);
    },
    proveCommitted(observation = {}) {
      const data = observationData(observation);
      const raw = ownerValue(data)
        ?? data.selectedDate
        ?? data.inputValue
        ?? data.actualValue
        ?? data.valueAfter
        ?? data.selectedText;
      let actual = null;
      let matched = false;
      if (intentKind === 'date') {
        actual = normalizeDateValue(raw, input);
        matched = actual === expected;
      } else if (intentKind === 'time') {
        actual = normalizeTimeValue(raw);
        matched = actual === expected;
      } else {
        actual = clean(raw, 240);
        matched = context.matchMode === 'exact'
          ? actual.toLocaleLowerCase() === expected.toLocaleLowerCase()
          : actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
      }
      const proof = {
        matched,
        checked: actual != null && actual !== '',
        terminal: false,
        reason: matched ? `owner_${intentKind}_exact` : `owner_${intentKind}_mismatch`,
        evidence: { expected, actual, matchMode: context.matchMode },
      };
      context.finalProof = proof;
      append('proof', 'value_commit', proof);
      if (matched) transition(RUNTIME_STATES.VALUE_COMMITTED, proof.evidence);
      return proof;
    },
    snapshot() {
      return {
        schema: RUNTIME_TRACKER_SCHEMA,
        intentKind,
        expected,
        matchMode: context.matchMode,
        state: context.state,
        stateHistory: [...context.stateHistory],
        control: context.control,
        controlValidation: context.controlValidation,
        finalProof: context.finalProof,
        evidenceLedger: [...context.evidenceLedger],
      };
    },
  };
}

module.exports = {
  SCHEMA,
  RUNTIME_TRACKER_SCHEMA,
  RUNTIME_STATES,
  normalizeDateValue,
  normalizeTimeValue,
  parseMonthIdentity,
  deriveMonthYearNavigation,
  findExactCalendarDay,
  findExactTimeOption,
  findTimezoneOption,
  validateTemporalControl,
  executeDateTransaction,
  executeTimeTransaction,
  executeTimezoneTransaction,
  temporalInstant,
  compareTemporal,
  validateChronology,
  createTemporalRuntimeTracker,
};
