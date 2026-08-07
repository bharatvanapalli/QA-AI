'use strict';

/**
 * Case-start precision (Phase B-2c.4) — every case must START from a KNOWN,
 * certified page, not from whatever the previous case left behind.
 *
 * Fixes the repeated-flow failures: a continuation case that inherits the prior
 * case's dashboard + stale scrollback (no fresh snapshot) and then fails to log
 * in again; and a login-establishing case that inherits an authenticated session
 * (httpOnly cookies the URL can't reveal). The rule:
 *
 *   - ALWAYS take a fresh snapshot at case start (never trust prior-case scrollback).
 *   - A login/session-establishing case ALWAYS resets to a clean logged-out state
 *     (fresh browser context — the URL is NOT a reliable auth-state proxy; a
 *     cookie/httpOnly session can be authenticated while sitting on /login).
 *   - If a required entry page is known and we are not on it, navigate there.
 *   - Then certify the entry page before handing control to the model.
 *
 * Pure + deterministic — produces the ORDERED action plan the runner executes at
 * B-2d. No LLM, no DB, no MCP. Reuses evidenceCheckers.urlMatches for URL
 * comparison so it matches the rest of the system.
 */

const { urlMatches } = require('./evidenceCheckers');

/**
 * @param {object} input
 * @param {string}  [input.currentUrl]              where the browser is now (end of the prior case)
 * @param {boolean} [input.establishesSession]      this case logs in (caseEstablishesSessionLive)
 * @param {string}  [input.requiredEntryPattern]    the page this case must start from (e.g. 'auth/login') or null
 * @param {boolean} [input.currentSnapshotFresh]    whether a snapshot was already captured for THIS case
 * @returns {{ actions:Array, needsSessionReset, needsNavigation, needsFreshSnapshot, entryAlreadyCorrect, requiredEntryPattern, reason }}
 */
function planCaseStart({ currentUrl = null, establishesSession = false, requiredEntryPattern = null, currentSnapshotFresh = false } = {}) {
  const entryKnown = !!requiredEntryPattern;
  const onEntry = entryKnown && currentUrl != null ? urlMatches(currentUrl, requiredEntryPattern) : null;

  // A session-establishing case ALWAYS resets — the URL cannot prove we are
  // logged out (httpOnly auth cookie). This extends the per-data-row reset to
  // any login case across separate test cases.
  const needsSessionReset = !!establishesSession;
  // Navigate when an entry is required AND (we just reset, or we are not on it).
  const needsNavigation = entryKnown && (needsSessionReset || onEntry !== true);
  // Fresh snapshot at case start unless one was already captured for this case.
  const needsFreshSnapshot = !currentSnapshotFresh;

  const actions = [];
  if (needsSessionReset) {
    actions.push({ type: 'reset_session', reason: 'login/session-establishing case must start from a clean logged-out state (fresh context clears httpOnly cookies); URL is not a reliable auth-state proxy' });
  }
  if (needsNavigation) {
    actions.push({ type: 'navigate', to: requiredEntryPattern, reason: needsSessionReset ? 'after reset, navigate to the required entry page' : `current page (${currentUrl}) is not the required entry (${requiredEntryPattern})` });
  }
  if (needsFreshSnapshot) {
    actions.push({ type: 'fresh_snapshot', reason: 'do not trust prior-case scrollback; capture the current page now so the model sees real evidence' });
  }
  actions.push({ type: 'certify_entry_page', expect: requiredEntryPattern || null, reason: entryKnown ? 'confirm we are on the required entry page before handing control' : 'no specific entry required; confirm the page settled' });

  let reason;
  if (needsSessionReset) reason = 'session-establishing case → reset + navigate + fresh snapshot + certify entry';
  else if (needsNavigation) reason = 'wrong starting page → navigate + fresh snapshot + certify entry';
  else if (needsFreshSnapshot) reason = 'correct page but stale context → fresh snapshot + certify entry';
  else reason = 'already on a fresh, correct page → certify entry only';

  return { actions, needsSessionReset, needsNavigation, needsFreshSnapshot, entryAlreadyCorrect: onEntry === true, requiredEntryPattern, reason };
}

/** After the case-start actions run, certify we actually reached the entry page. */
function certifyEntryReached({ currentUrl = null, requiredEntryPattern = null } = {}) {
  if (!requiredEntryPattern) return { certified: true, reason: 'no specific entry page required' };
  if (currentUrl == null) return { certified: false, reason: 'no current URL captured to certify entry' };
  const ok = urlMatches(currentUrl, requiredEntryPattern);
  return { certified: ok, reason: ok ? `on the required entry page (${requiredEntryPattern})` : `NOT on the required entry page: at ${currentUrl}, expected ${requiredEntryPattern}` };
}

module.exports = { planCaseStart, certifyEntryReached };
