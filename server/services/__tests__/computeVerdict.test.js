'use strict';

/**
 * Phase H M4 — computeVerdict priority-ladder fixtures.
 *
 * 13 ladder-branch fixtures + 1 invariant-violation fixture + flipDirection
 * mapping fixtures. Lives outside the bundler so it can be run as a
 * straight node script without a test runner.
 *
 * Run with: node server/services/__tests__/computeVerdict.test.js
 */

const { computeVerdict, deriveFlipDirection, effectiveOutcome } = require('../computeVerdict');

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  }
}
function expectThrows(label, fn, expectedMessageFragment) {
  try {
    fn();
    console.log(`  FAIL  ${label}  (did not throw)`);
    failures += 1;
  } catch (err) {
    if (typeof expectedMessageFragment === 'string' && err.message.includes(expectedMessageFragment)) {
      console.log(`  PASS  ${label}`);
    } else {
      console.log(`  FAIL  ${label}`);
      console.log(`        expected error to include: ${expectedMessageFragment}`);
      console.log(`        actual message:           ${err.message}`);
      failures += 1;
    }
  }
}

// ── Shared shorthand for building fixture inputs ───────────────────────
const D = (id, opts = {}) => ({ id, type: 'TEXT', payload: { expectedText: 'x' }, ...opts });
const R = (assertionId, outcome, reason = null) => ({ assertionId, outcome, reason });
const STEP = (status) => ({ status });

