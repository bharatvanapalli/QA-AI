'use strict';

/**
 * pageStateBuilder (Phase B-2a) — ONE acquisition channel, emitting CERTIFIED
 * channel objects. Pure + deterministic (no LLM, no DB, no MCP roundtrip).
 * Reuses the canonical snapshot parser (mcp.parseSnapshotLine) so it reads the
 * accessibility tree through the SAME lens as the role-map / self-heal and can
 * never drift on snapshot format.
 *
 * ── NO FINAL NULLS — certified channels (locked architecture) ────────────────
 * Every evidence channel is a CERTIFIED object, never a loose null/array:
 *
 *   {
 *     status: 'present' | 'inspected_empty' | 'needs_acquisition',
 *     items:  [...]            // (collection channels) concrete evidence
 *     value:  <scalar>         // (scalar channels: url/title/settled/…)
 *     certification: {
 *       inspectedSources: [...]   // what WAS inspected (present / inspected_empty)
 *       missingSources:   [...]   // what still must be inspected (needs_acquisition)
 *       nextActions:      [...]   // how to acquire it (needs_acquisition)
 *       confidence: 'high'|'medium'|'low',
 *       notes: [...]
 *     }
 *   }
 *
 * Invariants (the strict rules):
 *   1. `present`           ⇒ items.length > 0 (or a concrete scalar value).
 *   2. `inspected_empty`   ⇒ inspectedSources is NON-EMPTY and covers an
 *                            AUTHORITATIVE absence source for the channel. A
 *                            channel can only be certified empty after the
 *                            sources that COULD hold the evidence were inspected.
 *   3. `needs_acquisition` ⇒ missingSources + nextActions are populated. This is
 *                            the new internal `null`: a TRANSIENT state the live
 *                            acquisition loop (B-2b) must ESCALATE on. It is
 *                            FORBIDDEN as final verdict evidence / report / export
 *                            (enforced by certificationReport / assertCertified).
 *
 * Offline reality: from an accessibility snapshot ALONE this channel can confirm
 * PRESENCE of a field error, but it CANNOT certify ABSENCE of one — that needs
 * the DOM sources (aria-describedby / error containers) the live B-2b channel
 * supplies via `domFacts`. So a snapshot with no field error yields
 * `needs_acquisition` for fieldErrors (NOT a fake "inspected_empty"). Page-level
 * alerts DO live in the a11y tree, so pageErrors can be certified empty from the
 * snapshot.
 *
 * NOT wired into the live verdict path. The raw checker-compatible view is kept
 * SEPARATE (toCheckerPageState) so this checkpoint doesn't touch evidenceCheckers
 * or the green replay guard.
 */

const { parseSnapshotLine } = require('./mcp');
const { isErrorText, classifyMessageText } = require('../lib/messageClass');

// Acquisition source names (shared vocabulary with the future DOM channel).
const SRC = {
  A11Y: 'accessibility_snapshot',
  VISIBLE_TEXT: 'visible_text',
  FIELD_GROUP: 'field_group',
  ARIA_DESCRIBEDBY: 'aria_describedby',
  DOM_ERROR_CONTAINERS: 'dom_error_containers',
  NEARBY_TEXT: 'nearby_text',
  SESSION_URL: 'session_url',
  NETWORK_LOG: 'network_log',
  CONSOLE_LOG: 'console_log',
  SETTLE_SIGNAL: 'settle_signal',
};
// To certify ABSENCE of a field error we must have inspected at least one of
// these (a hidden/aria-only validation message is not visible in the a11y tree).
const FIELD_ERROR_ABSENCE_SOURCES = [SRC.ARIA_DESCRIBEDBY, SRC.DOM_ERROR_CONTAINERS];
// Page-level alerts/toasts ARE exposed in the accessibility tree, so it is an
// authoritative absence source for pageErrors.
const PAGE_ERROR_ABSENCE_SOURCES = [SRC.A11Y, SRC.DOM_ERROR_CONTAINERS];

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const PAGE_ALERT_ROLES = new Set(['alert', 'status', 'alertdialog']);
const CHECKABLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

