'use strict';
/*
 * DATA-ROW INTENT + CASE-vs-BINDING validation (run 91d6301a, audit P5).
 *
 * The FormValidation matrix bound ONE fixed negative oracle ("remain on login page")
 * across rows of DIFFERENT classes — so validAdminInputs / validESSInputs (success
 * rows, shouldSubmit=Yes) were judged by a negative oracle, and separate "empty
 * username/password" cases were bound to AuthProfiles rows that carry VALID creds.
 *
 * Drives the REAL classifyRowOutcomeClass + deriveCaseOracleIntent +
 * dataRowContractDefect to prove the mismatch is caught BEFORE the browser opens
 * (blocked as a test-data/binding defect — never mis-scored against the site), while
 * a correctly-bound negative row under a negative case is NOT flagged.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { classifyRowOutcomeClass } = require(path.join(ROOT, 'server', 'services', 'testDataMatrix'));
const { dataRowContractDefect, deriveCaseOracleIntent } = require(path.join(ROOT, 'server', 'lib', 'dataRowContract'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

// Generic, non-site rows (no OrangeHRM strings).
const validAdminRow = { index: 0, rowClass: 'validAdminInputs', label: 'validAdminInputs', inputs: { username: 'user1', password: 'Passw0rd!' }, raw: { shouldSubmit: 'Yes', expectedError: '' } };
const validEssRow = { index: 1, rowClass: 'validESSInputs', label: 'validESSInputs', inputs: { username: 'ess1', password: 'Ess0rd!1' }, raw: { shouldSubmit: 'Yes' } };
const emptyUserRow = { index: 2, rowClass: 'emptyUsername', label: 'emptyUsername', inputs: { username: '', password: 'Passw0rd!' }, raw: {} };
const authProfileValidRow = { index: 0, rowClass: null, label: 'admin', inputs: { username: 'user1', password: 'Passw0rd!' }, raw: {} };

console.log('— classifyRowOutcomeClass: the row classes are what the binding check relies on —');
ok('validAdminInputs → success', classifyRowOutcomeClass(validAdminRow).class === 'success', classifyRowOutcomeClass(validAdminRow).class);
ok('validESSInputs → success', classifyRowOutcomeClass(validEssRow).class === 'success', classifyRowOutcomeClass(validEssRow).class);
ok('emptyUsername → required_validation', classifyRowOutcomeClass(emptyUserRow).class === 'required_validation', classifyRowOutcomeClass(emptyUserRow).class);
ok('valid AuthProfiles row → success', classifyRowOutcomeClass(authProfileValidRow).class === 'success', classifyRowOutcomeClass(authProfileValidRow).class);

console.log('\n— deriveCaseOracleIntent —');
const negCaseRemainLogin = { name: 'Data-driven form validation matrix', declaredAssertions: [{ id: 'A', type: 'PAGE', criticality: 'must', text: 'User remains on the login page', payload: { pageName: 'Login' } }] };
const negCaseEmptyName = { name: 'Empty username shows inline error below username field', declaredAssertions: [] };
const negCaseInvalidHint = { name: 'Invalid credentials rejected', credentialHint: 'invalid', declaredAssertions: [] };
const posCaseDashboard = { name: 'Admin login redirects to dashboard', declaredAssertions: [{ id: 'A', type: 'PAGE', criticality: 'must', text: 'User is redirected to the dashboard', payload: { url: '/dashboard' } }] };
const ambiguousCase = { name: 'Login flow', declaredAssertions: [{ id: 'A', type: 'TEXT', text: 'Page loads' }] };
ok('"remain on login page" assertion → negative', deriveCaseOracleIntent(negCaseRemainLogin) === 'negative', deriveCaseOracleIntent(negCaseRemainLogin));
ok('"Empty username" case name → negative', deriveCaseOracleIntent(negCaseEmptyName) === 'negative', deriveCaseOracleIntent(negCaseEmptyName));
ok('credentialHint:"invalid" → negative', deriveCaseOracleIntent(negCaseInvalidHint) === 'negative', deriveCaseOracleIntent(negCaseInvalidHint));
ok('"redirects to dashboard" → positive', deriveCaseOracleIntent(posCaseDashboard) === 'positive', deriveCaseOracleIntent(posCaseDashboard));
ok('ambiguous case → null (never flag)', deriveCaseOracleIntent(ambiguousCase) === null, String(deriveCaseOracleIntent(ambiguousCase)));

const defect = (row, testCase) => dataRowContractDefect(row, { caseOracleIntent: deriveCaseOracleIntent(testCase), rowOutcome: classifyRowOutcomeClass(row) });

console.log('\n— THE mismatches the audit named are BLOCKED (test-data/binding defect) —');
ok('validAdminInputs under "remain on login" case → defect', !!defect(validAdminRow, negCaseRemainLogin), 'no defect');
ok('validESSInputs under "remain on login" case → defect', !!defect(validEssRow, negCaseRemainLogin), 'no defect');
ok('valid AuthProfiles row under "Empty username" case → defect', !!defect(authProfileValidRow, negCaseEmptyName), 'no defect');
ok('valid AuthProfiles row under invalid-credentials (NegativeAuth) case → defect', !!defect(authProfileValidRow, negCaseInvalidHint), 'no defect');

console.log('\n— correctly-bound rows are NOT flagged (no false test_data_invalid) —');
ok('emptyUsername (required_validation) under negative case → NO defect', !defect(emptyUserRow, negCaseRemainLogin), defect(emptyUserRow, negCaseRemainLogin) || '');
ok('validAdminInputs under a POSITIVE (dashboard) case → NO defect', !defect(validAdminRow, posCaseDashboard), defect(validAdminRow, posCaseDashboard) || '');
ok('validAdminInputs under an AMBIGUOUS case → NO defect', !defect(validAdminRow, ambiguousCase), defect(validAdminRow, ambiguousCase) || '');

console.log('\n— the new check does not disturb the existing row-internal defects —');
ok('emptyPassword class + non-empty password still flagged', !!dataRowContractDefect({ rowClass: 'emptyPassword', inputs: { username: 'user1', password: 'Passw0rd!' } }, {}), 'no defect');
ok('a clean positive row with no case context → NO defect', !dataRowContractDefect(validAdminRow, {}), 'unexpected defect');

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — case-vs-row intent enforced: a fixed NEGATIVE oracle bound to a SUCCESS row (validAdminInputs under remain-on-login; valid AuthProfiles row under an empty-field / invalid-credentials case) is blocked as a binding defect before the browser opens; correctly-bound negative rows and positive/ambiguous cases are untouched.');
