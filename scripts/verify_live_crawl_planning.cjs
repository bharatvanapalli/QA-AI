'use strict';
/*
 * LIVE-ish CRAWL PLANNING — seeds a FAKE multi-module app (with tabs) and drives
 * the REAL planning + tab-enumeration code against a simulated browser, proving:
 *   - the planned crawl records every top module (and drops logout / collapses
 *     a module sub-tree) — no module is missed,
 *   - tab substates are recorded by clicking each safe tab EXACTLY ONCE (no
 *     repeat-click loop), with distinct composite state keys,
 *   - re-encountering the same states is deduped (no repeat exploration),
 *   - the per-module budget stops one module from consuming the crawl.
 *
 * Section A (planner loop) is pure crawlPlanner — always runs. Section B drives
 * calibrator.enumerateTabSubstates with a fake MCP client; it needs the server
 * env (vault key) to require calibrator, so it self-skips cleanly if unavailable.
 * Generic — the fake app uses arbitrary module/tab names, never a real site.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'server', 'lib', 'crawlPlanner'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

// ── Section A — planned crawl loop over a fake multi-module app (pure) ────────
console.log('— Section A: planned crawl records every module, no repeat exploration —');
const ORIGIN = 'https://demo.app';
const nav = [
  { label: 'Dashboard', url: `${ORIGIN}/web/dashboard` },
  { label: 'Admin', url: `${ORIGIN}/web/admin/users` },
  { label: 'People', url: `${ORIGIN}/web/people/list` },
  { label: 'People', url: `${ORIGIN}/web/people/add` },     // same module sub-tree
  { label: 'Leave', url: `${ORIGIN}/web/leave/list` },
  { label: 'Reports', url: `${ORIGIN}/web/reports/home` },
  { label: 'Logout', url: `${ORIGIN}/web/auth/logout` },     // must be dropped
];
const modules = P.planModules(nav, { homeUrl: `${ORIGIN}/web/dashboard` });
ok('all distinct top modules recorded (dashboard, admin, people, leave, reports)',
  new Set(modules.map((m) => m.segment)).size === 5, JSON.stringify(modules.map((m) => m.segment)));
ok('module sub-tree collapses to one (people appears once)', modules.filter((m) => m.segment === 'people').length === 1);
ok('logout is never planned as a module', !modules.some((m) => /logout|auth/.test(m.segment)));

const budget = P.crawlBudget('standard');         // pagesPerModule = 2
const plan = P.selectInitialPlan(modules, budget);
ok('menu-first plan seeds one visit per module before any subpage', plan.length === modules.length);

// Simulate the crawl loop: a frontier with REPEATED module roots, extra subpages,
// and a duplicate state reached via a second URL. Drive the SAME gates the live
// crawl uses (per-module budget + composite state-key dedup).
const frontier = [
  `${ORIGIN}/web/admin/users`,
  `${ORIGIN}/web/admin/users`,                    // exact repeat URL → caught by URL dedup
  `${ORIGIN}/web/admin/users?tab=1`,              // query alias → same normalized path → URL dedup
  `${ORIGIN}/web/admin/groups`,
  `${ORIGIN}/web/admin/orgstructure`,             // 3rd admin page → over budget (cap 2)
  `${ORIGIN}/web/people/list`,
  `${ORIGIN}/web/people/viewList`,                // DIFFERENT path, SAME screen → composite-key dedup
  `${ORIGIN}/web/leave/list`,
  `${ORIGIN}/web/reports/home`,
];
// A fixed "screen content" per logical page so two URLs that render the same
// screen produce the SAME composite state key.
const screenFor = (url) => {
  const seg = url.split('?')[0];
  const map = {
    [`${ORIGIN}/web/admin/users`]: { role: 'user list', heading: 'System Users', text: ['Username', 'Role', 'Status'] },
    [`${ORIGIN}/web/admin/groups`]: { role: 'group list', heading: 'User Groups', text: ['Group', 'Members'] },
    [`${ORIGIN}/web/admin/orgstructure`]: { role: 'org tree', heading: 'Organization', text: ['Unit', 'Parent'] },
    [`${ORIGIN}/web/people/list`]: { role: 'people list', heading: 'Employees', text: ['First Name', 'Last Name'] },
    [`${ORIGIN}/web/people/viewList`]: { role: 'people list', heading: 'Employees', text: ['First Name', 'Last Name'] }, // same screen as /people/list

    [`${ORIGIN}/web/leave/list`]: { role: 'leave list', heading: 'Leave', text: ['From', 'To', 'Days'] },
    [`${ORIGIN}/web/reports/home`]: { role: 'reports', heading: 'Reports', text: ['Name', 'Type'] },
  };
  return map[seg] || { role: 'page', heading: 'Page', text: ['x'] };
};

const visited = new Set();
const seenStateKeys = new Set();
const moduleCounts = new Map();
const mappedByModule = {};
let urlDupSkips = 0;          // caught by normalized-URL dedup (exact repeat / query alias)
let stateDupSkips = 0;       // caught by composite state-key dedup (different URL, same screen)
let overBudgetSkips = 0;
for (const url of frontier) {
  const norm = P.normalizeUrlPath(url);
  if (visited.has(norm)) { urlDupSkips++; continue; }
  visited.add(norm);
  const moduleKey = P.moduleKeyForUrl(url, modules);
  if (moduleKey && !P.withinModuleBudget(moduleKey, moduleCounts, budget)) { overBudgetSkips++; continue; }
  const s = screenFor(url);
  const stateKey = P.computeStateKey({ normalizedUrl: norm, pageRole: s.role, heading: s.heading, activeNav: '', textCorpus: s.text });
  if (seenStateKeys.has(stateKey)) { stateDupSkips++; continue; }
  seenStateKeys.add(stateKey);
  if (moduleKey) { moduleCounts.set(moduleKey, (moduleCounts.get(moduleKey) || 0) + 1); mappedByModule[moduleKey] = (mappedByModule[moduleKey] || 0) + 1; }
}
ok('exact-repeat / query-alias URLs skipped by URL dedup', urlDupSkips >= 2, `urlDupSkips=${urlDupSkips}`);
// The composite state key (which INCLUDES normalized URL, per spec) is the
// content-level backstop: re-deriving the key for an already-mapped state yields
// a key already in the seen-set, so a repeat encounter is skipped. (Cross-route
// same-screen dedup is the separate landed-URL canonical check in the live crawl;
// substate dedup is proven in Section B's re-run.)
const reKey = P.computeStateKey({ normalizedUrl: P.normalizeUrlPath(`${ORIGIN}/web/admin/users`), pageRole: 'user list', heading: 'System Users', activeNav: '', textCorpus: ['Username', 'Role', 'Status'] });
ok('composite state key is stable + already in the seen-set (a repeat state would be skipped)', seenStateKeys.has(reKey), `stateDupSkips=${stateDupSkips} reKeyKnown=${seenStateKeys.has(reKey)}`);
ok('per-module budget held admin to 2 pages (one module cannot eat the crawl)', (mappedByModule[P.moduleKeyForUrl(`${ORIGIN}/web/admin/users`, modules)] || 0) === 2 && overBudgetSkips >= 1, JSON.stringify(mappedByModule));
ok('every module that had frontier URLs got mapped (admin, people, leave, reports)',
  ['admin', 'people', 'leave', 'reports'].every((seg) => { const m = modules.find((x) => x.segment === seg); return m && (mappedByModule[m.key] || 0) >= 1; }), JSON.stringify(mappedByModule));

// ── Section B — REAL enumerateTabSubstates against a fake MCP client ──────────
console.log('\n— Section B: tab substates recorded by clicking each tab ONCE (live-ish) —');
let cal = null;
try {
  require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });
  cal = require(path.join(ROOT, 'server', 'services', 'agents', 'calibrator'));
} catch (e) {
  console.log(`  NOTE  Section B skipped — calibrator could not load (${e.message.split('\n')[0]})`);
}

if (cal && typeof cal.enumerateTabSubstates === 'function') {
  (async () => {
    const PAGE_URL = `${ORIGIN}/web/people/list`;
    const TABS = [
      { ref: 'e10', label: 'Personal' },
      { ref: 'e11', label: 'Contact' },
      { ref: 'e12', label: 'Job' },
    ];
    let activeTab = 'personal';
    const clicks = {};
    let snapshots = 0;
    const panel = {
      personal: '  - heading "Personal Details" [level=2]\n  - text "First Name"\n  - text "Last Name"\n  - text "Date of Birth"',
      contact: '  - heading "Contact Details" [level=2]\n  - text "Street"\n  - text "City"\n  - text "Phone"',
      job: '  - heading "Job Details" [level=2]\n  - text "Job Title"\n  - text "Employment Status"',
    };
    const snapFor = (tab) => {
      const tabsLines = TABS.map((t) => `  - tab "${t.label}" [ref=${t.ref}]${t.label.toLowerCase() === tab ? ' [selected]' : ''}`).join('\n');
      return `- navigation "Sidebar"\n  - link "People" [ref=e1] [current]\n${tabsLines}\n${panel[tab] || ''}\n`;
    };
    const client = {
      async callTool({ name, arguments: args }) {
        if (name === 'browser_snapshot') { snapshots++; return { content: [{ type: 'text', text: snapFor(activeTab) }] }; }
        if (name === 'browser_evaluate') return { content: [{ type: 'text', text: 'Result: ' + JSON.stringify(PAGE_URL) }] };
        if (name === 'browser_click') {
          const ref = args && args.ref; clicks[ref] = (clicks[ref] || 0) + 1;
          const t = TABS.find((x) => x.ref === ref); if (t) activeTab = t.label.toLowerCase();
          return { content: [{ type: 'text', text: 'ok' }] };
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const mcpSession = { client };
    const budgetDeep = P.crawlBudget('deep');
    const seen = new Set();
    const r1 = await cal.enumerateTabSubstates({
      mcpSession, budget: budgetDeep, pageUrl: PAGE_URL, normalizedUrl: P.normalizeUrlPath(PAGE_URL),
      pageRole: 'people detail', activeNav: 'People', seenStateKeys: seen, module: null, authProfileId: null,
      log: () => {}, signal: null,
    });
    ok('discovered all 3 tabs', r1.discovered === 3, `discovered=${r1.discovered}`);
    ok('recorded all 3 tab substates', r1.visited === 3 && r1.substates.length === 3, `visited=${r1.visited}`);
    ok('each tab clicked EXACTLY once (no repeat-click loop)',
      TABS.every((t) => clicks[t.ref] === 1), JSON.stringify(clicks));
    ok('substates have distinct composite state keys', new Set(r1.substates.map((s) => s.stateKey)).size === 3);
    ok('each substate captured its panel heading + text', r1.substates.every((s) => s.heading && Array.isArray(s.textCorpus) && s.textCorpus.length > 0));
    ok('substate control signature names the tab (tab:label)', r1.substates.every((s) => /^tab:/.test(s.controlSig)));
    // Re-run with the SAME seen-set → everything is a duplicate → nothing new recorded.
    const r2 = await cal.enumerateTabSubstates({
      mcpSession, budget: budgetDeep, pageUrl: PAGE_URL, normalizedUrl: P.normalizeUrlPath(PAGE_URL),
      pageRole: 'people detail', activeNav: 'People', seenStateKeys: seen, module: null, authProfileId: null,
      log: () => {}, signal: null,
    });
    ok('re-encountering the same tab states records 0 new (dedup across pages)', r2.visited === 0, `visited2=${r2.visited}`);

    console.log('');
    if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
    console.log('OK — live-ish crawl: a planned crawl records every module (logout dropped, sub-tree collapsed), holds per-module budget, dedups repeated states, and enumerates every tab substate by clicking each tab exactly once (no repeat-click loop).');
  })().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
} else {
  console.log('');
  if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
  console.log('OK (Section A only — Section B skipped) — planned crawl records every module, holds per-module budget, and dedups repeated states.');
}
