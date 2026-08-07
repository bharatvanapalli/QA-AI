'use strict';

/**
 * Deterministic WIDGET COMPLETION verification (B-2e control-loop fix).
 *
 * Root cause of the conductor "confusion": steps were sealed PASS on weak evidence
 * (the selected value merely visible in an OPEN menu, or an autocomplete "click
 * suggestion" passing while the page showed "No Records Found"). A sealed-but-
 * unfinished step makes the model see a contradiction (backend says done, UI says
 * not), retry the old step while the pointer moved, and drift into wrong pages.
 *
 * These pure helpers enforce REAL completion:
 *  - a select/dropdown is committed ONLY when the menu is CLOSED and the CONTROL
 *    itself shows the value (not a placeholder, not an open-menu item);
 *  - an autocomplete suggestion pick CANNOT pass when no suggestion exists.
 *
 * Generic — no site classes. `parseSnapshotLine` (from mcp.js) is injected so the
 * role taxonomy matches the rest of the conductor.
 */

const PLACEHOLDER_RE = /--\s*select\s*--|(?:^|\s)select\s*\.{2,}|(?:^|\s)choose\b|--\s*--/i;
const NO_RESULTS_RE = /no records found|no results found|no matching|nothing found/i;
const OPEN_MENU_ROLES = new Set(['option', 'menuitem', 'listbox']);

/**
 * Is a dropdown/select selection actually COMMITTED to the closed control?
 * @returns {boolean} true ONLY when confident; biased to false (keep step pending).
 */
function isSelectionCommitted(snapshotText, value, hintWords = [], parseSnapshotLine = null) {
  const wl = String(value == null ? '' : value).toLowerCase().trim();
  if (!wl) return false;
  const lines = String(snapshotText || '').split(/\r?\n/).map((raw) => {
    const p = parseSnapshotLine ? parseSnapshotLine(raw) : null;
    return { raw, low: raw.toLowerCase(), indent: (raw.match(/^\s*/) || [''])[0].length, role: String((p && p.role) || '').toLowerCase(), name: String((p && p.name) || '').toLowerCase() };
  });
  const isMenu = (l) => OPEN_MENU_ROLES.has(l.role);

  // (1) NATIVE control whose OWN line carries the value (combobox/select "Status": Enabled).
  if (Array.isArray(hintWords) && hintWords.length) {
    for (const l of lines) {
      if ((l.role === 'combobox' || l.role === 'select') && hintWords.some((w) => l.name.includes(w))) {
        return l.low.includes(wl) && !PLACEHOLDER_RE.test(l.raw);
      }
    }
  }

  // (2) REGION-SCOPED check (custom role-less control). Find the field's LABEL by
  //     the hint words, then scope value/placeholder/menu checks to that field's
  //     OWN indentation block — NOT the whole page. This is the fix for the false
  //     negative: a sibling field still showing "-- Select --" (e.g. Status) must
  //     NOT fail an already-committed field (e.g. User Role = ESS).
  if (Array.isArray(hintWords) && hintWords.length) {
    for (let i = 0; i < lines.length; i++) {
      const anchor = lines[i];
      if (!hintWords.every((w) => anchor.low.includes(w))) continue;
      let menuOpen = false; let placeholder = false; let valuePresent = false; let sawRegion = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].indent <= anchor.indent) break; // next sibling field → region ends
        sawRegion = true;
        const l = lines[j];
        if (isMenu(l)) menuOpen = true;
        else { if (PLACEHOLDER_RE.test(l.raw)) placeholder = true; if (l.low.includes(wl)) valuePresent = true; }
      }
      if (!sawRegion) {
        // flat snapshot (no indentation) → bounded window after the label.
        for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
          const l = lines[j];
          if (isMenu(l)) menuOpen = true;
          else { if (PLACEHOLDER_RE.test(l.raw)) placeholder = true; if (l.low.includes(wl)) valuePresent = true; }
        }
      }
      return valuePresent && !placeholder && !menuOpen;
    }
    // label not found by hints → fall through to (3).
  }

  // (3) No hints / label not found: conservative GLOBAL last resort — value on a
  //     non-menu line, menu closed, no placeholder anywhere.
  if (lines.some(isMenu)) return false;
  const placeholderShowing = lines.some((l) => PLACEHOLDER_RE.test(l.raw));
  const valuePresent = lines.some((l) => !isMenu(l) && l.low.includes(wl));
  return valuePresent && !placeholderShowing;
}