// Default "clean" base — every fixture overrides as needed.
function base(over = {}) {
  return {
    declared: [],
    recorded: [],
    steps: [],
    userCancelled: false,
    sessionDied: false,
    consecutiveErrorsExceeded: false,
    hitTurnCeiling: false,
    reachedEndTurn: true,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 1 — User cancel beats everything');
// User cancellation must override step failures, assertion failures, and
// hit-the-turn-ceiling. Skipped status preserves "this case didn't get a
// chance" semantics.
expect('user_cancelled overrides everything',
  computeVerdict(base({
    declared: [D('ASN-aaaa')],
    recorded: [R('ASN-aaaa', 'not_matched')],
    steps: [STEP('fail')],
    userCancelled: true,
    hitTurnCeiling: true,
  })),
  { status: 'skipped', reason: 'user_cancelled' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 2 — Session death beats step + assertion outcomes');
expect('session_died → blocked(session_dead)',
  computeVerdict(base({
    declared: [D('ASN-bbbb')],
    recorded: [R('ASN-bbbb', 'not_matched')],
    steps: [STEP('fail')],
    sessionDied: true,
  })),
  { status: 'blocked', reason: 'session_dead' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 3 — No declared assertions → blocked(no_assertions_declared)');
expect('zero declared → blocked',
  computeVerdict(base({
    declared: [],
    recorded: [],
    steps: [STEP('pass'), STEP('pass')],
  })),
  { status: 'blocked', reason: 'no_assertions_declared' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 4 — No declared assertions BEATS stepFail (surface malformed case)');
// This is the load-bearing fixture per spec: surfacing the malformed case
// is more useful than burying it under a step failure.
expect('zero declared + stepFail → blocked(no_assertions_declared)',
  computeVerdict(base({
    declared: [],
    recorded: [],
    steps: [STEP('fail')],
  })),
  { status: 'blocked', reason: 'no_assertions_declared' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 5 — stepBlocked beats notMatched');
expect('stepBlocked priority → blocked(step_blocked)',
  computeVerdict(base({
    declared: [D('ASN-cccc')],
    recorded: [R('ASN-cccc', 'not_matched')],
    steps: [STEP('blocked')],
  })),
  { status: 'blocked', reason: 'step_blocked' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 6 — stepFail beats notMatched');
expect('stepFail priority → fail(step_failed)',
  computeVerdict(base({
    declared: [D('ASN-dddd')],
    recorded: [R('ASN-dddd', 'not_matched')],
    steps: [STEP('fail')],
  })),
  { status: 'fail', reason: 'step_failed' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 7 — stepBlocked beats stepFail when verification is incomplete');
// Under the post-recovery rule, step priority only fires when assertions
// did NOT fully verify the end state. Switching the recorded outcome to
// uncheckable means verification is incomplete → step_blocked wins over
// step_fail. (Previously this fixture had recorded=matched; that case is
// now rescued by Fixture 7b below.)
expect('stepBlocked > stepFail when verification incomplete → blocked',
  computeVerdict(base({
    declared: [D('ASN-eeee')],
    recorded: [R('ASN-eeee', 'uncheckable')],
    steps: [STEP('fail'), STEP('blocked')],
  })),
  { status: 'blocked', reason: 'step_blocked' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 7a — stepFail RECOVERED by full verification → pass');
// The core post-recovery rule. A transient tool error (click timeout
// that the agent retried successfully, slow-load form whose follow-up
// snapshot still showed the right page) used to incorrectly flip the
// case to step_failed. Now: if every declared assertion ended up
// matched, the end state was reached → pass.
expect('stepFail + all matched → pass (recovered)',
  computeVerdict(base({
    declared: [D('ASN-recover-1')],
    recorded: [R('ASN-recover-1', 'matched')],
    steps: [STEP('pass'), STEP('fail'), STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 7b — stepBlocked RECOVERED by full verification → pass');
// Same rule for stepBlocked. If a locator-class error was followed by
// successful navigation that the assertions verified, it was recovered.
expect('stepBlocked + all matched → pass (recovered)',
  computeVerdict(base({
    declared: [D('ASN-recover-2'), D('ASN-recover-3')],
    recorded: [R('ASN-recover-2', 'matched'), R('ASN-recover-3', 'matched')],
    steps: [STEP('blocked'), STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 7b2 - deterministic state readback failure blocks recovery');
// If the backend read the exact action target and proved the intended state
// did not land, a later broad assertion must not wash away that false action.
expect('stateEvidence mismatch + all matched -> blocked(step_state_unverified)',
  computeVerdict(base({
    declared: [D('ASN-state-proof')],
    recorded: [R('ASN-state-proof', 'matched')],
    steps: [{
      status: 'pass',
      stateEvidence: {
        matched: false,
        evidenceSource: 'dom_value_readback',
        expected: 'ESS',
        actual: 'Admin',
      },
    }],
  })),
  { status: 'blocked', reason: 'step_state_unverified' });

console.log('Fixture 7c — stepFail with one uncheckable does NOT trigger recovery');
// Verification was incomplete (one uncheckable) → step error stands.
// This is the conservative guardrail: recovery only fires on FULL
// verification, not partial.
expect('stepFail + 1 matched + 1 uncheckable → step_failed (not recovered)',
  computeVerdict(base({
    declared: [D('ASN-r-a'), D('ASN-r-b')],
    recorded: [R('ASN-r-a', 'matched'), R('ASN-r-b', 'uncheckable')],
    steps: [STEP('fail')],
  })),
  { status: 'fail', reason: 'step_failed' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 8 — notMatched beats uncheckable');
expect('notMatched > uncheckable → fail(assertion_not_matched)',
  computeVerdict(base({
    declared: [D('ASN-ffff'), D('ASN-gggg')],
    recorded: [R('ASN-ffff', 'not_matched'), R('ASN-gggg', 'uncheckable')],
    steps: [STEP('pass')],
  })),
  { status: 'fail', reason: 'assertion_not_matched' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 9 — Uncheckable WITH positive execution evidence → degraded PASS (verdict purity)');
// VERDICT PURITY (Phase 1): a hard-uncheckable assertion is OUR verification
// limitation, not a website failure. When the execution produced positive
// evidence (≥1 passing step) and nothing failed, the website did what the steps
// drove it to do → PASS with a loud degraded-verification warning, never a
// user-facing block. (The genuine no-evidence case is Fixture 9b below.)
expect('uncheckable + passing step → degraded pass',
  computeVerdict(base({
    declared: [D('ASN-hhhh')],
    recorded: [R('ASN-hhhh', 'uncheckable', 'agent_never_reached')],
    steps: [STEP('pass')],
  })),
  { status: 'blocked', reason: 'assertion_uncheckable' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 9b — Uncheckable with NO passing execution evidence → needs_human (never fake-pass)');
// The complement of 9: no step actually passed, so we have no evidence the site
// worked. We must NOT fake-pass — this genuinely stays needs_human.
expect('uncheckable + no passing step → needs_human',
  computeVerdict(base({
    declared: [D('ASN-hhhh2')],
    recorded: [R('ASN-hhhh2', 'uncheckable', 'agent_never_reached')],
    steps: [STEP('skipped')],
  })),
  { status: 'blocked', reason: 'assertion_uncheckable' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 10 — Turn ceiling with everything else clean → blocked(turn_ceiling)');
// If all declared assertion evidence was recorded and matched, a late
// turn ceiling is runner closeout noise, not a website blocker.
expect('turn ceiling → blocked',
  computeVerdict(base({
    declared: [D('ASN-iiii')],
    recorded: [R('ASN-iiii', 'matched')],
    steps: [STEP('pass')],
    hitTurnCeiling: true,
    reachedEndTurn: false,
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 11 — No end_turn (without hitting ceiling) → blocked(no_end_turn)');
// e.g. provider closeout issue after all checks were captured.
expect('!reachedEndTurn → blocked(no_end_turn)',
  computeVerdict(base({
    declared: [D('ASN-jjjj')],
    recorded: [R('ASN-jjjj', 'matched')],
    steps: [STEP('pass')],
    reachedEndTurn: false,
    hitTurnCeiling: false,
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 12 — All clean → pass');
expect('happy path → pass',
  computeVerdict(base({
    declared: [D('ASN-kkkk'), D('ASN-llll')],
    recorded: [R('ASN-kkkk', 'matched'), R('ASN-llll', 'matched')],
    steps: [STEP('pass'), STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 13 — Conjunction stepFail + uncheckable + turnCeiling → fail (priority 3 wins)');
expect('conjunction → fail(step_failed)',
  computeVerdict(base({
    declared: [D('ASN-mmmm')],
    recorded: [R('ASN-mmmm', 'uncheckable')],
    steps: [STEP('fail')],
    hitTurnCeiling: true,
    reachedEndTurn: false,
  })),
  { status: 'fail', reason: 'step_failed' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 14 — Soft-tier (should) not_matched WITHOUT semantic confirmation → degraded pass');
// Wording mismatch on a 'should' assertion: deterministic miss but no semantic
// rescue attempt. Case passes with an incidental_assertion_mismatch warning.
// The soft tier means "secondary copy that might vary" — don't fail the case.
expect('should not_matched (no semantic) → pass with warning',
  computeVerdict(base({
    declared: [D('ASN-s1'), D('ASN-s2', { criticality: 'should' })],
    recorded: [
      R('ASN-s1', 'matched'),
      { assertionId: 'ASN-s2', outcome: 'not_matched' }, // no semanticConfirmedNotMatched
    ],
    steps: [STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched', warnings: ['incidental_assertion_mismatch'] });

// ─────────────────────────────────────────────────────────────────────────
console.log('Fixture 15 — Soft-tier not_matched WITH semantic confirmation → fail (behavioral absence)');
// Both deterministic AND semantic verifier said not_matched → genuine behavior
// absent from page, not a wording gap. Promote to fail regardless of tier.
expect('should not_matched + semanticConfirmedNotMatched → fail',
  computeVerdict(base({
    declared: [D('ASN-s3'), D('ASN-s4', { criticality: 'should' })],
    recorded: [
      R('ASN-s3', 'matched'),
      { assertionId: 'ASN-s4', outcome: 'not_matched', semanticConfirmedNotMatched: true },
    ],
    steps: [STEP('pass')],
  })),
  { status: 'fail', reason: 'soft_assertion_behavioral_absence' });

// Pure 'must' not_matched still wins over soft double-miss (priority 4 before 4b).
expect('must not_matched + soft double-miss → fail(assertion_not_matched)',
  computeVerdict(base({
    declared: [D('ASN-s5'), D('ASN-s6', { criticality: 'should' })],
    recorded: [
      { assertionId: 'ASN-s5', outcome: 'not_matched' },
      { assertionId: 'ASN-s6', outcome: 'not_matched', semanticConfirmedNotMatched: true },
    ],
    steps: [STEP('pass')],
  })),
  { status: 'fail', reason: 'assertion_not_matched' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Invariant — declared has entry with no recorded outcome → THROWS LOUD');
expectThrows(
  'missing recorded for declared assertion throws',
  () => computeVerdict(base({
    declared: [D('ASN-nnnn'), D('ASN-oooo')],
    recorded: [R('ASN-nnnn', 'matched')],   // ASN-oooo is missing on purpose
    steps: [STEP('pass')],
  })),
  'computeVerdict invariant violated'
);

// ─────────────────────────────────────────────────────────────────────────
console.log('parseFailed handling — calibration grounding failures');
// parseFailed records are excluded from validDeclared. When ALL declared
// assertions are parseFailed (Calibrator grounding gap), we consult runtime
// outcomes instead of immediately failing.

// 1. No runtime outcomes at all → degraded pass (pre-assert-check era / benefit of doubt).
expect('all-parseFailed, no runtime outcomes → degraded pass (not invariant throw)',
  computeVerdict(base({
    declared: [{ ...D('ASN-pppp'), parseFailed: true }],
    recorded: [],
    steps: [STEP('pass')],
  })),
  { status: 'blocked', reason: 'assertion_parse_failed' });

// 2. Runtime outcome matched → degraded pass (site passed, calibration gap is ours).
expect('all-parseFailed, runtime matched → degraded pass',
  computeVerdict(base({
    declared: [{ ...D('ASN-p1'), parseFailed: true }, { ...D('ASN-p2'), parseFailed: true }],
    recorded: [{ assertionId: 'ASN-p1', outcome: 'matched' }, { assertionId: 'ASN-p2', outcome: 'matched' }],
    steps: [STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched', warnings: ['all_assertions_ungrounded'] });

// 3. Any runtime not_matched → fail (site actually failed the check).
expect('all-parseFailed, runtime not_matched → fail',
  computeVerdict(base({
    declared: [{ ...D('ASN-pf3'), parseFailed: true }],
    recorded: [{ assertionId: 'ASN-pf3', outcome: 'not_matched' }],
    steps: [STEP('pass')],
  })),
  { status: 'fail', reason: 'assertion_parse_failed' });

// 4. Any runtime uncheckable → needs_human (ambiguous).
expect('all-parseFailed, runtime uncheckable → needs_human',
  computeVerdict(base({
    declared: [{ ...D('ASN-pf4'), parseFailed: true }],
    recorded: [{ assertionId: 'ASN-pf4', outcome: 'uncheckable' }],
    steps: [STEP('pass')],
  })),
  { status: 'blocked', reason: 'assertion_parse_failed' });

// Zero declared still produces no_assertions_declared (Architect forgot to write any).
expect('zero declared → blocked(no_assertions_declared)',
  computeVerdict(base({
    declared: [],
    recorded: [],
    steps: [STEP('pass')],
  })),
  { status: 'blocked', reason: 'no_assertions_declared' });

// ─────────────────────────────────────────────────────────────────────────
console.log('Soft assertion uncheckable → degraded pass (not fail)');
// A soft (should/incidental) assertion the agent couldn't verify is our
// verification limitation, not a site defect. Routes to degraded pass.
expect('soft uncheckable → pass with soft_assertion_uncheckable warning',
  computeVerdict(base({
    declared: [D('ASN-must'), { ...D('ASN-soft'), criticality: 'should' }],
    recorded: [
      { assertionId: 'ASN-must', outcome: 'matched' },
      { assertionId: 'ASN-soft', outcome: 'uncheckable' },
    ],
    steps: [STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched', warnings: ['soft_assertion_uncheckable'] });

// ─────────────────────────────────────────────────────────────────────────
console.log('FORBIDDEN_TEXT — defensive verdict-time inversion');

// Helper: a FORBIDDEN_TEXT declared assertion.
const FORBID = (id, type = 'FORBIDDEN_TEXT') => ({ id, type, payload: { unexpectedText: 'undefined' } });

// Agent used expectedText (wrong primitive). Tool returned not_matched
// (text correctly absent). Without inversion, computeVerdict would mark
// this as fail. With inversion, it correctly marks pass.
expect('forbidden text + positive primitive + not_matched (absent) → pass',
  computeVerdict(base({
    declared: [FORBID('ASN-fx1')],
    recorded: [R('ASN-fx1', 'not_matched')],   // primitiveUsed undefined → defensive invert
    steps: [STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

// Same as above but with primitiveUsed explicitly 'positive'.
expect('forbidden text + primitiveUsed=positive + not_matched → pass',
  computeVerdict(base({
    declared: [FORBID('ASN-fx2')],
    recorded: [{ assertionId: 'ASN-fx2', outcome: 'not_matched', primitiveUsed: 'positive' }],
    steps: [STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

// Agent used expectedText, got matched (text WAS found → forbidden text
// is present → real fail).
expect('forbidden text + positive primitive + matched (present) → fail',
  computeVerdict(base({
    declared: [FORBID('ASN-fx3')],
    recorded: [{ assertionId: 'ASN-fx3', outcome: 'matched', primitiveUsed: 'positive' }],
    steps: [STEP('pass')],
  })),
  { status: 'fail', reason: 'assertion_not_matched' });

// Agent used the right primitive (unexpectedText). Tool returned matched
// (text correctly absent). primitiveUsed='negative' means NO inversion.
expect('forbidden text + negative primitive + matched (absent) → pass',
  computeVerdict(base({
    declared: [FORBID('ASN-fx4')],
    recorded: [{ assertionId: 'ASN-fx4', outcome: 'matched', primitiveUsed: 'negative' }],
    steps: [STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

// Agent used unexpectedText, got not_matched (text WAS found → real fail).
expect('forbidden text + negative primitive + not_matched (present) → fail',
  computeVerdict(base({
    declared: [FORBID('ASN-fx5')],
    recorded: [{ assertionId: 'ASN-fx5', outcome: 'not_matched', primitiveUsed: 'negative' }],
    steps: [STEP('pass')],
  })),
  { status: 'fail', reason: 'assertion_not_matched' });

// effectiveOutcome still maps forbidden+uncheckable → uncheckable (the OUTCOME is
// unchanged), but at the VERDICT layer a hard-uncheckable with positive execution
// evidence (a passing step) is a degraded PASS, not a user-facing block (Phase 1
// verdict purity) — identical to Fixture 9.
expect('forbidden text + uncheckable + passing step → degraded pass',
  computeVerdict(base({
    declared: [FORBID('ASN-fx6')],
    recorded: [{ assertionId: 'ASN-fx6', outcome: 'uncheckable', primitiveUsed: 'positive' }],
    steps: [STEP('pass')],
  })),
  { status: 'blocked', reason: 'assertion_uncheckable' });

// FORBIDDEN_ROLE follows the same rules.
expect('forbidden role + positive primitive + not_matched (absent) → pass',
  computeVerdict(base({
    declared: [{ id: 'ASN-fx7', type: 'FORBIDDEN_ROLE', payload: { unexpectedRole: 'dialog' } }],
    recorded: [{ assertionId: 'ASN-fx7', outcome: 'not_matched', primitiveUsed: 'positive' }],
    steps: [STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

// Mixed bag: 2 forbidden (one positive, one negative) + 1 regular TEXT.
expect('mixed forbidden + regular → all matched semantically → pass',
  computeVerdict(base({
    declared: [
      FORBID('ASN-fx8'),
      { id: 'ASN-fx9', type: 'TEXT', payload: { expectedText: 'Welcome' } },
    ],
    recorded: [
      { assertionId: 'ASN-fx8', outcome: 'not_matched', primitiveUsed: 'positive' }, // forbidden absent
      { assertionId: 'ASN-fx9', outcome: 'matched', primitiveUsed: 'positive' },      // Welcome present
    ],
    steps: [STEP('pass')],
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

console.log('Execution ownership — QAAI errors, product validations, and dependencies');
expect('empty/fresh snapshot inability is BLOCKED as a QAAI execution error',
  computeVerdict(base({
    declared: [D('ASN-odyssey-visible')],
    recorded: [R('ASN-odyssey-visible', 'uncheckable', 'agent_never_reached')],
    steps: [{
      status: 'fail',
      actionOutcome: 'failed',
      operationCheck: {
        required: true,
        matched: false,
        reason: 'visible_not_confirmed',
        evidence: 'Cached state and the one fresh validation snapshot did not confirm it.',
      },
    }],
  })),
  { status: 'blocked', reason: 'qaai_execution_error' });

expect('completed journal assertion mismatch is FAIL(validation_failed)',
  computeVerdict(base({
    declared: [D('ASN-journal-mismatch')],
    recorded: [R('ASN-journal-mismatch', 'matched')],
    steps: [{ status: 'pass', actionOutcome: 'succeeded', assertionOutcome: 'not_matched' }],
  })),
  { status: 'fail', reason: 'validation_failed' });

expect('non-blocking journal assertion mismatch does not fail the case',
  computeVerdict(base({
    declared: [D('ASN-nonblocking-mismatch')],
    recorded: [R('ASN-nonblocking-mismatch', 'matched')],
    steps: [{
      status: 'pass',
      actionType: 'assert',
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_matched',
      operationCheck: { required: false, matched: false },
    }],
  })),
  { status: 'pass', reason: 'all_assertions_matched' });

expect('action-time assertion proof overrides post-loop declaration drift',
  computeVerdict(base({
    declared: [D('ASN-post-loop-drift')],
    recorded: [{
      assertionId: 'ASN-post-loop-drift',
      outcome: 'not_matched',
      source: 'post_loop',
    }],
    steps: [{
      status: 'pass',
      actionType: 'assert',
      operationCheck: { required: false, matched: true },
    }],
  })),
  {
    status: 'pass',
    reason: 'all_assertions_matched',
    warnings: ['declared_assertion_drift'],
  });

expect('canonical journal assertionOutcome overrides duplicate post-loop prose drift',
  computeVerdict(base({
    declared: [D('ASN-journal-post-loop-drift')],
    recorded: [{
      assertionId: 'ASN-journal-post-loop-drift',
      outcome: 'not_matched',
      source: 'post_loop',
    }],
    steps: [{
      status: 'pass',
      actionType: 'assert',
      actionOutcome: 'succeeded',
      assertionOutcome: 'matched',
    }],
  })),
  {
    status: 'pass',
    reason: 'all_assertions_matched',
    warnings: ['declared_assertion_drift'],
  });

expect('dependency descendant not executed is BLOCKED and distinct',
  computeVerdict(base({
    declared: [D('ASN-dependency')],
    recorded: [R('ASN-dependency', 'matched')],
    steps: [{
      status: 'skipped',
      actionOutcome: 'not_executed',
      dependencySkipped: true,
      failureType: 'dependency_skipped',
    }],
  })),
  { status: 'blocked', reason: 'dependency_not_executed' });

console.log('effectiveOutcome — pure function smoke');
expect('non-forbidden + matched → matched',     effectiveOutcome('TEXT',           'matched',     'positive'), 'matched');
expect('non-forbidden + not_matched → not_matched', effectiveOutcome('URL',         'not_matched', 'positive'), 'not_matched');
expect('forbidden + positive + matched → not_matched', effectiveOutcome('FORBIDDEN_TEXT', 'matched',  'positive'), 'not_matched');
expect('forbidden + positive + not_matched → matched', effectiveOutcome('FORBIDDEN_TEXT', 'not_matched', 'positive'), 'matched');
expect('forbidden + negative + matched stays matched',  effectiveOutcome('FORBIDDEN_TEXT', 'matched', 'negative'), 'matched');
expect('forbidden + negative + not_matched stays',      effectiveOutcome('FORBIDDEN_TEXT', 'not_matched', 'negative'), 'not_matched');
expect('forbidden + uncheckable stays uncheckable',     effectiveOutcome('FORBIDDEN_TEXT', 'uncheckable', 'positive'), 'uncheckable');
expect('forbidden + missing primitiveUsed → invert (legacy default)',
  effectiveOutcome('FORBIDDEN_TEXT', 'not_matched', undefined), 'matched');

// ─────────────────────────────────────────────────────────────────────────
console.log('deriveFlipDirection — documented transitions (needs_human folded into fail)');
expect('FAIL → PASS  → FAIL_TO_PASS',           deriveFlipDirection('fail',         'pass'),        'FAIL_TO_PASS');
expect('PASS → FAIL  → PASS_TO_FAIL',           deriveFlipDirection('pass',         'fail'),        'PASS_TO_FAIL');
expect('PASS → needs_human → PASS_TO_FAIL',     deriveFlipDirection('pass',         'needs_human'), 'PASS_TO_FAIL');
expect('needs_human → PASS → FAIL_TO_PASS',     deriveFlipDirection('needs_human',  'pass'),        'FAIL_TO_PASS');
expect('FAIL → needs_human → null (same bucket)', deriveFlipDirection('fail',       'needs_human'), null);
expect('needs_human → FAIL → null (same bucket)', deriveFlipDirection('needs_human','fail'),        null);
expect('FAIL → BLOCKED → OTHER',                deriveFlipDirection('fail',         'blocked'),     'OTHER');
expect('PASS → PASS → null (agreement)',        deriveFlipDirection('pass',         'pass'),        null);
expect('null claim → null',                     deriveFlipDirection(null,           'pass'),        null);

// ─────────────────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log('OK — all assertions passed');
}
