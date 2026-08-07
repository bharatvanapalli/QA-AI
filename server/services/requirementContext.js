'use strict';

/**
 * Enterprise Mode P2-integration — the Architect's requirement context layer.
 *
 * DOCTRINE (user-set, 2026-06-03): once the Requirement Oracle exists, full
 * BRD / user-story / release-note BODIES must NOT keep flowing to the LLM by
 * default. The oracle exists precisely to make requirements deterministic and
 * to REDUCE trust in raw prompt context. So in Enterprise (Hybrid) mode the
 * Architect sees a COMPACT, STRUCTURED clause index — not the source docs:
 *
 *     { "requirementId": "REQ-…", "sourceType": "USER_STORY",
 *       "behaviourText": "Admin user can create a new employee record",
 *       "moduleHint": "Orders" }
 *
 * The verbatim excerpt stays SERVER-SIDE on RequirementClause for audit and
 * Node verification. When the Architect needs richer authoring context, we do
 * LOCAL DETERMINISTIC RETRIEVAL (lexical scoring — NO embedding API, no extra
 * egress): rank clauses by relevance to the generation scope and attach a
 * SHORT, CAPPED, LOGGED excerpt snippet to only the top few. Never the bodies.
 *
 * Additive mode (full bodies + index) survives ONLY as an explicit non-
 * enterprise / dev / RBAC-override path — never the enterprise default.
 *
 * This module is PURE (no DB, no LLM, no I/O) so scripts/verify_contract.cjs
 * can guard the data-minimization invariants directly. architect.js owns where
 * the returned block lands in the prompt; the routes own extraction + the mode
 * decision + the DLP egress gate.
 *
 * See ENTERPRISE_MODE.md → "P2 — Requirement extraction" + the DLP layer.
 */

// Caps — generous enough to author from, bounded enough to keep egress small
// and the prompt within budget. Overridable per-call via opts for tests.
const DEFAULTS = {
  maxClauses: 200,       // hard ceiling on index size (huge multi-module uploads)
  maxSnippets: 40,       // how many top-ranked clauses get a verbatim snippet
  maxSnippetChars: 200,  // per-snippet cap (a short quotable span, never a body)
  maxTotalSnippetChars: 9000, // aggregate snippet egress ceiling
};

// Tiny stop list — enough to stop the lexical ranker keying on filler. Kept
// deliberately small + generic (no domain words) so it never biases scoring.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'be', 'can', 'will', 'shall', 'should', 'must', 'may', 'as', 'at',
  'by', 'it', 'this', 'that', 'these', 'those', 'their', 'they', 'them', 'user',
  'users', 'system', 'able', 'new', 'via', 'from', 'into', 'when', 'then',
]);

function tokenize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

function clip(s, max) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return str.length > max ? str.slice(0, max).trimEnd() + '…' : str;
}

/**
 * Derive a best-effort module hint WITHOUT fabricating one: a clause earns a
 * moduleHint only if a known module name actually appears in its text. No
 * match → null (honest absence, never a guess).
 */
function deriveModuleHint(clause, knownModules) {
  if (!Array.isArray(knownModules) || !knownModules.length) return null;
  const hay = `${clause.behaviourText || ''} ${clause.excerpt || ''}`.toLowerCase();
  for (const m of knownModules) {
    const name = String(m || '').trim();
    if (name && hay.includes(name.toLowerCase())) return name;
  }
  return null;
}

/**
 * The compact, structured clause index — the ONLY requirement data the LLM sees
 * in Hybrid mode. Each row is exactly { requirementId, sourceType, behaviourText
 * [, moduleHint] }. No excerpt, no span, no source body.
 */
function buildClauseIndex(clauses, { knownModules = [] } = {}) {
  return (clauses || [])
    // #14/#13 — non-testable clauses (headings, TOC lines, bare story preambles)
    // are structural noise: they must NOT be shown to the architect as something
    // to author against. Excluded here so the LLM never tries to cite them.
    .filter((c) => c && c.id && c.behaviourText && c.testable !== false)
    .map((c) => {
      const row = {
        requirementId: c.id,
        sourceType: c.sourceType || 'BRD',
        behaviourText: clip(c.behaviourText, 280),
      };
      const hint = c.moduleHint || deriveModuleHint(c, knownModules);
      if (hint) row.moduleHint = hint;
      return row;
    });
}

/**
 * Deterministic lexical relevance of one clause to the generation scope.
 * Pure token overlap (Jaccard-ish) + a moduleHint bonus. No randomness, no
 * model call — the ranking is reproducible and auditable.
 */
function scoreClause(clause, scopeTokenSet, scopeModuleSet) {
  const toks = new Set(tokenize(`${clause.behaviourText || ''} ${clause.excerpt || ''}`));
  if (!toks.size || !scopeTokenSet.size) {
    // No basis to rank on → neutral score; id-order tie-break keeps it stable.
    var overlap = 0;
  } else {
    let hit = 0;
    for (const t of toks) if (scopeTokenSet.has(t)) hit++;
    overlap = hit / Math.sqrt(toks.size); // favour focused clauses over long ones
  }
  let bonus = 0;
  const hint = (clause.moduleHint || '').toLowerCase();
  if (hint && scopeModuleSet.has(hint)) bonus += 2; // a clause for the targeted module ranks up
  return overlap + bonus;
}

