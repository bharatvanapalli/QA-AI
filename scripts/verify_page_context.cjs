'use strict';
/*
 * Guard for the page-drift module derivation. Proves the guard catches drift even
 * when a step has NO Architect urlPattern (the a306ab75 case) — using verify.url
 * or a navigate step's value URL — and that /performance during an /admin flow is
 * a module mismatch.
 */
const { moduleOfUrl, expectedModuleForStep, pageDriftDecision } = require('../server/lib/pageContext');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const BASE = 'https://opensource-demo.orangehrmlive.com/web/index.php';

console.log('— module extraction —');
ok('admin module', moduleOfUrl(`${BASE}/admin/saveSystemUser`) === 'admin');
ok('performance module', moduleOfUrl(`${BASE}/performance/searchEvaluatePerformanceReview`) === 'performance');
ok('null for non-url', moduleOfUrl('') === null);

console.log('\n— expected module derived without urlPattern (a306ab75-like) —');
ok('from navigate step value', expectedModuleForStep({ action: 'Navigate', value: `${BASE}/admin/saveSystemUser` }) === 'admin');
ok('from verify.url', expectedModuleForStep({ action: 'Verify', verify: { kind: 'url', url: `${BASE}/admin/viewSystemUsers` } }) === 'admin');
ok('from urlPattern when present', expectedModuleForStep({ urlPattern: `${BASE}/pim/addEmployee` }) === 'pim');
ok('plain Fill step with no URL signal → null (cannot guess)', expectedModuleForStep({ action: 'Fill', element: 'Employee Name', value: 'Alice' }) === null);

console.log('\n— drift detection: /performance during an /admin workflow —');
{
  // Workflow module tracked as admin (from the navigate step); a later action is on performance.
  const workflowMod = expectedModuleForStep({ action: 'Navigate', value: `${BASE}/admin/saveSystemUser` });
  const curMod = moduleOfUrl(`${BASE}/performance/searchEvaluatePerformanceReview`);
  ok('admin workflow vs performance current → mismatch (drift)', workflowMod && curMod && workflowMod !== curMod);
  ok('admin vs admin → no drift', moduleOfUrl(`${BASE}/admin/saveSystemUser`) === moduleOfUrl(`${BASE}/admin/viewSystemUsers`));
}

console.log('\n— conductor decision: block real drift, allow legitimate transition setup —');
{
  const drift = pageDriftDecision({
    workflowModule: 'admin',
    currentUrl: `${BASE}/performance/searchEvaluatePerformanceReview`,
    step: { action: 'Fill', element: 'Username textbox on Add User form', value: 'qaai_ess_lifecycle_01' },
    toolName: 'browser_type',
  });
  ok('admin workflow on performance page → hard block', drift.block === true && /workflow is "admin"/.test(drift.reason || ''), JSON.stringify(drift));

  const loginStart = pageDriftDecision({
    workflowModule: 'auth',
    currentUrl: `${BASE}/auth/login`,
    step: { action: 'Click', element: 'Login button', verify: { kind: 'url', url: `${BASE}/dashboard/index` } },
    toolName: 'browser_click',
  });
  ok('login click from auth toward dashboard is allowed', loginStart.block === false, JSON.stringify(loginStart));

  const nav = pageDriftDecision({
    workflowModule: 'dashboard',
    currentUrl: `${BASE}/dashboard/index`,
    step: { action: 'Navigate', value: `${BASE}/admin/viewSystemUsers` },
    toolName: 'browser_navigate',
  });
  ok('explicit browser_navigate is allowed to cross modules', nav.block === false, JSON.stringify(nav));
}

console.log('\n— session-expiry recovery: re-login on /auth must NOT be blocked as drift —');
{
  // Mid-run the session expired and the app bounced to /auth/login while the
  // tracked workflow module was "dashboard". Re-login must be ALLOWED.
  const reauth = pageDriftDecision({
    workflowModule: 'dashboard',
    currentUrl: `${BASE}/auth/login`,
    step: { action: 'Fill', element: 'Username', value: 'Admin' },
    toolName: 'browser_type',
  });
  ok('re-login on /auth (workflow=dashboard) is ALLOWED, not drift', reauth.block === false, JSON.stringify(reauth));
  ok('tracked module resets to auth for clean recovery', reauth.nextWorkflowModule === 'auth', JSON.stringify(reauth.nextWorkflowModule));
  // But a NON-auth drift (admin workflow on performance) is still blocked.
  const stillBlocks = pageDriftDecision({ workflowModule: 'admin', currentUrl: `${BASE}/performance/searchEvaluatePerformanceReview`, step: { action: 'Fill' }, toolName: 'browser_type' });
  ok('real non-auth drift still hard-blocks', stillBlocks.block === true);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — page-context drift derivation verified (works without urlPattern via verify.url / navigate value)');
