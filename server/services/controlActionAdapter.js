'use strict';

const crypto = require('node:crypto');
const actionLocatorResolver = require('./actionLocatorResolver');
const browserActionRegistry = require('./browserActionRegistry');
const calendarTimeTransaction = require('./calendarTimeTransaction');
const controlAdapterRegistry = require('./controlAdapterRegistry');
const interactionProtocols = require('./interactionProtocols');
const postActionEffectProof = require('./postActionEffectProof');
const semanticControlResolver = require('./semanticControlResolver');
const waitContract = require('./waitContract');
const widgetRoutines = require('./widgetRoutines');
const contracts = require('./controlActionContracts');

const {
  SCHEMA,
  assertControlActionPlan,
  buildIdempotency,
  buildPostcondition,
  buildResolutionInput,
  clean,
  exactTextMatch,
  normalizeRetryPolicy,
  normalizeText,
  retryDecision,
} = contracts;

const ACTION_ALIASES = Object.freeze({
  fill: 'fill',
  enter: 'fill',
  input: 'fill',
  set: 'fill',
  type: 'type',
  clear: 'clear',
  select: 'select',
  choose: 'select',
  pick: 'select',
  check: 'check',
  uncheck: 'uncheck',
  radio: 'radio',
  selectradio: 'radio',
  hover: 'hover',
  mouseover: 'hover',
  press: 'press',
  presskey: 'press',
  keypress: 'press',
  keyboard: 'press',
  date: 'date',
  calendar: 'date',
  datepicker: 'date',
  setdate: 'date',
  scroll: 'scroll',
  scrollto: 'scroll',
  scrollintoview: 'scroll',
  expand: 'expand',
  ensureexpanded: 'expand',
  collapse: 'collapse',
  ensurecollapsed: 'collapse',
});

const SCROLL_ELEMENT_FUNCTION = `(${function qaaiScrollTargetIntoView(el) {
  if (!el || el.nodeType !== 1) return JSON.stringify({ ok: false, reason: 'target_not_found' });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  const rect = el.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  const area = Math.max(1, rect.width * rect.height);
  return JSON.stringify({
    ok: true,
    visible: visibleWidth > 0 && visibleHeight > 0,
    intersectionRatio: (visibleWidth * visibleHeight) / area,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  });
}.toString()})`;

function pageScrollFunction({ axis = 'y', direction = 'forward', amount = 0, boundary = null } = {}) {
  const payload = {
    axis: axis === 'x' ? 'x' : 'y',
    direction: direction === 'backward' ? 'backward' : 'forward',
    amount: Math.max(0, Number(amount) || 0),
    boundary: ['start', 'end'].includes(boundary) ? boundary : null,
  };
  return `() => {
    const payload = ${JSON.stringify(payload)};
    const root = document.scrollingElement || document.documentElement;
    const before = payload.axis === 'x' ? root.scrollLeft : root.scrollTop;
    const extent = payload.axis === 'x' ? root.scrollWidth - root.clientWidth : root.scrollHeight - root.clientHeight;
    let desired;
    if (payload.boundary === 'start') desired = 0;
    else if (payload.boundary === 'end') desired = Math.max(0, extent);
    else desired = before + (payload.direction === 'backward' ? -1 : 1) * (payload.amount || (payload.axis === 'x' ? root.clientWidth : root.clientHeight) * 0.8);
    if (payload.axis === 'x') root.scrollLeft = desired; else root.scrollTop = desired;
    const after = payload.axis === 'x' ? root.scrollLeft : root.scrollTop;
    return JSON.stringify({ ok: true, axis: payload.axis, before, after, max: Math.max(0, extent), boundary: payload.boundary });
  }`;
}

function contentScrollFunction({ axis = 'y', direction = 'forward', amount = 0, boundary = null } = {}) {
  const payload = {
    axis: axis === 'x' ? 'x' : 'y',
    direction: direction === 'backward' ? 'backward' : 'forward',
    amount: Math.max(0, Number(amount) || 0),
    boundary: ['start', 'end'].includes(boundary) ? boundary : null,
  };
  return `(el) => {
    const payload = ${JSON.stringify(payload)};
    if (!el || el.nodeType !== 1) return JSON.stringify({ ok: false, reason: 'scroll_container_not_found' });
    const before = payload.axis === 'x' ? el.scrollLeft : el.scrollTop;
    const extent = payload.axis === 'x' ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    let desired;
    if (payload.boundary === 'start') desired = 0;
    else if (payload.boundary === 'end') desired = Math.max(0, extent);
    else desired = before + (payload.direction === 'backward' ? -1 : 1) * (payload.amount || (payload.axis === 'x' ? el.clientWidth : el.clientHeight) * 0.8);
    if (payload.axis === 'x') el.scrollLeft = desired; else el.scrollTop = desired;
    const after = payload.axis === 'x' ? el.scrollLeft : el.scrollTop;
    return JSON.stringify({ ok: true, axis: payload.axis, before, after, max: Math.max(0, extent), boundary: payload.boundary });
  }`;
}

