'use strict';

function clean(value, max = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('\n');
  }
  return '';
}

function parseEvaluateJson(result) {
  const raw = textOfContent(result && result.content ? result.content : result) || '';
  const candidates = [
    raw,
    raw.replace(/^Result:\s*/i, ''),
  ];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const objectLike = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (objectLike) candidates.push(objectLike[1]);
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (!text) continue;
    try { return JSON.parse(text); } catch (_) {}
  }
  return null;
}

function extractActionRef(toolName, args = {}, fieldIndex = null) {
  if (toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
    const field = Number.isFinite(Number(fieldIndex)) ? args.fields[Number(fieldIndex)] : args.fields[0];
    return clean(field && (field.ref || field.target));
  }
  return clean(args.ref || args.target);
}

function extractIntendedValue(args = {}, fallback = '', fieldIndex = null) {
  if (Array.isArray(args.fields)) {
    const field = Number.isFinite(Number(fieldIndex)) ? args.fields[Number(fieldIndex)] : args.fields[0];
    return clean(field && (field.value || field.text || field.input), 1000);
  }
  return clean(args.value || args.text || args.input || fallback, 1000);
}

function normalizeComparable(value) {
  return clean(value, 1000).toLowerCase();
}

function valuesMatch(actual, expected) {
  const a = normalizeComparable(actual);
  const e = normalizeComparable(expected);
  if (!e) return false;
  return a === e || a.includes(e);
}

// Three-way classification of a live DOM value readback. The critical
// distinction the conductor needs is between a value we positively read that
// DISAGREES with the intent (a real failure) versus a value we simply could
// not read at all (uncheckable — the element ref almost always goes stale on
// an SPA after the page re-renders, so browser_evaluate resolves nothing).
// Per the project's uncheckable→soft doctrine, only a positively-read,
// non-empty, contradicting value is a 'mismatch'; everything else is
// 'uncheckable' and must NOT mark the step blocked.
//   'confirmed'   — read a non-empty value that matches the intent
//   'mismatch'    — read a non-empty value that contradicts the intent
//   'uncheckable' — could not resolve/read the element, or it read back empty
function classifyValueReadback(state, intendedValue) {
  if (!state || state.ok !== true) return 'uncheckable';
  const actual = clean(state.value || state.displayText || state.text || '');
  if (!actual) return 'uncheckable';
  return valuesMatch(actual, intendedValue) ? 'confirmed' : 'mismatch';
}

function snapshotLines(snapshotText) {
  return String(snapshotText || '').split(/\r?\n/);
}

function countMenuRoles(snapshotText) {
  let count = 0;
  for (const line of snapshotLines(snapshotText)) {
    const normalized = line.toLowerCase();
    if (/^\s*-?\s*(menu|menuitem|listbox|option|dialog)\b/.test(normalized)) count += 1;
  }
  return count;
}

function extractOptionTexts(snapshotText) {
  const out = [];
  for (const line of snapshotLines(snapshotText)) {
    if (!/^\s*-?\s*(option|menuitem)\b/i.test(line)) continue;
    const quoted = line.match(/"([^"]+)"/);
    const value = clean(quoted ? quoted[1] : line.replace(/\[[^\]]+\]/g, '').replace(/^\s*-?\s*\w+\s*/i, ''));
    if (value && !out.includes(value)) out.push(value);
  }
  return out.slice(0, 30);
}

function detectOverlayDelta(beforeSnapshot, afterSnapshot) {
  const beforeCount = countMenuRoles(beforeSnapshot);
  const afterCount = countMenuRoles(afterSnapshot);
  const beforeOptions = extractOptionTexts(beforeSnapshot);
  const options = extractOptionTexts(afterSnapshot);
  const beforeOptionSet = new Set(beforeOptions.map((value) => normalizeComparable(value)));
  const newOptions = options.filter((value) => !beforeOptionSet.has(normalizeComparable(value)));
  return {
    beforeCount,
    afterCount,
    options,
    newOptions,
    matched: afterCount > beforeCount || newOptions.length > 0,
  };
}

