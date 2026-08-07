'use strict';
/*
 * GUARD: ExecutionReadinessCompiler — the START-STATE contract.
 *
 * Proves (synthetic, generic data — no site strings, no DB):
 *   1. a positive login case is harvested as the login template (not a negative one);
 *   2. a case that operates on authenticated UI but does NOT self-authenticate gets the
 *      compiled login prelude PREPENDED + a credential source attached so its tokens
 *      resolve;
 *   3. a self-authenticating case (login / negative-login) is left untouched;
 *   4. a case that needs auth but has NO login template is NOT executable → dropped
 *      (never fabricate auth);
 *   5. the repair is IDEMPOTENT (an injected case then self-authenticates → no re-inject);
 *   6. a public/no-auth case needs no setup.
 */
const path = require('path');
const erc = require(path.join(__dirname, '..', 'server', 'services', 'executionReadinessCompiler.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('PASS ' + m); pass++; } else { console.log('FAIL ' + m); fail++; } };

const loginSteps = () => ([
  { order: 1, action: 'Navigate', target: 'login page', value: 'http://app/login' },
  { order: 2, action: 'Fill', target: 'Username field', value: '{{username}}' },
  { order: 3, action: 'Fill', target: 'Password field', value: '{{loginpassword}}' },
  { order: 4, action: 'Click', target: 'Login button' },
  { order: 5, action: 'Verify', target: 'Dashboard heading' },
]);

const mkScenarios = () => ([
  {
    id: 'S-auth', cases: [{
      id: 'c-login', name: 'Login with ADMIN_DEFAULT and verify dashboard', module: 'Authentication',
      steps: JSON.stringify(loginSteps()),
      dataBinding: { sheet: 'Feature', columnToField: { role: 'profileKey' }, companions: [{ sheet: 'Profiles', columnToField: { username: 'loginUsername', loginpassword: 'loginPassword' }, source: 'credential_companion' }] },
    }, {
      id: 'c-neg', name: 'Invalid credentials are rejected', module: 'Authentication',
      steps: JSON.stringify([
        { order: 1, action: 'Navigate', target: 'login page', value: 'http://app/login' },
        { order: 2, action: 'Fill', target: 'Username field', value: 'wrong' },
        { order: 3, action: 'Fill', target: 'Password field', value: 'wrong' },
        { order: 4, action: 'Click', target: 'Login button' },
      ]),
      dataBinding: null,
    }],
  },
  {
    id: 'S-nav', cases: [{
      id: 'c-nav', name: 'Per-menu-item navigation reaches expected page', module: 'Navigation',
      steps: JSON.stringify([
        { order: 1, action: 'Click', target: 'Left-menu link', value: '{{menulabel}}' },
        { order: 2, action: 'Verify', target: 'Module page signal' },
      ]),
      dataBinding: { sheet: 'Menu_Navigation', columnToField: { role: 'profileKey', menulabel: 'menuLabel' } },
    }],
  },
]);

// ── harvest ──────────────────────────────────────────────────────────────────
const tmpl = erc.harvestLoginTemplate(mkScenarios());
ok(tmpl && /ADMIN_DEFAULT/.test(tmpl.sourceCase || ''), `harvests the POSITIVE login case as template (${tmpl && tmpl.sourceCase})`);
ok(tmpl && tmpl.prelude.length === 4, `login prelude is the 4 login steps, excludes the post-login Verify (${tmpl && tmpl.prelude.length})`);
ok(tmpl && tmpl.companion && /profiles/i.test(tmpl.companion.sheet || ''), `template carries the credential companion (${tmpl && tmpl.companion && tmpl.companion.sheet})`);

// ── compile ──────────────────────────────────────────────────────────────────
const scns = mkScenarios();
const { report, scenarios } = erc.compileExecutionReadiness({ scenarios: scns });
ok(report.injected === 1, `exactly the 1 authenticated-no-setup case got login injected (${report.injected})`);
ok(report.selfAuth + report.noSetupNeeded === 2, `both login cases left un-injected (selfAuth=${report.selfAuth} + noSetupNeeded=${report.noSetupNeeded})`);
ok(report.dropped.length === 0, `nothing dropped when a login template exists (${report.dropped.length})`);
const negCase = scenarios.flatMap((s) => s.cases).find((c) => c.id === 'c-neg');
ok(negCase && JSON.parse(negCase.steps).length === 4, `negative-login case is untouched (still 4 steps, no prelude injected)`);

const nav = scenarios.flatMap((s) => s.cases).find((c) => c.id === 'c-nav');
const navSteps = JSON.parse(nav.steps);
ok(navSteps.length === 6, `nav case now has 4 login + 2 original steps (${navSteps.length})`);
ok(/password/i.test(`${navSteps[2].target}`) && /fill/i.test(navSteps[2].action), `login prelude is at the FRONT of the nav case`);
ok(/left-menu/i.test(`${navSteps[4].target}`), `the original functional action follows the prelude`);
ok(Array.isArray(nav.dataBinding.companions) && nav.dataBinding.companions.some((c) => /profiles/i.test(c.sheet)), `credential companion attached so injected {{username}}/{{loginpassword}} resolve`);
ok(nav._execReadiness === 'login_setup_injected', `nav case stamped _execReadiness=login_setup_injected`);

// ── idempotency ────────────────────────────────────────────────────────────────
const second = erc.compileExecutionReadiness({ scenarios });
ok(second.report.injected === 0, `re-running does NOT double-inject (injected=${second.report.injected})`);
const nav2 = second.scenarios.flatMap((s) => s.cases).find((c) => c.id === 'c-nav');
ok(JSON.parse(nav2.steps).length === 6, `nav case step count stable after a second compile (${JSON.parse(nav2.steps).length})`);

// ── no login template → authenticated case is NOT executable (dropped) ─────────
const scnsNoLogin = [mkScenarios()[1]]; // only the nav scenario, no login case anywhere
const noTmpl = erc.compileExecutionReadiness({ scenarios: scnsNoLogin, loginTemplate: null });
ok(noTmpl.report.dropped.length === 1 && /no_login_template/.test(noTmpl.report.dropped[0].reason), `authenticated case with NO login template is dropped as not-executable (${JSON.stringify(noTmpl.report.dropped)})`);
ok(noTmpl.scenarios.reduce((a, s) => a + s.cases.length, 0) === 0, `no un-executable case is kept`);

// ── public/no-auth case needs no setup ─────────────────────────────────────────
const pub = [{ id: 'S-pub', cases: [{ id: 'c-pub', name: 'Open public marketing page', module: 'public', steps: JSON.stringify([{ order: 1, action: 'Navigate', target: 'home', value: 'http://app/' }, { order: 2, action: 'Verify', target: 'hero banner' }]), dataBinding: null }] }];
const pubRes = erc.compileExecutionReadiness({ scenarios: pub });
ok(pubRes.report.injected === 0 && pubRes.report.dropped.length === 0, `a public/no-auth case needs no login setup and is not dropped`);

// ── stripLoginPrelude (#2 "login once per profile" primitive) ──────────────────
const injectedNav = JSON.parse(nav.steps); // 4 login steps + 2 functional
const strippedNav = erc.stripLoginPrelude(injectedNav);
ok(strippedNav.length === 2, `stripLoginPrelude removes the 4-step login prelude, leaves the 2 functional steps (${strippedNav.length})`);
ok(/left-menu/i.test(`${strippedNav[0].target}`), `stripped case now STARTS at the functional action (${strippedNav[0].target})`);
ok(!strippedNav.some((s) => /password/i.test(`${s.target}`)), `no credential step remains after strip`);

const funcOnly = [{ order: 1, action: 'Click', target: 'Save button' }, { order: 2, action: 'Verify', target: 'toast' }];
ok(erc.stripLoginPrelude(funcOnly).length === 2, `a case that does NOT start with login is returned unchanged (no false strip)`);

const loginOnly = loginSteps().slice(0, 4); // navigate+user+pass+click, nothing after
const strippedLoginOnly = erc.stripLoginPrelude(loginOnly);
ok(strippedLoginOnly.length === 4, `stripLoginPrelude never strips to nothing (login-only case keeps its steps: ${strippedLoginOnly.length})`);

console.log('───────────────────────────────────────────────');
if (fail) { console.log(`RESULT: RED — ${fail} failed, ${pass} passed.`); process.exit(1); }
console.log(`RESULT: GREEN — ${pass} assertions passed (execution-readiness start-state contract).`);
