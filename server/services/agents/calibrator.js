'use strict';

/**
 * E4 — Calibrator MVP
 *
 * Pre-run site crawl that maps pages and elements before the Architect
 * generates scenarios. Produces a PageManifest per URL stored in
 * CalibrationPage rows.
 *
 * What it does:
 * 1. Opens a Playwright MCP session (optionally with an auth fixture)
 * 2. Navigates to the startUrl, takes a snapshot
 * 3. Extracts interactive elements from the snapshot
 * 4. Classifies the page role via a single LLM call
 * 5. Follows navigation links breadth-first up to maxPages
 * 6. Persists CalibrationPage rows
 * 7. Broadcasts WS events: calibration.page.complete, calibration.complete
 *
 * The Architect reads calibration data via getCalibrationContext().
 * The Conductor uses it via resolveCalibrationSelector().
 */

const crypto = require('crypto');
const prisma = require('../../prisma');
const mcp = require('../mcp');
const sessionRegistry = require('../sessionRegistry');
const cancelRegistry = require('../cancelRegistry');
const { getProvider } = require('../../lib/llmProvider');
const { resolveAiCredentials } = require('../../lib/resolveAiCredentials');
const { classifyCapabilities } = require('./atlasCapabilities');
const atlasSlice = require('../../lib/atlasSlice');
const { recordDegradation } = require('../../lib/degradationSignal');
const crawlPlanner = require('../../lib/crawlPlanner');

const MAX_PAGES = 20;
const PAGE_ROLE_MAX_TOKENS = 60; // a 2-4 word label is tiny; cap discourages rambling
const AUTH_INITIAL_SETTLE_MS = Number.parseInt(process.env.QAAI_AUTH_INITIAL_SETTLE_MS || '15000', 10);
const AUTH_STAGE_SETTLE_MS = Number.parseInt(process.env.QAAI_AUTH_STAGE_SETTLE_MS || '10000', 10);

/**
 * Normalise a URL for deduplication: strip query + hash, lowercase origin+path.
 */
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return (u.origin + u.pathname).toLowerCase().replace(/\/$/, '') || rawUrl.toLowerCase();
  } catch {
    return rawUrl.toLowerCase();
  }
}

/**
 * Extract the accessibility tree snapshot text from an MCP tool result.
 */
function snapshotText(toolResult) {
  if (!toolResult?.content) return '';
  if (Array.isArray(toolResult.content)) {
    return toolResult.content.map((c) => (typeof c === 'object' ? c.text || '' : String(c))).join('\n');
  }
  return String(toolResult.content || '');
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const err = new Error('Calibration cancelled');
  err.code = 'CANCELLED';
  throw err;
}

function cancellableDelay(ms, signal) {
  if (!signal?.addEventListener) {
    throwIfAborted(signal);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      const err = new Error('Calibration cancelled');
      err.code = 'CANCELLED';
      reject(err);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Route every Calibrator MCP call through the shared MCP boundary.
 *
 * The MCP client is protected by ActionExecutionGateway. Calling
 * session.client.callTool() directly works for observations, but mutating
 * tools such as browser_navigate/click/evaluate are intentionally rejected.
 * Keeping one adapter here prevents crawl helpers from accidentally bypassing
 * that safety boundary while still giving each mutation an auditable source.
 */
async function callCalibratorTool(mcpSession, request, options = {}) {
  if (!request?.name) {
    const err = new Error('Calibrator MCP request requires a tool name.');
    err.code = 'CALIBRATOR_MCP_TOOL_REQUIRED';
    throw err;
  }
  const result = await mcp.callTool(
    mcpSession,
    request.name,
    request.arguments || {},
    { source: 'calibrator_crawl', ...options },
  );
  if (result?.isError) {
    const detail = mcp.textOfContent(result.content) || 'The browser tool returned an unspecified error.';
    const err = new Error(`${request.name} failed: ${detail}`);
    err.code = 'CALIBRATOR_MCP_TOOL_ERROR';
    err.toolName = request.name;
    throw err;
  }
  return result;
}

function buildZeroPageCrawlError(startUrl, pageFailures = [], degradations = []) {
  const firstFailure = pageFailures.find((failure) => failure?.message);
  const firstDegradation = degradations.find((degradation) => degradation?.reason);
  const detail = firstFailure?.message || firstDegradation?.reason || 'No page snapshot could be persisted.';
  const err = new Error(`Crawl of ${startUrl} mapped 0 pages. First cause: ${detail}`);
  err.code = 'CALIBRATION_ZERO_PAGES';
  err.pageFailures = pageFailures.slice(0, 20);
  return err;
}

// Interactive / meaningful roles worth recording as targetable elements.
const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'option', 'searchbox', 'spinbutton', 'switch', 'tab', 'treeitem']);

// The capability classifier (P3a) needs STRUCTURAL roles in addition to the
// interactive controls: table rows / column headers / cells / list items reveal
// an entity_collection ("pick the row with the least price"), and dialogs reveal
// a modal. These are NOT persisted into elementsJson (the conductor + Architect
// atlas want targetable controls only) — they are extracted into a SEPARATE,
// wider set passed only to classifyCapabilities. parseMcpSnapshotToCandidates
// already emits a durable getByRole(...) candidate for any named line, so a row
// like `row "iPhone 17 black 999"` yields a cross-session selector.
const CLASSIFIER_ROLES = new Set([...INTERACTIVE_ROLES,
  'row', 'gridcell', 'cell', 'columnheader', 'rowheader', 'listitem', 'dialog', 'alertdialog']);

/**
 * Parse interactive elements from a Playwright MCP accessibility snapshot.
 *
 * Delegates to mcp.parseMcpSnapshotToCandidates — the SAME parser the Conductor
 * and healer rely on — instead of a bespoke regex. The previous local regex
 * required `"label" [ref=xxx]` to be ADJACENT, but @playwright/mcp emits other
 * attributes between them (e.g. `[active]`, `[cursor=pointer]`), so it matched
 * nothing and every page recorded zero elements. Generic rule: one snapshot
 * parser for the whole system — the Calibrator must not fork it.
 *
 * Candidates arrive one-per-(element,strategy); we group them by ref (the
 * stable in-session element identity) into one ElementRecord with a
 * stability-ranked selectorChain.
 */
function extractElements(snap, roleFilter = INTERACTIVE_ROLES) {
  const candidates = mcp.parseMcpSnapshotToCandidates(snap) || [];
  const byKey = new Map();
  for (const c of candidates) {
    const role = (c.role || '').toLowerCase();
    if (!roleFilter.has(role)) continue;
    const key = c.ref || `${role}:${c.name}`;
    if (!byKey.has(key)) byKey.set(key, { role, name: c.name || '', ref: c.ref || null, chain: [] });
    byKey.get(key).chain.push({
      selector: c.expression,           // Playwright API form, e.g. getByRole("button", { name: "Login" })
      strategy: c.strategy,
      verified: false,
      stabilityScore: (typeof c.stability === 'number' ? c.stability : 50) / 100,
    });
  }
  const elements = [];
  for (const g of byKey.values()) {
    // Session-scoped ref as a low-stability verified fallback (valid in-session only).
    if (g.ref) g.chain.push({ selector: `ref=${g.ref}`, strategy: 'mcp-ref', verified: true, stabilityScore: 0.3 });
    g.chain.sort((a, b) => b.stabilityScore - a.stabilityScore);
    elements.push({
      semanticLabel: `${g.role} "${g.name}"`,
      selectorChain: g.chain,
      ariaRole: g.role,
      parentContext: '',
    });
  }
  return elements;
}

// ── Deeper crawl: NON-MUTATING interactive probe ─────────────────────────────
// Opens SAFE, non-committing affordances on a mapped page — custom dropdowns
// (combobox), tabs, and popup-menu buttons (avatar/overflow) — to capture the
// vocabulary they REVEAL (option values, menu items) that the static a11y
// snapshot can't see (a closed dropdown's options don't exist in the DOM until
// it opens). SAFE BY CONSTRUCTION: (1) an allow-list of opener roles + a
// deny-list of mutation/destructive verbs in the name, (2) it only OPENS and
// READS — it never selects an option, submits, or clicks inside the overlay,
// (3) it RESTORES (Escape) after each and HARD-RESETS by re-navigating if the
// URL changed or before leaving the page. Best-effort + capped; any anomaly
// skips that affordance and never breaks the crawl. The revealed options/items
// enrich the atlas vocabulary (data-value grounding for the Architect + option
// locators for the Conductor). Keyed off ARIA role + name shape — never a site
// string.
const PROBE_DENY_NAME_RE = /\b(save|submit|add|create|delete|remove|update|edit|confirm|apply|upload|send|reset|cancel|search|download|export|import|publish|approve|reject|assign|activate|deactivate|log\s?out|sign\s?out|logout|signout|new)\b/i;
const MODAL_OPENER_NAME_RE = /\b(view|details?|more|info|preview|open|show|expand|inspect|history|activity|notes?)\b/i;
// Tabs are NOT here: they get dedicated, fully-enumerated substate capture via
// enumerateTabSubstates (each tab → its own recorded state). This probe handles
// only selection dropdowns + popup-menu buttons (reveal-vocabulary openers).
const PROBE_OPENER_ROLES = new Set(['combobox']);
const REVEAL_ROLES = new Set(['option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'listitem', 'tab', 'treeitem']);

function countRevealRoles(snap) {
  let total = 0;
  for (const line of String(snap || '').split(/\r?\n/)) {
    const p = mcp.parseSnapshotLine ? mcp.parseSnapshotLine(line) : null;
    if (p && REVEAL_ROLES.has(String(p.role || '').toLowerCase())) total += 1;
  }
  return total;
}

function normalizeSameOriginUrls(rawUrls, baseOrigin) {
  const links = [];
  for (const href of (Array.isArray(rawUrls) ? rawUrls : [])) {
    if (typeof href !== 'string') continue;
    try {
      const u = new URL(href, baseOrigin);
      if (u.origin !== baseOrigin) continue;
      if (_ASSET_RE.test(u.pathname)) continue;
      links.push(u.origin + u.pathname);
    } catch { /* ignore malformed */ }
  }
  return [...new Set(links)];
}

function isSafeModalOpenerRow(row) {
  if (!row || !row.ref || row.flags?.disabled) return false;
  const role = String(row.role || '').toLowerCase();
  const name = String(row.name || '').trim();
  if (!name || PROBE_DENY_NAME_RE.test(name)) return false;
  if (!['button', 'link', 'menuitem'].includes(role)) return false;
  return !!(row.flags?.haspopup || MODAL_OPENER_NAME_RE.test(name));
}

function createCrawlActionLedger(log = null) {
  const seen = new Set();
  const normalizePart = (part) => String(part == null ? '' : part)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 160);
  return {
    markOnce(parts = [], label = 'crawl action') {
      const key = (Array.isArray(parts) ? parts : [parts]).map(normalizePart).join('|');
      if (seen.has(key)) {
        if (log) log('info', `[calibrator] action-ledger skip duplicate ${label}`);
        return false;
      }
      seen.add(key);
      return true;
    },
    size() {
      return seen.size;
    },
  };
}

async function probeInteractiveAffordances({ mcpSession, baselineSnap, pageUrl, log, signal, maxProbes = 6, actionLedger = null } = {}) {
  const revealedElements = [];
  const revealedText = [];
  if (!baselineSnap || !mcpSession || !mcpSession.client) return { revealedElements, revealedText, probes: 0 };

  // Candidate openers: a ref + an opener role (combobox/tab) or a popup-menu
  // button, whose NAME is NOT a mutation/destructive verb (the primary gate).
  const candidates = [];
  for (const line of String(baselineSnap).split(/\r?\n/)) {
    const p = mcp.parseSnapshotLine ? mcp.parseSnapshotLine(line) : null;
    if (!p || !p.ref) continue;
    const role = String(p.role || '').toLowerCase();
    const name = String(p.name || '').trim();
    const hasPopup = /haspopup/i.test(line);
    const isOpener = PROBE_OPENER_ROLES.has(role) || (role === 'button' && hasPopup);
    if (!isOpener) continue;
    if (name && PROBE_DENY_NAME_RE.test(name)) continue;  // never touch mutation/destructive/logout controls
    candidates.push({ ref: p.ref, role, name });
    if (candidates.length >= maxProbes) break;
  }
  if (!candidates.length) return { revealedElements, revealedText, probes: 0 };

  const baseReveal = countRevealRoles(baselineSnap);
  const baseKey = normalizeUrl(pageUrl);
  const seenItem = new Set();
  let probes = 0;

  for (const cand of candidates) {
    if (signal?.aborted) break;
    try {
      // OPEN via the RAW client → bypasses the QAAI evidence gate (we hold a live
      // ref from the snapshot we just read, so this is never a blind click).
      if (actionLedger && !actionLedger.markOnce(
        ['probe', baseKey, cand.role, cand.name || '', cand.ref || ''],
        `probe "${cand.name || cand.role || cand.ref}" on ${baseKey}`,
      )) {
        continue;
      }
      await callCalibratorTool(mcpSession, { name: 'browser_click', arguments: { element: cand.name || cand.role, ref: cand.ref } });
      probes += 1;
      await cancellableDelay(450, signal);
      const afterSnap = snapshotText(await callCalibratorTool(mcpSession, { name: 'browser_snapshot', arguments: {} }));

      // MUTATION GUARD — an opener must NOT navigate. If the URL changed, treat
      // it as unsafe: hard-reset and skip (we never commit a state change).
      let landed = '';
      try {
        const hrefRes = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: '() => location.href' } });
        landed = mcp.parseEvaluateReturnValue(mcp.textOfContent(hrefRes && hrefRes.content) || '');
      } catch (_) { landed = ''; }
      if (landed && typeof landed === 'string' && normalizeUrl(landed) !== baseKey) {
        if (log) log('info', `[calibrator] probe "${cand.name || cand.role}" navigated away — restoring + skipping (non-mutating probe only).`);
        try { await callCalibratorTool(mcpSession, { name: 'browser_navigate', arguments: { url: pageUrl } }); await cancellableDelay(700, signal); } catch (_) {}
        continue;
      }

      // CAPTURE the revealed option/menu items (delta vs baseline) — READ only.
      if (countRevealRoles(afterSnap) > baseReveal) {
        for (const line of String(afterSnap).split(/\r?\n/)) {
          const p = mcp.parseSnapshotLine ? mcp.parseSnapshotLine(line) : null;
          if (!p || !p.ref) continue;
          const role = String(p.role || '').toLowerCase();
          if (!REVEAL_ROLES.has(role)) continue;
          const name = String(p.name || '').trim();
          if (!name || name.length > 80) continue;
          const itemKey = `${role}:${name.toLowerCase()}`;
          if (seenItem.has(itemKey)) continue;
          seenItem.add(itemKey);
          if (!revealedText.includes(name)) revealedText.push(name);
          revealedElements.push({
            semanticLabel: `${role} "${name}"`,
            selectorChain: [{ selector: `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`, strategy: 'role', verified: false, stabilityScore: 0.5 }],
            ariaRole: role,
            parentContext: cand.name || '',
            revealedBy: cand.name || cand.role,
          });
        }
      }

      // RESTORE (best-effort): Escape closes dropdowns/menus/dialogs without committing.
      try { await callCalibratorTool(mcpSession, { name: 'browser_press_key', arguments: { key: 'Escape' } }); await cancellableDelay(200, signal); } catch (_) {}
    } catch (probeErr) {
      if (probeErr?.code === 'CANCELLED' || signal?.aborted) throw probeErr;
      // A failed probe must never break the crawl — fall through to the next.
    }
  }

  // GUARANTEED RESTORE — re-navigate so link extraction and the next BFS page
  // start from the clean baseline regardless of any tab switch / overlay left open.
  if (probes > 0) {
    try { await callCalibratorTool(mcpSession, { name: 'browser_navigate', arguments: { url: pageUrl } }); await cancellableDelay(700, signal); } catch (_) {}
  }
  if (revealedText.length && log) {
    log('info', `[calibrator] interactive probe revealed ${revealedText.length} option/menu value(s) from ${probes} affordance(s) on ${pageUrl}`);
  }
  return { revealedElements, revealedText, probes };
}

async function harvestPageInteriorViaScroll({
  mcpSession,
  pageUrl,
  baseOrigin,
  log,
  signal,
  maxScrolls = 0,
  contentOnlyLinks = false,
} = {}) {
  const textCorpus = [];
  const elements = [];
  let links = [];
  let snapshots = 0;
  if (!mcpSession || !mcpSession.client || !maxScrolls) return { textCorpus, elements, links, snapshots };

  const metricsFn = '() => ({ scrollHeight: Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0), clientHeight: window.innerHeight || document.documentElement.clientHeight || 0, y: window.scrollY || 0 })';
  let metrics = null;
  try {
    const res = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: metricsFn } });
    metrics = mcp.parseEvaluateReturnValue(mcp.textOfContent(res && res.content) || '');
  } catch { metrics = null; }
  const scrollHeight = Number(metrics?.scrollHeight || 0);
  const clientHeight = Number(metrics?.clientHeight || 0);
  const maxY = Math.max(0, scrollHeight - clientHeight);
  if (!maxY || scrollHeight < clientHeight * 1.25) return { textCorpus, elements, links, snapshots };

  const seenText = new Set();
  const seenElement = new Set();
  for (let i = 1; i <= Math.max(1, maxScrolls); i++) {
    throwIfAborted(signal);
    const y = Math.min(maxY, Math.round((maxY * i) / Math.max(1, maxScrolls)));
    try {
      await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: `() => { window.scrollTo(0, ${Number(y) || 0}); return window.scrollY || 0; }` } });
      await cancellableDelay(350, signal);
      const snap = snapshotText(await callCalibratorTool(mcpSession, { name: 'browser_snapshot', arguments: {} }));
      if (!snap) continue;
      snapshots += 1;
      for (const t of extractTextCorpus(snap)) {
        if (!seenText.has(t)) {
          seenText.add(t);
          textCorpus.push(t);
        }
      }
      for (const el of extractElements(snap)) {
        const key = el.selectorChain?.[0]?.selector || el.semanticLabel;
        if (!key || seenElement.has(key)) continue;
        seenElement.add(key);
        elements.push({ ...el, source: el.source || 'scroll-snapshot' });
      }
    } catch (err) {
      if (err?.code === 'CANCELLED' || signal?.aborted) throw err;
    }
  }

  try {
    const linkRes = await callCalibratorTool(mcpSession, {
      name: 'browser_evaluate',
      arguments: {
        function: contentOnlyLinks
          ? '() => Array.from((document.querySelector("main, [role=\\"main\\"]") || document.body).querySelectorAll("a[href]")).filter(a => !a.closest("header, nav, aside, footer, [role=\\"navigation\\"]")).map(a => a.href)'
          : '() => Array.from(document.querySelectorAll("a[href]")).map(a => a.href)',
      },
    });
    const arr = mcp.parseEvaluateReturnValue(mcp.textOfContent(linkRes && linkRes.content) || '');
    links = normalizeSameOriginUrls(Array.isArray(arr) ? arr : [], baseOrigin);
  } catch { links = []; }

  try {
    await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: '() => { window.scrollTo(0, 0); return window.scrollY || 0; }' } });
    await cancellableDelay(150, signal);
  } catch { /* best-effort restore */ }

  if (snapshots && log) {
    log('info', `[calibrator] page interior scroll harvested ${textCorpus.length} text value(s), ${elements.length} element(s), ${links.length} link(s) from ${snapshots} scroll state(s) on ${pageUrl}`);
  }
  return { textCorpus, elements, links, snapshots };
}

