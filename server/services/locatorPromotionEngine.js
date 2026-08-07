'use strict';

/**
 * Locator Promotion Engine (Phase B-2d.2c+) — the Bulletproof Locator Synthesizer.
 *
 * FORGES durable Gold/Silver locators from captured action-time context and emits
 * a LocatorPassport (ranked candidates, each with STRUCTURED args so codegen
 * never needs eval). PROOF is live (count===1 + same target + actionable +
 * survives re-render + post-action effect) — `proveCandidate`/`buildProvenPassport`
 * supply the contract; the resolver is injected by the conductor at B-2e.
 *
 * Bronze is an INPUT to promotion, never an output: `bronzeOnly`/`needsPromotion`
 * mark a capture-engine defect to repair, never a resting/export state.
 *
 * GENERATION is pure + deterministic (proven offline). Role names are normalized
 * to valid ARIA roles (never getByRole('input')); ids/attrs are CSS/attr escaped.
 */

function q(s) { return String(s == null ? '' : s).replace(/'/g, "\\'"); }
// CSS identifier escaping for #id / .class (handles : . space etc.).
function cssEscape(s) { return String(s == null ? '' : s).replace(/([^a-zA-Z0-9_ -￿-])/g, '\\$1'); }
// Attribute-VALUE escaping for [name="..."] (escape backslash + double quote).
function attrEscape(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

const TAG_ROLE = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button', option: 'option' };
const INPUT_TYPE_ROLE = {
  text: 'textbox', email: 'textbox', password: 'textbox', search: 'searchbox', tel: 'textbox', url: 'textbox',
  number: 'spinbutton', checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', range: 'slider',
};
const VALID_ARIA_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
  'option', 'spinbutton', 'slider', 'treeitem', 'menuitemcheckbox', 'menuitemradio', 'heading', 'img', 'dialog',
  'alertdialog', 'alert', 'row', 'cell', 'gridcell', 'columnheader', 'rowheader', 'tabpanel', 'banner', 'navigation',
  'main', 'complementary', 'contentinfo', 'region', 'article', 'group', 'form', 'table', 'list', 'listitem',
]);

/** Map a raw role/tag (+ input type) to a VALID ARIA role, or null. Never 'input'/'a'/etc. */
function normalizeRole(role, opts = {}) {
  const r = String(role || '').toLowerCase().trim();
  if (!r) return null;
  if (VALID_ARIA_ROLES.has(r)) return r;
  if (r === 'input') return INPUT_TYPE_ROLE[String(opts.type || 'text').toLowerCase()] || 'textbox';
  if (TAG_ROLE[r]) return TAG_ROLE[r];
  return null; // unknown tag → don't emit an invalid getByRole
}

const STRATEGY_ORDER = [
  'dialog_scoped_role', 'role', 'testId', 'label', 'placeholder', 'title', 'altText',
  'record_action', 'ancestor_role_chain', 'text_exact', 'ancestor_hasText_role',
  'id', 'name', 'data_attr', 'ancestor_structural_child', 'label_region', 'scoped_css',
];
const SEMANTIC_ANCESTOR_RE = /dialog|form|region|row|listitem|article|group|table|navigation|complementary|tabpanel|banner|contentinfo/;

// ── Context-Aware Strategy Ranking + Locator Scorecard ──────────────────────
// The engine chooses a locator strategy by the element's UI CONTEXT, not a fixed
// order: a form control near a label prefers label/role/placeholder/label_region;
// a row/list/card action prefers record_action; a modal control prefers a
// dialog-scoped semantic locator. record_action (often CSS-class-derived) must
// NEVER outrank a clean label/role/testId/placeholder for a normal form field.
const INPUT_LIKE = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'checkbox', 'radio', 'switch', 'slider', 'option']);
const COMMAND_LIKE = new Set(['button', 'link', 'menuitem', 'tab', 'treeitem']);
const SEMANTIC_STRATEGY = new Set(['role', 'testId', 'label', 'placeholder', 'title', 'altText', 'dialog_scoped_role']);
const TIER_BASE = { gold: 1000, silver: 500, bronze: 0 };
// Within-tier semantic strength of each strategy (higher = stronger/cleaner).
const STRATEGY_SEMANTIC = {
  dialog_scoped_role: 96, role: 95, testId: 92, label: 90, placeholder: 86, title: 70, altText: 70,
  ancestor_role_chain: 82, record_action: 80, label_region: 76, text_exact: 60, ancestor_hasText_role: 58,
  id: 55, name: 52, data_attr: 50, ancestor_structural_child: 45, scoped_css: 40,
};
// Per-context preferred / discouraged strategies (bonus / penalty applied to score).
const CONTEXT_PREFERENCE = {
  form_control: { prefer: ['role', 'label', 'placeholder', 'label_region', 'id', 'name'], avoid: ['record_action', 'ancestor_hasText_role', 'text_exact'] },
  record_action: { prefer: ['record_action', 'ancestor_role_chain', 'dialog_scoped_role', 'testId'], avoid: ['label_region'] },
  dialog_control: { prefer: ['dialog_scoped_role', 'role', 'label', 'testId', 'placeholder'], avoid: ['record_action'] },
  generic: { prefer: ['role', 'testId', 'label', 'placeholder'], avoid: [] },
};

