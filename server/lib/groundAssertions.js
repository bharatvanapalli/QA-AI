'use strict';

/**
 * Deterministic grounding gate for declared TEXT assertions.
 *
 * THE PROBLEM IT SOLVES
 * The Architect authors assertions from documents (and, when present, a Site
 * Atlas). It has never *seen* the page, so it sometimes asserts visible text
 * that the target page does not actually show — e.g. "Employee Name" on the
 * OrangeHRM Add-Employee form, which displays "First Name / Middle Name / Last
 * Name". With no criticality set, that hallucinated check defaulted to `must`
 * and, when it came back uncheckable, hard-escalated the whole case to
 * `needs_human`. The verdict layer was correct; the assertion was fabricated.
 *
 * THE FIX (no LLM, no guessing)
 * After a live crawl (the Calibrator) has captured each page's VISIBLE TEXT,
 * we can deterministically check whether an authored TEXT assertion's
 * expectedText is actually shown on the page it targets. When we have positive
 * coverage of that page and the text is absent, the assertion is demoted to a
 * `parseFailed` placeholder with reason `text_ungrounded` — a path the rest of
 * the system already understands: computeVerdict EXCLUDES parseFailed records
 * from the verdict math (they neither pass, fail, nor escalate), and Reports
 * surfaces the note so QA sees exactly why the check was skipped.
 *
 * This is the hard constraint the prompt could only request: a fabricated
 * label can no longer turn a real pass into needs_human/fail, because it is
 * removed from the contract the verdict is computed against — while remaining
 * visible (with its reason) so nothing is hidden.
 *
 * TWO DEMOTION PATHS, ONE BEING THE NARROW EXCEPTION:
 *   1. text_ungrounded (below) — SOFT-tier only, evidence-of-absence required.
 *      Honours the never-mask-a-must rule.
 *   2. structural_label — ANY tier, incl. 'must'. An ARIA LANDMARK accessible
 *      name ("Topbar Menu", "Sidebar", "Primary Navigation") is structural
 *      scaffolding: a presence check on it passes whenever the landmark exists
 *      even if the page is broken, so it is NEVER a real acceptance criterion
 *      and demoting it can never mask a defect. This is the deterministic
 *      ENFORCEMENT of the Architect prompt rule "ARIA structural labels — do not
 *      use as TEXT assertions", keyed off the landmark ROLE captured at
 *      calibration (atlas.structuralNames) — generic on any site, no hardcoded
 *      strings. It is the ONLY case that bypasses the must-guard, and only
 *      because the category itself carries zero diagnostic value.
 *
 * SAFETY / CONSERVATISM
 * FIRST RULE (never mask a real bug): the text_ungrounded path NEVER demotes a
 * 'must' assertion. A 'must' is a hard acceptance criterion — if the app genuinely
 * lacks that text it may be a real defect (a missing BRD-mandated banner), and
 * demoting it would auto-pass the violation. 'must' always flows to the verdict
 * and fails when unmet. The gate only ever touches ungrounded SOFT-tier
 * (should/incidental) copy. Proper authoring-side tiering is the primary cure;
 * the gate is a safe cleanup of secondary/inferred text, not a silencer.
 *
 * Among SOFT-tier assertions, we only demote when we have EVIDENCE of absence:
 *   • the assertion carries an explicit targetUrl that resolves to a crawled
 *     page, and that page's visible text does NOT contain it → demote
 *     ("target_page"). This is the Architect's own claim about WHERE the text
 *     shows, checked against ground truth — the highest-confidence signal.
 *   • the assertion has no usable targetUrl, the atlas is substantial
 *     (≥ minPagesForAnywhere), and the text appears on NO crawled page at all
 *     → demote ("anywhere", a pure fabrication).
 *   • otherwise (thin atlas, targetUrl page not crawled, text present somewhere,
 *     FORBIDDEN/absence assertions, non-TEXT types) → LEAVE AS-IS. Absence of
 *     evidence is never treated as evidence of absence.
 *
 * NOTE we deliberately do NOT scope a no-targetUrl assertion to the case's
 * step-navigated pages: an incomplete crawl (a page the BFS never reached)
 * would then wrongly demote text that genuinely lives on the un-crawled page.
 * A real-but-mis-scoped label (e.g. "Employee Name", which exists on the
 * Employee List page but was asserted on the Add form) is therefore left for
 * the Architect-side prevention — feeding it each page's real visible text so
 * it stops authoring the mis-scoped label in the first place. The gate's job
 * is the deterministic floor: explicit wrong-page claims and pure fabrications.
 *
 * Pure functions. No DB, no LLM, no side effects beyond mutating the passed
 * assertion records in place (and returning them). Exported for unit tests.
 */