async function probeModalAffordances({
  mcpSession, baselineSnap, pageUrl, normalizedUrl, pageRole, activeNav,
  seenStateKeys, module, authProfileId, log, signal, maxModals = 0, actionLedger = null,
} = {}) {
  const revealedElements = [];
  const revealedText = [];
  const substates = [];
  if (!baselineSnap || !mcpSession || !mcpSession.client || !maxModals) {
    return { revealedElements, revealedText, substates, probed: 0 };
  }

  let freshSnap = baselineSnap;
  try {
    freshSnap = snapshotText(await callCalibratorTool(mcpSession, { name: 'browser_snapshot', arguments: {} })) || baselineSnap;
  } catch { freshSnap = baselineSnap; }
  const rows = parseSnapshotRows(freshSnap);
  const candidates = rows.filter(isSafeModalOpenerRow).slice(0, Math.max(0, maxModals));
  if (!candidates.length) return { revealedElements, revealedText, substates, probed: 0 };

  const baseKey = normalizeUrl(pageUrl);
  const seenText = new Set();
  const seenElement = new Set();
  let probed = 0;
  let captured = 0;
  let navigated = 0;
  let noDialog = 0;

  for (const cand of candidates) {
    if (signal?.aborted) break;
    try {
      if (actionLedger && !actionLedger.markOnce(
        ['modal', baseKey, cand.role || '', cand.name || '', cand.ref || ''],
        `modal opener "${cand.name || cand.ref}" on ${baseKey}`,
      )) {
        continue;
      }
      await callCalibratorTool(mcpSession, { name: 'browser_click', arguments: { element: cand.name || cand.role || 'modal opener', ref: cand.ref } });
      probed += 1;
      await cancellableDelay(500, signal);

      let landed = '';
      try {
        const hrefRes = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: '() => location.href' } });
        landed = mcp.parseEvaluateReturnValue(mcp.textOfContent(hrefRes && hrefRes.content) || '');
      } catch { landed = ''; }
      if (landed && typeof landed === 'string' && normalizeUrl(landed) !== baseKey) {
        navigated += 1;
        try { await callCalibratorTool(mcpSession, { name: 'browser_navigate', arguments: { url: pageUrl } }); await cancellableDelay(600, signal); } catch (_) {}
        continue;
      }

      const modalSnap = snapshotText(await callCalibratorTool(mcpSession, { name: 'browser_snapshot', arguments: {} }));
      const modalRows = parseSnapshotRows(modalSnap);
      const hasDialog = modalRows.some((r) => ['dialog', 'alertdialog'].includes(String(r.role || '').toLowerCase()))
        || /\b(aria-modal|role=["']dialog["']|role=["']alertdialog["'])/i.test(modalSnap);
      if (!hasDialog) {
        noDialog += 1;
        try { await callCalibratorTool(mcpSession, { name: 'browser_press_key', arguments: { key: 'Escape' } }); await cancellableDelay(150, signal); } catch (_) {}
        continue;
      }

      const modalText = extractTextCorpus(modalSnap);
      const heading = crawlPlanner.primaryHeading(modalRows) || cand.name || 'modal';
      const controlSig = `modal:${String(cand.name || cand.ref || '').toLowerCase()}`;
      const stateKey = crawlPlanner.computeStateKey({ normalizedUrl, pageRole, heading, activeNav, textCorpus: modalText, controlSig });
      if (seenStateKeys && seenStateKeys.has(stateKey)) {
        try { await callCalibratorTool(mcpSession, { name: 'browser_press_key', arguments: { key: 'Escape' } }); await cancellableDelay(150, signal); } catch (_) {}
        continue;
      }
      if (seenStateKeys) seenStateKeys.add(stateKey);

      const modalElements = extractElements(modalSnap);
      let modalCaps = [];
      try {
        modalCaps = (classifyCapabilities({
          elements: extractElements(modalSnap, CLASSIFIER_ROLES), textCorpus: modalText,
          snapshot: modalSnap, pageUrl: normalizedUrl, module, authProfileId,
        }).capabilities) || [];
      } catch { modalCaps = []; }
      for (const t of modalText) {
        if (!seenText.has(t)) {
          seenText.add(t);
          revealedText.push(t);
        }
      }
      for (const el of modalElements) {
        const key = el.selectorChain?.[0]?.selector || el.semanticLabel;
        if (!key || seenElement.has(key)) continue;
        seenElement.add(key);
        revealedElements.push({ ...el, source: el.source || 'modal-probe', revealedBy: cand.name || cand.role });
      }
      substates.push({
        kind: 'modal',
        modalLabel: cand.name || '',
        controlSig,
        stateKey,
        heading,
        textCorpus: modalText.slice(0, 120),
        elements: modalElements,
        capabilities: modalCaps,
      });
      captured += 1;
      try { await callCalibratorTool(mcpSession, { name: 'browser_press_key', arguments: { key: 'Escape' } }); await cancellableDelay(200, signal); } catch (_) {}
    } catch (modalErr) {
      if (modalErr?.code === 'CANCELLED' || signal?.aborted) throw modalErr;
    }
  }

  if (probed > 0) {
    try { await callCalibratorTool(mcpSession, { name: 'browser_navigate', arguments: { url: pageUrl } }); await cancellableDelay(600, signal); } catch (_) {}
  }
  if (log && probed) {
    log('info', `[calibrator] modal substates on ${pageUrl}: ${captured}/${probed} captured`
      + (captured < probed ? ` (${navigated} navigated, ${noDialog} no dialog, ${probed - captured - navigated - noDialog} skipped/errored)` : ''));
  }
  return { revealedElements, revealedText, substates, probed };
}

// Roles whose accessible "name" is layout noise rather than page copy — we do
// NOT want these polluting the text corpus the Architect reads / the gate
// checks against.
// ARIA LANDMARK roles. Their accessible NAME is structural scaffolding ("Topbar
// Menu", "Primary Navigation", "Sidebar", "Main Content") — invisible to sighted
// users and present whenever the landmark exists even if the page is broken, so
// it has ZERO diagnostic value as a TEXT assertion. Captured SEPARATELY by
// extractStructuralNames and EXCLUDED from the content corpus below so a landmark
// label is never grounded as real visible content. Generic W3C ARIA vocabulary,
// NOT site-specific copy — the gate keys off ROLE, never a hardcoded string.
const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'complementary',
  'contentinfo', 'region', 'search', 'form']);

const TEXT_SKIP_ROLES = new Set(['generic', 'none', 'presentation', 'separator',
  'img', 'image', 'figure', 'graphics-symbol', 'list', 'listitem', 'group',
  ...LANDMARK_ROLES]);

/**
 * Collect the VISIBLE TEXT of a page from its accessibility snapshot: every
 * meaningful node's accessible name (headings, labels, column headers, static
 * text, AND the labels of controls) plus input placeholders, deduped
 * case-insensitively.
 *
 * This is the complement to extractElements() — that keeps only INTERACTIVE
 * controls, so form labels and column headers like "Employee Name" / "First
 * Name" never entered the atlas and a TEXT assertion could not be grounded
 * against anything. The corpus is THE ground truth a TEXT/PAGE assertion is
 * verified against, and what lets the Architect see a page's real labels
 * instead of guessing them. Reuses the canonical parseSnapshotLine tokenizer —
 * NO bespoke regex, NO parser fork (the parser-drift lesson).
 */
