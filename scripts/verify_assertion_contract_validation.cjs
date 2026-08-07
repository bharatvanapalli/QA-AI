'use strict';
/*
 * #1 ASSERTION-CONTRACT VALIDATION — a malformed PAGE assertion (the "blind bind"
 * poison: pageName an unresolved {{token}} or an error-message column) must be
 * REJECTED, not silently accepted as a checkable `must` that false-blocks the case
 * (uncheckable -> needs_human). Reproduces TestCase a66425b4 / ASN-6f70269f.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { validateRecord, normalizeForCase } = require(path.join(ROOT, 'server', 'lib', 'declaredAssertions'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— the EXACT malformed assertion from run 91d6301a (a66425b4 / ASN-6f70269f) is rejected —');
{
  const poison = { id: 'ASN-6f70269f', type: 'PAGE', criticality: 'must',
    payload: { pageName: '{{expectedValidationError}}', expectedSignals: { text: ['Required'], url: ['/web/index.php/auth/login'] } } };
  const v = validateRecord(poison);
  ok('pageName="{{expectedValidationError}}" → rejected (ok:false)', v.ok === false, JSON.stringify(v).slice(0, 80));
  ok('rejected with page_assertion_unresolved_token', v.issue === 'page_assertion_unresolved_token', v.issue);
}

console.log('\n— unresolved token anywhere in PAGE identity is rejected —');
{
  ok('token in expectedSignals.url → rejected',
    validateRecord({ type: 'PAGE', payload: { expectedSignals: { url: ['{{expectedLandingPage}}'] } } }).issue === 'page_assertion_unresolved_token');
  ok('token in expectedSignals.text → rejected',
    validateRecord({ type: 'PAGE', payload: { expectedSignals: { text: ['{{expected}}'] } } }).issue === 'page_assertion_unresolved_token');
  ok('token in payload.url → rejected',
    validateRecord({ type: 'PAGE', payload: { url: '{{x}}', expectedSignals: { text: ['Dashboard'] } } }).issue === 'page_assertion_unresolved_token');
}

console.log('\n— a well-formed PAGE assertion (real identity) is accepted —');
{
  const good = validateRecord({ type: 'PAGE', criticality: 'must', payload: { pageName: 'login', expectedSignals: { url: ['/auth/login'], text: ['Login'] } } });
  ok('real pageName + url + text → accepted (ok:true)', good.ok === true, JSON.stringify(good).slice(0, 80));
}

console.log('\n— at the CASE level, the poison is preserved as parseFailed (excluded from the hard verdict) —');
{
  const res = normalizeForCase(
    [{ id: 'ASN-6f70269f', type: 'PAGE', criticality: 'must', payload: { pageName: '{{expectedValidationError}}', expectedSignals: { text: ['Required'] } } }],
    { automatability: 'automatable', caseName: 'Data-driven form validation matrix' },
  );
  const recs = res.normalized || [];
  const poison = recs.find((r) => r.parseIssue === 'page_assertion_unresolved_token' || (r.parseFailed && /unresolved_token/.test(r.parseIssue || '')));
  ok('poison record carried as parseFailed (not a valid checkable must)', !!poison && poison.parseFailed === true, JSON.stringify(recs.map((r) => ({ pf: r.parseFailed, i: r.parseIssue }))));
  ok('issue is surfaced for QA review', (res.issues || []).some((s) => /unresolved_token/.test(s)), JSON.stringify(res.issues));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — a PAGE assertion whose identity is an unresolved {{token}} (the blind-bind poison) is rejected as a contract defect and can never enter the verdict as a checkable must.');