const STATUS = { PRESENT: 'present', EMPTY: 'inspected_empty', PENDING: 'needs_acquisition' };
// Evidence kinds whose ABSENCE (all channels inspected-empty) may only be
// certified once the page is SETTLED — otherwise a validation/error message that
// renders a beat after the action would be read as a false "no error" -> bug.
// PRESENCE of these still certifies immediately (a visible error is a visible error).
const ABSENCE_NEEDS_SETTLE = new Set(['field_error', 'error_present']);

const FIELD_ERROR_NEXT_ACTIONS = [
  'browser_evaluate: read aria-invalid / aria-describedby on the target field',
  'browser_evaluate: scan the field form-group for an error container (.error/.invalid/[role=alert])',
  're-snapshot after the page settles, then re-check',
  'inspect nearby text by DOM/bounding-box proximity to the field',
];

function normaliseFieldRole(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null;
}
function leadingIndent(line) { const m = /^(\s*)/.exec(line || ''); return m ? m[1].length : 0; }

function parseRows(snapshotText) {
  const rows = [];
  for (const line of String(snapshotText).split(/\r?\n/)) {
    const parsed = parseSnapshotLine(line);
    if (!parsed) continue;
    let text = parsed.name || '';
    if (!text) {
      const colon = /:\s*(.+?)\s*$/.exec(parsed.rest || '');
      if (colon && !/\[ref=/.test(colon[1])) text = colon[1];
    }
    rows.push({ indent: leadingIndent(line), role: (parsed.role || '').toLowerCase(), name: parsed.name || '', text, ref: parsed.ref || null, raw: line });
  }
  return rows;
}

/**
 * Scope error text nodes to fields by ORDER + PROXIMITY (never naive global text
 * matching): an error node belongs to the most recent preceding field with no
 * other field between them, and only within that field's group. An error under
 * an alert/status role, or with no qualifying field before it, is page-level.
 */
function extractErrors(rows) {
  const fieldErrors = [];
  const pageErrors = [];
  let lastField = null;
  let alertIndent = null;

  rows.forEach((r, i) => {
    if (alertIndent != null && r.indent <= alertIndent) alertIndent = null;
    if (PAGE_ALERT_ROLES.has(r.role)) alertIndent = r.indent;

    if (FIELD_ROLES.has(r.role)) {
      lastField = { name: r.name, fieldRole: normaliseFieldRole(r.name), indent: r.indent, index: i };
      return;
    }
    const content = r.text || r.name || '';
    if (!content || !isErrorText(content)) return;
    const messageClass = classifyMessageText(content);

    const inAlert = alertIndent != null;
    const scopable = !inAlert && lastField && r.indent >= lastField.indent && (i - lastField.index) <= 4;
    if (scopable) {
      fieldErrors.push({ fieldRole: lastField.fieldRole, fieldName: lastField.name, messageClass, text: content, source: SRC.FIELD_GROUP });
    } else {
      pageErrors.push({ messageClass, text: content, source: inAlert ? 'a11y_alert' : SRC.A11Y });
    }
  });
  return { fieldErrors, pageErrors };
}

function extractFieldValues(rows) {
  const values = {}; let found = false;
  for (const r of rows) {
    if (!FIELD_ROLES.has(r.role) || !r.name) continue;
    const role = normaliseFieldRole(r.name);
    if (r.text && r.text !== r.name) { values[role] = r.text; found = true; }
  }
  return { values, found };
}
// Login-form visibility (site-INDEPENDENT, role-based): the defining inputs of a
// login form are a username/email/login textbox + a password field; a submit button
// (log in / sign in) strengthens it. Keyed off snapshot roles/names, never site CSS.
function extractLoginForm(rows) {
  let username = false; let password = false; let submit = false; let otherTextbox = false;
  for (const r of rows) {
    const n = `${r.name || r.text || ''}`.toLowerCase();
    const raw = `${r.raw || ''}`.toLowerCase();
    if (FIELD_ROLES.has(r.role)) {
      if (/pass/.test(n) || /\[password\]|type=["']?password/.test(raw)) password = true;
      else if (/user|email|e-mail|login|account|phone|mobile|userid|username/.test(n)) username = true;
      else otherTextbox = true;
    } else if (r.role === 'button' && /\b(log\s*in|sign\s*in|signin|submit|continue|log\s*on|logon)\b/.test(n)) {
      submit = true;
    }
  }
  // A password field plus any other text input is a 2-field login form even when the
  // username input carries a generic/unlabelled name.
  if (password && !username && otherTextbox) username = true;
  return { usernameVisible: username, passwordVisible: password, submitVisible: submit };
}
function extractCheckedState(rows) {
  const state = {}; let found = false;
  for (const r of rows) {
    if (!CHECKABLE_ROLES.has(r.role)) continue;
    state[normaliseFieldRole(r.name) || `ref_${r.ref}`] = /\[checked\]|\[selected\]/.test(r.raw || '');
    found = true;
  }
  return { state, found };
}
function visibleTextOf(rows) { return rows.map((r) => r.text || r.name).filter(Boolean).join(' │ ').slice(0, 8000); }

// ── certified channel constructors ──────────────────────────────────────────
function presentColl(items, inspectedSources, confidence, notes = []) {
  return { status: STATUS.PRESENT, items, certification: { inspectedSources, missingSources: [], nextActions: [], confidence, notes } };
}
function emptyColl(inspectedSources, confidence, notes = []) {
  return { status: STATUS.EMPTY, items: [], certification: { inspectedSources, missingSources: [], nextActions: [], confidence, notes } };
}
function pendingColl(missingSources, nextActions, notes = []) {
  return { status: STATUS.PENDING, items: [], certification: { inspectedSources: [], missingSources, nextActions, confidence: 'low', notes } };
}
function presentScalar(value, inspectedSources, confidence = 'high', notes = []) {
  return { status: STATUS.PRESENT, value, certification: { inspectedSources, missingSources: [], nextActions: [], confidence, notes } };
}
function pendingScalar(missingSources, nextActions, notes = []) {
  return { status: STATUS.PENDING, value: null, certification: { inspectedSources: [], missingSources, nextActions, confidence: 'low', notes } };
}

/** Build an error channel honouring the absence-certification rule. */
function errorChannel(items, inspectedSources, absenceSources, hasDom, nextActionsIfPending) {
  if (items.length) {
    return presentColl(items, inspectedSources, hasDom ? 'high' : 'medium');
  }
  const inspectedAbsence = absenceSources.some((s) => inspectedSources.includes(s));
  if (inspectedAbsence) return emptyColl(inspectedSources, 'high', ['no matching error after inspecting authoritative absence sources']);
  const missing = absenceSources.filter((s) => !inspectedSources.includes(s));
  return pendingColl(missing, nextActionsIfPending, ['snapshot showed no error; authoritative absence sources not yet inspected — escalate, do not finalize']);
}

/**
 * @returns {object} pageState with certified `channels` — ALWAYS (never null).
 * With zero observation, every channel is `needs_acquisition` (the acquire-first
 * trigger), so a bare null can never re-enter the architecture here.
 */
function buildPageState(input = {}) {
  const { snapshotText, url = null, title = null, domFacts = null, networkLog = null, consoleErrors = null, settled } = input;
  const hasSnapshot = typeof snapshotText === 'string' && snapshotText.trim().length > 0;
  const hasDom = domFacts && typeof domFacts === 'object';
  // NO-FINAL-NULL: even with zero observation we return a fully-certified
  // pageState whose channels are ALL `needs_acquisition` (each carrying
  // nextActions) — never a bare null. An all-pending pageState IS the
  // "acquire-first" trigger, so null can never re-enter the architecture here.

  const rows = hasSnapshot ? parseRows(snapshotText) : [];
  const a11y = hasSnapshot ? extractErrors(rows) : { fieldErrors: [], pageErrors: [] };

  const domInspected = (hasDom && Array.isArray(domFacts.inspectedSources)) ? domFacts.inspectedSources : [];
  // DOM-probe errors may arrive without a messageClass — classify from text via
  // the SAME shared vocabulary so they match the checker's required class.
  const domFieldErrors = (hasDom && Array.isArray(domFacts.fieldErrors)) ? domFacts.fieldErrors.map((e) => ({ source: SRC.DOM_ERROR_CONTAINERS, ...e, messageClass: e.messageClass || classifyMessageText(e.text) })) : [];
  const domPageErrors = (hasDom && Array.isArray(domFacts.pageErrors)) ? domFacts.pageErrors.map((e) => ({ source: SRC.DOM_ERROR_CONTAINERS, ...e, messageClass: e.messageClass || classifyMessageText(e.text) })) : [];

  const a11ySources = hasSnapshot ? [SRC.A11Y, SRC.VISIBLE_TEXT, SRC.FIELD_GROUP] : [];
  const errSources = [...a11ySources, ...domInspected];

  const fieldErrorsCh = errorChannel([...a11y.fieldErrors, ...domFieldErrors], errSources, FIELD_ERROR_ABSENCE_SOURCES, hasDom, FIELD_ERROR_NEXT_ACTIONS);
  const pageErrorsCh = errorChannel([...a11y.pageErrors, ...domPageErrors], errSources, PAGE_ERROR_ABSENCE_SOURCES, hasDom,
    ['re-snapshot after settle to catch a transient alert/toast', 'browser_evaluate: scan page-level alert/toast containers']);

  // field values + checked state
  const fv = hasSnapshot ? extractFieldValues(rows) : { values: {}, found: false };
  if (hasDom && domFacts.fieldValues) { Object.assign(fv.values, domFacts.fieldValues); fv.found = fv.found || Object.keys(domFacts.fieldValues).length > 0; }
  const cs = hasSnapshot ? extractCheckedState(rows) : { state: {}, found: false };
  if (hasDom && domFacts.checkedState) { Object.assign(cs.state, domFacts.checkedState); cs.found = cs.found || Object.keys(domFacts.checkedState).length > 0; }

  const netItems = Array.isArray(networkLog) ? networkLog.filter((n) => n && Number(n.status) >= 400).map((n) => ({ url: n.url, method: n.method || null, status: Number(n.status) })) : null;
  const conItems = Array.isArray(consoleErrors) ? consoleErrors.filter(Boolean) : null;

  const channels = {
    url: url != null ? presentScalar(url, [SRC.SESSION_URL]) : pendingScalar([SRC.SESSION_URL], ['capture session.currentUrl / read URL from the next snapshot']),
    title: title != null ? presentScalar(title, [SRC.A11Y]) : pendingScalar([SRC.A11Y], ['read document.title via browser_evaluate']),
    snapshotText: hasSnapshot ? presentScalar(snapshotText, [SRC.A11Y], 'high', ['raw, for trace only']) : pendingScalar([SRC.A11Y], ['take a fresh snapshot']),
    visibleText: hasSnapshot ? presentScalar(visibleTextOf(rows), [SRC.VISIBLE_TEXT]) : pendingScalar([SRC.VISIBLE_TEXT], ['take a fresh snapshot']),
    fieldErrors: fieldErrorsCh,
    pageErrors: pageErrorsCh,
    fieldValues: fv.found ? presentScalar(fv.values, errSources)
      : (hasSnapshot || hasDom ? { status: STATUS.EMPTY, value: {}, certification: { inspectedSources: errSources, missingSources: [], nextActions: [], confidence: 'medium', notes: ['no field values read from inspected sources'] } }
        : pendingScalar([SRC.A11Y, SRC.DOM_ERROR_CONTAINERS], ['browser_evaluate: read input .value for each field'])),
    checkedState: cs.found ? presentScalar(cs.state, errSources)
      : (hasSnapshot || hasDom ? { status: STATUS.EMPTY, value: {}, certification: { inspectedSources: errSources, missingSources: [], nextActions: [], confidence: 'medium', notes: ['no checkable controls found'] } }
        : pendingScalar([SRC.A11Y], ['take a fresh snapshot'])),
    networkFailures: netItems == null ? pendingColl([SRC.NETWORK_LOG], ['attach the run network log'])
      : (netItems.length ? presentColl(netItems, [SRC.NETWORK_LOG], 'high') : emptyColl([SRC.NETWORK_LOG], 'high')),
    consoleErrors: conItems == null ? pendingColl([SRC.CONSOLE_LOG], ['attach the page console log'])
      : (conItems.length ? presentColl(conItems, [SRC.CONSOLE_LOG], 'high') : emptyColl([SRC.CONSOLE_LOG], 'high')),
    settled: typeof settled === 'boolean' ? presentScalar(settled, [SRC.SETTLE_SIGNAL]) : pendingScalar([SRC.SETTLE_SIGNAL], ['wait for network-idle / DOM settle and record the signal']),
    // login-form visibility (audit #4): PRESENT when the defining inputs (username +
    // password) are visible; EMPTY when a snapshot was inspected but no login form is
    // present; PENDING (needs_acquisition) when no snapshot was captured — so the
    // composite negative-login oracle blocks (evidence_missing) rather than passing.
    loginForm: !hasSnapshot
      ? pendingScalar([SRC.A11Y], ['take a fresh snapshot of the login page to confirm the form is visible'])
      : ((() => {
        const lf = extractLoginForm(rows);
        return (lf.usernameVisible && lf.passwordVisible)
          ? presentScalar(lf, [SRC.A11Y], 'high')
          : { status: STATUS.EMPTY, value: lf, certification: { inspectedSources: [SRC.A11Y], missingSources: [], nextActions: [], confidence: 'high', notes: ['snapshot inspected; login form (username + password) not visible'] } };
      })()),
  };

  // ONLY the certified channels surface. No raw top-level null scalars — every
  // value lives in its channel (channels.url.value, channels.snapshotText.value,
  // …) gated by that channel's status, so a null can never be read without its
  // acquisition status alongside it.
  return { channels };
}

// ── consumption helpers ───────────────────────────────────────────────────────

/**
 * Candidate pageState channels for an evidence KIND. Most kinds map to ONE
 * channel; `error_present` is satisfied by ALTERNATIVE channels — a rejection
 * error may surface page-level (pageErrors) OR field-level (fieldErrors).
 */
function evidenceCandidateChannels(kind) {
  switch (kind) {
    case 'page_present':
    case 'destination_absent':
    case 'page_settled': return ['url'];
    case 'field_error': return ['fieldErrors'];
    case 'error_present': return ['pageErrors', 'fieldErrors']; // OR
    case 'login_form_present': return ['loginForm'];
    default: return [];
  }
}

/** Flat union of channels a row's evidence touches — for the acquisition loop to target. */
function channelsForEvidence(requiredEvidence) {
  const set = new Set();
  for (const e of (Array.isArray(requiredEvidence) ? requiredEvidence : [])) {
    if (!e || !e.kind) continue;
    for (const ch of evidenceCandidateChannels(e.kind)) set.add(ch);
  }
  return Array.from(set);
}

/**
 * Certification gate (operationalises "no final nulls"), per evidence item, with
 * ALTERNATIVE-channel semantics:
 *   - PRESENCE wins:  if ANY candidate channel is `present`        -> certified.
 *   - ABSENCE is AND: else if ALL candidate channels are `inspected_empty`
 *                     -> certified (a real "no error anywhere" signal).
 *   - otherwise (some channel still pending, none present) -> NOT certified;
 *     report the pending candidate channels + nextActions so the loop escalates.
 *
 * This is why an auth-rejection row with a visible page-level alert does NOT get
 * stuck waiting on field-error absence: pageErrors `present` certifies
 * error_present immediately. The verdict MUST NOT finalize while certified=false.
 *
 * @param {object} pageState
 * @param {Array}  requiredEvidence  the row's requiredEvidence[] items
 */
function certificationReport(pageState, requiredEvidence) {
  const items = Array.isArray(requiredEvidence) ? requiredEvidence : [];
  const channels = (pageState && pageState.channels) || {};
  const statusOf = (k) => (channels[k] ? channels[k].status : STATUS.PENDING);
  const settledCertified = !!(channels.settled && channels.settled.status === STATUS.PRESENT && channels.settled.value === true);
  const pending = [];
  for (const e of items) {
    if (!e || !e.kind) continue;
    const cands = evidenceCandidateChannels(e.kind);
    if (!cands.length) continue; // kind with no pageState channel dependency
    const statuses = cands.map((c) => ({ c, s: statusOf(c) }));
    const anyPresent = statuses.some((x) => x.s === STATUS.PRESENT);
    const allEmpty = statuses.every((x) => x.s === STATUS.EMPTY);
    const absenceNeedsSettle = ABSENCE_NEEDS_SETTLE.has(e.kind);

    // PRESENCE wins immediately. ABSENCE certifies only when all candidate
    // channels are inspected-empty AND (for error kinds) the page is settled.
    let certified;
    if (anyPresent) certified = true;
    else if (allEmpty) certified = absenceNeedsSettle ? settledCertified : true;
    else certified = false;
    if (certified) continue;

    // Distinguish "still need to inspect the error channel" from "channel is
    // inspected-empty but the page isn't settled yet" — the latter is resolved
    // by settling + re-snapshotting, not by another DOM probe.
    const awaitingSettle = allEmpty && absenceNeedsSettle && !settledCertified;
    const stillPending = statuses.filter((x) => x.s === STATUS.PENDING);
    const settleCert = (channels.settled && channels.settled.certification) || {};
    pending.push({
      kind: e.kind,
      channels: cands,
      awaitingSettle: awaitingSettle || undefined,
      missingSources: awaitingSettle
        ? (settleCert.missingSources && settleCert.missingSources.length ? settleCert.missingSources : [SRC.SETTLE_SIGNAL])
        : stillPending.flatMap((x) => (channels[x.c] && channels[x.c].certification && channels[x.c].certification.missingSources) || ['(channel absent)']),
      nextActions: awaitingSettle
        ? (settleCert.nextActions && settleCert.nextActions.length ? settleCert.nextActions : ['wait for the page to settle, then re-snapshot and re-check'])
        : stillPending.flatMap((x) => (channels[x.c] && channels[x.c].certification && channels[x.c].certification.nextActions) || []),
    });
  }
  return { certified: pending.length === 0, pending };
}

/**
 * PRIVATE compatibility adapter — flatten certified channels into the shape
 * evidenceCheckers expects. A `needs_acquisition` channel flattens to `null`
 * here, so this MUST NOT be called on the live verdict path directly: a pending
 * channel would silently flatten to null and reach the checker as `unobservable`
 * — exactly the no-final-null violation we forbid. The live path calls
 * `toCertifiedCheckerPageState` (below), which REFUSES while anything is pending.
 * This raw adapter remains only for: (a) already-certified pageStates, and (b)
 * tests that construct a known-complete pageState. `inspected_empty` → `[]` (the
 * checker can then report a real `violated`). entry/authed URL patterns pass
 * through.
 */
function toCheckerPageState(pageState, { entryUrlPattern = null, authedUrlPattern = null } = {}) {
  if (!pageState || !pageState.channels) return null;
  const c = pageState.channels;
  const coll = (ch) => (ch.status === STATUS.PRESENT ? ch.items : ch.status === STATUS.EMPTY ? [] : null);
  const scal = (ch) => (ch.status === STATUS.PENDING ? null : ch.value);
  return {
    url: scal(c.url),
    title: scal(c.title),
    entryUrlPattern,
    authedUrlPattern,
    visibleText: scal(c.visibleText),
    fieldErrors: coll(c.fieldErrors),
    pageErrors: coll(c.pageErrors),
    fieldValues: scal(c.fieldValues),
    checkedState: scal(c.checkedState),
    loginForm: scal(c.loginForm), // {usernameVisible,passwordVisible,submitVisible} | null when pending
    networkFailures: coll(c.networkFailures),
    consoleErrors: coll(c.consoleErrors),
    settled: c.settled.status === STATUS.PENDING ? undefined : c.settled.value,
  };
}

/**
 * SAFE live-path boundary (enforces "no final null at the verdict edge"):
 * produce checker input ONLY when every channel this row's evidence needs is
 * CERTIFIED (present / inspected_empty). If ANY required channel is still
 * `needs_acquisition`, it REFUSES — returns { ok:false, pending } so the
 * acquisition loop (B-2b) escalates, instead of letting a pending channel
 * flatten to null and reach the verdict.
 *
 * The live path MUST call this — never toCheckerPageState directly — before
 * judgeRowEvidence. (B-2d wires this in; here it is the contract + the guard.)
 *
 * @returns {{ ok:boolean, pending:Array<{channel,missingSources,nextActions}>, checkerPageState:(object|null) }}
 */
function toCertifiedCheckerPageState(pageState, requiredEvidence, { entryUrlPattern = null, authedUrlPattern = null } = {}) {
  const report = certificationReport(pageState, requiredEvidence);
  if (!report.certified) return { ok: false, pending: report.pending, checkerPageState: null };
  return { ok: true, pending: [], checkerPageState: toCheckerPageState(pageState, { entryUrlPattern, authedUrlPattern }) };
}

module.exports = {
  buildPageState,
  toCheckerPageState,            // PRIVATE compat adapter — do not use on the live verdict path
  toCertifiedCheckerPageState,   // SAFE boundary — use this on the live path
  certificationReport,
  channelsForEvidence,
  evidenceCandidateChannels,
  normaliseFieldRole,
  STATUS,
  SRC,
};
