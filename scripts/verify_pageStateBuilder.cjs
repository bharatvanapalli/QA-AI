'use strict';
/*
 * Guard for Phase B-2a — pageStateBuilder certified channels.
 *
 * ⚠ FIXTURES ARE SYNTHETIC / FORMAT-FAITHFUL, NOT LIVE PROOF. The snapshot
 * strings below are hand-authored to match the @playwright/mcp accessibility-tree
 * line shape (`- role "name" [ref=eN]`, `- text: …`, `- alert: …`). They prove
 * the builder's LOGIC (scoping, certification, no-final-null). Real-OrangeHRM
 * fidelity is proven later by the B-2e live capture, not here.
 */
const { buildPageState, toCheckerPageState, toCertifiedCheckerPageState, certificationReport, STATUS } = require('../server/services/pageStateBuilder');
const { judgeRowEvidence } = require('../server/services/evidenceCheckers');
const { buildRowEvidenceContract } = require('../server/services/testDataMatrix');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const mkRow = (inputs) => ({ index: 0, setName: 'AuthProfiles', sheet: 'AuthProfiles', inputs, raw: { ...inputs }, expected: null, rowClass: null, expectedColumn: null, rowClassColumn: null, label: 'row' });
const URL_LOGIN = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';

// format-faithful accessibility-tree fixtures
const SNAP_EMPTY_USERNAME = [
  '- document:',
  '  - form "LoginForm":',
  '    - textbox "Username" [ref=e3]',
  '    - text: Required',
  '    - textbox "Password" [ref=e5]',
  '    - button "Login" [ref=e7]',
].join('\n');
const SNAP_EMPTY_PASSWORD = [
  '- form "LoginForm":',
  '  - textbox "Username" [ref=e3]',
  '  - textbox "Password" [ref=e5]',
  '  - text: Required',
  '  - button "Login" [ref=e7]',
].join('\n');
const SNAP_BOTH_EMPTY = [
  '- form "LoginForm":',
  '  - textbox "Username" [ref=e3]',
  '  - text: Required',
  '  - textbox "Password" [ref=e5]',
  '  - text: Required',
  '  - button "Login" [ref=e7]',
].join('\n');
const SNAP_INVALID_CREDS = [
  '- alert: Invalid credentials',
  '- form "LoginForm":',
  '  - textbox "Username" [ref=e3]: baduser',
  '  - textbox "Password" [ref=e5]',
  '  - button "Login" [ref=e7]',
].join('\n');
const SNAP_CLEAN = [
  '- form "LoginForm":',
  '  - textbox "Username" [ref=e3]',
  '  - textbox "Password" [ref=e5]',
  '  - button "Login" [ref=e7]',
].join('\n');

console.log('— (1) present field error carries certification + correct scope —');
{
  const ps = buildPageState({ snapshotText: SNAP_EMPTY_USERNAME, url: URL_LOGIN });
  const fe = ps.channels.fieldErrors;
  ok('fieldErrors status present', fe.status === STATUS.PRESENT, fe.status);
  ok('scoped to username (not password)', fe.items.length === 1 && fe.items[0].fieldRole === 'username' && fe.items[0].messageClass === 'required', JSON.stringify(fe.items));
  ok('certification has non-empty inspectedSources', Array.isArray(fe.certification.inspectedSources) && fe.certification.inspectedSources.length > 0, JSON.stringify(fe.certification));
  ok('confidence present', !!fe.certification.confidence, fe.certification.confidence);
}

console.log('\n— (1b) end-to-end: present evidence -> judgeRowEvidence -> works/pass (synthetic) —');
{
  const ps = buildPageState({ snapshotText: SNAP_EMPTY_USERNAME, url: URL_LOGIN });
  const checkerPs = toCheckerPageState(ps, { entryUrlPattern: 'auth/login', authedUrlPattern: 'dashboard' });
  const contract = buildRowEvidenceContract(mkRow({ username: '', password: 'admin123' }));
  const res = judgeRowEvidence(contract, checkerPs);
  ok('verdict works (field error observed + on entry + dest absent)', res.verdict === 'works', `${res.verdict}/${res.reason}`);
}

