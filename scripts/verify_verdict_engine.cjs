'use strict';
// Guard for Phase B core — the deterministic VerdictEngine, proven against the
// user's EXACT acceptance matrix, using REAL A2 contracts (buildRowEvidenceContract).
const { evaluateEvidenceContract, mapVerdictToRunStatus } = require('../server/services/verdictEngine');
const { buildRowEvidenceContract } = require('../server/services/testDataMatrix');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const mk = (o) => ({ index: 0, setName: 'S', sheet: 'S', inputs: {}, raw: {}, expected: null, rowClass: null, expectedColumn: null, rowClassColumn: null, label: 'Row 1', ...o });
// all-satisfied observations aligned to a contract's requiredEvidence
const allSat = (c) => c.requiredEvidence.map(() => ({ status: 'satisfied' }));
const idxOf = (c, kind) => c.requiredEvidence.findIndex((e) => e.kind === kind);

console.log('— emptyUsername: login remains + dashboard absent + scoped Required error -> WORKS —');
{
  const c = buildRowEvidenceContract(mk({ inputs: { username: '', password: 'admin123' }, label: 'Row 1 · emptyUsername' }));
  const r = evaluateEvidenceContract(c, allSat(c));
  ok('verdict works', r.verdict === 'works', r.verdict + '/' + r.reason);
  ok('maps to pass', mapVerdictToRunStatus(r).status === 'pass');
  ok('contract required a scoped username field_error', idxOf(c, 'field_error') >= 0 && c.requiredEvidence[idxOf(c, 'field_error')].fieldRole === 'username');
}

console.log('\n— emptyUsername but DASHBOARD appeared (security bug) -> BUG (inverse-bug catch) —');
{
  const c = buildRowEvidenceContract(mk({ inputs: { username: '', password: 'admin123' }, label: 'Row 1 · emptyUsername' }));
  const obs = allSat(c);
  obs[idxOf(c, 'destination_absent')] = { status: 'violated', detail: 'dashboard markers present — empty username reached the authenticated area' };
  const r = evaluateEvidenceContract(c, obs);
  ok('verdict bug', r.verdict === 'bug', r.verdict);
  ok('violated includes destination_absent', r.violated.includes('destination_absent'));
  ok('maps to fail', mapVerdictToRunStatus(r).status === 'fail');
}

console.log('\n— emptyUsername but NO validation error shown (missing-validation defect) -> BUG —');
{
  const c = buildRowEvidenceContract(mk({ inputs: { username: '', password: 'admin123' }, label: 'Row 1 · emptyUsername' }));
  const obs = allSat(c);
  obs[idxOf(c, 'field_error')] = { status: 'violated', detail: 'no validation error appeared under the empty username field' };
  const r = evaluateEvidenceContract(c, obs);
  ok('verdict bug (site accepted empty required field silently)', r.verdict === 'bug', r.verdict);
  ok('violated includes field_error', r.violated.includes('field_error'));
}

console.log('\n— valid-admin: PASS only when dashboard evidence appears —');
{
  const c = buildRowEvidenceContract(mk({ inputs: { username: 'Admin', password: 'admin123' }, expected: '/web/index.php/dashboard/index', expectedColumn: 'expectedLandingPage' }));
  ok('intentClass success', c.intentClass === 'success', c.intentClass);
  // dashboard present -> works
  let r = evaluateEvidenceContract(c, [{ status: 'satisfied' }]);
  ok('dashboard present -> works', r.verdict === 'works', r.verdict);
  // stayed on login (dashboard NOT present) -> bug
  r = evaluateEvidenceContract(c, [{ status: 'violated', detail: 'still on login page; dashboard never appeared' }]);
  ok('stayed on login -> bug (valid creds must reach dashboard)', r.verdict === 'bug', r.verdict);
}

console.log('\n— dashboard expectation attached to a NEGATIVE row -> DELTA, not a product failure —');
{
  const c = buildRowEvidenceContract(mk({ inputs: { username: '', password: 'x' }, expected: 'Required', expectedColumn: 'expectedValidationError', raw: { expectedLandingPage: '/web/index.php/dashboard/index', expectedValidationError: 'Required' } }));
  ok('intent stayed negative', c.intentClass === 'required_validation', c.intentClass);
  ok('A2 emitted a destination_vs_intent_conflict delta', c.contractDeltas.some((d) => d.kind === 'destination_vs_intent_conflict'));
  const r = evaluateEvidenceContract(c, allSat(c));
  ok('verdict works (correct negative behavior)', r.verdict === 'works', r.verdict);
  ok('dashboard conflict surfaced as a DELTA (not a fail)', r.deltas.some((d) => d.kind === 'destination_vs_intent_conflict'));
  ok('dashboard was NEVER a required-present item', !c.requiredEvidence.some((e) => e.kind === 'page_present' && e.page === 'destination'));
}

console.log('\n— text delta (page "Required" vs doc "Username is required") -> still WORKS, delta reported —');
{
  const c = buildRowEvidenceContract(mk({ inputs: { username: '', password: 'x' }, expected: 'Username is required', expectedColumn: 'expectedValidationError' }));
  const obs = allSat(c);
  obs[idxOf(c, 'field_error')] = { status: 'satisfied', delta: { expected: 'Username is required', actual: 'Required', note: 'correct-class error, different wording' } };
  const r = evaluateEvidenceContract(c, obs);
  ok('verdict works despite wording difference', r.verdict === 'works', r.verdict);
  ok('text delta reported', r.deltas.some((d) => d.kind === 'evidence_text_delta' && d.actual === 'Required'));
}

console.log('\n— not_judged only when a CORE item is unobservable (and violated beats unobservable) —');
{
  const c = buildRowEvidenceContract(mk({ inputs: { username: '', password: 'x' }, label: 'Row 1 · emptyUsername' }));
  // one unobservable, rest satisfied -> not_judged
  let obs = allSat(c); obs[idxOf(c, 'field_error')] = { status: 'unobservable', detail: 'could not read the field-group error region after settle' };
  let r = evaluateEvidenceContract(c, obs);
  ok('unobservable core item -> not_judged', r.verdict === 'not_judged', r.verdict);
  ok('not_judged maps to blocked(evidence_missing), NOT a website verdict', mapVerdictToRunStatus(r).status === 'blocked' && mapVerdictToRunStatus(r).blockedReason === 'evidence_missing');
  // violated + unobservable together -> bug wins (a defect is definitive)
  obs = allSat(c);
  obs[idxOf(c, 'destination_absent')] = { status: 'violated' };
  obs[idxOf(c, 'field_error')] = { status: 'unobservable' };
  r = evaluateEvidenceContract(c, obs);
  ok('violated + unobservable -> bug (definitive defect wins)', r.verdict === 'bug', r.verdict);
}

console.log('\n— anti-fake-pass: empty contract never claims works —');
{
  const r = evaluateEvidenceContract({ requiredEvidence: [] }, []);
  ok('empty required evidence -> not_judged (never works)', r.verdict === 'not_judged' && r.reason === 'no_required_evidence', r.verdict + '/' + r.reason);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — VerdictEngine verified against the acceptance matrix');