function extractTextCorpus(snap) {
  if (!snap || typeof snap !== 'string') return [];
  const seen = new Set();
  const out = [];
  const push = (s) => {
    const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (!v || v.length > 160) return;          // drop empties + paragraph-length blobs
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  for (const line of snap.split(/\r?\n/)) {
    if (out.length >= 500) break;              // hard cap — a page's label set is small
    const p = mcp.parseSnapshotLine(line);
    if (!p) continue;
    if (TEXT_SKIP_ROLES.has((p.role || '').toLowerCase())) continue;
    if (p.name) push(p.name);
    if (p.placeholder) push(p.placeholder);
  }
  return out;
}

/**
 * Collect this page's ARIA LANDMARK accessible names (navigation/region/banner/
 * complementary/contentinfo/search/form/main labels). These are structural
 * scaffolding, NOT visible content — asserting one as TEXT passes whenever the
 * landmark exists even if the page is broken (zero diagnostic value), which is
 * exactly the "expectedText: Topbar Menu" trap. Captured APART from the content
 * corpus so the structural-label gate (groundAssertions) can demote any TEXT
 * assertion whose expectedText is ONLY a landmark name — generically, on any
 * site, keyed off ARIA role. Same canonical parseSnapshotLine tokenizer — no
 * parser fork (the [[buildrefrolemap-parser-drift]] lesson).
 */
function extractStructuralNames(snap) {
  if (!snap || typeof snap !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const line of snap.split(/\r?\n/)) {
    if (out.length >= 100) break;              // a page has few landmarks
    const p = mcp.parseSnapshotLine(line);
    if (!p || !p.name) continue;
    if (!LANDMARK_ROLES.has((p.role || '').toLowerCase())) continue;
    const v = String(p.name).replace(/\s+/g, ' ').trim();
    if (!v || v.length > 80) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// Heuristic field finders for a deterministic form login. Operate on
// parseMcpSnapshotToCandidates output ({ role, name, ref, strategy, ... }).
function pickField(cands, roleRe, nameRe) {
  const inputs = cands.filter((c) => roleRe.test((c.role || '').toLowerCase()) && c.ref);
  return inputs.find((c) => nameRe.test(`${c.name || ''}`)) || inputs[0] || null;
}

/**
 * Enrich snapshot lines into login-field candidates carrying role+name+ref AND
 * the structural hints the accessible NAME alone misses: input placeholder and
 * the ARIA label projected by parseSnapshotLine. A bare a11y "name" is often
 * empty on a password input (the visible label is a sibling <label>, not the
 * input's accessible name), so #29's username/password regexes never matched and
 * the crawl fell back to positional-only guessing. Folding placeholder/idAttr/
 * testid into one searchable `hint` string lets the SAME generic regex key off
 * any of those structural signals — never a hardcoded site string. De-duped by
 * ref so each input appears once with its first (canonical) snapshot row.
 */
function enrichLoginCandidates(snap) {
  if (!snap || typeof snap !== 'string') return [];
  const byRef = new Map();
  let order = 0;
  for (const line of snap.split(/\r?\n/)) {
    const p = mcp.parseSnapshotLine(line);
    if (!p || !p.ref) continue;
    if (byRef.has(p.ref)) continue;
    const hint = [p.name, p.placeholder, p.testid, p.idAttr].filter(Boolean).join(' ');
    byRef.set(p.ref, {
      role: (p.role || '').toLowerCase(),
      name: p.name || '',
      ref: p.ref,
      placeholder: p.placeholder || '',
      disabled: /\bdisabled\b/i.test(p.rest || ''),
      hint,
      order: order++,
    });
  }
  return [...byRef.values()];
}

// True when a snapshot has the structural signature of a NON-form-login wall —
// an identity-first / SSO / OAuth / passwordless flow where no same-origin
// password input exists. Generic: keyed off ROLE shape (a single text field with
// a continue/next/SSO button and ZERO password-like input), never a site string.
// Used only to label the degradation reason; the crawl still proceeds.
function looksLikeFederatedLogin(enriched) {
  const inputs = enriched.filter((c) => /textbox|searchbox|combobox/.test(c.role));
  const hasPasswordLike = enriched.some((c) => /pass|pwd|secret/i.test(c.hint));
  const ssoButton = enriched.some((c) => c.role === 'button'
    && /\b(continue|next|sso|single sign|use\s+\w+|sign in with|microsoft|google|okta|saml|oauth)\b/i.test(c.hint));
  // One-or-zero visible inputs + an advance/SSO button + no password field is the
  // canonical identity-first / federated shape.
  return !hasPasswordLike && ssoButton && inputs.length <= 2;
}

const AUTH_INPUT_RE = /textbox|searchbox|combobox/;
const AUTH_USER_RE = /user|email|login|account|signin|sign[-_ ]?in|phone|mobile/i;
const AUTH_PASSWORD_RE = /pass|pwd|secret/i;
const AUTH_SUBMIT_RE = /\b(log\s*in|sign\s*in|submit|continue|enter|next|verify)\b/i;
const AUTH_PROVIDER_RE = /\b(sign\s*in\s*with|continue\s*with|sso|single\s*sign|microsoft|google|okta|saml|oauth|identity\s*provider|work\s+or\s+school|corporate)\b/i;
const AUTH_PROMPT_TEXT_RE = /\b(stay\s+signed\s+in|keep\s+me\s+signed\s+in|remember\s+this\s+device|trust\s+this\s+browser|permissions\s+requested|consent)\b/i;
const AUTH_PROMPT_BUTTON_RE = /\b(no|not\s+now|skip|continue|yes|accept|ok|done)\b/i;
const HARD_AUTH_CHALLENGE_RE = /\b(multi[-\s]?factor|mfa|2fa|two[-\s]?step|authenticator|verification\s+code|enter\s+code|one[-\s]?time|otp|captcha|security\s+key|approve\s+sign[-\s]?in|text\s+message|phone\s+call)\b/i;
const AUTH_SCREEN_TEXT_RE = /\b(sign\s*in|log\s*in|login|email\s+address|email,\s*phone,\s*or\s*skype|enter\s+your\s+email|password|continue|next|microsoft|google|okta|sso|single\s*sign)\b/i;
const STRICT_AUTH_IDENTIFIER_RE = /\b(email,\s*phone,\s*or\s*skype|valid\s+email\s+address|microsoft\s+account|work\s+or\s+school)\b/i;
const AUTH_IDENTIFIER_ERROR_RE = /\b(enter\s+a\s+valid\s+email|valid\s+email\s+address|email\s+is\s+required|enter\s+your\s+email|phone\s+number,\s*or\s*skype\s+name|required\s+email|invalid\s+email)\b/i;

function uniqueByRef(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    if (!item?.ref) continue;
    if (seen.has(item.ref)) continue;
    seen.add(item.ref);
    out.push(item);
  }
  return out;
}

function findClickableCandidate(enriched, cands, nameRe) {
  const fromEnriched = uniqueByRef(enriched).filter((c) => /button|link|menuitem/.test(c.role || '') && nameRe.test(`${c.hint || ''} ${c.name || ''}`));
  if (fromEnriched.length) return fromEnriched[0];
  const fromCands = uniqueByRef(cands).filter((c) => /button|link|menuitem/.test((c.role || '').toLowerCase()) && nameRe.test(`${c.name || ''}`));
  return fromCands[0] || null;
}

function findPostLoginPromptButton(snap, enriched, cands) {
  if (!AUTH_PROMPT_TEXT_RE.test(String(snap || ''))) return null;
  const clickables = uniqueByRef([...(enriched || []), ...(cands || [])])
    .filter((c) => /button|link|menuitem/.test((c.role || '').toLowerCase()) && c.ref);
  return clickables.find((c) => /^no$/i.test(`${c.name || c.hint || ''}`.trim()))
    || clickables.find((c) => AUTH_PROMPT_BUTTON_RE.test(`${c.name || ''} ${c.hint || ''}`))
    || null;
}

function allowPositionalPasswordFallback(snap, { userField, submit, providerButton, inputs } = {}) {
  if (!userField || !Array.isArray(inputs) || inputs.length < 2) return false;
  const pageText = String(snap || '');
  const submitLabel = `${submit?.name || ''} ${submit?.hint || ''}`;
  if (AUTH_PASSWORD_RE.test(pageText)) return true;
  if (providerButton) return false;
  if (AUTH_IDENTIFIER_ERROR_RE.test(pageText)) return false;
  if (STRICT_AUTH_IDENTIFIER_RE.test(pageText)) return false;
  if (/\bnext\b/i.test(submitLabel)) return false;
  return /\b(log\s*in|login|sign\s*in)\b/i.test(submitLabel);
}

function locateLoginControls(snap) {
  const cands = mcp.parseMcpSnapshotToCandidates(snap) || [];
  const enriched = enrichLoginCandidates(snap);
  const inputs = enriched.filter((c) => AUTH_INPUT_RE.test(c.role));
  const explicitUserField = inputs.find((c) => AUTH_USER_RE.test(c.hint)) || null;
  const submit = findClickableCandidate(enriched, cands, AUTH_SUBMIT_RE);
  const providerButton = findClickableCandidate(enriched, cands, AUTH_PROVIDER_RE);

  let userField = explicitUserField || null;
  if (!userField && (submit || providerButton || inputs.length === 1)) {
    userField = inputs.find((c) => !AUTH_PASSWORD_RE.test(c.hint)) || null;
  }

  const pwByHint = inputs.find((c) => AUTH_PASSWORD_RE.test(c.hint) && c.ref !== userField?.ref);
  const positionalPasswordAllowed = allowPositionalPasswordFallback(snap, { userField, submit, providerButton, inputs });
  const pwField = pwByHint
    || (positionalPasswordAllowed
      ? (inputs.find((c) => c.ref !== userField?.ref && userField && c.order > userField.order)
        || inputs.find((c) => c.ref !== userField?.ref && userField)
        || null)
      : null)
    || null;

  const promptButton = findPostLoginPromptButton(snap, enriched, cands);
  const authButton = submit || providerButton;
  const isLoginLike = !!pwField
    || !!providerButton
    || !!promptButton
    || (!!authButton && (!!explicitUserField || inputs.length <= 2))
    || looksLikeFederatedLogin(enriched);

  return {
    snap,
    cands,
    enriched,
    inputs,
    explicitUserField,
    userField,
    pwField,
    submit,
    providerButton,
    promptButton,
    isLoginLike,
  };
}

function describeLoginControls(controls) {
  const userField = controls?.userField;
  const pwField = controls?.pwField;
  const submit = controls?.submit;
  const provider = controls?.providerButton;
  return `user=${userField ? `${userField.role}"${userField.name}"${userField.disabled ? '[disabled]' : ''}@${userField.ref}` : 'NONE'} `
    + `pw=${pwField ? `${pwField.role}"${pwField.name}"@${pwField.ref}` : 'NONE'} `
    + `submit=${submit ? `"${submit.name || submit.hint || ''}"@${submit.ref}` : 'NONE'} `
    + `provider=${provider ? `"${provider.name || provider.hint || ''}"@${provider.ref}` : 'NONE'}`;
}

function authScreenFingerprint(snap) {
  return String(snap || '')
    .toLowerCase()
    .replace(/\[ref=e\d+\]/g, '[ref]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function authActionKey(kind, controls, parts = []) {
  return [
    kind,
    ...parts.map((part) => String(part || '')),
    authScreenFingerprint(controls && controls.snap),
  ].join(':');
}

function isHardAuthChallengeSnapshot(snap) {
  return HARD_AUTH_CHALLENGE_RE.test(String(snap || ''));
}

function snapshotStillLooksAuth(controls) {
  if (!controls) return false;
  if (isHardAuthChallengeSnapshot(controls.snap) && !controls.pwField) return true;
  return !!controls.isLoginLike;
}

function authControlsLookActionable(controls) {
  return !!(controls && (
    controls.isLoginLike
    || (Array.isArray(controls.inputs) && controls.inputs.length > 0)
    || controls.providerButton
    || controls.promptButton
  ));
}

function authDomHint(elements = [], snap = '') {
  if (AUTH_SCREEN_TEXT_RE.test(String(snap || ''))) return true;
  return (Array.isArray(elements) ? elements : []).some((el) => AUTH_SCREEN_TEXT_RE.test([
    el.semanticLabel,
    el.label,
    el.name,
    el.text,
    el.elementKind,
  ].filter(Boolean).join(' ')));
}

function authIdentifierUsableForScreen(value, snap = '') {
  const text = String(value == null ? '' : value).trim();
  if (!text || /change_me|placeholder|example\.com|dummy|sample|null|undefined/i.test(text)) return false;
  if (!STRICT_AUTH_IDENTIFIER_RE.test(String(snap || ''))) return true;
  return text.includes('@') || /^[+\d][\d\s().-]{5,}$/.test(text);
}

function authFieldAppearsFilled(field, expectedValue = '') {
  if (!field) return false;
  const label = `${field.name || ''} ${field.hint || ''}`.trim();
  const expected = String(expectedValue || '').trim().toLowerCase();
  if (expected && label.toLowerCase().includes(expected)) return true;
  return /\b\S+@\S+\.\S+\b/.test(label) || /^[+\d][\d\s().-]{5,}$/.test(label);
}

function shouldClickProviderBeforeIdentifier(controls, userValue, submittedIdentifier = false) {
  if (!controls || !controls.providerButton || controls.pwField) return false;
  const userField = controls.userField || null;
  if (!userField) return true;
  if (userField.disabled) return true;
  if (submittedIdentifier) return true;
  return authFieldAppearsFilled(userField, userValue);
}

function authScreenHasIdentifierError(controls) {
  return AUTH_IDENTIFIER_ERROR_RE.test(String(controls?.snap || ''));
}

function classifyAuthScreenObservation(controls, {
  userValue = '',
  identifierState = null,
  submittedIdentifier = false,
  submittedPassword = false,
  clickedProvider = false,
} = {}) {
  if (!controls) {
    return { state: 'unknown', action: 'stop', reason: 'no_controls' };
  }
  if ((submittedPassword || clickedProvider || submittedIdentifier) && !snapshotStillLooksAuth(controls)) {
    return { state: 'authenticated_or_left_auth', action: 'success', reason: 'auth_controls_absent_after_progress' };
  }
  if (isHardAuthChallengeSnapshot(controls.snap) && !controls.pwField) {
    return { state: 'hard_auth_challenge', action: 'block', reason: 'mfa_otp_captcha_or_security_challenge' };
  }
  if (controls.promptButton) {
    return { state: 'post_login_prompt', action: 'click_prompt', reason: 'safe_prompt_button_present' };
  }

  const identifierField = controls.userField || null;
  const identifierFilled = !!(
    (identifierState && identifierState.hasExpected)
    || authFieldAppearsFilled(identifierField, userValue)
  );
  const identifierError = authScreenHasIdentifierError(controls);
  const identifierEditable = !!(identifierField && !identifierField.disabled);

  if (identifierEditable && (identifierError || (!identifierFilled && /\bnext\b/i.test(`${controls.submit?.name || ''} ${controls.submit?.hint || ''}`)))) {
    return {
      state: 'identifier_required',
      action: 'enter_identifier',
      reason: identifierError
        ? 'screen_reports_missing_or_invalid_identifier'
        : 'identifier_field_empty_before_next',
      identifierFilled,
      identifierError,
      identifierState,
    };
  }

  if (controls.pwField) {
    return {
      state: 'password_required',
      action: 'enter_password',
      reason: identifierField && !identifierFilled && !submittedIdentifier
        ? 'password_screen_with_identifier_field_needs_identifier_first'
        : 'password_field_present',
      identifierFilled,
      identifierError,
      identifierState,
    };
  }

  if (controls.providerButton && (!identifierField || identifierField.disabled || identifierFilled)) {
    return {
      state: 'provider_handoff',
      action: 'click_provider',
      reason: !identifierField
        ? 'provider_button_without_identifier_field'
        : (identifierField.disabled ? 'identifier_field_disabled_or_prefilled' : 'identifier_verified_before_provider'),
      identifierFilled,
      identifierError,
      identifierState,
    };
  }

  if (identifierEditable && (identifierError || !identifierFilled || controls.submit || controls.isLoginLike)) {
    return {
      state: 'identifier_required',
      action: 'enter_identifier',
      reason: identifierError
        ? 'screen_reports_missing_or_invalid_identifier'
        : (identifierFilled ? 'identifier_field_present_with_advance' : 'identifier_field_empty_or_unverified'),
      identifierFilled,
      identifierError,
      identifierState,
    };
  }

  if (controls.providerButton) {
    return {
      state: 'provider_handoff',
      action: 'click_provider',
      reason: 'provider_button_is_only_driveable_auth_action',
      identifierFilled,
      identifierError,
      identifierState,
    };
  }

  if (!snapshotStillLooksAuth(controls)) {
    return { state: 'authenticated_or_left_auth', action: 'success', reason: 'auth_controls_absent' };
  }

  return {
    state: 'auth_unknown',
    action: 'block',
    reason: 'auth_like_screen_without_safe_next_action',
    identifierFilled,
    identifierError,
    identifierState,
  };
}

async function callAuthTool(mcpSession, name, args) {
  const result = await mcp.callTool(mcpSession, name, args);
  if (result?.isError) {
    const detail = mcp.textOfContent(result.content) || `${name} failed`;
    throw new Error(detail);
  }
  return result;
}

async function readAuthIdentifierDomState(mcpSession, expectedValue = '') {
  const expectedJson = JSON.stringify(String(expectedValue || '').trim());
  const fn = `() => {
    const expected = ${expectedJson};
    const norm = (value) => String(value || '').trim().toLowerCase();
    const expectedNorm = norm(expected);
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const labelText = (el) => {
      const id = el.id ? String(el.id) : '';
      const labels = [];
      if (el.labels) for (const label of el.labels) labels.push(label.textContent || '');
      if (id) {
        const byFor = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (byFor) labels.push(byFor.textContent || '');
      }
      return [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('name'),
        el.getAttribute('id'),
        el.getAttribute('autocomplete'),
        ...labels,
      ].filter(Boolean).join(' ');
    };
    const score = (el) => {
      const hay = labelText(el).toLowerCase();
      let s = 0;
      if (/email|e-mail|phone|skype|user|account|login|work or school/.test(hay)) s += 10;
      if (/password|passcode|pwd/.test(hay)) s -= 20;
      if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') s -= 20;
      if (document.activeElement === el) s += 5;
      if (el.value && expectedNorm && norm(el.value) === expectedNorm) s += 30;
      return s;
    };
    const fields = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
      .filter(visible)
      .map((el, index) => ({
        el,
        index,
        score: score(el),
        value: el.isContentEditable ? el.textContent || '' : el.value || '',
        disabled: !!(el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true'),
        label: labelText(el),
        type: el.getAttribute('type') || '',
      }))
      .filter((row) => !/password|hidden|submit|button/i.test(row.type || '') && !/password|passcode|pwd/i.test(row.label || ''))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const best = fields[0] || null;
    if (!best) return { found: false, hasExpected: false, empty: true };
    return {
      found: true,
      hasExpected: !!expectedNorm && norm(best.value) === expectedNorm,
      empty: !String(best.value || '').trim(),
      value: String(best.value || '').slice(0, 180),
      disabled: best.disabled,
      label: String(best.label || '').slice(0, 180),
      active: document.activeElement === best.el,
      candidateCount: fields.length,
    };
  }`;
  try {
    const res = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: fn } });
    const parsed = mcp.parseEvaluateReturnValue(mcp.textOfContent(res && res.content) || '');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function fillAuthIdentifierViaDom(mcpSession, expectedValue = '') {
  const expectedJson = JSON.stringify(String(expectedValue || '').trim());
  const fn = `() => {
    const expected = ${expectedJson};
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const labelText = (el) => {
      const id = el.id ? String(el.id) : '';
      const labels = [];
      if (el.labels) for (const label of el.labels) labels.push(label.textContent || '');
      if (id) {
        const byFor = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (byFor) labels.push(byFor.textContent || '');
      }
      return [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('name'),
        el.getAttribute('id'),
        el.getAttribute('autocomplete'),
        ...labels,
      ].filter(Boolean).join(' ');
    };
    const score = (el) => {
      const hay = labelText(el).toLowerCase();
      let s = 0;
      if (/email|e-mail|phone|skype|user|account|login|work or school/.test(hay)) s += 10;
      if (/password|passcode|pwd/.test(hay)) s -= 30;
      if (document.activeElement === el) s += 5;
      return s;
    };
    const fields = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
      .filter((el) => visible(el) && !(el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true'))
      .filter((el) => !/password|hidden|submit|button/i.test(el.getAttribute('type') || '') && !/password|passcode|pwd/i.test(labelText(el)))
      .sort((a, b) => score(b) - score(a));
    const el = fields[0] || null;
    if (!el) return { ok: false, reason: 'no_editable_identifier_field' };
    el.focus();
    if (el.isContentEditable) {
      el.textContent = expected;
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, expected);
      else el.value = expected;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: expected }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      ok: true,
      value: el.isContentEditable ? el.textContent || '' : el.value || '',
      label: labelText(el).slice(0, 180),
    };
  }`;
  try {
    const res = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: fn } });
    const parsed = mcp.parseEvaluateReturnValue(mcp.textOfContent(res && res.content) || '');
    return parsed && typeof parsed === 'object' ? parsed : { ok: false, reason: 'unparseable_dom_fill_result' };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : 'dom_fill_failed' };
  }
}

async function ensureAuthIdentifierEntered(mcpSession, controls, userValue, log, signal) {
  if (!controls?.userField?.ref) return { ok: false, reason: 'no_identifier_field' };
  if (controls.userField.disabled) return { ok: false, reason: 'identifier_field_disabled' };
  if (!authIdentifierUsableForScreen(userValue, controls.snap)) return { ok: false, reason: 'invalid_identifier_value' };
  if (authFieldAppearsFilled(controls.userField, userValue)) return { ok: true, source: 'snapshot_name' };

  await callAuthTool(mcpSession, 'browser_type', {
    element: controls.userField.name || controls.userField.hint || 'Username field',
    target: controls.userField.ref,
    text: userValue,
  });
  await cancellableDelay(250, signal);
  let state = await readAuthIdentifierDomState(mcpSession, userValue);
  if (state?.hasExpected) return { ok: true, source: 'mcp_type_readback', state };

  log('warn', `[calibrator] auth identifier was not present after browser_type (state=${JSON.stringify(state || {})}); retrying with DOM value setter before clicking advance.`);
  const domFill = await fillAuthIdentifierViaDom(mcpSession, userValue);
  await cancellableDelay(250, signal);
  state = await readAuthIdentifierDomState(mcpSession, userValue);
  if (state?.hasExpected) return { ok: true, source: 'dom_value_setter', state, domFill };
  return { ok: false, reason: 'identifier_not_entered', state, domFill };
}

async function readLoginControls(mcpSession, signal, waitMs = 800, options = {}) {
  if (waitMs > 0) await cancellableDelay(waitMs, signal);
  throwIfAborted(signal);
  const snapResult = await callCalibratorTool(mcpSession, { name: 'browser_snapshot', arguments: {} });
  const controls = locateLoginControls(snapshotText(snapResult));
  controls.domAuthHint = false;
  controls.domElementCount = 0;
  if (!authControlsLookActionable(controls) && options.domFallback) {
    try {
      const domElements = await harvestInteractiveViaDom(mcpSession, null);
      controls.domElementCount = domElements.length;
      controls.domAuthHint = authDomHint(domElements, controls.snap);
    } catch (_) {
      controls.domAuthHint = AUTH_SCREEN_TEXT_RE.test(String(controls.snap || ''));
    }
  }
  return controls;
}

async function waitForLoginControls(mcpSession, signal, {
  timeoutMs = AUTH_INITIAL_SETTLE_MS,
  firstWaitMs = 800,
  retryWaitMs = 1200,
  log = null,
  domFallback = true,
} = {}) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || AUTH_INITIAL_SETTLE_MS);
  let controls = null;
  let notedDomHint = false;
  for (let attempt = 0; ; attempt += 1) {
    controls = await readLoginControls(mcpSession, signal, attempt === 0 ? firstWaitMs : retryWaitMs, { domFallback });
    if (authControlsLookActionable(controls)) return controls;
    if (controls.domAuthHint && !notedDomHint) {
      notedDomHint = true;
      if (log) log('info', '[calibrator] auth DOM fallback sees login-like controls before accessibility refs settled; waiting for driveable fields/buttons.');
    }
    if (Date.now() >= deadline) return controls;
  }
}

async function readCurrentBrowserUrl(mcpSession) {
  try {
    const res = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: '() => location.href' } });
    const parsed = mcp.parseEvaluateReturnValue(mcp.textOfContent(res && res.content) || '');
    if (typeof parsed === 'string' && parsed) return parsed;
  } catch (_) {
    // Best-effort only; the MCP session cache is still useful if evaluation fails.
  }
  return mcpSession.currentUrl || null;
}

