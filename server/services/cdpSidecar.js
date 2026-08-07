'use strict';

/**
 * CDP / action-time precision sidecar (Phase B-2d.2a).
 *
 * MCP remains the ACTION channel. This sidecar adds the action-time PRECISION
 * capture MCP alone can't: a pre-action DOM atlas (visible interactive candidates
 * with attrs + bounding boxes + surrounding text) and a telemetry listener that
 * records the REAL event target + composedPath + bbox at the moment of the
 * action — BEFORE navigation/DOM mutation removes the element.
 *
 * Availability: the atlas + telemetry run via `browser_evaluate` (always
 * available). True CDP (backendNodeId, cross-shadow composedPath, durable node
 * identity) is BEST-EFFORT — when it can't attach in the MCP architecture we set
 * `cdpAvailable=false` and record the missing fields as gaps for B-2e, never
 * failing the run. Captured evidence flows through the Locator Evidence Cascade
 * (Gold/Silver/Bronze) into PrecisionActionRecord.locatorEvidence.
 *
 * The pure helpers (atlas→evidence, init-script strings) are unit-tested; live
 * capture is proven at B-2e.
 */

const { buildLocatorEvidence } = require('./locatorEvidenceCascade');

// Pre-action DOM atlas — visible interactive candidates with durable attrs, bbox,
// the field LABEL, the ANCESTOR chain (for anchoring nameless/role-less controls),
// the RECORD identity (table/grid/list/card row the action belongs to), a stable
// action-child selector, disabled/visibility state, and input type. GENERIC — no
// site-specific classes; role-less interactive coverage is via tabindex /
// aria-haspopup / contenteditable; record coverage is via role/tag/display +
// repeated-sibling structure (works on virtualized div-grids, not just <tr>).
const DOM_ATLAS_FN = `() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const ROLE_TAGS = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox' };
  const SEM = /(dialog|alertdialog|row|listitem|article|group|table|region|navigation|tabpanel|form|menu|listbox|grid)/i;
  const RECORD_ROLE = /^(row|listitem|article|treeitem)$/i; // a record, NOT a cell
  const CELL_ROLE = /^(cell|gridcell|columnheader|rowheader)$/i;
  const cssEsc = (s) => { try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); } catch (e) { return String(s); } };
  // A class token is "stable" if it isn't framework-generated / hashed / a BEM
  // state modifier. Used to derive generic record + action selectors.
  const stableTokens = (el) => {
    // getAttribute('class') — NOT el.className (which is an SVGAnimatedString object
    // for SVG elements, stringifying to "[object SVGAnimatedString]").
    const cls = (el && el.getAttribute) ? (el.getAttribute('class') || '') : '';
    return cls.split(/\\s+/).filter((c) => c && c.length <= 40 && !/\\d{3,}/.test(c) && !/--/.test(c) && !/^(css|ng|ember|mui|jss|sc|chakra)-/.test(c) && !/[0-9a-f]{8,}/i.test(c));
  };
  const sel = [
    'button', 'a[href]', 'input', 'select', 'textarea',
    '[role=button]', '[role=link]', '[role=textbox]', '[role=combobox]', '[role=checkbox]',
    '[role=radio]', '[role=switch]', '[role=tab]', '[role=menuitem]', '[role=option]', '[role=slider]',
    '[contenteditable=true]', '[tabindex]:not([tabindex="-1"])',
    '[aria-haspopup="true"]', '[aria-haspopup="listbox"]', '[aria-haspopup="menu"]',
  ].join(', ');
  const visible = (el, r) => {
    if (!r || r.width === 0 || r.height === 0) return false;
    let cs; try { cs = getComputedStyle(el); } catch (e) { return true; }
    if (!cs) return true;
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05 && cs.pointerEvents !== 'none';
  };
  const labelOf = (el) => {
    let l = el.getAttribute('aria-label') || '';
    if (!l) { const lb = el.getAttribute('aria-labelledby'); if (lb) { const n = document.getElementById(lb.split(/\\s+/)[0]); if (n) l = n.textContent; } }
    if (!l && el.id) { try { const lf = document.querySelector('label[for="' + cssEsc(el.id) + '"]'); if (lf) l = lf.textContent; } catch (e) {} }
    if (!l) { const lp = el.closest && el.closest('label'); if (lp) l = lp.textContent; }
    return norm(l);
  };
  const ancestorsOf = (el) => {
    const out = []; let cur = el.parentElement; let hops = 0;
    while (cur && hops < 8 && out.length < 2) {
      hops++;
      const role = cur.getAttribute && cur.getAttribute('role');
      const cls = (cur.className && cur.className.toString) ? cur.className.toString() : '';
      const looksContainer = (role && SEM.test(role)) || /(group|row|card|dialog|modal|form|field|item|cell)/i.test(cls);
      if (looksContainer) {
        out.push({
          role: norm(role || (/(row|card)/i.test(cls) ? 'row' : /(dialog|modal)/i.test(cls) ? 'dialog' : /(group|field)/i.test(cls) ? 'group' : '')) || null,
          name: norm(cur.textContent).slice(0, 80),
          testId: cur.getAttribute('data-testid') || cur.getAttribute('data-test') || null,
          idAttr: cur.id || null,
        });
      }
      cur = cur.parentElement;
    }
    return out;
  };
  // Generic record-container selector: role=row/listitem/gridcell, <tr>/<li>,
  // computed display:table-row, OR a repeated sibling container that shares a
  // stable class with >=2 like-tag siblings (the div-grid / card-list case).
  const recordSelectorFor = (el) => {
    const role = el.getAttribute && el.getAttribute('role');
    if (role && RECORD_ROLE.test(role)) return '[role="' + role.toLowerCase() + '"]';
    const tag = el.tagName.toLowerCase();
    if (tag === 'tr') return 'tr';
    if (tag === 'li') return 'li';
    const parent = el.parentElement;
    const toks = stableTokens(el);
    if (parent && toks.length) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      if (sibs.length >= 2) {
        for (const tok of toks) {
          const withTok = sibs.filter((c) => c.classList && c.classList.contains(tok));
          if (withTok.length >= 2) return tag + '.' + cssEsc(tok);
        }
      }
    }
    let cs; try { cs = getComputedStyle(el); } catch (e) {}
    if (cs && cs.display === 'table-row') return tag === 'tr' ? 'tr' : (toks.length ? tag + '.' + cssEsc(toks[0]) : null);
    return null;
  };
  const buildRec = (cur, recSel) => {
    const role = (cur.getAttribute('role') || '').toLowerCase();
    const tag = cur.tagName.toLowerCase();
    const cells = Array.from(cur.children).map((c) => norm(c.textContent)).filter(Boolean).slice(0, 12);
    const sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName) : [];
    return {
      rowText: norm(cur.textContent).slice(0, 120),
      cellTexts: cells,
      recordSelector: recSel,
      containerRole: RECORD_ROLE.test(role) ? role : (tag === 'tr' ? 'row' : tag === 'li' ? 'listitem' : null),
      containerTag: tag,
      containerTestId: cur.getAttribute('data-testid') || cur.getAttribute('data-test') || null,
      rowIndex: sibs.indexOf(cur),
      siblingCount: sibs.length,
    };
  };
  const isCellish = (cur) => {
    const role = (cur.getAttribute('role') || '').toLowerCase();
    if (CELL_ROLE.test(role)) return true;
    return /(^|[\\s_-])cell([\\s_-]|$)/i.test(cur.getAttribute('class') || '');
  };
  // The record (row/card/listitem) an action belongs to. STRONGEST signal first:
  // an explicit record role (role=row/listitem/article, <tr>, <li>) — climb PAST
  // cells (role=cell/gridcell or *cell* class) to reach it. Only when there is no
  // explicit record container do we fall back to the repeated-sibling div-grid /
  // card heuristic (also skipping cells). Generic — no site classes.
  const recordOf = (el) => {
    let cur = el.parentElement; let hops = 0; let fallback = null;
    while (cur && hops < 14) {
      hops++;
      const role = (cur.getAttribute('role') || '').toLowerCase();
      const tag = cur.tagName.toLowerCase();
      if (RECORD_ROLE.test(role) || tag === 'tr' || tag === 'li') {
        const recSel = RECORD_ROLE.test(role) ? '[role="' + role + '"]' : tag;
        const r = buildRec(cur, recSel);
        if (r.rowText) return r; // explicit record with distinguishing text wins
      } else if (!fallback && !isCellish(cur)) {
        const recSel = recordSelectorFor(cur);
        if (recSel) {
          const sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName) : [];
          if (sibs.length >= 2) { const r = buildRec(cur, recSel); if (r.rowText) fallback = r; }
        }
      }
      cur = cur.parentElement;
    }
    return fallback;
  };
  // Nearest scrollable ancestor (for the virtualized-row acquisition loop).
  const scrollContainerOf = (el) => {
    let cur = el.parentElement; let hops = 0;
    while (cur && hops < 16) {
      hops++;
      let cs; try { cs = getComputedStyle(cur); } catch (e) { cur = cur.parentElement; continue; }
      if (cs && /(auto|scroll)/.test(cs.overflowY + ' ' + cs.overflow) && cur.scrollHeight - cur.clientHeight > 8) {
        const toks = stableTokens(cur);
        const role = cur.getAttribute('role');
        return role ? '[role="' + role.toLowerCase() + '"]' : (cur.getAttribute('data-testid') ? '[data-testid="' + cur.getAttribute('data-testid') + '"]' : (toks.length ? cur.tagName.toLowerCase() + '.' + cssEsc(toks[0]) : null));
      }
      cur = cur.parentElement;
    }
    return null;
  };
  // A stable selector that distinguishes THIS action child inside its record:
  // testId, else a child icon's stable class (icon-only actions), else own class.
  const actionSelectorFor = (el) => {
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testId) return '[data-testid="' + testId + '"]';
    let icon = null; try { icon = el.querySelector('i[class], svg[class], [class*=icon]'); } catch (e) {}
    if (icon) { const it = stableTokens(icon); if (it.length) return el.tagName.toLowerCase() + ':has(.' + cssEsc(it[it.length - 1]) + ')'; }
    const own = stableTokens(el);
    if (own.length) return el.tagName.toLowerCase() + '.' + cssEsc(own[own.length - 1]);
    return null;
  };
  const out = [];
  const els = Array.from(document.querySelectorAll(sel)).slice(0, 600);
  const seen = new Set();
  for (const el of els) {
    if (seen.has(el)) continue; seen.add(el);
    let r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }
    if (!visible(el, r)) continue;
    const tag = el.tagName.toLowerCase();
    const label = labelOf(el);
    const name = el.getAttribute('aria-label') || label || norm(el.textContent) || el.getAttribute('value') || '';
    const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null);
    out.push({
      role: el.getAttribute('role') || ROLE_TAGS[tag] || tag,
      name: norm(name).slice(0, 120),
      tag,
      type: tag === 'input' ? (el.getAttribute('type') || 'text') : null,
      labelText: label || null,
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || null,
      idAttr: el.id || null,
      nameAttr: el.getAttribute('name') || null,
      placeholder: el.getAttribute('placeholder') || null,
      title: el.getAttribute('title') || null,
      altText: tag === 'img' ? (el.getAttribute('alt') || null) : null,
      disabled,
      ancestors: ancestorsOf(el),
      record: recordOf(el),
      actionSelector: actionSelectorFor(el),
      scrollContainer: scrollContainerOf(el),
      childTag: tag,
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      surroundingText: norm((el.closest('label, [class*=group], [class*=field], li, td, tr') || el.parentElement || {}).textContent || '').slice(0, 160),
    });
  }
  return out;
}`;

