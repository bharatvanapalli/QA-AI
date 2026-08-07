'use strict';

/**
 * Evidence Checkers (Phase B-slice) — the deterministic GATHER half.
 *
 * The VerdictEngine (verdictEngine.js) is the JUDGE: it tallies index-aligned
 * `observations` against a row's `requiredEvidence`. This module produces those
 * observations from a `pageState` the Conductor captured. Pure + deterministic
 * (CLAUDE.md "Node unless genuine novelty") — URL/text/error matching, no LLM,
 * no DB, no MCP roundtrip. The Conductor (Phase B checkpoint 2) builds `pageState`
 * from the live MCP snapshot and calls judgeRowEvidence(); this same module is
 * exercised offline by the recorded-evidence replay.
 *
 * pageState (every field optional; null/undefined => "not captured" => the
 * dependent checker returns `unobservable`, NEVER a fabricated satisfied — this
 * is the honesty rule: we only assert what was actually observed):
 *   {
 *     url:             string|null,   // current page URL (null = unknown)
 *     entryUrlPattern: string|null,   // identifies the entry/login page (e.g. 'auth/login')
 *     authedUrlPattern:string|null,   // identifies the authenticated area (e.g. 'dashboard') — optional
 *     fieldErrors:     Array|null,    // [{fieldRole, messageClass, text}]; null = NOT captured, [] = captured-none
 *     pageErrors:      Array|null,    // [{messageClass, text}];            null = NOT captured, [] = captured-none
 *     settled:         boolean|undefined,
 *   }
 *
 * Each checker returns an observation: { status: 'satisfied'|'violated'|'unobservable', detail, delta? }.
 *   satisfied    — the page shows what the evidence requires.
 *   violated     — the page shows the OPPOSITE (a real defect — e.g. a negative
 *                  row reached the dashboard, or a required field produced NO error).
 *   unobservable — the relevant channel was not captured; we refuse to guess.
 */

const { evaluateEvidenceContract } = require('./verdictEngine');
const { partitionByCheckability } = require('./evidenceRegistry');
const { REQUIRED_MSG_RE, AUTH_ERR_RE } = require('../lib/messageClass');

function isUrlLike(s) { return typeof s === 'string' && (/^https?:/i.test(s) || s.includes('/')); }

/** Reduce a URL/pattern to its lowercased path (strip origin, query, hash). */
function pathKey(pattern) {
  if (!pattern || typeof pattern !== 'string') return '';
  return pattern.trim().toLowerCase().replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
}

/** Generic, base-path-tolerant URL match: compare on the last 1–2 path segments. */
function urlMatches(url, pattern) {
  const u = (url || '').toLowerCase();
  const key = pathKey(pattern);
  if (!u || !key) return false;
  const segs = key.split('/').filter(Boolean);
  if (!segs.length) return false;
  const tail = segs.slice(-2).join('/');
  return (tail && u.includes(tail)) || u.includes(segs[segs.length - 1]);
}

function obs(status, detail, delta) {
  const o = { status, detail: detail || null };
  if (delta) o.delta = delta;
  return o;
}

// ── page_present ────────────────────────────────────────────────────────────
// req: { page: 'entry'|'destination', urlPattern? }
function checkPagePresent(req, ps) {
  if (!ps || ps.url == null) return obs('unobservable', 'no URL captured');
  const pattern = req.page === 'destination'
    ? (req.urlPattern || null)
    : (ps.entryUrlPattern || null);
  if (!pattern) return obs('unobservable', `no reference pattern for page '${req.page}'`);
  if (urlMatches(ps.url, pattern)) return obs('satisfied', `URL ${ps.url} matches ${req.page} pattern ${pattern}`);
  return obs('violated', `expected ${req.page} page (${pattern}) but URL is ${ps.url}`);
}

// ── destination_absent ───────────────────────────────────────────────────────
// req: { destinationHint?, urlPattern? } — the forbidden (authenticated) destination must be ABSENT.
function checkDestinationAbsent(req, ps) {
  if (!ps || ps.url == null) return obs('unobservable', 'no URL captured');
  const forbidden = (req.urlPattern && isUrlLike(req.urlPattern) ? req.urlPattern : null)
    || (req.destinationHint && isUrlLike(req.destinationHint) ? req.destinationHint : null)
    || ps.authedUrlPattern
    || null;
  if (forbidden && urlMatches(ps.url, forbidden)) {
    return obs('violated', `reached forbidden destination ${forbidden} (URL ${ps.url})`); // the inverse bug
  }
  // Demonstrably still on the entry page => the authenticated area is absent.
  if (ps.entryUrlPattern && urlMatches(ps.url, ps.entryUrlPattern)) {
    return obs('satisfied', `still on entry page (${ps.url}); authenticated destination absent`);
  }
  if (forbidden) return obs('satisfied', `URL ${ps.url} does not match forbidden ${forbidden}`);
  return obs('unobservable', 'no forbidden pattern and not confirmed on entry page');
}

/** Match the FIRST captured error of the right class; returns {hit, delta?} or null. */
function matchError(list, messageClass, expectedText, classRe) {
  for (const e of list) {
    const cls = e && e.messageClass;
    const text = (e && e.text) || '';
    const classOk = (messageClass && cls === messageClass) || (classRe && classRe.test(text)) || (!messageClass && !classRe);
    if (!classOk) continue;
    let delta = null;
    if (expectedText && text && text.trim().toLowerCase() !== String(expectedText).trim().toLowerCase()) {
      delta = { expected: String(expectedText), actual: text }; // advisory text delta, not a failure
    }
    return { hit: e, delta };
  }
  return null;
}

