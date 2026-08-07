'use strict';

/**
 * Phase H M4 — post-loop assertion ratification.
 *
 * After the agent finishes (clean end_turn, ceiling hit, error, cancel,
 * anything), ANY declared assertion that the agent did NOT call
 * `assertion_check` on still has to be checked — otherwise computeVerdict
 * either throws (invariant violation) OR silently passes the case (the
 * worst regression). This module closes that hole deterministically:
 *
 *   1. Take ONE bounded validation snapshot at start (not N — all unchecked
 *      assertions are evaluated against the same final state, without a
 *      second stability cycle).
 *   2. For every declared assertion with no recorded outcome, synthesise
 *      a check by calling `mcp.checkAssertion()` (the synthetic, no LLM)
 *      with the declared payload.
 *   3. URL three-way disambiguation (per
 *      [[verdict-layer-implementation-spec]] M4 §Mechanism 4):
 *        - normalize(currentUrl) === normalize(targetUrl)
 *            → check against the snapshot
 *        - normalize(targetUrl) matched by any entry in visitedUrls
 *          but currentUrl differs
 *            → uncheckable("transient_window_missed")
 *        - neither
 *            → uncheckable("agent_never_reached")
 *   4. Return the augmented `recorded[]` with `source: "post_loop"` on
 *      every newly-added record so the disagreement metric can tell
 *      "agent verified" from "we verified for them".
 *
 * Failure modes:
 *   - No fresh snapshot available (snapshot call errors/timeouts) →
 *     every snapshot-dependent assertion becomes
 *     uncheckable("transient_snapshot_timeout").
 *   - Primitive type we can't verify yet (EVALUATE, FORBIDDEN_*,
 *     unrecognised type) → uncheckable("primitive_unsupported"). Phase 2
 *     will lift these.
 *   - parseFailed declared entry → uncheckable("declared_assertion_unparseable").
 *
 * Normal mode intentionally does not add a stability wait. Thorough mode owns
 * the separately-authored scroll/wait/re-snapshot recovery for transient
 * uncheckables.
 */

const { normalizePath, visitedSetContains } = require('../lib/urlNormalize');

const POST_LOOP_VALIDATION_SNAPSHOT_TIMEOUT_MS = Math.max(
  250,
  Math.min(
    5_000,
    Number(
      process.env.QAAI_POST_LOOP_VALIDATION_SNAPSHOT_TIMEOUT_MS
      || process.env.QAAI_VALIDATION_SNAPSHOT_TIMEOUT_MS,
    ) || 1_200,
  ),
);

/**
 * Translate a declaredAssertion record's `type`/`payload` into the
 * argument shape expected by mcp.checkAssertion(). Returns:
 *   { args, supported: true }  when checkAssertion can verify it
 *   { supported: false, reason } when the primitive isn't supported in Phase 1
 */
