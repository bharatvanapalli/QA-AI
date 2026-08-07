'use strict';

const CALENDAR_CANDIDATE_FUNCTION = `() => {
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const attr = (node, name) => node && node.getAttribute ? clean(node.getAttribute(name)) : '';
  const bool = (value) => /^(?:1|true|yes)$/i.test(clean(value));
  const integer = (value) => { const n = Number(value); return Number.isInteger(n) ? n : null; };
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const monthPattern = months.join('|');
  const monthState = (value) => {
    const text = clean(value).toLowerCase();
    let match = text.match(new RegExp('\\\\b(' + monthPattern + ')\\\\s+(\\\\d{4})\\\\b', 'i'));
    if (match) return { year: Number(match[2]), month: months.indexOf(match[1].toLowerCase()) + 1 };
    match = text.match(new RegExp('\\\\b(\\\\d{4})\\\\s+(' + monthPattern + ')\\\\b', 'i'));
    return match ? { year: Number(match[1]), month: months.indexOf(match[2].toLowerCase()) + 1 } : null;
  };
  const exactDate = (value) => {
    const text = clean(value);
    const match = text.match(/(?:^|\\D)(\\d{4})[-/]([01]?\\d)[-/]([0-3]?\\d)(?:\\D|$)/);
    if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const named = text.toLowerCase().match(new RegExp('\\\\b(' + monthPattern + ')\\\\s+(\\\\d{1,2})(?:st|nd|rd|th)?[,]?\\\\s+(\\\\d{4})\\\\b', 'i'));
    if (named) return { year: Number(named[3]), month: months.indexOf(named[1].toLowerCase()) + 1, day: Number(named[2]) };
    if (/^\\d{1,2}$/.test(text)) return null;
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed)) return null;
    const date = new Date(parsed);
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  };
  const role = (node) => attr(node, 'role') || ({ BUTTON: 'button', OPTION: 'option', SELECT: 'combobox', TD: 'gridcell', SPAN: 'generic' }[node.tagName] || '');
  const name = (node) => clean(attr(node, 'aria-label') || attr(node, 'title') || node.innerText || node.textContent);
  const visible = (node) => { const s = getComputedStyle(node); const r = node.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const enabled = (node) => !node.disabled && attr(node, 'aria-disabled') !== 'true';
  const hitTarget = (node) => {
    if (!node || !node.getBoundingClientRect || !document.elementFromPoint) return false;
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2));
    if (!hit) return false;
    const owner = hit.closest && hit.closest('button, [role="button"], [role="gridcell"], td, option, [role="option"], [tabindex]');
    return owner === node || (!owner && hit === node);
  };
  const numericDay = (node) => { const value = name(node); return /^\\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 31 ? Number(value) : null; };
  const daySelector = 'button, [role="button"], [role="gridcell"], td, option, [role="option"], [tabindex], span';
  const dayInteractionOwner = (node) => node && node.closest
    ? (node.closest('button, [role="button"], [role="gridcell"], td, option, [role="option"], [tabindex]') || node)
    : node;
  const dayNodes = (root) => {
    const raw = Array.from(root.querySelectorAll(daySelector)).filter((node) => visible(node) && numericDay(node) != null);
    const owners = Array.from(new Set(raw.map(dayInteractionOwner))).filter((node) => visible(node) && numericDay(node) != null);
    return owners.filter((node) => !owners.some((other) => other !== node && node.contains(other) && numericDay(other) === numericDay(node)));
  };
  const roots = [];
  const rootSet = new Set();
  const addRoot = (seed) => {
    if (!seed || !visible(seed)) return;
    let current = seed;
    let best = seed;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      if (!visible(current)) continue;
      if (monthState(current.textContent) && dayNodes(current).length >= 7) { best = current; break; }
    }
    if (!rootSet.has(best)) { rootSet.add(best); roots.push(best); }
  };
  Array.from(document.querySelectorAll('[role="dialog"], [role="grid"], input[type="date"], input[type="month"], [data-calendar], [data-datepicker]')).filter(visible).forEach(addRoot);
  if (!roots.length && document.activeElement) addRoot(document.activeElement);
  if (!roots.some((root) => monthState(root.textContent))) {
    const fallback = Array.from(document.querySelectorAll('div, section, table')).filter(visible).filter((node) => monthState(node.textContent) && dayNodes(node).length >= 20).sort((left, right) => dayNodes(left).length - dayNodes(right).length)[0];
    if (fallback) addRoot(fallback);
  }
  const scope = roots.length ? roots : [document.body];
  const seen = new Set(); const candidates = [];
  for (const root of scope) {
    const state = monthState(root.textContent);
    const calendarDays = dayNodes(root);
    const values = calendarDays.map(numericDay);
    const segments = [];
    let segmentStart = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (values[index] <= 7 && values[index - 1] >= 20) {
        segments.push({ start: segmentStart, end: index - 1 });
        segmentStart = index;
      }
    }
    if (values.length) segments.push({ start: segmentStart, end: values.length - 1 });
    const currentSegment = segments.sort((left, right) => (right.end - right.start) - (left.end - left.start))[0] || null;
    const dayIndex = new Map(calendarDays.map((node, index) => [node, index]));
    for (const node of Array.from(new Set([...root.querySelectorAll('button, [role="button"], option, [role="option"], select, input'), ...calendarDays]))) {
      if (!visible(node)) continue;
      const candidateName = name(node); const candidateRole = role(node);
      const dateValue = attr(node, 'data-date') || attr(node, 'datetime') || attr(node, 'data-value') || attr(node, 'value') || candidateName;
      let dateParts = exactDate(dateValue);
      const rawDirection = clean([attr(node, 'data-direction'), attr(node, 'data-nav'), attr(node, 'rel'), candidateName, attr(node, 'class')].join(' ')).toLowerCase();
      const direction = /(?:^|[\\s_-])(?:next|forward|following|increment)(?:[\\s_-]|$)/.test(rawDirection) ? 'forward'
        : /(?:^|[\\s_-])(?:prev|previous|back|backward|decrement)(?:[\\s_-]|$)/.test(rawDirection) ? 'backward' : null;
      const axis = (attr(node, 'data-calendar-axis') || attr(node, 'data-axis')).toLowerCase() || null;
      const numericValue = integer(attr(node, 'data-value') || attr(node, 'value'));
      const semanticAction = (attr(node, 'data-action') || (candidateRole === 'option' ? 'option' : '')).toLowerCase() || null;
      const index = dayIndex.get(node);
      const explicitOutside = /(?:^|[\\s_-])(?:other|outside|adjacent)(?:[\\s_-]|$)/i.test(attr(node, 'class'));
      const inferredCurrent = Number.isInteger(index) && currentSegment && index >= currentSegment.start && index <= currentSegment.end;
      const currentMonth = bool(attr(node, 'data-current-month')) || attr(node, 'aria-current') === 'date'
        || (!explicitOutside && inferredCurrent === true);
      if (!dateParts && state && currentMonth && numericDay(node) != null) {
        dateParts = { year: state.year, month: state.month, day: numericDay(node) };
      }
      if (!dateParts && !direction && !axis) continue;
      const key = [candidateRole, candidateName, JSON.stringify(dateParts), direction, axis, numericValue].join('|');
      if (seen.has(key)) continue; seen.add(key);
      candidates.push({
        role: candidateRole, name: candidateName, dateParts, direction, axis,
        numericValue, value: numericValue, semanticAction,
        currentMonth,
        hitTarget: hitTarget(node),
        disabled: !enabled(node), ariaDisabled: attr(node, 'aria-disabled'),
      });
    }
  }
  let calendarState = null;
  for (const root of roots) {
    const year = integer(attr(root, 'data-year'));
    const month = integer(attr(root, 'data-month'));
    if (year && month >= 1 && month <= 12) { calendarState = { year, month }; break; }
    if (root.matches && root.matches('input[type="month"]') && /^\\d{4}-\\d{2}$/.test(root.value || '')) {
      const parts = root.value.split('-').map(Number); calendarState = { year: parts[0], month: parts[1] }; break;
    }
    const textState = monthState(root.textContent);
    if (textState) { calendarState = textState; break; }
  }
  if (!calendarState) {
    const current = candidates.find((candidate) => candidate.currentMonth && candidate.dateParts);
    if (current) calendarState = { year: current.dateParts.year, month: current.dateParts.month };
  }
  return { candidates, calendarState };
}`;

