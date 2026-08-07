'use strict';

/**
 * Evidence Acquisition Engine (Phase B-2b) — the ACTIVE half of the no-final-null
 * architecture. It does NOT settle for `needs_acquisition`: given a row's
 * requiredEvidence it keeps gathering across channels until every required item
 * is CERTIFIED (present / inspected_empty), or it declares an internal
 * `automation_capture_failure` (→ retry/heal, NEVER a user-facing website bug).
 *
 *   acquire → snapshot → buildPageState → certificationReport
 *     ├─ certified?  → return the CERTIFIED checker pageState (verdict may run)
 *     └─ pending?    → ESCALATE (DOM probe / settle / re-snapshot) → loop
 *
 * Dependency-injected `observer` so the loop is unit-provable offline AND binds
 * to the live MCP session unchanged (createMcpObserver below). The engine never
 * calls raw toCheckerPageState — only toCertifiedCheckerPageState — so a pending
 * channel can never flatten into a verdict.
 *
 *   observer.snapshot()  → { snapshotText, url, title, settled?, networkLog?, consoleErrors? }
 *   observer.domProbe?() → domFacts { inspectedSources[], fieldErrors[], pageErrors[], fieldValues{}, checkedState{} }
 *   observer.settle?()   → Promise (wait for the page to settle, then next round re-snapshots)
 */

const {
  buildPageState,
  certificationReport,
  toCertifiedCheckerPageState,
  channelsForEvidence,
} = require('./pageStateBuilder');

// ── The generic DOM probe (runs in-page via browser_evaluate) ────────────────
// Reads the authoritative field/page error sources the accessibility snapshot
// can't see: aria-invalid / aria-describedby, form-group error containers (by
// generic class/role, never a site string), page-level alerts/toasts, plus field
// values + checked state. Returns a `domFacts` object buildPageState merges.
// Kept as a string because it is serialized to the browser by @playwright/mcp.
const DOM_PROBE_FN = `() => {
  const norm = (s) => (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const ERR_RE = /error|invalid|help-?block|field-?error|hint|warning|danger/i;
  const labelOf = (el) => {
    let l = el.getAttribute('aria-label') || '';
    if (!l && el.id) { try { const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]'); if (lab) l = lab.textContent; } catch (e) {} }
    if (!l) { const lp = el.closest && el.closest('label'); if (lp) l = lp.textContent; }
    if (!l) l = el.getAttribute('placeholder') || el.getAttribute('name') || '';
    return (l || '').trim();
  };
  const inputs = Array.from(document.querySelectorAll('input, select, textarea, [role=textbox], [role=combobox], [contenteditable=true]'));
  const fieldErrors = []; const seen = new Set();
  for (const el of inputs) {
    const label = labelOf(el); const fieldRole = norm(label); if (!fieldRole) continue;
    const texts = [];
    const desc = el.getAttribute('aria-describedby');
    if (desc) desc.split(/\\s+/).forEach((id) => { const d = document.getElementById(id); if (d && d.textContent && d.textContent.trim()) texts.push(d.textContent.trim()); });
    const group = (el.closest && el.closest('.form-group, .field, [class*="input"], [class*="form"], [class*="field"], [class*="group"]')) || el.parentElement;
    if (group) group.querySelectorAll('*').forEach((node) => {
      if (node === el) return;
      const cls = (node.className && node.className.toString) ? node.className.toString() : '';
      const role = node.getAttribute && node.getAttribute('role');
      if ((ERR_RE.test(cls) || role === 'alert') && node.textContent && node.textContent.trim()) texts.push(node.textContent.trim());
    });
    const invalid = el.getAttribute('aria-invalid') === 'true';
    for (const t of texts) { const k = fieldRole + '|' + t; if (seen.has(k)) continue; seen.add(k); fieldErrors.push({ fieldRole, fieldName: label.slice(0, 80), text: t.slice(0, 300), source: 'dom_error_containers', ariaInvalid: invalid }); }
  }
  const pageErrors = []; const pseen = new Set();
  document.querySelectorAll('[role=alert], [role=status], .toast, .snackbar, [class*="alert"], [class*="toast"], [class*="error-banner"], [class*="error-message"]').forEach((node) => {
    const t = (node.textContent || '').trim(); if (!t || pseen.has(t)) return; pseen.add(t);
    pageErrors.push({ text: t.slice(0, 300), source: 'dom_error_containers' });
  });
  const fieldValues = {}; const checkedState = {};
  for (const el of inputs) { const r = norm(labelOf(el)); if (!r) continue; if (el.type === 'checkbox' || el.type === 'radio') checkedState[r] = !!el.checked; else if (typeof el.value === 'string' && el.value) fieldValues[r] = el.value; }
  return { inspectedSources: ['aria_describedby', 'dom_error_containers', 'nearby_text'], fieldErrors, pageErrors, fieldValues, checkedState };
}`;

