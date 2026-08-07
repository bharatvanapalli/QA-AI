'use strict';
/**
 * Guard: verify the Action Disposition Filter works correctly on a sample trail.
 *
 * Runs classifyDisposition against synthetic traces that cover the known
 * failure patterns: cancel-loops, retry-fills, dead fills, assertion-support
 * hovers, and the setup detection (login sequence).
 *
 * Usage:
 *   node scripts/verify_action_disposition.cjs
 *
 * Exits 0 if all assertions pass, 1 if any fail.
 */

const { classifyDisposition, buildActionPlan } = require('../server/services/codegen/_actionPlan');

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function makeAction(tool, args, extra = {}) {
  return { tool, args: args || {}, ok: true, ...extra };
}

// ── Test 1: Login setup detection ─────────────────────────────────────────────
console.log('\nTest 1: Setup — login sequence classified correctly');
{
  const trail = [
    makeAction('browser_navigate', { url: 'http://app/login' }),
    makeAction('browser_fill', { element: 'Username', value: 'admin' }),
    makeAction('browser_fill', { element: 'Password', value: 'admin123' }),
    makeAction('browser_click', { element: 'Login' }),
    makeAction('browser_click', { element: 'Add Employee' }),
    makeAction('browser_fill', { element: 'First Name', value: 'John' }),
  ];
  const d = classifyDisposition(trail);
  assert('navigate → setup', d[0] === 'setup', `got ${d[0]}`);
  assert('username fill → setup', d[1] === 'setup', `got ${d[1]}`);
  assert('password fill → setup', d[2] === 'setup', `got ${d[2]}`);
  assert('login button → setup', d[3] === 'setup', `got ${d[3]}`);
  assert('Add Employee → committed', d[4] === 'committed', `got ${d[4]}`);
  assert('First Name fill → committed', d[5] === 'committed', `got ${d[5]}`);
}

// ── Test 2: Cancel-loop detection ─────────────────────────────────────────────
console.log('\nTest 2: Cancel-loop — exploratory + recovery classified correctly');
{
  const trail = [
    makeAction('browser_click', { element: 'Wrong Button' }),  // wrong click
    makeAction('browser_fill', { element: 'Some field', value: 'x' }), // intermediate
    makeAction('browser_click', { element: 'Cancel' }),         // cancel
    makeAction('browser_click', { element: 'Save' }),           // real action after recovery
  ];
  const d = classifyDisposition(trail);
  assert('wrong click → exploratory', d[0] === 'exploratory', `got ${d[0]}`);
  assert('intermediate → exploratory', d[1] === 'exploratory', `got ${d[1]}`);
  assert('cancel click → recovery', d[2] === 'recovery', `got ${d[2]}`);
  assert('real Save → committed', d[3] === 'committed', `got ${d[3]}`);
}

// ── Test 3: browser_navigate_back as recovery ─────────────────────────────────
console.log('\nTest 3: Cancel-loop with navigate_back');
{
  const trail = [
    makeAction('browser_click', { element: 'Accidental link' }),
    makeAction('browser_navigate_back', {}),
    makeAction('browser_click', { element: 'Real action' }),
  ];
  const d = classifyDisposition(trail);
  assert('accidental click → exploratory', d[0] === 'exploratory', `got ${d[0]}`);
  assert('navigate_back → recovery', d[1] === 'recovery', `got ${d[1]}`);
  assert('real action → committed', d[2] === 'committed', `got ${d[2]}`);
}

// ── Test 4: Dead fills ─────────────────────────────────────────────────────────
console.log('\nTest 4: Dead fills — earlier fills on same field are dropped');
{
  const trail = [
    makeAction('browser_fill', { element: 'First Name', value: 'wrong' }),
    makeAction('browser_fill', { element: 'Last Name', value: 'Doe' }),
    makeAction('browser_fill', { element: 'First Name', value: 'correct' }), // overwrites
  ];
  const d = classifyDisposition(trail);
  assert('first fill (wrong) → dead', d[0] === 'dead', `got ${d[0]}`);
  assert('last name fill → committed', d[1] === 'committed', `got ${d[1]}`);
  assert('second fill (correct) → committed', d[2] === 'committed', `got ${d[2]}`);
}

// ── Test 5: Identical re-fill → first is dead, last is kept ──────────────────
// Same field + same value still produces a duplicate locator in the spec. The
// exported test only needs the final write, so the earlier duplicate is dead.
// (This was intentionally tightened — the prior guard preserving same-value
// re-fills produced duplicate el2/el3 steps in generated specs.)
console.log('\nTest 5: Same field, same value — first is dead, last kept');
{
  const trail = [
    makeAction('browser_fill', { element: 'Search', value: 'John' }),
    makeAction('browser_fill', { element: 'Search', value: 'John' }), // same value
  ];
  const d = classifyDisposition(trail);
  assert('first same-value fill → dead', d[0] === 'dead', `got ${d[0]}`);
  assert('second same-value fill → committed', d[1] === 'committed', `got ${d[1]}`);
}

