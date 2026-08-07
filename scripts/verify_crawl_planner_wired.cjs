'use strict';
/*
 * CRAWL PLANNER WIRING — verify_crawl_planner.cjs proves the planner LOGIC is
 * correct; this proves it is actually WIRED into the live crawl, the route, and
 * the UI (a correct-but-unused planner would still leave the old random BFS +
 * unconditional recrawl in place). Source-level assertions only — dependency-free
 * and deterministic, so it never needs a browser, DB, or env.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const has = (src, ...subs) => subs.every((s) => src.includes(s));

const calibrator = read('server/services/agents/calibrator.js');
const scenarios = read('server/routes/scenarios.js');
const runSuite = read('src/pages/RunSuite.jsx');
const testCases = read('src/pages/TestCases.jsx');

console.log('— calibrator.js wires the planner into the live crawl —');
ok('requires crawlPlanner', has(calibrator, "require('../../lib/crawlPlanner')"));
ok('derives budget from crawl mode', has(calibrator, 'crawlPlanner.crawlBudget(', 'crawlPlanner.crawlModeForGenerationMode'));
ok('menu-first module plan (planModules + selectInitialPlan)', has(calibrator, 'crawlPlanner.planModules(', 'crawlPlanner.selectInitialPlan('));
ok('per-module budget gate (moduleKeyForUrl + withinModuleBudget)', has(calibrator, 'crawlPlanner.moduleKeyForUrl(', 'crawlPlanner.withinModuleBudget('));
ok('module budget actually SKIPS over-budget pages (continue)', /withinModuleBudget[\s\S]{0,400}continue;/.test(calibrator));
ok('composite state-key dedup (computeStateKey + seenStateKeys + duplicateStatesSkipped)', has(calibrator, 'crawlPlanner.computeStateKey(', 'seenStateKeys', 'duplicateStatesSkipped'));
ok('duplicate state actually SKIPS (continue)', /seenStateKeys\.has\(stateKey\)[\s\S]{0,160}continue;/.test(calibrator));
ok('tab substates enumerated', has(calibrator, 'enumerateTabSubstates(', 'tabsDiscovered', 'tabsVisited'));
ok('persists stateKey + substatesJson on the page row', has(calibrator, 'stateKey,', 'substatesJson: JSON.stringify(substates)'));
ok('coverage report + sufficiency computed + persisted', has(calibrator, 'crawlPlanner.summarizeCoverage(', 'crawlPlanner.classifySufficiency(', 'coverageReportJson: JSON.stringify(coverage)', 'sufficiency: sufficiency.level'));
ok('runCalibrator returns the verdict to the caller', /return \{ pagesCount[\s\S]{0,80}sufficiency/.test(calibrator));
ok('tabs removed from the dropdown-probe openers (dedicated path)', has(calibrator, "PROBE_OPENER_ROLES = new Set(['combobox'])"));
ok('the flat global maxPages:18 is gone from the crawl', !calibrator.includes('maxPages = MAX_PAGES'));

console.log('\n— scenarios.js route uses the reuse-vs-refresh decision —');
ok('requires crawlPlanner', has(scenarios, "require('../lib/crawlPlanner')"));
ok('derives crawl mode from generation mode', has(scenarios, 'crawlPlanner.crawlModeForGenerationMode(', 'const crawlMode'));
ok('prefers the STRUCTURED generationMode field over the prose-label regex', has(scenarios, 'req.body?.generationMode'));
ok('UI sends generationMode as a structured field', has(testCases, 'generationMode: depth'));
ok('calls decideAtlasRefresh (no unconditional crawl)', has(scenarios, 'crawlPlanner.decideAtlasRefresh(', 'refreshDecision.refresh'));
ok('passes crawlMode/generationMode/focusModule to the calibrator', has(scenarios, 'crawlMode,', 'generationMode,', 'focusModule:'));
ok('no longer hardcodes maxPages: 18', !scenarios.includes('maxPages: 18'));
ok('surfaces an explicit sufficiency verdict (insufficient/partial)', has(scenarios, "=== 'insufficient'", "=== 'partial'"));
ok('reuse path logs the decision message', has(scenarios, 'refreshDecision.message'));

console.log('\n— RunSuite.jsx no longer force-recrawls on every run —');
ok('does NOT hardcode forceAtlasRefresh: true', !runSuite.includes('forceAtlasRefresh: true'));
ok('forces only when the user opted in', has(runSuite, 'options?.forceAtlasRefresh === true'));

console.log('\n— GenerateConfigCard exposes the explicit rebuild toggle (default off) —');
ok('rebuildAtlas state defaults to false', has(testCases, 'useState(false)') && /rebuildAtlas, setRebuildAtlas\] = useState\(false\)/.test(testCases));
ok('toggle passes forceAtlasRefresh ONLY when on', has(testCases, 'rebuildAtlas ? { forceAtlasRefresh: true }'));
ok('a rebuild switch is rendered (aria-checked={rebuildAtlas})', has(testCases, 'aria-checked={rebuildAtlas}'));

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — the crawl planner is wired end-to-end: live crawl (mode budget, menu-first plan, per-module budget, state-key dedup, tab substates, coverage+sufficiency persist), route (reuse-vs-refresh decision + honest sufficiency), and UI (no unconditional recrawl; explicit rebuild toggle).');