// Normalise for comparison: lowercase, strip punctuation to spaces, collapse
// whitespace. So "Employee ID", "Employee Id:", "  employee   id " all compare
// equal — robust to the cosmetic differences between an authored label and the
// crawled accessibility name, without being so loose it matches unrelated text.
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Reduce a URL (full or path) to a comparable path suffix: strip origin,
// query, hash and trailing slash.
function pathOf(u) {
  return norm(String(u || '').replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/\/+$/, ''));
}

// Does this crawled page correspond to the given target URL/path?
function pageMatchesTarget(page, targetUrl) {
  const t = pathOf(targetUrl);
  if (!t || t === '/') return false;          // root/empty path is not specific enough
  const candidates = [pathOf(page.normalizedUrl), pathOf(page.url)];
  return candidates.some((p) => p && (p === t || p.endsWith(t) || p.includes(t)));
}

// Is `needle` present in the page's visible text? Strict FORWARD containment:
// some corpus entry must contain the (normalised) needle verbatim. We do NOT
// match the reverse direction ("page shows 'Employee', assertion wants
// 'Employee Name'") — that reverse match is exactly the fabrication we want to
// catch.
function textPresent(needle, corpus) {
  const n = norm(needle);
  if (!n) return true;                         // nothing to ground → no-op
  for (const c of corpus || []) {
    const cc = norm(c);
    if (cc && cc.includes(n)) return true;
  }
  return false;
}

// Is `expected` ONLY an ARIA landmark accessible name (structural scaffolding),
// and not real visible content anywhere we crawled? A landmark label ("Topbar
// Menu", "Sidebar", "Primary Navigation") matches whenever the landmark exists —
// even if the page is broken — so it has zero diagnostic value as a presence
// assertion. We require an EXACT normalised match against a captured landmark
// name AND absence from the content corpus: a string that is also genuine
// content (e.g. a heading that happens to coincide with a landmark name) is left
// alone. structuralSet empty (pre-regen / legacy atlas) → always false → no-op.
function isStructuralOnly(expected, structuralSet, allText) {
  const n = norm(expected);
  if (!n || !structuralSet.has(n)) return false;
  if (textPresent(expected, allText)) return false; // also real content → keep
  return true;
}

// Criticality normaliser — mirrors computeVerdict: silence = 'must'.
function crit(c) {
  return (c === 'should' || c === 'incidental') ? c : 'must';
}

function demote(a, expected, where) {
  a.parseFailed = true;
  a.parseFailedReason = 'text_ungrounded';
  const why = `auto: "${String(expected).slice(0, 60)}" is not shown on the calibrated ${where} — skipped (text_ungrounded)`;
  a.note = a.note ? `${String(a.note).slice(0, 70)} | ${why}` : why;
}

/**
 * Ground one case's declared assertions against the atlas, in place.
 *
 * @param {Array}  assertions  normalized declaredAssertions for the case
 * @param {Array}  steps       the case's steps (reserved; not used for scoping —
 *                             see the SAFETY note above on why step-URL scoping
 *                             is intentionally avoided)
 * @param {Object} atlas       getCalibrationAtlas() result, or null
 * @param {Object} [opts]      { caseName, minPagesForAnywhere = 3 }
 * @returns {{ assertions: Array, demoted: Array, emptied: boolean }}
 */
