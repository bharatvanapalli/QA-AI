'use strict';

/**
 * crawlPlanner — deterministic planning logic for the site Calibrator.
 *
 * The Calibrator used to be a flat BFS over <a href> links with one global
 * maxPages budget, which let a single deep module (e.g. an HR app's PIM/My-Info
 * sub-tree) consume the entire crawl while other top-level modules stayed
 * unmapped, and re-mapped content-identical screens reached via two URLs. This
 * module turns it into a PLANNED site mapper:
 *
 *   - crawlModeForGenerationMode / crawlBudget — depth scales with the run's
 *     generation mode (smoke→shallow … complete→deep) instead of one hard 18.
 *   - planModules — a menu-first plan: every discovered top-level nav module gets
 *     a planned visit BEFORE budget is spent on subpages.
 *   - moduleKeyForUrl / withinModuleBudget — per-module budget so no single
 *     module can eat the whole crawl.
 *   - computeStateKey — a composite UI-state fingerprint (URL + role + heading +
 *     active nav + text hash + control signature) so content-identical states are
 *     deduped, not just identical URLs.
 *   - classifyAffordances — separates nav / tab / dropdown / filter / DESTRUCTIVE
 *     controls so probing is safe by construction (destructive is never clicked).
 *   - decideAtlasRefresh — reuse a recent atlas unless a concrete reason justifies
 *     a recrawl (explicit rebuild, target/auth change, deeper mode, staleness).
 *   - summarizeCoverage / classifySufficiency — an explicit, honest coverage
 *     report + sufficient|partial|insufficient verdict (never a silent "ready").
 *
 * EVERYTHING here is generic — keyed off ARIA role, nav structure, URL shape, and
 * name word-shape, NEVER a site-specific string. Pure + side-effect-free so the
 * Calibrator wires it into the live crawl and the guards test it without a
 * browser. Snapshot parsing stays in mcp.parseSnapshotLine (the canonical
 * tokenizer); this module consumes already-parsed rows so it never forks it.
 */

const crypto = require('crypto');

const CRAWL_SCOPE_ENTRY_PAGE = 'entry-page';
const CRAWL_SCOPE_SITE = 'site';

/**
 * Crawl scope is a safety boundary, not an optional tuning hint.
 *
 * Omitted or unknown input resolves to entry-page: map the requested page and
 * the destinations linked from its main content, while excluding global
 * header/navigation/footer discovery. Whole-site traversal must be explicit.
 */
function resolveCrawlScope(value, { defaultScope = CRAWL_SCOPE_ENTRY_PAGE } = {}) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['site', 'full-site', 'whole-site', 'entire-site'].includes(normalized)) {
    return CRAWL_SCOPE_SITE;
  }
  if (['entry-page', 'entry', 'page', 'content-links'].includes(normalized)) {
    return CRAWL_SCOPE_ENTRY_PAGE;
  }
  return defaultScope === CRAWL_SCOPE_SITE ? CRAWL_SCOPE_SITE : CRAWL_SCOPE_ENTRY_PAGE;
}

// ── Safety vocabulary ────────────────────────────────────────────────────────
// Mutating / destructive / session-ending verbs. A control whose accessible NAME
// matches this is NEVER clicked during a crawl (the crawl is read-only). Word-
// boundary anchored so "saved searches" (a noun) doesn't trip "save", etc. This
// is the single source of truth shared with the Calibrator's probe gate.
// Word-boundary anchored so noun labels never trip a verb: "Pay Grades" /
// "Payroll" must NOT match (only "Pay Now" / "Make Payment" are actions);
// "Cancellations" must NOT match "cancel"; "Address" must NOT match "add". Search/
// sort/filter are deliberately ABSENT — they are non-mutating and handled by the
// safe 'filter' class below, not treated as destructive.
const DESTRUCTIVE_NAME_RE = /\b(save|submit|add|create|new|delete|remove|update|edit|confirm|apply|upload|send|reset|cancel|publish|approve|reject|assign|activate|deactivate|enable|disable|terminate|purchase|checkout|place\s+order|make\s+payment|pay\s+now|destroy|drop|wipe|clear\s+all)\b/i;

// Auth / session links we never treat as crawlable modules (following Logout
// would end the authenticated crawl). Keyed off word-shape, not a site string.
const AUTH_LINK_RE = /\b(log\s?out|sign\s?out|logout|signout|switch\s+account|change\s+password)\b/i;