function declaredToCheckArgs(decl) {
  if (!decl || !decl.payload) return { supported: false, reason: 'primitive_unsupported' };
  const t = String(decl.type || '').toUpperCase();
  const p = decl.payload;
  switch (t) {
    case 'TEXT':
      if (typeof p.expectedText === 'string') {
        return { supported: true, args: { assertion: `declared:${decl.id}`, expectedText: p.expectedText } };
      }
      return { supported: false, reason: 'primitive_unsupported' };
    case 'URL':
      if (typeof p.expectedUrlPattern === 'string') {
        return { supported: true, args: { assertion: `declared:${decl.id}`, expectedUrlPattern: p.expectedUrlPattern } };
      }
      return { supported: false, reason: 'primitive_unsupported' };
    case 'ROLE':
      if (typeof p.expectedRole === 'string') {
        return { supported: true, args: { assertion: `declared:${decl.id}`, expectedRole: p.expectedRole } };
      }
      return { supported: false, reason: 'primitive_unsupported' };
    case 'DOWNLOAD':
      if (p.filenamePattern || p.minSize || p.mimeType) {
        return {
          supported: true,
          args: {
            assertion: `declared:${decl.id}`,
            expectedDownload: {
              filenamePattern: p.filenamePattern,
              minSize: p.minSize,
              mimeType: p.mimeType,
            },
          },
        };
      }
      return { supported: false, reason: 'primitive_unsupported' };
    case 'FORBIDDEN_TEXT':
      // Phase H+1 — inverted text check via the unexpectedText primitive.
      // matched=true means the forbidden string was absent (success).
      if (typeof p.unexpectedText === 'string') {
        return { supported: true, args: { assertion: `declared:${decl.id}`, unexpectedText: p.unexpectedText } };
      }
      return { supported: false, reason: 'primitive_unsupported' };
    case 'FORBIDDEN_ROLE':
      // Phase H+1 — inverted role check via the unexpectedRole primitive.
      if (typeof p.unexpectedRole === 'string') {
        return { supported: true, args: { assertion: `declared:${decl.id}`, unexpectedRole: p.unexpectedRole } };
      }
      return { supported: false, reason: 'primitive_unsupported' };
    case 'EVALUATE':
      // JS-evaluate primitive still requires a Phase 2 wait_for_stable
      // wiring before we trust running arbitrary JS in post-loop ratify.
      return { supported: false, reason: 'primitive_unsupported' };
    case 'PAGE': {
      // PAGE assertion sprint — Day 3. postLoopRatify dispatches via the
      // pageAssertion arg so checkAssertion → _checkPageAssertion runs the
      // weighted-quorum matcher and (if semantic-fallback is enabled for
      // the run) the page-level LLM rescue.
      if (!p || typeof p !== 'object') {
        return { supported: false, reason: 'primitive_unsupported' };
      }
      if (!p.pageName || !p.expectedSignals || typeof p.expectedSignals !== 'object') {
        return { supported: false, reason: 'primitive_unsupported' };
      }
      return {
        supported: true,
        args: {
          assertion: `declared:${decl.id}`,
          pageAssertion: {
            pageName: p.pageName,
            expectedSignals: p.expectedSignals,
            primaryIndicator: p.primaryIndicator,
          },
        },
      };
    }
    default:
      return { supported: false, reason: 'primitive_unsupported' };
  }
}

/**
 * Map a checkAssertion legacy payload into the V2 outcome contract.
 * Mirrors the augmentation logic in mcp.augmentWithOutcome, copied here
 * so this module is self-contained and doesn't depend on whether the
 * QAAI_ASSERTION_V2 env flag was on during the run.
 *
 *   matched=true                           → "matched"
 *   reason=no_snapshot                     → "uncheckable":"no_snapshot"
 *   reason=missing_criteria                → "uncheckable":"primitive_unsupported"
 *   else (criteria_failed / pollCapped)    → "not_matched"
 */
function legacyToOutcome(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { outcome: 'uncheckable', reason: 'unknown_result' };
  }
  if (parsed.matched === true) return { outcome: 'matched', reason: null };
  if (parsed.reason === 'no_snapshot') return { outcome: 'uncheckable', reason: 'no_snapshot' };
  // transient_snapshot_timeout: the snapshot we evaluated was itself empty / a
  // timeout-error payload — never a settled page with the value absent. Uncheckable
  // + retryable; must NOT fall through to the not_matched default below (that would
  // turn a transient snapshot failure into a false FAIL).
  if (parsed.reason === 'transient_snapshot_timeout') return { outcome: 'uncheckable', reason: 'transient_snapshot_timeout' };
  if (parsed.reason === 'missing_criteria') return { outcome: 'uncheckable', reason: 'primitive_unsupported' };
  // transient_window_missed: agent briefly reached the target URL but had
  // already navigated away when postLoopRatify ran. We genuinely can't
  // evaluate the assertion against the current page — uncheckable.
  if (parsed.reason === 'transient_window_missed') return { outcome: 'uncheckable', reason: 'transient_window_missed' };
  // agent_never_reached: the agent was supposed to visit this URL and
  // never did. This is an execution failure — the SUT was not reached,
  // so the assertion is definitively not verified. Map to not_matched
  // (FAIL), not uncheckable. Treating it as uncheckable was hiding
  // navigation failures inside the needs_human bucket.
  if (parsed.reason === 'agent_never_reached')     return { outcome: 'not_matched', reason: 'agent_never_reached' };
  // semantic_uncheckable: the LLM semantic fallback was invoked and the
  // model couldn't decide from the snapshot. Routes to needs_human so
  // a human can adjudicate — better than masking the doubt as a fail.
  if (parsed.reason === 'semantic_uncheckable') return { outcome: 'uncheckable', reason: 'semantic_uncheckable' };
  // pollCapped: polling exhausted budget — page may have been slow, not wrong.
  if (parsed.pollCapped === true) return { outcome: 'uncheckable', reason: 'stability_timeout' };
  return { outcome: 'not_matched', reason: parsed.reason || 'criteria_failed' };
}