// ── Test 6: Assertion support hover ───────────────────────────────────────────
console.log('\nTest 6: Assertion support — hover without follow-up click');
{
  const trail = [
    makeAction('browser_click', { element: 'Profile' }),
    makeAction('browser_hover', { element: 'Status badge' }), // hover to check tooltip
    makeAction('browser_click', { element: 'Save' }),
  ];
  const d = classifyDisposition(trail);
  assert('click Profile → committed', d[0] === 'committed', `got ${d[0]}`);
  assert('hover without follow-up → assertion_support', d[1] === 'assertion_support', `got ${d[1]}`);
  assert('click Save → committed', d[2] === 'committed', `got ${d[2]}`);
}

// ── Test 7: Hover with follow-up click stays committed ────────────────────────
console.log('\nTest 7: Hover with immediate follow-up click stays committed');
{
  const trail = [
    makeAction('browser_hover', { element: 'Dropdown' }),
    makeAction('browser_click', { element: 'Dropdown' }), // follow-up on same element
  ];
  const d = classifyDisposition(trail);
  assert('hover with follow-up → committed', d[0] === 'committed', `got ${d[0]}`);
  assert('follow-up click → committed', d[1] === 'committed', `got ${d[1]}`);
}

// ── Test 8: buildActionPlan returns droppedActions + traceVersion ─────────────
console.log('\nTest 8: buildActionPlan structure — droppedActions + traceVersion');
{
  const trail = [
    makeAction('browser_fill', { element: 'Username', value: 'admin' }),
    makeAction('browser_fill', { element: 'Password', value: 'pass' }),
    makeAction('browser_click', { element: 'Login' }),
    makeAction('browser_click', { element: 'Wrong button' }),
    makeAction('browser_click', { element: 'Cancel' }),
    makeAction('browser_click', { element: 'Save' }),
  ];
  const plan = buildActionPlan({ trail, status: 'pass', stepResults: [] });
  const exportedDispositions = plan.actions.map((a) => a.disposition);
  const droppedDispositions = plan.droppedActions.map((a) => a.disposition);

  assert('setup actions exported', exportedDispositions.includes('setup'), `exported: ${exportedDispositions.join(', ')}`);
  assert('committed actions exported', exportedDispositions.includes('committed'), `exported: ${exportedDispositions.join(', ')}`);
  assert('exploratory NOT exported', !exportedDispositions.includes('exploratory'), `exported: ${exportedDispositions.join(', ')}`);
  assert('recovery NOT exported', !exportedDispositions.includes('recovery'), `exported: ${exportedDispositions.join(', ')}`);
  assert('exploratory in droppedActions', droppedDispositions.includes('exploratory'), `dropped: ${droppedDispositions.join(', ')}`);
  assert('recovery in droppedActions', droppedDispositions.includes('recovery'), `dropped: ${droppedDispositions.join(', ')}`);
  assert('traceVersion=legacy (no domFacts)', plan.traceVersion === 'legacy', `got ${plan.traceVersion}`);
}

// ── Test 9: traceVersion v2 when domFacts present ─────────────────────────────
console.log('\nTest 9: traceVersion=v2 when any action has domFacts');
{
  const trail = [
    makeAction('browser_click', { element: 'Save' }, {
      domFacts: { role: 'button', accessibleName: 'Save', selector: "getByRole('button', { name: 'Save' })" },
    }),
  ];
  const plan = buildActionPlan({ trail, status: 'pass' });
  assert('traceVersion=v2 with domFacts', plan.traceVersion === 'v2', `got ${plan.traceVersion}`);
  assert('domFacts threaded into action', plan.actions[0] && plan.actions[0].domFacts != null, 'domFacts missing');
}

// ── Test 10: browser_fill_form credential detection ───────────────────────────
console.log('\nTest 10: browser_fill_form with credential fields → setup');
{
  const trail = [
    makeAction('browser_fill_form', { fields: [{ label: 'Username', value: 'admin' }, { label: 'Password', value: 'pass' }] }),
    makeAction('browser_click', { element: 'Login' }),
    makeAction('browser_click', { element: 'Add' }),
  ];
  const d = classifyDisposition(trail);
  assert('fill_form with credentials → setup', d[0] === 'setup', `got ${d[0]}`);
  assert('login button → setup', d[1] === 'setup', `got ${d[1]}`);
  assert('Add → committed', d[2] === 'committed', `got ${d[2]}`);
}