console.log('\n— (2) inspected_empty requires inspected absence sources —');
{
  // DOM channel inspected the authoritative absence sources and found nothing.
  const ps = buildPageState({ snapshotText: SNAP_CLEAN, url: URL_LOGIN, domFacts: { inspectedSources: ['aria_describedby', 'dom_error_containers'], fieldErrors: [], pageErrors: [] } });
  const fe = ps.channels.fieldErrors;
  ok('fieldErrors inspected_empty', fe.status === STATUS.EMPTY, fe.status);
  ok('inspectedSources non-empty + includes dom_error_containers', fe.certification.inspectedSources.includes('dom_error_containers'), JSON.stringify(fe.certification.inspectedSources));
  // pageErrors: a11y is authoritative for visible alerts -> clean page certifies empty from snapshot alone.
  ok('pageErrors inspected_empty from a11y alone', ps.channels.pageErrors.status === STATUS.EMPTY, ps.channels.pageErrors.status);
}

console.log('\n— (3) snapshot-only absence is NOT faked empty; it is needs_acquisition w/ nextActions —');
{
  const ps = buildPageState({ snapshotText: SNAP_CLEAN, url: URL_LOGIN });
  const fe = ps.channels.fieldErrors;
  ok('fieldErrors needs_acquisition (cannot certify absent from a11y alone)', fe.status === STATUS.PENDING, fe.status);
  ok('missingSources lists the DOM absence sources', fe.certification.missingSources.includes('aria_describedby') || fe.certification.missingSources.includes('dom_error_containers'), JSON.stringify(fe.certification.missingSources));
  ok('nextActions populated (how to acquire)', fe.certification.nextActions.length > 0, JSON.stringify(fe.certification.nextActions));
}

console.log('\n— (3b) NO FINAL NULL: empty input -> all-pending certified pageState (never null) —');
{
  const empty = buildPageState({});
  ok('empty input is NOT null', empty !== null && !!empty.channels);
  const allChannels = Object.values(empty.channels);
  ok('every channel is needs_acquisition', allChannels.every((c) => c.status === STATUS.PENDING), JSON.stringify(Object.entries(empty.channels).map(([k, c]) => `${k}:${c.status}`)));
  ok('every pending channel carries missingSources + nextActions', allChannels.every((c) => c.certification.missingSources.length > 0 && c.certification.nextActions.length > 0), 'a channel lacked missingSources/nextActions');
  ok('builder no longer exposes raw top-level null scalars', !('url' in empty) && !('snapshotText' in empty), JSON.stringify(Object.keys(empty)));

  const ps = buildPageState({ url: URL_LOGIN });
  ok('url present', ps.channels.url.status === STATUS.PRESENT, ps.channels.url.status);
  ok('fieldErrors needs_acquisition (no snapshot)', ps.channels.fieldErrors.status === STATUS.PENDING, ps.channels.fieldErrors.status);
  ok('snapshotText needs_acquisition with nextActions', ps.channels.snapshotText.status === STATUS.PENDING && ps.channels.snapshotText.certification.nextActions.length > 0);
}

console.log('\n— (4) needs_acquisition is NOT accepted as final evidence (certification gate) —');
{
  const reqV = [{ kind: 'page_present', page: 'entry' }, { kind: 'field_error', fieldRole: 'username', messageClass: 'required' }];
  const pending = buildPageState({ snapshotText: SNAP_CLEAN, url: URL_LOGIN });
  const rep = certificationReport(pending, reqV);
  ok('certified=false when a required channel is pending', rep.certified === false, JSON.stringify(rep));
  ok('pending entry names the kind + carries nextActions', rep.pending.some((p) => p.kind === 'field_error' && p.nextActions.length > 0), JSON.stringify(rep.pending));
  // when the pending channel is satisfied (field error present), the gate passes.
  const certified = buildPageState({ snapshotText: SNAP_EMPTY_USERNAME, url: URL_LOGIN });
  ok('certified=true once fieldErrors present + url present', certificationReport(certified, reqV).certified === true);
}

console.log('\n— (5) username/password Required scoped correctly (order/proximity) —');
{
  const up = buildPageState({ snapshotText: SNAP_EMPTY_PASSWORD, url: URL_LOGIN }).channels.fieldErrors;
  ok('empty password -> Required scoped to password', up.status === STATUS.PRESENT && up.items.length === 1 && up.items[0].fieldRole === 'password', JSON.stringify(up.items));
  const both = buildPageState({ snapshotText: SNAP_BOTH_EMPTY, url: URL_LOGIN }).channels.fieldErrors;
  const roles = both.items.map((i) => i.fieldRole).sort();
  ok('both empty -> Required scoped to BOTH fields', both.items.length === 2 && roles[0] === 'password' && roles[1] === 'username', JSON.stringify(both.items));
}