/**
 * Run post-loop ratification.
 *
 * @param {Object} params
 * @param {Object} params.mcp                         The mcp module (require('./mcp')).
 * @param {Object} params.mcpSession                  The active MCP session (may be null in dry-run).
 * @param {Array}  params.declared                    Declared assertion records.
 * @param {Array}  params.recorded                    Outcomes already recorded by the agent's assertion_check calls.
 * @param {string} [params.currentUrl]                The agent's final URL (session.currentUrl).
 * @param {Set<string>} [params.visitedUrls]          Normalized paths the session visited.
 * @param {Function} [params.send]                    Optional WS broadcast for telemetry/UI.
 * @param {string} [params.tcId]                      For WS log routing.
 * @returns {Promise<{ recorded: Array, snapshotTaken: boolean }>}
 */
// Uncheckable reasons that a harder probe (scroll + wait + re-snapshot)
// could plausibly resolve — the page was simply not in an evaluable state
// yet. Structurally-unverifiable reasons (primitive_unsupported, broken
// declared payloads, an LLM that already abstained, a dead session) are NOT
// here: retrying them only burns time. This drives the THOROUGH-mode
// exhaustive re-check.
const RETRYABLE_UNCHECKABLE = new Set([
  'stability_timeout',
  'no_snapshot',
  'transient_snapshot_timeout',
  'transient_window_missed',
  'unparseable_result',
  'unknown_result',
]);

async function captureDomTextFallback(mcp, mcpSession) {
  if (!mcp || !mcpSession) return false;
  try {
    const res = await mcp.callTool(mcpSession, 'browser_evaluate', {
      function: '() => (document.body && document.body.innerText) ? document.body.innerText : (document.documentElement ? document.documentElement.innerText : "")',
    }, {
      timeoutMs: POST_LOOP_VALIDATION_SNAPSHOT_TIMEOUT_MS,
      strictActionEvidence: false,
      telemetry: false,
      source: 'post_loop_ratify_dom_text_fallback',
    });
    return !!res && !res.isError;
  } catch (_) {
    return false;
  }
}