// Telemetry listener — capture-phase, PASSIVE, never preventDefault/stopPropagation,
// try/catch wrapped, bounded ring buffer, minimal synchronous work. Must never
// interfere with the app's native React/Angular/Vue event handling.
//
// Telemetry is CONFIRMATION, not the primary source of action identity (the
// pre-dispatch atlas identity + elementFromPoint is the reliable core). Robust
// install: attach to BOTH window and document, listen to a wide event set, and
// be idempotent + reinstallable (call again after every navigation — listeners
// on the old document are gone once it's replaced). Best-effort same-origin frame
// install too. Uses composedPath()[0] as the REAL target (pierces shadow DOM).
const TELEMETRY_INIT_SCRIPT = `() => {
  try {
    const RING = 80;
    const install = (root, doc) => {
      try {
        if (!root || root.__qaaiTelemetryInstalled) return false;
        root.__qaaiTelemetryInstalled = true;
        const W = (typeof window !== 'undefined') ? window : root;
        W.__qaaiTelemetry = W.__qaaiTelemetry || [];
        const onEvt = (e) => {
          try {
            const path = (typeof e.composedPath === 'function' ? e.composedPath() : []);
            const t = (path && path.length ? path[0] : null) || e.target;
            if (!t || !t.getBoundingClientRect) return;
            const r = t.getBoundingClientRect();
            const trail = path.slice(0, 6).map((n) => (n && n.tagName) ? (n.tagName.toLowerCase() + (n.id ? ('#' + n.id) : '')) : '').filter(Boolean);
            W.__qaaiTelemetry.push({
              type: e.type,
              tag: t.tagName ? t.tagName.toLowerCase() : null,
              role: t.getAttribute ? (t.getAttribute('role') || null) : null,
              idAttr: t.id || null,
              nameAttr: t.getAttribute ? (t.getAttribute('name') || null) : null,
              testId: t.getAttribute ? (t.getAttribute('data-testid') || t.getAttribute('data-test') || null) : null,
              placeholder: t.getAttribute ? (t.getAttribute('placeholder') || null) : null,
              text: (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
              composedPath: trail,
              bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            });
            if (W.__qaaiTelemetry.length > RING) W.__qaaiTelemetry.shift();
          } catch (_) { /* telemetry must never break the app */ }
        };
        const types = ['pointerdown', 'mousedown', 'click', 'input', 'beforeinput', 'change', 'keydown', 'focus'];
        for (const type of types) {
          try { (doc || root).addEventListener(type, onEvt, { capture: true, passive: true }); } catch (_) {}
        }
        return true;
      } catch (_) { return false; }
    };
    let any = false;
    if (typeof document !== 'undefined') any = install(document, document) || any;
    if (typeof window !== 'undefined') any = install(window, document) || any;
    // best-effort same-origin frames
    try {
      const frames = (typeof window !== 'undefined' && window.frames) ? window.frames : [];
      for (let i = 0; i < frames.length; i++) {
        try { const fd = frames[i].document; if (fd) install(fd, fd); } catch (_) { /* cross-origin */ }
      }
    } catch (_) {}
    return any ? 'installed' : 'already_installed';
  } catch (_) { return 'error'; }
}`;

