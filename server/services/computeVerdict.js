'use strict';

/**
 * Phase H M4 — mechanical verdict (pure function).
 *
 * Deterministic priority ladder that maps execution signals + recorded
 * assertion outcomes to a case verdict. NO LLM. NO database. NO side
 * effects. The branching logic is written once here and is the single
 * source of truth for `RunResult.status` in mechanical mode.
 *
 * Why a pure function and not an inline branch in conductor.js: the
 * verdict is now a contract the agent cannot violate. Keeping it in one
 * spot — testable in isolation against 13 ladder fixtures — is what makes
 * "the report will stop lying" a load-bearing promise instead of an
 * aspiration that drifts with every new patch.
 *
 * INVARIANT (CRITICAL): `recorded` MUST contain an outcome record for
 * every entry in `declared`. Callers MUST call `postLoopRatify()` before
 * invoking this function. If the invariant is broken, declared
 * assertions that the agent never checked silently fall through to
 * `pass` — the worst possible regression, it re-introduces false-pass.
 * The runtime assertion below fails LOUD instead of silently.
 *
 * The function returns `{ status, reason }` and never throws on normal
 * branches — only on invariant violation (caller bug).
 *
 * Ladder (highest priority first; first hit wins):
 *
 *   1. Termination signals override everything:
 *        userCancelled              → skipped("user_cancelled")
 *        sessionDied                → blocked("session_dead")
 *        consecutiveErrorsExceeded  → blocked("consecutive_errors")
 *
 *   2. Structural guard — surface malformed case rather than mask it:
 *        declared.length === 0      → needs_human("no_assertions_declared")
 *        (NB: this also beats stepFail by design — see fixture #4.)
 *
 *   3. Execution-level failures GATED on incomplete verification:
 *        - If EVERY declared assertion ended up semantically matched, the
 *          agent verified the correct end state. Any tool error during
 *          execution was a recovered transient hiccup (locator timeout
 *          followed by a successful retry, slow click whose follow-up
 *          snapshot still showed the right page, etc.). In that case the
 *          step errors are SUBSUMED by the verification result and we
 *          fall through to priority 4/6 → pass.
 *        - If verification is incomplete (any uncheckable) or failed
 *          (any not_matched), the step error is durable:
 *            anyStepBlocked         → blocked("step_blocked")
 *            anyStepFail            → fail("step_failed")
 *
 *      Generic rule (load-bearing): verification beats execution-noise.
 *      The declared assertions are the contract — when they all matched,
 *      the case is a pass, regardless of how many tool errors the agent
 *      had to climb through to get there.
 *
 *   4. Verification outcomes (HARD / 'must' tier only — DEFECT 4):
 *        anyHardNotMatched          → fail("assertion_not_matched")
 *        anyHardUncheckable         → needs_human("assertion_uncheckable")
 *      A 'should'/'incidental' miss never reaches here — it becomes a
 *      warning on a still-passing case at priority 6. A human tester does
 *      not fail a test over copy that isn't the thing the test proves.
 *
 *   5. Termination cleanliness:
 *        hitTurnCeiling + incomplete evidence  → blocked("turn_ceiling")
 *        !reachedEndTurn + incomplete evidence → blocked("no_end_turn")
 *
 *   6. Otherwise                    → pass
 */

/**
 * @typedef {Object} DeclaredAssertion
 * @property {string} id              ASN-<hex> stable identifier
 * @property {string} type
 * @property {("must"|"should"|"incidental")} [criticality]  default 'must'
 * @property {Object} payload
 * @property {string|null} [targetUrl]
 * @property {string} [checkAt]
 * @property {boolean} [parseFailed]
 */

/**
 * @typedef {Object} RecordedOutcome
 * @property {string} assertionId
 * @property {"matched"|"not_matched"|"uncheckable"} outcome
 * @property {string} [reason]
 * @property {string} [source]
 * @property {number} [ts]
 */

/**
 * @typedef {Object} StepResult
 * @property {"pass"|"fail"|"blocked"|"skipped"} status
 */

/**
 * @typedef {Object} VerdictInputs
 * @property {DeclaredAssertion[]} declared
 * @property {RecordedOutcome[]}   recorded
 * @property {StepResult[]}        steps
 * @property {boolean} userCancelled
 * @property {boolean} sessionDied
 * @property {boolean} consecutiveErrorsExceeded
 * @property {boolean} hitTurnCeiling
 * @property {boolean} reachedEndTurn
 */

