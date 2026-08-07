'use strict';
/*
 * Guard for B-2c.5 — code-ready trace assembly (the B-2c -> Phase E bridge).
 * Proves certified actions become export-ready steps + a deduped locator
 * manifest; uncertified or locator-less actions are surfaced as warnings and
 * marked NOT export-ready (codegen fails closed, no narration inference); and
 * tracePreferred() switches codegen onto the trace (bypassing legacy recovery).
 * Records are built via the real Precision Action Kernel. SYNTHETIC, not live.
 */
const { buildPrecisionActionRecord } = require('../server/services/precisionActionKernel');
const { assembleCodeReadyTrace, tracePreferred, traceFullyExportReady } = require('../server/services/codeReadyTrace');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const LOGIN = 'https://x/web/index.php/auth/login';
const DASH = 'https://x/web/index.php/dashboard/index';
const SNAP_LOGIN = ['- form "LoginForm":', '  - textbox "Username" [ref=e3]', '  - textbox "Password" [ref=e5]', '  - button "Login" [ref=e7]'].join('\n');
const SNAP_DASH = ['- heading "Dashboard" [ref=e1]'].join('\n');
const loc = (name) => ({ strategy: 'role', expression: `getByRole('x',{name:'${name}'})` });

// certified fill (value readback) + certified click (navigation), both with locators.
const fillRec = buildPrecisionActionRecord({ approvedStep: { id: 's1', urlPattern: '/auth/login' }, toolName: 'browser_type', args: { ref: 'e3', text: 'Admin' }, targetLabel: 'Username', resolvedRef: 'e3', snapshotBefore: SNAP_LOGIN, snapshotAfter: SNAP_LOGIN.replace('[ref=e3]', '[ref=e3]: Admin'), urlBefore: LOGIN, urlAfter: LOGIN, locatorCandidate: loc('Username') });
const clickRec = buildPrecisionActionRecord({ approvedStep: { id: 's2', urlPattern: '/auth/login' }, toolName: 'browser_click', args: { ref: 'e7' }, targetLabel: 'Login', resolvedRef: 'e7', snapshotBefore: SNAP_LOGIN, snapshotAfter: SNAP_DASH, urlBefore: LOGIN, urlAfter: DASH, locatorCandidate: loc('Login') });

console.log('— clean case: certified actions -> export-ready steps + locator manifest, no warnings —');
{
  const t = assembleCodeReadyTrace([fillRec, clickRec]);
  ok('2 steps', t.total === 2, String(t.total));
  ok('both certified + export-ready', t.certifiedCount === 2 && t.exportReadyCount === 2, JSON.stringify({ c: t.certifiedCount, e: t.exportReadyCount }));
  ok('fill step carries value', t.steps[0].action === 'fill' && t.steps[0].value === 'Admin', JSON.stringify(t.steps[0]));
  ok('locator manifest has both targets', t.locatorManifest.length === 2 && t.locatorManifest.some((m) => m.name === 'Username') && t.locatorManifest.some((m) => m.name === 'Login'), JSON.stringify(t.locatorManifest));
  ok('no warnings', t.warnings.length === 0);
  ok('fully export-ready', traceFullyExportReady(t) === true);
  ok('tracePreferred true (codegen bypasses legacy recovery)', tracePreferred([fillRec, clickRec]) === true);
}

console.log('— uncertified action (no effect) -> warning, step not export-ready, kept out of manifest —');
{
  const noEffect = buildPrecisionActionRecord({ approvedStep: { id: 's3', urlPattern: '/auth/login' }, toolName: 'browser_click', args: { ref: 'e7' }, targetLabel: 'Login', resolvedRef: 'e7', snapshotBefore: SNAP_LOGIN, snapshotAfter: SNAP_LOGIN, urlBefore: LOGIN, urlAfter: LOGIN, locatorCandidate: loc('Login') });
  const t = assembleCodeReadyTrace([fillRec, noEffect]);
  ok('warning emitted for the uncertified action', t.warnings.some((w) => w.status === 'no_observable_effect'), JSON.stringify(t.warnings));
  ok('uncertified step not export-ready', t.steps[1].exportReady === false && t.steps[1].certified === false);
  ok('uncertified target NOT in manifest', !t.locatorManifest.some((m) => m.name === 'Login'), JSON.stringify(t.locatorManifest));
  ok('not fully export-ready', traceFullyExportReady(t) === false);
}