/** Derive a label-region string for a role-less control (own labelText, else by
 *  subtracting the control's own text from an ancestor's text). Pure. */
function deriveLabelRegion(ctx = {}) {
  if (ctx.labelText) return String(ctx.labelText);
  if (!Array.isArray(ctx.ancestors) || !ctx.name) return null;
  const own = String(ctx.name).trim();
  for (const a of ctx.ancestors) {
    const at = String((a && a.name) || '').trim();
    if (at && own && at.length > own.length && at.endsWith(own)) {
      const c = at.slice(0, at.length - own.length).trim();
      if (c && c.length <= 40) return c;
    }
  }
  return null;
}

/** A TRUE data record (table/grid/list/card row), NOT a single-control form-field
 *  group. record_action is reserved for these. */
function isDataRecord(rec) {
  if (!rec) return false;
  if (/^(row|listitem|gridcell|treeitem)$/i.test(rec.containerRole || '')) return true;
  if (/^(tr|li)$/i.test(rec.containerTag || '')) return true;
  if (/\[role="(row|listitem|gridcell|treeitem)"\]/.test(rec.recordSelector || '')) return true;
  // repeated container holding several DATA cells (a data row has many cells; a
  // form-field group has ~1 control + a label).
  return (rec.siblingCount >= 2 && Array.isArray(rec.cellTexts) && rec.cellTexts.length >= 3);
}

/** Classify the UI context of the element being located. Driven primarily by the
 *  ELEMENT's interaction class (input-like vs command-like), record/dialog second. */
function classifyLocatorContext(ctx = {}) {
  const role = normalizeRole(ctx.role, { type: ctx.inputType });
  const anc = Array.isArray(ctx.ancestors) ? ctx.ancestors : [];
  const inDialog = anc.some((a) => /dialog|alertdialog|modal/i.test((a && a.role) || ''));
  const labelRegion = deriveLabelRegion(ctx);
  const inputLike = (role && INPUT_LIKE.has(role)) || (!role && !!labelRegion);
  const commandLike = (role && COMMAND_LIKE.has(role)) || (!role && !ctx.name && !labelRegion); // nameless icon
  // A form control wins form_control even when it sits inside a repeated record
  // (the dropdown-in-a-grid case) — prefer its label, not the record.
  if (inputLike) return inDialog ? 'dialog_control' : 'form_control';
  if (isDataRecord(ctx.record) && (commandLike || !ctx.name)) return 'record_action';
  if (inDialog && (commandLike || role)) return 'dialog_control';
  return 'generic';
}