console.log('\n— (6) invalid credentials -> pageErrors/auth, NOT fieldErrors —');
{
  const ps = buildPageState({ snapshotText: SNAP_INVALID_CREDS, url: URL_LOGIN });
  const pe = ps.channels.pageErrors;
  ok('pageErrors present + class auth', pe.status === STATUS.PRESENT && pe.items.some((i) => i.messageClass === 'auth' && /invalid/i.test(i.text)), JSON.stringify(pe.items));
  ok('fieldErrors NOT present (no fabricated field scope)', ps.channels.fieldErrors.status !== STATUS.PRESENT, ps.channels.fieldErrors.status);
}

console.log('\n— (7) toCertifiedCheckerPageState: NO pending channel can become final checker evidence —');
{
  const reqValidation = buildRowEvidenceContract(mkRow({ username: '', password: 'admin123' })).requiredEvidence;
  const patterns = { entryUrlPattern: 'auth/login', authedUrlPattern: 'dashboard' };

  // snapshot-only: fieldErrors is needs_acquisition -> the boundary REFUSES.
  const pendingPs = buildPageState({ snapshotText: SNAP_CLEAN, url: URL_LOGIN });
  const refused = toCertifiedCheckerPageState(pendingPs, reqValidation, patterns);
  ok('refuses (ok:false) while a required channel is pending', refused.ok === false, JSON.stringify(refused.pending));
  ok('produces NO checker input when refusing', refused.checkerPageState === null);
  ok('refusal names the pending kind + nextActions (how to escalate)', refused.pending.some((p) => p.kind === 'field_error' && p.nextActions.length > 0), JSON.stringify(refused.pending));

  // certified (field error present): the boundary ALLOWS, and judge runs.
  const certPs = buildPageState({ snapshotText: SNAP_EMPTY_USERNAME, url: URL_LOGIN });
  const allowed = toCertifiedCheckerPageState(certPs, reqValidation, patterns);
  ok('allows (ok:true) once all required channels certified', allowed.ok === true && !!allowed.checkerPageState, JSON.stringify(allowed.pending));
  const res = judgeRowEvidence(buildRowEvidenceContract(mkRow({ username: '', password: 'admin123' })), allowed.checkerPageState);
  ok('verdict computable only AFTER certification (works)', res.verdict === 'works', `${res.verdict}/${res.reason}`);
}