// Pre-dispatch RELIABLE identity: what is actually at the action point. Returns
// the element at the bbox centre (piercing shadow DOM via shadowRoot hit-test)
// and whether the intended target is the hit element or an ancestor of it — i.e.
// NOT obscured by an overlay/modal/spinner. This is the primary capture truth;
// telemetry is only confirmation. Call with { x, y, expect: {testId,id,role,name} }.
const ELEMENT_FROM_POINT_FN = `(arg) => {
  try {
    const x = arg && arg.x, y = arg && arg.y, expect = (arg && arg.expect) || {};
    if (typeof x !== 'number' || typeof y !== 'number') return { ok: false, reason: 'no-point' };
    let el = document.elementFromPoint(x, y);
    // pierce open shadow roots
    let guard = 0;
    while (el && el.shadowRoot && guard < 6) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; guard++; }
    if (!el) return { ok: false, reason: 'no-element-at-point' };
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const idOf = (n) => ({ tag: n.tagName ? n.tagName.toLowerCase() : null, role: n.getAttribute ? (n.getAttribute('role') || null) : null, idAttr: n.id || null, testId: n.getAttribute ? (n.getAttribute('data-testid') || n.getAttribute('data-test') || null) : null, name: norm(n.getAttribute && n.getAttribute('aria-label') || n.textContent || ''), nameAttr: n.getAttribute ? (n.getAttribute('name') || null) : null });
    const hit = idOf(el);
    // does the intended target equal the hit element or one of its ancestors/descendants?
    const matches = (n) => {
      if (!n || !n.getAttribute) return false;
      if (expect.testId && (n.getAttribute('data-testid') === expect.testId || n.getAttribute('data-test') === expect.testId)) return true;
      if (expect.id && n.id === expect.id) return true;
      if (expect.nameAttr && n.getAttribute('name') === expect.nameAttr) return true;
      return false;
    };
    let onTarget = matches(el);
    if (!onTarget) { let a = el, h = 0; while (a && h < 6) { if (matches(a)) { onTarget = true; break; } a = a.parentElement; h++; } }
    return { ok: true, hit, onTarget, obscured: !onTarget && !!(expect.testId || expect.id || expect.nameAttr) };
  } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
}`;