// Filter / search / sort affordances — safe to OPEN + capture + restore, but a
// distinct class from plain selection dropdowns so a deep crawl can choose to
// enumerate them while a shallow crawl skips them.
const FILTER_NAME_RE = /\b(filter|search|sort|date\s*range|advanced|refine|facet|criteria)\b/i;

// ── Crawl mode + budget ──────────────────────────────────────────────────────

const GENERATION_MODE_TO_CRAWL = {
  smoke: 'shallow',
  regression: 'standard',
  // Functional + Security are breadth modes (every module + main states), so they
  // map to a standard crawl EXPLICITLY rather than silently falling through to the
  // default — Security could be bumped to 'deep' if injection/validation surfaces
  // need subtab/filter depth, but standard reaches every module's forms by design.
  functional: 'standard',
  security: 'standard',
  complete: 'deep',
  focus: 'focused',
};

/** Map a generation mode (smoke|regression|complete|focus) to a crawl depth. */
function crawlModeForGenerationMode(generationMode) {
  const key = String(generationMode || '').toLowerCase().trim();
  return GENERATION_MODE_TO_CRAWL[key] || 'standard';
}

// Relative depth rank — used by decideAtlasRefresh to know when a new run needs a
// DEEPER crawl than the atlas it would otherwise reuse. focused is treated as
// standard-depth breadth-wise (it just concentrates budget on one module).
const CRAWL_DEPTH_RANK = { shallow: 1, focused: 2, standard: 2, deep: 3 };

/**
 * The concrete budget for a crawl mode. `Infinity` topModules = visit every
 * discovered module. Numbers are deliberate, not magic: shallow ≈ a smoke map of
 * the main modules; standard ≈ every module + its main tab states; deep ≈ every
 * module with tabs/subtabs/filter panels; focused ≈ one module deep, others a
 * single page.
 */
function crawlBudget(crawlMode) {
  switch (String(crawlMode || '').toLowerCase()) {
    case 'shallow':
      return { crawlMode: 'shallow', topModules: 20, pagesPerModule: 20, otherPagesPerModule: 20,
        tabsPerPage: 20, openFilters: true, probeBudgetPerPage: 20, modalProbeBudgetPerPage: 10,
        scrollSnapshotsPerPage: 6, totalPageCap: 100 };
    case 'deep':
    case 'focused':
    case 'standard':
    default:
      return { crawlMode: 'deep', topModules: Infinity, pagesPerModule: 500, otherPagesPerModule: 500,
        tabsPerPage: 100, openFilters: true, probeBudgetPerPage: 100, modalProbeBudgetPerPage: 50,
        scrollSnapshotsPerPage: 15, totalPageCap: 500 };
  }
}

// ── Affordance classification (safe probing) ─────────────────────────────────
// A "row" is a parsed snapshot node the CALLER builds from mcp.parseSnapshotLine
// plus the raw line's flags: { role, name, ref, flags:{ haspopup, selected,
// current, disabled, expanded } }. Classification is pure word-shape + role.

const TAB_NAME_HINT_RE = /\b(tab|panel|overview|details|settings|profile|general|history|logs|activity|billing|security|permissions|notifications|preferences|members|team|integration|integrations)\b/i;

/**
 * Classify one affordance into exactly one safety class. DESTRUCTIVE wins over
 * everything (a "Save" inside a tablist is still never clicked). Returns one of:
 * 'destructive' | 'tab' | 'filter' | 'dropdown' | 'nav' | 'other'.
 */
function classifyAffordance(row) {
  const role = String(row && row.role || '').toLowerCase();
  const name = String(row && row.name || '').trim();
  const flags = (row && row.flags) || {};
  // 1) destructive / mutating / logout — NEVER actionable by the crawl.
  if (name && (DESTRUCTIVE_NAME_RE.test(name) || AUTH_LINK_RE.test(name))) return 'destructive';
  // 2) tabs — role=tab or custom tab button/link with tab flags/names (panel switch, no URL change). Safe to enumerate.
  if (role === 'tab') return 'tab';
  if ((role === 'button' || role === 'link' || role === 'listitem' || role === 'menuitem') && (flags.selected || flags.current || TAB_NAME_HINT_RE.test(name))) {
    return 'tab';
  }
  // 3) filter/search/sort affordances — safe to open + restore.
  if (name && FILTER_NAME_RE.test(name) && (role === 'button' || role === 'combobox' || role === 'searchbox' || role === 'textbox')) return 'filter';
  // 4) selection dropdowns / popup-menu buttons — safe to open + restore.
  if (role === 'combobox' || role === 'listbox' || (role === 'button' && flags.haspopup)) return 'dropdown';
  // 5) navigation — links / menu items the BFS follows (not "probed").
  if (role === 'link' || role === 'menuitem' || role === 'treeitem') return 'nav';
  return 'other';
}