async function driveDeterministicAuthFlow(mcpSession, cred, log, signal, degradeCollector = null) {
  const userValue = cred.email || cred.name;
  let controls = await waitForLoginControls(mcpSession, signal, {
    timeoutMs: AUTH_INITIAL_SETTLE_MS,
    firstWaitMs: 900,
    retryWaitMs: 1200,
    log,
    domFallback: true,
  });

  log('info', `[calibrator] login fields - ${controls.cands.length} candidates; ${describeLoginControls(controls)}`
    + (controls.domAuthHint ? ` domAuthHint=yes domElements=${controls.domElementCount || 0}` : ''));

  let submittedIdentifier = false;
  let submittedPassword = false;
  let clickedProvider = false;
  let lastActionKey = '';

  for (let stage = 0; stage < 8; stage++) {
    throwIfAborted(signal);
    const identifierState = controls.userField
      ? await readAuthIdentifierDomState(mcpSession, userValue)
      : null;
    const observation = classifyAuthScreenObservation(controls, {
      userValue,
      identifierState,
      submittedIdentifier,
      submittedPassword,
      clickedProvider,
    });
    log('info', `[calibrator] auth state - ${observation.state}; action=${observation.action}; reason=${observation.reason}`
      + (identifierState ? `; identifier=${identifierState.hasExpected ? 'verified' : (identifierState.empty ? 'empty' : 'different')}` : ''));

    if (observation.action === 'success') {
      log('info', `[calibrator] form-login succeeded as "${userValue}" - crawl will map the authenticated app`);
      return await readCurrentBrowserUrl(mcpSession);
    }

    if (observation.action === 'block') {
      recordDegradation({
        onLog: log,
        collector: degradeCollector,
        stage: 'auth-crawl',
        reason: observation.state === 'hard_auth_challenge'
          ? 'login reached an MFA/OTP/CAPTCHA challenge that requires an auth fixture or human setup'
          : `screen-aware auth controller could not find a safe next action (${observation.reason})`,
        impact: 'authenticated area unmapped; scenarios grounded from docs only',
        severity: 'warning',
      });
      return null;
    }

    if (observation.action === 'click_prompt') {
      log('info', `[calibrator] staged-auth prompt - clicking "${controls.promptButton.name || controls.promptButton.hint || 'continue'}"`);
      await callAuthTool(mcpSession, 'browser_click', {
        element: controls.promptButton.name || controls.promptButton.hint || 'Post-login prompt',
        target: controls.promptButton.ref,
      });
      controls = await waitForLoginControls(mcpSession, signal, {
        timeoutMs: AUTH_STAGE_SETTLE_MS,
        firstWaitMs: 2200,
        retryWaitMs: 1000,
        log,
      });
      continue;
    }

    if (observation.action === 'enter_password') {
      if (controls.userField && controls.userField.ref !== controls.pwField?.ref && !observation.identifierFilled && !submittedIdentifier) {
        const identifierEntry = await ensureAuthIdentifierEntered(mcpSession, controls, userValue, log, signal);
        if (!identifierEntry.ok) {
          recordDegradation({
            onLog: log,
            collector: degradeCollector,
            stage: 'auth-crawl',
            reason: `could not prove identifier was entered before password step (${identifierEntry.reason})`,
            impact: 'authenticated area unmapped; scenarios grounded from docs only',
            severity: 'warning',
          });
          return null;
        }
        submittedIdentifier = true;
      }
      await callAuthTool(mcpSession, 'browser_type', { element: 'Password field', target: controls.pwField.ref, text: cred.password });
      if (controls.submit) {
        await callAuthTool(mcpSession, 'browser_click', { element: controls.submit.name || 'Login button', target: controls.submit.ref });
      } else {
        await callAuthTool(mcpSession, 'browser_type', { element: 'Password field', target: controls.pwField.ref, text: '', submit: true });
      }
      submittedPassword = true;
      controls = await readLoginControls(mcpSession, signal, 3000);
      log('info', `[calibrator] post-submit - url=${mcpSession.currentUrl || '?'} ${describeLoginControls(controls)}`);
      continue;
    }

    if (observation.action === 'click_provider') {
      const actionKey = authActionKey('provider', controls, [controls.providerButton.ref]);
      if (actionKey === lastActionKey) break;
      lastActionKey = actionKey;
      await callAuthTool(mcpSession, 'browser_click', {
        element: controls.providerButton.name || controls.providerButton.hint || 'SSO provider',
        target: controls.providerButton.ref,
      });
      clickedProvider = true;
      controls = await waitForLoginControls(mcpSession, signal, {
        timeoutMs: AUTH_STAGE_SETTLE_MS,
        firstWaitMs: 3000,
        retryWaitMs: 1000,
        log,
      });
      log('info', `[calibrator] staged-auth provider - url=${mcpSession.currentUrl || '?'} ${describeLoginControls(controls)}`);
      continue;
    }

    if (observation.action === 'enter_identifier') {
      const actionKey = authActionKey('identifier', controls, [controls.userField.ref, controls.submit?.ref || 'enter']);
      if (actionKey === lastActionKey) break;
      lastActionKey = actionKey;
      const identifierEntry = await ensureAuthIdentifierEntered(mcpSession, controls, userValue, log, signal);
      if (!identifierEntry.ok) {
        recordDegradation({
          onLog: log,
          collector: degradeCollector,
          stage: 'auth-crawl',
          reason: `could not prove identifier was entered before clicking ${controls.submit ? `"${controls.submit.name || controls.submit.hint || 'advance'}"` : 'Enter'} (${identifierEntry.reason})`,
          impact: 'authenticated area unmapped; scenarios grounded from docs only',
          severity: 'warning',
        });
        return null;
      }
      if (identifierEntry.source === 'snapshot_name') {
        log('info', `[calibrator] staged-auth identifier already present on screen - advancing without retyping "${controls.userField.name || controls.userField.hint || 'identifier'}"`);
      } else {
        log('info', `[calibrator] staged-auth identifier entered and verified by ${identifierEntry.source || 'readback'} before advancing.`);
      }
      if (controls.submit) {
        await callAuthTool(mcpSession, 'browser_click', { element: controls.submit.name || 'Continue button', target: controls.submit.ref });
      } else {
        await callAuthTool(mcpSession, 'browser_type', { element: 'Username field', target: controls.userField.ref, text: '', submit: true });
      }
      submittedIdentifier = true;
      controls = await waitForLoginControls(mcpSession, signal, {
        timeoutMs: AUTH_STAGE_SETTLE_MS,
        firstWaitMs: 2600,
        retryWaitMs: 1000,
        log,
      });
      log('info', `[calibrator] staged-auth advanced - url=${mcpSession.currentUrl || '?'} ${describeLoginControls(controls)}`);
      continue;
    }

    break;
  }

  if ((submittedPassword || clickedProvider) && !snapshotStillLooksAuth(controls)) {
    log('info', `[calibrator] form-login succeeded as "${userValue}" - crawl will map the authenticated app`);
    return await readCurrentBrowserUrl(mcpSession);
  }

  const federated = looksLikeFederatedLogin(controls.enriched);
  recordDegradation({
    onLog: log,
    collector: degradeCollector,
    stage: 'auth-crawl',
    reason: federated
      ? 'staged SSO/OAuth login could not be completed with the supplied credentials'
      : 'could not locate a driveable username/password login sequence',
    impact: 'authenticated area unmapped; scenarios grounded from docs only',
    severity: 'warning',
  });
  return null;
}

/**
 * Best-effort deterministic form login BEFORE the BFS crawl.
 *
 * Why this exists: the crawler previously only injected a storageState auth
 * fixture. A project with plain form credentials (the common case for many apps'
 * Admin/admin123) therefore hit the login wall and the atlas mapped exactly ONE
 * page (login), leaving the entire authenticated app invisible. With no atlas
 * coverage the Architect authored every behind-login assertion blind.
 *
 * This logs in with the first testCredential so the BFS starts from the real
 * post-login app. FULLY best-effort: any failure logs a warning and the crawl
 * proceeds with whatever is reachable (never worse than before). Returns the
 * post-login URL on success, null otherwise.
 */
async function attemptFormLogin(mcpSession, cred, startUrl, log, signal, degradeCollector = null) {
  if (!cred || !(cred.email || cred.name) || !cred.password) return null;
  const userValue = cred.email || cred.name;
  try {
    throwIfAborted(signal);
    await callCalibratorTool(mcpSession, { name: 'browser_navigate', arguments: { url: startUrl } });
    return await driveDeterministicAuthFlow(mcpSession, cred, log, signal, degradeCollector);
    // SPA login forms render late — poll for the username field up to ~6s.
    let cands = [];
    let enriched = [];
    let snapForLogin = '';
    const deadline = Date.now() + 6000;
    for (let attempt = 0; ; attempt++) {
      await cancellableDelay(attempt === 0 ? 800 : 1200, signal);
      throwIfAborted(signal);
      const snapResult = await callCalibratorTool(mcpSession, { name: 'browser_snapshot', arguments: {} });
      snapForLogin = snapshotText(snapResult);
      cands = mcp.parseMcpSnapshotToCandidates(snapForLogin) || [];
      const hasUser = cands.some((c) => /textbox|searchbox|combobox/.test((c.role || '').toLowerCase()));
      if (hasUser || Date.now() > deadline) break;
    }
    // #29 — enrich candidates with placeholder/aria/id hints so the username +
    // password matchers key off STRUCTURE, not just the (often-empty) accessible
    // name. Generic: the regex inspects role + a folded hint string, never a site
    // literal.
    enriched = enrichLoginCandidates(snapForLogin);
    const inputRe = /textbox|searchbox|combobox/;
    const inputs = enriched.filter((c) => inputRe.test(c.role));
    const userRe = /user|email|login|account|signin|sign[-_ ]?in|phone|mobile/i;
    const pwRe = /pass|pwd|secret/i;
    // Username: prefer hint match (name OR placeholder OR id/testid); fall back to
    // the FIRST input on the page (login forms put username first) — positional.
    let userField = inputs.find((c) => userRe.test(c.hint)) || inputs[0] || null;
    // Password: prefer an input whose hint says password; else the first input
    // AFTER the username field (positional — password follows username); never the
    // username field itself.
    const pwByHint = inputs.find((c) => pwRe.test(c.hint) && c.ref !== userField?.ref);
    let pwField = pwByHint
      || inputs.find((c) => c.ref !== userField?.ref && (!userField || c.order > userField.order))
      || inputs.find((c) => c.ref !== userField?.ref)
      || null;
    // Keep the legacy candidate-based pickers as a last resort (covers the rare
    // page where enrichment yields nothing but parseMcpSnapshotToCandidates does).
    if (!userField) userField = pickField(cands, /textbox|searchbox|combobox/, /user|email|login|account/i);
    if (!pwField) {
      const pwCandidates = cands.filter((c) => /textbox/.test((c.role || '').toLowerCase()) && c.ref && c.ref !== userField?.ref);
      pwField = pwCandidates.find((c) => /pass|pwd|secret/i.test(`${c.name || ''}`)) || pwCandidates[0] || null;
    }
    const submit = pickField(cands, /button/, /log\s*in|sign\s*in|submit|continue|enter|next/i);
    log('info', `[calibrator] login fields — ${cands.length} candidates; user=${userField ? `${userField.role}"${userField.name}"@${userField.ref}` : 'NONE'} pw=${pwField ? `${pwField.role}"${pwField.name}"@${pwField.ref}` : 'NONE'} submit=${submit ? `"${submit.name}"@${submit.ref}` : 'NONE'}`);
    if (!userField || !pwField) {
      // #6 — no discoverable username+password pair. This is the SSO/OAuth/MFA/
      // identity-first case (or a broken/blocked login). Do NOT silently proceed
      // as if the authenticated area were mapped: emit an honest degradation so
      // the operator knows scenarios behind login are doc-grounded only. We do
      // Legacy fallback is unreachable; staged SSO is handled above.
      const federated = looksLikeFederatedLogin(enriched);
      recordDegradation({
        onLog: log,
        collector: degradeCollector,
        stage: 'auth-crawl',
        reason: federated
          ? 'legacy fallback could not complete staged SSO/OAuth login'
          : 'could not locate a username+password field pair on the login page',
        impact: 'authenticated area unmapped; scenarios grounded from docs only',
        severity: 'warning',
      });
      return null;
    }
    throwIfAborted(signal);
    await mcp.callTool(mcpSession, 'browser_type', { element: 'Username field', target: userField.ref, text: userValue });
    throwIfAborted(signal);
    await mcp.callTool(mcpSession, 'browser_type', { element: 'Password field', target: pwField.ref, text: cred.password });
    throwIfAborted(signal);
    if (submit) {
      await mcp.callTool(mcpSession, 'browser_click', { element: 'Login button', target: submit.ref });
    } else {
      // No obvious submit button — submit by pressing Enter in the password field.
      await mcp.callTool(mcpSession, 'browser_type', { element: 'Password field', target: pwField.ref, text: '', submit: true });
    }
    // Let the post-login app settle, then confirm we left the login page.
    await cancellableDelay(2500, signal);
    throwIfAborted(signal);
    const after = await callCalibratorTool(mcpSession, { name: 'browser_snapshot', arguments: {} });
    const afterCands = mcp.parseMcpSnapshotToCandidates(snapshotText(after)) || [];
    const textboxesAfter = afterCands.filter((c) => /textbox/.test((c.role || '').toLowerCase())).length;
    const loginBtnAfter = afterCands.some((c) => /button/.test((c.role || '').toLowerCase()) && /log\s*in|sign\s*in/i.test(`${c.name || ''}`));
    log('info', `[calibrator] post-submit — url=${mcpSession.currentUrl || '?'} textboxes=${textboxesAfter} loginBtn=${loginBtnAfter}`);
    const stillOnLogin = loginBtnAfter && textboxesAfter >= 2;
    if (stillOnLogin) {
      log('warn', '[calibrator] form-login appears to have failed — still on a login form after submit (check credentials). Crawling reachable pages only.');
      return null;
    }
    log('info', `[calibrator] form-login succeeded as "${userValue}" — crawl will map the authenticated app`);
    return mcpSession.currentUrl || null;
  } catch (err) {
    if (err?.code === 'CANCELLED' || signal?.aborted) throw err;
    log('warn', `[calibrator] form-login error (continuing unauthenticated): ${err.message}`);
    return null;
  }
}

/**
 * Fallback credential source: when project.testCredentials is empty, the real
 * login is often baked into a test case's step VALUES (the Architect writes
 * "Fill Username = Admin / Fill Password = admin123" straight from the BRD, and
 * the Conductor just types those). Harvest the first case that fills BOTH a
 * username-ish field and a password-ish field with non-empty values — that's a
 * positive-login case demonstrating exactly how to authenticate this app.
 * Negative cases (empty password) are naturally skipped (no password value).
 */
async function harvestLoginFromCases(projectId) {
  const cases = await prisma.testCase.findMany({
    where: { projectId },
    select: { steps: true },
    orderBy: { createdAt: 'asc' },
    take: 300,
  });
  for (const tc of cases) {
    let steps = [];
    try { steps = JSON.parse(tc.steps || '[]'); } catch { continue; }
    let user = null, pass = null;
    for (const s of steps) {
      if (!s || !/fill|type|enter|input/i.test(String(s.action || ''))) continue;
      const val = typeof s.value === 'string' ? s.value.trim() : '';
      if (!val) continue;
      const tgt = `${s.target || ''} ${s.description || ''} ${s.expected || ''}`.toLowerCase();
      if (!pass && /pass|pwd|secret/.test(tgt)) pass = val;
      else if (!user && /user|email|login|account/.test(tgt)) user = val;
    }
    if (user && pass) return { name: user, email: user, password: pass };
  }
  return null;
}

/**
 * Extract hrefs from a snapshot to find navigation targets. FALLBACK only —
 * the Playwright MCP snapshot is an accessibility tree that does NOT carry raw
 * href attributes, so on a real SPA this finds nothing. Kept for the rare
 * static-HTML page whose snapshot happens to include hrefs.
 */
function extractLinks(snap, baseOrigin) {
  const links = [];
  const hrefRe = /href="([^"]+)"/g;
  let m;
  while ((m = hrefRe.exec(snap)) !== null) {
    const href = m[1];
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    try {
      const resolved = new URL(href, baseOrigin).toString();
      if (resolved.startsWith(baseOrigin)) links.push(resolved);
    } catch { /* ignore malformed hrefs */ }
  }
  return [...new Set(links)];
}

// Static asset extensions we never want to enqueue as crawlable pages.
const _ASSET_RE = /\.(png|jpe?g|gif|svg|webp|css|js|mjs|ico|pdf|zip|woff2?|ttf|eot|map)(\?|$)/i;

/**
 * The REAL link source: query the live DOM via browser_evaluate for every
 * <a href>. This is what makes the BFS work on SPAs whose
 * sidebar/nav are real anchors in the DOM but absent from the a11y snapshot.
 * Returns deduped same-origin origin+pathname URLs. Uses the `function` arg
 * shape this MCP build expects (mirrors browser_extract_data) and the canonical
 * parseEvaluateReturnValue to read the "Result:" payload.
 */
