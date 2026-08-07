'use strict';
/**
 * Guard for the two GENERIC authoring-integrity fixes (any website, no hardcoded
 * site strings). Run: node scripts/verify_structural_label_and_titles.cjs
 *
 *  #2 structural-label gate — an ARIA LANDMARK accessible name ("Topbar Menu",
 *     "Sidebar") has zero diagnostic value as a TEXT assertion (it passes
 *     whenever the landmark exists even if the page is broken). It is:
 *       • captured APART from the content corpus at calibration (extractStructuralNames
 *         / extractTextCorpus skips landmark roles), and
 *       • demoted by groundCaseAssertions at ANY criticality (incl. must) via
 *         reason 'structural_label' — the ONLY case that bypasses the never-mask-
 *         a-must rule, justified because the category itself is non-diagnostic.
 *
 *  #1 title integrity — a case name claiming an entity ABSENT while the case's
 *     own assertions verify it PRESENT is a self-contradiction; the clause is
 *     stripped. Legit negative-test titles (entity asserted absent / not
 *     asserted at all) are left intact.
 */
// Load .env first — requiring architect.js transitively pulls vault.js, which
// hard-throws without VAULT_MASTER_KEY. The server loads .env the same way.
const path = require('path');
try { require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', '.env') }); } catch (_) { /* optional */ }

const { groundCaseAssertions } = require('../server/lib/groundAssertions');
const { extractTextCorpus, extractStructuralNames } = require('../server/services/agents/calibrator');
const { sanitizeContradictoryTitles } = require('../server/services/agents/architect');

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`PASS: ${label}`); passed++; }
  else { console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// ── #2a calibrator: landmark names go to structuralNames, NOT the content corpus ──
const SNAP = [
  '- navigation "Topbar Menu":',
  '  - button "User dropdown"',
  '- heading "Dashboard"',
  '- textbox "Username"',
  '- region "Sidebar"',
  '- button "Login"',
].join('\n');
const content = extractTextCorpus(SNAP);
const structural = extractStructuralNames(SNAP);
const has = (arr, v) => arr.map((x) => String(x).toLowerCase()).includes(v.toLowerCase());
check('content corpus keeps real content (Dashboard/Username/Login)', has(content, 'Dashboard') && has(content, 'Username') && has(content, 'Login'), JSON.stringify(content));
check('content corpus EXCLUDES landmark names (Topbar Menu / Sidebar)', !has(content, 'Topbar Menu') && !has(content, 'Sidebar'), JSON.stringify(content));
check('structuralNames CAPTURES landmark names (Topbar Menu / Sidebar)', has(structural, 'Topbar Menu') && has(structural, 'Sidebar'), JSON.stringify(structural));
check('structuralNames EXCLUDES content (Dashboard/Username)', !has(structural, 'Dashboard') && !has(structural, 'Username'), JSON.stringify(structural));

// ── #2b groundCaseAssertions: structural-label demotion at ANY tier ──
const atlas = {
  pages: [{ url: '/x', normalizedUrl: '/x', pageRole: 'dashboard', textCorpus: ['Dashboard', 'Username', 'Search'], elementLabels: [] }],
  allText: ['dashboard', 'username', 'search'],      // 'search' IS real content here
  structuralNames: ['Topbar Menu', 'Sidebar', 'Search'], // 'Search' is ALSO a landmark name
};
const A = (type, criticality, payload) => ({ type, criticality, payload });
function ground(assertions) {
  const r = groundCaseAssertions(assertions, [], atlas, { caseName: 'c' });
  return r.assertions;
}

let r = ground([A('TEXT', 'must', { expectedText: 'Topbar Menu' })]);
check('must-tier landmark TEXT → demoted structural_label', r[0].parseFailed === true && r[0].parseFailedReason === 'structural_label', JSON.stringify(r[0]));

r = ground([A('TEXT', 'should', { expectedText: 'Sidebar' })]);
check('should-tier landmark TEXT → demoted structural_label', r[0].parseFailed === true && r[0].parseFailedReason === 'structural_label');

r = ground([A('TEXT', 'must', { expectedText: 'Dashboard' })]);
check('content TEXT (Dashboard) → untouched', !r[0].parseFailed, JSON.stringify(r[0]));

r = ground([A('TEXT', 'should', { expectedText: 'Search' })]);
check('name that is BOTH landmark AND content (Search) → untouched (not structural-only)', !r[0].parseFailed, JSON.stringify(r[0]));

r = ground([A('FORBIDDEN_TEXT', 'must', { unexpectedText: 'Topbar Menu' })]);
check('FORBIDDEN_TEXT on a landmark → untouched (absence assertion)', !r[0].parseFailed);

// Regression: text_ungrounded must-guard still intact (only structural bypasses it).
r = ground([A('TEXT', 'must', { expectedText: 'Nonexistent Phrase Xyz' })]);
check('must-tier NON-structural ungrounded TEXT → NOT demoted (never-mask-a-must intact)', !r[0].parseFailed, JSON.stringify(r[0]));

// ── #1 title integrity: strip self-contradiction, keep legit negatives ──
const scen = [{
  cases: [
    { name: 'Admin navigation: Admin, PIM, Time, Recruitment modules visible (Leave not present on demo)',
      declaredAssertions: [A('TEXT', 'should', { expectedText: 'Leave' }), A('TEXT', 'should', { expectedText: 'Admin' })] },
    { name: 'Login error banner not shown for valid credentials',
      declaredAssertions: [A('FORBIDDEN_TEXT', 'must', { unexpectedText: 'Invalid credentials' })] },
    { name: 'Dashboard widgets visible — Quick Launch not present',
      declaredAssertions: [A('TEXT', 'should', { expectedText: 'Quick Launch' })] },
    { name: 'Profile page loads correctly',
      declaredAssertions: [A('TEXT', 'should', { expectedText: 'Profile' })] },
  ],
}];
const res = sanitizeContradictoryTitles(scen);
const c = scen[0].cases;
check('contradictory parenthetical stripped (Leave asserted present)', !/leave not present/i.test(c[0].name) && /modules visible/i.test(c[0].name), c[0].name);
check('… but the rest of the title is preserved', /Admin, PIM, Time, Recruitment/i.test(c[0].name), c[0].name);
check('legit negative title (FORBIDDEN, no positive assert) UNTOUCHED', c[1].name === 'Login error banner not shown for valid credentials', c[1].name);
check('contradictory trailing clause stripped (Quick Launch asserted present)', c[2].name === 'Dashboard widgets visible', c[2].name);
check('non-negative title UNTOUCHED', c[3].name === 'Profile page loads correctly', c[3].name);
check('stripped count === 2', res.stripped === 2, `stripped=${res.stripped}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