/**
 * Rank + cap the clause set against the scope. Returns the kept clauses (in
 * descending relevance, stable id tie-break) and how many were dropped by the
 * ceiling. Capping only bites on very large inputs; a single module's clauses
 * all survive.
 */
function rankClauses(clauses, scopeText, { maxClauses = DEFAULTS.maxClauses, knownModules = [] } = {}) {
  const scopeTokenSet = new Set(tokenize(scopeText));
  const scopeModuleSet = new Set((knownModules || []).map((m) => String(m || '').toLowerCase()).filter(Boolean));
  const scored = (clauses || [])
    .filter((c) => c && c.id)
    .map((c) => ({ clause: c, score: scoreClause(c, scopeTokenSet, scopeModuleSet) }))
    .sort((a, b) => (b.score - a.score) || String(a.clause.id).localeCompare(String(b.clause.id)));
  const kept = scored.slice(0, maxClauses).map((s) => s.clause);
  return { kept, droppedCount: Math.max(0, scored.length - kept.length), scored };
}

/**
 * Attach a CAPPED verbatim excerpt snippet to the top-N most scope-relevant
 * index rows (so doc_quoted assertions have real text to quote) while keeping
 * total snippet egress under a ceiling. Mutates index rows by id-match. Returns
 * the egress stats for logging. This is the ONLY path by which source text
 * reaches the model in Hybrid mode — and it is bounded + logged.
 */
function attachSnippets(index, scored, {
  maxSnippets = DEFAULTS.maxSnippets,
  maxSnippetChars = DEFAULTS.maxSnippetChars,
  maxTotalSnippetChars = DEFAULTS.maxTotalSnippetChars,
} = {}) {
  const byId = new Map(index.map((r) => [r.requirementId, r]));
  let attached = 0;
  let totalChars = 0;
  for (const { clause } of scored) {
    if (attached >= maxSnippets || totalChars >= maxTotalSnippetChars) break;
    const row = byId.get(clause.id);
    if (!row || !clause.excerpt) continue;
    const snip = clip(clause.excerpt, maxSnippetChars);
    if (!snip) continue;
    if (totalChars + snip.length > maxTotalSnippetChars) continue;
    row.sourceSnippet = snip;
    attached++;
    totalChars += snip.length;
  }
  return { snippetCount: attached, snippetChars: totalChars };
}

/**
 * Build the Architect's requirement-context block.
 *
 * @param {Array}  clauses  - RequirementClause rows (id, sourceType, behaviourText, excerpt, …)
 * @param {object} opts
 * @param {string} opts.scopeText   - free text describing what's being generated (req titles + guidance + modules)
 * @param {string[]} opts.knownModules
 * @param {boolean} opts.withSnippets - attach capped verbatim snippets to top-ranked clauses (Hybrid authoring depth)
 * @returns {{ block: string, clauseIdSet: Set<string>, stats: object } | null}
 *   block        — the string to place in the prompt (header + JSON index)
 *   clauseIdSet  — the authoritative id set Node validates requirementRefs against
 *   stats        — { clauseCount, droppedCount, snippetCount, snippetChars } for logging
 */
function buildArchitectClauseBlock(clauses, {
  scopeText = '', knownModules = [], withSnippets = true,
  maxClauses = DEFAULTS.maxClauses, maxSnippets = DEFAULTS.maxSnippets,
  maxSnippetChars = DEFAULTS.maxSnippetChars, maxTotalSnippetChars = DEFAULTS.maxTotalSnippetChars,
} = {}) {
  // #14/#13 — exclude non-testable clauses up front so ranking, the index, and
  // snippet attachment all operate on the same testable-only set (keeps the RTM
  // denominator and the architect input aligned).
  const real = (clauses || []).filter((c) => c && c.id && c.behaviourText && c.testable !== false);
  if (!real.length) return null;

  const { kept, droppedCount, scored } = rankClauses(real, scopeText, { maxClauses, knownModules });
  const index = buildClauseIndex(kept, { knownModules });
  let snippetStats = { snippetCount: 0, snippetChars: 0 };
  if (withSnippets) {
    const keptScored = scored.filter((s) => index.some((r) => r.requirementId === s.clause.id));
    snippetStats = attachSnippets(index, keptScored, { maxSnippets, maxSnippetChars, maxTotalSnippetChars });
  }

  const header =
    'VERIFIED REQUIREMENT CLAUSES — THE INDEPENDENT ORACLE (data-minimized; cite, never invent):\n'
    + 'The platform extracted and verified each clause against its source document. The verbatim\n'
    + 'source text is held server-side for audit; only a short snippet is shown where it aids authoring.\n'
    + 'The "requirementId" is a content hash ASSIGNED BY THE PLATFORM. Do NOT invent requirement IDs.\n'
    + 'Use ONLY ids that appear in this list. A "must" assertion must cite the clause(s) it proves via\n'
    + '"requirementRefs"; an id not in this list does not exist (leave the ref empty → coverage gap, not a fail).\n';

  const block = `${header}\n${JSON.stringify(index, null, 0)}`;
  const clauseIdSet = new Set(index.map((r) => r.requirementId));
  return {
    block,
    clauseIdSet,
    stats: { clauseCount: index.length, droppedCount, ...snippetStats },
  };
}

module.exports = {
  DEFAULTS,
  tokenize,
  clip,
  deriveModuleHint,
  buildClauseIndex,
  scoreClause,
  rankClauses,
  attachSnippets,
  buildArchitectClauseBlock,
};
