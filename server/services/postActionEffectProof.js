'use strict';

/**
 * Post-action EFFECT PROOF (Phase B-2e).
 *
 * "Tool dispatched" ≠ "the action worked." Every action must prove its OBSERVABLE
 * effect, typed by what the action was:
 *   fill            → the field's value reads back as the intended value
 *   select/dropdown → the displayed/selected value changed (to intended)
 *   checkbox/radio  → the checked state changed
 *   click (command) → navigation / toast / modal open-or-close / row added-or-
 *                     removed / network response (save, delete, submit…)
 *
 * Deterministic (CLAUDE.md "Node unless genuine novelty"): given before/after
 * observations it decides proven/not. Live capture is via `EFFECT_PROBE_FN`
 * (browser_evaluate) + an optional targeted value/checked readback; both are
 * INJECTED by the conductor so this stays unit-testable and generic (no site
 * classes — toast/error/row detection is by role + generic class-substring).
 */

function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }
function normUrl(u) { return norm(u).replace(/[?#].*$/, '').replace(/\/+$/, ''); }

function actionVerb(toolName) {
  const t = String(toolName || '').toLowerCase();
  if (/type|fill/.test(t)) return 'fill';
  if (/select|option/.test(t)) return 'select';
  if (/check|toggle|switch/.test(t)) return 'check';
  if (/click|press|tap/.test(t)) return 'click';
  if (/navigate|goto/.test(t)) return 'navigate';
  return 'other';
}

/** What KIND of effect should this action produce? Drives which proof we demand. */
function classifyExpectedEffect({ verb, targetRole }) {
  if (verb === 'fill') return 'value_set';
  if (verb === 'select' || targetRole === 'combobox' || targetRole === 'listbox') return 'selection_changed';
  if (verb === 'check' || targetRole === 'checkbox' || targetRole === 'radio' || targetRole === 'switch') return 'checked_changed';
  if (verb === 'navigate') return 'command_effect';
  if (verb === 'click') return 'command_effect';
  return 'unknown';
}

/**
 * @param {object} input
 * @param {string} input.toolName
 * @param {string} [input.targetRole]
 * @param {string} [input.intendedValue]
 * @param {object} [input.before]   EFFECT_PROBE_FN fingerprint before the action
 * @param {object} [input.after]    EFFECT_PROBE_FN fingerprint after the action
 * @param {string} [input.valueAfter]   targeted value readback of the acted element
 * @param {boolean} [input.checkedBefore]
 * @param {boolean} [input.checkedAfter]
 * @param {boolean} [input.networkOk]   a relevant 2xx/3xx response was observed
 * @returns {{expected,proven,kind,signals:string[],reason,intendedValue}}
 */
function proveEffect(input = {}) {
  const { toolName = '', targetRole = null, intendedValue = null, before = null, after = null,
    valueAfter = null, checkedBefore = null, checkedAfter = null, networkOk = false } = input;
  const verb = actionVerb(toolName);
  const expected = classifyExpectedEffect({ verb, targetRole });

  // Generic page-level signals (overlay/nav/row/toast/error deltas).
  const signals = [];
  const urlChanged = !!(before && after && normUrl(before.url) !== normUrl(after.url));
  const toastAppeared = !!(after && after.toast && (!before || norm(before.toast) !== norm(after.toast)));
  const dialogDelta = !!(before && after && before.dialogOpen !== after.dialogOpen);
  const rowDelta = !!(before && after && before.rowCount !== after.rowCount);
  const errorAppeared = !!(before && after && (after.errorCount || 0) > (before.errorCount || 0));
  const toastLooksLikeValidationError = toastAppeared
    && /\b(error|invalid|incorrect|required|failed|denied|missing|please\s+(?:enter|provide|fill|select|complete)|must\s+(?:enter|provide|fill|select|complete))\b/i
      .test(String(after.toast || ''));
  if (urlChanged) signals.push('navigation');
  if (toastAppeared && !toastLooksLikeValidationError) signals.push('toast');
  if (dialogDelta) signals.push(after.dialogOpen > before.dialogOpen ? 'modal_opened' : 'modal_closed');
  if (rowDelta) signals.push(after.rowCount < before.rowCount ? 'row_removed' : 'row_added');
  if (networkOk) signals.push('network_response');
  if (errorAppeared || toastLooksLikeValidationError) signals.push('validation_error_shown');

  let proven = false; let kind = expected; let reason = '';
  if (expected === 'value_set') {
    const got = valueAfter != null ? valueAfter : (after && after.activeValue);
    proven = got != null && intendedValue != null && norm(got).includes(norm(intendedValue));
    kind = 'value_readback';
    reason = proven ? `value readback "${String(got).slice(0, 40)}" contains intended` : `value readback ${got == null ? '(none)' : '"' + String(got).slice(0, 40) + '"'} != intended "${String(intendedValue).slice(0, 40)}"`;
  } else if (expected === 'selection_changed') {
    if (valueAfter != null && intendedValue != null) proven = norm(valueAfter).includes(norm(intendedValue));
    else proven = !!(before && after && norm(before.activeValue) !== norm(after.activeValue)) || rowDelta || dialogDelta;
    kind = 'selection_changed';
    reason = proven ? 'displayed selection changed' : 'no selection change observed';
  } else if (expected === 'checked_changed') {
    if (checkedBefore != null && checkedAfter != null) proven = checkedBefore !== checkedAfter;
    else proven = !!(before && after && before.checkedCount !== after.checkedCount);
    kind = 'checked_state';
    reason = proven ? 'checked state changed' : 'no checked-state change observed';
  } else if (expected === 'command_effect') {
    proven = signals.length > 0;
    kind = proven ? signals[0] : 'no_effect';
    reason = proven ? `observed: ${signals.join(', ')}` : 'no observable effect (no navigation / toast / modal / row / network change)';
  } else {
    proven = urlChanged || toastAppeared || dialogDelta || rowDelta;
    kind = proven ? 'changed' : 'unknown';
    reason = proven ? `observed: ${signals.join(', ') || 'change'}` : 'no observation captured';
  }
  return { expected, proven, kind, signals, reason, intendedValue: intendedValue || null };
}

// Compact, GENERIC effect fingerprint captured before & after an action. No site
// classes — toast/error/row by ARIA role + generic class-substring (case-insensitive).
const EFFECT_PROBE_FN = `() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const q = (sel) => { try { return document.querySelectorAll(sel).length; } catch (e) { return 0; } };
  let toast = '';
  try {
    const nodes = document.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"], [class*="toast" i], [class*="snackbar" i], [class*="notification" i]');
    for (const n of nodes) { const tx = norm(n.textContent); if (tx) { toast = tx.slice(0, 120); break; } }
  } catch (e) {}
  let activeValue = null;
  try { const a = document.activeElement; if (a && ('value' in a)) activeValue = String(a.value).slice(0, 200); } catch (e) {}
  return {
    url: location.href,
    dialogOpen: q('[role="dialog"], [role="alertdialog"], dialog[open]'),
    toast,
    rowCount: q('[role="row"], tr, [class*="table-row" i], [class*="list-item" i]'),
    checkedCount: q('input:checked, [role="checkbox"][aria-checked="true"], [role="radio"][aria-checked="true"], [role="switch"][aria-checked="true"]'),
    errorCount: q('[role="alert"], [aria-invalid="true"], [class*="error" i], [class*="invalid" i]'),
    activeValue,
  };
}`;

module.exports = { proveEffect, classifyExpectedEffect, actionVerb, EFFECT_PROBE_FN };