function groundCaseAssertions(assertions, steps, atlas, opts = {}) {
  const demoted = [];
  const list = Array.isArray(assertions) ? assertions : [];
  if (!atlas || !Array.isArray(atlas.pages) || atlas.pages.length === 0) {
    return { assertions: list, demoted, emptied: false };
  }
  const minPagesForAnywhere = opts.minPagesForAnywhere ?? 3;
  const structuralSet = new Set((atlas.structuralNames || []).map(norm));

  for (const a of list) {
    if (!a || a.parseFailed) continue;
    if (a.type !== 'TEXT') continue;
    const expected = (a.payload && a.payload.expectedText) != null ? a.payload.expectedText : a.expectedText;
    if (typeof expected !== 'string' || !expected.trim()) continue;
    // FORBIDDEN / absence assertions assert the text is GONE — never demote.
    if (a.payload && typeof a.payload.unexpectedText === 'string') continue;

    // DATA-ORACLE PLACEHOLDER guard. A tokenized expectedText — {{expected}},
    // {{expectedVisibleSignal}}, {{expectedPlatformVerdict}} — is NOT literal copy: it
    // resolves to a real value only after per-ROW data substitution at RUN time.
    // Grounding runs at AUTHORING time (pre-substitution), so verifying the raw token
    // against the calibrated page corpus is meaningless and produced spurious
    // text_ungrounded / structural_label parseFailed. Skip grounding for any
    // expectedText still carrying an unresolved {{token}}; the row-resolved value is
    // validated against the WorkbookContract expected columns (oracleContract), not here.
    if (/\{\{\s*[a-zA-Z_][\w.]*\s*\}\}/.test(expected)) continue;

    // STRUCTURAL-LABEL gate (any criticality, incl. 'must'). An ARIA landmark
    // accessible name is structural scaffolding: a presence check on it passes
    // whenever the landmark exists — even if the navigation is broken, empty, or
    // showing the wrong user — so it has ZERO diagnostic value. Unlike the
    // text_ungrounded path below (soft-tier only, to avoid masking a missing
    // requirement), this demotes EVERY tier: a landmark label is NEVER a real
    // acceptance criterion, so demoting it can never mask a real defect — which
    // is precisely why bypassing the must-guard is safe here and nowhere else.
    // Keyed off the ARIA ROLE captured at calibration → generic on any site, no
    // hardcoded strings. This is the deterministic ENFORCEMENT of the Architect
    // prompt rule "ARIA structural labels — do not use as TEXT assertions".
    if (isStructuralOnly(expected, structuralSet, atlas.allText)) {
      a.parseFailed = true;
      a.parseFailedReason = 'structural_label';
      const why = `auto: "${String(expected).slice(0, 60)}" is an ARIA landmark label (structural scaffolding, not visible content) — skipped (structural_label)`;
      a.note = a.note ? `${String(a.note).slice(0, 70)} | ${why}` : why;
      demoted.push({ caseName: opts.caseName || '', expected, scope: 'structural_label', pages: [] });
      continue;
    }

    // MASKING GUARD (architect review #2 — the dangerous case). NEVER demote a
    // 'must' assertion. A 'must' is a hard acceptance criterion: if its text is
    // genuinely absent from the app, that may be a REAL DEFECT — e.g. a
    // BRD-mandated compliance banner the developer forgot to render. Demoting it
    // would silently mask the bug and auto-pass a violation. So a 'must' always
    // flows to the verdict and FAILS when unmet (the human sees the real defect).
    // The gate only strips ungrounded SOFT-tier copy (should/incidental) — the
    // inferred/secondary text that was never a real requirement. This is why
    // proper authoring-side tiering (atlas-grounded labels + the negative-case
    // doctrine) is the PRIMARY cure; the gate is a safe cleanup, not a silencer.
    if (crit(a.criticality) === 'must') continue;

    // (a) explicit targetUrl resolving to a crawled page → strict per-page check.
    const scopePages = a.targetUrl ? atlas.pages.filter((p) => pageMatchesTarget(p, a.targetUrl)) : [];
    if (scopePages.length > 0) {
      const grounded = scopePages.some((p) => textPresent(expected, p.textCorpus || []));
      if (!grounded) {
        const where = scopePages.map((p) => p.pageRole || p.url).slice(0, 2).join(' / ') || 'target page';
        demote(a, expected, where);
        demoted.push({ caseName: opts.caseName || '', expected, scope: 'target_page', pages: scopePages.map((p) => p.url) });
      }
      continue;
    }
    // (b) no usable page scope → only catch pure fabrications (text on NO page),
    // and only when the atlas is substantial enough to trust an absence.
    if (atlas.pages.length >= minPagesForAnywhere) {
      const existsAnywhere = (atlas.allText || []).some((c) => norm(c).includes(norm(expected)));
      if (!existsAnywhere) {
        demote(a, expected, 'application (text appears on no crawled page)');
        demoted.push({ caseName: opts.caseName || '', expected, scope: 'anywhere', pages: [] });
      }
    }
    // else: insufficient evidence — leave the assertion untouched.
  }

  const emptied = list.length > 0 && list.every((a) => a && a.parseFailed);
  return { assertions: list, demoted, emptied };
}

module.exports = {
  groundCaseAssertions,
  // exported for unit tests
  norm,
  pathOf,
  pageMatchesTarget,
  textPresent,
};