async function postLoopRatify({
  mcp,
  mcpSession,
  declared = [],
  recorded = [],
  currentUrl = null,
  visitedUrls = new Set(),
  send = null,
  tcId = null,
  // THOROUGH only. After the normal ratification pass, settle the page
  // harder (scroll to trigger lazy/below-fold content, wait, re-snapshot)
  // and retry any assertion still uncheckable for a TRANSIENT reason. This
  // can only flip uncheckable → matched/not_matched (a real verdict on
  // newly-evaluable evidence); it can NEVER fabricate a pass. Fast mode
  // leaves the single-snapshot result as-is and routes uncheckables to
  // needs_human.
  exhaustive = false,
}) {
  const out = [...recorded];

  // PATH 4 hardening — non-durable outcomes get re-evaluated.
  //
  // Two classes of non-durable outcomes:
  //
  // (a) uncheckable with a transient reason (transient_window_missed,
  //     no_snapshot, stability_timeout). The page wasn't in a state we
  //     could evaluate yet — not a final verdict.
  //
  // (b) not_matched with source='agent'. The agent called assertion_check
  //     mid-transition (before the page reached its final state) and got
  //     back not_matched. Without re-evaluation that "agent-too-fast"
  //     mistake hardens into a FAIL even when the page eventually loaded
  //     correctly — directly violating the live-pass → reported-pass
  //     promise. We rescue these by re-checking against the post-loop
  //     stable snapshot. A later 'matched' legitimately overrides the
  //     prematurely-recorded miss.
  //
  //     Source-scoped: post_loop and conductor_inline outcomes stay
  //     durable. post_loop is already a re-eval; re-evaluating it again
  //     would be circular. conductor_inline runs when Conductor saw a
  //     URL change land — that's a strong durable signal, not a race.
  //
  // Generic rule: outcomes captured against a transient page state are
  // non-durable. Final verdict layer gets one shot against the stable
  // post-loop snapshot.
  const NONDURABLE_REASONS = new Set([
    'transient_window_missed',
    'no_snapshot',
    'transient_snapshot_timeout',
    'stability_timeout',
  ]);
  const reEvaluateIds = new Set();
  for (const r of out) {
    if (!r || !r.assertionId) continue;
    if (r.outcome === 'uncheckable' && NONDURABLE_REASONS.has(r.reason)) {
      reEvaluateIds.add(r.assertionId);
    } else if (r.outcome === 'not_matched' && r.source === 'agent') {
      reEvaluateIds.add(r.assertionId);
    }
  }
  // Build the "needs a post-loop check" set: declared records that have NO
  // entry yet, PLUS declared records whose existing entry is non-durable
  // (uncheckable with a transient reason, or agent-initiated not_matched
  // per PATH 4). Records whose existing entry is 'matched', or not_matched
  // from post_loop/conductor_inline, or a genuinely terminal uncheckable
  // (primitive_unsupported, agent_never_reached) are left alone.
  const recordedIds = new Set(out.map((r) => r && r.assertionId).filter(Boolean));
  const unchecked = declared.filter((d) => d && d.id
    && (!recordedIds.has(d.id) || reEvaluateIds.has(d.id)));
  if (unchecked.length === 0) {
    return { recorded: out, snapshotTaken: false };
  }

  // ── ONE fresh snapshot for the whole batch ──────────────────────────
  // We deliberately do not refresh per-assertion: all unchecked
  // assertions evaluate against the same "final state of the page".
  // This is a validation-only read: skip the extra snapshot-stability cycle
  // and enforce a short hard timeout. Mutating actions keep their own
  // action-time stabilization; ratification never adds hidden polling.
  let snapshotTaken = false;
  let snapshotError = null;
  if (mcpSession) {
    try {
      const snap = await mcp.snapshot(mcpSession, {
        skipSnapshotStability: true,
        timeoutMs: POST_LOOP_VALIDATION_SNAPSHOT_TIMEOUT_MS,
        strictActionEvidence: false,
        source: 'post_loop_ratify_shared_validation_snapshot',
        telemetry: false,
      });
      const snapshotText = typeof snap?.text === 'string' ? snap.text : '';
      snapshotTaken = typeof mcp.isSnapshotText === 'function'
        ? mcp.isSnapshotText(snapshotText)
        : /\[ref=/m.test(snapshotText);
      if (!snapshotTaken) snapshotError = snap?.error || 'no usable accessibility snapshot returned';
    } catch (err) {
      snapshotError = err?.message || String(err);
    }
    if (!snapshotTaken && send && tcId) {
      try {
        send({
          type: 'agent.phase.log', phase: 'conductor', level: 'warn',
          message: `Post-loop ratification could not refresh the shared snapshot (${snapshotError || 'unknown snapshot error'}); snapshot-dependent assertions will be marked uncheckable.`,
          tcId,
        });
      } catch (_) {}
    }
    if (snapshotTaken) {
      await captureDomTextFallback(mcp, mcpSession);
    }
  }

  // PATH 7 batch flag — postLoopRatify takes ONE shared snapshot at the
  // top of this function. Every per-assertion `mcp.callTool('assertion_check')`
  // call below must evaluate against THAT snapshot, not re-snapshot per
  // assertion (which would expose us to inter-check page drift). The
  // Normal assertion checks may take one fresh snapshot after a cache miss;
  // this flag disables that per-assertion refresh for the shared batch.
  if (mcpSession) mcpSession._assertionBatchActive = true;

  try {

  // Compare on PATH not full URL — the declared targetUrl is typically a
  // relative path ("/dashboard") while currentUrl is absolute
  // ("https://app.example.com/dashboard"). Path-level comparison is what
  // the test cases mean by "on the target page".
  const normalizedCurrent = currentUrl ? normalizePath(currentUrl) : '';

  // Helper: when re-evaluating a non-durable outcome, replace the existing
  // record in `out` instead of appending; otherwise push a new record.
  // Either way the caller's collection ends up with exactly one outcome
  // per declared assertion.
  const recordOutcome = (record) => {
    const id = record && record.assertionId;
    if (id && reEvaluateIds.has(id)) {
      const idx = out.findIndex((r) => r && r.assertionId === id);
      if (idx >= 0) {
        out[idx] = record;
        return;
      }
    }
    out.push(record);
  };

  for (const decl of unchecked) {
    const baseRec = {
      assertionId: decl.id,
      source: 'post_loop',
      ts: Date.now(),
    };

    // Phase H+1 — postLoopRatify always uses the RIGHT primitive for
    // the declared type (unexpectedText for FORBIDDEN_TEXT, etc.), so
    // outcomes from this module are already in semantic form. Mark them
    // as 'negative' for FORBIDDEN_* so computeVerdict's effectiveOutcome
    // skips the defensive inversion (no double-flip).
    const isForbidden = decl.type === 'FORBIDDEN_TEXT' || decl.type === 'FORBIDDEN_ROLE';
    if (isForbidden) baseRec.primitiveUsed = 'negative';

    // checkAt:'transient' assertions must be observed mid-execution during
    // a brief window that is always closed by the time postLoopRatify runs
    // (success toasts, loading spinners, inline saving states, etc.).
    // Re-evaluating against the final snapshot always fails and produces a
    // misleading not_matched. Record as uncheckable so computeVerdict routes
    // on criticality rather than treating it as a hard failure.
    // The agent is taught to call assertion_check in the SAME turn as the
    // trigger; if it missed the window there is nothing to recover here.
    //
    // PATH 4 guard: if the agent ALREADY called assertion_check on this
    // transient assertion and got not_matched, that is a definitive result
    // (the agent checked in-flight and the state was genuinely absent).
    // Do NOT override a definitive agent not_matched with uncheckable —
    // that would hide a real failure behind a conservative "we couldn't check".
    if (decl.checkAt === 'transient') {
      const agentRecord = out.find(
        (r) => r && r.assertionId === decl.id && r.source === 'agent',
      );
      if (!agentRecord || agentRecord.outcome === 'uncheckable') {
        recordOutcome({ ...baseRec, outcome: 'uncheckable', reason: 'transient_window_missed' });
      }
      // else: agent explicitly checked and got not_matched — preserve it.
      continue;
    }

    // parseFailed placeholders go straight to uncheckable. The structural
    // guard in computeVerdict will route the case to
    // needs_human(no_assertions_declared) — but we still need to record
    // an outcome to satisfy the invariant.
    //
    // parseFailedReason (Phase H+2 Rule 3) lets policy-level demotions
    // distinguish themselves from structural failures: e.g.,
    //   text_ungrounded → expectedText not cited in any source document.
    //   no_assertions_declared → entire array was missing.
    // Both route to needs_human at the verdict layer; the specific reason
    // surfaces on the BlockedItem / Reports detail pane so QA knows why.
    // P0-13: strict `=== true` so both computeVerdict and ratifier agree.
    if (decl.parseFailed === true) {
      const reason = (typeof decl.parseFailedReason === 'string' && decl.parseFailedReason)
        ? decl.parseFailedReason
        : 'declared_assertion_unparseable';
      recordOutcome({ ...baseRec, outcome: 'uncheckable', reason });
      continue;
    }

    // URL three-way disambiguation. Only fires when the declared
    // assertion explicitly names a targetUrl — assertions without
    // targetUrl evaluate against the live page wherever the agent
    // ended up.
    //
    // PAGE assertion sprint — Day 3. PAGE assertions are EXEMPT from the
    // URL three-way: their whole point is that URL is one signal among
    // many, and the weighted quorum tolerates the URL being "wrong"
    // (saucedemo's /login is actually /) when text+role identify the
    // page. Skipping the URL gate routes PAGE straight to the matcher.
    if (decl.targetUrl && String(decl.type || '').toUpperCase() !== 'PAGE') {
      const normalizedTarget = normalizePath(decl.targetUrl);
      const onTarget = normalizedCurrent && normalizedCurrent === normalizedTarget;
      const visitedTarget = visitedSetContains(visitedUrls, decl.targetUrl);
      if (!onTarget && visitedTarget) {
        recordOutcome({ ...baseRec, outcome: 'uncheckable', reason: 'transient_window_missed' });
        continue;
      }
      if (!onTarget && !visitedTarget) {
        // The agent was required to reach this URL and never did.
        // This is a navigation failure — not a verification uncertainty.
        recordOutcome({ ...baseRec, outcome: 'not_matched', reason: 'agent_never_reached' });
        continue;
      }
      // onTarget === true → fall through to the snapshot check.
    }

    // Translate to checkAssertion args and run the synthetic check.
    const translation = declaredToCheckArgs(decl);
    if (!translation.supported) {
      recordOutcome({ ...baseRec, outcome: 'uncheckable', reason: translation.reason });
      continue;
    }

    if (!mcpSession) {
      // Dry-run / no MCP — every assertion becomes uncheckable("no_snapshot").
      recordOutcome({ ...baseRec, outcome: 'uncheckable', reason: 'no_snapshot' });
      continue;
    }

    if (!snapshotTaken && !translation.args.expectedDownload) {
      // The one allowed fresh read failed. Never evaluate a snapshot-dependent
      // assertion against stale cached page state. Exhaustive mode may retry
      // this transient result through its separately-authored waits below.
      recordOutcome({
        ...baseRec,
        outcome: 'uncheckable',
        reason: 'transient_snapshot_timeout',
      });
      continue;
    }

    let result;
    try {
      result = await mcp.callTool(mcpSession, 'assertion_check', translation.args);
    } catch (err) {
      recordOutcome({ ...baseRec, outcome: 'uncheckable', reason: 'session_dead' });
      continue;
    }

    // Parse the legacy payload, then map to V2 outcome.
    let parsed = null;
    try {
      const text = result?.content?.[0]?.text;
      if (typeof text === 'string') parsed = JSON.parse(text);
    } catch (_) { /* falls through to uncheckable */ }

    if (!parsed) {
      recordOutcome({ ...baseRec, outcome: 'uncheckable', reason: 'unparseable_result' });
      continue;
    }
    const mapped = legacyToOutcome(parsed);
    recordOutcome({
      ...baseRec,
      outcome: mapped.outcome,
      reason: mapped.reason,
      evidence: parsed.evidence || null,
    });
  }

  // ── THOROUGH — exhaustive uncheckable re-check ─────────────────────
  // The single post-loop snapshot above is a "best one shot". Some genuine
  // verdicts hide behind async render, lazy-loaded / below-fold content, or
  // a page that simply hadn't settled. Thorough mode is willing to spend the
  // extra turns to find them: settle the page harder, then retry every
  // assertion still uncheckable for a TRANSIENT reason. A recovered outcome
  // is a real verdict on newly-evaluable evidence — never a fabricated pass.
  if (exhaustive && mcpSession) {
    const retryTargets = out.filter(
      (r) => r && r.outcome === 'uncheckable' && RETRYABLE_UNCHECKABLE.has(r.reason),
    );
    if (retryTargets.length > 0) {
      if (send && tcId) {
        try {
          send({
            type: 'agent.phase.log', phase: 'conductor', level: 'info',
            message: `   🔬 thorough: re-checking ${retryTargets.length} uncheckable assertion(s) after settling the page (scroll + wait + fresh snapshot)…`,
            tcId,
          });
        } catch (_) {}
      }
      // Settle the page: scroll to the bottom to trigger lazy/below-fold
      // content, give async renders time, then take a fresh snapshot. Every
      // step is best-effort — a failure just means we re-check against
      // whatever state we have.
      try {
        await mcp.callTool(mcpSession, 'browser_evaluate', {
          function: '() => { window.scrollTo(0, document.body.scrollHeight); }',
        });
      } catch (_) { /* scroll probe unavailable — continue */ }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        await mcp.callTool(mcpSession, 'browser_evaluate', {
          function: '() => { window.scrollTo(0, 0); }',
        });
      } catch (_) { /* ignore */ }
      // Re-snapshot — but a single browser_snapshot can ITSELF time out and
      // return a timeout/error payload (no page content). Re-checking against
      // that re-creates the exact transient-uncheckable bug. Retry up to 3× until
      // we get a REAL snapshot (one containing accessibility [ref=] tokens), so
      // the re-check below evaluates against a settled page, not an error string.
      for (let snapTry = 0; snapTry < 3; snapTry++) {
        let snapTxt = '';
        try {
          const s = await mcp.callTool(mcpSession, 'browser_snapshot', {});
          snapTxt = (s && Array.isArray(s.content) && s.content[0] && typeof s.content[0].text === 'string')
            ? s.content[0].text : '';
        } catch (_) { /* keep prior snapshot */ }
        if (/\[ref=/m.test(snapTxt)) break; // real snapshot acquired
        await new Promise((resolve) => setTimeout(resolve, 1000)); // settle, then retry
      }
      await captureDomTextFallback(mcp, mcpSession);

      let recovered = 0;
      for (const r of retryTargets) {
        const decl = declared.find((d) => d && d.id === r.assertionId);
        if (!decl) continue;
        const translation = declaredToCheckArgs(decl);
        if (!translation.supported) continue; // can't probe what we can't check
        let result;
        try {
          result = await mcp.callTool(mcpSession, 'assertion_check', translation.args);
        } catch (_) { continue; }
        let parsed = null;
        try {
          const text = result?.content?.[0]?.text;
          if (typeof text === 'string') parsed = JSON.parse(text);
        } catch (_) { /* leave as-is */ }
        if (!parsed) continue;
        const mapped = legacyToOutcome(parsed);
        if (mapped.outcome !== 'uncheckable') {
          // Resolved on the harder probe — replace the uncheckable record
          // with the real verdict. Tagged source so the disagreement metric
          // can attribute the recovery to the thorough re-check.
          const idx = out.findIndex((x) => x && x.assertionId === r.assertionId);
          if (idx >= 0) {
            out[idx] = {
              ...out[idx],
              outcome: mapped.outcome,
              reason: mapped.reason,
              source: 'post_loop_exhaustive',
              evidence: parsed.evidence || out[idx].evidence || null,
            };
            recovered++;
          }
        }
      }
      if (recovered > 0 && send && tcId) {
        try {
          send({
            type: 'agent.phase.log', phase: 'conductor', level: 'info',
            message: `   🔬 thorough re-check resolved ${recovered} of ${retryTargets.length} previously-uncheckable assertion(s).`,
            tcId,
          });
        } catch (_) {}
      }
    }
  }

  return { recorded: out, snapshotTaken };

  } finally {
    // PATH 7 — always lower the batch flag so subsequent agent-initiated
    // assertion_check calls on this session resume their unconditional
    // cached-then-one-fresh behavior.
    if (mcpSession) mcpSession._assertionBatchActive = false;
  }
}

module.exports = { postLoopRatify, declaredToCheckArgs, legacyToOutcome };
