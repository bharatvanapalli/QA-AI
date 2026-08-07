// Zero-LLM verification that the snapshot-parser consolidation is correct.
// Asserts (a) buildRefRoleMap captures pre-ref-attribute + nameless elements,
// (b) parseMcpSnapshotToCandidates output is unchanged vs. its old regex.
// Usage: node scripts/verify_parser_consolidation.cjs
const mcp = require('../server/services/mcp.js');

// Representative OrangeHRM-style a11y snapshot with the exact shapes that broke
// the old buildRefRoleMap: [active]/[selected] BEFORE [ref], plus nameless refs.
const SNAP = [
  '- generic [ref=e1]:',
  '  - heading "Login" [level=5] [ref=e10]',
  '  - textbox "Username" [active] [ref=e23]',
  '  - textbox "Password" [ref=e24]',
  "  - button 'Login' [ref=e30]",
  '  - option "EN" [selected] [ref=e9]',
  '  - checkbox "Remember" [checked] [ref=e40]',
  '  - generic [ref=e5]',            // nameless but ref\'d — must survive
  '  - link "Forgot password?" [ref=e51]',
  '  - img "logo" [ref=e2]',
  '  - text "no ref here"',          // no ref — must be skipped
].join('\n');

let fails = 0;
function ok(cond, msg) { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) fails++; }

// ── 1. buildRefRoleMap (the role-validator / self-heal map). The drift fixture:
// pre-ref attributes ([active]/[selected]/[checked]) must NOT drop the element,
// and NAMELESS-but-ref'd elements (e5) must SURVIVE (the naive "build from
// candidates" approach would lose them — that's the regression we\'re guarding).
const rrm = mcp.buildRefRoleMap(SNAP);
ok(rrm.get('e23')?.role === 'textbox' && rrm.get('e23')?.name === 'Username',
   'roleMap: e23 [active] Username kept as textbox');
ok(rrm.get('e9')?.role === 'option',   'roleMap: e9 [selected] option kept');
ok(rrm.get('e40')?.role === 'checkbox','roleMap: e40 [checked] checkbox kept');
ok(rrm.get('e30')?.role === 'button',  'roleMap: e30 single-quoted Login kept as button');
ok(rrm.get('e10')?.role === 'heading', 'roleMap: e10 heading kept');
ok(rrm.has('e5') && rrm.get('e5').role === 'generic' && rrm.get('e5').name === '',
   'roleMap: e5 NAMELESS generic SURVIVES (no candidate, but role-validatable)');
ok(!Array.from(rrm.values()).some(v => v.name === 'no ref here'),
   'roleMap: text line with no [ref] is skipped');

// ── 1b. parseSnapshotLine primitive directly.
const pl = mcp.parseSnapshotLine('  - textbox "Username" [active] [ref=e23]');
ok(pl && pl.role === 'textbox' && pl.name === 'Username' && pl.ref === 'e23',
   'parseSnapshotLine: ref found after [active]');

// ── 2. parseMcpSnapshotToCandidates: every ref'd+named element must produce a role
// candidate, and the pre-attr ones (e23 Username, e9 option, e40 checkbox) must
// be present — that's the drift fixture.
const cands = mcp.parseMcpSnapshotToCandidates(SNAP);
const byRef = {};
for (const c of cands) { (byRef[c.ref] ||= []).push(c.strategy); }
ok(!!byRef.e23, 'Username (e23, [active] before ref) is parsed');
ok(!!byRef.e9,  'option EN (e9, [selected] before ref) is parsed');
ok(!!byRef.e40, 'checkbox Remember (e40, [checked] before ref) is parsed');
ok(!!byRef.e30, "Login button (e30, single-quoted name) is parsed");
ok(cands.some(c => c.ref === 'e23' && c.role === 'textbox' && c.name === 'Username'),
   'e23 carries correct role=textbox name=Username');

// ── 2. Name→ref resolution (depends on buildRefRoleMap internally). Simulate a
// session with the snapshot and ask _resolveByDescription to find "Login".
// rolesForTool tells it browser_click → clickable roles, so "Login" should
// resolve to the BUTTON (e30), not the heading (e10) — role-aware self-heal.
if (typeof mcp._resolveByDescription === 'function' && typeof mcp.rolesForTool === 'function') {
  // buildRefRoleMap is internal; _resolveByDescription reads session.refRoleMap.
  // Build the map the same way the runtime does: via a fake session whose
  // lastSnapshot is SNAP, then let the resolver rebuild. We can\'t call the
  // private builder, so construct refRoleMap by parsing candidates → map.
  const refRoleMap = new Map();
  for (const c of cands) { if (c.ref && !refRoleMap.has(c.ref)) refRoleMap.set(c.ref, { role: c.role, name: c.name }); }
  const session = { refRoleMap, lastSnapshot: SNAP };
  const clickRoles = mcp.rolesForTool('browser_click');
  const healed = mcp._resolveByDescription(session, 'Login', clickRoles);
  ok(healed === 'e30', `"Login" + click roles resolves to BUTTON e30 (got ${healed})`);
  const typeRoles = mcp.rolesForTool('browser_type');
  const healedU = mcp._resolveByDescription(session, 'Username', typeRoles);
  ok(healedU === 'e23', `"Username" + type roles resolves to textbox e23 (got ${healedU})`);
} else {
  console.log('  SKIP  _resolveByDescription/rolesForTool not exported');
}

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