async function evaluateRefState({ session, ref, elementLabel, mcp }) {
  if (!session || !ref || !mcp || typeof mcp.callTool !== 'function') {
    return { ok: false, reason: 'missing_session_or_ref' };
  }
  const fn = `(${function qaaiReadActionTargetState(el) {
    const target = el && el.nodeType === 1 ? el : null;
    const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const attr = (node, name) => node && node.getAttribute ? clean(node.getAttribute(name)) : '';
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const fieldContainer = (node) => {
      let cur = node;
      for (let depth = 0; cur && depth < 6; depth += 1, cur = cur.parentElement) {
        const text = clean(cur.innerText || cur.textContent);
        const controls = cur.querySelectorAll ? cur.querySelectorAll('input, textarea, select, button, [role], [contenteditable="true"]').length : 0;
        if (text && controls > 0 && text.length < 400) return cur;
      }
      return node ? node.parentElement : null;
    };
    const menuTrigger = target && target.closest
      ? (target.closest('[aria-expanded], [aria-controls], [aria-owns], [aria-haspopup]') || target)
      : target;
    const controlledIds = clean([
      attr(menuTrigger, 'aria-controls'),
      attr(menuTrigger, 'aria-owns'),
    ].filter(Boolean).join(' ')).split(/\s+/).filter(Boolean);
    const controlledNodes = controlledIds
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const localPopup = menuTrigger && menuTrigger.parentElement && menuTrigger.parentElement.querySelector
      ? menuTrigger.parentElement.querySelector('[role="listbox"], [role="menu"], [role="tree"], [role="dialog"]')
      : null;
    const popupNodes = Array.from(new Set([...controlledNodes, localPopup].filter(Boolean)));
    const visiblePopup = popupNodes.find((node) => visible(node)) || null;
    const ariaExpanded = attr(menuTrigger, 'aria-expanded').toLowerCase();
    const menuOpen = ariaExpanded === 'true' || !!visiblePopup;
    const tag = target ? target.tagName.toLowerCase() : '';
    const type = attr(target, 'type');
    const container = fieldContainer(target);
    const selected = target && tag === 'select'
      ? Array.from(target.selectedOptions || []).map((o) => clean(o.textContent || o.value)).join(' ')
      : '';
    const value = target
      ? (target.value != null && String(target.value) !== '' ? String(target.value) : selected)
      : '';
    const text = target ? clean(target.innerText || target.textContent) : '';
    const containerText = container ? clean(container.innerText || container.textContent) : '';
    return JSON.stringify({
      ok: !!target,
      tag,
      type,
      value,
      text,
      displayText: clean([value, selected, text].filter(Boolean).join(' ')),
      containerText,
      checked: !!(target && target.checked),
      ariaChecked: attr(target, 'aria-checked') || null,
      ariaPressed: attr(target, 'aria-pressed') || null,
      ariaExpanded: ariaExpanded || null,
      ariaControls: controlledIds,
      ariaHasPopup: attr(menuTrigger, 'aria-haspopup') || null,
      controlledPopupVisible: !!visiblePopup,
      controlledPopupRole: visiblePopup ? attr(visiblePopup, 'role') || visiblePopup.tagName.toLowerCase() : null,
      controlledPopupText: visiblePopup ? clean(visiblePopup.innerText || visiblePopup.textContent) : '',
      menuOpen,
      visible: visible(target),
      enabled: !!target && !target.disabled && attr(target, 'aria-disabled') !== 'true',
    });
  }.toString()})`;
  try {
    const result = await mcp.callTool(session, 'browser_evaluate', {
      element: elementLabel || ref,
      ref,
      function: fn,
    }, { strictActionEvidence: false, source: 'widget_state_readback', telemetry: false });
    const parsed = parseEvaluateJson(result);
    return parsed && typeof parsed === 'object' ? parsed : { ok: false, reason: 'parse_failed' };
  } catch (err) {
    return { ok: false, reason: 'evaluate_failed', detail: clean(err && err.message || err, 300) };
  }
}

function buildStepEvidence({ stepIndex, intent, toolName, targetLabel, intendedValue, actualValue, matched, evidenceSource, locatorQuality, retryCount = 0, reason, detail } = {}) {
  return {
    stepIndex: Number.isFinite(Number(stepIndex)) ? Number(stepIndex) : null,
    intent: clean(intent, 240) || null,
    toolName: toolName || null,
    targetLabel: clean(targetLabel, 240) || null,
    intendedValue: clean(intendedValue, 1000) || null,
    actualValue: clean(actualValue, 1000) || null,
    matched: matched === true,
    evidenceSource: evidenceSource || null,
    locatorQuality: locatorQuality || null,
    retryCount: Number.isFinite(Number(retryCount)) ? Number(retryCount) : 0,
    reason: reason || null,
    detail: detail ? clean(detail, 500) : null,
    ts: new Date().toISOString(),
  };
}

function inferLocatorQuality(trailEntry = {}) {
  if (trailEntry.actionLocator && trailEntry.actionLocatorGap) return 'verified_with_gap';
  if (trailEntry.actionLocator) return 'verified';
  if (trailEntry.actionLocatorGap) return 'gap';
  if (trailEntry.memoryFastPathDispatch) return 'memory';
  return 'unknown';
}

module.exports = {
  clean,
  extractActionRef,
  extractIntendedValue,
  valuesMatch,
  classifyValueReadback,
  evaluateRefState,
  detectOverlayDelta,
  buildStepEvidence,
  inferLocatorQuality,
};