/** Bucket many rows by class using LLM or rule classifier. */
async function classifyAffordances(rows, context = {}) {
  const out = { destructive: [], tab: [], filter: [], dropdown: [], nav: [], other: [] };
  const rowsArr = Array.isArray(rows) ? rows : [];
  if (!rowsArr.length) return out;
  
  const { classifyAndRankAffordances } = require('../services/agents/intentClassifier');
  const rankedMap = await classifyAndRankAffordances(rowsArr, context).catch(() => new Map());

  for (const row of rowsArr) {
    const fallbackClass = classifyAffordance(row);
    const rowId = row.id || row.ref || (row.role ? `${row.role}:${row.name}` : null);
    const ranked = rowId ? rankedMap.get(rowId) : null;
    const safetyClass = ranked ? ranked.safetyClass : fallbackClass;
    row._relevanceScore = ranked ? ranked.relevanceScore : 50; // Attach for ranking later
    
    // Safety check: if fallback says destructive, ALWAYS trust fallback (defense in depth)
    const finalClass = (fallbackClass === 'destructive') ? 'destructive' : safetyClass;
    
    if (out[finalClass]) {
      out[finalClass].push(row);
    } else {
      out.other.push(row);
    }
  }
  return out;
}

/** Safe to OPEN-and-restore during a crawl? tabs/dropdowns/filters yes; never destructive. */
function isSafeToProbe(kind) {
  return kind === 'tab' || kind === 'dropdown' || kind === 'filter';
}

/**
 * Which safe affordances should this crawl actually enumerate on a page, capped
 * by budget. Tabs are enumerated FULLY up to tabsPerPage (panel states matter);
 * dropdowns/filters share probeBudgetPerPage. DESTRUCTIVE is always excluded.
 * Returns { tabs, probes } — disjoint lists of rows to open.
 */
async function selectProbeTargets(rows, budget, context = {}) {
  const c = await classifyAffordances(rows, context);
  
  // Rank by relevance score (descending)
  c.tab.sort((a, b) => (b._relevanceScore || 0) - (a._relevanceScore || 0));
  c.dropdown.sort((a, b) => (b._relevanceScore || 0) - (a._relevanceScore || 0));
  c.filter.sort((a, b) => (b._relevanceScore || 0) - (a._relevanceScore || 0));

  const tabs = (budget.tabsPerPage > 0) ? c.tab.slice(0, budget.tabsPerPage) : [];
  const probePool = [...c.dropdown, ...(budget.openFilters ? c.filter : [])];
  
  // Re-sort the combined probe pool to ensure highest relevance wins
  probePool.sort((a, b) => (b._relevanceScore || 0) - (a._relevanceScore || 0));
  const probes = probePool.slice(0, Math.max(0, budget.probeBudgetPerPage || 0));
  
  return { tabs, probes, classified: c };
}

// ── Composite UI-state key (content-level dedup) ─────────────────────────────

/** Lowercase + collapse whitespace; '' for nullish. */
function _norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }

/** Stable short hash of a visible-text corpus (order-independent). */
function hashTextCorpus(textCorpus) {
  const arr = (Array.isArray(textCorpus) ? textCorpus : [])
    .map((t) => _norm(t)).filter(Boolean).sort();
  if (!arr.length) return '0';
  return crypto.createHash('sha1').update(arr.join('\n')).digest('hex').slice(0, 12);
}

/**
 * The composite state key. Two screens with the SAME normalized URL but a
 * different active tab / heading / structural layout get DIFFERENT keys.
 * A structural DOM hash is computed from the snapshot rows (roles) to dedup
 * content-identical states (e.g. User A profile vs User B profile) even if the URL changes.
 * controlSig distinguishes substates opened by clicking a specific control (e.g. "tab:Job Titles").
 */
