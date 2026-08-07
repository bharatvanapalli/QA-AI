'use strict';
/* Guard: Class E setup-chain composition. A journey that assumes an inherited authenticated
 * session it never establishes must get the run's recorded login PREPENDED (faithful replay,
 * no invented creds) — UNLESS it operates on the login page, references logout, or already
 * logs in. All detection is keyed off IR structure + universal auth concepts, never a site
 * string. Regression: run 707ba2ac's ESS-dashboard/RBAC opened on blank/unauth pages and
 * failed; negative-validation specs must NOT be composed; ESS-sidebar (own ESS session,
 * blocked) must block rather than run under admin. */
const path = require('path');
const X = require(path.join(__dirname,'..','server','services','codegen','replayExport'));
const { deriveLoginPrecondition, journeyNeedsLoginPrecondition, caseOperatesOnLoginPage, irPerformsLogin, journeyReferencesLogout, extractLoginBlock, deriveLogoutUrl, journeyPerformsLogout, journeyNeedsLogoutPrecondition, irHasOnlyFormValidationAsserts, journeyNeedsLogoutButCant } = X;

let fail = 0;
const ok = (c,m)=>{ if(!c){console.error('  FAIL:',m);fail++;} else console.log('  ok:',m); };
const item = (ir, caseName='c') => ({ r: { envelope: { ir }, caseName, runResultId: 'rr', testCaseId: 'tc', scenarioId: 'sid' } });

const loginIr = { steps: [
  { op:'act', action:'navigate', url:'https://x/auth/login' },
  { op:'resolve', as:'el1' }, { op:'act', action:'fill', target:'el1', valueRef:'env:QAAI_USERNAME' },
  { op:'resolve', as:'el2' }, { op:'act', action:'fill', target:'el2', valueRef:'env:QAAI_PASSWORD' },
  { op:'resolve', as:'el3' }, { op:'act', action:'click', target:'el3' },
  { op:'assert', channel:'URL', expected:'/dashboard' },          // post-login extra (should be sliced off)
]};
const authContentIr = { steps: [ { op:'assert', channel:'UI_TEXT', expected:'My Info' }, { op:'assert', channel:'UI_TEXT', expected:'Apply Leave' } ] };
const navAuthIr = { steps: [ { op:'act', action:'navigate', url:'https://x/admin/viewSystemUsers' }, { op:'assert', channel:'PAGE', expected:'Dashboard' } ] };
const loginPageEvalIr = { steps: [ { op:'assert', channel:'EVALUATE', script:'!!document.querySelector(\'input[name="password"]\')', expected:'true' } ] };
const negSubmitIr = { steps: [ { op:'act', action:'navigate', url:'https://x/auth/login' }, { op:'resolve', as:'el1' }, { op:'act', action:'fill', target:'el1', valueRef:'env:QAAI_USERNAME' }, { op:'act', action:'click', target:'el1' }, { op:'assert', channel:'UI_TEXT', expected:'Password is required' } ] };
const logoutIr = { steps: [ { op:'assert', channel:'UI_TEXT', expected:'after logout the cookie is gone' } ] };

// irPerformsLogin
ok(irPerformsLogin(loginIr), 'irPerformsLogin: pw fill + click → true');
ok(!irPerformsLogin(authContentIr), 'irPerformsLogin: assert-only → false');

// caseOperatesOnLoginPage
ok(caseOperatesOnLoginPage(loginPageEvalIr), 'login-page: querySelector input[name=password] → true');
ok(caseOperatesOnLoginPage(negSubmitIr), 'login-page: fills credential + "is required" → true');
ok(!caseOperatesOnLoginPage(authContentIr), 'authenticated content (My Info/Apply Leave) → not login-page');
ok(!caseOperatesOnLoginPage(navAuthIr), 'navigate to admin URL + assert Dashboard → not login-page');

// journeyReferencesLogout
ok(journeyReferencesLogout([item(logoutIr)]), 'logout reference detected');
ok(!journeyReferencesLogout([item(authContentIr)]), 'no logout reference');

// journeyNeedsLoginPrecondition
ok(journeyNeedsLoginPrecondition([item(authContentIr)]), 'COMPOSE: assert-only authenticated content (ESS-sidebar/dashboard shape)');
ok(journeyNeedsLoginPrecondition([item(navAuthIr)]), 'COMPOSE: navigates to authed URL, no login (RBAC shape)');
ok(!journeyNeedsLoginPrecondition([item(loginIr)]), 'SKIP: journey already logs in');
ok(!journeyNeedsLoginPrecondition([item(loginPageEvalIr)]), 'SKIP: login-page field-existence test');
ok(!journeyNeedsLoginPrecondition([item(negSubmitIr)]), 'SKIP: negative submit-empty validation');
ok(!journeyNeedsLoginPrecondition([item(logoutIr)]), 'SKIP: logout journey (would invert premise)');

// extractLoginBlock — slices through the credential-submit click, drops post-login extras
{
  const block = extractLoginBlock(loginIr);
  ok(block && block.length === 7, `login block sliced to navigate..click (got ${block && block.length})`);
  ok(block && block[block.length-1].action === 'click', 'login block ends at the submit click');
  ok(block && !block.some(s => s.op === 'assert'), 'login block drops post-login assertions');
}

// deriveLoginPrecondition — picks the shortest login prefix across results
{
  const results = [ { envelope:{ ir: authContentIr } }, { envelope:{ ir: loginIr } } ];
  const pre = deriveLoginPrecondition(results);
  ok(pre && pre.steps.length === 7 && pre.loginUrl === 'https://x/auth/login', `derived precondition (steps=${pre&&pre.steps.length}, url=${pre&&pre.loginUrl})`);
  ok(!deriveLoginPrecondition([{ envelope:{ ir: authContentIr } }]), 'no login in run → null (cannot compose)');
}

