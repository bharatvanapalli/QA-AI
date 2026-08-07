'use strict';
/*
 * Guard for B-2c.0 — certified action-target resolution.
 *
 * Proves the role-safe resolver (mcp.resolveActionRefByDescription) NEVER
 * dispatches to a static/nearby element, and that the loose word-overlap
 * resolver (findRefForLabelInSnapshot) — which DOES pick static elements — is
 * the unsafe one we quarantine behind the QAAI_CERTIFIED_ACTION_TARGETS flag.
 *
 * Pure/offline against synthetic accessibility-tree fixtures (format-faithful,
 * not live). The conductor's gating of these resolvers is parse-verified; this
 * guard proves the resolver each path lands on.
 */
const mcp = require('../server/services/mcp');
const conductor = require('../server/services/agents/conductor');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const R = (snap, label, tool) => mcp.resolveActionRefByDescription(snap, label, tool);

console.log('— heading-vs-button same label: certified resolver picks the BUTTON, never the heading —');
{
  const snap = ['- heading "Submit" [ref=e1]', '- button "Submit" [ref=e2]'].join('\n');
  ok('click "Submit" -> button e2 (not heading e1)', R(snap, 'Submit', 'browser_click') === 'e2', R(snap, 'Submit', 'browser_click'));
  // The LOOSE resolver is the hazard: it accepts the heading. (This is why it is quarantined.)
  ok('loose resolver WOULD accept a static role (proves why we quarantine it)', !!conductor.findRefForLabelInSnapshot(snap, 'Submit'));
}

console.log('\n— static-only label: certified resolver returns NULL (no fallback to heading) —');
{
  const snap = ['- heading "Welcome back" [ref=e1]', '- button "Login" [ref=e2]'].join('\n');
  ok('click "Welcome back" -> null (only a heading matches; do not dispatch on it)', R(snap, 'Welcome back', 'browser_click') === null, String(R(snap, 'Welcome back', 'browser_click')));
}

console.log('\n— generic wrapper + real control same label: picks the interactive control —');
{
  const snap = ['- generic "Add Note" [ref=e1]', '- button "Add Note" [ref=e2]'].join('\n');
  ok('click "Add Note" -> button e2 (not the generic wrapper)', R(snap, 'Add Note', 'browser_click') === 'e2', R(snap, 'Add Note', 'browser_click'));
}

console.log('\n— ambiguous (two identical clickable names): returns NULL, never guesses —');
{
  const snap = ['- button "Select" [ref=e1]', '- button "Select" [ref=e2]'].join('\n');
  ok('two exact "Select" buttons -> null', R(snap, 'Select', 'browser_click') === null, String(R(snap, 'Select', 'browser_click')));
}

console.log('\n— role match respects the tool (type needs a textbox; click needs a clickable) —');
{
  const snap = ['- textbox "Username" [ref=e1]', '- button "Username" [ref=e2]'].join('\n');
  ok('TYPE "Username" -> textbox e1 (not the button)', R(snap, 'Username', 'browser_type') === 'e1', R(snap, 'Username', 'browser_type'));
  const onlyButton = ['- button "Login" [ref=e2]'].join('\n');
  ok('TYPE where only a button matches -> null (wrong role)', R(onlyButton, 'Login', 'browser_type') === null, String(R(onlyButton, 'Login', 'browser_type')));
}

console.log('\n— unambiguous single clickable resolves; descriptive words are stripped —');
{
  const snap = ['- button "Login" [ref=e5]'].join('\n');
  ok('click "the Login button" -> e5 (filler words ignored)', R(snap, 'the Login button', 'browser_click') === 'e5', R(snap, 'the Login button', 'browser_click'));
}

console.log('\n— rollout flag plumbing —');
{
  const prev = process.env.QAAI_CERTIFIED_ACTION_TARGETS;
  process.env.QAAI_CERTIFIED_ACTION_TARGETS = '';
  ok('flag OFF by default-empty', conductor.certifiedActionTargetsEnabled() === false);
  process.env.QAAI_CERTIFIED_ACTION_TARGETS = 'true';
  ok('flag ON when set', conductor.certifiedActionTargetsEnabled() === true);
  if (prev == null) delete process.env.QAAI_CERTIFIED_ACTION_TARGETS; else process.env.QAAI_CERTIFIED_ACTION_TARGETS = prev;
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — certified action-target resolver verified (SYNTHETIC fixtures; live wiring proven at B-2e)');
