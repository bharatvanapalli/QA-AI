'use strict';
/*
 * Guard for the STATEFUL SCENARIO CONTRACT — replays the exact failure the reviewer
 * found: TC1 (login) stops after the password fill without clicking Login, then the
 * runner continued into TC2 ("Admin avatar after login") and TC3 ("Session persists")
 * on the broken half-login state.
 *
 * The contract: a scenario's cases share one browser/conversation; if a case does NOT
 * pass, the shared state is poisoned. A later case that DEPENDS on that state (does
 * not establish its own session) is blocked failed_prereq WITHOUT invoking the model;
 * a SELF-ESTABLISHING case (its own login/setup) resets to a clean browser and runs.
 * Plus: explicit dependsOnIds enforcement is now default-ON.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server', 'services', 'agents', 'conductor.js'), 'utf8');
const { caseEstablishesSessionLive } = require(path.join(ROOT, 'server', 'lib', 'sessionScope'));
const { inferStatefulPrereqIds } = require(path.join(ROOT, 'server', 'lib', 'statefulDependency'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const has = (s) => src.includes(s);

console.log('— A. default-ON explicit dependency enforcement (Fix 2) —');
ok('requireDependencyOrder defaults ON (opt-out only via opts/env=off)',
  /requireDependencyOrder = opts\.requireDependencyOrder != null[\s\S]*?process\.env\.QAAI_ENFORCE_DEPENDENCY !== 'off'/.test(src));
ok('a failed explicit prerequisite still HARD-blocks (recordFailedPrereqBlock under requireDependencyOrder)',
  has('if (requireDependencyOrder) {') && has('await recordFailedPrereqBlock({ tc, runId: runRow.id, projectId, send, gate: depGate, caseOutcomes });'));

console.log('\n— B. implicit same-scenario continuity gate (Fix 1 + 5) —');
ok('per-scenario poison tracker exists', has('let scenarioStatePoison = null;'));
ok('continuity gate keys off caseEstablishesSessionLive', has("require('../../lib/sessionScope').caseEstablishesSessionLive(tc)") && has('if (scenarioStatePoison) {'));
ok('self-establishing case RESETS the browser + forces fresh conversation',
  has('await startFreshMcpSessionForScenario(scenario)') && has('scenarioContext.casesCompleted = 0;'));
ok('dependent (non-self-establishing) case is BLOCKED failed_prereq (reuses recordFailedPrereqBlock)',
  /if \(scenarioStatePoison\)[\s\S]*?recordFailedPrereqBlock\(\{[\s\S]*?blockedByName: scenarioStatePoison\.caseName/.test(src));
ok('blocked case is NOT executed (continue before runOneCase)',
  /recordFailedPrereqBlock\(\{[\s\S]*?\}\);\s*[\r\n]+\s*dependencyFindings\.push\([\s\S]*?implicit: true \}\);\s*[\r\n]+\s*continue;/.test(src));
ok('poison is SET after a non-pass case outcome (post recordCaseOutcome)',
  /caseOutcomes\.get\(tc\.id\)[\s\S]*?status !== 'pass' && !scenarioStatePoison[\s\S]*?scenarioStatePoison = \{/.test(src));

console.log('\n— C. BEHAVIOR: the reviewer\'s exact scenario (login → avatar → session) —');
// TC1: the login-establishing case (5 steps; here it would stop after password).
const TC1 = { name: 'Admin login redirects to dashboard', steps: [
  { action: 'Navigate', value: 'https://example.test/web/index.php/auth/login' },
  { action: 'Fill', element: 'Username field', value: 'Admin' },
  { action: 'Fill', element: 'Password field', value: 'admin123' },
  { action: 'Click', element: 'Login button' },
  { action: 'Verify', element: 'Dashboard heading' },
] };
// TC2 / TC3: depend on the authenticated session; NO own login steps.
const TC2 = { name: 'Admin avatar displayed in top-right after login', steps: [{ action: 'Verify', element: 'Admin avatar in top-right corner' }] };
const TC3 = { name: 'Session persists across page navigations after Admin login', steps: [{ action: 'Click', element: 'PIM' }, { action: 'Verify', element: 'session still active' }] };
// A negative-login case: dependent-looking but SELF-ESTABLISHING (its own login).
const NEG = { name: 'Empty username shows inline error', steps: [
  { action: 'Navigate', value: '/web/index.php/auth/login' },
  { action: 'Fill', element: 'Password field', value: 'x' },
  { action: 'Click', element: 'Login button' },
] };
// Persisted (JSON-string steps) shape must still be detected.
const TC1_PERSISTED = { name: 'login (persisted)', steps: JSON.stringify(TC1.steps) };

ok('TC1 (login) is self-establishing → true', caseEstablishesSessionLive(TC1) === true);
ok('TC1 persisted (JSON-string steps) still detected → true', caseEstablishesSessionLive(TC1_PERSISTED) === true);
ok('TC2 (avatar after login) is NOT self-establishing → false', caseEstablishesSessionLive(TC2) === false);
ok('TC3 (session persists) is NOT self-establishing → false', caseEstablishesSessionLive(TC3) === false);
ok('negative-login case IS self-establishing → true', caseEstablishesSessionLive(NEG) === true);

// Replica of the gate decision (the source asserts in B tie it to the real code).
const gateDecision = (poison, selfEstablishing) => (!poison ? 'run' : (selfEstablishing ? 'reset_and_run' : 'block_failed_prereq'));
console.log('\n— D. gate decision on that scenario after TC1 does not pass —');
ok('TC1 runs (no poison yet)', gateDecision(null, caseEstablishesSessionLive(TC1)) === 'run');
ok('TC2 BLOCKED failed_prereq (poison + not self-establishing)', gateDecision({ caseName: TC1.name }, caseEstablishesSessionLive(TC2)) === 'block_failed_prereq');
ok('TC3 BLOCKED failed_prereq (poison + not self-establishing)', gateDecision({ caseName: TC1.name }, caseEstablishesSessionLive(TC3)) === 'block_failed_prereq');
ok('negative-login case RESETS + runs (poison + self-establishing) — not blocked', gateDecision({ caseName: TC1.name }, caseEstablishesSessionLive(NEG)) === 'reset_and_run');

console.log('\n— E. planning-metadata materialization (Fix 2): infer dependsOnIds for stateful cases —');
{
  const cases = [
    { id: 'tc1', name: 'Admin login redirects to dashboard', steps: [{ action: 'Navigate', value: '/web/index.php/auth/login' }, { action: 'Fill', element: 'Password field' }, { action: 'Click', element: 'Login button' }] },
    { id: 'tc2', name: 'Admin avatar displayed in top-right after login', steps: [{ action: 'Verify', element: 'Admin avatar' }] },
    { id: 'tc3', name: 'Session persists across page navigations after Admin login', steps: [{ action: 'Click', element: 'PIM' }] },
    { id: 'neg', name: 'Empty username shows inline error', steps: [{ action: 'Navigate', value: '/auth/login' }, { action: 'Fill', element: 'Password field' }, { action: 'Click', element: 'Login button' }] },
  ];
  const edges = inferStatefulPrereqIds(cases);
  ok('TC2 (avatar after login) → inferred dependsOnIds = [TC1]', JSON.stringify(edges.get('tc2')) === '["tc1"]', JSON.stringify(edges.get('tc2')));
  ok('TC3 (session persists) → inferred dependsOnIds = [TC1]', JSON.stringify(edges.get('tc3')) === '["tc1"]', JSON.stringify(edges.get('tc3')));
  ok('TC1 (the login establisher) → no inferred prereq', !edges.has('tc1'));
  ok('negative-login case (self-establishing) → no inferred prereq', !edges.has('neg'));
  ok('scenario with NO session-establishing case → no inferred edges (conservative)',
    inferStatefulPrereqIds([{ id: 'x', name: 'Footer shows copyright', steps: [{ action: 'Verify', element: 'footer' }] }]).size === 0);
}
ok('conductor materializes inferred edges BEFORE buildGraph (so the default-on gate enforces them)',
  src.includes("require('../../lib/statefulDependency')") && src.includes('inferStatefulPrereqIds(s.cases')
  && src.indexOf('inferStatefulPrereqIds(s.cases') < src.indexOf('const runGraph = dependencyGraph.buildGraph('));

console.log('\n— F. counter hygiene (Fix 5): successful progress only counts passes —');
ok('casesAttempted counter exists (honest attempt count)', src.includes('scenarioContext.casesAttempted ='));
ok('casesPassed advances ONLY on an authoritative pass', /__outcome\.status === 'pass'\) \{\s*[\r\n]+\s*scenarioContext\.casesPassed = /.test(src));
ok('scenario summary reports passed/attempted (not blind casesCompleted)', /casesPassed \|\| 0\}\/\$\{scenarioContext\.casesAttempted/.test(src));

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — stateful scenario contract: default-on dependency enforcement + materialized dependsOnIds (TC2/TC3 → login) + runtime poison; dependents blocked failed_prereq (no model); self-establishing cases reset+run; successful progress counts passes only.');