// ── Logout teardown composition ─────────────────────────────────────────────
const postLogoutAssertIr = { steps: [ { op:'assert', channel:'EVALUATE', script:"!document.cookie.includes('orangehrm')", expected:'true' } ] };
const logoutNavIr = { steps: [ { op:'act', action:'navigate', url:'https://x/web/index.php/auth/logout' } ] };
{
  ok(deriveLogoutUrl([{ envelope:{ ir: logoutNavIr } }]) === 'https://x/web/index.php/auth/logout', 'deriveLogoutUrl finds the evidenced /logout endpoint');
  ok(deriveLogoutUrl([{ envelope:{ ir: authContentIr } }]) === null, 'no logout nav in run → null');
  ok(journeyPerformsLogout([item(logoutNavIr)]), 'journeyPerformsLogout: navigates to /logout → true');
  ok(!journeyPerformsLogout([item(postLogoutAssertIr)]), 'journeyPerformsLogout: bare post-logout assert → false');
  // stranded post-logout assert (references logout, no login, no logout action) → COMPOSE teardown
  ok(journeyNeedsLogoutPrecondition([item(postLogoutAssertIr, 'Session cookie is cleared after logout')]), 'COMPOSE teardown: stranded post-logout assert');
  // a journey that performs its own logout → no teardown needed
  ok(!journeyNeedsLogoutPrecondition([item(logoutNavIr, 'logout flow')]), 'SKIP teardown: journey performs its own logout');
  // a journey that logs in itself and logs out → no teardown
  ok(!journeyNeedsLogoutPrecondition([item({ steps:[...loginIr.steps, { op:'act', action:'navigate', url:'https://x/web/index.php/auth/logout' }] }, 'logout after login')]), 'SKIP teardown: journey logs in + out itself');
  // a non-logout authenticated journey is NOT a logout-precondition case
  ok(!journeyNeedsLogoutPrecondition([item(authContentIr)]), 'SKIP teardown: not a logout journey');
}

// ── Class B: Gap A — logout teardown unavailable → block condition ────────────
console.log('\n[Gap A] journeyNeedsLogoutButCant');
ok(typeof journeyNeedsLogoutButCant === 'function', 'journeyNeedsLogoutButCant exported');
{
  // A post-logout EVALUATE journey shape: references logout in case name, no act steps
  const cookieEvalIr = { steps: [{ op: 'assert', channel: 'EVALUATE', script: "!document.cookie.includes('session')", expected: 'true' }] };
  const cookieItem = (ir, n = 'Session cookie is cleared after logout') => ({ r: { envelope: { ir }, caseName: n, runResultId: 'rr', testCaseId: 'tc', scenarioId: 'sid' } });
  const mockLoginPrecondition = { steps: [{ op: 'act', action: 'navigate', url: 'https://x/auth/login' }] };

  ok(journeyNeedsLogoutButCant([cookieItem(cookieEvalIr)], { loginPrecondition: mockLoginPrecondition, logoutUrl: null }),
    'Gap A: logout teardown needed, logoutUrl=null → block condition met');
  ok(journeyNeedsLogoutButCant([cookieItem(cookieEvalIr)], { loginPrecondition: null, logoutUrl: 'https://x/logout' }),
    'Gap A: logout teardown needed, loginPrecondition=null → block condition met');
  ok(!journeyNeedsLogoutButCant([cookieItem(cookieEvalIr)], { loginPrecondition: mockLoginPrecondition, logoutUrl: 'https://x/logout' }),
    'Gap A: both ingredients present → compose (not block)');
  ok(!journeyNeedsLogoutButCant([item(authContentIr)], { loginPrecondition: mockLoginPrecondition, logoutUrl: null }),
    'Gap A: non-logout journey → not affected by this predicate');
}

// ── Class B: Gap B — irHasOnlyFormValidationAsserts ──────────────────────────
console.log('\n[Gap B] irHasOnlyFormValidationAsserts');
ok(typeof irHasOnlyFormValidationAsserts === 'function', 'irHasOnlyFormValidationAsserts exported');
{
  const evalOnlyIr = { steps: [{ op: 'assert', channel: 'EVALUATE', script: '!!document.querySelector(".err")', expected: 'true' }] };
  const validationTextIr = { steps: [{ op: 'assert', channel: 'UI_TEXT', expected: 'Required' }] };
  const appContentIr = { steps: [{ op: 'assert', channel: 'UI_TEXT', expected: 'My Info' }] };
  const mixedIr = { steps: [{ op: 'act', action: 'navigate', url: 'https://x' }, { op: 'assert', channel: 'EVALUATE', script: '1', expected: 'true' }] };

  ok(irHasOnlyFormValidationAsserts(evalOnlyIr), 'Gap B: EVALUATE-only IR → validation case');
  ok(irHasOnlyFormValidationAsserts(validationTextIr), 'Gap B: UI_TEXT "Required" → validation case');
  ok(!irHasOnlyFormValidationAsserts(appContentIr), 'Gap B: UI_TEXT "My Info" → app content, NOT validation');
  ok(!irHasOnlyFormValidationAsserts(loginIr), 'Gap B: login IR has act steps → NOT stranded');
  ok(!irHasOnlyFormValidationAsserts(mixedIr), 'Gap B: IR with navigate act → NOT validation-only');
  ok(!irHasOnlyFormValidationAsserts({ steps: [] }), 'Gap B: empty steps → false');
  ok(!irHasOnlyFormValidationAsserts(null), 'Gap B: null IR → false');
}

if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
console.log('\nverify_setup_chain_composition: all checks passed');
