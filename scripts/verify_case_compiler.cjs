'use strict';
/*
 * CASE COMPILER — the promotion authority. Proves the deterministic classifier
 * (ready | needs_review | blocked) enforces the core invariants, and that all
 * three approve funnels in testCases.js are gated so a `blocked` case can never
 * become `approved` (= runnable). A correct classifier that isn't wired into
 * approval would leave the old "advisory" behaviour in place, so both the logic
 * and the wiring are locked here. Pure + deterministic; generic across sites.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'server', 'services', 'caseCompiler'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const codes = (v) => v.blockers.map((b) => b.code).concat(v.warnings.map((w) => w.code)).join(',');

console.log('— READY: a clean, fully-bound, must-asserted case —');
{
  const v = C.compileCase({
    name: 'Admin login → dashboard', steps: [{ action: 'fill', value: '{{username}}' }, { action: 'fill', value: '{{password}}' }],
    declaredAssertions: [{ type: 'PAGE', criticality: 'must', payload: { expectedSignals: { url: ['/dashboard'] } } }],
    dataBinding: { sheet: 'AuthProfiles', status: 'complete', columnToField: { username: 'username', password: 'password' }, findings: [] },
    automatability: 'automatable',
  });
  ok('clean bound case → ready', v.state === 'ready', codes(v));
}

console.log('\n— BLOCKED: core-invariant violations cannot become Ready —');
ok('{{token}} with NO binding → blocked (unresolved_tokens_no_binding)', (() => {
  const v = C.compileCase({ name: 'X', steps: [{ value: '{{username}}' }], declaredAssertions: [{ type: 'TEXT', criticality: 'must', payload: { expectedText: 'Hi' } }], dataBinding: null, automatability: 'automatable' });
  return v.state === 'blocked' && v.blockers.some((b) => b.code === 'unresolved_tokens_no_binding');
})());
ok('UNMAPPED token (binding cannot fill it) → blocked (unmapped_tokens) even though binding.status=complete', (() => {
  const v = C.compileCase({ name: 'X', steps: [{ value: '{{ssn}}' }], declaredAssertions: [{ type: 'TEXT', criticality: 'must', payload: { expectedText: 'Hi' } }], dataBinding: { sheet: 'Auth', status: 'complete', findings: [{ code: 'data_placeholder_not_in_mapping', severity: 'warning', token: 'ssn' }] }, automatability: 'automatable' });
  return v.state === 'blocked' && v.blockers.some((b) => b.code === 'unmapped_tokens');
})());
ok('parseFailed MUST assertion → blocked (assertion_invalid)', (() => {
  const v = C.compileCase({ name: 'X', steps: [], declaredAssertions: [{ type: 'TEXT', criticality: 'must', parseFailed: true, payload: {} }], dataBinding: null, automatability: 'automatable' });
  return v.state === 'blocked' && v.blockers.some((b) => b.code === 'assertion_invalid');
})());
ok('malformed PAGE (unresolved-token pageName) MUST → blocked', (() => {
  const v = C.compileCase({ name: 'X', steps: [], declaredAssertions: [{ type: 'PAGE', criticality: 'must', payload: { pageName: '{{expectedValidationError}}', expectedSignals: { text: ['x'] } } }], dataBinding: null, automatability: 'automatable' });
  return v.state === 'blocked' && v.blockers.some((b) => b.code === 'assertion_invalid');
})());
ok('structurally broken binding (sheet not found) → blocked (data_binding_incomplete)', (() => {
  const v = C.compileCase({ name: 'X', steps: [], declaredAssertions: [{ type: 'PAGE', criticality: 'must', payload: { expectedSignals: { url: ['/x'] } } }], dataBinding: { sheet: 'Missing', status: 'incomplete', findings: [{ code: 'data_binding_sheet_not_found', severity: 'error' }] }, automatability: 'automatable' });
  return v.state === 'blocked' && v.blockers.some((b) => b.code === 'data_binding_incomplete');
})());
ok('URL assertion with placeholder pattern → blocked (url_pattern_unresolved_token)', (() => {
  const v = C.compileCase({ name: 'X', steps: [], declaredAssertions: [{ type: 'URL', criticality: 'must', payload: { expectedUrlPattern: '/{{landing}}' } }], dataBinding: { sheet: 'S', status: 'complete', columnToField: { landing: 'landing' }, findings: [] }, automatability: 'automatable' });
  return v.state === 'blocked' && v.blockers.some((b) => b.code === 'url_pattern_unresolved_token');
})());
ok('automatable case with EMPTY declaredAssertions → blocked (parseFailed placeholder)', (() => {
  // Mirrors declaredAssertions.normalizeForCase emitting a parseFailed placeholder
  // for an automatable case with no assertions.
  const v = C.compileCase({ name: 'X', steps: [], declaredAssertions: [{ type: 'TEXT', criticality: 'must', parseFailed: true, payload: {} }], dataBinding: null, automatability: 'automatable' });
  return v.state === 'blocked';
})());
ok('automatable case with TRULY EMPTY [] declaredAssertions → blocked (no_assertions; legacy-bypass safety)', (() => {
  const v = C.compileCase({ name: 'X', steps: [], declaredAssertions: [], dataBinding: null, automatability: 'automatable' });
  return v.state === 'blocked' && v.blockers.some((b) => b.code === 'no_assertions');
})());

console.log('\n— NEEDS_REVIEW: runnable but incomplete (never silently Ready) —');
ok('no typed operations[] when atlas capabilities exist → needs_review (not blocked)', (() => {
  const v = C.compileCase({ name: 'X', steps: [], declaredAssertions: [{ type: 'PAGE', criticality: 'must', payload: { expectedSignals: { url: ['/x'] } } }], dataBinding: null, operations: null, automatability: 'automatable' }, { atlasHasCapabilities: true });
  return v.state === 'needs_review' && v.warnings.some((w) => w.code === 'no_typed_operations');
})());
ok('advisory binding finding (literal leak) → needs_review', (() => {
  const v = C.compileCase({ name: 'X', steps: [{ value: '{{u}}' }], declaredAssertions: [{ type: 'PAGE', criticality: 'must', payload: { expectedSignals: { url: ['/x'] } } }], dataBinding: { sheet: 'S', status: 'complete', columnToField: { u: 'u' }, findings: [{ code: 'data_input_placeholders_missing', severity: 'warning' }] }, automatability: 'automatable' });
  return v.state === 'needs_review';
})());
ok('crawl coverage gap for the case module → needs_review', (() => {
  const v = C.compileCase({ name: 'X', module: 'recruitment', steps: [], declaredAssertions: [{ type: 'PAGE', criticality: 'must', payload: { expectedSignals: { url: ['/x'] } } }], dataBinding: null, automatability: 'automatable' }, { coverageUnmapped: ['recruitment'] });
  return v.state === 'needs_review' && v.warnings.some((w) => w.code === 'crawl_coverage_gap');
})());
ok('assertions present but NONE are must → needs_review (proves nothing)', (() => {
  const v = C.compileCase({ name: 'X', steps: [], declaredAssertions: [{ type: 'TEXT', criticality: 'should', payload: { expectedText: 'x' } }], dataBinding: null, automatability: 'automatable' });
  return v.state === 'needs_review' && v.warnings.some((w) => w.code === 'no_must_assertion');
})());

console.log('\n— manual cases carry no automation contract → ready —');
ok('manual case → ready (not blocked)', C.compileCase({ name: 'X', automatability: 'manual', declaredAssertions: [] }).state === 'ready');

console.log('\n— scanTokens finds tokens across name/steps/assertions —');
ok('scanTokens collects distinct token names', (() => {
  const t = C.scanTokens('Login {{username}}', [{ value: '{{password}}' }], 'expect {{username}}');
  return t.includes('username') && t.includes('password') && t.length === 2;
})());

console.log('\n— compileStoredCase parses JSON string columns —');
ok('compileStoredCase blocks a stored case with no-binding token', (() => {
  const v = C.compileStoredCase({ name: 'X', steps: JSON.stringify([{ value: '{{x}}' }]), declaredAssertions: JSON.stringify([{ type: 'TEXT', criticality: 'must', payload: { expectedText: 'y' } }]), dataBindingJson: null, automatability: 'automatable' });
  return v.state === 'blocked';
})());

console.log('\n— shared execution gate (used by BOTH conductor runners) —');
ok('excludeBlockedScenarios drops blocked, keeps ready, prunes empty scenarios, reports excluded', (() => {
  const scenarios = [
    { name: 'S1', cases: [
      { name: 'good', steps: JSON.stringify([]), declaredAssertions: JSON.stringify([{ type: 'PAGE', criticality: 'must', payload: { expectedSignals: { url: ['/x'] } } }]), automatability: 'automatable' },
      { name: 'bad-token', steps: JSON.stringify([{ value: '{{x}}' }]), declaredAssertions: JSON.stringify([{ type: 'TEXT', criticality: 'must', payload: { expectedText: 'y' } }]), dataBindingJson: null, automatability: 'automatable' },
    ] },
    { name: 'S2', cases: [{ name: 'no-assertions', steps: JSON.stringify([]), declaredAssertions: JSON.stringify([]), automatability: 'automatable' }] },
  ];
  const r = C.excludeBlockedScenarios(scenarios);
  return r.scenarios.length === 1 && r.scenarios[0].cases.length === 1 && r.scenarios[0].cases[0].name === 'good' && r.excluded.length === 2;
})());

console.log('\n— WIRING: all three approve funnels gate on the compiler —');
const tcRoutes = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'testCases.js'), 'utf8');
ok('testCases.js requires the compiler', tcRoutes.includes("require('../services/caseCompiler')"));
ok('single-case PUT refuses approving a blocked case', /data\.status === 'approved'[\s\S]{0,500}compileStoredCase\(existing,[\s\S]{0,200}=== 'blocked'/.test(tcRoutes));
ok('approve-all compiles pending + approves only non-blocked', /approve-all[\s\S]{0,1400}compileStoredCase\(tc,[\s\S]{0,200}=== 'blocked'/.test(tcRoutes));
ok('bulk-update gates approval on the compiler', /status === 'approved'[\s\S]{0,500}compileStoredCase\(tc,/.test(tcRoutes));
ok('blocked cases are reported back (not silently dropped)', tcRoutes.includes('blocked.push({ id: tc.id'));
ok('GET /test-cases returns per-case compiledReadiness (visible before approval)', tcRoutes.includes('compiledReadiness') && /compileStoredCase\(tc, \{ atlasHasCapabilities, workbookContract \}\)/.test(tcRoutes));
// Step 6 — the WorkbookContract is loaded and threaded so readiness/approval reflect the Oracle Contract's row-evidence findings.
ok('approve/readiness load + pass the project WorkbookContract', tcRoutes.includes('loadProjectWorkbookContract(project.id)') && /compileStoredCase\([^)]*\{[^}]*workbookContract/.test(tcRoutes));

console.log('\n— WIRING: every run entry point is gated (no bypass) —');
const runsSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'runs.js'), 'utf8');
ok('runs.js requires the compiler', runsSrc.includes("require('./caseCompiler')"));
ok('startRun refuses blocked cases (CASE_BLOCKED)', runsSrc.includes('compileStoredCase(tc)') && runsSrc.includes("code = 'CASE_BLOCKED'"));
ok('startRun refuses ANY unapproved case in the closure, not only requested (CASE_NOT_APPROVED)',
  runsSrc.includes("code = 'CASE_NOT_APPROVED'") && /EVERY case in the dependency closure must be approved/.test(runsSrc));
const agentsSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'agents.js'), 'utf8');
ok('main pipeline runner (agents.js /execute + /run-smoke) uses the SHARED gate', agentsSrc.includes('excludeBlockedScenarios(scenarios'));

const runnerSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'agents', 'conductorRunner.js'), 'utf8');
ok('shared conductorRunner.js (the blocked-rerun runner) ALSO uses the shared gate', runnerSrc.includes("require('../caseCompiler')") && runnerSrc.includes('excludeBlockedScenarios(scenarios'));
ok('conductorRunner emits a clear no-runnable-cases event when all are excluded', /No runnable cases after the compiler gate/.test(runnerSrc));

const blockedSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'blocked.js'), 'utf8');
ok('blocked rerun refuses a blocked case (CASE_BLOCKED)', blockedSrc.includes('compileStoredCase(tcForGate)') && blockedSrc.includes("code: 'CASE_BLOCKED'"));
ok('blocked rerun refuses BEFORE marking the item resolved (no false-resolve)', (() => {
  const gateIdx = blockedSrc.indexOf('compileStoredCase(tcForGate)');
  const resolveIdx = blockedSrc.indexOf("resolveNote: 'Rerun via conductor queued'");
  return gateIdx > -1 && resolveIdx > -1 && gateIdx < resolveIdx;
})());
ok('agents.js route-local runner STOPS when the gate empties the run (UX parity with conductorRunner)',
  /No runnable cases after the compiler gate/.test(agentsSrc));

console.log('\n— Step 5: no generation persistence bypass (persistCases is the sole creator) —');
ok('legacy /test-cases/generate is RETIRED (410 ENDPOINT_RETIRED)', tcRoutes.includes("code: 'ENDPOINT_RETIRED'") && /\/generate[\s\S]{0,1200}ENDPOINT_RETIRED/.test(tcRoutes));
ok('the retired route creates NOTHING (no testCase.create in testCases.js)', !tcRoutes.includes('.testCase.create('));
const contractSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'testCaseContract.js'), 'utf8');
ok('persistCases is the canonical creator (testCaseContract.js owns testCase.create)', contractSrc.includes('.testCase.create('));

console.log('\n— WIRING: the UI surfaces held-back cases (no more "All pending approved") —');
const tcUi = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'TestCases.jsx'), 'utf8');
ok('approve-all no longer unconditionally claims all approved', !tcUi.includes("toast.success('All pending test cases approved.')"));
ok('approve handlers surface the blocked payload', tcUi.includes('res?.blocked') && /Held back \$\{blocked\.length\}/.test(tcUi));
ok('a readiness chip renders for blocked / needs_review cases', tcUi.includes('readinessBadge') && tcUi.includes('compiledReadiness'));

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — the CaseCompiler is the promotion authority: core-invariant violations (unresolved/unmapped tokens, malformed must-assertions, broken bindings, placeholder URLs) are blocked from ever becoming approved/runnable; incomplete-but-runnable cases are needs_review (surfaced, never silently Ready); all three approve funnels enforce it.');
