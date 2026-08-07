'use strict';
/*
 * Guard for B-2d — Conductor Precision Bridge (the single flag-gated integration
 * surface). Proves the HARD SAFETY CONTRACT: flag OFF -> every hook returns null
 * (conductor falls through to current behavior); flag ON -> hooks compose the
 * proven pieces correctly. SYNTHETIC observers; live proof at B-2e.
 */
const bridge = require('../server/services/conductorPrecisionBridge');
const { buildRowEvidenceContract } = require('../server/services/testDataMatrix');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const setFlag = (v) => { if (v == null) delete process.env.QAAI_CERTIFIED_ACTION_TARGETS; else process.env.QAAI_CERTIFIED_ACTION_TARGETS = v; };
const prev = process.env.QAAI_CERTIFIED_ACTION_TARGETS;

const LOGIN = 'https://x/web/index.php/auth/login';
const DASH = 'https://x/web/index.php/dashboard/index';
const SNAP_LOGIN = ['- form "LoginForm":', '  - textbox "Username" [ref=e3]', '  - button "Login" [ref=e7]'].join('\n');

(async () => {
  console.log('— FLAG OFF: every hook is a passthrough (null) so the conductor keeps current behavior —');
  {
    setFlag('');
    ok('enabled() false', bridge.enabled() === false);
    ok('planStart -> null', bridge.planStart({ currentUrl: DASH, establishesSession: true, requiredEntryPattern: 'auth/login' }) === null);
    ok('resolveTarget -> null', bridge.resolveTarget({ snapshotBefore: SNAP_LOGIN, intendedLabel: 'Login', toolName: 'browser_click' }) === null);
    ok('captureAction -> null', bridge.captureAction({ toolName: 'browser_click', resolvedRef: 'e7', snapshotBefore: SNAP_LOGIN, urlBefore: LOGIN }) === null);
    ok('caseTrace -> null', bridge.caseTrace([]) === null);
    ok('judgeRow -> null', (await bridge.judgeRow({ requiredEvidence: [], observer: { snapshot: async () => ({}) } })) === null);
  }

  console.log('\n— FLAG ON: hooks activate and compose the proven pieces —');
  {
    setFlag('1');
    ok('enabled() true', bridge.enabled() === true);

    // Hook 1 — case start
    const plan = bridge.planStart({ currentUrl: DASH, establishesSession: true, requiredEntryPattern: 'auth/login' });
    ok('planStart returns a reset+navigate plan', plan && plan.needsSessionReset === true && plan.actions.some((a) => a.type === 'navigate'), JSON.stringify(plan && plan.actions.map((a) => a.type)));

    // Hook 2 — certified resolve (model label, no ref)
    const res = bridge.resolveTarget({ snapshotBefore: SNAP_LOGIN, intendedLabel: 'Login', toolName: 'browser_click' });
    ok('resolveTarget certified -> ref e7', res && res.ref === 'e7', JSON.stringify(res));

    // Hook 3 — memory re-certification path
    const recert = bridge.resolveTarget({ snapshotBefore: SNAP_LOGIN, intendedLabel: 'Login', toolName: 'browser_click', rememberedRef: 'e7' });
    ok('resolveTarget(remembered) -> reuse e7', recert && recert.decision === 'reuse' && recert.ref === 'e7', JSON.stringify(recert));

    // Hook 5/6 — capture record with post-action effect + interaction protocol
    const rec = bridge.captureAction({ approvedStep: { id: 's1', urlPattern: '/auth/login' }, toolName: 'browser_click', args: { ref: 'e7' }, targetLabel: 'Login', resolvedRef: 'e7', snapshotBefore: SNAP_LOGIN, snapshotAfter: '- heading "Dashboard" [ref=e1]', urlBefore: LOGIN, urlAfter: DASH, locatorCandidate: { strategy: 'role', expression: "getByRole('button',{name:'Login'})" } });
    ok('captureAction -> certified record w/ codeReadyIntent', rec && rec.certification.certified === true && rec.codeReadyIntent.action === 'click', JSON.stringify(rec && rec.certification));
    ok('record carries interaction protocol classification', rec && rec.interaction && rec.interaction.protocol === 'command', JSON.stringify(rec && rec.interaction));

    // Vision-DOM fusion via captureAction: atlas candidates -> selected mark +
    // Gold locator from the mark's cascade evidence (markId/box stay telemetry).
    const recVision = bridge.captureAction({
      approvedStep: { id: 's2', urlPattern: '/auth/login' }, toolName: 'browser_click', args: { ref: 'e7' },
      targetLabel: 'Login', targetRole: 'button', resolvedRef: 'e7',
      snapshotBefore: SNAP_LOGIN, snapshotAfter: '- heading "Dashboard" [ref=e1]', urlBefore: LOGIN, urlAfter: DASH,
      atlasEntries: [{ role: 'button', name: 'Login', idAttr: 'loginBtn', bbox: { x: 1, y: 1, w: 9, h: 9 } }, { role: 'button', name: 'Cancel', bbox: { x: 50, y: 1, w: 9, h: 9 } }],
    });
    ok('vision fusion attaches markId for the selected target', recVision && recVision.visualTelemetry && recVision.visualTelemetry.markId === 'm1', JSON.stringify(recVision && recVision.visualTelemetry && recVision.visualTelemetry.markId));
    // STRUCTURAL no-leak: an unproven candidate NEVER lands in .locator — it goes
    // to .candidateLocator (diagnostic) and .locator stays null so a direct
    // exporter fails closed instead of shipping an unproven locator.
    ok('candidate: codeReadyIntent.target.locator is NULL (no unproven leak)', recVision.codeReadyIntent.target.locator === null, JSON.stringify(recVision.codeReadyIntent.target.locator));
    ok('candidate forged into .candidateLocator (gold getByRole, not a coordinate)', recVision.codeReadyIntent.target.candidateLocator && /getByRole|getByTestId/.test(recVision.codeReadyIntent.target.candidateLocator.expression) && !/bbox|coordinate|m1/i.test(recVision.codeReadyIntent.target.candidateLocator.expression) && recVision.codeReadyIntent.target.candidateLocator.proven === false, JSON.stringify(recVision.codeReadyIntent.target.candidateLocator));
    ok('captureAction attaches a CandidateLocatorPassport', recVision.candidatePassport && recVision.candidatePassport.kind === 'CandidateLocatorPassport' && !!recVision.candidatePassport.primary, JSON.stringify(recVision.locatorPromotionStatus));
    ok('bronzeRepairRequired false when forgeable', recVision.bronzeRepairRequired === false);
    const recProven = bridge.captureAction({ approvedStep: { id: 'sp' }, toolName: 'browser_click', args: { ref: 'e7' }, targetLabel: 'Login', targetRole: 'button', resolvedRef: 'e7', snapshotBefore: SNAP_LOGIN, snapshotAfter: '- heading "Dashboard" [ref=e1]', urlBefore: LOGIN, urlAfter: DASH, provenLocatorPassport: { kind: 'ProvenLocatorPassport', proven: true, primary: { tier: 'gold', strategy: 'role', expression: "getByRole('button', { name: 'Login' })", build: [['getByRole', 'button', { name: 'Login' }]] }, alternates: [] } });
    ok('proven: .locator populated (proven:true), .candidateLocator null, status proven', recProven.codeReadyIntent.target.locator && recProven.codeReadyIntent.target.locator.proven === true && recProven.codeReadyIntent.target.candidateLocator === null && recProven.locatorPromotionStatus === 'proven', JSON.stringify({ l: recProven.codeReadyIntent.target.locator, s: recProven.locatorPromotionStatus }));

    // Hook 7 — judge from live page-state (certified evidence present -> works)
    const contract = buildRowEvidenceContract({ index: 0, setName: 'S', sheet: 'S', inputs: { username: '', password: 'admin123' }, raw: {}, expected: null, rowClass: null, rowClassColumn: null, expectedColumn: null, label: 'r' });
    const observer = {
      async snapshot() { return { snapshotText: ['- form:', '  - textbox "Username" [ref=e3]', '  - text: Required'].join('\n'), url: LOGIN, settled: true }; },
      async domProbe() { return { inspectedSources: ['aria_describedby', 'dom_error_containers'], fieldErrors: [{ fieldRole: 'username', text: 'Required' }], pageErrors: [] }; },
    };
    const judged = await bridge.judgeRow({ requiredEvidence: contract.requiredEvidence, observer, patterns: { entryUrlPattern: 'auth/login', authedUrlPattern: 'dashboard' } });
    ok('judgeRow -> works/pass from live-captured evidence', judged && judged.verdict === 'works' && judged.runStatus.status === 'pass', JSON.stringify(judged && { v: judged.verdict, s: judged.runStatus.status }));

    // honest capture failure -> not_judged/blocked (not a bug, not a pass)
    const observerFail = { async snapshot() { return { snapshotText: ['- form:', '  - textbox "Username" [ref=e3]'].join('\n'), url: LOGIN, settled: false }; } };
    const judgedFail = await bridge.judgeRow({ requiredEvidence: contract.requiredEvidence, observer: observerFail, patterns: { entryUrlPattern: 'auth/login', authedUrlPattern: 'dashboard' }, maxRounds: 2 });
    ok('judgeRow capture-failure -> not_judged/blocked (no fake bug/pass)', judgedFail && judgedFail.verdict === 'not_judged' && judgedFail.runStatus.status === 'blocked', JSON.stringify(judgedFail && { v: judgedFail.verdict, s: judgedFail.runStatus.status }));

    // Hook 8 — case trace. A candidate (unproven) locator is NOT export-ready, so
    // the trace is NOT preferred until proven (no partial/unproven export).
    const ctCandidate = bridge.caseTrace([rec]);
    ok('caseTrace NOT preferred while locator is an unproven candidate', ctCandidate && ctCandidate.preferred === false && ctCandidate.trace.exportReadyCount === 0, JSON.stringify(ctCandidate && { p: ctCandidate.preferred, e: ctCandidate.trace.exportReadyCount }));
    const ctProven = bridge.caseTrace([recProven]);
    ok('caseTrace prefers the trace once the locator is PROVEN', ctProven && ctProven.preferred === true && ctProven.trace.exportReadyCount === 1, JSON.stringify(ctProven && { p: ctProven.preferred, e: ctProven.trace.exportReadyCount }));
    // Partial trace (one proven action + one unproven candidate) must NOT be
    // preferred — no partial legacy-bypass; promotion/repair continues first.
    const ctPartial = bridge.caseTrace([recProven, recVision]);
    ok('partial trace (proven + candidate) NOT preferred', ctPartial && ctPartial.preferred === false && ctPartial.trace.exportReadyCount === 1 && ctPartial.trace.total === 2, JSON.stringify(ctPartial && { p: ctPartial.preferred, e: ctPartial.trace.exportReadyCount, t: ctPartial.trace.total }));
  }

  setFlag(prev);
  console.log('');
  if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
  console.log('OK — conductor precision bridge verified (flag-gated; SYNTHETIC observers; live hooks wired into conductor.js + proven at B-2e)');
})();
