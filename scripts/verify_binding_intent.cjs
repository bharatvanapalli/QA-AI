'use strict';
/*
 * #3 INTENT-AWARE DATA BINDING — chooseBinding must score CASE INTENT, not just
 * placeholder overlap, so a negative-auth case never makes AuthProfiles (the
 * positive identity sheet) its PRIMARY row matrix. Reproduces the exact failure:
 * "Invalid password — correct username rejected" must NOT bind to AuthProfiles.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chooseBinding, markDataAwareCases } = require(path.join(ROOT, 'server', 'services', 'testDataAuthoring'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const AUTH_PROFILES = { sheet: 'AuthProfiles', purpose: 'auth_profiles', confidence: 'high', columnToField: { username: 'username', password: 'password' } };
const NEGATIVE_AUTH = { sheet: 'NegativeAuth', columnToField: { username: 'username', password: 'password' }, expectedColumn: 'expected', rowClassColumn: 'scenario' };
const FORM_VALIDATION = { sheet: 'FormValidation', columnToField: { username: 'username', password: 'password' }, expectedColumn: 'expected', rowClassColumn: 'scenario' };
const SECURITY_AUTH = { sheet: 'SecurityAuth', columnToField: { username: 'username', password: 'password' }, expectedColumn: 'expected' };

const negCase = {
  name: 'Invalid password — correct username rejected', credentialHint: 'invalid', declaredAssertions: [],
  steps: [{ action: 'Fill', element: 'Username field', value: '{{username}}' }, { action: 'Fill', element: 'Password field', value: '{{password}}' }],
};
const posCase = {
  name: 'Admin login redirects to dashboard', credentialHint: 'primary',
  declaredAssertions: [{ id: 'A', type: 'PAGE', payload: { expectedSignals: { url: ['/dashboard'] } } }],
  steps: [{ action: 'Fill', element: 'Username field', value: '{{username}}' }, { action: 'Fill', element: 'Password field', value: '{{password}}' }],
};
const ambiguousCase = {
  name: 'Login flow', declaredAssertions: [],
  steps: [{ action: 'Fill', element: 'Username field', value: '{{username}}' }, { action: 'Fill', element: 'Password field', value: '{{password}}' }],
};
const pick = (c, bindings) => { const r = chooseBinding(c, { name: 'Authentication', module: 'Authentication' }, bindings, null); return r.binding && r.binding.sheet; };

console.log('— THE exact failure: negative-auth case must NOT bind AuthProfiles —');
ok('"Invalid password rejected" with [AuthProfiles, NegativeAuth] → binds NegativeAuth', pick(negCase, [AUTH_PROFILES, NEGATIVE_AUTH]) === 'NegativeAuth', pick(negCase, [AUTH_PROFILES, NEGATIVE_AUTH]));
ok('order-independent: [NegativeAuth, AuthProfiles] → still NegativeAuth', pick(negCase, [NEGATIVE_AUTH, AUTH_PROFILES]) === 'NegativeAuth', pick(negCase, [NEGATIVE_AUTH, AUTH_PROFILES]));

console.log('\n— negative case prefers validation/security sheets over AuthProfiles too —');
ok('negative + [AuthProfiles, FormValidation] → FormValidation', pick(negCase, [AUTH_PROFILES, FORM_VALIDATION]) === 'FormValidation', pick(negCase, [AUTH_PROFILES, FORM_VALIDATION]));
ok('negative + [AuthProfiles, SecurityAuth] → SecurityAuth', pick(negCase, [AUTH_PROFILES, SECURITY_AUTH]) === 'SecurityAuth', pick(negCase, [AUTH_PROFILES, SECURITY_AUTH]));

console.log('\n— negative case + ONLY AuthProfiles → UNBOUND (never primary; synthesizer covers it) —');
ok('negative + [AuthProfiles] only → no binding (null)', pick(negCase, [AUTH_PROFILES]) == null, String(pick(negCase, [AUTH_PROFILES])));

console.log('\n— a POSITIVE case still binds AuthProfiles (intent matches identity sheet) —');
ok('"Admin login → dashboard" + [AuthProfiles, NegativeAuth] → AuthProfiles', pick(posCase, [AUTH_PROFILES, NEGATIVE_AUTH]) === 'AuthProfiles', pick(posCase, [AUTH_PROFILES, NEGATIVE_AUTH]));

console.log('\n— an AMBIGUOUS case is unaffected (placeholder scoring as before) —');
{
  const r = pick(ambiguousCase, [AUTH_PROFILES, NEGATIVE_AUTH]);
  ok('ambiguous case still resolves to a binding (no intent disqualification)', r === 'AuthProfiles' || r === 'NegativeAuth', String(r));
}

console.log('\n— #3.2 PRE-APPROVAL: an EXPLICIT wrong binding (negative case already bound to AuthProfiles) is rejected before approval —');
{
  const testData = { mapping: { bindings: [{ sheet: 'AuthProfiles', purpose: 'auth_profiles', columnToField: { username: 'username', password: 'password' } }] } };
  const mkScn = (c) => ([{ name: 'Negative Authentication', module: 'Authentication', cases: [c] }]);
  const negBound = { name: 'Invalid password — correct username rejected', credentialHint: 'invalid', declaredAssertions: [], dataBinding: { sheet: 'AuthProfiles' }, steps: [{ value: '{{username}}' }, { value: '{{password}}' }] };
  markDataAwareCases(mkScn(negBound), testData, {});
  ok('negative case explicitly bound to AuthProfiles → status incomplete', negBound.dataBinding && negBound.dataBinding.status === 'incomplete', JSON.stringify(negBound.dataBinding));
  ok('flagged data_binding_intent_mismatch (generation defect, pre-approval)',
    !!(negBound.dataBinding && (negBound.dataBinding.findings || []).some((f) => f.code === 'data_binding_intent_mismatch')), JSON.stringify(negBound.dataBinding && negBound.dataBinding.findings));

  const posBound = { name: 'Admin login redirects to dashboard', credentialHint: 'primary', declaredAssertions: [{ id: 'A', type: 'PAGE', payload: { expectedSignals: { url: ['/dashboard'] } } }], dataBinding: { sheet: 'AuthProfiles' }, steps: [{ value: '{{username}}' }, { value: '{{password}}' }] };
  markDataAwareCases(mkScn(posBound), testData, {});
  ok('a POSITIVE case explicitly bound to AuthProfiles is NOT flagged intent-mismatch',
    !(posBound.dataBinding && (posBound.dataBinding.findings || []).some((f) => f.code === 'data_binding_intent_mismatch')), JSON.stringify(posBound.dataBinding));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — data binding is intent-aware: a negative/invalid/validation/security case can never make AuthProfiles its primary row matrix (selection), and an explicit negative→AuthProfiles binding is rejected as a generation defect before approval; positive/ambiguous cases unaffected.');