/**
 * @typedef {Object} VerdictResult
 * @property {"pass"|"fail"|"blocked"|"skipped"} status
 * @property {string} reason
 */

/**
 * Phase H+1 — defensive FORBIDDEN-inversion at verdict-compute time.
 *
 * Translates a raw assertion_check outcome into its SEMANTIC outcome,
 * accounting for the declared assertion's type and which primitive the
 * agent (or postLoopRatify) used to verify it.
 *
 * Why this is load-bearing: the agent will sometimes call assertion_check
 * with `expectedText: "undefined"` for a FORBIDDEN_TEXT assertion — the
 * tool correctly answers "not_matched" (the text wasn't there) but the
 * agent's intent was "is the forbidden text absent?", which is a PASS.
 * Without this layer, every FORBIDDEN_TEXT verified that way becomes
 * fail("assertion_not_matched"). With it, the ladder reads the right
 * semantic outcome regardless of which primitive the agent picked.
 *
 * Rule:
 *   - non-FORBIDDEN type → raw outcome passes through.
 *   - FORBIDDEN_TEXT/ROLE + primitiveUsed === 'positive' → invert.
 *     (The agent used expectedText to verify absence; the tool's answer
 *     was correct from its perspective but inverted from the test's.)
 *   - FORBIDDEN_TEXT/ROLE + primitiveUsed === 'negative' → pass through.
 *     (The agent used unexpectedText; the tool already produced the
 *     right semantic answer.)
 *   - FORBIDDEN_* with unknown primitiveUsed → invert by default
 *     (matches the friend-recommended defensive helper — agents that
 *     don't record the primitive used pre-date the prompt update and
 *     were calling expectedText).
 *
 * Pure function. Exported for tests.
 */
// Module-level: used both in priority 2b (before validDeclared is computed)
// and in the DEFECT-4 criticality tier section.
function crit(c) {
  return (c === 'should' || c === 'incidental') ? c : 'must';
}

function effectiveOutcome(declType, recordedOutcome, primitiveUsed) {
  const isForbidden = declType === 'FORBIDDEN_TEXT' || declType === 'FORBIDDEN_ROLE';
  if (!isForbidden) return recordedOutcome;
  if (primitiveUsed === 'negative') return recordedOutcome; // tool gave right answer
  if (recordedOutcome === 'matched')     return 'not_matched';
  if (recordedOutcome === 'not_matched') return 'matched';
  return recordedOutcome; // uncheckable stays uncheckable
}

function isVerdictBlockingStep(step) {
  if (!step || (step.status !== 'fail' && step.status !== 'blocked')) return false;
  const op = step.operationCheck || null;
  if (op && op.matched === false && op.required !== true) return false;
  const assertion = step.assertion || null;
  if (assertion && assertion.required !== true) return false;
  return true;
}

function isStateEvidenceBlockingStep(step) {
  if (!step || !step.stateEvidence) return false;
  const ev = step.stateEvidence;
  if (ev.matched !== false) return false;
  const source = String(ev.evidenceSource || '');
  return /dom_.*readback|overlay_delta|page_identity|url_state/.test(source);
}