function normalize(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function snapshotControls(snapshotText) {
  const controls = [];
  for (const line of String(snapshotText || '').split(/\r?\n/)) {
    const match = line.match(/^\s*-?\s*(button|gridcell|option|combobox|spinbutton|generic)\b([^\n]*?)\[ref=([^\]]+)\]([^\n]*)$/i);
    if (!match) continue;
    const quoted = match[2].match(/^\s+"([^"]*)"/);
    const trailing = match[4].match(/:\s*([^\[]+?)\s*$/);
    controls.push({ role: match[1].toLowerCase(), name: quoted ? quoted[1] : trailing ? trailing[1] : '', ref: match[3] });
  }
  return controls;
}

function attachSnapshotRefs(candidates = [], snapshotText = '') {
  const controls = snapshotControls(snapshotText);
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const exact = controls.filter((control) => control.role === normalize(candidate.role)
      && normalize(control.name) === normalize(candidate.name));
    if (exact.length === 1) return { ...candidate, ref: exact[0].ref };
    const calendarRoles = new Set(['button', 'gridcell', 'generic']);
    const compatible = candidate?.dateParts && calendarRoles.has(normalize(candidate.role))
      ? controls.filter((control) => calendarRoles.has(control.role)
        && normalize(control.name) === normalize(candidate.name))
      : [];
    return compatible.length === 1 ? { ...candidate, ref: compatible[0].ref } : { ...candidate };
  });
}

module.exports = {
  CALENDAR_CANDIDATE_FUNCTION,
  attachSnapshotRefs,
  _snapshotControls: snapshotControls,
};