/** Does the result surface show a no-results state? Delegates to the universal
 *  Result-Bearing Input Protocol so autocomplete + search + lookup + filter all
 *  share ONE empty-result vocabulary (not an autocomplete-only check). */
function autocompleteHasNoResults(snapshotText) {
  return require('./resultBearingInputVerification').hasEmptyResult(snapshotText);
}

/** Is a suggestion/option list still OPEN (selection not yet committed)? */
function suggestionPanelOpen(snapshotText, parseSnapshotLine = null) {
  return String(snapshotText || '').split(/\r?\n/).some((l) => {
    const p = parseSnapshotLine ? parseSnapshotLine(l) : null;
    return OPEN_MENU_ROLES.has(String((p && p.role) || '').toLowerCase());
  });
}

/** Does a step's intent indicate picking an autocomplete/suggestion result? */
function isSuggestionPickStep(step) {
  const intent = `${(step && step.action) || ''} ${(step && step.expected) || ''} ${(step && step.element) || ''}`.toLowerCase();
  return /\b(suggestion|autocomplete|type[- ]?ahead|first (?:result|option|match|suggestion)|search result)\b/.test(intent)
    || /type for hints/i.test(String((step && step.element) || ''));
}

/**
 * Build the audit-ready outcome of a test-data/precondition stop. The step that
 * ENTERED the value (found by matching the approved Fill step's value) is marked
 * blocked with the no-records explanation — NOT left as a misleading PASS; every
 * later step is blocked as a dependency with clear wording. Returns the mutated
 * stepResults + the human-readable error. Pure — unit-testable.
 */
function buildTestDataInvalidOutcome({ stepResults = [], approvedSteps = [], field = '', value = '', fallbackStepIndex = 0, emptyText = 'No Records Found' } = {}) {
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // The observed empty-result phrase the SITE actually showed (e.g. "No results found",
  // "No options"). Defaults to "No Records Found" only when the caller didn't capture
  // one — the message is otherwise generated from value + field + observed text, with
  // no site-specific literals.
  const shown = String(emptyText || 'No Records Found').trim() || 'No Records Found';
  let idx = -1;
  for (let i = 0; i < approvedSteps.length; i++) {
    const s = approvedSteps[i];
    if (s && /fill|type|enter/i.test(String(s.action || '')) && norm(s.value) === norm(value)) { idx = i; break; }
  }
  if (idx < 0) idx = Math.max(0, fallbackStepIndex);
  const error = `QAAI entered the approved value "${value}" into "${field}", but the application returned "${shown}" — there is no record to select. The remaining steps depend on selecting a record here, so they were blocked. This is a test-data / precondition issue (the required record does not exist), not a product defect or an automation failure.`;
  const out = stepResults.map((s) => ({ ...(s || {}) }));
  for (let i = idx; i < out.length; i++) {
    if (!out[i]) continue;
    if (i === idx) {
      out[i].status = 'blocked';
      out[i].reason = 'test_data_invalid';
      // Set BOTH evidence and error — the Reports step row renders `error`, so the
      // human explanation must be on that field (not only `evidence`).
      out[i].evidence = `Entered approved value "${value}" into "${field}"; the application returned "${shown}" — no suggestion/record exists to select.`;
      out[i].error = out[i].evidence;
    } else if (!out[i].status || out[i].status === 'pending') {
      out[i].status = 'blocked';
      out[i].reason = 'test_data_invalid_dependency';
      out[i].evidence = `Blocked because the record for approved value "${value}" could not be selected in "${field}".`;
      out[i].error = out[i].evidence;
    }
  }
  return { stepResults: out, error, blockedStepIndex: idx, dependentCount: Math.max(0, out.length - idx - 1) };
}

module.exports = { isSelectionCommitted, autocompleteHasNoResults, suggestionPanelOpen, isSuggestionPickStep, buildTestDataInvalidOutcome, PLACEHOLDER_RE, NO_RESULTS_RE };
