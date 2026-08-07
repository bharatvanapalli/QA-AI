'use strict';

/**
 * Widget routines (Phase B-2c.3) — deterministic, widget-specific certifications
 * that feed `widgetStateBefore` + an effect verdict into the Precision Action
 * Kernel record. They turn "I clicked something with similar text" into a proven
 * two-step / readback interaction.
 *
 * Pure + deterministic (CLAUDE.md "Node unless genuine novelty"): each routine
 * reads the accessibility snapshots captured around the interaction and certifies
 * what actually happened. Reuses the canonical snapshot parser (mcp.parseSnapshotLine).
 * No LLM, no DB, no MCP roundtrip. Wired into live dispatch at B-2d.
 */

const { parseSnapshotLine } = require('./mcp');

const OPTION_ROLES = new Set(['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'listitem']);
const CHECKABLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function parseRows(snapshotText) {
  const rows = [];
  for (const line of String(snapshotText || '').split(/\r?\n/)) {
    const p = parseSnapshotLine(line);
    if (!p) continue;
    let value = '';
    const colon = /:\s*(.+?)\s*$/.exec((p.rest || '').replace(/\[[^\]]*\]/g, ' '));
    if (colon) value = colon[1].trim();
    rows.push({ role: (p.role || '').toLowerCase(), name: p.name || '', ref: p.ref || null, value, raw: line });
  }
  return rows;
}

function listOptions(snapshotText) {
  return parseRows(snapshotText).filter((r) => OPTION_ROLES.has(r.role) && r.name);
}

function findControl(snapshotText, label) {
  const rows = parseRows(snapshotText);
  const n = norm(label);
  // EXACT match first so an overlapping label ("User") never shadows the
  // intended control ("User Role"); only then fall back to containment.
  return rows.find((r) => r.name && norm(r.name) === n)
    || rows.find((r) => r.name && (norm(r.name).includes(n) || n.includes(norm(r.name)))) || null;
}

/**
 * Dropdown / custom-select TWO-STEP certification:
 *   open the control → option panel must be VISIBLE → the EXACT option must be
 *   present → after selecting, the panel CLOSES and the chosen value is reflected.
 * Never "click something with similar text".
 *
 * @returns {{ widget:'dropdown', certified, panelOpened, optionMatched, panelClosed, valueReflected, reason }}
 */
function certifyDropdownSelection({ controlLabel, optionLabel, snapshotBeforeOpen, snapshotAfterOpen, snapshotAfterSelect, allowPartialOption = false } = {}) {
  const optsBefore = listOptions(snapshotBeforeOpen).length;
  const optsAfterOpen = listOptions(snapshotAfterOpen);
  // The panel opened iff more options are visible than before the click.
  const panelOpened = optsAfterOpen.length > optsBefore;
  // EXACT normalized option match by default — selecting "ESS" must NOT match
  // "ESS Admin" or "ESSENTIAL". Partial only when the caller explicitly opts in.
  const optionMatched = optsAfterOpen.some((o) => allowPartialOption
    ? (norm(o.name) === norm(optionLabel) || norm(o.name).includes(norm(optionLabel)))
    : norm(o.name) === norm(optionLabel));
  const optsAfterSelect = listOptions(snapshotAfterSelect).length;
  const panelClosed = optsAfterSelect < optsAfterOpen.length || optsAfterSelect === 0;
  // value reflected: SCOPED to the control itself (its accessible name or its
  // displayed value) — never certified from global page text, which could match
  // the same word appearing elsewhere on the page.
  const ctrl = findControl(snapshotAfterSelect, controlLabel);
  const valueReflected = !!(ctrl && (norm(ctrl.name).includes(norm(optionLabel)) || norm(ctrl.value).includes(norm(optionLabel))));

  const certified = panelOpened && optionMatched && panelClosed && valueReflected;
  let reason;
  if (!panelOpened) reason = 'option panel did not open (no new options visible after the trigger click)';
  else if (!optionMatched) reason = `the exact option "${optionLabel}" was not present in the open panel`;
  else if (!panelClosed) reason = 'panel did not close after selection (selection may not have registered)';
  else if (!valueReflected) reason = `control does not reflect the selected value "${optionLabel}" after selection`;
  else reason = 'dropdown two-step certified: opened, exact option present, panel closed, value reflected';

  return {
    widget: 'dropdown',
    certified,
    panelOpened,
    optionMatched,
    panelClosed,
    valueReflected,
    optionsVisible: optsAfterOpen.map((o) => o.name),
    reason,
  };
}

/**
 * Form FIELD readback: after a fill, the field must actually hold the intended
 * value (a fill that silently no-ops is NOT done).
 */
function certifyFieldReadback({ fieldLabel, intendedValue, snapshotAfter } = {}) {
  const ctrl = findControl(snapshotAfter, fieldLabel);
  const observedValue = ctrl ? ctrl.value : null;
  const want = String(intendedValue == null ? '' : intendedValue);
  // Sensitive fields (password) often render masked / no value in the a11y tree —
  // report unknown rather than a false mismatch.
  const readable = !!(ctrl && observedValue);
  const valueConfirmed = readable ? (norm(observedValue) === norm(want) || observedValue === want) : null;
  return {
    widget: 'field',
    certified: valueConfirmed === true,
    fieldFound: !!ctrl,
    observedValue: readable ? observedValue : null,
    valueConfirmed, // true | false | null(unreadable, e.g. masked)
    reason: !ctrl ? `field "${fieldLabel}" not found after fill`
      : !readable ? 'field value not readable from the accessibility tree (e.g. masked password) — confirm via DOM at B-2d'
        : valueConfirmed ? 'field holds the intended value'
          : `field holds "${observedValue}", expected "${want}"`,
  };
}

/** Checkbox / radio / switch state certification. */
function certifyToggleState({ controlLabel, intendedChecked, snapshotAfter } = {}) {
  const rows = parseRows(snapshotAfter).filter((r) => CHECKABLE_ROLES.has(r.role));
  const n = norm(controlLabel);
  const ctrl = rows.find((r) => r.name && (norm(r.name) === n || norm(r.name).includes(n))) || null;
  if (!ctrl) return { widget: 'toggle', certified: false, found: false, reason: `toggle "${controlLabel}" not found` };
  const checked = /\[checked\]|\[selected\]/.test(ctrl.raw);
  const certified = checked === !!intendedChecked;
  return { widget: 'toggle', certified, found: true, observedChecked: checked, reason: certified ? 'toggle in the intended state' : `toggle is ${checked ? 'checked' : 'unchecked'}, expected ${intendedChecked ? 'checked' : 'unchecked'}` };
}

/**
 * Modal outcome: a modal/dialog expected to appear (or to be dismissed) is
 * certified by its presence/absence across the action.
 */
function certifyModalOutcome({ snapshotBefore, snapshotAfter, expect = 'dismissed', dialogLabel } = {}) {
  const hasDialog = (snap) => parseRows(snap).some((r) => (r.role === 'dialog' || r.role === 'alertdialog') && (!dialogLabel || norm(r.name).includes(norm(dialogLabel))));
  const before = hasDialog(snapshotBefore);
  const after = hasDialog(snapshotAfter);
  let certified; let reason;
  if (expect === 'appeared') { certified = !before && after; reason = certified ? 'dialog appeared' : 'expected dialog did not appear'; }
  else { certified = before && !after; reason = certified ? 'dialog dismissed' : (before ? 'dialog still present after action' : 'no dialog was present to dismiss'); }
  return { widget: 'modal', certified, dialogBefore: before, dialogAfter: after, reason };
}

module.exports = {
  certifyDropdownSelection,
  certifyFieldReadback,
  certifyToggleState,
  certifyModalOutcome,
  listOptions,
  findControl,
};