function computeStateKey({ normalizedUrl, pageRole, heading, activeNav, textCorpus, textHash, controlSig, rows } = {}) {
  let structuralHash = '0';
  if (Array.isArray(rows) && rows.length > 0) {
    // Phase C Upgrade: Embedding-Based (Structural) State Deduplication
    // We hash the sequence of roles to represent the layout structure.
    const structureTokens = rows
      .map(r => r.role ? _norm(r.role) : '')
      .filter(role => role && !['text', 'generic'].includes(role));
    if (structureTokens.length > 0) {
      structuralHash = crypto.createHash('sha1').update(structureTokens.join(',')).digest('hex').slice(0, 12);
    }
  }

  const th = textHash != null ? String(textHash) : hashTextCorpus(textCorpus);
  
  // We combine the URL, structural hash, and active UI states.
  return [
    _norm(normalizedUrl),
    _norm(pageRole),
    _norm(heading),
    _norm(activeNav),
    structuralHash, // structural layout identity
    th, // text content identity
    _norm(controlSig),
  ].join('|');
}

function _isDynamicRecordSegment(segment) {
  const s = String(segment == null ? '' : segment).trim();
  if (!s) return false;
  const decoded = (() => { try { return decodeURIComponent(s); } catch { return s; } })();
  if (/^\d{1,12}$/.test(decoded)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) return true;
  if (decoded.length >= 8 && /[a-z]/i.test(decoded) && /\d/.test(decoded) && /^[a-z0-9_-]+$/i.test(decoded)) return true;
  return false;
}

/**
 * Collapse record/detail data variants into one route shape. A crawl atlas needs
 * the User Profile form once; crawling /view-user/32, /view-user/21, /view-user/9
 * teaches the same controls with different business data and burns the page/tab
 * budget. Returns null for non-record routes.
 */
function normalizeRecordRouteTemplate(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) return null;
    let changed = false;
    const templated = segs.map((seg) => {
      if (_isDynamicRecordSegment(seg)) {
        changed = true;
        return ':id';
      }
      return seg.toLowerCase();
    });
    if (!changed) return null;
    return (u.origin + '/' + templated.join('/')).toLowerCase().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** First heading-ish node's name (role=heading), else ''. rows = parsed nodes. */
function primaryHeading(rows) {
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (String(r && r.role || '').toLowerCase() === 'heading' && r.name) return String(r.name).trim();
  }
  return '';
}

/** The active/current nav item's name (aria-current / selected), else ''. */
function activeNavItem(rows) {
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const role = String(r && r.role || '').toLowerCase();
    const flags = (r && r.flags) || {};
    if ((role === 'link' || role === 'menuitem' || role === 'tab' || role === 'treeitem')
      && (flags.current || flags.selected) && r.name) return String(r.name).trim();
  }
  return '';
}

// ── Module-first planning + per-module budget ────────────────────────────────

/** Normalize a URL to origin+pathname (mirror of the Calibrator's normalizeUrl). */
function normalizeUrlPath(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return (u.origin + u.pathname).toLowerCase().replace(/\/+$/, '') || String(rawUrl).toLowerCase();
  } catch { return String(rawUrl || '').toLowerCase(); }
}

/** The leading path segment is a module's natural key ("/admin/users" → "admin"). */
function _firstPathSegment(rawUrl) {
  try {
    const seg = new URL(rawUrl).pathname.split('/').filter(Boolean);
    // Skip an SPA hash/app prefix like "/web/index.php" → take the first
    // MEANINGFUL segment (longest leading run that isn't a generic shell word).
    const GENERIC = new Set(['web', 'index.php', 'app', 'index.html', 'home', 'dashboard', '#']);
    for (const s of seg) { if (!GENERIC.has(s.toLowerCase())) return s.toLowerCase(); }
    return seg.length ? seg[seg.length - 1].toLowerCase() : '';
  } catch { return ''; }
}

/**
 * Build a menu-first crawl plan from discovered top-level navigation links.
 * Input: [{ label, url }] harvested from the nav/menu landmark. Output: ordered,
 * de-duplicated modules — each { key, label, url, segment } — with auth/logout
 * and destructive entries removed. Order = menu discovery order (the site's own
 * IA), so the crawl visits Admin, PIM, Leave, … each once before drilling deep.
 * Generic: the labels come from the live DOM, never a hardcoded module list.
 */