async function extractLinksViaDom(mcpSession, baseOrigin, log, { contentOnly = false } = {}) {
  try {
    const res = await callCalibratorTool(mcpSession, {
      name: 'browser_evaluate',
      arguments: {
        function: contentOnly
          ? '() => Array.from((document.querySelector("main, [role=\\"main\\"]") || document.body).querySelectorAll("a[href]")).filter(a => !a.closest("header, nav, aside, footer, [role=\\"navigation\\"]")).map(a => a.href)'
          : '() => Array.from(document.querySelectorAll("a[href]")).map(a => a.href)',
      },
    });
    const rawText = mcp.textOfContent(res && res.content) || '';
    if (!res || res.isError) {
      if (log) log('warn', `[calibrator] DOM link eval errored: ${rawText.slice(0, 160)}`);
      return [];
    }
    const val = mcp.parseEvaluateReturnValue(rawText);
    let arr = Array.isArray(val) ? val : [];
    // Belt-and-suspenders: if the structured parse still yields nothing, pull
    // absolute URLs straight out of the result text (a[href] is always absolute).
    if (!arr.length) arr = rawText.match(/https?:\/\/[^\s"'\\\]]+/g) || [];
    if (log) log('info', `[calibrator] DOM eval → ${arr.length} hrefs`);
    const links = [];
    for (const href of arr) {
      if (typeof href !== 'string') continue;
      try {
        const u = new URL(href, baseOrigin);
        if (u.origin !== baseOrigin) continue;           // same-origin only
        if (_ASSET_RE.test(u.pathname)) continue;          // skip static assets
        links.push(u.origin + u.pathname);                 // drop query/hash for dedup
      } catch { /* ignore malformed */ }
    }
    return [...new Set(links)];
  } catch { return []; }
}

/**
 * #7 — DOM-eval fallback vocabulary for ARIA-poor SPAs.
 *
 * extractElements is a11y-snapshot-bound: it needs each control to carry a
 * role+name in the accessibility tree. Custom-widget SPAs (clickable <div>s,
 * unlabelled icon buttons, role-less anchors) expose almost nothing there, so the
 * atlas recorded ~0 interactive elements and the Architect authored behind-page
 * steps blind. This harvests interactive elements STRUCTURALLY from the live DOM —
 * buttons/links/inputs/[role]/[onclick]/[tabindex]/contenteditable/data-router —
 * and synthesises a durable Playwright locator per element WITHOUT inventing
 * accessible names. Generic: keyed off tag/attribute STRUCTURE, never a site
 * selector. Returns ElementRecords shaped exactly like extractElements output so
 * the caller can merge them.
 */
async function harvestInteractiveViaDom(mcpSession, log) {
  // Run entirely in the page: collect a structural descriptor for each
  // interactive node, then build a stable getBy*/locator() expression here.
  const fn = `() => {
    const out = [];
    const sel = 'button, a[href], input, select, textarea, [role], [onclick], [tabindex], [contenteditable="true"], [data-router], [data-href], [data-testid], [data-test]';
    const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 400);
    for (const el of nodes) {
      const tag = (el.tagName || '').toLowerCase();
      const role = el.getAttribute('role') || '';
      const type = (el.getAttribute('type') || '').toLowerCase();
      const isInteractive = tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea'
        || role || el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0'
        || el.getAttribute('contenteditable') === 'true' || el.hasAttribute('data-router') || el.hasAttribute('data-href');
      if (!isInteractive) continue;
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
      if (r.width === 0 && r.height === 0) continue;
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      out.push({
        tag, role, type,
        text,
        name: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '').slice(0, 60),
        testid: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
        id: el.id || '',
      });
    }
    return out;
  }`;
  try {
    const res = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: fn } });
    const rawText = mcp.textOfContent(res && res.content) || '';
    if (!res || res.isError) {
      if (log) log('info', `[calibrator] DOM interactive-eval errored: ${rawText.slice(0, 120)}`);
      return [];
    }
    const arr = mcp.parseEvaluateReturnValue(rawText);
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const elements = [];
    for (const d of arr) {
      if (!d || typeof d !== 'object') continue;
      const role = String(d.role || d.tag || '').toLowerCase();
      const label = String(d.name || d.text || '').trim();
      // Build a stability-ranked chain from STRUCTURE only — no invented names.
      const chain = [];
      if (d.testid) chain.push({ selector: `getByTestId(${JSON.stringify(d.testid)})`, strategy: 'testid', verified: false, stabilityScore: 0.95 });
      if (d.id) chain.push({ selector: `locator(${JSON.stringify('#' + d.id)})`, strategy: 'css-id', verified: false, stabilityScore: 0.6 });
      if (d.role && label) chain.push({ selector: `getByRole(${JSON.stringify(d.role)}, { name: ${JSON.stringify(label)} })`, strategy: 'role', verified: false, stabilityScore: 0.55 });
      if (label && label.length < 60) chain.push({ selector: `getByText(${JSON.stringify(label)})`, strategy: 'text', verified: false, stabilityScore: 0.45 });
      if (!chain.length) continue;             // no addressable handle → skip
      const key = chain[0].selector;
      if (seen.has(key)) continue;
      seen.add(key);
      chain.sort((a, b) => b.stabilityScore - a.stabilityScore);
      elements.push({
        semanticLabel: `${role || 'element'} "${label}"`,
        selectorChain: chain,
        ariaRole: role,
        parentContext: '',
        source: 'dom-eval',                    // provenance: structurally harvested, not a11y-verified
      });
    }
    if (log) log('info', `[calibrator] DOM interactive-eval → ${elements.length} structural elements (ARIA-poor fallback)`);
    return elements;
  } catch (err) {
    if (log) log('info', `[calibrator] DOM interactive-eval threw: ${err.message}`);
    return [];
  }
}

// #16 — challenge / unreachable / error page detector. A captcha / Cloudflare
// "checking your browser" interstitial or a hard nav error must NOT be persisted
// as legitimate atlas vocabulary (it would teach the Architect a fake page). Keyed
// off STRUCTURAL signatures (challenge copy, captcha widget role, browser error
// chrome), never a single site string. Returns a short reason or null.
const _CHALLENGE_TEXT_RE = /\b(checking your browser|verify you are human|are you a robot|complete the (security )?check|cloudflare|attention required|captcha|hcaptcha|recaptcha|access denied|request blocked|unusual traffic|rate limited|too many requests)\b/i;
const _NAV_ERROR_RE = /\b(this site can'?t be reached|err_[a-z_]+|dns_probe|connection (timed out|refused|reset)|took too long to respond|502 bad gateway|503 service unavailable|504 gateway timeout|net::err)\b/i;
function looksLikeChallengeOrError(snap, textCorpus) {
  const hay = `${snap || ''}\n${(Array.isArray(textCorpus) ? textCorpus.join('\n') : '')}`;
  if (_NAV_ERROR_RE.test(hay)) return 'navigation/connection error page';
  if (_CHALLENGE_TEXT_RE.test(hay)) return 'bot-challenge / captcha / access-blocked page';
  // A captcha iframe/widget often surfaces as a checkbox or button named for the
  // challenge provider — structural, role-keyed.
  if (/\b(role=)?checkbox\b[^\n]*\b(robot|human|captcha)\b/i.test(hay)) return 'captcha challenge widget';
  return null;
}

/**
 * #20 — discover navigation targets beyond <a href>. pushState SPAs route via
 * role=link, buttons, and elements carrying click handlers / data-router / data-href
 * attributes — none of which extractLinksViaDom (a[href] only) sees, so the BFS
 * stalled at 1-2 pages. This harvests candidate destinations STRUCTURALLY from the
 * live DOM: explicit href-like attributes (data-href / data-router) resolved to
 * same-origin URLs. Click-only routers cannot be turned into a navigable URL
 * without executing them (we will not blind-click during a read-only crawl), so
 * they are reported for the degradation count but not enqueued. Generic — keyed
 * off attribute STRUCTURE, never a site selector.
 */
async function extractRouterLinksViaDom(mcpSession, baseOrigin, log, { contentOnly = false } = {}) {
  const fn = `() => {
    const urls = [];
    const add = (v) => { if (typeof v === 'string' && v) urls.push(v); };
    for (const el of Array.from(document.querySelectorAll('[data-href], [data-router], [data-route], [data-to], [role="link"]'))) {
      if (${contentOnly ? 'true' : 'false'} && (!el.closest('main, [role="main"]') || el.closest('header, nav, aside, footer, [role="navigation"]'))) continue;
      add(el.getAttribute('data-href'));
      add(el.getAttribute('data-route'));
      add(el.getAttribute('data-to'));
      const a = el.closest && el.closest('a[href]');
      if (a) add(a.getAttribute('href'));
    }
    return Array.from(new Set(urls)).slice(0, 200);
  }`;
  try {
    const res = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: fn } });
    if (!res || res.isError) return [];
    const arr = mcp.parseEvaluateReturnValue(mcp.textOfContent(res && res.content) || '');
    if (!Array.isArray(arr)) return [];
    const links = [];
    for (const href of arr) {
      if (typeof href !== 'string') continue;
      try {
        const u = new URL(href, baseOrigin);
        if (u.origin !== baseOrigin) continue;
        if (_ASSET_RE.test(u.pathname)) continue;
        links.push(u.origin + u.pathname);
      } catch { /* ignore */ }
    }
    const out = [...new Set(links)];
    if (out.length && log) log('info', `[calibrator] router-attr eval → ${out.length} SPA nav targets`);
    return out;
  } catch { return []; }
}

/**
 * Classify a page's role via a single cheap LLM call.
 * Returns a short string like "login page", "product list", "dashboard".
 */
async function classifyPageRole(snap, provider, apiKey, model) {
  if (!provider || !apiKey) return null;
  try {
    const resp = await provider.complete({
      apiKey,
      model,
      maxTokens: PAGE_ROLE_MAX_TOKENS,
      systemPrompt: 'You are a web page classifier. Reply with ONLY a short 2-4 word page-type label in lowercase. No markdown, no headings, no asterisks, no punctuation, no explanation. Examples of a valid reply: login page | dashboard | product list | checkout | user profile | admin settings.',
      messages: [{ role: 'user', content: `Classify this page (label only):\n${snap.slice(0, 2000)}` }],
    });
    const raw = resp?.content?.find((b) => b.type === 'text')?.text || '';
    return cleanPageRole(raw);
  } catch {
    return null;
  }
}

/**
 * Reduce a possibly-verbose LLM reply to a clean short label. Models (Claude in
 * particular) often ignore "label only" and return markdown like
 * "## Page Classification\n### Result: **Login Page**…". A naive slice stored
 * that whole blob as the pageRole and polluted the Site Atlas. Strip markdown,
 * pull the value after a "Result:/Label:" marker if present, take the first
 * meaningful line, and trim to a few words.
 */
function cleanPageRole(raw) {
  if (!raw) return null;
  let t = String(raw).replace(/[#*`_>]/g, ' ');           // drop markdown syntax
  const marker = t.match(/(?:result|label|page type|classification)\s*[:\-]\s*(.+)/i);
  if (marker) t = marker[1];
  t = (t.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '').trim(); // first non-empty line
  t = t.split(/[.:(\[]/)[0];                               // drop trailing explanation
  t = t.replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase().trim();
  if (!t) return null;
  return t.split(' ').slice(0, 5).join(' ').slice(0, 50);  // cap at 5 words / 50 chars
}

/**
 * Parse a snapshot into planner "rows" — { role, name, ref, flags } — using the
 * CANONICAL mcp.parseSnapshotLine tokenizer (never a fork) plus the bracket
 * flags it leaves in `rest` ([selected]/[haspopup]/[expanded]/[disabled]/
 * [active]). These rows feed crawlPlanner.classifyAffordances / primaryHeading /
 * activeNavItem / computeStateKey — the deterministic planning layer.
 */
function parseSnapshotRows(snap) {
  const rows = [];
  for (const line of String(snap || '').split(/\r?\n/)) {
    const p = mcp.parseSnapshotLine(line);
    if (!p || !(p.role || p.name)) continue;
    const rest = p.rest || line;
    rows.push({
      role: (p.role || '').toLowerCase(),
      name: p.name || '',
      ref: p.ref || null,
      flags: {
        haspopup: /haspopup/i.test(rest),
        selected: /\bselected\b/i.test(rest),
        current: /\bcurrent\b/i.test(rest) || /aria-current/i.test(line),
        active: /\bactive\b/i.test(rest),
        expanded: /\bexpanded\b/i.test(rest),
        disabled: /\bdisabled\b/i.test(rest),
      },
    });
  }
  return rows;
}

/**
 * Discover the site's TOP-LEVEL navigation modules from the live DOM — anchors
 * inside nav/menu landmarks, with their visible label. This is what makes the
 * crawl a PLANNED site mapper (one visit per module first) instead of a random
 * BFS. Generic: it reads whatever the app's own navigation exposes (nav,
 * [role=navigation], aside, header), never a hardcoded module list. Returns
 * [{ label, url }] (same-origin, asset-stripped). Empty on any failure → the
 * crawl falls back to plain BFS, never worse than before.
 */
async function harvestNavModulesViaDom(mcpSession, baseOrigin, log) {
  const fn = `() => {
    const out = [];
    const seen = new Set();
    const roots = Array.from(document.querySelectorAll('nav, [role="navigation"], aside, header, [class*="sidepanel" i], [class*="sidebar" i], [class*="mainmenu" i]'));
    const scopes = roots.length ? roots : [document.body].filter(Boolean);
    for (const root of scopes) {
      for (const a of Array.from(root.querySelectorAll('a[href]'))) {
        const href = a.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const label = (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
        out.push({ label, url: href });
        if (out.length >= 80) break;
      }
    }
    return out;
  }`;
  try {
    const res = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: fn } });
    if (!res || res.isError) return [];
    const arr = mcp.parseEvaluateReturnValue(mcp.textOfContent(res && res.content) || '');
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      try {
        const u = new URL(it.url, baseOrigin);
        if (u.origin !== baseOrigin) continue;       // same-origin modules only
        if (_ASSET_RE.test(u.pathname)) continue;
        out.push({ label: String(it.label || ''), url: u.origin + u.pathname });
      } catch { /* ignore malformed */ }
    }
    return out;
  } catch { return []; }
}

/**
 * Enumerate role=tab SUBSTATES on a page as planned, recorded states (not just
 * reveal-vocabulary). Each safe tab is clicked ONCE (capped by budget.tabsPerPage),
 * its panel captured (heading / visible text / interactive elements / typed
 * capabilities), de-duped by composite state key, and then the page is restored.
 * SAFE BY CONSTRUCTION: tabs that NAVIGATE (URL change) are treated as links, not
 * panels — restored + skipped (BFS will reach them by URL); destructive controls
 * are never in the tab set (crawlPlanner.classifyAffordances excludes them).
 * Returns { substates, discovered, visited }. Best-effort; any anomaly skips the
 * tab and never breaks the crawl.
 */
async function enumerateTabSubstates(args) {
  const { mcpSession, budget, pageUrl, normalizedUrl, pageRole, activeNav,
    seenStateKeys, module, authProfileId, log, signal, actionLedger = null } = args;
  const substates = [];
  if (!budget || !budget.tabsPerPage || !mcpSession || !mcpSession.client) {
    return { substates, discovered: 0, visited: 0 };
  }
  // Re-snapshot the live page so tab refs are CURRENT — an earlier dropdown probe
  // may have re-navigated the page, invalidating the original snapshot's refs.
  let freshSnap = '';
  try { freshSnap = snapshotText(await callCalibratorTool(mcpSession, { name: 'browser_snapshot', arguments: {} })); } catch (_) { freshSnap = ''; }
  const rows = parseSnapshotRows(freshSnap);
  const tabs = crawlPlanner.selectProbeTargets(rows, budget).tabs
    .filter((t) => t.ref && !t.flags.disabled && !t.flags.selected && !t.flags.current);
  const discovered = tabs.length;
  if (!discovered) return { substates, discovered: 0, visited: 0 };
  const baseKey = normalizeUrl(pageUrl);
  let visited = 0;
  let navigatedCount = 0, emptyCount = 0, dupCount = 0;
  for (const tab of tabs) {
    if (signal && signal.aborted) break;
    try {
      if (actionLedger && !actionLedger.markOnce(
        ['tab', baseKey, tab.name || '', tab.ref || ''],
        `tab "${tab.name || tab.ref}" on ${baseKey}`,
      )) {
        continue;
      }
      await callCalibratorTool(mcpSession, { name: 'browser_click', arguments: { element: tab.name || 'tab', ref: tab.ref } });
      await cancellableDelay(450, signal);
      // MUTATION/NAV GUARD — a real panel tab does NOT change the URL.
      let landed = '';
      try {
        const r = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: '() => location.href' } });
        landed = mcp.parseEvaluateReturnValue(mcp.textOfContent(r && r.content) || '');
      } catch (_) { landed = ''; }
      if (landed && typeof landed === 'string' && normalizeUrl(landed) !== baseKey) {
        navigatedCount += 1;
        if (log) log('info', `[calibrator] tab "${tab.name || '(unnamed)'}" NAVIGATES (→ ${String(landed).slice(0, 80)}) — it is a route link, not an in-place panel; queued as a page, not a tab substate`);
        try { await callCalibratorTool(mcpSession, { name: 'browser_navigate', arguments: { url: pageUrl } }); await cancellableDelay(600, signal); } catch (_) {}
        continue; // navigated → BFS will map it as a page, not a substate
      }
      const tabSnap = snapshotText(await callCalibratorTool(mcpSession, { name: 'browser_snapshot', arguments: {} }));
      if (!tabSnap) { emptyCount += 1; if (log) log('info', `[calibrator] tab "${tab.name || '(unnamed)'}" — empty snapshot after click, skipped`); continue; }
      const tabText = extractTextCorpus(tabSnap);
      const tabRows = parseSnapshotRows(tabSnap);
      const heading = crawlPlanner.primaryHeading(tabRows) || tab.name;
      const controlSig = `tab:${(tab.name || '').toLowerCase()}`;
      const stateKey = crawlPlanner.computeStateKey({ normalizedUrl, pageRole, heading, activeNav, textCorpus: tabText, controlSig });
      if (seenStateKeys.has(stateKey)) { dupCount += 1; if (log) log('info', `[calibrator] tab "${tab.name || '(unnamed)'}" — identical panel state already recorded, skipped (dedup)`); continue; }
      seenStateKeys.add(stateKey);
      const tabElements = extractElements(tabSnap);
      let tabCaps = [];
      try {
        tabCaps = (classifyCapabilities({
          elements: extractElements(tabSnap, CLASSIFIER_ROLES), textCorpus: tabText,
          snapshot: tabSnap, pageUrl: normalizedUrl, module, authProfileId,
        }).capabilities) || [];
      } catch (_) { tabCaps = []; }
      substates.push({
        tabLabel: tab.name || '',
        controlSig,
        stateKey,
        heading,
        textCorpus: tabText.slice(0, 120),
        elements: tabElements,
        capabilities: tabCaps,
      });
      visited += 1;
    } catch (tabErr) {
      if (tabErr && (tabErr.code === 'CANCELLED' || (signal && signal.aborted))) throw tabErr;
      // a failed tab must never break the crawl — skip it
    }
  }
  // GUARANTEED RESTORE — re-navigate so link extraction + the next page start clean.
  if (discovered) {
    try { await callCalibratorTool(mcpSession, { name: 'browser_navigate', arguments: { url: pageUrl } }); await cancellableDelay(600, signal); } catch (_) {}
  }
  if (log && discovered) {
    // Always report the outcome when tabs were discovered — an all-skipped page is the
    // exact "6 discovered / 0 visited" signal, now with the reason breakdown so the
    // next crawl shows WHY (navigated route-tabs vs empty/dup/error), not an opaque 0.
    log('info', `[calibrator] tab substates on ${pageUrl}: ${visited}/${discovered} captured`
      + (visited < discovered ? ` (${navigatedCount} navigate as routes, ${dupCount} duplicate, ${emptyCount} empty, ${discovered - visited - navigatedCount - dupCount - emptyCount} errored)` : ''));
  }
  return { substates, discovered, visited };
}