/** Union-merge successive domFacts probes (later probe corroborates/adds). */
function mergeDomFacts(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  const dedupe = (arr, key) => { const seen = new Set(); const out = []; for (const x of arr) { const k = key(x); if (seen.has(k)) continue; seen.add(k); out.push(x); } return out; };
  return {
    inspectedSources: Array.from(new Set([...(prev.inspectedSources || []), ...(next.inspectedSources || [])])),
    fieldErrors: dedupe([...(prev.fieldErrors || []), ...(next.fieldErrors || [])], (e) => `${e.fieldRole}|${e.text}`),
    pageErrors: dedupe([...(prev.pageErrors || []), ...(next.pageErrors || [])], (e) => e.text),
    fieldValues: { ...(prev.fieldValues || {}), ...(next.fieldValues || {}) },
    checkedState: { ...(prev.checkedState || {}), ...(next.checkedState || {}) },
  };
}

/**
 * Acquire certified evidence for a row's requiredEvidence. Escalates up to
 * maxRounds. Returns the live page-state + the certified checker input, or an
 * internal automation_capture_failure (no fake bug, no fake pass).
 *
 * @returns {Promise<{ ok:boolean, status:string, rounds:number, pageState:object, checkerPageState:(object|null), pending:Array }>}
 */
async function acquireEvidence({ requiredEvidence, observer, patterns = {}, maxRounds = 4, onLog = async () => {} } = {}) {
  if (!observer || typeof observer.snapshot !== 'function') throw new Error('acquireEvidence: observer.snapshot is required');
  // Each acquisition cycle follows fresh actions/navigation — never trust a
  // settle signal carried over from a PRIOR cycle (a stale `settled:true` would
  // let absence certify on a page that has since changed). Re-establish settle
  // from scratch this cycle.
  if (typeof observer.resetSettle === 'function') observer.resetSettle();
  let domFacts = null;
  let pageState = null;
  let report = { certified: false, pending: [] };

  for (let round = 1; round <= maxRounds; round++) {
    const obs = (await observer.snapshot()) || {};
    pageState = buildPageState({
      snapshotText: obs.snapshotText, url: obs.url, title: obs.title,
      settled: obs.settled, networkLog: obs.networkLog, consoleErrors: obs.consoleErrors,
      domFacts,
      entryUrlPattern: patterns.entryUrlPattern || null,
      authedUrlPattern: patterns.authedUrlPattern || null,
    });
    report = certificationReport(pageState, requiredEvidence);
    if (report.certified) {
      const certified = toCertifiedCheckerPageState(pageState, requiredEvidence, patterns);
      await onLog('info', `evidence acquired & certified in ${round} round(s)`);
      return { ok: true, status: 'certified', rounds: round, pageState, checkerPageState: certified.checkerPageState, pending: [] };
    }

    // ESCALATE — resolve the pending channels rather than finalize a null.
    const awaitingSettle = report.pending.some((p) => p.awaitingSettle);
    const needsErrorChannels = report.pending.some((p) => (p.channels || []).some((c) => c === 'fieldErrors' || c === 'pageErrors'));
    await onLog('info', `acquisition round ${round}: not yet certified — pending [${report.pending.map((p) => p.kind).join(', ')}]${awaitingSettle ? ' (awaiting settle)' : ''}; escalating`);

    // The channels are inspected-empty but the page isn't settled — settle and
    // re-snapshot (a late-rendering validation message may yet appear). Probing
    // again would just re-read the same empty DOM, so settle takes priority.
    if (awaitingSettle) {
      if (typeof observer.settle === 'function') { await observer.settle(); continue; }
      break; // cannot settle -> cannot certify absence -> capture failure (no false bug)
    }
    if (needsErrorChannels && typeof observer.domProbe === 'function') {
      try {
        const probed = await observer.domProbe();
        domFacts = mergeDomFacts(domFacts, probed);
      } catch (e) {
        await onLog('warn', `DOM probe failed (${e && e.message}); will retry/settle`);
        if (typeof observer.settle === 'function') await observer.settle();
      }
    } else if (typeof observer.settle === 'function') {
      await observer.settle();
    } else {
      break; // no escalation lever available — stop and report capture failure
    }
  }

  // Bounded escalation exhausted. This is an INTERNAL automation capture failure
  // (the loop could not certify a required channel) — it must trigger retry/heal
  // upstream, and must NEVER be reported as a website bug or a pass.
  await onLog('warn', `evidence NOT certified after ${maxRounds} round(s); pending [${report.pending.map((p) => p.kind).join(', ')}] — automation_capture_failure`);
  return { ok: false, status: 'automation_capture_failure', rounds: maxRounds, pageState, checkerPageState: null, pending: report.pending };
}