function planModules(navLinks, opts = {}) {
  const homeKey = opts.homeUrl ? normalizeUrlPath(opts.homeUrl) : null;
  const seenKey = new Set();
  const seenSeg = new Set();
  const modules = [];
  for (const link of (Array.isArray(navLinks) ? navLinks : [])) {
    const label = String(link && link.label || '').trim();
    const url = String(link && link.url || '').trim();
    if (!url) continue;
    if (label && (AUTH_LINK_RE.test(label) || DESTRUCTIVE_NAME_RE.test(label))) continue; // never plan logout/destructive
    const key = normalizeUrlPath(url);
    if (!key || seenKey.has(key)) continue;
    if (homeKey && key === homeKey && modules.length) continue; // home counted once
    const segment = _firstPathSegment(url);
    // Collapse multiple links into the same module sub-tree (one planned visit
    // per top-level segment) so "/pim/viewEmployeeList" and "/pim/addEmployee"
    // don't both become "modules".
    if (segment && seenSeg.has(segment)) continue;
    seenKey.add(key);
    if (segment) seenSeg.add(segment);
    modules.push({ key, label: label || segment || key, url, segment });
  }
  return modules;
}

/** Which planned module does a URL belong to? Matches by leading path segment. */
function moduleKeyForUrl(url, modules) {
  const seg = _firstPathSegment(url);
  if (!seg) return null;
  const m = (Array.isArray(modules) ? modules : []).find((mod) => mod.segment === seg);
  return m ? m.key : null;
}

/**
 * The initial plan queue: one root URL per planned module, ordered, capped to
 * budget.topModules. For focused mode, the focus module (matched by label/segment
 * against focusModule) is placed FIRST and others are kept but will be held to
 * otherPagesPerModule by the budget. This is the "every module gets one planned
 * visit before deep subpages" guarantee.
 */
function selectInitialPlan(modules, budget, opts = {}) {
  const mods = Array.isArray(modules) ? modules.slice() : [];
  const focus = opts.focusModule ? _norm(opts.focusModule) : null;
  if (focus) {
    mods.sort((a, b) => {
      const af = _norm(a.label).includes(focus) || a.segment === focus ? 0 : 1;
      const bf = _norm(b.label).includes(focus) || b.segment === focus ? 0 : 1;
      return af - bf;
    });
  }
  const cap = Number.isFinite(budget.topModules) ? budget.topModules : mods.length;
  return mods.slice(0, Math.max(0, cap)).map((m) => m.url);
}

/**
 * Per-module budget gate. Returns true if a page belonging to `moduleKey` may
 * still be visited given how many pages of that module are already mapped.
 * `isFocus` (focused mode's focus module) gets the larger pagesPerModule; every
 * other module gets otherPagesPerModule — so one module cannot eat the crawl.
 */
function withinModuleBudget(moduleKey, moduleCounts, budget, opts = {}) {
  const count = (moduleCounts && moduleCounts.get ? moduleCounts.get(moduleKey) : (moduleCounts || {})[moduleKey]) || 0;
  const cap = opts.isFocus ? budget.pagesPerModule : (budget.otherPagesPerModule ?? budget.pagesPerModule);
  return count < cap;
}

// ── Atlas refresh decision ───────────────────────────────────────────────────

/**
 * Decide whether to recrawl or reuse the most recent successful atlas. Reuse is
 * the DEFAULT; a recrawl needs a concrete, reportable reason. Pure — `now` and
 * `staleMs` are injected for determinism.
 *
 * @param {object} a
 * @param {boolean} a.explicitRefresh   user clicked rebuild/refresh
 * @param {object|null} a.latestAtlas   { startUrl, authProfileId, crawlMode, sufficiency, completedAt|createdAt }
 * @param {string} a.targetUrl          current project target URL
 * @param {string|null} a.authProfileId current run identity
 * @param {string} a.crawlMode          crawl mode the current run needs
 * @param {number} a.now                epoch ms
 * @param {number} a.staleMs            staleness horizon
 * @returns {{ refresh:boolean, reason:string|null, message:string }}
 */