/**
 * Main calibrator entry point.
 *
 * @param {object} opts
 * @param {string}   opts.projectId
 * @param {string}   opts.userId
 * @param {string}   opts.calibrationId  Pre-created Calibration row id
 * @param {string}   opts.startUrl
 * @param {number}   [opts.maxPages]
 * @param {function} [opts.send]         WS broadcast: (msg) => void
 * @param {object}   [opts.signal]       AbortSignal
 * @param {string}   [opts.module]       Focus module this slice covers (P3b); null = whole-app
 * @param {string}   [opts.moduleHint]   Plain-text module name used to prioritise BFS links; may equal opts.module
 * @param {string}   [opts.authProfileId] Identity the crawl ran as (P3b); null = role-agnostic
 */
async function runCalibrator({
  projectId,
  userId,
  calibrationId,
  startUrl,
  maxPages = null,
  send,
  signal,
  module = null,
  moduleHint = null,
  authProfileId = null,
  crawlMode = null,
  generationMode = null,
  focusModule = null,
  crawlScope = null,
}) {
  const broadcast = send || (() => {});
  // Crawl depth scales with the generation mode (smoke→shallow … complete→deep),
  // never a single hard maxPages. An explicit crawlMode wins; otherwise derive it
  // from the generation mode; default standard. The budget governs pages-per-
  // module, tab depth, probe budget, and the hard page ceiling.
  const effectiveCrawlMode = crawlMode || crawlPlanner.crawlModeForGenerationMode(generationMode);
  const entryPageScope = String(crawlScope || '').trim().toLowerCase() === 'entry-page';
  const baseBudget = crawlPlanner.crawlBudget(effectiveCrawlMode);
  const budget = entryPageScope
    ? {
      ...baseBudget,
      tabsPerPage: Math.max(baseBudget.tabsPerPage || 0, 24),
      probeBudgetPerPage: Math.max(baseBudget.probeBudgetPerPage || 0, 12),
      scrollSnapshotsPerPage: Math.max(baseBudget.scrollSnapshotsPerPage || 0, 6),
    }
    : baseBudget;
  // An omitted maxPages defers fully to the mode budget (the old flat "18" is
  // gone — the mode owns the ceiling); an explicit positive maxPages can only
  // LOWER it, never raise it past the mode cap.
  const pageCap = (Number.isFinite(maxPages) && maxPages > 0)
    ? Math.min(maxPages, budget.totalPageCap)
    : budget.totalPageCap;
  let mcpSession = null;
  // P3b — per-page snapshot hashes accumulate here so the atlas fingerprint (the
  // drift key) is computed at completion over exactly the pages we mapped.
  const pageHashes = [];
  // Honest-degradation collector — every recordDegradation pushes a structured
  // record here so the crawl can surface what it could NOT map (SSO/MFA login,
  // ARIA-poor pages with no harvestable vocabulary, unreachable/challenge pages)
  // instead of returning a quietly-partial atlas. Broadcast on the completion
  // event so the UI/operator can judge how much of the app stayed invisible.
  const degradations = [];

  // Mirror to console: the calibrator runs in a background setImmediate, so its
  // WS logs vanish if nobody is watching the socket. The console copy makes
  // background crawls debuggable from the server log.
  const log = (level, msg) => {
    console.log(`[calibrator:${level}] ${msg}`);
    broadcast({ type: 'agent.phase.log', phase: 'calibrator', level, message: msg });
  };
  const crawlActionLedger = createCrawlActionLedger(log);

  try {
    log('info', `[calibrator] starting — ${startUrl} (mode ${effectiveCrawlMode}: ≤${pageCap} pages, ${budget.pagesPerModule}/module, tabs ${budget.tabsPerPage}, probes ${budget.probeBudgetPerPage}, modals ${budget.modalProbeBudgetPerPage || 0}, scrolls ${budget.scrollSnapshotsPerPage || 0})`);

    // Load project for auth fixture + LLM credentials
    const projectRow = await prisma.project.findUnique({
      where: { id: projectId },
      select: { defaultAuthFixtureId: true, aiProvider: true, testCredentials: true },
    });

    // Resolve LLM provider for page role classification (cheap, optional)
    const { apiKey, model, providerName } = await resolveAiCredentials(userId).catch(() => ({}));
    const provider = apiKey ? getProvider(providerName || 'claude') : null;
    const classificationModel = provider ? model : null;

    // Start MCP session
    mcpSession = await mcp.startMcpSession({ userId, targetUrl: startUrl, broadcast });
    sessionRegistry.set(userId + ':calibrator', mcpSession);

    // Inject auth fixture if configured
    if (projectRow?.defaultAuthFixtureId) {
      try {
        const fixture = await prisma.authFixture.findFirst({
          where: { id: projectRow.defaultAuthFixtureId, projectId },
        });
        if (fixture) {
          const state = JSON.parse(fixture.storageState);
          const cookies = (state.cookies || []).map((c) => ({
            name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
            secure: c.secure || false, httpOnly: c.httpOnly || false,
            sameSite: c.sameSite || 'None',
            ...(c.expires > 0 ? { expires: c.expires } : {}),
          }));
          if (cookies.length) {
            await callCalibratorTool(mcpSession, {
              name: 'browser_execute_cdp_command',
              arguments: { command: 'Network.setCookies', params: { cookies } },
            });
          }
          // Phase 3a — also inject localStorage per origin. Token/SSO auth
          // frequently lives in localStorage, not cookies; injecting only
          // cookies would leave a token app stuck at the login wall and the
          // atlas would map nothing behind it. Mirrors the conductor's
          // injectAuthFixture so an authenticated CRAWL sees the same
          // logged-in state an authenticated RUN does.
          for (const origin of state.origins || []) {
            const items = origin.localStorage || [];
            if (!items.length) continue;
            try {
              await callCalibratorTool(mcpSession, { name: 'browser_navigate', arguments: { url: origin.origin } });
              const script = items
                .map((i) => `try{localStorage.setItem(${JSON.stringify(i.name)},${JSON.stringify(i.value)})}catch(_){}`)
                .join(';');
              // MCP 0.0.75: use `function` (callable), not `expression` (removed).
              await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: `() => { ${script} }` } });
            } catch (lsErr) {
              log('warn', `[calibrator] localStorage injection for ${origin.origin} failed: ${lsErr.message}`);
            }
          }
          log('info', `[calibrator] auth fixture "${fixture.name}" injected (${cookies.length} cookies, ${(state.origins || []).length} origins) — crawl will map authenticated pages`);
        }
      } catch (err) {
        log('warn', `[calibrator] auth fixture injection failed: ${err.message}`);
      }
    }

    // Authenticate via form login if the project has plain credentials and no
    // storageState fixture already carried us in. Without this the BFS stops at
    // the login wall and the atlas maps one page. Best-effort — failure just
    // means we crawl whatever is reachable unauthenticated.
    let postLoginUrl = null;
    // Track whether this site needed auth + whether we cleared it — feeds the
    // honest sufficiency verdict (login-walled + ≤1 page mapped = insufficient).
    let loginRequired = !!projectRow?.defaultAuthFixtureId;
    let loginSucceeded = !!projectRow?.defaultAuthFixtureId; // fixture injected → assume in
    let authCred = null;
    let retriedAuthAfterVisibleLogin = false;
    if (!projectRow?.defaultAuthFixtureId) {
      let creds = [];
      try { creds = JSON.parse(projectRow?.testCredentials || '[]'); } catch { creds = []; }
      let cred = Array.isArray(creds) ? creds.find((c) => c && (c.email || c.name) && c.password) : null;
      if (!cred) {
        cred = await harvestLoginFromCases(projectId);
        if (cred) log('info', `[calibrator] project credential store empty — harvested login from a test case's steps (user "${cred.email}")`);
      }
      if (cred) {
        authCred = cred;
        loginRequired = true;
        postLoginUrl = await attemptFormLogin(mcpSession, cred, startUrl, log, signal, degradations);
        loginSucceeded = !!postLoginUrl;
      } else {
        log('info', '[calibrator] no credentials (store empty + no login steps found) — crawling unauthenticated (login-walled pages stay invisible)');
      }
    }

    // ── Menu-first crawl plan ──────────────────────────────────────────────
    // Before any BFS, inspect the site's own navigation and plan ONE visit per
    // top-level module, so a deep module can't consume the whole budget before
    // the others are even seen. Generic — uses whatever nav the app exposes.
    let modules = [];
    let planSeed = [];
    try {
      const seedUrl = postLoginUrl || startUrl;
      if (entryPageScope) {
        log('info', `[calibrator] entry-page scope: seeding only ${seedUrl}; global header/navigation/footer modules are excluded`);
      } else {
      await callCalibratorTool(mcpSession, { name: 'browser_navigate', arguments: { url: seedUrl } });
      await cancellableDelay(1200, signal);
      let seedOrigin = '';
      try { seedOrigin = new URL(seedUrl).origin; } catch { seedOrigin = ''; }
      const navModules = await harvestNavModulesViaDom(mcpSession, seedOrigin, log);
      modules = crawlPlanner.planModules(navModules, { homeUrl: seedUrl });
      planSeed = crawlPlanner.selectInitialPlan(modules, budget, { focusModule: focusModule || moduleHint });
      log('info', `[calibrator] menu plan (${effectiveCrawlMode}) — ${modules.length} module(s): ${modules.map((m) => m.label).join(', ') || '(none discovered; falling back to BFS)'}`);
      }
    } catch (planErr) {
      if (planErr && planErr.code === 'CANCELLED') throw planErr;
      log('info', `[calibrator] menu discovery skipped (${planErr.message}); using plain BFS`);
    }

    // BFS crawl. Seed the planned module roots FIRST (menu-first), then the
    // post-login landing URL, then startUrl so the login page itself is mapped.
    const visited = new Set();
    const queue = [];
    for (const u of planSeed) queue.push(u);
    if (postLoginUrl && postLoginUrl !== startUrl) queue.push(postLoginUrl);
    queue.push(startUrl);
    let pagesCount = 0;
    const pageFailures = [];
    let consecutiveBrowserSessionFailures = 0;

    // Per-module budget + content-level dedup + tab/coverage counters.
    const moduleCounts = new Map();          // moduleKey → pages mapped
    const visitedModules = new Set();        // moduleKey set actually visited
    const seenStateKeys = new Set();         // composite UI-state keys already mapped
    const seenRecordRouteTemplates = new Set(); // same page shape with different record data
    const pagesPerModule = {};               // moduleKey → count (coverage report)
    const capabilitiesPerModule = {};        // moduleKey → capability count
    let duplicateStatesSkipped = 0;
    let tabsDiscovered = 0;
    let tabsVisited = 0;

    // Resolve the focus module (focused mode) to its key so it keeps the larger
    // per-module budget while every other module is held to otherPagesPerModule.
    let focusKey = null;
    const focusName = (focusModule || moduleHint) ? String(focusModule || moduleHint).toLowerCase() : null;
    if (focusName) {
      const fm = modules.find((m) => String(m.label || '').toLowerCase().includes(focusName) || m.segment === focusName);
      if (fm) focusKey = fm.key;
    }

    while (queue.length > 0 && pagesCount < pageCap) {
      throwIfAborted(signal);

      const url = queue.shift();
      const normalizedUrl = normalizeUrl(url);
      const isEntryPage = entryPageScope && normalizedUrl === normalizeUrl(startUrl);
      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);
      const recordRouteTemplate = crawlPlanner.normalizeRecordRouteTemplate(url);
      if (recordRouteTemplate && seenRecordRouteTemplates.has(recordRouteTemplate)) {
        duplicateStatesSkipped += 1;
        log('info', `[calibrator] ${url} matches already-mapped record route ${recordRouteTemplate} — skipping data-variant page`);
        continue;
      }

      // Per-module budget gate — once a module has its allotted pages, skip
      // further pages of it so no single module eats the crawl (record-detail tunnels).
      const moduleKey = crawlPlanner.moduleKeyForUrl(url, modules);
      if (moduleKey && !crawlPlanner.withinModuleBudget(moduleKey, moduleCounts, budget, { isFocus: !!focusKey && moduleKey === focusKey })) {
        log('info', `[calibrator] module budget reached for "${moduleKey}" — skipping ${url} (no single module consumes the crawl)`);
        continue;
      }

      try {
        // Navigate to page
        throwIfAborted(signal);
        await callCalibratorTool(mcpSession, { name: 'browser_navigate', arguments: { url } });
        consecutiveBrowserSessionFailures = 0;

        // SPAs (React/Vue/Angular) render the real UI AFTER navigation resolves.
        // A fixed 800ms wait captured the pre-render shell on slow SPAs and returned a
        // 137-byte snapshot with zero elements at 800ms but the full login form
        // (textbox Username/Password, Login button) at ~2.5s. Poll: snapshot,
        // and re-try until interactive elements appear or a 6s budget is hit.
        // Static pages return on the first attempt (~800ms); SPAs catch up.
        let snap = '';
        let elements = [];
        const settleDeadline = Date.now() + 6000;
        for (let attempt = 0; ; attempt++) {
          await cancellableDelay(attempt === 0 ? 800 : 1200, signal);
          throwIfAborted(signal);
          const snapResult = await callCalibratorTool(mcpSession, { name: 'browser_snapshot', arguments: {} });
          snap = snapshotText(snapResult);
          elements = extractElements(snap);
          if (elements.length > 0 || Date.now() > settleDeadline) break;
        }
        if (!snap) continue;

        // ── Canonical-URL dedup (SPA redirect/alias collapse) ──────────────
        // The requested URL often redirects/routes to a DIFFERENT canonical path
        // (e.g. a module root "/records" -> its default sub-page
        // "/recruitment/viewCandidates"; or an anchor href vs a router target for
        // the same item). normalizeUrl keys on origin+pathname, so those alias to
        // DIFFERENT keys and the SAME logical page gets crawled TWICE — wasting
        // the maxPages budget (which halves real coverage) and double-loading the
        // site (the "navbar swept top-to-bottom twice" symptom). Read the LANDED
        // url from the browser itself: if it normalises to an already-mapped page,
        // skip this duplicate; otherwise record the landed key so a later alias
        // link is skipped. Generic — keyed off the post-navigation URL, never a
        // site string. Best-effort: any eval failure falls through and maps as before.
        try {
          const hrefRes = await callCalibratorTool(mcpSession, { name: 'browser_evaluate', arguments: { function: '() => location.href' } });
          const landedRaw = mcp.parseEvaluateReturnValue(mcp.textOfContent(hrefRes && hrefRes.content) || '');
          const landedUrl = typeof landedRaw === 'string' ? landedRaw : '';
          if (landedUrl) {
            const landedKey = normalizeUrl(landedUrl);
            if (landedKey && landedKey !== normalizedUrl) {
              if (visited.has(landedKey)) {
                log('info', `[calibrator] ${url} → redirected to already-mapped ${landedKey}; skipping duplicate`);
                continue;
              }
              visited.add(landedKey);
            }
          }
        } catch { /* best-effort; map under the requested URL as before */ }

        // Visible text — the ground truth for TEXT/PAGE assertion grounding
        // (CONTENT names only; ARIA landmark labels are excluded here).
        const textCorpus = extractTextCorpus(snap);
        let pageInteriorLinks = [];

        // #16 — never persist a bot-challenge / captcha / nav-error page as
        // legitimate atlas vocabulary. Detect it structurally and emit an honest
        // degradation INSTEAD of recording the interstitial's copy as page content
        // (which would teach the Architect a fake page and ground assertions
        // against challenge text).
        const challengeReason = looksLikeChallengeOrError(snap, textCorpus);
        if (challengeReason) {
          recordDegradation({
            onLog: log,
            collector: degradations,
            stage: 'atlas-crawl',
            reason: `${url} returned a ${challengeReason} — not real application content`,
            impact: 'this page is omitted from the atlas; vocabulary/coverage for it is missing',
            severity: 'warning',
          });
          continue; // do NOT persist, classify, or follow links from a challenge page
        }

        // ── Composite UI-state dedup ───────────────────────────────────────
        // URL-level dedup (above) can't catch the SAME screen reached via two
        // routes. Build a content-level state key (URL + role + heading + active
        // nav + visible-text hash); if we've already mapped this exact state, skip
        // it (and count it) so a crawl loop can't re-map the same page and eat the
        // budget. Keyed off generic page content, never a site string.
        const stateRows = parseSnapshotRows(snap);
        const pageHeading = crawlPlanner.primaryHeading(stateRows);
        const activeNav = crawlPlanner.activeNavItem(stateRows);
        const stateKey = crawlPlanner.computeStateKey({ normalizedUrl, pageRole: null, heading: pageHeading, activeNav, textCorpus });
        if (seenStateKeys.has(stateKey)) {
          duplicateStatesSkipped += 1;
          log('info', `[calibrator] ${url} is a duplicate UI-state (the same screen was already mapped) — skipping`);
          continue;
        }
        seenStateKeys.add(stateKey);
        if (recordRouteTemplate) seenRecordRouteTemplates.add(recordRouteTemplate);

        // #7 — ARIA-poor SPA fallback. extractElements is a11y-snapshot-bound; a
        // custom-widget SPA (clickable divs, role-less anchors, unlabelled icon
        // buttons) yields almost nothing there. When the snapshot produced very few
        // interactive candidates, harvest interactive elements STRUCTURALLY from the
        // live DOM and merge them so the page still gets usable vocabulary. Keyed
        // off element COUNT (a structural signal), never a site identity.
        if (elements.length < 3) {
          throwIfAborted(signal);
          const domElements = await harvestInteractiveViaDom(mcpSession, log);
          if (domElements.length) {
            const seenLabels = new Set(elements.map((e) => e.semanticLabel));
            for (const de of domElements) {
              if (seenLabels.has(de.semanticLabel)) continue;
              seenLabels.add(de.semanticLabel);
              elements.push(de);
            }
          }
        }

        if (loginRequired && !loginSucceeded && authCred && !retriedAuthAfterVisibleLogin) {
          const visibleAuthControls = locateLoginControls(snap);
          const visibleAuth = authControlsLookActionable(visibleAuthControls) || authDomHint(elements, snap);
          if (visibleAuth) {
            retriedAuthAfterVisibleLogin = true;
            log('info', '[calibrator] login controls appeared during page mapping after initial auth failed - retrying authentication before recording an unauthenticated atlas.');
            let retryUrl = null;
            try {
              retryUrl = await driveDeterministicAuthFlow(mcpSession, authCred, log, signal, degradations);
            } catch (retryErr) {
              if (retryErr?.code === 'CANCELLED' || signal?.aborted) throw retryErr;
              log('warn', `[calibrator] visible-login auth retry failed: ${retryErr.message}`);
            }
            if (retryUrl) {
              postLoginUrl = retryUrl;
              loginSucceeded = true;
              queue.length = 0;
              queue.push(retryUrl);
              log('info', `[calibrator] visible-login auth retry succeeded - restarting crawl from ${retryUrl}`);
              continue;
            }
          }
        }

        try {
          let baseOriginForInterior = '';
          try { baseOriginForInterior = new URL(url).origin; } catch { /* ignore */ }
          const interior = await harvestPageInteriorViaScroll({
            mcpSession,
            pageUrl: url,
            baseOrigin: baseOriginForInterior,
            log,
            signal,
            maxScrolls: budget.scrollSnapshotsPerPage || 0,
            contentOnlyLinks: isEntryPage,
          });
          if (interior.textCorpus.length) {
            const seenText = new Set(textCorpus);
            for (const t of interior.textCorpus) {
              if (!seenText.has(t)) {
                seenText.add(t);
                textCorpus.push(t);
              }
            }
          }
          if (interior.elements.length) {
            const seenLabels = new Set(elements.map((e) => e.semanticLabel));
            for (const el of interior.elements) {
              if (seenLabels.has(el.semanticLabel)) continue;
              seenLabels.add(el.semanticLabel);
              elements.push(el);
            }
          }
          pageInteriorLinks = interior.links || [];
        } catch (interiorErr) {
          if (interiorErr?.code === 'CANCELLED' || signal?.aborted) throw interiorErr;
          log('info', `[calibrator] page interior scroll skipped for ${url}: ${interiorErr.message}`);
        }

        // Classify page role
        throwIfAborted(signal);
        const pageRole = await classifyPageRole(snap, provider, apiKey, classificationModel);
        throwIfAborted(signal);

        // ARIA landmark labels, captured apart so the structural-label gate can
        // demote zero-diagnostic-value assertions (e.g. "Topbar Menu").
        const structuralNames = extractStructuralNames(snap);

        // Compute snapshot hash for staleness detection
        const snapshotHash = crypto.createHash('sha256').update(snap.slice(0, 5000)).digest('hex').slice(0, 16);

        // P3a — classify this page's interactive structure into typed
        // CapabilityRecords (form / entity_collection / search_filter_sort /
        // workflow_action / modal / file) bound to the durable selectors already
        // extracted. Fully deterministic (no LLM); a capability with no
        // cross-session selector is dropped by the vocabulary validator. This is
        // the HOW-oracle substrate the BDD pipeline + ReplayIR consume — the
        // atlas proves HOW to operate the page, NEVER what the business result is.
        let capabilities = [];
        let droppedCaps = [];
        try {
          // Wider role set than elementsJson — the classifier needs table rows /
          // column headers / dialogs to detect entity_collection + modal. Pass the
          // normalized page url + slice (module, authProfile) so each capability
          // gets a stable, slice-scoped capabilityId (P3d).
          const classifierElements = extractElements(snap, CLASSIFIER_ROLES);
          throwIfAborted(signal);
          const classified = classifyCapabilities({
            elements: classifierElements, textCorpus, snapshot: snap,
            pageUrl: normalizedUrl, module, authProfileId,
          });
          capabilities = classified.capabilities;
          droppedCaps = classified.dropped;
        } catch (capErr) {
          log('warn', `[calibrator] capability classification failed for ${url}: ${capErr.message}`);
        }

        // ── Deeper crawl: NON-MUTATING interactive probe ───────────────────
        // Open safe affordances (custom dropdowns, tabs, popup-menu buttons) to
        // capture vocabulary the static snapshot can't see (option values, menu
        // items) — for data-value grounding + Conductor option locators. Merge
        // the revealed vocab into this page's elements + textCorpus BEFORE
        // persist so the atlas carries it. The probe restores the live page
        // (re-navigates) before returning, so link extraction below is clean.
        try {
          const probe = await probeInteractiveAffordances({
            mcpSession, baselineSnap: snap, pageUrl: url, log, signal, maxProbes: budget.probeBudgetPerPage,
            actionLedger: crawlActionLedger,
          });
          if (probe.revealedElements.length) {
            const seenLabels = new Set(elements.map((e) => e.semanticLabel));
            for (const el of probe.revealedElements) {
              if (seenLabels.has(el.semanticLabel)) continue;
              seenLabels.add(el.semanticLabel);
              elements.push(el);
            }
          }
          if (probe.revealedText.length) {
            const seenText = new Set(textCorpus);
            for (const t of probe.revealedText) {
              if (!seenText.has(t)) { seenText.add(t); textCorpus.push(t); }
            }
          }
        } catch (probeErr) {
          if (probeErr?.code === 'CANCELLED' || signal?.aborted) throw probeErr;
          log('info', `[calibrator] interactive probe skipped for ${url}: ${probeErr.message}`);
        }

        // ── Tab / subtab SUBSTATES ─────────────────────────────────────────
        // Enumerate role=tab panels as planned, recorded substates (parent URL,
        // tab label, state key, visible text, elements, capabilities) — budget-
        // capped per mode. Tabs that NAVIGATE are restored + left for the BFS;
        // destructive controls are never in the tab set. Merge each substate's
        // vocab into the page so the atlas carries it even though the substates
        // live under one CalibrationPage row (substatesJson).
        let substates = [];
        try {
          const tabResult = await enumerateTabSubstates({
            mcpSession, budget, pageUrl: url, normalizedUrl, pageRole, activeNav,
            seenStateKeys, module, authProfileId, log, signal,
            actionLedger: crawlActionLedger,
          });
          substates = tabResult.substates;
          tabsDiscovered += tabResult.discovered;
          tabsVisited += tabResult.visited;
          for (const ss of substates) {
            const seenLabels = new Set(elements.map((e) => e.semanticLabel));
            for (const el of (ss.elements || [])) {
              if (seenLabels.has(el.semanticLabel)) continue;
              seenLabels.add(el.semanticLabel);
              elements.push(el);
            }
            const seenText = new Set(textCorpus);
            for (const t of (ss.textCorpus || [])) {
              if (!seenText.has(t)) { seenText.add(t); textCorpus.push(t); }
            }
          }
        } catch (tabErr) {
          if (tabErr?.code === 'CANCELLED' || signal?.aborted) throw tabErr;
          log('info', `[calibrator] tab enumeration skipped for ${url}: ${tabErr.message}`);
        }

        try {
          const modalResult = await probeModalAffordances({
            mcpSession,
            baselineSnap: snap,
            pageUrl: url,
            normalizedUrl,
            pageRole,
            activeNav,
            seenStateKeys,
            module,
            authProfileId,
            log,
            signal,
            maxModals: budget.modalProbeBudgetPerPage || 0,
            actionLedger: crawlActionLedger,
          });
          if (modalResult.substates.length) {
            substates.push(...modalResult.substates);
            for (const ss of modalResult.substates) {
              for (const cap of (ss.capabilities || [])) {
                const capId = cap && (cap.capabilityId || `${cap.type}:${cap.name || cap.description || ''}`);
                if (capId && capabilities.some((existing) => (existing.capabilityId || `${existing.type}:${existing.name || existing.description || ''}`) === capId)) continue;
                capabilities.push(cap);
              }
            }
          }
          if (modalResult.revealedElements.length) {
            const seenLabels = new Set(elements.map((e) => e.semanticLabel));
            for (const el of modalResult.revealedElements) {
              if (seenLabels.has(el.semanticLabel)) continue;
              seenLabels.add(el.semanticLabel);
              elements.push(el);
            }
          }
          if (modalResult.revealedText.length) {
            const seenText = new Set(textCorpus);
            for (const t of modalResult.revealedText) {
              if (!seenText.has(t)) {
                seenText.add(t);
                textCorpus.push(t);
              }
            }
          }
        } catch (modalErr) {
          if (modalErr?.code === 'CANCELLED' || signal?.aborted) throw modalErr;
          log('info', `[calibrator] modal probing skipped for ${url}: ${modalErr.message}`);
        }

        // Persist CalibrationPage. capabilitiesJson is written on the rich attempt
        // ONLY; a pre-regen Prisma client (the column is unknown until the next
        // restart applies the P3 migration + regenerates the client) falls back to
        // the base write so the crawl still completes — the same graceful ladder
        // testCaseContract.persistCases uses for requirementRefs.
        const baseData = {
          calibrationId,
          url,
          normalizedUrl,
          pageRole: pageRole || null,
          elementsJson: JSON.stringify(elements),
          textCorpus: JSON.stringify(textCorpus),
          snapshotHash,
        };
        try {
          await prisma.calibrationPage.create({ data: { ...baseData, capabilitiesJson: JSON.stringify(capabilities), structuralNamesJson: JSON.stringify(structuralNames), stateKey, substatesJson: JSON.stringify(substates) } });
        } catch (capPersistErr) {
          // Pre-regen client doesn't know capabilitiesJson/stateKey/substatesJson →
          // base write keeps the crawl alive. Logged so a POST-regen real failure
          // (not the unknown column) stays visible rather than silently dropping data.
          log('info', `[calibrator] rich page fields not persisted for ${url} (likely pre-regen client): ${capPersistErr.message}`);
          await prisma.calibrationPage.create({ data: baseData });
        }
        pagesCount++;
        pageHashes.push(snapshotHash); // feeds the atlas fingerprint (drift key)
        // Per-module accounting (coverage report + budget enforcement).
        if (moduleKey) {
          moduleCounts.set(moduleKey, (moduleCounts.get(moduleKey) || 0) + 1);
          visitedModules.add(moduleKey);
          pagesPerModule[moduleKey] = (pagesPerModule[moduleKey] || 0) + 1;
          capabilitiesPerModule[moduleKey] = (capabilitiesPerModule[moduleKey] || 0) + (capabilities ? capabilities.length : 0);
        }

        broadcast({
          type: 'calibration.page.complete',
          calibrationId,
          projectId,
          url,
          pageRole: pageRole || null,
          elementsCount: elements.length,
          textCount: textCorpus.length,
          capabilitiesCount: capabilities.length,
          pagesCount,
        });

        log('info', `[calibrator] mapped: ${url} — ${pageRole || 'unknown'} (${elements.length} elements, ${textCorpus.length} text labels, ${capabilities.length} capabilities${droppedCaps.length ? `, ${droppedCaps.length} dropped` : ''})`);

        // Extract navigation links for next BFS level. Prefer the live-DOM
        // anchor list (works on SPAs); fall back to snapshot-regex for the odd
        // static page whose a11y tree carries hrefs.
        let baseOrigin = '';
        try { baseOrigin = new URL(url).origin; } catch { /* ignore */ }
        throwIfAborted(signal);
        let links = entryPageScope && !isEntryPage
          ? []
          : await extractLinksViaDom(mcpSession, baseOrigin, log, { contentOnly: isEntryPage });
        if (!links.length && !entryPageScope) links = extractLinks(snap, baseOrigin);
        // #20 — pushState SPAs route via role=link / buttons / data-router/data-href
        // attributes, not just <a href>, so anchor-only discovery stalled at 1-2
        // pages. Union in structurally-discovered router targets (generic, keyed
        // off attribute shape) so the BFS reaches more of the app.
        throwIfAborted(signal);
        const routerLinks = entryPageScope && !isEntryPage
          ? []
          : await extractRouterLinksViaDom(mcpSession, baseOrigin, log, { contentOnly: isEntryPage });
        if (routerLinks.length) links = [...new Set([...links, ...routerLinks])];
        if (pageInteriorLinks.length) links = [...new Set([...links, ...pageInteriorLinks])];
        if (entryPageScope && !isEntryPage) links = [];
        let enqueued = 0;
        for (const link of links) {
          const normLink = normalizeUrl(link);
          if (!visited.has(normLink)) {
            // Focus-mode prioritisation: pages of the focus module jump to the
            // FRONT so its deep budget is spent first; everything else is plain
            // BFS. The per-module budget already prevents any module from
            // tunnelling, so non-focus links never need front-loading.
            if (focusKey && crawlPlanner.moduleKeyForUrl(link, modules) === focusKey) {
              queue.unshift(link);
            } else {
              queue.push(link);
            }
            enqueued++;
          }
        }
        log('info', `[calibrator] ${url} → ${links.length} links found, ${enqueued} new queued (queue=${queue.length})`);
      } catch (pageErr) {
        if (pageErr?.code === 'CANCELLED' || signal?.aborted) throw pageErr;
        const browserSessionLost = /ECONNREFUSED|websocket|browser (?:has been )?closed|target .*closed|session .*closed|connection .*closed/i
          .test(String(pageErr?.message || pageErr || ''));
        if (browserSessionLost) {
          consecutiveBrowserSessionFailures += 1;
          if (consecutiveBrowserSessionFailures >= 3) {
            const sessionErr = new Error(
              `Crawler browser session became unavailable for ${consecutiveBrowserSessionFailures} consecutive pages; stopping instead of draining the remaining queue.`,
            );
            sessionErr.code = 'CALIBRATOR_BROWSER_SESSION_LOST';
            throw sessionErr;
          }
        } else {
          consecutiveBrowserSessionFailures = 0;
        }
        pageFailures.push({
          url,
          code: pageErr?.code || null,
          message: String(pageErr?.message || pageErr || 'Unknown page-mapping error').slice(0, 500),
        });
        log('warn', `[calibrator] failed to map ${url}: ${pageErr.message}`);
      }
    }

    // P3b — slice + drift bookkeeping. The fingerprint is the SORTED set of page
    // snapshot hashes; comparing it to this slice's prior CURRENT atlas tells us
    // whether the site drifted (→ version++) or is unchanged (→ refresh). The new
    // row becomes the current slice and supersedes the prior current for the SAME
    // (project, module, authProfile) key. All of this is wrapped so a pre-regen
    // Prisma client (slice columns unknown until the next restart) falls back to
    // the legacy completion write — never blocking the crawl from finishing.
    if (pagesCount === 0) {
      recordDegradation({
        onLog: log,
        collector: degradations,
        stage: 'atlas-crawl',
        reason: `crawl of ${startUrl} mapped 0 pages`,
        impact: 'no live site atlas; scenario generation can continue from uploaded documents, but no page labels or controls are verified',
        severity: 'error',
      });
      throw buildZeroPageCrawlError(startUrl, pageFailures, degradations);
    }

    const completedAt = new Date();
    const fingerprint = atlasSlice.computeAtlasFingerprint(pageHashes);
    let prior = null;
    try {
      prior = await prisma.calibration.findFirst({
        where: { projectId, module, authProfileId, status: 'complete', isCurrent: true, id: { not: calibrationId } },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, atlasFingerprint: true },
      });
    } catch { prior = null; } // pre-regen client → treat as no prior slice
    const decision = atlasSlice.decideSliceVersion({
      priorVersion: prior?.version || 0,
      priorFingerprint: prior?.atlasFingerprint || null,
      newFingerprint: fingerprint,
    });

    // ── Crawl coverage report + explicit sufficiency verdict ───────────────
    // Never a silent "atlas ready": summarise what the plan covered and classify
    // sufficient | partial | insufficient so the route can warn/block honestly.
    const coverage = crawlPlanner.summarizeCoverage({
      crawlMode: effectiveCrawlMode,
      modulesDiscovered: modules,
      modulesVisited: [...visitedModules],
      pagesPerModule, pagesVisited: pagesCount,
      duplicateStatesSkipped, tabsDiscovered, tabsVisited,
      capabilitiesPerModule, loginRequired, loginSucceeded,
    });
    const sufficiency = crawlPlanner.classifySufficiency(coverage, { crawlMode: effectiveCrawlMode, loginRequired, loginSucceeded });
    log('info', `[calibrator] coverage — ${coverage.modulesVisited}/${coverage.modulesDiscovered} modules, ${pagesCount} pages, ${tabsVisited}/${tabsDiscovered} tabs, ${duplicateStatesSkipped} dup-state(s) skipped → sufficiency: ${sufficiency.level}${sufficiency.warnings.length ? ' (' + sufficiency.warnings.join('; ') + ')' : ''}`);

    try {
      await prisma.calibration.update({
        where: { id: calibrationId },
        data: {
          status: 'complete', pagesCount, completedAt,
          module, authProfileId, atlasFingerprint: fingerprint,
          version: decision.version, isCurrent: true,
          staleAt: atlasSlice.deriveStaleAt(completedAt),
          crawlMode: effectiveCrawlMode,
          coverageReportJson: JSON.stringify(coverage),
          sufficiency: sufficiency.level,
        },
      });
      if (decision.supersede) {
        await prisma.calibration.updateMany({
          where: { projectId, module, authProfileId, status: 'complete', isCurrent: true, id: { not: calibrationId } },
          data: { isCurrent: false },
        });
      }
      log('info', `[calibrator] slice ${atlasSlice.sliceLabel({ module, authProfileId, version: decision.version })} — drift '${decision.drift}', fingerprint ${fingerprint || 'none'}`);
    } catch (sliceErr) {
      log('info', `[calibrator] slice fields not persisted (likely pre-regen client): ${sliceErr.message}`);
      await prisma.calibration.update({
        where: { id: calibrationId },
        data: { status: 'complete', pagesCount, completedAt },
      });
    }

    // #16 — a crawl that mapped (almost) nothing is a degradation, not a quiet
    // success: the site may be unreachable, fully bot-blocked, or login-walled with
    // an auth flow we couldn't drive. Emit an honest signal so the atlas isn't
    // trusted as complete coverage. (Per-page challenge/SSO signals already fired
    // above; this is the whole-crawl floor.)
    if (pagesCount === 0) {
      recordDegradation({
        onLog: log,
        collector: degradations,
        stage: 'atlas-crawl',
        reason: `crawl of ${startUrl} mapped 0 pages (unreachable, fully bot-blocked, or login-walled with an undriveable auth flow)`,
        impact: 'no live site atlas — all scenarios are grounded from docs only, with no HOW/label verification',
        severity: 'error',
      });
    }

    // Surface what the crawl could NOT map alongside the completion event so the
    // operator/UI can judge atlas trust (loud-and-honest, never silently partial).
    broadcast({
      type: 'calibration.complete', calibrationId, projectId, pagesCount,
      module, authProfileId, version: decision.version, drift: decision.drift,
      crawlMode: effectiveCrawlMode, coverage, sufficiency,
      degradations: degradations.slice(0, 50),
    });
    log('info', `[calibrator] complete — ${pagesCount} pages mapped (sufficiency: ${sufficiency.level})${degradations.length ? `; ${degradations.length} degradation${degradations.length === 1 ? '' : 's'} recorded` : ''}`);

    // Return the verdict so the caller (scenarios route) can warn/gate honestly
    // without a stale-client DB read for the new columns.
    return { pagesCount, crawlMode: effectiveCrawlMode, coverage, sufficiency, degradations: degradations.slice(0, 50) };

  } catch (err) {
    log('warn', `[calibrator] failed: ${err.message}`);
    await prisma.calibration.update({
      where: { id: calibrationId },
      data: { status: 'failed', errorMessage: String(err.message).slice(0, 500) },
    }).catch(() => {});
    broadcast({
      type: 'calibration.failed',
      calibrationId,
      projectId,
      code: err.code || 'CALIBRATION_FAILED',
      error: String(err.message).slice(0, 500),
    });
    throw err;
  } finally {
    if (mcpSession) {
      try { await mcp.stopMcpSession(mcpSession); } catch { /* ignore */ }
      sessionRegistry.remove(userId + ':calibrator'); // registry exposes remove(), not delete()
    }
  }
}

