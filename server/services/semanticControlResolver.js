'use strict';

function clean(value, max = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function integer(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function dateParts(value) {
  if (!value || typeof value !== 'object') return null;
  const year = integer(value.year);
  const month = integer(value.month);
  const day = integer(value.day);
  if (year == null || month == null || day == null) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function candidateDateParts(candidate = {}) {
  return dateParts(candidate.dateParts || candidate.date || candidate.semanticDate || {
    year: candidate.year,
    month: candidate.month,
    day: candidate.day,
  });
}

function disabled(candidate = {}) {
  return candidate.disabled === true
    || candidate.enabled === false
    || candidate.ariaDisabled === true
    || candidate.ariaDisabled === 'true';
}

function candidateIdentity(candidate = {}) {
  return clean(candidate.ref || candidate.id || candidate.expression || candidate.selector || candidate.name, 500) || null;
}

function unique(candidates, reason) {
  const usable = (candidates || []).filter(Boolean);
  if (usable.length === 1) return { ok: true, candidate: usable[0], identity: candidateIdentity(usable[0]), reason };
  if (usable.length === 0) return { ok: false, code: 'semantic_target_not_found', candidates: [], reason };
  return {
    ok: false,
    code: 'semantic_target_ambiguous',
    candidates: usable.map((candidate) => ({ identity: candidateIdentity(candidate), role: candidate.role || null })),
    reason,
  };
}

function resolveCalendarDay(semanticTarget, candidates = []) {
  const expected = dateParts(semanticTarget && semanticTarget.dateParts);
  if (!expected) return { ok: false, code: 'invalid_calendar_day_contract' };
  const roles = new Set(['gridcell', 'button']);
  const matches = candidates.filter((candidate) => {
    const actual = candidateDateParts(candidate);
    if (!actual || disabled(candidate)) return false;
    if (roles.has(String(candidate.role || '').toLowerCase()) === false) return false;
    if (semanticTarget.requireCurrentMonth === true && candidate.currentMonth !== true) return false;
    return actual.year === expected.year && actual.month === expected.month && actual.day === expected.day;
  });
  const actionable = matches.filter((candidate) => clean(candidate.ref, 500));
  if (!actionable.length && matches.length) {
    return {
      ok: false,
      code: 'semantic_target_ref_unavailable',
      candidates: matches.map((candidate) => ({ identity: candidateIdentity(candidate), role: candidate.role || null })),
      reason: 'calendar_day_exact_date_parts',
    };
  }
  if (actionable.length > 1) {
    const hitTargets = actionable.filter((candidate) => candidate.hitTarget === true);
    if (hitTargets.length === 1) return unique(hitTargets, 'calendar_day_exact_hit_target');
  }
  return unique(actionable, 'calendar_day_exact_date_parts');
}

function navigationDirection(delta) {
  if (delta > 0) return 'forward';
  if (delta < 0) return 'backward';
  return null;
}

function semanticDirection(candidate = {}) {
  const direct = clean(candidate.direction || candidate.semanticDirection || candidate.navigationDirection, 40).toLowerCase();
  if (['forward', 'next', 'increment'].includes(direct)) return 'forward';
  if (['backward', 'previous', 'decrement'].includes(direct)) return 'backward';
  const action = clean(candidate.semanticAction || candidate.action, 40).toLowerCase();
  if (['increment', 'increase'].includes(action)) return 'forward';
  if (['decrement', 'decrease'].includes(action)) return 'backward';
  return null;
}

function exactSetter(candidates, axis, expected) {
  return candidates.filter((candidate) => {
    if (disabled(candidate)) return false;
    const candidateAxis = clean(candidate.axis || candidate.calendarAxis || candidate.controlKind, 40).toLowerCase();
    const action = clean(candidate.semanticAction || candidate.action, 40).toLowerCase();
    const value = integer(candidate.value ?? candidate.numericValue ?? candidate.datePartValue);
    return candidateAxis === axis && ['set', 'select', 'option'].includes(action) && value === expected;
  });
}

function resolveCalendarPosition(semanticTarget, candidates = [], calendarState = {}) {
  const expected = dateParts(semanticTarget && semanticTarget.dateParts);
  const currentYear = integer(calendarState.year);
  const currentMonth = integer(calendarState.month);
  if (!expected || currentYear == null || currentMonth == null || currentMonth < 1 || currentMonth > 12) {
    return { ok: false, code: 'calendar_position_state_missing' };
  }
  if (currentYear === expected.year && currentMonth === expected.month) {
    return { ok: true, alreadySatisfied: true, reason: 'calendar_month_year_already_positioned', operations: [] };
  }

  const yearSetter = unique(exactSetter(candidates, 'year', expected.year), 'calendar_year_exact_value');
  const monthSetter = unique(exactSetter(candidates, 'month', expected.month), 'calendar_month_exact_value');
  if (yearSetter.ok && monthSetter.ok) {
    return {
      ok: true,
      alreadySatisfied: false,
      reason: 'calendar_month_year_exact_setters',
      operations: [
        { kind: 'set_year', candidate: yearSetter.candidate, expected: expected.year },
        { kind: 'set_month', candidate: monthSetter.candidate, expected: expected.month },
      ],
    };
  }

  const deltaMonths = (expected.year - currentYear) * 12 + (expected.month - currentMonth);
  const direction = navigationDirection(deltaMonths);
  const navigators = candidates.filter((candidate) => !disabled(candidate) && semanticDirection(candidate) === direction);
  const navigator = unique(navigators, `calendar_navigation_${direction || 'none'}`);
  if (!navigator.ok) {
    return {
      ...navigator,
      deltaMonths,
      direction,
      code: navigator.code || 'calendar_navigation_control_not_found',
    };
  }
  return {
    ok: true,
    alreadySatisfied: false,
    reason: 'calendar_directional_navigation',
    deltaMonths,
    direction,
    operations: [{
      kind: 'navigate_month',
      direction,
      repeat: Math.abs(deltaMonths),
      candidate: navigator.candidate,
    }],
  };
}

function resolveSemanticTarget({ semanticTarget, candidates = [], calendarState = null } = {}) {
  const kind = clean(semanticTarget && semanticTarget.kind, 80).toLowerCase();
  if (kind === 'calendar_day') return resolveCalendarDay(semanticTarget, candidates);
  if (kind === 'calendar_position') return resolveCalendarPosition(semanticTarget, candidates, calendarState || {});
  return { ok: false, code: 'unsupported_semantic_target', kind: kind || null };
}

module.exports = {
  resolveSemanticTarget,
  resolveCalendarDay,
  resolveCalendarPosition,
  _candidateDateParts: candidateDateParts,
  _semanticDirection: semanticDirection,
};