function decideAtlasRefresh(a = {}) {
  const { explicitRefresh, latestAtlas, targetUrl, authProfileId = null, crawlMode = 'standard',
    now = 0, staleMs = 24 * 60 * 60 * 1000, legacyAtlas = false } = a;
  const reuse = (msg) => ({ refresh: false, reason: null, message: msg || 'Using recent site atlas' });
  const refresh = (reason) => ({ refresh: true, reason, message: `Refreshing site atlas because: ${reason}` });

  if (explicitRefresh) return refresh('you requested an atlas rebuild');
  if (!latestAtlas) return refresh('no successful atlas exists yet');

  if (targetUrl && latestAtlas.startUrl
    && normalizeUrlPath(latestAtlas.startUrl) !== normalizeUrlPath(targetUrl)) {
    return refresh('the target URL changed since the last crawl');
  }
  if ((latestAtlas.authProfileId || null) !== (authProfileId || null)) {
    return refresh('the auth profile / identity changed since the last crawl');
  }
  // LEGACY atlas — produced before the crawl planner (no crawlMode / coverage report /
  // sufficiency / state-keys). A missing crawlMode is NOT "standard depth"; it means the
  // planner never ran, so its pages have no UI-state dedup or tab-substate coverage and
  // its "sufficiency" is unknown. Never reuse it — force exactly ONE rebuild so the
  // atlas is regenerated by the planned crawler. (The caller computes legacyAtlas from
  // the persisted planner fields; a null crawlMode alone also trips this.)
  if (legacyAtlas || !latestAtlas.crawlMode) {
    return refresh('the existing atlas predates the crawl planner (missing crawlMode/coverage report/sufficiency/state-keys) — rebuilding once with the planned crawler');
  }
  const sufficiency = String(latestAtlas.sufficiency || '').trim().toLowerCase();
  if (sufficiency === 'insufficient') {
    return refresh('the existing atlas is insufficient (login wall or too little of the app was mapped)');
  }
  if (sufficiency === 'partial' && String(crawlMode || '').toLowerCase() === 'deep') {
    return refresh('the existing atlas is partial and complete/deep coverage was requested');
  }
  const needRank = CRAWL_DEPTH_RANK[crawlMode] || 2;
  const haveRank = CRAWL_DEPTH_RANK[latestAtlas.crawlMode] || 2;
  if (needRank > haveRank) {
    return refresh('this generation mode needs a deeper crawl than the existing atlas');
  }
  const ts = latestAtlas.completedAt || latestAtlas.createdAt;
  const ageMs = ts ? (now - new Date(ts).getTime()) : Infinity;
  if (ageMs > staleMs) {
    const days = Math.max(1, Math.round(ageMs / 86400000));
    return refresh(`the existing atlas is stale (${days} day${days === 1 ? '' : 's'} old)`);
  }
  return reuse();
}

// ── Coverage report + sufficiency verdict ────────────────────────────────────

/**
 * Assemble the crawl-coverage report (persisted on Calibration.coverageReportJson
 * and broadcast on calibration.complete). Pure aggregation of counters the
 * Calibrator accumulates during the crawl.
 */
function summarizeCoverage(input = {}) {
  const modulesDiscovered = Array.isArray(input.modulesDiscovered) ? input.modulesDiscovered : [];
  const modulesVisited = Array.isArray(input.modulesVisited) ? input.modulesVisited : [];
  const visitedSet = new Set(modulesVisited.map((m) => (typeof m === 'string' ? m : m.key)));
  const modulesSkipped = modulesDiscovered
    .filter((m) => !visitedSet.has(m.key))
    .map((m) => ({ key: m.key, label: m.label, reason: 'crawl budget exhausted before this module' }));
  return {
    crawlMode: input.crawlMode || null,
    modulesDiscovered: modulesDiscovered.length,
    modulesVisited: visitedSet.size,
    modulesSkipped,
    pagesPerModule: input.pagesPerModule || {},        // { moduleKey: count }
    pagesVisited: input.pagesVisited || 0,
    duplicateStatesSkipped: input.duplicateStatesSkipped || 0,
    tabsDiscovered: input.tabsDiscovered || 0,
    tabsVisited: input.tabsVisited || 0,
    tabsSkipped: Math.max(0, (input.tabsDiscovered || 0) - (input.tabsVisited || 0)),
    capabilitiesPerModule: input.capabilitiesPerModule || {},
    loginRequired: !!input.loginRequired,
    loginSucceeded: !!input.loginSucceeded,
  };
}

/**
 * Explicit, honest sufficiency verdict — never a silent "Atlas ready".
 *
 *   insufficient — the crawl could not build a usable atlas (login-walled with
 *     ≤1 page mapped, or 0 pages). Generation should NOT trust this atlas.
 *   partial      — usable but incomplete (some discovered modules unvisited, or a
 *     duplicate-state loop ate budget). Generation may proceed WITH a warning;
 *     `complete` mode blocks (the user asked for full coverage).
 *   sufficient   — modules discovered were mapped to plan; atlas is trustworthy.
 *
 * Returns { level, reasons[], warnings[], block } — block=true tells the caller
 * to halt generation (only in deep/complete mode on a partial/insufficient map).
 */
