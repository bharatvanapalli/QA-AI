'use strict';
/*
 * VERDICT PURITY — the verdict layer must NEVER fake-pass a required assertion.
 *
 * Reproduces the exact false-pass pattern run 91d6301a persisted for the
 * "Data-driven form validation matrix" (S2 C1): two MUST assertions recorded
 * `uncheckable`, six passing steps, yet status=pass with mechanicalVerdictReason
 * "all_assertions_matched ⚠ hard_assertion_uncheckable_passed_on_clean_execution".
 *
 * Drives the REAL computeVerdict() (not a fixture of it) and asserts:
 *   - hard/must uncheckable  -> needs_human (NEVER pass), regardless of passing steps
 *   - missing hard record    -> throws the invariant (NEVER pass)
 *   - soft/should uncheckable -> pass + warning (unchanged — only HARD tier gates)
 *   - hard not_matched        -> fail (unchanged)
 *   - the dead escape-hatch warning string is gone from the source
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { computeVerdict } = require(path.join(ROOT, 'server', 'services', 'computeVerdict'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const must = (id) => ({ id, criticality: 'must', type: 'PAGE' });
const should = (id) => ({ id, criticality: 'should', type: 'TEXT' });
const rec = (id, outcome, extra) => ({ assertionId: id, outcome, ...(extra || {}) });
const passSteps = (n) => Array.from({ length: n }, (_, i) => ({ index: i, status: 'pass' }));
const skipSteps = (n) => Array.from({ length: n }, (_, i) => ({ index: i, status: 'skipped' }));
const base = { userCancelled: false, sessionDied: false, consecutiveErrorsExceeded: false, hitTurnCeiling: false, reachedEndTurn: true };

console.log('— THE run 91d6301a false-pass pattern: hard uncheckable + passing steps —');
{
  // Two MUST assertions, both uncheckable; six passing steps — the exact S2 C1 shape.
  const v = computeVerdict({ ...base,
    declared: [must('ASN-6f70269f'), must('ASN-fed1dbff')],
    recorded: [rec('ASN-6f70269f', 'uncheckable', { reason: 'primitive_unsupported' }),
               rec('ASN-fed1dbff', 'uncheckable', { reason: 'primitive_unsupported' })],
    steps: passSteps(6),
  });
  ok('S2 C1 pattern is NOT pass', v.status !== 'pass', `got ${v.status}/${v.reason}`);
  ok('S2 C1 pattern → needs_human/assertion_uncheckable', v.status === 'needs_human' && v.reason === 'assertion_uncheckable', `got ${v.status}/${v.reason}`);
  ok('no "all_assertions_matched" reason leaks on an uncheckable must', !/all_assertions_matched/.test(v.reason || ''));
}

console.log('\n— hard uncheckable with NO passing step (was already needs_human) —');
{
  const v = computeVerdict({ ...base, declared: [must('A')], recorded: [rec('A', 'uncheckable')], steps: skipSteps(3) });
  ok('still needs_human (not blocked-into-pass)', v.status === 'needs_human' && v.reason === 'assertion_uncheckable', `got ${v.status}/${v.reason}`);
}

console.log('\n— ONE hard uncheckable among matched musts still blocks the whole pass —');
{
  const v = computeVerdict({ ...base,
    declared: [must('A'), must('B')],
    recorded: [rec('A', 'matched'), rec('B', 'uncheckable')],
    steps: passSteps(5),
  });
  ok('mixed matched+uncheckable musts → needs_human, not pass', v.status === 'needs_human', `got ${v.status}/${v.reason}`);
}

console.log('\n— soft/should uncheckable is UNCHANGED: pass + warning (only HARD tier gates) —');
{
  const v = computeVerdict({ ...base,
    declared: [must('A'), should('B')],
    recorded: [rec('A', 'matched'), rec('B', 'uncheckable')],
    steps: passSteps(4),
  });
  ok('matched must + uncheckable should → pass', v.status === 'pass', `got ${v.status}/${v.reason}`);
  ok('carries soft_assertion_uncheckable warning', Array.isArray(v.warnings) && v.warnings.includes('soft_assertion_uncheckable'), JSON.stringify(v.warnings));
}

console.log('\n— hard not_matched still FAILS (unchanged); clean pass still PASSES —');
{
  const f = computeVerdict({ ...base, declared: [must('A')], recorded: [rec('A', 'not_matched')], steps: passSteps(3) });
  ok('hard not_matched → fail', f.status === 'fail' && f.reason === 'assertion_not_matched', `got ${f.status}/${f.reason}`);
  const p = computeVerdict({ ...base, declared: [must('A')], recorded: [rec('A', 'matched')], steps: passSteps(3) });
  ok('all musts matched → pass', p.status === 'pass' && p.reason === 'all_assertions_matched', `got ${p.status}/${p.reason}`);
}

console.log('\n— MISSING hard record must not pass: the invariant THROWS rather than fake-pass —');
{
  let threw = null;
  try {
    computeVerdict({ ...base, declared: [must('A'), must('B')], recorded: [rec('A', 'matched')], steps: passSteps(3) });
  } catch (e) { threw = e; }
  ok('missing hard record throws (never returns pass)', !!threw && threw.code === 'INVARIANT_NO_RECORDED_OUTCOME', threw ? threw.code : 'did not throw');
  ok('the throw names the offending assertion id', !!threw && threw.assertionId === 'B', threw && threw.assertionId);
}

console.log('\n— TERMINATION signals resolve to their honest status, NOT an invariant throw (reviewer gap #2) —');
{
  // A terminal early-exit legitimately has missing assertion records; it must
  // return its terminal status, not throw INVARIANT_NO_RECORDED_OUTCOME.
  const declTwo = [must('A'), must('B')];
  const oneRec = [rec('A', 'matched')]; // B has no record → would trip the invariant
  const cancel = computeVerdict({ ...base, declared: declTwo, recorded: oneRec, steps: skipSteps(3), userCancelled: true });
  ok('userCancelled + missing record → skipped/user_cancelled (no throw)', cancel.status === 'skipped' && cancel.reason === 'user_cancelled', `${cancel.status}/${cancel.reason}`);
  const dead = computeVerdict({ ...base, declared: declTwo, recorded: oneRec, steps: skipSteps(3), sessionDied: true });
  ok('sessionDied + missing record → blocked/session_dead (no throw)', dead.status === 'blocked' && dead.reason === 'session_dead', `${dead.status}/${dead.reason}`);
  const errs = computeVerdict({ ...base, declared: declTwo, recorded: oneRec, steps: skipSteps(3), consecutiveErrorsExceeded: true });
  ok('consecutiveErrorsExceeded + missing record → blocked/consecutive_errors (no throw)', errs.status === 'blocked' && errs.reason === 'consecutive_errors', `${errs.status}/${errs.reason}`);
  // Turn ceiling: exempt from the throw, resolved gracefully by the ladder (never fake-pass).
  let ceilThrew = false, ceil = null;
  try { ceil = computeVerdict({ ...base, reachedEndTurn: false, hitTurnCeiling: true, declared: declTwo, recorded: oneRec, steps: passSteps(2) }); }
  catch (_) { ceilThrew = true; }
  ok('hitTurnCeiling + missing record → does NOT throw', !ceilThrew, 'threw INVARIANT');
  ok('hitTurnCeiling + missing record → non-pass (needs_human/assertion_missing_record or blocked)', !ceilThrew && ceil && ceil.status !== 'pass', ceil ? `${ceil.status}/${ceil.reason}` : 'threw');
  // A NON-terminal missing record still throws loudly (the invariant is intact).
  let normalThrew = null;
  try { computeVerdict({ ...base, declared: declTwo, recorded: oneRec, steps: passSteps(3) }); }
  catch (e) { normalThrew = e; }
  ok('non-terminal missing record STILL throws the invariant (intact)', !!normalThrew && normalThrew.code === 'INVARIANT_NO_RECORDED_OUTCOME', normalThrew ? normalThrew.code : 'did not throw');
}

console.log('\n— the dead escape-hatch is gone from the source (cannot regress silently) —');
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'services', 'computeVerdict.js'), 'utf8');
  ok('no "hard_assertion_uncheckable_passed_on_clean_execution" push remains',
    !src.includes("calGapWarnings.push('hard_assertion_uncheckable_passed_on_clean_execution')"));
  ok('the anyHardUncheckable branch returns needs_human (no fall-through to pass)',
    /if \(anyHardUncheckable\) \{[\s\S]*?return \{ status: 'needs_human', reason: 'assertion_uncheckable' \};[\s\S]*?\}/.test(src));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — verdict purity enforced: a required (must) assertion that is uncheckable or unrecorded can NEVER pass. The run 91d6301a false-pass pattern now resolves to needs_human.');