function stepDiagnosticText(step) {
  if (!step) return '';
  const operationCheck = step.operationCheck || step.stepOperationCheck || {};
  const assertion = step.assertion || step.stepAssertion || {};
  const stateEvidence = step.stateEvidence || {};
  const attempts = Array.isArray(step.attempts) ? step.attempts : [];
  return [
    step.reason,
    step.error,
    step.evidence,
    step.executionErrorReason,
    step.continuationReason,
    step.failureType,
    step.failureImpact,
    operationCheck.reason,
    operationCheck.evidence,
    assertion.reason,
    assertion.evidence,
    stateEvidence.reason,
    stateEvidence.detail,
    stateEvidence.evidenceSource,
    ...attempts.flatMap((attempt) => [attempt?.reason, attempt?.error, attempt?.evidence]),
  ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Evidence acquisition is QAAI's responsibility. A missing/empty snapshot,
 * dead browser session, dispatch/locator failure, or an explicit execution-
 * error marker can prevent a product assertion from being checked; it cannot
 * prove the product failed. Keep the textual fallback deliberately narrow so
 * a genuine, observed "element is not visible" result remains a validation
 * failure rather than being hidden as infrastructure noise.
 */
function isQaaiExecutionFailureStep(step) {
  if (!step) return false;
  if (step.executionError === true || step.qaaiExecutionError === true) return true;

  const failureType = String(step.failureType || step.failureImpact || '').toLowerCase();
  if (/qaai|execution_error|automation_error|infrastructure/.test(failureType)) return true;

  const diagnostic = stepDiagnosticText(step);
  if (/snapshot_(?:unavailable|missing|empty)|fresh_snapshot_(?:unavailable|missing|empty)|evidence_acquisition|browser_session_(?:dead|unavailable)|session_dead|dispatch_failed|locator_(?:resolution_)?failed|selector_resolution_failed/.test(diagnostic)) {
    return true;
  }

  const operationCheck = step.operationCheck || step.stepOperationCheck || {};
  const unresolvedStateCheck = operationCheck.required !== false
    && operationCheck.matched === false
    && ['visible_not_confirmed', 'hidden_not_confirmed', 'url_not_reached', 'evidence_missing']
      .includes(String(operationCheck.reason || step.reason || '').toLowerCase());

  return unresolvedStateCheck
    && /cached state.+fresh validation snapshot|fresh validation snapshot.+did not confirm|snapshot.+did not confirm/.test(diagnostic);
}

function isDependencyNotExecutedStep(step) {
  if (!step) return false;
  const failureType = String(step.failureType || step.failureImpact || '').toLowerCase();
  return step.dependencySkipped === true
    || step.actionOutcome === 'not_executed'
    || failureType.includes('dependency');
}

function hasJournalAssertionMismatch(step) {
  if (!step || step.actionOutcome === 'not_executed') return false;
  const assertion = step.assertion || step.stepAssertion || null;
  const operationCheck = step.operationCheck || step.stepOperationCheck || null;
  if (assertion?.required === false || (!assertion && operationCheck?.required === false)) return false;
  if (String(step.assertionOutcome || '').toLowerCase() === 'not_matched') return true;
  const assertions = [
    ...(Array.isArray(step.assertions) ? step.assertions : []),
    ...(Array.isArray(step.assertionOutcomes) ? step.assertionOutcomes : []),
  ];
  if (assertions.some((assertion) => String(assertion?.outcome || assertion?.assertionOutcome || '').toLowerCase() === 'not_matched')) {
    return true;
  }
  return assertion?.required !== false && assertion?.matched === false;
}

function computeVerdict(inputs) {
  const {
    declared = [],
    recorded = [],
    steps = [],
    userCancelled = false,
    sessionDied = false,
    consecutiveErrorsExceeded = false,
    hitTurnCeiling = false,
    reachedEndTurn = false,
  } = inputs || {};

  // ── Ladder priority 1 — termination signals (BEFORE the invariant) ────
  // A terminal early-exit legitimately has missing assertion records: the run
  // ended before postLoopRatify could fill them. These must resolve to their
  // HONEST terminal status, never be mislabelled as an INVARIANT_NO_RECORDED_
  // OUTCOME throw — so they are checked FIRST and return immediately. (Reviewer
  // gap: userCancelled / sessionDied / consecutiveErrorsExceeded with a missing
  // record used to throw because the invariant ran ahead of this block.)
  if (userCancelled) {
    return { status: 'skipped', reason: 'user_cancelled' };
  }
  if (sessionDied) {
    return { status: 'blocked', reason: 'session_dead' };
  }
  if (consecutiveErrorsExceeded) {
    return { status: 'blocked', reason: 'consecutive_errors' };
  }

  // ── Invariant assert ─────────────────────────────────────────────────
  // Every declared assertion MUST have a recorded outcome. If not, the
  // post-loop ratification was skipped (bug) and any "pass" coming out
  // of this function would be a silent false-pass. Throw LOUD so the
  // caller catches it during dev/test instead of in production.
  //
  // EXEMPT a turn-ceiling early-exit: hitting the MAX_TURNS ceiling stops the
  // loop before ratification, so missing records there are EXPECTED, not a
  // postLoopRatify bug. We skip the throw and let the ladder resolve it — the
  // priority-4a missing-record backstop returns needs_human(assertion_missing_
  // record), or the turn_ceiling rung returns blocked — NEVER a fake-pass.
  if (!hitTurnCeiling) {
    for (const decl of declared) {
      if (!decl || !decl.id) continue;
      // parseFailed entries are placeholders the system itself flagged at
      // declared-assertion normalisation time. They have no recorded outcome
      // by construction — the structural guard at priority 2 routes the
      // case to needs_human(no_assertions_declared). Invariant exemption
      // is intentional: this isn't an agent-skipped assertion, it's a
      // malformed one we surface deliberately.
      //
      // P0-13: strict `=== true` coercion. A truthy-but-not-true value
      // ("true", 1) would otherwise skip the exemption AND skip the
      // invariant check (impossible — both branches use the same gate),
      // landing the case at the ratifier's defensive blocked(invariant_violation).
      // Generic rule: parseFailed is a boolean — coerce at write site and
      // at read site so type drift can't hide structural failures.
      if (decl.parseFailed === true) continue;
      const hasRecord = recorded.some((r) => r && r.assertionId === decl.id);
      if (!hasRecord) {
        // P0-13: surface the offending assertionId so the engineer can find
        // the row in the DB instead of guessing from server logs alone.
        const err = new Error(
          `computeVerdict invariant violated: declared assertion ${decl.id} ` +
          `has no recorded outcome. Did you skip postLoopRatify()?`
        );
        err.assertionId = decl.id;
        err.code = 'INVARIANT_NO_RECORDED_OUTCOME';
        throw err;
      }
    }
  }

  // ── Calibration-gap warning accumulator ──────────────────────────────
  // Priority 2 and 2b may discover that parseFailed assertions were
  // runtime-verified by the Conductor and matched. Those cases should not
  // fail — they should pass with a degraded warning surfaced here. The
  // accumulator is merged into the priority-6 warnings array before the
  // final return, without touching any of the hard-verdict branches.
  const calGapWarnings = [];

  // ── Ladder priority 2 — structural guard ─────────────────────────────
  // P0-13: strict coercion. Truthy-but-not-true would falsely classify a
  // malformed assertion as valid, hiding the structural failure.
  //
  // Two sub-cases:
  //   declared.length === 0                     → no_assertions_declared (Architect omitted them)
  //   declared.length > 0 but all parseFailed   → check runtime outcomes before deciding
  //
  // For all-parseFailed: the Architect DID write assertions but the Calibrator
  // could not ground them (underspecified page name, text not in corpus, etc.).
  // This is OUR authoring/calibration gap, not a site defect. We consult the
  // outcomes the Conductor recorded at runtime for these assertions:
  //   - all matched           → degraded pass (warnings: ['all_assertions_ungrounded'])
  //   - any not_matched       → fail (site genuinely failed even an ungrounded check)
  //   - any uncheckable       → needs_human (ambiguous — route to human review)
  //   - no runtime outcomes   → degraded pass (pre-assert-check era; give benefit of doubt)
  const validDeclared = declared.filter((d) => d && d.id && d.parseFailed !== true);
  if (validDeclared.length === 0) {
    if (declared.length === 0) {
      return { status: 'blocked', reason: 'no_assertions_declared' };
    }
    // All declared have parseFailed=true — consult runtime outcomes.
    const pfOutcomes = declared
      .filter((d) => d && d.id && d.parseFailed === true)
      .map((d) => recorded.find((r) => r && r.assertionId === d.id))
      .filter(Boolean);
    if (pfOutcomes.some((r) => r.outcome === 'not_matched')) {
      return { status: 'fail', reason: 'assertion_parse_failed' };
    }
    if (pfOutcomes.some((r) => r.outcome === 'uncheckable')) {
      return { status: 'blocked', reason: 'assertion_parse_failed' };
    }
    if (pfOutcomes.length !== declared.filter((d) => d && d.id && d.parseFailed === true).length) {
      return { status: 'blocked', reason: 'assertion_parse_failed' };
    }
    // Every ungrounded assertion was still runtime-checked and matched.
    // Surface calibration gap as a warning — the site passed, we just couldn't
    // formally certify the assertions. QA should re-calibrate.
    return {
      status: 'pass',
      reason: 'all_assertions_matched',
      warnings: ['all_assertions_ungrounded'],
    };
  }

  // ── Ladder priority 2b — parseFailed assertions in a mixed case ────────
  // When parseFailed hard-tier assertions exist alongside valid ones, we
  // consult their runtime outcomes before failing the case:
  //   - any not_matched       → fail (site defect evidenced at runtime)
  //   - any uncheckable/missing → needs_human (couldn't verify)
  //   - all matched           → add 'hard_assertion_ungrounded' warning and continue
  //
  // Soft-tier parseFailed records are already excluded by validDeclared; they
  // never block the hard-tier verdict.
  //
  // Strict `=== true` — see P0-13 note on the invariant check above.
  {
    const fullHasAnyMust = declared.some((d) => d && d.id && crit(d.criticality) === 'must');
    const fullHasAnyShould = !fullHasAnyMust && declared.some((d) => d && d.id && crit(d.criticality) === 'should');
    const fullHardTier = fullHasAnyMust ? 'must' : (fullHasAnyShould ? 'should' : 'none');
    const pfHardAssertions = fullHardTier !== 'none' ? declared.filter((d) => {
      if (!d || !d.id || d.parseFailed !== true) return false;
      const t = crit(d.criticality);
      return (fullHardTier === 'must' && t === 'must') || (fullHardTier === 'should' && t === 'should');
    }) : [];
    if (pfHardAssertions.length > 0) {
      const pfHardOutcomes = pfHardAssertions
        .map((d) => recorded.find((r) => r && r.assertionId === d.id))
        .filter(Boolean);
      if (pfHardOutcomes.some((r) => r.outcome === 'not_matched')) {
        return { status: 'fail', reason: 'assertion_parse_failed' };
      }
      const allChecked = pfHardOutcomes.length === pfHardAssertions.length;
      if (!allChecked || pfHardOutcomes.some((r) => r.outcome === 'uncheckable')) {
        return { status: 'blocked', reason: 'assertion_parse_failed' };
      }
      // All parseFailed hard assertions matched at runtime — carry a warning
      // and continue to evaluate the valid assertions normally.
      calGapWarnings.push('hard_assertion_ungrounded');
    }
  }

  // ── Compute SEMANTIC outcomes first ──────────────────────────────────
  // Filter the recorded[] to only entries matching declared IDs (a
  // belt-and-braces in case recorded[] picked up stray check results
  // from earlier exploratory assertion_check calls that didn't match a
  // declared ID — though M2's validation rejects those).
  //
  // For each recorded outcome, look up the declared type and convert
  // the raw outcome into its SEMANTIC outcome via effectiveOutcome.
  // This handles the FORBIDDEN_TEXT/ROLE inversion case where the
  // agent used the wrong primitive (expectedText on a forbidden type).
  const declaredById = new Map(validDeclared.map((d) => [d.id, d]));

  // DEFECT 4 — criticality tiers. A 'must' assertion is a real acceptance
  // criterion: a miss FAILS the case. 'should'/'incidental' are secondary or
  // inferred copy: a miss is a WARNING on a still-passing case, never a fail —
  // the way a human tester ignores a cosmetic wording difference. Default to
  // 'must' (silence = hard requirement) so an Architect that omits the field
  // can never accidentally soften a check.
  //
  // FAIL-SAFE (Edge Case 1 — tiered, NOT blanket promotion). The hard tier is
  // the HIGHEST criticality actually present:
  //   must present       → only 'must' is hard (should/incidental are soft warnings)
  //   else should present→ 'should' becomes the hard baseline; 'incidental' stays SOFT
  //   else all incidental→ NOTHING is promoted; incidental copy is never hard-failed
  // Rationale: a purely visual / informational case (form-step alerts, a
  // sequence of toasts) legitimately has no acceptance criterion. The old
  // "promote everything" fail-safe turned that case's flaky incidental copy
  // into a 'must' and hard-failed on a one-word mismatch — defeating the whole
  // criticality layer. We promote at most one tier down (to 'should'), and we
  // NEVER promote 'incidental'. An all-incidental case can only warn, not
  // hard-fail (the authoring-side guardrail nudges every case toward a 'must').
  // `crit` is defined at module level so priority 2b can use it before this point.
  const hasAnyMust = validDeclared.some((d) => crit(d.criticality) === 'must');
  const hasAnyShould = validDeclared.some((d) => crit(d.criticality) === 'should');
  const hardTier = hasAnyMust ? 'must' : (hasAnyShould ? 'should' : 'none');
  const isHard = (c) => {
    const t = crit(c);
    if (hardTier === 'must') return t === 'must';
    if (hardTier === 'should') return t === 'should';
    return false; // all-incidental → no hard tier; soft warnings only
  };

  const relevantRecorded = recorded
    .filter((r) => r && declaredById.has(r.assertionId))
    .map((r) => {
      const decl = declaredById.get(r.assertionId);
      return {
        ...r,
        effective: effectiveOutcome(decl?.type, r.outcome, r.primitiveUsed),
        criticality: crit(decl?.criticality),
        hard: isHard(decl?.criticality),
      };
    });

  // Only the HARD tier drives fail / needs_human. The SOFT tier contributes
  // warnings only (priority 6).
  const hardRecorded = relevantRecorded.filter((r) => r.hard);
  const softRecorded = relevantRecorded.filter((r) => !r.hard);

  const anyHardNotMatched = hardRecorded.some((r) => r.effective === 'not_matched');
  const anyHardUncheckable = hardRecorded.some((r) => r.effective === 'uncheckable');
  const anySoftNotMatched = softRecorded.some((r) => r.effective === 'not_matched');
  const anySoftUncheckable = softRecorded.some((r) => r.effective === 'uncheckable');
  // Semantic double-miss: a 'should' assertion that failed BOTH the deterministic
  // layer AND the LLM semantic rescue. The semantic verifier's job is to handle
  // WORDING differences — if it also says no, the behavior is genuinely absent
  // (not a copy mismatch), and the case should fail regardless of tier.
  const anySoftSemanticDoubleNotMatched = softRecorded.some(
    (r) => r.effective === 'not_matched' && r.semanticConfirmedNotMatched === true
  );

  // "Fully verified" (the gate that subsumes recovered step errors at
  // priority 3) keys off the HARD tier: every must-assertion matched, none
  // uncheckable, and we hold a record for every hard declared assertion
  // (postLoopRatify guarantees a record per declared; we count for safety).
  const hardDeclaredCount = validDeclared.filter((d) => isHard(d.criticality)).length;
  const fullyVerified = hardDeclaredCount > 0
    && !anyHardNotMatched
    && !anyHardUncheckable
    && hardRecorded.length === hardDeclaredCount;

  // ── Ladder priority 3 — execution-level failures (gated) ─────────────
  // Step status semantics:
  //   blocked = locator-class or infrastructure error (session, network,
  //             evaluate runtime, MCP died, etc.).
  //   fail    = UI dead-end — element found but action couldn't complete,
  //             intercepted click, form rejected without element error,
  //             explicit page-level error.
  //
  // PRE-EXISTING BUG (now fixed): step errors used to fire BEFORE
  // verification, so a recovered transient tool error (click timeout
  // followed by a successful snapshot showing the right page) wrongly
  // produced step_failed even when every declared assertion matched.
  //
  // New rule (load-bearing): if the agent FULLY verified the end state,
  // step errors are subsumed and we fall through to pass. Otherwise the
  // step error stands because verification didn't confirm the recovery.
  const anyQaaiExecutionFailure = steps.some(isQaaiExecutionFailureStep);
  if (!fullyVerified && anyQaaiExecutionFailure) {
    return { status: 'blocked', reason: 'qaai_execution_error' };
  }

  const anyJournalAssertionNotMatched = steps.some(hasJournalAssertionMismatch);
  if (anyJournalAssertionNotMatched) {
    return { status: 'fail', reason: 'validation_failed' };
  }

  const anyStateEvidenceBlocked = steps.some(isStateEvidenceBlockingStep);
  if (anyStateEvidenceBlocked) {
    return { status: 'blocked', reason: 'step_state_unverified' };
  }
  if (!fullyVerified) {
    const anyStepBlocked = steps.some((s) => isVerdictBlockingStep(s) && s.status === 'blocked');
    if (anyStepBlocked) {
      return { status: 'blocked', reason: 'step_blocked' };
    }
    const anyStepFail = steps.some((s) => isVerdictBlockingStep(s) && s.status === 'fail');
    if (anyStepFail) {
      return { status: 'fail', reason: 'step_failed' };
    }
  }

  const anyDependencyNotExecuted = steps.some(isDependencyNotExecutedStep);
  if (anyDependencyNotExecuted) {
    return { status: 'blocked', reason: 'dependency_not_executed' };
  }

  // Action-time assertion evidence is canonical. A synthetic post-loop
  // recheck can disagree when a stored declaration contains authoring prose
  // instead of the concrete browser oracle. That duplicate mismatch must not
  // poison a completed flow or block its dependent cases.
  const explicitAssertionSteps = steps.filter((step) => {
    const actionType = String(step?.actionType || step?.stepKind || '').toLowerCase();
    return actionType === 'assert'
      || actionType === 'assertion'
      || !!step?.assertion
      || !!step?.stepAssertion
      || step?.assertionOutcome != null;
  });
  const noBlockingExecutionStep = !steps.some(isVerdictBlockingStep);
  const runtimeAssertionsSettled = explicitAssertionSteps.length > 0
    && explicitAssertionSteps.every((step) => {
      const assertion = step.assertion || step.stepAssertion || null;
      const operationCheck = step.operationCheck || step.stepOperationCheck || null;
      if (assertion?.required === false || (!assertion && operationCheck?.required === false)) return true;
      return step.status === 'pass'
        && (step.assertionOutcome === 'matched'
          || assertion?.matched === true
          || operationCheck?.matched === true);
    });
  const unresolvedHardRecords = hardRecorded.filter((entry) => entry.effective !== 'matched');
  const postLoopOnlyDrift = unresolvedHardRecords.length > 0
    && unresolvedHardRecords.every((entry) => entry.source === 'post_loop');
  if (noBlockingExecutionStep && runtimeAssertionsSettled && postLoopOnlyDrift) {
    return {
      status: 'pass',
      reason: 'all_assertions_matched',
      warnings: ['declared_assertion_drift'],
    };
  }

  // ── Ladder priority 4 — verification outcomes (HARD tier only) ───────
  // Soft-tier (should/incidental) misses NEVER fail/block — they fold into
  // warnings at priority 6 so the case still passes (DEFECT 4).
  if (anyHardNotMatched) {
    return { status: 'fail', reason: 'assertion_not_matched' };
  }
  if (anyHardUncheckable) {
    // ── VERDICT PURITY — NEVER FAKE-PASS A REQUIRED ASSERTION (run 91d6301a) ──
    // A "must" assertion is, by definition, the thing the case EXISTS to prove.
    // `uncheckable` means we could NOT formally re-verify it — OUR verification
    // limitation, never proof the site worked. The old escape hatch demoted this
    // to PASS-with-warning ("hard_assertion_uncheckable_passed_on_clean_execution")
    // whenever ANY step happened to pass — so a case could go green while the
    // required assertion was never checked. That is exactly the false-pass run
    // 91d6301a persisted for the FormValidation matrix (8 rows: both must
    // assertions uncheckable, yet status=pass).
    //
    // Honesty floor: a required-but-unverifiable assertion is needs_human, FULL
    // STOP. Passing-step "evidence" does NOT substitute for verifying the must —
    // the steps driving the page is not proof the acceptance criterion held. The
    // durable cure is making these primitives CHECKABLE via the evidence checkers
    // (so they stop arriving here as uncheckable); until then we surface honestly
    // rather than lie. Soft-tier uncheckables still fold into warnings (priority 6).
    return { status: 'blocked', reason: 'assertion_uncheckable' };
  }
  // Priority 4a — graceful backstop: a hard declared assertion that reaches the
  // pass tier without a COUNTED hard record is an un-evaluated acceptance criterion
  // → needs_human, never pass. The loud invariant at the top of this function
  // already THROWS (INVARIANT_NO_RECORDED_OUTCOME) when any non-parseFailed declared
  // assertion has no record, so this normally never fires — it is defence-in-depth
  // in case that exemption widens (e.g. parseFailed drift) or the invariant is ever
  // relaxed: we surface needs_human here rather than depend on the throw being
  // correctly handled upstream. (Distinct-id count is robust to duplicate records.)
  if (hardDeclaredCount > 0) {
    const hardRecordedIds = new Set(hardRecorded.map((r) => r.assertionId));
    const anyHardMissingRecord = validDeclared
      .filter((d) => isHard(d.criticality))
      .some((d) => !hardRecordedIds.has(d.id));
    if (anyHardMissingRecord) {
      return { status: 'blocked', reason: 'assertion_missing_record' };
    }
  }
  // Priority 4b — semantic double-miss promotion. A 'should' assertion that
  // failed BOTH deterministic and semantic rescue is a genuine behavioral
  // absence, not a wording gap. Promote to fail so QA sees the real defect
  // rather than a yellow warning on an otherwise-green case.
  if (anySoftSemanticDoubleNotMatched) {
    return { status: 'fail', reason: 'soft_assertion_behavioral_absence' };
  }

  // ── Ladder priority 5 — termination cleanliness ──────────────────────
  // The agent should arrive at end_turn, but a late loop ceiling after all
  // declared assertions were recorded is not a website blocker. That is a
  // runner-closeout issue after the acceptance evidence is already complete.
  // Block only when the ceiling/no-end-turn also means the declared evidence
  // is incomplete.
  const assertionEvidenceComplete = validDeclared.length > 0
    && relevantRecorded.length === validDeclared.length;
  if (hitTurnCeiling && !assertionEvidenceComplete) {
    return { status: 'blocked', reason: 'turn_ceiling' };
  }
  if (!reachedEndTurn && !assertionEvidenceComplete) {
    return { status: 'blocked', reason: 'no_end_turn' };
  }

  // ── Ladder priority 6 — pass ─────────────────────────────────────────
  //
  // FRIEND R3 — degraded-pass tier. If the case passes BUT some assertions
  // were rescued via the LLM (source='semantic_rescue' or score below the
  // PAGE matcher's "all_channels_matched" stage), AND there was execution
  // noise (any step failed/blocked but was recovered), the pass is real but
  // weaker than a clean deterministic pass. Surface a `warnings` array so
  // Reports can show a chip ("degraded verification — rescued by LLM with
  // recovered step errors") and QA can prioritise human review.
  //
  // The warning does NOT change the pass verdict — friend 2 was explicit:
  // "the execution noise should be promoted to a Warning on the test
  // report" rather than flipping the outcome.
  const anyRescued = relevantRecorded.some((r) => r && r.source === 'semantic_rescue');
  const anyStepFailRecovered = steps.some((s) => s && (s.status === 'fail' || s.status === 'blocked'));
  // Start with any calibration-gap warnings collected at priority 2/2b.
  const warnings = [...calGapWarnings];
  if (anyRescued && anyStepFailRecovered) {
    warnings.push('degraded_verification_with_recovered_step_errors');
  } else if (anyRescued) {
    warnings.push('passed_via_semantic_rescue');
  }
  // Soft-tier uncheckable: the agent couldn't verify a secondary condition.
  // This is our verification limitation, not a site defect. Surface as a
  // degraded-pass warning so QA sees it without blocking the release.
  // (Hard-tier uncheckable already returned needs_human at priority 4.)
  if (anySoftUncheckable) {
    warnings.push('soft_assertion_uncheckable');
  }
  // Soft-tier not_matched: the case proved its hard criteria but a should/incidental
  // assertion differed (e.g. inferred toast copy vs live wording). Pass stands;
  // surface a warning so Reports shows WHY it's a degraded pass.
  if (anySoftNotMatched) {
    warnings.push('incidental_assertion_mismatch');
  }
  return warnings.length > 0
    ? { status: 'pass', reason: 'all_assertions_matched', warnings }
    : { status: 'pass', reason: 'all_assertions_matched' };
}

/**
 * Derive the disagreement direction between the agent's claim and the
 * mechanical verdict. Used to fill `RunResult.flipDirection` for the
 * disagreement-rate dashboard. `null` means agreement (or no claim).
 *
 * @param {string|null} agentClaimed   "pass" | "fail" | "blocked" | "skipped" | null
 * @param {string}      mechanical     status from computeVerdict()
 * @returns {string|null}
 */
function deriveFlipDirection(agentClaimed, mechanical) {
  if (!agentClaimed) return null;
  if (agentClaimed === mechanical) return null;
  // Normalise both sides into our four-bucket comparator.
  const norm = (s) => {
    if (s === 'pass') return 'PASS';
    if (s === 'fail' || s === 'needs_human') return 'FAIL';
    return 'OTHER';
  };
  const a = norm(agentClaimed);
  const m = norm(mechanical);
  if (a === m) return null; // same bucket after normalization (e.g. fail vs needs_human)
  // A non-pass/fail "claim" (e.g. 'backend_auto_closeout' — the backend closed the row
  // out deterministically; the agent made NO pass/fail claim) is NOT a disagreement to
  // flip on. Only a real agent pass/fail claim can flip against the mechanical verdict.
  if (a === 'OTHER') return null;
  if (a === 'FAIL' && m === 'PASS') return 'FAIL_TO_PASS';
  if (a === 'PASS' && m === 'FAIL') return 'PASS_TO_FAIL';
  return 'OTHER';
}

module.exports = { computeVerdict, deriveFlipDirection, effectiveOutcome };