/**
 * P3b — resolve the CURRENT calibration for a (module, authProfile) slice, with
 * the wrong-role firewall + graceful pre-regen fallback. Two lean queries: scan
 * slice metadata (scalar only), let atlasSlice.pickSlice choose (NEVER a foreign
 * authProfile's slice), then load the chosen row with its pages. A pre-regen
 * client (slice columns unknown) falls back to the legacy newest-complete query
 * so the running backend keeps grounding until the next restart.
 *
 * @param {string} projectId
 * @param {{module?:string, authProfileId?:string}} [opts]
 * @returns {Promise<{calibration:object, degraded:string|null, freshness:object}|null>}
 */
async function loadCurrentCalibration(projectId, opts = {}) {
  let chosenId = null; let degraded = null; let completedAt = null; let staleAt = null; let atlasFingerprint = null;
  try {
    const metas = await prisma.calibration.findMany({
      where: { projectId, status: 'complete' },
      take: 50,
      select: { id: true, module: true, authProfileId: true, version: true, isCurrent: true, completedAt: true, staleAt: true, atlasFingerprint: true, createdAt: true },
    });
    const picked = atlasSlice.pickSlice(metas, opts);
    if (!picked.chosen) return null;           // absent / wrong-role block
    chosenId = picked.chosen.id; degraded = picked.degraded;
    completedAt = picked.chosen.completedAt; staleAt = picked.chosen.staleAt; atlasFingerprint = picked.chosen.atlasFingerprint || null;
  } catch {
    // pre-regen client: slice columns unknown in select → legacy newest-complete.
    const legacy = await prisma.calibration.findFirst({
      where: { projectId, status: 'complete' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, completedAt: true, atlasFingerprint: true },
    });
    if (!legacy) return null;
    chosenId = legacy.id; completedAt = legacy.completedAt; atlasFingerprint = legacy.atlasFingerprint || null;
  }
  const calibration = await prisma.calibration.findUnique({
    where: { id: chosenId },
    include: { pages: { orderBy: { capturedAt: 'asc' } } },
  });
  if (!calibration || !calibration.pages.length) return null;
  return { calibration, degraded, freshness: atlasSlice.atlasFreshness(completedAt, Date.now(), staleAt, atlasFingerprint) };
}