/** True when a candidate leans on an app-CSS class/id selector (brittle vs semantic). */
function usesAppCss(cand) {
  return (cand.build || []).some(([m, a]) => m === 'locator' && typeof a === 'string'
    && /[.#]/.test(a) && !/^xpath=/.test(a) && a !== '..' && !/\[(data-testid|data-test|name|role|aria-|tabindex)/.test(a));
}

/**
 * Score a candidate by UI context. Dimensions: tier, semantic strength,
 * context-fit, stability (penalise app-CSS), scope quality, readability, frame
 * scope, and (when supplied) live PROOF (uniqueness/actionable/unobscured/
 * rerender). The highest score — not the first proven — is exported.
 */
function scoreCandidate(cand, meta = {}) {
  const context = meta.context || 'generic';
  const pref = CONTEXT_PREFERENCE[context] || CONTEXT_PREFERENCE.generic;
  const parts = {};
  parts.tier = TIER_BASE[cand.tier] || 0;
  parts.semantic = STRATEGY_SEMANTIC[cand.strategy] != null ? STRATEGY_SEMANTIC[cand.strategy] : 30;
  parts.context = pref.prefer.includes(cand.strategy) ? 30 : (pref.avoid.includes(cand.strategy) ? -45 : 0);
  parts.stability = usesAppCss(cand) ? -18 : (SEMANTIC_STRATEGY.has(cand.strategy) ? 10 : 0);
  parts.scope = /dialog_scoped_role|record_action|ancestor_role_chain/.test(cand.strategy) ? 8 : 0;
  parts.readability = /(role|label|placeholder|testId)/i.test(cand.strategy) ? 6 : (/(xpath|scoped_css|label_region)/.test(cand.strategy) ? -4 : 0);
  parts.frame = cand.framed ? 4 : 0;
  const pr = meta.proof;
  parts.proof = pr ? ((pr.proven ? 20 : -100000) + (pr.actionable ? 6 : 0) + (pr.obscured ? -60 : 0) + (pr.survivesRerender !== false ? 6 : 0)) : 0;
  const score = Object.keys(parts).reduce((a, k) => a + parts[k], 0);
  return { score, parts };
}

// Each candidate carries STRUCTURED `build` steps (base → method chain) so the
// codegen factory can construct the locator WITHOUT eval. `expression` is for
// display/trace only.
function cand(tier, strategy, build, expression) { return { tier, strategy, build, expression }; }

function promoteLocators(ctx = {}) {
  const role = normalizeRole(ctx.role, { type: ctx.inputType });
  const inDialog = (Array.isArray(ctx.ancestors) ? ctx.ancestors : []).some((a) => /dialog|alertdialog|modal/i.test((a && a.role) || ''));
  const out = [];

  // ── GOLD semantic ────────────────────────────────────────────────────────
  // Dialog-scoped semantic FIRST when the control lives in a modal — scope beats
  // a global role match (two "Save" buttons: page + dialog).
  if (inDialog && role && ctx.name) out.push(cand('gold', 'dialog_scoped_role', [['getByRole', 'dialog'], ['getByRole', role, { name: ctx.name }]], `getByRole('dialog').getByRole('${q(role)}', { name: '${q(ctx.name)}' })`));
  if (role && ctx.name) out.push(cand('gold', 'role', [['getByRole', role, { name: ctx.name }]], `getByRole('${q(role)}', { name: '${q(ctx.name)}' })`));
  if (ctx.testId) out.push(cand('gold', 'testId', [['getByTestId', ctx.testId]], `getByTestId('${q(ctx.testId)}')`));
  if (ctx.label) out.push(cand('gold', 'label', [['getByLabel', ctx.label]], `getByLabel('${q(ctx.label)}')`));
  if (ctx.placeholder) out.push(cand('gold', 'placeholder', [['getByPlaceholder', ctx.placeholder]], `getByPlaceholder('${q(ctx.placeholder)}')`));
  if (ctx.title) out.push(cand('gold', 'title', [['getByTitle', ctx.title]], `getByTitle('${q(ctx.title)}')`));
  if (ctx.altText) out.push(cand('gold', 'altText', [['getByAltText', ctx.altText]], `getByAltText('${q(ctx.altText)}')`));

  // ── Relationship Gold: nearest stable semantic ancestor → child control.
  //    Required for icon/SVG actions that lack their own accessible name. ─────
  const anc = (Array.isArray(ctx.ancestors) ? ctx.ancestors : []).find((a) => a
    && (a.testId || a.idAttr || (a.role && a.name)) && SEMANTIC_ANCESTOR_RE.test(String(a.role || '')));
  let ancHead = null; let ancExpr = '';
  if (anc) {
    if (anc.testId) { ancHead = ['getByTestId', anc.testId]; ancExpr = `getByTestId('${q(anc.testId)}')`; }
    else if (anc.idAttr) { ancHead = ['locator', `#${cssEscape(anc.idAttr)}`]; ancExpr = `locator('#${cssEscape(anc.idAttr)}')`; }
    else { ancHead = ['getByRole', normalizeRole(anc.role) || 'group', { name: anc.name }]; ancExpr = `getByRole('${q(normalizeRole(anc.role) || 'group')}', { name: '${q(anc.name)}' })`; }
  }
  if (ancHead && role && (ctx.name || ctx.text)) {
    const childName = ctx.name || ctx.text;
    out.push(cand('gold', 'ancestor_role_chain', [ancHead, ['getByRole', role, { name: childName }]], `${ancExpr}.getByRole('${q(role)}', { name: '${q(childName)}' })`));
  }

  // ── Text forging (div-soup): exact visible text, and ancestor.filter(hasText). ─
  if (ctx.text && ctx.textUnique) {
    out.push(cand('gold', 'text_exact', [['getByText', ctx.text, { exact: true }], ['filter', { visible: true }]], `getByText('${q(ctx.text)}', { exact: true }).filter({ visible: true })`));
    if (ancHead && role) {
      out.push(cand('gold', 'ancestor_hasText_role', [ancHead, ['filter', { hasText: ctx.text }], ['getByRole', role]], `${ancExpr}.filter({ hasText: '${q(ctx.text)}' }).getByRole('${q(role)}')`));
    }
  }

  // ── Record / row action anchoring (tables, grids, lists, cards) ───────────
  // Anchor an action to the RECORD it belongs to: select all record containers,
  // narrow to the one with the row's UNIQUE text, then the action child. Generic
  // (works on <tr>, role=row/listitem, and repeated div-grids/cards — the record
  // selector is derived structurally, NOT from site classes). Uniqueness is
  // PROVEN live (count===1) — `.filter({hasText})` narrows, never `.first()`.
  // Forbidden: blind `locator('div, li, tr')` bases — recordSelector is required.
  const rec = ctx.record;
  if (rec && rec.rowText && (rec.recordSelector || rec.containerTestId || (rec.containerRole && normalizeRole(rec.containerRole)))) {
    let recHead; let recExpr;
    if (rec.containerTestId) { recHead = ['getByTestId', rec.containerTestId]; recExpr = `getByTestId('${q(rec.containerTestId)}')`; }
    else if (rec.containerRole && normalizeRole(rec.containerRole)) { const rr = normalizeRole(rec.containerRole); recHead = ['getByRole', rr]; recExpr = `getByRole('${q(rr)}')`; }
    else { recHead = ['locator', String(rec.recordSelector)]; recExpr = `locator('${q(rec.recordSelector)}')`; }
    const filterStep = ['filter', { hasText: rec.rowText }];
    const filterExpr = `.filter({ hasText: '${q(rec.rowText)}' })`;
    if (role && (ctx.name || ctx.text)) {
      // Named action child inside the record → Gold (semantic + scoped).
      const childName = ctx.name || ctx.text;
      out.push(cand('gold', 'record_action', [recHead, filterStep, ['getByRole', role, { name: childName }]], `${recExpr}${filterExpr}.getByRole('${q(role)}', { name: '${q(childName)}' })`));
    } else if (ctx.actionSelector) {
      // Icon-only / nameless action → Silver via the stable in-record action selector.
      out.push(cand('silver', 'record_action', [recHead, filterStep, ['locator', String(ctx.actionSelector)]], `${recExpr}${filterExpr}.locator('${q(ctx.actionSelector)}')`));
    } else if (role) {
      out.push(cand('silver', 'record_action', [recHead, filterStep, ['getByRole', role]], `${recExpr}${filterExpr}.getByRole('${q(role)}')`));
    }
  }

  // ── SILVER structural ─────────────────────────────────────────────────────
  if (ctx.idAttr && !isDynamicToken(ctx.idAttr)) out.push(cand('silver', 'id', [['locator', `#${cssEscape(ctx.idAttr)}`]], `locator('#${cssEscape(ctx.idAttr)}')`));
  if (ctx.nameAttr) out.push(cand('silver', 'name', [['locator', `[name="${attrEscape(ctx.nameAttr)}"]`]], `locator('[name="${attrEscape(ctx.nameAttr)}"]')`));
  for (const [k, v] of Object.entries(ctx.dataAttrs || {})) { if (v && !isDynamicToken(v)) out.push(cand('silver', 'data_attr', [['locator', `[${k}="${attrEscape(v)}"]`]], `locator('[${q(k)}="${attrEscape(v)}"]')`)); }
  // Icon-only with no name/text: anchor to the stable ancestor, then a structural child.
  if (ancHead && !ctx.name && !ctx.text && ctx.childTag) {
    out.push(cand('silver', 'ancestor_structural_child', [ancHead, ['locator', String(ctx.childTag)]], `${ancExpr}.locator('${q(ctx.childTag)}')`));
  }
  if (ctx.scopedCss && ancHead) out.push(cand('silver', 'scoped_css', [ancHead, ['locator', ctx.scopedCss]], `${ancExpr}.locator('${q(ctx.scopedCss)}')`));

  // ── Label-region anchored (role-less / no-gold custom controls) ───────────
  // Derive the label by SUBTRACTING the control's own text from an ancestor's
  // text ("User Role-- Select --" − "-- Select --" => "User Role"), then anchor:
  // the label text → its parent group → the interactive child. Generic (no site
  // classes) — covers role-less custom dropdowns/selects, date pickers, etc.
  const labelRegion = deriveLabelRegion(ctx);
  const interactiveSel = role
    ? (/combobox|listbox/.test(role) ? '[role="combobox"], [role="listbox"]' : null)
    : '[tabindex]:not([tabindex="-1"])';
  const noGold = !out.some((c) => c.tier === 'gold');
  if (labelRegion && interactiveSel && (role === null || noGold)) {
    // Forge MULTIPLE anchor relationships; live proof picks whichever resolves
    // to count===1 (DOM nesting varies). Generic — no site classes.
    // (a) label → nearest ancestor that CONTAINS an interactive descendant → it
    //     (robust to depth; naturally skips a same-text column header whose
    //     container has no interactive descendant).
    const ancXp = 'xpath=ancestor::*[descendant::*[@tabindex and not(@tabindex="-1")] or descendant::*[@role="combobox"]][1]';
    out.push(cand('silver', 'label_region',
      [['getByText', labelRegion, { exact: true }], ['locator', ancXp], ['locator', interactiveSel]],
      `getByText('${q(labelRegion)}', { exact: true }).locator("${ancXp}").locator('${q(interactiveSel)}')`));
    // (b) label → first focusable FOLLOWING it (label-then-control layouts).
    out.push(cand('silver', 'label_region',
      [['getByText', labelRegion, { exact: true }], ['locator', 'xpath=following::*[@tabindex and not(@tabindex="-1")][1]']],
      `getByText('${q(labelRegion)}', { exact: true }).locator("xpath=following::*[@tabindex and not(@tabindex='-1')][1]")`));
    // (c) label → its parent → interactive descendant (sibling label+control).
    out.push(cand('silver', 'label_region',
      [['getByText', labelRegion, { exact: true }], ['locator', '..'], ['locator', interactiveSel]],
      `getByText('${q(labelRegion)}', { exact: true }).locator('..').locator('${q(interactiveSel)}')`));
  }

  // ── FRAME wrapping ─────────────────────────────────────────────────────────
  const framed = ctx.frame
    ? out.map((c) => ({ ...c, build: [['frameLocator', ctx.frame], ...c.build], expression: `frameLocator('${q(ctx.frame)}').${c.expression}`, framed: true }))
    : out;

  // CONTEXT-AWARE ranking: score each candidate by UI context (form/record/
  // dialog/generic) + semantic strength + stability, and sort by score. This is
  // what stops a CSS-derived record_action from outranking a clean label_region
  // on a form control. Live PROOF later re-confirms the winner among proven.
  const context = classifyLocatorContext(ctx);
  for (const c of framed) { const s = scoreCandidate(c, { context }); c.score = s.score; c.scoreParts = s.parts; c.context = context; }
  framed.sort((a, b) => (b.score - a.score) || (STRATEGY_ORDER.indexOf(a.strategy) - STRATEGY_ORDER.indexOf(b.strategy)));
  return framed;
}

// Reject obviously dynamic ids/attrs (frameworks emit ember123 / cdk-overlay-7 /
// :r3: / random hashes) so we never forge a brittle Silver locator from them.
function isDynamicToken(v) {
  const s = String(v || '');
  return /^:?r[0-9a-z]+:?$/i.test(s) || /\d{4,}/.test(s) || /[0-9a-f]{8,}/i.test(s) || /(ember|cdk-|ng-|mui-|css-)[0-9a-z-]*\d/i.test(s);
}

function buildPassport(ctx = {}) {
  const candidates = promoteLocators(ctx);
  return {
    kind: 'CandidateLocatorPassport',
    context: classifyLocatorContext(ctx),
    target: { role: normalizeRole(ctx.role, { type: ctx.inputType }), name: ctx.name || null, idAttr: ctx.idAttr || null, frame: ctx.frame || null, bbox: ctx.bbox || null },
    primary: candidates[0] || null,
    alternates: candidates.slice(1),
    needsLiveProof: candidates.length > 0,
    bronzeOnly: candidates.length === 0, // nothing forgeable → repair, never export
  };
}

/**
 * PROOF for one candidate from its live resolution. A candidate is proven only
 * when it is unique (count===1), the same target, actionable, stable across
 * re-render, AND NOT obscured (an overlay/modal/spinner covering the centre point
 * via elementFromPoint disqualifies it — never call a covered element actionable).
 */
function proveCandidate(candidate, resolution) {
  if (!candidate || !resolution || typeof resolution !== 'object') return { ...(candidate || {}), proven: false, reason: 'no resolution' };
  const obscured = resolution.obscured === true;
  const proven = resolution.count === 1 && resolution.sameTarget === true && resolution.actionable === true
    && !obscured && (resolution.survivesRerender !== false);
  return {
    ...candidate, proven,
    proof: { count: resolution.count, sameTarget: !!resolution.sameTarget, actionable: !!resolution.actionable, obscured, survivesRerender: resolution.survivesRerender !== false },
    reason: proven ? 'unique + same target + actionable + unobscured + stable' : `count=${resolution.count}, sameTarget=${resolution.sameTarget}, actionable=${resolution.actionable}, obscured=${obscured}, stable=${resolution.survivesRerender !== false}`,
  };
}

function selectProvenPrimary(provenCandidates, context) {
  const proven = (Array.isArray(provenCandidates) ? provenCandidates : []).filter((c) => c && c.proven);
  if (!proven.length) return null;
  // Pick the HIGHEST-SCORING proven candidate (context-aware), not the first
  // proven. Re-score with the live proof folded in so an unobscured, stable,
  // unique winner is chosen. Tier base keeps Gold above Silver in general.
  const ranked = proven.map((c) => ({ c, s: c.score != null ? c.score : scoreCandidate(c, { context: context || c.context, proof: c.proof }).score }));
  ranked.sort((a, b) => b.s - a.s);
  return ranked[0].c;
}

/**
 * Build a ProvenLocatorPassport by proving each candidate via an injected
 * resolver `resolve(candidate) -> resolution`. Returns the proven primary +
 * proven alternates, or a repair signal when none prove out.
 */
async function buildProvenPassport(candidatePassport, resolve) {
  const cands = candidatePassport ? [candidatePassport.primary, ...(candidatePassport.alternates || [])].filter(Boolean) : [];
  const context = candidatePassport ? candidatePassport.context : 'generic';
  const proven = [];
  const rejected = [];
  for (const c of cands) {
    let res = null;
    try { res = await resolve(c); } catch (_) { res = null; }
    const pc = proveCandidate(c, res || {});
    // Re-score with the live proof folded in (uniqueness/actionable/unobscured/rerender).
    const sc = scoreCandidate(pc, { context, proof: pc.proof });
    pc.score = sc.score; pc.scoreParts = sc.parts;
    if (pc.proven) proven.push(pc); else rejected.push({ strategy: pc.strategy, tier: pc.tier, reason: pc.reason });
  }
  const primary = selectProvenPrimary(proven, context);
  return {
    kind: 'ProvenLocatorPassport',
    context,
    target: candidatePassport ? candidatePassport.target : null,
    primary: primary || null,
    alternates: proven.filter((c) => c !== primary),
    rejected, // why each candidate was NOT selected (codegen passport visibility)
    selectionReason: primary ? `${primary.strategy} (${context}) score=${primary.score}` : null,
    proven: !!primary,
    repairRequired: !primary, // no proven Gold/Silver → repair, never export coordinates
  };
}

/** Bronze-never-rests: cascade evidence with no gold/silver MUST be promoted. */
function needsPromotion(evidence) {
  if (!evidence) return false;
  return (!Array.isArray(evidence.gold) || !evidence.gold.length) && (!Array.isArray(evidence.silver) || !evidence.silver.length);
}

/**
 * Codegen-side factory source (NO eval): builds a Playwright locator from a
 * candidate's structured `build` steps, then a passport resolver that tries
 * PROVEN candidates in order and confirms uniqueness. Emitted into generated POM.
 */
const PASSPORT_FACTORY_SRC = `// QAAI locator factory — builds locators from structured steps (no eval).
function qaaiBuildLocator(page, candidate) {
  let cur = page;
  for (const step of candidate.build) {
    const [method, ...args] = step;
    cur = cur[method](...args);
  }
  return cur;
}
async function qaaiResolve(page, passport) {
  for (const c of [passport.primary, ...(passport.alternates || [])].filter(Boolean)) {
    try { const loc = qaaiBuildLocator(page, c); if (await loc.count() === 1) return loc; } catch (_) {}
  }
  throw new Error('No proven Gold/Silver locator resolved uniquely for ' + (passport.target && passport.target.name));
}`;

module.exports = {
  promoteLocators, buildPassport, proveCandidate, selectProvenPrimary, buildProvenPassport,
  needsPromotion, normalizeRole, cssEscape, attrEscape, isDynamicToken,
  classifyLocatorContext, scoreCandidate, deriveLabelRegion, isDataRecord,
  PASSPORT_FACTORY_SRC, STRATEGY_ORDER,
};
