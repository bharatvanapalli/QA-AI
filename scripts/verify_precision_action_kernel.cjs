'use strict';
/*
 * Guard for B-2c.1 — Precision Action Kernel (the one atomic action-time capture).
 * Proves the record ties step+page+target+ref+role+locator+effect+code-ready
 * intent together, and certifies honestly: static-role targets, no-effect actions,
 * unresolved targets, and wrong-page actions are all surfaced (not silently "done").
 * SYNTHETIC accessibility-tree fixtures — not live proof.
 */
const { buildPrecisionActionRecord, classifyEffect } = require('../server/services/precisionActionKernel');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const LOGIN = 'https://x/web/index.php/auth/login';
const DASH = 'https://x/web/index.php/dashboard/index';
const SNAP_LOGIN = ['- form "LoginForm":', '  - textbox "Username" [ref=e3]', '  - textbox "Password" [ref=e5]', '  - button "Login" [ref=e7]', '  - heading "Login" [ref=e9]'].join('\n');
const SNAP_DASH = ['- heading "Dashboard" [ref=e1]', '- navigation "Sidepanel" [ref=e2]'].join('\n');

console.log('— certified click: button target + navigation effect -> certified + code-ready intent —');
{
  const r = buildPrecisionActionRecord({
    approvedStep: { id: 'S1C1-step3', intent: 'click Login', urlPattern: '/auth/login' },
    toolName: 'browser_click', args: { ref: 'e7' }, targetLabel: 'Login', resolvedRef: 'e7',
    snapshotBefore: SNAP_LOGIN, snapshotAfter: SNAP_DASH, urlBefore: LOGIN, urlAfter: DASH,
    locatorCandidate: { strategy: 'role', expression: "getByRole('button',{name:'Login'})" },
  });
  ok('status certified', r.certification.status === 'certified', r.certification.status);
  ok('target role=button, interactive', r.target.role === 'button' && r.target.interactive === true, JSON.stringify(r.target));
  ok('effect navigated', r.effect.kind === 'navigated' && r.effect.observed === true, JSON.stringify(r.effect));
  ok('code-ready intent click+locator', r.codeReadyIntent.action === 'click' && !!r.codeReadyIntent.target.locator, JSON.stringify(r.codeReadyIntent));
  ok('bound to approved step', r.approvedStepId === 'S1C1-step3');
  ok('pageMatchesStep true', r.certification.pageMatchesStep === true);
}

console.log('\n— certified fill: textbox target + dom change -> code-ready fill intent with value —');
{
  const after = SNAP_LOGIN.replace('[ref=e3]', '[ref=e3]: Admin');
  const r = buildPrecisionActionRecord({
    approvedStep: { id: 's', urlPattern: '/auth/login' },
    toolName: 'browser_type', args: { ref: 'e3', text: 'Admin' }, targetLabel: 'Username', resolvedRef: 'e3',
    snapshotBefore: SNAP_LOGIN, snapshotAfter: after, urlBefore: LOGIN, urlAfter: LOGIN,
  });
  ok('status certified', r.certification.status === 'certified', r.certification.status);
  ok('target textbox interactive', r.target.role === 'textbox' && r.target.interactive, JSON.stringify(r.target));
  ok('effect dom_changed', r.effect.kind === 'dom_changed');
  ok('code-ready fill intent carries value', r.codeReadyIntent.action === 'fill' && r.codeReadyIntent.value === 'Admin', JSON.stringify(r.codeReadyIntent));
}

console.log('\n— STATIC-role target (the wrong-nearby-click) -> flagged target_static_role, NOT certified —');
{
  const r = buildPrecisionActionRecord({
    approvedStep: { id: 's' }, toolName: 'browser_click', args: { ref: 'e9' }, targetLabel: 'Login', resolvedRef: 'e9', // e9 is the heading
    snapshotBefore: SNAP_LOGIN, snapshotAfter: SNAP_DASH, urlBefore: LOGIN, urlAfter: DASH,
  });
  ok('target role heading, isStatic', r.target.role === 'heading' && r.target.isStatic === true, JSON.stringify(r.target));
  ok('status target_static_role (not certified)', r.certification.status === 'target_static_role' && r.certification.certified === false, r.certification.status);
}

console.log('\n— NO observable effect -> no_observable_effect (action not silently "done") —');
{
  const r = buildPrecisionActionRecord({
    approvedStep: { id: 's' }, toolName: 'browser_click', args: { ref: 'e7' }, targetLabel: 'Login', resolvedRef: 'e7',
    snapshotBefore: SNAP_LOGIN, snapshotAfter: SNAP_LOGIN, urlBefore: LOGIN, urlAfter: LOGIN, // nothing changed
  });
  ok('status no_observable_effect', r.certification.status === 'no_observable_effect', r.certification.status);
  ok('effect.observed false', r.effect.observed === false);
}

console.log('\n— unresolved target -> target_unresolved; wrong page -> wrong_page_for_step —');
{
  const noRef = buildPrecisionActionRecord({ approvedStep: { id: 's', urlPattern: '/auth/login' }, toolName: 'browser_click', args: {}, targetLabel: 'Login', resolvedRef: null, snapshotBefore: SNAP_LOGIN, snapshotAfter: SNAP_DASH, urlBefore: LOGIN, urlAfter: DASH });
  ok('no ref -> target_unresolved', noRef.certification.status === 'target_unresolved', noRef.certification.status);
  const wrongPage = buildPrecisionActionRecord({ approvedStep: { id: 's', urlPattern: '/auth/login' }, toolName: 'browser_click', args: { ref: 'e2' }, targetLabel: 'Sidepanel', resolvedRef: 'e2', snapshotBefore: SNAP_DASH, snapshotAfter: SNAP_DASH, urlBefore: DASH, urlAfter: DASH });
  ok('on dashboard when step expects login -> wrong_page_for_step', wrongPage.certification.status === 'wrong_page_for_step', wrongPage.certification.status);
}

console.log('\n— effect classifier edge: no post observation -> unknown (not "no_effect") —');
{
  const e = classifyEffect({ urlBefore: LOGIN, urlAfter: null, snapshotBefore: SNAP_LOGIN, snapshotAfter: null });
  ok('unknown when nothing captured after', e.kind === 'unknown' && e.observed === false, JSON.stringify(e));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — Precision Action Kernel verified (SYNTHETIC fixtures; live capture wired at B-2d, proven at B-2e)');
