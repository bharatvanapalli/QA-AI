'use strict';
// Guard for Phase A2 — structured evidence contract + de-poisoned binder.
const { buildRowEvidenceContract, bindExpectedColumnToAssertion } = require('../server/services/testDataMatrix');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const mk = (o) => ({ index: 0, setName: 'S', sheet: 'S', inputs: {}, raw: {}, expected: null, rowClass: null, expectedColumn: null, rowClassColumn: null, label: 'Row 1', ...o });
const kinds = (c) => c.requiredEvidence.map((e) => e.kind);
const ev = (c, k) => c.requiredEvidence.find((e) => e.kind === k);

console.log('— Friend verification #1: expectedValidationError NEVER becomes pageName —');
{
  // A PAGE assertion the architect authored, bound against an error-expected row.
  const assertion = { type: 'PAGE', criticality: 'must', payload: { pageName: '{{expectedValidationError}}', expectedSignals: { text: ['Username'] } } };
  const row = mk({ inputs: { username: '', password: 'x' }, expected: 'Username is required', expectedColumn: 'expectedValidationError' });
  const bound = bindExpectedColumnToAssertion(assertion, row);
  const pn = bound && bound.payload && bound.payload.pageName;
  ok('error value did NOT become pageName', pn !== 'username_is_required' && pn !== 'Username is required' && !(typeof pn === 'string' && pn.includes('{{')), `pageName=${JSON.stringify(pn)}`);
  ok('unbound {{token}} pageName stripped', pn == null || !String(pn).includes('{{'), `pageName=${JSON.stringify(pn)}`);
}

console.log('\n— Friend verification #2: expectedLandingPage destination -> destination evidence —');
{
  const row = mk({ inputs: { username: 'Admin', password: 'admin123' }, expected: '/web/index.php/dashboard/index', expectedColumn: 'expectedLandingPage' });
  const c = buildRowEvidenceContract(row);
  ok('intentClass success', c.intentClass === 'success', c.intentClass);
  const pp = ev(c, 'page_present');
  ok('requires page_present at destination', !!pp && pp.page === 'destination', JSON.stringify(kinds(c)));
  ok('destination urlPattern bound', pp && /dashboard/.test(String(pp.urlPattern || '')), JSON.stringify(pp));
}

console.log('\n— Friend verification #3: expectedLandingPage=/auth/login on negative row -> STAY/REJECT —');
{
  const row = mk({ inputs: { username: 'baduser', password: 'badpass' }, expected: '/web/index.php/auth/login', expectedColumn: 'expectedLandingPage', label: 'Row 6 · invalidCredentials' });
  const c = buildRowEvidenceContract(row);
  ok('intentClass auth_rejection (NOT success)', c.intentClass === 'auth_rejection', c.intentClass);
  ok('requires page_present at entry', (ev(c, 'page_present') || {}).page === 'entry', JSON.stringify(kinds(c)));
  ok('requires destination_absent', kinds(c).includes('destination_absent'), JSON.stringify(kinds(c)));
}

console.log('\n— Friend verification #4: mixed rows in one sheet -> different intentClass —');
{
  const rows = [
    mk({ inputs: { username: '', password: 'x' }, label: 'Row 1 · emptyUsername' }),                                              // blank input -> required_validation (rung 3)
    mk({ inputs: { username: 'Admin', password: 'admin123' }, rowClass: 'validAdminInputs', rowClassColumn: 'scenarioType' }),     // success (rowClass signal)
    mk({ inputs: { username: 'wrong', password: 'wrong' }, rowClass: 'invalidCredentials', rowClassColumn: 'scenarioType' }),      // auth_rejection (rowClass signal — NOT the input value)
  ].map(buildRowEvidenceContract);
  const classes = rows.map((c) => c.intentClass);
  ok('three distinct intent classes', new Set(classes).size === 3, JSON.stringify(classes));
  ok('emptyUsername -> required_validation', classes[0] === 'required_validation', classes[0]);
  ok('validAdminInputs -> success', classes[1] === 'success', classes[1]);
  ok('invalidCredentials -> auth_rejection', classes[2] === 'auth_rejection', classes[2]);
}

console.log('\n— Friend verification #5: declaredAssertions preserved as advisory (not mutated into oracle) —');
{
  // bindExpectedColumnToAssertion is the only path that touches the assertion; for
  // a non-URL error value it must NOT inject expectedSignals/primaryIndicator or
  // overwrite the authored identity — it stays advisory.
  const assertion = { type: 'TEXT', criticality: 'should', provenance: 'doc_quoted', payload: { expectedText: 'Some doc note' } };
  const row = mk({ inputs: { username: '', password: 'x' }, expected: 'Required', expectedColumn: 'expectedValidationError' });
  const bound = bindExpectedColumnToAssertion(assertion, row);
  ok('TEXT assertion type preserved', bound.type === 'TEXT', bound.type);
  ok('provenance preserved', bound.provenance === 'doc_quoted', bound.provenance);
  ok('not turned into a PAGE oracle', !bound.payload.pageName && !bound.payload.expectedSignals, JSON.stringify(bound.payload));
}

console.log('\n— field_error scoping + required_validation evidence —');
{
  const row = mk({ inputs: { username: '', password: 'admin123' }, expected: 'Username is required', expectedColumn: 'expectedValidationError' });
  const c = buildRowEvidenceContract(row);
  ok('intentClass required_validation', c.intentClass === 'required_validation', c.intentClass);
  const fe = ev(c, 'field_error');
  ok('field_error scoped to the blank field (username)', !!fe && fe.fieldRole === 'username', JSON.stringify(fe));
  ok('field_error messageClass required', fe && fe.messageClass === 'required', JSON.stringify(fe));
  ok('expectedText carried as advisory text (not a gate)', fe && fe.expectedText === 'Username is required', JSON.stringify(fe));
}

console.log('\n— conflict delta: negative intent + a success destination column —');
{
  // Row classed negative (empty username) but the sheet ALSO carries a dashboard
  // landing column → emit a delta, intent stays primary.
  const row = mk({ inputs: { username: '', password: 'x' }, expected: 'Required', expectedColumn: 'expectedValidationError', raw: { expectedLandingPage: '/web/index.php/dashboard/index', expectedValidationError: 'Required' } });
  const c = buildRowEvidenceContract(row);
  ok('intent stays negative (required_validation)', c.intentClass === 'required_validation', c.intentClass);
  ok('conflict delta emitted', c.contractDeltas.some((d) => d.kind === 'destination_vs_intent_conflict'), JSON.stringify(c.contractDeltas));
  ok('destination required ABSENT (intent primary)', kinds(c).includes('destination_absent'), JSON.stringify(kinds(c)));
  ok('does NOT require page_present at destination', !c.requiredEvidence.some((e) => e.kind === 'page_present' && e.page === 'destination'), JSON.stringify(kinds(c)));
}

console.log('\n— low-confidence row still gets evidence requirements (never silently certified) —');
{
  const row = mk({ inputs: {} });   // empty inputs -> unknown/low
  const c = buildRowEvidenceContract(row);
  ok('intentClass unknown / confidence low', c.intentClass === 'unknown' && c.confidence === 'low', `${c.intentClass}/${c.confidence}`);
  ok('still emits a requirement (page_settled) for the Conductor to resolve live', c.requiredEvidence.length > 0, JSON.stringify(kinds(c)));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — evidence contract + de-poisoned binder verified');
