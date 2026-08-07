'use strict';
/*
 * Phase B — CHECKPOINT 1 proof: RECORDED-EVIDENCE replay of run 90002e1c.
 *
 * Honest scope (per the locked rules): this replays the deterministic
 * VerdictEngine + Phase-B-slice evidence checkers against pageStates TRANSCRIBED
 * from run 90002e1c's stored assertion evidence (prisma/dev.db). It does NOT
 * re-execute raw snapshots (the cancelled run did not persist them) and does NOT
 * prove the LIVE Conductor can gather the same observedEvidence — that is
 * checkpoint 2 (fresh live capture).
 *
 * Proves:
 *   (1) OLD poisoned `must` PAGE assertion -> FAIL          (the recorded reality)
 *   (2) NEW required_validation contract on the SAME real pageState -> NOT a bug.
 *       field_error is UNOBSERVABLE (the stored evidence never captured it; we
 *       refuse to fabricate it), so the honest verdict is not_judged -> blocked,
 *       which REMOVES the false website-bug accusation.
 *   (3) PASS path (explicitly fresh-shaped, NOT from 90002e1c): when the field
 *       error IS observed, the same contract -> works -> pass.
 *   (4) Synthetic negative control: a negative row that REACHED the dashboard
 *       -> destination_absent violated -> bug -> fail (no fake-pass).
 */
const fs = require('fs');
const path = require('path');
const { buildRowEvidenceContract } = require('../server/services/testDataMatrix');
const { judgeRowEvidence } = require('../server/services/evidenceCheckers');
const { mapVerdictToRunStatus } = require('../server/services/verdictEngine');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'phaseB_replay_90002e1c.json'), 'utf8'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const mkRow = (inputs) => ({ index: 0, setName: 'AuthProfiles', sheet: 'AuthProfiles', inputs, raw: { ...inputs }, expected: null, rowClass: null, expectedColumn: null, rowClassColumn: null, label: 'replay row' });

console.log(`Run under replay: ${fx.runId}  (shared poisoned assertion: ${fx.assertionIdShared})\n`);

console.log('— (1)+(2) the 5 real fail cases: OLD=FAIL, NEW=not a bug (not_judged, field_error uncaptured) —');
for (const c of fx.cases) {
  console.log(`\n  · case ${c.caseId}  poisonedPageName=${JSON.stringify(c.poisonedPageName)}`);
  console.log(`    provenance: recordedStatus=${c.recordedStatus} (${c.recordedReason}) | assertion ${c.assertionId}`);
  console.log(`    evidence excerpt: "${c.storedEvidenceExcerpt.slice(0, 110)}…"`);

  // (1) OLD reality, preserved in the DB.
  ok('OLD path recorded FAIL', c.recordedStatus === 'fail', c.recordedStatus);

  if (!c.modelForContractProof) {
    console.log('    (not modeled for contract proof — pageName "(none)" gives no reliable input basis; provenance only)');
    continue;
  }

  // (2) NEW path on the SAME transcribed pageState.
  const contract = buildRowEvidenceContract(mkRow(c.row));
  ok('row classifies negative (required_validation)', contract.intentClass === 'required_validation', contract.intentClass);
  const res = judgeRowEvidence(contract, c.reconstructedPageState);
  const mapped = mapVerdictToRunStatus(res);
  ok('NEW verdict is NOT bug (false-FAIL removed)', res.verdict !== 'bug', `${res.verdict}`);
  ok('NEW verdict is not_judged (field_error unobservable, not fabricated)', res.verdict === 'not_judged', `${res.verdict}/${res.reason}`);
  ok('entry page_present + destination_absent SATISFIED from stored evidence',
    res.items.filter((i) => i.kind === 'page_present' || i.kind === 'destination_absent').every((i) => i.status === 'satisfied'),
    JSON.stringify(res.items.map((i) => `${i.kind}:${i.status}`)));
  ok('field_error UNOBSERVABLE (channel not captured)', res.unobservable.includes('field_error'), JSON.stringify(res.unobservable));
  ok('maps to blocked(evidence_missing) — not fail, not pass', mapped.status === 'blocked' && mapped.blockedReason === 'evidence_missing', JSON.stringify(mapped));
}

console.log('\n— (3) PASS path (fresh-shaped, NOT from 90002e1c): field error OBSERVED -> works -> pass —');
{
  const f = fx.freshShapedPassCase;
  const contract = buildRowEvidenceContract(mkRow(f.row));
  const res = judgeRowEvidence(contract, f.pageState);
  const mapped = mapVerdictToRunStatus(res);
  ok('verdict works', res.verdict === 'works', `${res.verdict}/${res.reason}`);
  ok('maps to pass', mapped.status === 'pass', JSON.stringify(mapped));
  ok('all gating items satisfied', res.items.every((i) => i.status === 'satisfied'), JSON.stringify(res.items.map((i) => `${i.kind}:${i.status}`)));
}

console.log('\n— (3b) text DELTA carried advisory, verdict still works —');
{
  const contract = buildRowEvidenceContract(mkRow({ username: '', password: 'admin123' }));
  // observed text differs from a doc-expected string -> delta, NOT a failure.
  const ps = { url: 'https://x/web/index.php/auth/login', entryUrlPattern: 'auth/login', authedUrlPattern: 'dashboard',
    fieldErrors: [{ fieldRole: 'username', messageClass: 'required', text: 'Required' }], pageErrors: [] };
  // inject a doc-expected string onto the contract's field_error to force a delta
  const fe = contract.requiredEvidence.find((e) => e.kind === 'field_error');
  if (fe) fe.expectedText = 'Username is required';
  const res = judgeRowEvidence(contract, ps);
  ok('verdict still works despite text delta', res.verdict === 'works', res.verdict);
  ok('delta surfaced advisory', res.deltas.some((d) => d.kind === 'evidence_text_delta' && /Username is required/.test(d.expected || '')), JSON.stringify(res.deltas));
}

console.log('\n— (4) synthetic negative control: negative row REACHED dashboard -> bug -> fail —');
{
  const n = fx.syntheticNegativeControl;
  const contract = buildRowEvidenceContract(mkRow(n.row));
  const res = judgeRowEvidence(contract, n.pageState);
  const mapped = mapVerdictToRunStatus(res);
  ok('verdict bug', res.verdict === 'bug', `${res.verdict}/${res.reason}`);
  ok('destination_absent is the violation (inverse bug caught)', res.violated.includes('destination_absent'), JSON.stringify(res.violated));
  ok('maps to fail (no fake-pass)', mapped.status === 'fail', JSON.stringify(mapped));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — Phase B checkpoint 1 (recorded-evidence replay) verified. NOT YET PROVEN: live Conductor gather (checkpoint 2).');