console.log('\n— (8) error_present is satisfied by ALTERNATIVE channels (pageErrors OR fieldErrors) —');
{
  const { mapVerdictToRunStatus } = require('../server/services/verdictEngine');
  const authRow = { index: 0, setName: 'AuthProfiles', sheet: 'AuthProfiles', inputs: { username: 'wrong', password: 'wrong' }, raw: { username: 'wrong', password: 'wrong' }, expected: null, rowClass: 'invalidCredentials', rowClassColumn: 'scenarioType', expectedColumn: null, label: 'auth' };
  const authContract = buildRowEvidenceContract(authRow);
  const patterns = { entryUrlPattern: 'auth/login', authedUrlPattern: 'dashboard' };
  ok('auth row emits error_present', authContract.requiredEvidence.some((e) => e.kind === 'error_present'), JSON.stringify(authContract.requiredEvidence.map((e) => e.kind)));

  // CASE 1 — page-level alert present, fieldErrors still pending -> ALLOWS (not stuck) -> works.
  const ps1 = buildPageState({ snapshotText: SNAP_INVALID_CREDS, url: URL_LOGIN });
  ok('case1: pageErrors present, fieldErrors pending', ps1.channels.pageErrors.status === STATUS.PRESENT && ps1.channels.fieldErrors.status === STATUS.PENDING, `${ps1.channels.pageErrors.status}/${ps1.channels.fieldErrors.status}`);
  const c1 = toCertifiedCheckerPageState(ps1, authContract.requiredEvidence, patterns);
  ok('case1: ALLOWS despite fieldErrors pending (page alert is enough)', c1.ok === true, JSON.stringify(c1.pending));
  ok('case1: judge -> works', judgeRowEvidence(authContract, c1.checkerPageState).verdict === 'works', JSON.stringify(judgeRowEvidence(authContract, c1.checkerPageState)));

  // CASE 2 — no page alert (pageErrors empty) and fieldErrors pending -> REFUSES with nextActions.
  const ps2 = buildPageState({ snapshotText: SNAP_CLEAN, url: URL_LOGIN });
  const c2 = toCertifiedCheckerPageState(ps2, authContract.requiredEvidence, patterns);
  ok('case2: REFUSES (pageErrors empty + fieldErrors pending, no present channel)', c2.ok === false);
  ok('case2: refusal carries nextActions for error_present', c2.pending.some((p) => p.kind === 'error_present' && p.nextActions.length > 0), JSON.stringify(c2.pending));

  // CASE 3 — field-level error present, pageErrors empty -> ALLOWS via fieldErrors -> works.
  const SNAP_FIELD_AUTH = ['- form "LoginForm":', '  - textbox "Username" [ref=e3]', '  - text: Invalid credentials', '  - textbox "Password" [ref=e5]', '  - button "Login" [ref=e7]'].join('\n');
  const ps3 = buildPageState({ snapshotText: SNAP_FIELD_AUTH, url: URL_LOGIN });
  ok('case3: fieldErrors present, pageErrors empty', ps3.channels.fieldErrors.status === STATUS.PRESENT && ps3.channels.pageErrors.status === STATUS.EMPTY, `${ps3.channels.fieldErrors.status}/${ps3.channels.pageErrors.status}`);
  const c3 = toCertifiedCheckerPageState(ps3, authContract.requiredEvidence, patterns);
  ok('case3: ALLOWS via fieldErrors', c3.ok === true, JSON.stringify(c3.pending));
  ok('case3: judge -> works (field-level auth error satisfies error_present)', judgeRowEvidence(authContract, c3.checkerPageState).verdict === 'works');

  // CASE 4 — BOTH channels certified inspected-empty + page SETTLED -> missing error is a BUG.
  const ps4 = buildPageState({ snapshotText: SNAP_CLEAN, url: URL_LOGIN, settled: true, domFacts: { inspectedSources: ['aria_describedby', 'dom_error_containers'], fieldErrors: [], pageErrors: [] } });
  ok('case4: both error channels inspected_empty', ps4.channels.pageErrors.status === STATUS.EMPTY && ps4.channels.fieldErrors.status === STATUS.EMPTY, `${ps4.channels.pageErrors.status}/${ps4.channels.fieldErrors.status}`);
  const c4 = toCertifiedCheckerPageState(ps4, authContract.requiredEvidence, patterns);
  ok('case4: ALLOWS (both certified empty)', c4.ok === true, JSON.stringify(c4.pending));
  const r4 = judgeRowEvidence(authContract, c4.checkerPageState);
  ok('case4: judge -> bug (rejection error missing everywhere)', r4.verdict === 'bug', JSON.stringify(r4));
  ok('case4: maps to fail', mapVerdictToRunStatus(r4).status === 'fail');
}

console.log('\n— (9) ABSENCE waits for settle; PRESENCE certifies immediately —');
{
  const reqV = [{ kind: 'page_present', page: 'entry' }, { kind: 'field_error', fieldRole: 'username', messageClass: 'required' }];
  const domEmpty = { inspectedSources: ['aria_describedby', 'dom_error_containers'], fieldErrors: [], pageErrors: [] };

  // inspected-empty but NOT settled -> absence must NOT certify (awaitingSettle).
  const notSettled = buildPageState({ snapshotText: SNAP_CLEAN, url: URL_LOGIN, settled: false, domFacts: domEmpty });
  const rUn = certificationReport(notSettled, reqV);
  ok('absence NOT certified while page unsettled', rUn.certified === false, JSON.stringify(rUn.pending));
  ok('pending field_error is awaitingSettle with a wait nextAction', rUn.pending.some((p) => p.kind === 'field_error' && p.awaitingSettle === true && p.nextActions.length > 0), JSON.stringify(rUn.pending));

  // same, but settled -> absence certifies.
  const settled = buildPageState({ snapshotText: SNAP_CLEAN, url: URL_LOGIN, settled: true, domFacts: domEmpty });
  ok('absence certifies once settled', certificationReport(settled, reqV).certified === true);

  // PRESENCE certifies even when unsettled (a visible error is a visible error).
  const presentUnsettled = buildPageState({ snapshotText: SNAP_EMPTY_USERNAME, url: URL_LOGIN, settled: false });
  ok('presence certifies immediately despite unsettled', certificationReport(presentUnsettled, reqV).certified === true);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — pageStateBuilder certified channels verified (SYNTHETIC fixtures; live fidelity pending B-2e)');
