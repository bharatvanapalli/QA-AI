'use strict';

/**
 * Step 3B resolver — storyId-first data binding over the WorkbookContract.
 *
 * Binding order (the load-bearing fix): EXACT case.storyId → workbook row.storyId
 * wins; else module/scope; else semantic (token overlap) — and a semantic-only
 * bind is flagged WEAK (needs_review). A storyId match BEATS keyword overlap, so a
 * PIM case never binds Admin_UserSearch just because columns look similar; and a
 * case that cites a storyId no sheet carries becomes needs_review instead of a
 * confident wrong bind.
 *
 * Pure (no DB / LLM / IO). Consumes the canonical WorkbookContract (RowContract
 * storyIds). Generic — keyed off the storyId join + sheet-name module tokens.
 */

const { normalizeStoryId } = require('./storyId');

const tok = (s) => String(s == null ? '' : s)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')        // split camelCase
  .toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

/** Map normalized storyId → [{ sheet, storyColumn, rowIndices }] across the contract. */
function buildStoryIndex(contract) {
  const idx = new Map();
  for (const s of (contract && Array.isArray(contract.sheets) ? contract.sheets : [])) {
    const byStory = new Map();
    for (const r of (Array.isArray(s.rows) ? s.rows : [])) {
      const sid = normalizeStoryId(r.storyId);
      if (!sid) continue;
      if (!byStory.has(sid)) byStory.set(sid, []);
      byStory.get(sid).push(r.index);
    }
    for (const [sid, rowIndices] of byStory) {
      if (!idx.has(sid)) idx.set(sid, []);
      idx.get(sid).push({ sheet: s.name, storyColumn: s.storyIdColumn, rowIndices });
    }
  }
  return idx;
}

/** Sheets whose name tokens include the case's module token (module/scope match). */
function sheetsForModule(module, contract) {
  const mtoks = tok(module);
  if (!mtoks.length) return [];
  const out = [];
  for (const s of (contract && Array.isArray(contract.sheets) ? contract.sheets : [])) {
    const sToks = new Set(tok(s.name));
    if (mtoks.some((m) => sToks.has(m))) out.push(s);
  }
  return out;
}

/**
 * Resolve the binding for one case.
 * @param {{storyId?, module?}} caseDesc
 * @param {object} contract  WorkbookContract
 * @returns {{ sheet, storyColumn?, storyId?, rowIndices?, matchKind:'storyId'|'module'|'none', needsReview:boolean, reason:string } | null}
 *          null = no storyId/module signal → caller falls back to semantic (weak).
 */
function resolveStoryBinding(caseDesc, contract) {
  const sid = normalizeStoryId(caseDesc && caseDesc.storyId);
  if (sid) {
    const hits = buildStoryIndex(contract).get(sid) || [];
    if (hits.length) {
      // Prefer the sheet that carries the MOST rows for this story (its home sheet).
      const best = hits.slice().sort((a, b) => b.rowIndices.length - a.rowIndices.length)[0];
      return {
        sheet: best.sheet, storyColumn: best.storyColumn, storyId: sid, rowIndices: best.rowIndices,
        matchKind: 'storyId', needsReview: false,
        reason: `case storyId ${sid} matches ${best.rowIndices.length} row(s) in "${best.sheet}" (beats keyword overlap)`,
      };
    }
    // storyId cited but NO sheet carries it → never guess a wrong sheet.
    return { sheet: null, storyId: sid, matchKind: 'none', needsReview: true, reason: `case cites storyId ${sid} but no workbook sheet/row carries it` };
  }
  // No storyId → module/scope match (weaker but structural).
  const modSheets = sheetsForModule(caseDesc && caseDesc.module, contract);
  if (modSheets.length === 1) {
    return { sheet: modSheets[0].name, storyColumn: modSheets[0].storyIdColumn || null, matchKind: 'module', needsReview: false, reason: `module "${caseDesc.module}" matches sheet "${modSheets[0].name}"` };
  }
  // 0 or ambiguous module match → caller uses semantic (flagged weak).
  return null;
}

module.exports = { buildStoryIndex, sheetsForModule, resolveStoryBinding };
