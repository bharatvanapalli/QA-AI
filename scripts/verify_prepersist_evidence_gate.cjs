'use strict';
/*
 * PRE-PERSIST EVIDENCE GATE — a `pass` cannot be persisted without real evidence.
 *
 * Reproduces the zero-evidence false-passes run 91d6301a stored (5 PASS rows with
 * 0 screenshots, empty assertionCheckResults, all 6 steps skipped, narrate-only
 * trail, empty mechanicalVerdictReason — i.e. they never went through the verdict
 * ladder at all). The gate is the LAST chokepoint every result write funnels
 * through, so it must catch these regardless of which upstream path produced them.
 *
 * Drives the REAL exported enforcePrePersistEvidenceGate() (server/lib).
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { enforcePrePersistEvidenceGate: gate } = require(path.join(ROOT, 'server', 'lib', 'prePersistEvidenceGate'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const passSteps = (n) => Array.from({ length: n }, (_, i) => ({ index: i, status: 'pass' }));
const skipSteps = (n) => Array.from({ length: n }, (_, i) => ({ index: i, status: 'skipped' }));
const realTrail = (n) => Array.from({ length: n }, (_, i) => ({ tool: i % 2 ? 'browser_click' : 'browser_type', ok: true }));
const narrateTrail = (n) => Array.from({ length: n }, () => ({ tool: 'agent_narration', agentNarration: true }));
const must = (id) => ({ id, criticality: 'must', type: 'PAGE' });

console.log('— THE run 91d6301a row-9 class: pass with NO evidence —');
{
  // overlyLongPassword: status=pass, screenshots=[], acr=[], all steps skipped, narrate-only trail.
  const g = gate({ status: 'pass', screenshots: [], assertionCheckResults: [], stepResults: skipSteps(6), actionTrail: narrateTrail(3), declaredAssertions: [must('A')], verdictMode: 'mechanical_v1' });
  ok('downgraded (not pass)', g.downgraded === true && g.status !== 'pass', `${g.status}`);
  ok('→ blocked/no_evidence', g.status === 'blocked' && g.blockedReason === 'no_evidence', `${g.status}/${g.blockedReason}`);
  ok('stamps a verdict_downgraded reason', /^verdict_downgraded:/.test(g.mechanicalVerdictReason || ''), g.mechanicalVerdictReason);
}

console.log('\n— narration-only trail but a stray screenshot (evades #1, caught by #2) —');
{
  const g = gate({ status: 'pass', screenshots: ['/a.png'], assertionCheckResults: [], stepResults: passSteps(0), actionTrail: narrateTrail(4), declaredAssertions: [], verdictMode: 'legacy' });
  ok('→ blocked/no_execution (no real browser action)', g.status === 'blocked' && g.blockedReason === 'no_execution', `${g.status}/${g.blockedReason}`);
}

console.log('\n— planned steps exist but NONE passed (all skipped) though there were real actions —');
{
  const g = gate({ status: 'pass', screenshots: ['/a.png'], assertionCheckResults: [{ outcome: 'matched' }], stepResults: skipSteps(6), actionTrail: realTrail(3), declaredAssertions: [must('A')], verdictMode: 'mechanical_v1' });
  ok('→ blocked/incomplete_execution', g.status === 'blocked' && g.blockedReason === 'incomplete_execution', `${g.status}/${g.blockedReason}`);
}

console.log('\n— mechanical_v1: declared assertions but ZERO checks recorded —');
{
  const g = gate({ status: 'pass', screenshots: ['/a.png'], assertionCheckResults: [], stepResults: passSteps(4), actionTrail: realTrail(4), declaredAssertions: [must('A'), must('B')], verdictMode: 'mechanical_v1' });
  ok('→ needs_human/assertion_missing_record', g.status === 'needs_human' && g.gateReason === 'pass_with_declared_assertions_but_no_checks', `${g.status}/${g.gateReason}`);
}

console.log('\n— LEGACY SAFETY: a real legacy pass with declared assertions + empty v2 array stays PASS —');
{
  // In legacy mode assertionCheckResults (the v2 column) is legitimately empty;
  // evidence lives in the trail. This MUST NOT be downgraded.
  const g = gate({ status: 'pass', screenshots: ['/a.png', '/b.png'], assertionCheckResults: [], stepResults: passSteps(5), actionTrail: realTrail(6), declaredAssertions: [must('A')], verdictMode: 'legacy' });
  ok('legacy pass with real evidence stays pass', g.status === 'pass' && g.downgraded === false, `${g.status}/${g.downgraded}`);
}

console.log('\n— a genuine clean pass (both modes) is untouched —');
{
  const mech = gate({ status: 'pass', screenshots: ['/a.png'], assertionCheckResults: [{ outcome: 'matched' }], stepResults: passSteps(6), actionTrail: realTrail(6), declaredAssertions: [must('A')], verdictMode: 'mechanical_v1' });
  ok('mechanical_v1 clean pass stays pass', mech.status === 'pass' && mech.downgraded === false, `${mech.status}`);
  const leg = gate({ status: 'pass', screenshots: ['/a.png'], assertionCheckResults: [], stepResults: passSteps(6), actionTrail: realTrail(6), declaredAssertions: [must('A')], verdictMode: 'legacy' });
  ok('legacy clean pass stays pass', leg.status === 'pass' && leg.downgraded === false, `${leg.status}`);
}

console.log('\n— we DOWNGRADE only; a fail/blocked/skipped/needs_human is never touched/upgraded —');
{
  for (const s of ['fail', 'blocked', 'skipped', 'needs_human']) {
    const g = gate({ status: s, screenshots: [], assertionCheckResults: [], stepResults: [], actionTrail: [], declaredAssertions: [], verdictMode: 'mechanical_v1' });
    ok(`status="${s}" returned untouched`, g.status === s && g.downgraded === false, `${g.status}/${g.downgraded}`);
  }
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — pre-persist evidence gate enforced: a pass without screenshots/checks/passing-step, a narration-only run, an all-skipped run, or (mechanical_v1) declared-but-unchecked assertions can no longer be persisted as PASS. Legacy passes with real evidence are untouched.');