function actionToken(step = {}) {
  return clean(step.action || step.verb || step.type || step.kind, 80).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function actionKind(step = {}) {
  return ACTION_ALIASES[actionToken(step)] || null;
}

function targetOf(step = {}) {
  return clean(step.element || step.target || step.field || step.locator_hint || step.locatorHint, 240) || null;
}

function dateOwnerTarget(value) {
  const authoredTarget = clean(value, 240);
  if (!authoredTarget) return null;
  return authoredTarget.replace(
    /\s+(?:calendar(?:\s+(?:button|icon|opener|trigger))?|date\s*picker(?:\s+(?:button|icon|opener|trigger))?)\s*$/i,
    '',
  ).trim() || authoredTarget;
}

function valueOf(step = {}) {
  const value = step.value != null ? step.value
    : step.text != null ? step.text
      : step.option != null ? step.option
        : step.input != null ? step.input
          : null;
  return value == null ? '' : String(value);
}

function selectCriterionOf(step = {}) {
  const supplied = step.selectionCriteria && typeof step.selectionCriteria === 'object'
    ? step.selectionCriteria
    : null;
  if (supplied) {
    const kind = clean(supplied.kind, 80).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const exactText = clean(
      supplied.text ?? supplied.value ?? supplied.expectedText ?? supplied.expectedLabel,
      1000,
    );
    if (['exact', 'exact_text', 'exact_value'].includes(kind) && exactText) {
      return { kind: 'exact', text: exactText, source: 'selectionCriteria' };
    }
    if (kind === 'ordinal' && exactText) {
      return {
        kind: 'exact',
        text: exactText,
        source: 'selectionCriteria',
        ordinal: Number.isInteger(Number(supplied.ordinal)) ? Number(supplied.ordinal) : null,
      };
    }

    const predicateText = clean(supplied.predicate, 1000);
    const containsValue = clean(
      supplied.field === 'visible_label' && clean(supplied.operator, 80).toLowerCase() === 'contains'
        ? supplied.value
        : null,
      1000,
    );
    const predicateMatch = predicateText.match(/(?:visible\s+)?label\s+contains\s+(.+)$/i);
    const containsText = containsValue || clean(predicateMatch && predicateMatch[1], 1000);
    if (['predicate', 'contains', 'contains_text'].includes(kind) && containsText) {
      return { kind: 'contains', text: containsText, source: 'selectionCriteria' };
    }
    return null;
  }

  const legacyValue = clean(valueOf(step), 1000);
  return legacyValue ? { kind: 'exact', text: legacyValue, source: 'value' } : null;
}

function roleOf(step = {}) {
  return clean(step.role || step.targetRole || step.controlRole, 80).toLowerCase() || null;
}

function makePhase({
  id,
  toolName,
  resolutionToolName = toolName,
  args = {},
  label = null,
  roleHints = [],
  tagHints = [],
  scope = null,
  resolutionRequired = true,
  branch = null,
  semanticTarget = null,
  allowUtilityDispatch = false,
} = {}) {
  browserActionRegistry.requireActionEntry(toolName);
  if (resolutionToolName) browserActionRegistry.requireActionEntry(resolutionToolName);
  const resolution = buildResolutionInput({ label, roleHints, tagHints, scope, required: resolutionRequired });
  return {
    id,
    toolName,
    resolutionToolName: resolution ? resolutionToolName : null,
    args: { ...args },
    resolution,
    freshObservationRequired: !!resolution,
    branch,
    semanticTarget: semanticTarget && typeof semanticTarget === 'object' ? { ...semanticTarget } : null,
    ...(allowUtilityDispatch ? { allowUtilityDispatch: true } : {}),
  };
}

function adapterWaitContract(step, postcondition) {
  const inferred = waitContract.buildWaitContract(step);
  const kind = inferred.kind === 'none' ? 'assertion' : inferred.kind;
  return {
    ...inferred,
    kind,
    adapterPostcondition: postcondition,
    expected: {
      ...(inferred.expected && typeof inferred.expected === 'object' ? inferred.expected : {}),
      adapterKind: postcondition.kind,
      exact: true,
    },
  };
}

function protocolNameFor({ toolName, role, intentKind = null }) {
  return interactionProtocols.classifyInteraction({ toolName, targetRole: role, intentKind });
}

function finalizePlan({ step, kind, variant = null, phases, idempotency, postcondition, retryPolicy, role = null, metadata = {} }) {
  const plan = {
    schema: SCHEMA,
    kind,
    variant,
    target: targetOf(step),
    role,
    phases,
    idempotency,
    postcondition,
    retryPolicy,
    waitContract: adapterWaitContract(step, postcondition),
    interactionProtocol: protocolNameFor({
      toolName: phases[0]?.toolName || '',
      role,
      intentKind: kind === 'date' ? 'date' : null,
    }),
    websiteNeutral: true,
    metadata: { ...metadata },
  };
  return assertControlActionPlan(controlAdapterRegistry.annotateActionPlan(plan, step));
}

function buildFillPlan(step, kind) {
  const label = targetOf(step);
  if (!label) throw new Error(`${kind} target is required.`);
  const valueRef = clean(step.valueRef || step.dataRef, 500) || null;
  const referenceBacked = Boolean(valueRef && step.value == null && step.input == null && step.option == null);
  const sensitive = step.sensitive === true || /password|passcode|secret|token|credential/i.test(label);
  const value = kind === 'clear' ? '' : (referenceBacked ? null : valueOf(step));
  const expected = referenceBacked ? { valueRef, sensitive } : value;
  const toolName = (kind === 'type' || kind === 'clear') ? 'browser_type' : 'browser_fill_form';
  const args = (kind === 'type' || kind === 'clear')
    ? { element: label, target: null, ...(referenceBacked ? { valueRef } : { text: value }) }
    : { fields: [{ name: label, element: label, type: roleOf(step) || 'textbox', target: null, ...(referenceBacked ? { valueRef } : { value, text: value }) }] };
  
  const isAppendOp = Boolean(
    step.append === true || step.type === 'Append' ||
    (step.action && /\bappend\b/i.test(step.action)) ||
    (label && /\bappend\b/i.test(label))
  );

  const postcondition = buildPostcondition({ 
    kind: referenceBacked ? 'value_ref_exact' : (isAppendOp ? 'value_ends_with' : 'value_exact'), 
    expected 
  });
  return finalizePlan({
    step,
    kind,
    role: roleOf(step) || 'textbox',
    phases: [makePhase({
      id: 'set-value',
      toolName,
      args,
      label,
      roleHints: ['textbox', 'searchbox', 'spinbutton', 'combobox'],
      tagHints: ['input', 'textarea'],
    })],
    idempotency: buildIdempotency({ mode: 'set_exact_value', expectedState: expected, retrySafe: true }),
    postcondition,
    retryPolicy: normalizeRetryPolicy(step.retryPolicy, { maxRetries: 1 }),
    metadata: { valueRef, referenceBacked, sensitive },
  });
}

function materializeReferencePhase(phase, value) {
  if (!phase || typeof phase !== 'object') throw new Error('Dispatch phase is required.');
  const args = JSON.parse(JSON.stringify(phase.args || {}));
  if (phase.toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
    args.fields = args.fields.map((field, index) => {
      if (index !== 0) return field;
      const materialized = { ...field, value: String(value), text: String(value) };
      delete materialized.valueRef;
      return materialized;
    });
  } else if (phase.toolName === 'browser_type') {
    args.text = String(value);
    delete args.valueRef;
  }
  return { ...phase, args };
}

function valueFingerprint(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function selectVariant(step = {}) {
  const explicit = clean(step.controlKind || step.widgetKind || step.selectKind || step.variant, 80).toLowerCase();
  const tag = clean(step.tag || step.targetTag, 40).toLowerCase();
  const role = roleOf(step);
  if (explicit === 'native' || tag === 'select') return 'native';
  if (['aria', 'custom', 'listbox', 'autocomplete'].includes(explicit)) return 'custom';
  if (role === 'listbox' || (role === 'combobox' && tag && tag !== 'select')) return 'custom';
  return 'adaptive';
}

function nativeSelectPhase(label, value, branch = null) {
  return makePhase({
    id: 'select-native-option',
    toolName: 'browser_select_option',
    args: { element: label, target: null, values: [value] },
    label,
    roleHints: ['combobox', 'listbox'],
    tagHints: ['select'],
    branch,
  });
}

function customSelectPhases(label, value, branch = null, match = 'exact') {
  return [
    makePhase({
      id: 'open-choice-control',
      toolName: 'browser_click',
      args: { element: label, target: null },
      label,
      roleHints: ['combobox', 'listbox', 'button'],
      scope: { purpose: 'choice_control' },
      branch,
    }),
    makePhase({
      id: 'open-choice-control-keyboard-assist',
      toolName: 'browser_press_key',
      resolutionToolName: 'browser_click',
      args: { element: label, target: null, key: 'ArrowDown' },
      label,
      roleHints: ['combobox', 'listbox', 'button', 'textbox', 'searchbox', 'spinbutton'],
      scope: { purpose: 'choice_control_keyboard_assist', ownerTarget: label },
      branch,
      semanticTarget: { kind: 'control_opener', controlKind: 'choice', ownerTarget: label },
    }),
    makePhase({
      id: match === 'contains' ? 'choose-matching-option' : 'choose-exact-option',
      toolName: 'browser_click',
      args: { element: value, target: null },
      label: value,
      roleHints: ['option', 'menuitemradio', 'menuitemcheckbox', 'treeitem'],
      scope: { ownerTarget: label, openedByPhase: 'open-choice-control' },
      branch,
      semanticTarget: { kind: 'option', name: value, match },
    }),
  ];
}

function buildSelectPlan(step) {
  const label = targetOf(step);
  const criterion = selectCriterionOf(step);
  if (!label) throw new Error('Select target is required.');
  if (!criterion) throw new Error('Select value or supported selectionCriteria is required.');
  const value = criterion.text;
  const requestedVariant = selectVariant(step);
  const variant = criterion.kind === 'contains' ? 'custom' : requestedVariant;
  const phases = variant === 'native'
    ? [nativeSelectPhase(label, value)]
    : variant === 'custom'
      ? customSelectPhases(label, value, null, criterion.kind)
      : [nativeSelectPhase(label, value, 'target_is_native_select'), ...customSelectPhases(label, value, 'target_is_aria_or_custom', criterion.kind)];
  const postcondition = buildPostcondition({
    kind: criterion.kind === 'contains' ? 'selection_contains' : 'selection_exact',
    expected: value,
  });
  return finalizePlan({
    step,
    kind: 'select',
    variant,
    role: roleOf(step) || 'combobox',
    phases,
    idempotency: buildIdempotency({ mode: 'ensure_exact_state', expectedState: value, retrySafe: true }),
    postcondition,
    retryPolicy: normalizeRetryPolicy(step.retryPolicy, { maxRetries: 1 }),
    metadata: {
      optionMatch: criterion.kind,
      selectionSource: criterion.source,
      ...(criterion.ordinal != null ? { authoredOrdinal: criterion.ordinal } : {}),
      reopenOnRetry: variant !== 'native',
    },
  });
}

function buildTogglePlan(step, kind) {
  const label = targetOf(step);
  if (!label) throw new Error(`${kind} target is required.`);
  const intendedChecked = kind !== 'uncheck';
  const toolName = intendedChecked ? 'browser_check' : 'browser_uncheck';
  const role = kind === 'radio' ? 'radio' : roleOf(step) || 'checkbox';
  const postcondition = buildPostcondition({ kind: 'checked_exact', expected: intendedChecked });
  return finalizePlan({
    step,
    kind,
    role,
    phases: [makePhase({
      id: intendedChecked ? 'ensure-checked' : 'ensure-unchecked',
      toolName,
      resolutionToolName: 'browser_click',
      args: { element: label, target: null },
      label,
      roleHints: kind === 'radio' ? ['radio', 'menuitemradio'] : ['checkbox', 'switch', 'menuitemcheckbox'],
      tagHints: ['input'],
    })],
    idempotency: buildIdempotency({ mode: 'ensure_exact_state', expectedState: intendedChecked, retrySafe: true }),
    postcondition,
    retryPolicy: normalizeRetryPolicy(step.retryPolicy, { maxRetries: 1 }),
  });
}

function buildDisclosurePlan(step, kind) {
  const label = targetOf(step);
  if (!label) throw new Error(`${kind} target is required.`);
  const intendedExpanded = kind === 'expand';
  const postcondition = buildPostcondition({ kind: 'expanded_exact', expected: intendedExpanded });
  return finalizePlan({
    step,
    kind,
    role: roleOf(step) || 'button',
    phases: [makePhase({
      id: intendedExpanded ? 'ensure-expanded' : 'ensure-collapsed',
      toolName: 'browser_click',
      resolutionToolName: 'browser_click',
      args: { element: label, target: null },
      label,
      roleHints: ['button', 'combobox', 'treeitem'],
      tagHints: ['button'],
      semanticTarget: { kind: 'control_opener', controlKind: 'disclosure', ownerTarget: label },
    })],
    idempotency: buildIdempotency({ mode: 'ensure_exact_state', expectedState: intendedExpanded, retrySafe: true }),
    postcondition,
    retryPolicy: normalizeRetryPolicy(step.retryPolicy, { maxRetries: 1 }),
    metadata: { stateAttribute: 'aria-expanded' },
  });
}

function tooltipExpectedText(step = {}) {
  return clean(
    step.expectedText
    || step.tooltipText
    || step.operationCheck?.condition?.text
    || step.verify?.text
    || step.expected,
    500,
  ) || null;
}

function buildHoverPlan(step) {
  const label = targetOf(step);
  if (!label) throw new Error('Hover target is required.');
  const expectedText = tooltipExpectedText(step);
  const postcondition = buildPostcondition({
    kind: expectedText ? 'tooltip_visible_exact' : 'hover_state_exact',
    expected: expectedText || true,
    source: expectedText ? 'rendered_tooltip_readback' : 'exact_target_hover_state',
  });
  return finalizePlan({
    step,
    kind: 'hover',
    role: roleOf(step),
    phases: [makePhase({
      id: 'hover-target',
      toolName: 'browser_hover',
      args: { element: label, target: null },
      label,
      roleHints: roleOf(step) ? [roleOf(step)] : [],
    })],
    idempotency: buildIdempotency({ mode: 'ensure_exact_state', expectedState: postcondition.expected, retrySafe: true }),
    postcondition,
    retryPolicy: normalizeRetryPolicy(step.retryPolicy, { maxRetries: 1 }),
  });
}

function stateDescriptor(step = {}) {
  const source = step.postcondition || step.expectedState || step.operationCheck?.condition || step.verify || null;
  if (source && typeof source === 'object') return { ...source };
  return null;
}

function buildPressPlan(step) {
  const key = clean(step.key || step.value || step.text, 120);
  if (!key) throw new Error('Keyboard/Press key is required.');
  const expected = stateDescriptor(step);
  const label = targetOf(step);
  const retrySafe = step.retrySafe === true;
  const postcondition = expected ? buildPostcondition({ kind: 'state_exact', expected, source: 'typed_state_readback' }) : null;
  return finalizePlan({
    step,
    kind: 'press',
    role: roleOf(step),
    phases: [makePhase({
      id: 'press-key',
      toolName: 'browser_press_key',
      resolutionToolName: label ? 'browser_hover' : null,
      args: { key },
      label,
      roleHints: roleOf(step) ? [roleOf(step)] : [],
      resolutionRequired: !!label,
    })],
    idempotency: buildIdempotency({ mode: retrySafe ? 'effect_bound' : 'non_idempotent', expectedState: expected, retrySafe }),
    postcondition,
    retryPolicy: normalizeRetryPolicy(step.retryPolicy, { maxRetries: retrySafe ? 1 : 0 }),
    metadata: { key, focusedTargetRequired: !!label },
  });
}

function canonicalDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = clean(value, 120);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function dateParts(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return { year, month, day };
}

function dateVariant(step = {}) {
  const explicit = clean(step.controlKind || step.widgetKind || step.dateKind || step.variant, 80).toLowerCase();
  const inputType = clean(step.inputType || step.typeAttribute, 40).toLowerCase();
  if (explicit === 'native' || inputType === 'date') return 'native';
  if (['semantic', 'calendar', 'datepicker', 'custom'].includes(explicit)) return 'semantic';
  return 'adaptive';
}

function semanticCalendarPhases(label, isoDate, branch = null) {
  const parts = dateParts(isoDate);
  return [
    makePhase({
      id: 'open-calendar',
      toolName: 'browser_click',
      args: { element: label, target: null },
      label,
      roleHints: ['textbox', 'combobox', 'button'],
      branch,
    }),
    makePhase({
      id: 'position-calendar',
      toolName: 'browser_click',
      args: { element: null, target: null },
      label: null,
      roleHints: ['button', 'combobox', 'spinbutton'],
      scope: { openedByPhase: 'open-calendar', roles: ['dialog', 'grid'] },
      branch,
      semanticTarget: {
        kind: 'calendar_position',
        dateParts: parts,
        navigation: { compareVisibleMonthYear: true, directionFromDelta: true },
        acceptedTools: ['browser_click', 'browser_select_option'],
        labelIndependent: true,
      },
    }),
    makePhase({
      id: 'choose-calendar-day',
      toolName: 'browser_click',
      args: { element: isoDate, target: null },
      label: null,
      roleHints: ['gridcell', 'button'],
      scope: { openedByPhase: 'open-calendar', roles: ['dialog', 'grid'] },
      branch,
      semanticTarget: {
        kind: 'calendar_day',
        dateParts: parts,
        requireCurrentMonth: true,
        excludeDisabled: true,
        match: 'exact_date_parts',
        labelIndependent: true,
      },
    }),
  ];
}

function nativeDatePhase(label, isoDate, branch = null) {
  return makePhase({
    id: 'set-native-date',
    toolName: 'browser_fill_form',
    // browser_fill_form accepts accessibility control roles, not HTML input
    // types. A native <input type="date"> is still filled as a textbox with
    // its locale-independent ISO value.
    args: { fields: [{ name: label, element: label, type: 'textbox', target: null, value: isoDate, text: isoDate }] },
    label,
    roleHints: ['textbox'],
    tagHints: ['input'],
    branch,
  });
}

function buildDatePlan(step) {
  const authoredTarget = targetOf(step);
  const label = dateOwnerTarget(authoredTarget);
  if (!label) throw new Error('Calendar/Date target is required.');
  const isoDate = canonicalDate(step.date || step.value || step.text);
  if (!isoDate) throw new Error('Calendar/Date requires an unambiguous ISO date (YYYY-MM-DD).');
  const variant = dateVariant(step);
  const phases = variant === 'native'
    ? [nativeDatePhase(label, isoDate)]
    : variant === 'semantic'
      ? semanticCalendarPhases(label, isoDate)
      : [nativeDatePhase(label, isoDate, 'target_is_native_date_input'), ...semanticCalendarPhases(label, isoDate, 'target_is_semantic_calendar')];
  const postcondition = buildPostcondition({ kind: 'date_exact', expected: isoDate });
  return finalizePlan({
    step,
    kind: 'date',
    variant,
    role: roleOf(step) || 'textbox',
    phases,
    idempotency: buildIdempotency({ mode: 'set_exact_value', expectedState: isoDate, retrySafe: true }),
    postcondition,
    retryPolicy: normalizeRetryPolicy(step.retryPolicy, { maxRetries: 1 }),
    metadata: {
      isoDate,
      dateParts: dateParts(isoDate),
      localeIndependent: true,
      ownerTarget: label,
      authoredTarget,
    },
  });
}

function scrollMode(step = {}) {
  const explicit = clean(step.scrollMode || step.mode || step.variant, 80).toLowerCase();
  if (['target', 'element', 'into_view', 'intoview'].includes(explicit)) return 'target';
  if (['content', 'container'].includes(explicit)) return 'content';
  if (['page', 'document'].includes(explicit)) return 'page';
  return targetOf(step) ? 'target' : 'page';
}

function buildScrollPlan(step) {
  const mode = scrollMode(step);
  const label = targetOf(step);
  const direction = clean(step.direction, 40).toLowerCase() === 'backward' ? 'backward' : 'forward';
  const axis = clean(step.axis, 10).toLowerCase() === 'x' ? 'x' : 'y';
  const boundary = ['start', 'end'].includes(clean(step.boundary, 20).toLowerCase()) ? clean(step.boundary, 20).toLowerCase() : null;
  const amount = Math.max(0, Number(step.amount || step.delta || 0) || 0);
  if ((mode === 'target' || mode === 'content') && !label) throw new Error(`${mode} scroll target is required.`);
  const phase = mode === 'target'
    ? makePhase({
        id: 'scroll-target-into-view',
        toolName: 'browser_evaluate',
        resolutionToolName: 'browser_hover',
        args: { element: label, target: null, function: SCROLL_ELEMENT_FUNCTION },
        label,
        roleHints: roleOf(step) ? [roleOf(step)] : [],
        allowUtilityDispatch: true,
      })
    : makePhase({
        id: mode === 'content' ? 'scroll-content' : 'scroll-page',
        toolName: 'browser_evaluate',
        resolutionToolName: mode === 'content' ? 'browser_hover' : null,
        args: {
          element: label,
          target: null,
          function: mode === 'content'
            ? contentScrollFunction({ axis, direction, amount, boundary })
            : pageScrollFunction({ axis, direction, amount, boundary }),
        },
        label,
        roleHints: mode === 'content' ? ['region', 'listbox', 'grid', 'tree'] : [],
        resolutionRequired: mode === 'content',
        allowUtilityDispatch: true,
      });
  const postcondition = buildPostcondition({
    kind: mode === 'target' ? 'target_visible_exact' : 'scroll_position_exact',
    expected: mode === 'target' ? { visible: true, minimumIntersectionRatio: Number(step.minimumIntersectionRatio) || 0.01 }
      : { axis, direction, amount, boundary, contentEffect: step.contentEffect || null },
    source: mode === 'target' ? 'intersection_readback' : 'bounded_scroll_readback',
  });
  const relativeScroll = !boundary && mode !== 'target';
  return finalizePlan({
    step,
    kind: 'scroll',
    variant: mode,
    role: roleOf(step),
    phases: [phase],
    idempotency: buildIdempotency({
      mode: relativeScroll ? 'effect_bound' : 'ensure_exact_state',
      expectedState: postcondition.expected,
      retrySafe: !relativeScroll,
    }),
    postcondition,
    retryPolicy: normalizeRetryPolicy(step.retryPolicy, { maxRetries: relativeScroll ? 0 : 1 }),
    metadata: { mode, axis, direction, amount, boundary },
  });
}

function buildControlActionPlan(step = {}) {
  const kind = actionKind(step);
  if (!kind) throw new Error(`Unsupported control action: ${step.action || step.verb || step.type || '(missing)'}`);
  if (kind === 'fill' || kind === 'type' || kind === 'clear') return buildFillPlan(step, kind);
  if (kind === 'select') return buildSelectPlan(step);
  if (kind === 'check' || kind === 'uncheck' || kind === 'radio') return buildTogglePlan(step, kind);
  if (kind === 'hover') return buildHoverPlan(step);
  if (kind === 'press') return buildPressPlan(step);
  if (kind === 'date') return buildDatePlan(step);
  if (kind === 'scroll') return buildScrollPlan(step);
  if (kind === 'expand' || kind === 'collapse') return buildDisclosurePlan(step, kind);
  throw new Error(`No control adapter for action: ${kind}`);
}

function phaseById(plan, phaseId) {
  return (plan?.phases || []).find((phase) => phase.id === phaseId) || null;
}

function resolverArgsForPhase(phase) {
  const label = phase?.resolution?.label;
  const toolName = phase?.resolutionToolName;
  if (toolName === 'browser_fill_form') {
    return { fields: [{ name: label, element: label, target: null }] };
  }
  return { element: label, target: null };
}

async function resolvePhaseTarget({
  session,
  plan,
  phaseId,
  snapshotText,
  pageUrl = null,
  resolver = actionLocatorResolver,
  semanticCandidates = null,
  calendarState = null,
  semanticResolver = semanticControlResolver,
} = {}) {
  const phase = phaseById(plan, phaseId);
  if (!phase) return { ok: false, code: 'unknown_dispatch_phase', phaseId };
  if (!phase.resolution) return { ok: true, phase, actionLocator: null, resolutionNotRequired: true };
  if (!snapshotText) return { ok: false, code: 'fresh_observation_required', phase };
  if (!phase.resolution.label && phase.semanticTarget) {
    if (Array.isArray(semanticCandidates)) {
      const semanticResolution = semanticResolver.resolveSemanticTarget({
        semanticTarget: phase.semanticTarget,
        candidates: semanticCandidates,
        calendarState,
      });
      if (semanticResolution && semanticResolution.ok === true) {
        const candidate = semanticResolution.candidate || semanticResolution.operations?.[0]?.candidate || null;
        return {
          ok: true,
          phase,
          semanticResolution,
          resolvedCandidate: candidate,
          actionLocator: candidate?.actionLocator || candidate?.locator || null,
          phaseAlreadySatisfied: semanticResolution.alreadySatisfied === true,
        };
      }
      return {
        ok: false,
        code: semanticResolution?.code || 'semantic_resolution_failed',
        phase,
        semanticTarget: phase.semanticTarget,
        semanticResolution,
      };
    }
    return {
      ok: false,
      code: 'semantic_resolution_required',
      phase,
      semanticTarget: phase.semanticTarget,
      resolutionInput: phase.resolution,
    };
  }
  const result = await resolver.resolveVerifiedForTool({
    session,
    toolName: phase.resolutionToolName,
    args: resolverArgsForPhase(phase),
    snapshotText,
    pageUrl,
    elementLabel: phase.resolution.label,
  });
  const verified = result?.actionLocator && resolver.isVerifiedActionLocator(result.actionLocator);
  return verified
    ? { ok: true, phase, actionLocator: result.actionLocator, fulfilledBy: result.fulfilledBy || null }
    : { ok: false, code: 'unique_live_target_not_proven', phase, gap: result?.gap || null, diagnostic: result?.diagnostic || null };
}

function bindResolvedTarget(phase, ref) {
  if (!phase || typeof phase !== 'object') throw new Error('Dispatch phase is required.');
  const target = clean(ref, 120);
  if (!target) throw new Error('Resolved target ref is required.');
  const args = JSON.parse(JSON.stringify(phase.args || {}));
  if (phase.toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
    args.fields = args.fields.map((field, index) => index === 0 ? { ...field, target, ref: target } : field);
  } else if (phase.toolName !== 'browser_press_key') {
    args.target = target;
    args.ref = target;
  } else {
    args.resolvedTarget = target;
  }
  return { ...phase, args };
}

function proofResult(kind, matched, reason, details = null) {
  return {
    kind,
    matched: matched === true,
    checked: true,
    status: matched === true ? 'pass' : 'blocked',
    reason,
    evidence: reason,
    details,
  };
}

function directActualValue(observation = {}) {
  if (observation.actualValue != null) return observation.actualValue;
  if (observation.valueAfter != null) return observation.valueAfter;
  if (observation.selectedValue != null) return observation.selectedValue;
  if (observation.inputValue != null) return observation.inputValue;
  return null;
}

function proveValue(plan, observation, options = {}) {
  const referenceBacked = plan.postcondition.kind === 'value_ref_exact';
  const expected = referenceBacked ? options.resolvedValue : plan.postcondition.expected;
  if (referenceBacked && expected == null) {
    return proofResult('value_ref_exact', false, 'referenced value was unavailable for exact readback proof', {
      valueRef: plan.metadata?.valueRef || null,
      expectedFingerprint: null,
      actualFingerprint: null,
    });
  }
  const direct = directActualValue(observation);
  if (direct != null) {
    const matched = exactTextMatch(direct, expected);
    if (referenceBacked) {
      return proofResult('value_ref_exact', matched, matched ? 'secure target value fingerprint confirmed' : 'secure target value fingerprint did not match', {
        valueRef: plan.metadata?.valueRef || null,
        expectedFingerprint: valueFingerprint(expected),
        actualFingerprint: valueFingerprint(direct),
        nonEmpty: String(direct).length > 0,
      });
    }
    return proofResult('value_exact', matched, matched ? 'exact target value confirmed' : 'exact target value did not match', { actual: direct, expected });
  }
  if (referenceBacked) {
    const observedFingerprint = observation.valueFingerprint || observation.actualValueFingerprint || null;
    const expectedFingerprint = valueFingerprint(expected);
    const matched = Boolean(observedFingerprint && observedFingerprint === expectedFingerprint);
    return proofResult('value_ref_exact', matched, matched ? 'secure target value fingerprint confirmed' : 'secure target value fingerprint was unavailable or did not match', {
      valueRef: plan.metadata?.valueRef || null,
      expectedFingerprint,
      actualFingerprint: observedFingerprint,
      nonEmpty: observation.valueNonEmpty === true,
    });
  }
  const certified = widgetRoutines.certifyFieldReadback({
    fieldLabel: plan.target,
    intendedValue: expected,
    snapshotAfter: observation.snapshotAfter || observation.snapshotText || '',
  });
  return proofResult('value_exact', certified.certified, certified.reason, certified);
}

function proveSelection(plan, observation) {
  const expected = plan.postcondition.expected;
  const channels = [
    directActualValue(observation),
    observation.selectedText,
    ...(Array.isArray(observation.selectedValues) ? observation.selectedValues : []),
    ...(Array.isArray(observation.selectedTexts) ? observation.selectedTexts : []),
  ].filter((value) => value != null);
  if (channels.length) {
    const contains = plan.postcondition.kind === 'selection_contains';
    const expectedTime = calendarTimeTransaction.normalizeTimeValue(expected);
    const matched = channels.some((value) => {
      if (contains) {
        return clean(value, 2000).toLowerCase().includes(clean(expected, 2000).toLowerCase());
      }
      if (exactTextMatch(value, expected)) return true;
      const actualTime = calendarTimeTransaction.normalizeTimeValue(value);
      return Boolean(expectedTime && actualTime && expectedTime === actualTime);
    });
    const kind = contains ? 'selection_contains' : 'selection_exact';
    return proofResult(
      kind,
      matched,
      matched
        ? (contains ? 'selected value or visible option text contains the required text' : 'exact selected value or visible option text confirmed')
        : (contains ? 'selected value and visible option text did not contain the required text' : 'selected value and visible option text did not exactly match'),
      { actual: channels, expected },
    );
  }
  if (plan.postcondition.kind === 'selection_contains') {
    const snapshot = clean(observation.snapshotAfterSelect || observation.snapshotAfter || observation.snapshotText, 20_000);
    const matched = snapshot.toLowerCase().includes(clean(expected, 2000).toLowerCase());
    return proofResult('selection_contains', matched, matched ? 'selected control snapshot contains the required text' : 'selected control did not expose the required text', { expected });
  }
  if (plan.variant === 'custom' || observation.snapshotAfterOpen) {
    const certified = widgetRoutines.certifyDropdownSelection({
      controlLabel: plan.target,
      optionLabel: expected,
      snapshotBeforeOpen: observation.snapshotBeforeOpen || '',
      snapshotAfterOpen: observation.snapshotAfterOpen || '',
      snapshotAfterSelect: observation.snapshotAfterSelect || observation.snapshotAfter || '',
      allowPartialOption: false,
    });
    return proofResult('selection_exact', certified.certified, certified.reason, certified);
  }
  return proofResult('selection_exact', false, 'exact selected value was not readable', { expected });
}

function booleanState(observation = {}) {
  if (typeof observation.checked === 'boolean') return observation.checked;
  if (typeof observation.checkedAfter === 'boolean') return observation.checkedAfter;
  if (typeof observation.ariaChecked === 'boolean') return observation.ariaChecked;
  if (typeof observation.ariaChecked === 'string') {
    if (observation.ariaChecked === 'true') return true;
    if (observation.ariaChecked === 'false') return false;
  }
  return null;
}

function proveToggle(plan, observation) {
  const expected = plan.postcondition.expected === true;
  const direct = booleanState(observation);
  if (direct != null) {
    const matched = direct === expected;
    return proofResult('checked_exact', matched, matched ? 'exact checked state confirmed' : 'checked state did not match', { actual: direct, expected });
  }
  const certified = widgetRoutines.certifyToggleState({
    controlLabel: plan.target,
    intendedChecked: expected,
    snapshotAfter: observation.snapshotAfter || observation.snapshotText || '',
  });
  return proofResult('checked_exact', certified.certified, certified.reason, certified);
}

function expandedState(observation = {}) {
  if (typeof observation.expanded === 'boolean') return observation.expanded;
  if (typeof observation.expandedAfter === 'boolean') return observation.expandedAfter;
  if (typeof observation.ariaExpanded === 'boolean') return observation.ariaExpanded;
  if (typeof observation.ariaExpanded === 'string') {
    if (observation.ariaExpanded === 'true') return true;
    if (observation.ariaExpanded === 'false') return false;
  }
  return null;
}

function proveDisclosure(plan, observation) {
  const expected = plan.postcondition.expected === true;
  const actual = expandedState(observation);
  const matched = actual != null && actual === expected;
  return proofResult(
    'expanded_exact',
    matched,
    matched ? 'exact expanded state confirmed' : 'expanded state did not match',
    { actual, expected },
  );
}

function proveHover(plan, observation) {
  if (plan.postcondition.kind === 'hover_state_exact') {
    const matched = observation.targetHovered === true;
    return proofResult('hover_state_exact', matched, matched ? 'exact target is hovered' : 'exact target hover state was not observed');
  }
  const visible = observation.tooltipVisible === true;
  const actual = observation.tooltipText;
  const expected = plan.postcondition.expected;
  const matched = visible && actual != null && exactTextMatch(actual, expected);
  return proofResult('tooltip_visible_exact', matched, matched ? 'rendered tooltip text matched exactly' : 'rendered tooltip text was not proven exactly', { visible, actual, expected });
}

function sameUrl(actual, expected) {
  const normalize = (value) => clean(value, 2000).replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  return normalize(actual) === normalize(expected);
}

function proveStateDescriptor(expected = {}, observation = {}) {
  const kind = clean(expected.kind || expected.type, 80).toLowerCase();
  if (kind === 'value' || kind === 'value_exact') return exactTextMatch(directActualValue(observation), expected.value ?? expected.expected);
  if (kind === 'value_ends_with') {
    const actual = normalize(directActualValue(observation));
    const expectedStr = normalize(expected.value ?? expected.expected);
    return actual && expectedStr && actual.endsWith(expectedStr);
  }
  if (kind === 'focus') return exactTextMatch(observation.focusedTarget, expected.target || expected.expected);
  if (kind === 'visible') return observation.visible === true && (!expected.target || exactTextMatch(observation.visibleTarget, expected.target));
  if (kind === 'hidden') return observation.visible === false;
  if (kind === 'url') return sameUrl(observation.url, expected.url || expected.expected);
  if (kind === 'attribute') return exactTextMatch(observation.attributes?.[expected.name], expected.value);
  if (kind === 'effect') {
    const effect = postActionEffectProof.proveEffect(observation.effectInput || {});
    return effect.proven === true && effect.kind === expected.effect;
  }
  return false;
}

function provePress(plan, observation) {
  const expected = plan.postcondition.expected || {};
  const matched = proveStateDescriptor(expected, observation);
  return proofResult('state_exact', matched, matched ? 'typed keyboard postcondition matched exactly' : 'typed keyboard postcondition did not match', { expected });
}

function proveDate(plan, observation) {
  const expected = plan.postcondition.expected;
  const rawActual = observation.selectedDate || observation.inputValue || observation.actualValue || observation.valueAfter;
  const actual = calendarTimeTransaction.normalizeDateValue(rawActual, plan.metadata || {});
  const matched = !!actual && actual === expected;
  return proofResult('date_exact', matched, matched ? 'exact calendar date confirmed' : 'calendar date did not exactly match', {
    actual,
    expected,
    rawActual,
  });
}

function proveScroll(plan, observation) {
  if (plan.variant === 'target') {
    const minimum = Number(plan.postcondition.expected?.minimumIntersectionRatio) || 0.01;
    const ratio = Number(observation.intersectionRatio);
    const matched = observation.visible === true && Number.isFinite(ratio) && ratio >= minimum;
    return proofResult('target_visible_exact', matched, matched ? 'target visibility threshold confirmed' : 'target visibility threshold not reached', { ratio, minimum });
  }
  const expected = plan.postcondition.expected || {};
  const before = Number(observation.before);
  const after = Number(observation.after);
  const max = Number(observation.max);
  let matched = false;
  if (expected.contentEffect && observation.contentEffectMatched === true) matched = true;
  else if (expected.boundary === 'start') matched = Number.isFinite(after) && after === 0;
  else if (expected.boundary === 'end') matched = Number.isFinite(after) && Number.isFinite(max) && after === max;
  else if (Number.isFinite(before) && Number.isFinite(after)) {
    const minimumDelta = Math.max(1, Number(expected.amount) || 1);
    matched = expected.direction === 'backward' ? before - after >= minimumDelta : after - before >= minimumDelta;
  }
  return proofResult('scroll_position_exact', matched, matched ? 'bounded scroll effect confirmed' : 'bounded scroll effect not confirmed', { before, after, max, expected });
}

function proveControlAction(plan, observation = {}, options = {}) {
  if (!plan || plan.schema !== SCHEMA) return proofResult('invalid_plan', false, 'valid control action plan is required');
  if (plan.kind === 'fill' || plan.kind === 'type') return proveValue(plan, observation, options);
  if (plan.kind === 'select') return proveSelection(plan, observation);
  if (['check', 'uncheck', 'radio'].includes(plan.kind)) return proveToggle(plan, observation);
  if (plan.kind === 'hover') return proveHover(plan, observation);
  if (plan.kind === 'press') return provePress(plan, observation);
  if (plan.kind === 'date') return proveDate(plan, observation);
  if (plan.kind === 'scroll') return proveScroll(plan, observation);
  if (plan.kind === 'expand' || plan.kind === 'collapse') return proveDisclosure(plan, observation);
  return proofResult('unsupported_action', false, `No postcondition proof adapter for ${plan.kind}`);
}

function alreadySatisfied(plan, observation = {}, options = {}) {
  if (!plan?.idempotency?.alreadySatisfiedIsSuccess) return { satisfied: false, reason: 'short_circuit_disabled' };
  if (plan.idempotency.mode === 'non_idempotent') return { satisfied: false, reason: 'non_idempotent_action' };
  const proof = proveControlAction(plan, observation, options);
  return { satisfied: proof.matched === true, reason: proof.matched ? 'exact_postcondition_already_satisfied' : proof.reason, proof };
}

module.exports = {
  ACTION_ALIASES,
  SCROLL_ELEMENT_FUNCTION,
  actionKind,
  targetOf,
  valueOf,
  canonicalDate,
  buildControlActionPlan,
  resolvePhaseTarget,
  bindResolvedTarget,
  materializeReferencePhase,
  valueFingerprint,
  proveControlAction,
  alreadySatisfied,
  retryDecision,
  pageScrollFunction,
  contentScrollFunction,
  _proveStateDescriptor: proveStateDescriptor,
};
