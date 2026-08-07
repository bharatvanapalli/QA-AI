'use strict';
/*
 * Guard for B-2c.4 — case-start precision. Proves every case starts from a
 * KNOWN, certified page: fresh snapshot always; login cases reset to clean
 * logged-out state even when the URL looks like /login; wrong starting page ->
 * navigate; entry certified before handing control. SYNTHETIC, not live.
 */
const { planCaseStart, certifyEntryReached } = require('../server/services/caseStartPrecision');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const types = (p) => p.actions.map((a) => a.type);
const LOGIN = 'https://x/web/index.php/auth/login';
const DASH = 'https://x/web/index.php/dashboard/index';

console.log('— login case inheriting dashboard from a prior case -> reset + navigate + fresh snapshot + certify —');
{
  const p = planCaseStart({ currentUrl: DASH, establishesSession: true, requiredEntryPattern: 'auth/login' });
  ok('needsSessionReset', p.needsSessionReset === true);
  ok('needsNavigation', p.needsNavigation === true);
  ok('needsFreshSnapshot', p.needsFreshSnapshot === true);
  ok('action order reset->navigate->fresh_snapshot->certify', JSON.stringify(types(p)) === JSON.stringify(['reset_session', 'navigate', 'fresh_snapshot', 'certify_entry_page']), JSON.stringify(types(p)));
}

console.log('— login case ALREADY on /login still resets (URL is not a reliable auth-state proxy) —');
{
  const p = planCaseStart({ currentUrl: LOGIN, establishesSession: true, requiredEntryPattern: 'auth/login' });
  ok('still resets despite being on /login', p.needsSessionReset === true, p.reason);
  ok('still navigates after reset', p.needsNavigation === true);
  ok('reset_session is present', types(p).includes('reset_session'));
}

console.log('— authed (non-login) case already on the required page -> no reset, no navigation, but FRESH snapshot —');
{
  const p = planCaseStart({ currentUrl: DASH, establishesSession: false, requiredEntryPattern: 'dashboard' });
  ok('no session reset', p.needsSessionReset === false);
  ok('no navigation (already on required page)', p.needsNavigation === false, p.reason);
  ok('entryAlreadyCorrect', p.entryAlreadyCorrect === true);
  ok('STILL takes a fresh snapshot (no stale scrollback)', p.needsFreshSnapshot === true && types(p).includes('fresh_snapshot'));
}

console.log('— non-login case on the WRONG page -> navigate (no reset) —');
{
  const p = planCaseStart({ currentUrl: LOGIN, establishesSession: false, requiredEntryPattern: 'pim/viewEmployeeList' });
  ok('navigates to required page', p.needsNavigation === true && p.actions.some((a) => a.type === 'navigate' && a.to === 'pim/viewEmployeeList'), JSON.stringify(types(p)));
  ok('no session reset for a non-login case', p.needsSessionReset === false);
}

console.log('— no required entry declared -> no nav/reset, fresh snapshot + certify(settled) only —');
{
  const p = planCaseStart({ currentUrl: DASH, establishesSession: false, requiredEntryPattern: null });
  ok('no navigation when no entry required', p.needsNavigation === false);
  ok('fresh snapshot still required', p.needsFreshSnapshot === true);
  ok('certify_entry_page present (settled check)', types(p).includes('certify_entry_page'));
}

console.log('— snapshot already fresh for this case -> skip the redundant fresh_snapshot —');
{
  const p = planCaseStart({ currentUrl: DASH, establishesSession: false, requiredEntryPattern: 'dashboard', currentSnapshotFresh: true });
  ok('needsFreshSnapshot false', p.needsFreshSnapshot === false);
  ok('no fresh_snapshot action', !types(p).includes('fresh_snapshot'), JSON.stringify(types(p)));
}

console.log('— certifyEntryReached —');
{
  ok('on /login when entry=auth/login -> certified', certifyEntryReached({ currentUrl: LOGIN, requiredEntryPattern: 'auth/login' }).certified === true);
  ok('on /dashboard when entry=auth/login -> NOT certified', certifyEntryReached({ currentUrl: DASH, requiredEntryPattern: 'auth/login' }).certified === false);
  ok('no required entry -> certified (n/a)', certifyEntryReached({ currentUrl: DASH, requiredEntryPattern: null }).certified === true);
  ok('no current URL -> not certified', certifyEntryReached({ currentUrl: null, requiredEntryPattern: 'auth/login' }).certified === false);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — case-start precision verified (SYNTHETIC; wired into the case loop at B-2d, proven at B-2e)');