/**
 * Build a context string for the Architect from the CURRENT Calibration slice for
 * a project. Returns null if no usable slice exists. opts = {module, authProfileId}.
 */
async function getCalibrationContext(projectId, opts = {}) {
  const loaded = await loadCurrentCalibration(projectId, opts);
  if (!loaded) return null;
  const { calibration, degraded, freshness } = loaded;

  const lines = [
    `## Site Atlas (from Calibrator — ${calibration.pages.length} pages mapped on ${calibration.createdAt.toISOString().slice(0, 10)})`,
    `Start URL: ${calibration.startUrl}`,
  ];
  // P3b — surface (never hide) when this atlas is role-agnostic or stale, so the
  // Architect treats its HOW evidence with the right confidence. NEVER a reason
  // to weaken an OUTCOME — the anti-circular firewall still owns business truth.
  if (degraded === 'no_authprofile_slice') {
    lines.push('NOTE: no calibration exists for this run\'s identity yet — using the role-agnostic site map. Element availability may differ for this role.');
  }
  if (freshness && freshness.stale) {
    lines.push(`NOTE: this atlas is stale (mapped over ${Math.round((freshness.ageMs || 0) / 86400000)} days ago) — labels/selectors may have drifted; re-calibrate for full confidence.`);
  }
  if (freshness && freshness.schemaStale) {
    lines.push(`NOTE: this atlas was captured with an older parser schema; re-calibrate to refresh selector and role-map evidence for ${freshness.schemaVersion}.`);
  }

  // Structured crawl coverage — what the PLAN actually mapped, so the Architect
  // treats this atlas as a coverage CONTRACT (which modules/tabs exist, and which
  // were NOT mapped) rather than just a bag of pages. Read defensively: the
  // columns are absent on a pre-regen client (→ undefined), so the block is simply
  // omitted there. Generic — module keys come from the live nav, never hardcoded.
  let coverage = null;
  try { coverage = calibration.coverageReportJson ? JSON.parse(calibration.coverageReportJson) : null; } catch { coverage = null; }
  const sufficiency = calibration.sufficiency || (coverage && coverage.sufficiency) || null;
  const crawlMode = calibration.crawlMode || (coverage && coverage.crawlMode) || null;
  if (coverage || sufficiency) {
    lines.push('', '## Crawl coverage (a coverage contract — not just context)');
    if (crawlMode) lines.push(`Crawl mode: ${crawlMode}`);
    if (sufficiency) {
      lines.push(`Atlas sufficiency: ${sufficiency}${sufficiency !== 'sufficient'
        ? ' — areas NOT listed below are UNVERIFIED; do not invent routes/labels/assertions for them, and prefer marking the affected stories incomplete over guessing.'
        : ''}`);
    }
    if (coverage) {
      lines.push(`Mapped: ${coverage.modulesVisited}/${coverage.modulesDiscovered} module(s), ${coverage.pagesVisited} page(s), ${coverage.tabsVisited}/${coverage.tabsDiscovered} tab substate(s); ${coverage.duplicateStatesSkipped} duplicate state(s) skipped.`);
      const ppm = coverage.pagesPerModule || {};
      const ppmKeys = Object.keys(ppm);
      if (ppmKeys.length) lines.push(`Pages per module: ${ppmKeys.map((k) => `${k}=${ppm[k]}`).join(', ')}`);
      const skipped = Array.isArray(coverage.modulesSkipped) ? coverage.modulesSkipped : [];
      if (skipped.length) {
        lines.push(`NOT MAPPED (coverage gap — do NOT author grounded steps/assertions here; flag such stories as needing crawl coverage): ${skipped.map((m) => m.label || m.key).join(', ')}`);
      }
    }
  }

  lines.push('', 'Verified pages:');
  for (const page of calibration.pages.slice(0, 20)) {
    const elements = JSON.parse(page.elementsJson || '[]');
    lines.push(`- ${page.pageRole || 'page'} (${page.url})`);
    for (const el of elements.slice(0, 8)) {
      // Lead with the highest-stability VERIFIED selector (skip the
      // session-scoped mcp-ref — it's meaningless across runs). This is the
      // rerun-speed fix: it lets the EXECUTOR target the element correctly on
      // its FIRST attempt instead of improvising from a raw snapshot and only
      // receiving the verified selector reactively inside the healer AFTER a
      // failed click. Vocabulary only — it changes HOW we find the element,
      // never the verdict.
      const stable = Array.isArray(el.selectorChain)
        ? el.selectorChain.find((s) => s && s.strategy && s.strategy !== 'mcp-ref')
        : null;
      const sel = stable?.selector ? ` → ${stable.selector}` : '';
      lines.push(`  • ${el.semanticLabel}${sel}`);
    }
    // Visible text actually shown on this page — the labels/headings/column
    // headers a TEXT assertion can legitimately check for. Without this the
    // Architect invented copy (e.g. "Employee Name" on a form that shows "First
    // Name"). Capped so a dense page can't blow the prompt budget.
    let corpus = [];
    try { corpus = JSON.parse(page.textCorpus || '[]'); } catch { corpus = []; }
    if (corpus.length) {
      lines.push(`  visible text: ${corpus.slice(0, 40).map((t) => `"${t}"`).join(', ')}`);
    }
    // Tab/subtab SUBSTATES discovered on this page — surfaced EXPLICITLY (not just
    // folded into the page vocab) so the Architect can author per-tab scenarios:
    // each is a distinct screen reached by clicking a tab WITHOUT a URL change.
    // Absent on a pre-regen client (→ []). Capped to keep the prompt bounded.
    let substates = [];
    try { substates = JSON.parse(page.substatesJson || '[]'); } catch { substates = []; }
    if (Array.isArray(substates) && substates.length) {
      lines.push(`  tab substates (${substates.length}): ${substates.slice(0, 12).map((s) => `"${s.tabLabel || s.heading || 'tab'}"`).join(', ')}`);
      for (const ss of substates.slice(0, 8)) {
        const ssCorpus = Array.isArray(ss.textCorpus) ? ss.textCorpus.slice(0, 12) : [];
        if (ssCorpus.length) lines.push(`    • tab "${ss.tabLabel || ss.heading || ''}" shows: ${ssCorpus.map((t) => `"${t}"`).join(', ')}`);
      }
    }
  }
  lines.push('');
  lines.push('These pages, elements and visible-text labels were verified by a live crawl of THIS application. ARCHITECT: use the page names and element labels to write accurate step descriptions, and author TEXT/PAGE assertions ONLY against strings that appear in a page\'s "visible text" list above — do NOT invent labels a page does not show (a fabricated label cannot be verified and only produces noise). When you assert text that is page-specific, set the assertion\'s targetUrl to the page that shows it. EXECUTOR: prefer the verified selector (after the →) on your FIRST attempt to locate an element — it is ground truth for HOW to find it. NEVER weaken a declared OUTCOME to match the atlas — the atlas governs HOW to interact and WHICH labels exist, never WHAT the business result should be.');

  return lines.join('\n');
}

/**
 * Structured atlas for the deterministic grounding gate (groundAssertions).
 * Returns null if no complete calibration exists. Unlike getCalibrationContext
 * (a prose string for the LLM), this returns machine-readable per-page text so
 * the gate can check, without an LLM, whether an authored TEXT assertion's
 * expectedText is actually shown anywhere we crawled.
 *
 * Shape:
 *   {
 *     pages: [{ url, normalizedUrl, pageRole, textCorpus: string[], elementLabels: string[] }],
 *     allText: string[],  // union of every page's visible CONTENT text (lowercased), for "exists anywhere" checks
 *     structuralNames: string[], // ARIA landmark labels (navigation/region/banner/...) — for the structural-label gate
 *     stale: boolean,     // P3b — past the freshness horizon (surfaced, not hidden)
 *     degraded: string|null, // 'no_authprofile_slice' when standing in the role-agnostic map
 *     slice: { module, authProfileId, version } // which slice grounded this run
 *   }
 *
 * P3b: slice-aware via loadCurrentCalibration — a run grounds ONLY against its own
 * (module, authProfile) slice; a foreign authProfile's evidence is NEVER returned.
 */
async function getCalibrationAtlas(projectId, opts = {}) {
  const loaded = await loadCurrentCalibration(projectId, opts);
  if (!loaded) return null;
  const { calibration, degraded, freshness } = loaded;

  const allText = new Set();
  const structuralNamesSet = new Set(); // ARIA landmark labels across the slice
  const capabilities = []; // P3c — flat capability inventory across the slice's pages
  const pages = calibration.pages.map((p) => {
    let textCorpus = [];
    let elements = [];
    try { textCorpus = JSON.parse(p.textCorpus || '[]'); } catch { textCorpus = []; }
    try { elements = JSON.parse(p.elementsJson || '[]'); } catch { elements = []; }
    // structuralNamesJson is undefined on a pre-regen client → [] (no capture yet).
    let structuralNames = [];
    try { structuralNames = JSON.parse(p.structuralNamesJson || '[]'); } catch { structuralNames = []; }
    for (const s of structuralNames) { const v = String(s || '').trim(); if (v) structuralNamesSet.add(v); }
    // capabilitiesJson is undefined on a pre-regen client → [] (no inventory yet).
    let pageCaps = [];
    try { pageCaps = JSON.parse(p.capabilitiesJson || '[]'); } catch { pageCaps = []; }
    // Carry the FULL capability record — capabilityId (the menu's [id] + the ref
    // operations[] bind to) and evidence (columns/fields the menu hints + the BDD
    // bridge field-grounds against). Projecting only type/name/operations made the
    // menu show [undefined] ids → the Architect could not bind ops (P3d smoke bug).
    for (const c of pageCaps) if (c && c.type) capabilities.push({ capabilityId: c.capabilityId || null, type: c.type, name: c.name, operations: c.operations, evidence: c.evidence, pageUrl: p.url });
    const elementLabels = elements.map((e) => e.semanticLabel || '').filter(Boolean);
    // Element NAMES (button "Login" → "Login") are visible text too — fold the
    // control labels into the per-page text so "click Login" style assertions
    // ground correctly even when the label only lives on an interactive node.
    const elementNames = elements.map((e) => {
      const m = /"([^"]*)"/.exec(e.semanticLabel || '');
      return m ? m[1] : '';
    }).filter(Boolean);
    const pageText = [...textCorpus, ...elementNames];
    for (const t of pageText) allText.add(String(t).toLowerCase());
    return {
      url: p.url,
      normalizedUrl: p.normalizedUrl,
      pageRole: p.pageRole || null,
      textCorpus: pageText,
      elementLabels,
    };
  });
  return {
    pages,
    allText: [...allText],
    structuralNames: [...structuralNamesSet], // ARIA landmark labels — for the structural-label gate
    capabilities,
    stale: !!(freshness && freshness.stale),
    schemaStale: !!(freshness && freshness.schemaStale),
    degraded: degraded || null,
    slice: { module: calibration.module ?? null, authProfileId: calibration.authProfileId ?? null, version: calibration.version ?? 1 },
  };
}

/**
 * Look up a pre-verified selector for an element on a given URL.
 * Used by the Conductor as the first lookup before the healer fires.
 * Returns the best selector string or null if no match.
 */
async function resolveCalibrationSelector(projectId, currentUrl, semanticQuery) {
  const normUrl = normalizeUrl(currentUrl);
  const page = await prisma.calibrationPage.findFirst({
    where: {
      calibration: { projectId, status: 'complete' },
      normalizedUrl: normUrl,
    },
    orderBy: { capturedAt: 'desc' },
  });
  if (!page) return null;

  let elements;
  try { elements = JSON.parse(page.elementsJson); } catch { return null; }

  const query = semanticQuery.toLowerCase();
  const match = elements.find((el) => {
    const label = el.semanticLabel.toLowerCase();
    return label.includes(query) || query.includes(el.ariaRole);
  });
  if (!match) return null;

  // Return the highest-stability verified selector, falling back to unverified
  const candidates = match.selectorChain.sort((a, b) => b.stabilityScore - a.stabilityScore);
  return candidates[0]?.selector || null;
}

module.exports = {
  runCalibrator,
  getCalibrationContext,
  getCalibrationAtlas,
  resolveCalibrationSelector,
  // exported for unit tests (text-corpus + grounding)
  extractTextCorpus,
  extractStructuralNames,           // structural-label gate — exported for regression guard
  parseSnapshotRows,                // planner-row parsing (flags) — exported for crawl-planning guard
  enumerateTabSubstates,            // tab-substate enumeration — exported for the live crawl guard
  harvestNavModulesViaDom,          // nav/module discovery — exported for the live crawl guard
  locateLoginControls,              // staged-auth field discovery - exported for auth-crawl guard
  looksLikeFederatedLogin,          // staged-auth classifier - exported for auth-crawl guard
  isHardAuthChallengeSnapshot,      // MFA/OTP/CAPTCHA gate - exported for auth-crawl guard
  authActionKey,                    // staged-auth loop guard - exported for auth-crawl guard
  shouldClickProviderBeforeIdentifier, // staged-auth provider priority guard
  authFieldAppearsFilled,           // identifier readback guard - exported for auth-crawl guard
  classifyAuthScreenObservation,    // screen-aware auth state machine - exported for auth-crawl guard
  createCrawlActionLedger,          // crawl click memory - exported for crawl loop guard
  isSafeModalOpenerRow,             // crawl modal-probe safety guard
  harvestPageInteriorViaScroll,     // page-interior scroll harvesting guard
  probeModalAffordances,            // safe modal substate capture guard
  extractLinksViaDom,               // scoped content-link discovery guard
  callCalibratorTool,               // gateway-safe MCP adapter for crawl actions
  buildZeroPageCrawlError,           // honest zero-page failure contract
};
