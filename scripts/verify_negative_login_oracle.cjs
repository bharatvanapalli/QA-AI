'use strict';
/*
 * NEGATIVE-LOGIN ORACLE — proves the composite is ENFORCED end-to-end (audit #4).
 *
 * The reviewer asked for one enforced composite check for negative login rows:
 *   URL/login identity AND dashboard absent AND rejection/validation visible — and a
 *   pass ONLY when all hold together; dashboard reached -> bug; rejection uncapturable
 *   -> blocked/evidence_missing.
 *
 * That composite is realised by the row's requiredEvidence contract
 * (testDataMatrix builds page_present(entry) + destination_absent + error_present /
 * field_error) evaluated by the DETERMINISTIC VerdictEngine, whose tally already is a
 * composite AND: any item violated -> bug; any unobservable -> not_judged; ALL
 * satisfied -> works. This guard runs the REAL judgeRowEvidence + mapVerdictToRunStatus
 * over the reviewer's exact matrix to prove the composite gates correctly (not advisory).
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { judgeRowEvidence } = require(path.join(ROOT, 'server', 'services', 'evidenceCheckers'));
const { mapVerdictToRunStatus } = require(path.join(ROOT, 'server', 'services', 'verdictEngine'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

// Composite contracts exactly as testDataMatrix emits them for negative login rows.
// Contracts now include the 4th composite signal: login_form_present.
const authRejectionContract = {
  intentClass: 'auth_rejection',
  requiredEvidence: [
    { kind: 'page_present', page: 'entry' },
    { kind: 'login_form_present' },
    { kind: 'destination_absent', destinationHint: '/dashboard' },
    { kind: 'error_present', messageClass: 'auth' },
  ],
};
const requiredValidationContract = {
  intentClass: 'required_validation',
  requiredEvidence: [
    { kind: 'page_present', page: 'entry' },
    { kind: 'login_form_present' },
    { kind: 'destination_absent', destinationHint: '/dashboard' },
    { kind: 'field_error', fieldRole: 'username', messageClass: 'required' },
  ],
};
const FORM_VISIBLE = { usernameVisible: true, passwordVisible: true, submitVisible: true };
const FORM_ABSENT = { usernameVisible: false, passwordVisible: false, submitVisible: false };
// pageState shapes as pageStateBuilder produces (url + patterns + channels). loginForm
// defaults to visible; individual cases override (absent / pending=null).
const onLogin = { entryUrlPattern: '/auth/login', authedUrlPattern: '/dashboard', loginForm: FORM_VISIBLE };
const judgeStatus = (contract, ps) => mapVerdictToRunStatus(judgeRowEvidence(contract, ps)).status;

console.log('— auth_rejection (invalid credentials) —');
ok('stay on login + dashboard absent + auth error visible → PASS (works)',
  judgeStatus(authRejectionContract, { ...onLogin, url: 'https://app/auth/login', pageErrors: [{ messageClass: 'auth', text: 'Invalid credentials' }], fieldErrors: [] }) === 'pass');
ok('reached the dashboard → FAIL (bug — the inverse defect)',
  judgeStatus(authRejectionContract, { ...onLogin, url: 'https://app/dashboard/index', pageErrors: [], fieldErrors: [] }) === 'fail');
ok('stay on login but NO rejection visible after settle (both channels empty) → FAIL (bug)',
  judgeStatus(authRejectionContract, { ...onLogin, url: 'https://app/auth/login', pageErrors: [], fieldErrors: [] }) === 'fail');
ok('rejection channel still PENDING (uncaptured) → BLOCKED/evidence_missing, never pass',
  judgeStatus(authRejectionContract, { ...onLogin, url: 'https://app/auth/login', pageErrors: null, fieldErrors: null }) === 'blocked');

console.log('\n— required_validation (empty field) —');
ok('empty username stays on login + dashboard absent + scoped required error → PASS (works)',
  judgeStatus(requiredValidationContract, { ...onLogin, url: 'https://app/auth/login', pageErrors: [], fieldErrors: [{ fieldRole: 'username', messageClass: 'required', text: 'Required' }] }) === 'pass');
ok('empty field reaches the dashboard → FAIL (bug)',
  judgeStatus(requiredValidationContract, { ...onLogin, url: 'https://app/dashboard/index', pageErrors: [], fieldErrors: [] }) === 'fail');
ok('required-validation error channel PENDING → BLOCKED/evidence_missing',
  judgeStatus(requiredValidationContract, { ...onLogin, url: 'https://app/auth/login', pageErrors: null, fieldErrors: null }) === 'blocked');
ok('no error scoped to the required field (errors only elsewhere) → FAIL (bug)',
  judgeStatus(requiredValidationContract, { ...onLogin, url: 'https://app/auth/login', pageErrors: [], fieldErrors: [{ fieldRole: 'password', messageClass: 'required', text: 'Required' }] }) === 'fail');

console.log('\n— composite is AND, not OR (a single satisfied signal must NOT pass) —');
ok('dashboard absent satisfied BUT no error + still pending error → not a pass',
  judgeStatus(authRejectionContract, { ...onLogin, url: 'https://app/auth/login', pageErrors: null, fieldErrors: null }) !== 'pass');
ok('error present BUT reached dashboard → FAIL (destination violation dominates)',
  judgeStatus(authRejectionContract, { ...onLogin, url: 'https://app/dashboard/index', pageErrors: [{ messageClass: 'auth', text: 'Invalid credentials' }], fieldErrors: [] }) === 'fail');

console.log('\n— login-form visibility is the REQUIRED 4th signal (audit #4 finish) —');
ok('URL login + dashboard absent + rejection visible BUT form MISSING → NOT pass (login_form_present violated → bug)',
  judgeStatus(authRejectionContract, { ...onLogin, url: 'https://app/auth/login', loginForm: FORM_ABSENT, pageErrors: [{ messageClass: 'auth', text: 'Invalid credentials' }], fieldErrors: [] }) !== 'pass');
ok('form channel PENDING (not captured) → BLOCKED/evidence_missing, never pass',
  judgeStatus(authRejectionContract, { ...onLogin, url: 'https://app/auth/login', loginForm: null, pageErrors: [{ messageClass: 'auth', text: 'Invalid credentials' }], fieldErrors: [] }) === 'blocked');
ok('all four signals present (form + login URL + dashboard absent + rejection) → PASS',
  judgeStatus(authRejectionContract, { ...onLogin, url: 'https://app/auth/login', loginForm: FORM_VISIBLE, pageErrors: [{ messageClass: 'auth', text: 'Invalid credentials' }], fieldErrors: [] }) === 'pass');
ok('dashboard reached even WITH form + error evidence → FAIL (destination violation dominates)',
  judgeStatus(authRejectionContract, { ...onLogin, url: 'https://app/dashboard/index', loginForm: FORM_ABSENT, pageErrors: [{ messageClass: 'auth', text: 'x' }], fieldErrors: [] }) === 'fail');
ok('required_validation: form visible + scoped required field error + dashboard absent → PASS',
  judgeStatus(requiredValidationContract, { ...onLogin, url: 'https://app/auth/login', loginForm: FORM_VISIBLE, pageErrors: [], fieldErrors: [{ fieldRole: 'username', messageClass: 'required', text: 'Required' }] }) === 'pass');
ok('required_validation: form MISSING (password input not visible) → NOT pass',
  judgeStatus(requiredValidationContract, { ...onLogin, url: 'https://app/auth/login', loginForm: { usernameVisible: true, passwordVisible: false }, pageErrors: [], fieldErrors: [{ fieldRole: 'username', messageClass: 'required', text: 'Required' }] }) !== 'pass');

console.log('\n— checker unit behavior (login_form_present) —');
{
  const { _checkers } = require(path.join(ROOT, 'server', 'services', 'evidenceCheckers'));
  const c = _checkers.login_form_present;
  ok('username+password visible → satisfied', c({}, { loginForm: FORM_VISIBLE }).status === 'satisfied');
  ok('password not visible → violated', c({}, { loginForm: { usernameVisible: true, passwordVisible: false } }).status === 'violated');
  ok('channel null (pending) → unobservable', c({}, { loginForm: null }).status === 'unobservable');
  ok('submit absent but username+password present → still satisfied (submit not gated)', c({}, { loginForm: { usernameVisible: true, passwordVisible: true, submitVisible: false } }).status === 'satisfied');
}

console.log('\n— registry + emission wiring —');
{
  const reg = require(path.join(ROOT, 'server', 'services', 'evidenceRegistry'));
  const REG = reg.REGISTRY || reg.registry || reg.EVIDENCE_KINDS || reg;
  const entry = (REG && REG.login_form_present) || (typeof reg.isCheckable === 'function' ? { hasChecker: reg.isCheckable('login_form_present') } : null);
  ok('login_form_present registered with hasChecker:true', !!(entry && entry.hasChecker === true) || (typeof reg.isCheckable === 'function' && reg.isCheckable('login_form_present') === true));
  const tdm = fs.readFileSync(path.join(ROOT, 'server', 'services', 'testDataMatrix.js'), 'utf8');
  ok('testDataMatrix emits login_form_present for LOGIN rows only (isLoginRow gated)',
    tdm.includes("if (isLoginRow) requiredEvidence.push({ kind: 'login_form_present' })") && /isLoginRow = .*pass\|pwd/.test(tdm));
  const psb = fs.readFileSync(path.join(ROOT, 'server', 'services', 'pageStateBuilder.js'), 'utf8');
  ok('pageStateBuilder builds a loginForm channel + maps login_form_present → [loginForm]',
    psb.includes('loginForm:') && psb.includes("case 'login_form_present': return ['loginForm'];") && psb.includes('function extractLoginForm'));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — negative-login composite ENFORCED with ALL FOUR signals: login URL identity + login FORM visible + dashboard absent + rejection/validation visible. Pass only when all hold; dashboard reached → fail; any signal (incl. form) uncapturable → blocked/evidence_missing.');