// ── field_error ───────────────────────────────────────────────────────────────
// req: { fieldRole?, messageClass, expectedText? } — a scoped validation error must be present.
function checkFieldError(req, ps) {
  if (!ps || ps.fieldErrors == null) return obs('unobservable', 'field-error channel not captured');
  const scoped = req.fieldRole
    ? ps.fieldErrors.filter((e) => e && (e.fieldRole === req.fieldRole))
    : ps.fieldErrors;
  if (req.fieldRole && !scoped.length) {
    // The field exists in the requirement but no error was captured against it.
    return ps.fieldErrors.length
      ? obs('violated', `no validation error scoped to field '${req.fieldRole}' (saw errors on other fields)`)
      : obs('violated', `required field '${req.fieldRole}' produced NO validation error`);
  }
  const classRe = (req.messageClass === 'required') ? REQUIRED_MSG_RE : null;
  const m = matchError(scoped, req.messageClass === 'required' ? 'required' : req.messageClass, req.expectedText, classRe);
  if (m) return obs('satisfied', `field error present${req.fieldRole ? ` on '${req.fieldRole}'` : ''}: "${m.hit.text || ''}"`, m.delta);
  return obs('violated', `required field error (${req.messageClass}) absent`);
}

// ── error_present ─────────────────────────────────────────────────────────────
// req: { messageClass, expectedText? } — a general (e.g. auth-rejection) error
// must be present. ALTERNATIVE channels: the error may surface page-level
// (pageErrors) OR field-level (fieldErrors). PRESENCE in EITHER satisfies it;
// ABSENCE can only be declared when BOTH channels were actually inspected
// (non-null). If one channel is still uncaptured (null) and no match was found,
// it is unobservable -> the acquisition loop escalates, never a false bug.
function checkErrorPresent(req, ps) {
  const havePage = !!(ps && ps.pageErrors != null);
  const haveField = !!(ps && ps.fieldErrors != null);
  if (!havePage && !haveField) return obs('unobservable', 'error channels not captured (page + field both pending)');
  const classRe = (req.messageClass === 'auth') ? AUTH_ERR_RE : null;
  const pool = [...(havePage ? ps.pageErrors : []), ...(haveField ? ps.fieldErrors : [])];
  const m = matchError(pool, req.messageClass === 'auth' ? null : req.messageClass, req.expectedText, classRe);
  if (m) return obs('satisfied', `error present: "${m.hit.text || ''}"`, m.delta);
  // No match. Only a real defect if BOTH channels were inspected and empty.
  if (havePage && haveField) return obs('violated', `expected ${req.messageClass} error absent in BOTH page and field channels`);
  return obs('unobservable', 'no matching error in the captured channel; the other error channel is not captured yet — acquire it before judging');
}

// ── page_settled (fallback for unknown intent) ─────────────────────────────────
function checkPageSettled(req, ps) {
  if (ps && (ps.settled === true || ps.url != null)) return obs('satisfied', 'page settled');
  return obs('unobservable', 'page state not captured');
}

// ── login_form_present ────────────────────────────────────────────────────────
// req: {} — the LOGIN FORM must be visible (the audit's missing 4th signal). A
// usable login page shows the username/email input AND the password field (a submit
// button strengthens it but isn't gated — many forms submit on Enter). Channel not
// captured → unobservable (acquire, never fake-pass); inspected but no form → violated.
function checkLoginFormPresent(req, ps) {
  const lf = ps && ps.loginForm;
  if (lf == null) return obs('unobservable', 'login-form channel not captured (take/settle a snapshot of the page)');
  if (lf.usernameVisible && lf.passwordVisible) {
    return obs('satisfied', `login form visible (username + password${lf.submitVisible ? ' + submit' : ''})`);
  }
  return obs('violated', `login form not visible (username:${!!lf.usernameVisible}, password:${!!lf.passwordVisible}) — not on a usable login page`);
}

const CHECKERS = {
  page_present: checkPagePresent,
  destination_absent: checkDestinationAbsent,
  field_error: checkFieldError,
  error_present: checkErrorPresent,
  page_settled: checkPageSettled,
  login_form_present: checkLoginFormPresent,
};

/** Gather one observation for a single requiredEvidence item. */
function gatherObservation(req, pageState) {
  const fn = req && req.kind && CHECKERS[req.kind];
  if (!fn) return obs('unobservable', `no checker for kind '${req && req.kind}'`);
  try {
    return fn(req, pageState);
  } catch (e) {
    return obs('unobservable', `checker error: ${e && e.message}`);
  }
}

/** Gather observations index-aligned with a requiredEvidence[] list. */
function gatherObservations(requiredEvidence, pageState) {
  return (Array.isArray(requiredEvidence) ? requiredEvidence : []).map((r) => gatherObservation(r, pageState));
}

/**
 * The Phase-B "gather + judge" entry point. Partitions the row's evidence by
 * registry checkability so ONLY kinds with a real checker gate the verdict
 * (advisory/un-registered kinds are surfaced but never force a verdict), gathers
 * observations for the gating set, and runs the deterministic VerdictEngine.
 *
 * @returns the engine result + { advisory, unregistered, gatheredFor } for trace.
 */
function judgeRowEvidence(evidenceContract, pageState) {
  const { required, advisory, unregistered } = partitionByCheckability(
    (evidenceContract && evidenceContract.requiredEvidence) || [],
  );
  const observations = gatherObservations(required, pageState);
  const gatingContract = { ...evidenceContract, requiredEvidence: required };
  const result = evaluateEvidenceContract(gatingContract, observations);
  return { ...result, advisory, unregistered, gatheredFor: required.map((r) => r.kind) };
}

module.exports = {
  gatherObservation,
  gatherObservations,
  judgeRowEvidence,
  // exported for focused unit assertions
  urlMatches,
  _checkers: CHECKERS,
};
