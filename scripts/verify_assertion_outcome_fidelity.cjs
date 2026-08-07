'use strict';
/* Guard: the EXPORT's per-assertion verdict must track the LIVE run's verdict.
 *   - reduceAssertionOutcomes collapses many observations to one effective outcome,
 *     priority not_matched > matched > uncheckable.
 *   - emitAssertion(step):
 *       liveOutcome 'uncheckable' -> SOFT annotation, NO expect()/throw (L3: never invent
 *         a gate the live run never resolved; this was the run 707ba2ac cookie-check that
 *         turned a needs_human into a hard export failure).
 *       liveOutcome 'matched'/'not_matched'/absent -> hard gate retained (matched passes;
 *         not_matched reproduces the live defect; legacy runs without outcomes still assert).
 */
const path = require('path');
const { reduceAssertionOutcomes } = require(path.join(__dirname,'..','server','services','codegen','replayExport'));
const { emitAssertion } = require(path.join(__dirname,'..','server','services','codegen','adapters','playwrightReference'));

let fail = 0;
const ok = (c, m) => { if (!c) { console.error('  FAIL:', m); fail++; } else console.log('  ok:', m); };

// ── reduceAssertionOutcomes ────────────────────────────────────────────────
{
  const log = JSON.stringify([
    { assertionId: 'A', outcome: 'uncheckable' }, { assertionId: 'A', outcome: 'matched' },   // A: matched wins over uncheckable
    { assertionId: 'B', outcome: 'matched' }, { assertionId: 'B', outcome: 'not_matched' },    // B: not_matched dominates
    { assertionId: 'C', outcome: 'uncheckable' },                                              // C: stays uncheckable
  ]);
  const r = reduceAssertionOutcomes(log);
  ok(r.A === 'matched', `A reduces matched>uncheckable (got ${r.A})`);
  ok(r.B === 'not_matched', `B reduces not_matched dominates (got ${r.B})`);
  ok(r.C === 'uncheckable', `C stays uncheckable (got ${r.C})`);
  ok(Object.keys(reduceAssertionOutcomes(null)).length === 0, 'null log -> {}');
  ok(Object.keys(reduceAssertionOutcomes('not json')).length === 0, 'garbage log -> {}');
}

// ── emitAssertion honours liveOutcome ──────────────────────────────────────
const evalStep = (lo) => ({ op: 'assert', channel: 'EVALUATE', contractRef: 'ASN-x', script: 'document.cookie.length > 0', expected: 'true', liveOutcome: lo });
const textStep = (lo) => ({ op: 'assert', channel: 'UI_TEXT', contractRef: 'ASN-t', expected: 'Dashboard', liveOutcome: lo });

{
  const u = emitAssertion(evalStep('uncheckable'));
  ok(/qaai-uncheckable/.test(u), 'EVALUATE uncheckable -> qaai-uncheckable annotation');
  ok(!/\bexpect\(/.test(u) && !/\bthrow\b/.test(u), 'EVALUATE uncheckable -> no expect()/throw gate');

  const ut = emitAssertion(textStep('uncheckable'));
  ok(/qaai-uncheckable/.test(ut) && !/\bexpect\(/.test(ut) && !/assertTextPresent/.test(ut), 'UI_TEXT uncheckable -> annotation only, no assertion call');

  const m = emitAssertion(evalStep('matched'));
  ok(/evaluateSettled\(page/.test(m) && /expect\(/.test(m), 'EVALUATE matched -> hard gate retained (settled eval)');

  const nm = emitAssertion(evalStep('not_matched'));
  ok(/expect\(/.test(nm), 'EVALUATE not_matched -> hard gate retained (reproduces live defect)');

  const legacy = emitAssertion(evalStep(undefined));
  ok(/expect\(/.test(legacy), 'EVALUATE no liveOutcome (legacy run) -> hard gate retained');
}

if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
console.log('\nverify_assertion_outcome_fidelity: all checks passed');
