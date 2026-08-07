'use strict';
/*
 * CRAWL PLANNER — the Calibrator must be a PLANNED site mapper, not a flat BFS.
 * Locks the deterministic planning logic the live crawl wires in:
 *   - atlas refresh policy (reuse unless a concrete reason justifies recrawl)
 *   - menu-first module plan (every top module visited before deep subpages)
 *   - per-module budget (one module cannot eat the whole crawl)
 *   - composite UI-state key (content-level dedup, not URL-only)
 *   - safe affordance classing (destructive controls are NEVER clicked)
 *   - mode→depth scaling (regression broader than smoke; complete deepest)
 *   - explicit sufficiency verdict (never a silent "ready")
 * Generic, site-agnostic — keyed off ARIA role / URL shape / word-shape only.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'server', 'lib', 'crawlPlanner'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;
const atlas = (over = {}) => ({ startUrl: 'https://app.example.com/web/index.php/dashboard', authProfileId: null, crawlMode: 'standard', completedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), ...over });

console.log('— atlas refresh policy: reuse by default, recrawl only for a reason —');
ok('fresh atlas + normal generate → REUSE (no force)', P.decideAtlasRefresh({ explicitRefresh: false, latestAtlas: atlas(), targetUrl: atlas().startUrl, crawlMode: 'standard', now: NOW, staleMs: DAY }).refresh === false);
ok('explicit rebuild → REFRESH', P.decideAtlasRefresh({ explicitRefresh: true, latestAtlas: atlas(), targetUrl: atlas().startUrl, now: NOW, staleMs: DAY }).refresh === true);
ok('no atlas exists → REFRESH', P.decideAtlasRefresh({ explicitRefresh: false, latestAtlas: null, targetUrl: 'https://x', now: NOW, staleMs: DAY }).refresh === true);
ok('stale atlas → REFRESH', P.decideAtlasRefresh({ explicitRefresh: false, latestAtlas: atlas({ completedAt: new Date(NOW - 3 * DAY).toISOString() }), targetUrl: atlas().startUrl, now: NOW, staleMs: DAY }).refresh === true);
ok('changed target URL → REFRESH', P.decideAtlasRefresh({ explicitRefresh: false, latestAtlas: atlas(), targetUrl: 'https://other.example.com/web/index.php/dashboard', now: NOW, staleMs: DAY }).refresh === true);
ok('changed auth profile → REFRESH', P.decideAtlasRefresh({ explicitRefresh: false, latestAtlas: atlas({ authProfileId: 'ap-1' }), targetUrl: atlas().startUrl, authProfileId: 'ap-2', now: NOW, staleMs: DAY }).refresh === true);
ok('deeper mode than existing (deep > standard) → REFRESH', P.decideAtlasRefresh({ explicitRefresh: false, latestAtlas: atlas({ crawlMode: 'standard' }), targetUrl: atlas().startUrl, crawlMode: 'deep', now: NOW, staleMs: DAY }).refresh === true);
ok('shallower mode than existing (smoke vs deep) → REUSE', P.decideAtlasRefresh({ explicitRefresh: false, latestAtlas: atlas({ crawlMode: 'deep' }), targetUrl: atlas().startUrl, crawlMode: 'shallow', now: NOW, staleMs: DAY }).refresh === false);
// LEGACY atlas policy (crawler-planner): crawlMode=null means the planner NEVER ran —
// it is NOT "standard depth". Such an atlas is legacy and forces exactly one rebuild.
ok('atlas with NO recorded crawlMode + regression → REFRESH (legacy, planner never ran)', (() => { const d = P.decideAtlasRefresh({ explicitRefresh: false, latestAtlas: atlas({ crawlMode: null }), targetUrl: atlas().startUrl, crawlMode: 'standard', now: NOW, staleMs: DAY }); return d.refresh === true && /predates the crawl planner|legacy/i.test(d.reason); })());
ok('atlas with NO recorded crawlMode + complete → REFRESH', P.decideAtlasRefresh({ explicitRefresh: false, latestAtlas: atlas({ crawlMode: null }), targetUrl: atlas().startUrl, crawlMode: 'deep', now: NOW, staleMs: DAY }).refresh === true);
ok('explicit legacyAtlas=true (even WITH a crawlMode) → REFRESH', P.decideAtlasRefresh({ explicitRefresh: false, legacyAtlas: true, latestAtlas: atlas({ crawlMode: 'standard' }), targetUrl: atlas().startUrl, crawlMode: 'standard', now: NOW, staleMs: DAY }).refresh === true);
ok('a fully-planned atlas (crawlMode set, legacyAtlas=false) still REUSES', P.decideAtlasRefresh({ explicitRefresh: false, legacyAtlas: false, latestAtlas: atlas({ crawlMode: 'standard' }), targetUrl: atlas().startUrl, crawlMode: 'standard', now: NOW, staleMs: DAY }).refresh === false);
{
  const d = P.decideAtlasRefresh({ explicitRefresh: false, latestAtlas: atlas(), targetUrl: 'https://other.example.com/x', now: NOW, staleMs: DAY });
  ok('refresh decision carries a human reason', typeof d.reason === 'string' && /target url/i.test(d.reason), d.reason);
}

console.log('\n— mode → crawl depth + budget —');
ok('smoke → shallow, regression → standard, complete → deep, focus → focused',
  P.crawlModeForGenerationMode('smoke') === 'shallow' && P.crawlModeForGenerationMode('regression') === 'standard' && P.crawlModeForGenerationMode('complete') === 'deep' && P.crawlModeForGenerationMode('focus') === 'focused');
ok('functional + security map EXPLICITLY (breadth → standard), not a silent fallback',
  P.crawlModeForGenerationMode('functional') === 'standard' && P.crawlModeForGenerationMode('security') === 'standard');
ok('an unrecognised mode still defaults to standard', P.crawlModeForGenerationMode('totally-unknown') === 'standard' && P.crawlModeForGenerationMode(null) === 'standard');
const bShallow = P.crawlBudget('shallow'); const bStd = P.crawlBudget('standard'); const bDeep = P.crawlBudget('deep'); const bFocus = P.crawlBudget('focused');
ok('regression (standard) covers MORE modules than smoke (shallow)', (bStd.topModules === Infinity || bStd.topModules > bShallow.topModules) && bShallow.topModules <= 5, `${bShallow.topModules} vs ${bStd.topModules}`);
ok('complete (deep) enables deeper tab/panel coverage than standard', bDeep.tabsPerPage > bStd.tabsPerPage && bDeep.openFilters === true && bStd.openFilters === false, JSON.stringify({ deepTabs: bDeep.tabsPerPage, stdTabs: bStd.tabsPerPage }));
ok('deep page cap > standard page cap > shallow page cap', bDeep.totalPageCap > bStd.totalPageCap && bStd.totalPageCap > bShallow.totalPageCap);
ok('focused: focus module deep, others a single page', bFocus.pagesPerModule >= 8 && bFocus.otherPagesPerModule === 1);
ok('no single hard maxPages: every mode has its own budget object', [bShallow, bStd, bDeep, bFocus].every((b) => b.totalPageCap > 0 && b.crawlMode));

console.log('\n— menu-first module planning + per-module budget —');
const nav = [
  { label: 'Admin', url: 'https://app.example.com/web/index.php/admin/viewSystemUsers' },
  { label: 'PIM', url: 'https://app.example.com/web/index.php/pim/viewEmployeeList' },
  { label: 'PIM', url: 'https://app.example.com/web/index.php/pim/addEmployee' }, // same module sub-tree
  { label: 'Leave', url: 'https://app.example.com/web/index.php/leave/viewLeaveList' },
  { label: 'Time', url: 'https://app.example.com/web/index.php/time/viewEmployeeTimesheet' },
  { label: 'Logout', url: 'https://app.example.com/web/index.php/auth/logout' }, // must be dropped
];
const modules = P.planModules(nav, { homeUrl: 'https://app.example.com/web/index.php/dashboard' });
ok('PIM sub-tree links collapse to ONE module', modules.filter((m) => m.segment === 'pim').length === 1, JSON.stringify(modules.map((m) => m.segment)));
ok('Logout is never planned as a module', !modules.some((m) => /logout|auth/.test(m.segment)), JSON.stringify(modules.map((m) => m.segment)));
ok('distinct top modules discovered (admin, pim, leave, time)', new Set(modules.map((m) => m.segment)).size === 4, JSON.stringify(modules.map((m) => m.segment)));
const plan = P.selectInitialPlan(modules, bStd);
ok('menu-first plan visits EVERY module once before any subpage (standard)', plan.length === modules.length);
const planSmoke = P.selectInitialPlan(modules, bShallow);
ok('shallow plan is capped to topModules (≤5)', planSmoke.length <= bShallow.topModules);
{
  const counts = new Map();
  const pimKey = P.moduleKeyForUrl('https://app.example.com/web/index.php/pim/viewEmployeeList', modules);
  ok('moduleKeyForUrl resolves a subpage to its module', !!pimKey, String(pimKey));
  // standard: pagesPerModule = 2 → 3rd page of the same module is over budget
  ok('within budget at 0 visited', P.withinModuleBudget(pimKey, counts, bStd) === true);
  counts.set(pimKey, 2);
  ok('over budget once pagesPerModule reached (one module cannot eat the crawl)', P.withinModuleBudget(pimKey, counts, bStd) === false);
}
{
  // focused: focus module gets the big budget, others just 1
  const fcounts = new Map();
  const pimKey = P.moduleKeyForUrl('https://app.example.com/web/index.php/pim/x', modules);
  fcounts.set(pimKey, 1);
  ok('focused: non-focus module capped at 1 page', P.withinModuleBudget(pimKey, fcounts, bFocus, { isFocus: false }) === false);
  ok('focused: focus module still has budget at 1 page', P.withinModuleBudget(pimKey, fcounts, bFocus, { isFocus: true }) === true);
}

console.log('\n— composite UI-state key (content-level dedup) —');
const baseState = { normalizedUrl: 'https://app.example.com/web/index.php/pim/viewemployeelist', pageRole: 'employee list', heading: 'Employee Information', activeNav: 'PIM', textCorpus: ['First Name', 'Last Name', 'Job Title'] };
const k1 = P.computeStateKey(baseState);
const k1b = P.computeStateKey({ ...baseState, textCorpus: ['Job Title', 'Last Name', 'First Name'] }); // reordered → same
ok('identical content (order-independent) → SAME state key (skip duplicate)', k1 === k1b);
const k2 = P.computeStateKey({ ...baseState, controlSig: 'tab:Job Titles', heading: 'Job Titles', textCorpus: ['Job Title', 'Add', 'Delete'] });
ok('different tab substate on same URL → DIFFERENT state key (record substate)', k1 !== k2);
const k3 = P.computeStateKey({ ...baseState, normalizedUrl: 'https://app.example.com/web/index.php/pim/addemployee', heading: 'Add Employee', textCorpus: ['First Name', 'Middle Name', 'Last Name', 'Save'] });
ok('different page → DIFFERENT state key', k1 !== k3);

console.log('\n— safe affordance classification: destructive NEVER clicked —');
const rows = [
  { role: 'tab', name: 'Job Titles' },
  { role: 'tab', name: 'Pay Grades' },
  { role: 'tab', name: 'Employment Status' },
  { role: 'combobox', name: 'Job Title' },
  { role: 'button', name: 'Filter', flags: {} },
  { role: 'button', name: 'Save', flags: {} },        // destructive
  { role: 'button', name: 'Delete', flags: {} },      // destructive
  { role: 'link', name: 'Logout' },                   // destructive (session)
  { role: 'button', name: 'Add', flags: {} },         // destructive (mutating)
  { role: 'link', name: 'Admin' },                    // nav
  { role: 'button', name: 'Options', flags: { haspopup: true } }, // dropdown
];
const cls = P.classifyAffordances(rows);
ok('Save / Delete / Logout / Add classified DESTRUCTIVE', cls.destructive.length === 4, JSON.stringify(cls.destructive.map((r) => r.name)));
ok('role=tab classified as tab (3 tabs)', cls.tab.length === 3, JSON.stringify(cls.tab.map((r) => r.name)));
ok('Filter classified as filter (safe open+restore)', cls.filter.length === 1 && cls.filter[0].name === 'Filter');
ok('combobox + haspopup-button classified as dropdown', cls.dropdown.length === 2, JSON.stringify(cls.dropdown.map((r) => r.name)));
ok('Admin link classified as nav', cls.nav.length === 1 && cls.nav[0].name === 'Admin');
ok('isSafeToProbe: tab/dropdown/filter yes, destructive/nav no', P.isSafeToProbe('tab') && P.isSafeToProbe('dropdown') && P.isSafeToProbe('filter') && !P.isSafeToProbe('destructive') && !P.isSafeToProbe('nav'));
{
  // deep mode enumerates ALL tabs; destructive is never in the probe set
  const deepTargets = P.selectProbeTargets(rows, bDeep);
  ok('deep mode enumerates ALL safe tabs from the snapshot', deepTargets.tabs.length === 3, JSON.stringify(deepTargets.tabs.map((t) => t.name)));
  ok('probe set NEVER contains a destructive control', ![...deepTargets.tabs, ...deepTargets.probes].some((r) => P.DESTRUCTIVE_NAME_RE.test(r.name) || P.AUTH_LINK_RE.test(r.name)));
  const shallowTargets = P.selectProbeTargets(rows, bShallow);
  ok('shallow mode enumerates NO tabs (tabsPerPage 0)', shallowTargets.tabs.length === 0);
}

console.log('\n— explicit sufficiency verdict (never a silent "ready") —');
ok('0 pages → insufficient (blocks)', P.classifySufficiency({ pagesVisited: 0 }, { crawlMode: 'standard' }).level === 'insufficient');
ok('login required + only login page → insufficient', P.classifySufficiency({ pagesVisited: 1, loginRequired: true, loginSucceeded: false }, { crawlMode: 'standard' }).level === 'insufficient');
{
  const cov = { pagesVisited: 12, modulesDiscovered: 6, modulesVisited: 6, duplicateStatesSkipped: 1, loginRequired: true, loginSucceeded: true };
  ok('all modules mapped → sufficient', P.classifySufficiency(cov, { crawlMode: 'standard' }).level === 'sufficient');
}
{
  const cov = { pagesVisited: 10, modulesDiscovered: 8, modulesVisited: 4, loginSucceeded: true };
  ok('standard mode, half the modules unvisited → partial (warn, no block)', (() => { const s = P.classifySufficiency(cov, { crawlMode: 'standard' }); return s.level === 'partial' && s.block === false; })());
  ok('complete (deep) mode with modules unvisited → partial + BLOCK', (() => { const s = P.classifySufficiency(cov, { crawlMode: 'deep' }); return s.level === 'partial' && s.block === true; })());
}
{
  const cov = { pagesVisited: 6, modulesDiscovered: 3, modulesVisited: 3, duplicateStatesSkipped: 20, loginSucceeded: true };
  const s = P.classifySufficiency(cov, { crawlMode: 'standard' });
  ok('many duplicate states skipped → loop warning surfaced', s.warnings.some((w) => /loop|duplicate/i.test(w)), JSON.stringify(s.warnings));
}
{
  // Fix 5 — tabs DISCOVERED but NONE visited must NOT be "sufficient" (tab panels unmapped).
  const cov = { pagesVisited: 12, modulesDiscovered: 10, modulesVisited: 10, tabsDiscovered: 6, tabsVisited: 0, loginSucceeded: true };
  const sStd = P.classifySufficiency(cov, { crawlMode: 'standard' });
  ok('standard: tabsDiscovered=6/tabsVisited=0 → partial (NOT sufficient), warned, no block', sStd.level === 'partial' && sStd.block === false && sStd.warnings.some((w) => /tab/i.test(w)), JSON.stringify({ lvl: sStd.level, w: sStd.warnings }));
  const sDeep = P.classifySufficiency(cov, { crawlMode: 'deep' });
  ok('deep: tabs discovered but unvisited → partial + BLOCK (complete coverage requested)', sDeep.level === 'partial' && sDeep.block === true, JSON.stringify({ lvl: sDeep.level, block: sDeep.block }));
  const covOk = { pagesVisited: 12, modulesDiscovered: 10, modulesVisited: 10, tabsDiscovered: 6, tabsVisited: 6, loginSucceeded: true };
  ok('tabs discovered AND visited → sufficient', P.classifySufficiency(covOk, { crawlMode: 'standard' }).level === 'sufficient');
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — crawl planner is a planned, generic site mapper: reuse-by-default atlas policy, menu-first module plan, per-module budget, content-level dedup, destructive-safe probing, mode-scaled depth, and an explicit sufficiency verdict.');