/** Convert one DOM-atlas entry (or telemetry event) into cascade evidence. Pure. */
function atlasEntryToEvidence(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return buildLocatorEvidence({
    role: entry.role, name: entry.name, testId: entry.testId, label: entry.label, placeholder: entry.placeholder,
    idAttr: entry.idAttr, nameAttr: entry.nameAttr,
    bbox: entry.bbox, surroundingText: entry.surroundingText, coordinates: entry.coordinates,
    frame: entry.frame, shadow: entry.shadow,
  });
}

function evalText(mcp, res) {
  const text = (typeof mcp.textOfContent === 'function' ? mcp.textOfContent(res && res.content) : '') || '';
  return typeof mcp.parseEvaluateReturnValue === 'function' ? mcp.parseEvaluateReturnValue(text) : null;
}

/**
 * Sidecar bound to a live MCP session. Telemetry + atlas via browser_evaluate;
 * CDP best-effort (cdpAvailable false until a real attach lands — gaps recorded).
 */
function createSidecar({ mcp, session } = {}) {
  let cdpAvailable = false; // proven/attached at B-2e; telemetry works regardless
  return {
    get cdpAvailable() { return cdpAvailable; },
    // Idempotent + reinstallable — call after EVERY navigation (the old document's
    // listeners die when the document is replaced). Returns 'installed' on a fresh
    // install, 'already_installed' when this document already had it.
    async installTelemetry() {
      try { return evalText(mcp, await mcp.callTool(session, 'browser_evaluate', { function: TELEMETRY_INIT_SCRIPT })); } catch (_) { return null; }
    },
    async getRecentEvents() {
      try { const v = evalText(mcp, await mcp.callTool(session, 'browser_evaluate', { function: '() => (window.__qaaiTelemetry || [])' })); return Array.isArray(v) ? v : []; } catch (_) { return []; }
    },
    async captureAtlas() {
      try { const v = evalText(mcp, await mcp.callTool(session, 'browser_evaluate', { function: DOM_ATLAS_FN })); return Array.isArray(v) ? v : []; } catch (_) { return []; }
    },
    // PRIMARY reliable capture: what is actually at the action point + whether the
    // intended target is obscured by an overlay/modal/spinner. Telemetry is only
    // confirmation; THIS is the truth. `expect` carries the durable identity of
    // the element we mean to act on (testId/id/nameAttr) so we can confirm a hit.
    async elementAtPoint(x, y, expect) {
      try {
        const fn = '(' + ELEMENT_FROM_POINT_FN + ')(' + JSON.stringify({ x, y, expect: expect || {} }) + ')';
        const v = evalText(mcp, await mcp.callTool(session, 'browser_evaluate', { function: fn }));
        return (v && typeof v === 'object') ? v : { ok: false, reason: 'no-result' };
      } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
    },
    // Missing precision fields when CDP isn't attached — surfaced for B-2e, never fatal.
    precisionTelemetryGaps() { return cdpAvailable ? [] : ['backendNodeId', 'cross_shadow_composedPath', 'durable_node_identity']; },
  };
}

module.exports = { DOM_ATLAS_FN, TELEMETRY_INIT_SCRIPT, ELEMENT_FROM_POINT_FN, atlasEntryToEvidence, createSidecar };