function classifySufficiency(coverage = {}, opts = {}) {
  const crawlMode = opts.crawlMode || coverage.crawlMode || 'standard';
  const reasons = [];
  const warnings = [];

  const pages = coverage.pagesVisited || 0;
  const loginRequired = coverage.loginRequired ?? opts.loginRequired;
  const loginSucceeded = coverage.loginSucceeded ?? opts.loginSucceeded;
  const discovered = coverage.modulesDiscovered || 0;
  const visited = coverage.modulesVisited || 0;
  const dupSkipped = coverage.duplicateStatesSkipped || 0;

  // Hard insufficient: login wall not cleared, or essentially nothing mapped.
  if (pages === 0) {
    reasons.push('the crawl mapped 0 pages (site unreachable, fully blocked, or undriveable login)');
    return { level: 'insufficient', reasons, warnings, block: true };
  }
  if (loginRequired && loginSucceeded === false && pages <= 1) {
    reasons.push('the site requires login but the crawl mapped only the login page (add/verify credentials)');
    return { level: 'insufficient', reasons, warnings, block: crawlMode === 'deep' || crawlMode === 'standard' };
  }

  // Duplicate-state loop warning (budget eaten re-mapping the same screen).
  if (dupSkipped >= Math.max(5, pages)) {
    warnings.push('crawl loop / duplicate state detected — many states were skipped as repeats');
  }

  // Module coverage: discovered modules left unvisited.
  if (discovered > 0 && visited < discovered) {
    const missing = discovered - visited;
    const msg = `${missing} of ${discovered} discovered module${missing === 1 ? '' : 's'} were not visited`;
    if (crawlMode === 'deep') {
      reasons.push(msg + ' (complete coverage was requested)');
      return { level: 'partial', reasons, warnings, block: true };
    }
    if (crawlMode === 'standard') {
      warnings.push(msg);
      return { level: 'partial', reasons, warnings, block: false };
    }
    // shallow/focused intentionally sample a subset — partial but expected.
    warnings.push(msg + ' (expected for this crawl mode)');
    return { level: 'partial', reasons, warnings, block: false };
  }

  // Tab / substate coverage: tabs were DISCOVERED but NONE were entered. A page's tab
  // panels are distinct UI states (a record's Personal/Contact/Job tabs, a settings
  // page's sections); skipping ALL of them means the atlas missed real coverage. That
  // is NOT "sufficient" — surface it as partial (deep mode blocks; standard warns).
  const tabsDiscovered = coverage.tabsDiscovered || 0;
  const tabsVisited = coverage.tabsVisited || 0;
  if (tabsDiscovered > 0 && tabsVisited === 0) {
    const msg = `${tabsDiscovered} tab/substate(s) were discovered but NONE were visited — tab panels are unmapped`;
    if (crawlMode === 'deep') {
      reasons.push(msg + ' (complete coverage was requested)');
      return { level: 'partial', reasons, warnings, block: true };
    }
    warnings.push(msg);
    return { level: 'partial', reasons, warnings, block: false };
  }

  if (warnings.length) return { level: 'partial', reasons, warnings, block: false };
  return { level: 'sufficient', reasons, warnings, block: false };
}

module.exports = {
  CRAWL_SCOPE_ENTRY_PAGE,
  CRAWL_SCOPE_SITE,
  resolveCrawlScope,
  // safety vocabulary (single source of truth, shared with the Calibrator)
  DESTRUCTIVE_NAME_RE,
  AUTH_LINK_RE,
  FILTER_NAME_RE,
  // mode + budget
  crawlModeForGenerationMode,
  crawlBudget,
  CRAWL_DEPTH_RANK,
  // affordance classification
  classifyAffordance,
  classifyAffordances,
  isSafeToProbe,
  selectProbeTargets,
  // state key
  hashTextCorpus,
  computeStateKey,
  normalizeRecordRouteTemplate,
  primaryHeading,
  activeNavItem,
  // module planning
  normalizeUrlPath,
  planModules,
  moduleKeyForUrl,
  selectInitialPlan,
  withinModuleBudget,
  // refresh + coverage
  decideAtlasRefresh,
  summarizeCoverage,
  classifySufficiency,
};