console.log('— certified action with NO locator -> codegen gap warning, not export-ready —');
{
  const noLoc = buildPrecisionActionRecord({ approvedStep: { id: 's4', urlPattern: '/auth/login' }, toolName: 'browser_click', args: { ref: 'e7' }, targetLabel: 'Login', resolvedRef: 'e7', snapshotBefore: SNAP_LOGIN, snapshotAfter: SNAP_DASH, urlBefore: LOGIN, urlAfter: DASH, locatorCandidate: null });
  const t = assembleCodeReadyTrace([noLoc]);
  ok('certified but no-locator -> warning certified_no_locator', t.warnings.some((w) => w.status === 'certified_no_locator'), JSON.stringify(t.warnings));
  ok('step certified but NOT export-ready', t.steps[0].certified === true && t.steps[0].exportReady === false);
  ok('no narration-based locator invented (manifest empty)', t.locatorManifest.length === 0);
}

console.log('— tracePreferred false when no precision records / none export-ready —');
{
  ok('empty -> not preferred (legacy path runs)', tracePreferred([]) === false);
  const noLoc = buildPrecisionActionRecord({ approvedStep: { id: 's5' }, toolName: 'browser_click', args: { ref: 'e7' }, targetLabel: 'Login', resolvedRef: 'e7', snapshotBefore: SNAP_LOGIN, snapshotAfter: SNAP_DASH, urlBefore: LOGIN, urlAfter: DASH, locatorCandidate: null });
  ok('records exist but none have a locator -> not preferred', tracePreferred([noLoc]) === false);
}

console.log('— candidate-only record (unproven locator in candidateLocator, .locator null) -> locator_unproven, not export-ready —');
{
  // Shape produced by the precision path for an UNPROVEN forged candidate.
  const candRec = {
    approvedStepId: 's-cand',
    certification: { certified: true, status: 'certified' },
    codeReadyIntent: { action: 'click', target: { role: 'button', name: 'X', locator: null, candidateLocator: { tier: 'gold', strategy: 'role', expression: "getByRole('button', { name: 'X' })", proven: false } } },
  };
  const t = assembleCodeReadyTrace([candRec]);
  ok('warning status locator_unproven', t.warnings.some((w) => w.status === 'locator_unproven'), JSON.stringify(t.warnings));
  ok('exportReadyCount === 0', t.exportReadyCount === 0, String(t.exportReadyCount));
  ok('tracePreferred === false', tracePreferred([candRec]) === false);
}

console.log('— proven + candidate partial trace -> total 2, exportReady 1, NOT preferred —');
{
  const provenRec = {
    approvedStepId: 's-proven',
    certification: { certified: true, status: 'certified' },
    codeReadyIntent: { action: 'click', target: { role: 'button', name: 'Y', locator: { tier: 'gold', strategy: 'role', expression: "getByRole('button', { name: 'Y' })", proven: true }, candidateLocator: null } },
  };
  const candRec = {
    approvedStepId: 's-cand',
    certification: { certified: true, status: 'certified' },
    codeReadyIntent: { action: 'click', target: { role: 'button', name: 'X', locator: null, candidateLocator: { tier: 'gold', strategy: 'role', expression: "getByRole('button', { name: 'X' })", proven: false } } },
  };
  const t = assembleCodeReadyTrace([provenRec, candRec]);
  ok('total === 2', t.total === 2, String(t.total));
  ok('exportReadyCount === 1 (only the proven step)', t.exportReadyCount === 1, String(t.exportReadyCount));
  ok('tracePreferred === false (no partial bypass)', tracePreferred([provenRec, candRec]) === false);
  ok('all-proven trace IS preferred', tracePreferred([provenRec]) === true);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — code-ready trace assembly verified (SYNTHETIC; consumed by Phase E, gated bypass of legacy recovery at B-2d)');