/**
 * Live adapter — bind an observer to a real MCP session. The conductor passes
 * its `mcp` module + session; this turns each lever into the matching MCP call.
 * (Wired into the run at B-2d; validated live at B-2e. Kept thin on purpose.)
 */
function createMcpObserver({ mcp, session, takeSnapshot, fieldHints } = {}) {
  // settle state for this observer: undefined until we've explicitly settled the
  // page (browser_wait_for), then true. Lets absence-certification wait for a
  // settled page on the live path (see certificationReport's settle rule).
  let settledFlag;
  return {
    async snapshot() {
      // takeSnapshot() is the conductor's existing "refresh + return snapshot" helper;
      // fall back to the session's cached lastSnapshot/currentUrl.
      if (typeof takeSnapshot === 'function') {
        const s = (await takeSnapshot()) || {};
        return { snapshotText: s.snapshotText || session.lastSnapshot, url: s.url || session.currentUrl, title: s.title, settled: (s.settled != null ? s.settled : settledFlag), networkLog: s.networkLog, consoleErrors: s.consoleErrors };
      }
      return { snapshotText: session && session.lastSnapshot, url: session && session.currentUrl, settled: settledFlag };
    },
    async domProbe() {
      const res = await mcp.callTool(session, 'browser_evaluate', { function: DOM_PROBE_FN });
      // MCP returns the evaluate result as TEXT inside result.content (e.g.
      // "### Result\n{json}\n### Ran Playwright code…"). Parse via the SAME
      // canonical helpers the rest of mcp.js uses — never reach for res.result /
      // res.value (that returns the whole MCP envelope, not domFacts).
      const text = (typeof mcp.textOfContent === 'function' ? mcp.textOfContent(res && res.content) : '') || '';
      const parsed = typeof mcp.parseEvaluateReturnValue === 'function'
        ? mcp.parseEvaluateReturnValue(text)
        : safeJson(text);
      return parsed && typeof parsed === 'object' ? parsed : null;
    },
    async settle() {
      try { await mcp.callTool(session, 'browser_wait_for', { time: 1 }); settledFlag = true; } catch (_) {}
    },
    // The conductor MUST call this after every mutating action / navigation so a
    // prior `settled:true` is not trusted on a page that has since changed.
    // acquireEvidence also calls it at the start of each cycle as a backstop.
    resetSettle() { settledFlag = undefined; },
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

module.exports = { acquireEvidence, createMcpObserver, mergeDomFacts, DOM_PROBE_FN };
