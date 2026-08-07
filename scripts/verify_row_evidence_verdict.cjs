'use strict';
/*
 * #2 LIVE EVIDENCE-CONTRACT ORACLE — judgeRowFromLiveSnapshot turns a genuinely
 * passing negative-login row into a real PASS (instead of the needs_human false
 * block caused by the malformed declaredAssertion), and catches the inverse bug.
 *
 * Drives the REAL helper end-to-end: buildRowEvidenceContract → buildPageState →
 * toCertifiedCheckerPageState → judgeRowEvidence → mapVerdictToRunStatus.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { judgeRowFromLiveSnapshot } = require(path.join(ROOT, 'server', 'lib', 'rowEvidenceVerdict'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const LOGIN_URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
const DASH_URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index';

// A negative-login row: empty username (required_validation intent).
const emptyUserRow = { index: 0, setName: 'FormValidation', label: 'emptyUsername', rowClass: 'emptyUsername', inputs: { username: '', password: 'x' }, raw: { scenario: 'emptyUsername' } };

// Snapshot of the OrangeHRM login page AFTER submitting empty username: form still
// visible, "Required" inline error under the Username field, still on /auth/login.
const SNAP_STILL_ON_LOGIN_WITH_ERROR = [
  '- textbox "Username" [ref=e23]',
  '  - text: "Required"',
  '- textbox "Password" [ref=e30]',
  '- button "Login" [ref=e32]',
].join('\n');

// Snapshot of a settled dashboard (no login form) — the inverse-bug case.
const SNAP_DASHBOARD = [
  '- heading "Dashboard" [ref=e1]',
  '- navigation "Sidepanel" [ref=e2]',
].join('\n');

console.log('— a genuinely-passing negative-login row → real PASS (not needs_human) —');
{
  const r = judgeRowFromLiveSnapshot({ row: emptyUserRow, snapshotText: SNAP_STILL_ON_LOGIN_WITH_ERROR, url: LOGIN_URL, entryUrlPattern: LOGIN_URL });
  ok('still-on-login + form visible + Required error → status=pass', r.status === 'pass', `${r.status} (${r.reason})`);
  ok('reason marks the evidence contract', /^evidence_contract:/.test(r.reason || ''), r.reason);
}

console.log('\n— inverse bug: negative row reached the dashboard → real FAIL —');
{
  const r = judgeRowFromLiveSnapshot({ row: emptyUserRow, snapshotText: SNAP_DASHBOARD, url: DASH_URL, entryUrlPattern: LOGIN_URL });
  ok('left the login page (reached dashboard) → status=fail', r.status === 'fail', `${r.status} (${r.reason})`);
  ok('reason names reached_destination', /reached_destination/.test(r.reason || ''), r.reason);
}

console.log('\n— evidence not observable → null (defer to declaredAssertion verdict; never fake-pass) —');
{
  const r = judgeRowFromLiveSnapshot({ row: emptyUserRow, snapshotText: '', url: LOGIN_URL, entryUrlPattern: LOGIN_URL });
  ok('empty snapshot → status=null (uncertified, defer)', r.status === null, `${r.status} (${r.reason})`);
}

console.log('\n— a `bug` from field-error scoping is NOT auto-failed (no false fail) —');
{
  // Still on login + form visible, but NO inline error captured. The field_error
  // requirement is unmet → `bug`, but the URL never left login, so we must NOT
  // decisively fail (could be a snapshot-scoping miss) — defer (null).
  const noErr = ['- textbox "Username" [ref=e23]', '- textbox "Password" [ref=e30]', '- button "Login" [ref=e32]'].join('\n');
  const r = judgeRowFromLiveSnapshot({ row: emptyUserRow, snapshotText: noErr, url: LOGIN_URL, entryUrlPattern: LOGIN_URL });
  ok('still-on-login + no captured error → status=null (defer, not a false fail)', r.status === null, `${r.status} (${r.reason})`);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — the live evidence contract is decisive for data-driven rows: a genuinely-passing negative-login row becomes a real PASS, a row that reached the destination becomes a real FAIL, and unobservable/ambiguous evidence defers (never a fake pass or false fail).');