// ── Test 11: Pass 2b — dead navigate (agent navigated to wrong URL then correct) ─
// Navigates must be AFTER the login sequence so Pass 1 doesn't eat them as setup.
console.log('\nTest 11: Dead navigate — first navigate is dead when second is different URL');
{
  const trail = [
    makeAction('browser_fill', { element: 'Username', value: 'admin' }),
    makeAction('browser_fill', { element: 'Password', value: 'pass' }),
    makeAction('browser_click', { element: 'Login' }),
    // Post-login: agent navigates to wrong page, then correct page
    makeAction('browser_navigate', { url: 'http://app/wrong-page' }),
    makeAction('browser_navigate', { url: 'http://app/correct-page' }),
    makeAction('browser_click', { element: 'Edit' }),
  ];
  const d = classifyDisposition(trail);
  assert('wrong navigate → dead', d[3] === 'dead', `got ${d[3]}`);
  assert('correct navigate → committed', d[4] === 'committed', `got ${d[4]}`);
  assert('edit click → committed', d[5] === 'committed', `got ${d[5]}`);
}

// ── Test 12: Pass 2b — non-consecutive navigates NOT marked dead ──────────────
console.log('\nTest 12: Non-consecutive navigates — intervening action keeps both committed');
{
  const trail = [
    makeAction('browser_fill', { element: 'Username', value: 'admin' }),
    makeAction('browser_fill', { element: 'Password', value: 'pass' }),
    makeAction('browser_click', { element: 'Login' }),
    // Post-login: navigate, click, then navigate again — NOT consecutive
    makeAction('browser_navigate', { url: 'http://app/page-a' }),
    makeAction('browser_click', { element: 'Some action' }), // intervenes — breaks consecutive detect
    makeAction('browser_navigate', { url: 'http://app/page-b' }),
  ];
  const d = classifyDisposition(trail);
  assert('first navigate → committed (not consecutive)', d[3] === 'committed', `got ${d[3]}`);
  assert('click → committed', d[4] === 'committed', `got ${d[4]}`);
  assert('second navigate → committed', d[5] === 'committed', `got ${d[5]}`);
}

// ── Test 13: Pass 2c — same-step wrong click with URL crossing ─────────────────
console.log('\nTest 13: Same-step wrong click (URL crossing) → earlier click exploratory');
{
  const trail = [
    makeAction('browser_click', { element: 'Wrong Edit' }, { stepIndex: 2, pageUrl: 'http://app/list', pageUrlAfter: 'http://app/wrong-page' }),
    makeAction('browser_fill', { element: 'First Name', value: 'x' }, { stepIndex: 2, pageUrl: 'http://app/wrong-page' }),
    makeAction('browser_navigate_back', {}, { stepIndex: 2 }),
    makeAction('browser_click', { element: 'Correct Edit' }, { stepIndex: 2, pageUrl: 'http://app/list', pageUrlAfter: 'http://app/edit-page' }),
    makeAction('browser_fill', { element: 'First Name', value: 'John' }, { stepIndex: 2, pageUrl: 'http://app/edit-page' }),
  ];
  const d = classifyDisposition(trail);
  // wrong click → exploratory (Pass 2 catches click+navigate_back)
  assert('wrong click → exploratory (Pass 2)', d[0] === 'exploratory', `got ${d[0]}`);
  assert('fill in wrong form → exploratory', d[1] === 'exploratory', `got ${d[1]}`);
  assert('navigate_back → recovery', d[2] === 'recovery', `got ${d[2]}`);
  assert('correct click → committed', d[3] === 'committed', `got ${d[3]}`);
  assert('real fill → committed', d[4] === 'committed', `got ${d[4]}`);
}

// ── Test 14: Pass 2c — same-step, no URL crossing → both clicks stay committed ─
console.log('\nTest 14: Same-step two clicks, same URL → legitimate expand+select, not exploratory');
{
  const trail = [
    makeAction('browser_click', { element: 'Dropdown' }, { stepIndex: 3, pageUrl: 'http://app/form', pageUrlAfter: 'http://app/form' }),
    makeAction('browser_click', { element: 'Option A' }, { stepIndex: 3, pageUrl: 'http://app/form', pageUrlAfter: 'http://app/form' }),
  ];
  const d = classifyDisposition(trail);
  assert('expand click → committed (no URL crossing)', d[0] === 'committed', `got ${d[0]}`);
  assert('select click → committed', d[1] === 'committed', `got ${d[1]}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n[verify_action_disposition] ${passed} passed, ${failed} failed.\n`);
process.exit(failed > 0 ? 1 : 0);
