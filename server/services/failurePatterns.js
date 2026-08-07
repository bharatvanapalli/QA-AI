'use strict';

/**
 * Failure-pattern store — Phase G cross-run learning loop.
 *
 *   - upsertPatterns(projectId, classifications)
 *       Called by the post-mortem invocation path (server/routes/reporter.js
 *       POST /:runId/analyze) after the postMortem agent classifies fresh
 *       failures. Existing signatures get occurrences++ and the new example
 *       id appended; new signatures create a row.
 *
 *   - loadProjectPatterns(projectId, { limit })
 *       Read access for the conductor's prompt-injection block and for the
 *       rcaChat primer. Ordered by occurrences DESC so the most-recurring
 *       traps come first in the prompt's limited budget.
 *
 *   - buildLearnedPatternsBlock(projectId)
 *       Format the top-N patterns into the markdown block that goes into the
 *       conductor's static system-prompt prefix (cached alongside the known-
 *       locators block). Returns null when the table is empty for this
 *       project so the prompt stays lean for brand-new projects.
 *
 *   - matchPatternsForResult(projectId, { error, rcaWhy, rcaFix, rcaClass })
 *       Lightweight keyword/category match used by rcaChat to surface "we've
 *       seen this before" context in per-failure user conversations.
 *
 * Why a service module (not inline in routes/reporter.js)?
 *   The same upsert path must be reachable from the auto-analyze trigger,
 *   from a future manual "re-classify" UI button, and from any seeding/
 *   backfill script. Putting it here also keeps the route file lean.
 */

const prisma = require('../prisma');
const { encodeJson, decodeJson } = require('./jsonField');

const MAX_EXAMPLES_PER_PATTERN = 3;
const DEFAULT_PROMPT_LIMIT = 12;

/**
 * @param {string} projectId
 * @param {Array} classifications  output of postMortem.run().patterns
 * @returns {Promise<{ created: number, updated: number }>}
 */
async function upsertPatterns(projectId, classifications) {
  if (!projectId) return { created: 0, updated: 0 };
  const items = Array.isArray(classifications) ? classifications.filter(Boolean) : [];
  if (!items.length) return { created: 0, updated: 0 };

  let created = 0;
  let updated = 0;
  const now = new Date();

  // Group incoming classifications by signature so multiple failures sharing
  // a signature within ONE postMortem call increment occurrences correctly.
  const bySig = new Map();
  for (const it of items) {
    const sig = String(it.signature || '').trim();
    if (!sig) continue;
    if (!bySig.has(sig)) {
      bySig.set(sig, { ...it, exampleIds: [] });
    }
    bySig.get(sig).exampleIds.push(it.exampleRunResultId);
  }

  for (const [signature, payload] of bySig.entries()) {
    const existing = await prisma.failurePattern.findUnique({
      where: { projectId_signature: { projectId, signature } },
      select: { id: true, occurrences: true, exampleRunResultIds: true },
    });

    if (existing) {
      // Merge example ids, dedupe, keep the most-recent MAX_EXAMPLES_PER_PATTERN.
      const prior = decodeJson(existing.exampleRunResultIds, []);
      const merged = [...payload.exampleIds, ...prior]
        .filter((v, i, arr) => v && arr.indexOf(v) === i)
        .slice(0, MAX_EXAMPLES_PER_PATTERN);
      await prisma.failurePattern.update({
        where: { id: existing.id },
        data: {
          occurrences: existing.occurrences + payload.exampleIds.length,
          exampleRunResultIds: encodeJson(merged),
          lastSeenAt: now,
          // We deliberately do NOT overwrite title/description/resolution
          // here — those were the AGENT's first-pass distillation; later
          // calls may produce slightly different wording for the same root
          // cause and we'd churn for nothing. Manual edits via a future
          // pattern-editor UI would land in a separate write path.
        },
      });
      updated += 1;
    } else {
      await prisma.failurePattern.create({
        data: {
          projectId,
          signature,
          category: payload.category || 'unknown',
          title: payload.title || '(untitled pattern)',
          description: payload.description || '',
          trigger: payload.trigger || '',
          resolution: payload.resolution || '',
          occurrences: payload.exampleIds.length,
          exampleRunResultIds: encodeJson(
            payload.exampleIds.slice(0, MAX_EXAMPLES_PER_PATTERN)
          ),
          firstSeenAt: now,
          lastSeenAt: now,
        },
      });
      created += 1;
    }
  }
  return { created, updated };
}

/**
 * @param {string} projectId
 * @param {object} [opts]
 * @param {number} [opts.limit=12]
 * @returns {Promise<Array>}
 */
async function loadProjectPatterns(projectId, { limit = DEFAULT_PROMPT_LIMIT } = {}) {
  if (!projectId) return [];
  return prisma.failurePattern.findMany({
    where: { projectId },
    orderBy: [{ occurrences: 'desc' }, { lastSeenAt: 'desc' }],
    take: Math.max(1, Math.min(50, limit)),
  });
}

/**
 * Build the markdown block injected into the conductor's static system-prompt
 * prefix. Mirrors loadKnownLocatorsBlock in shape so cache behaviour matches.
 *
 * Returns null for new projects (empty table) so brand-new flows don't get a
 * meaningless "## Learned from prior runs (nothing yet)" header.
 */
async function buildLearnedPatternsBlock(projectId, { limit = DEFAULT_PROMPT_LIMIT } = {}) {
  const rows = await loadProjectPatterns(projectId, { limit });
  if (!rows.length) return null;
  const lines = [];
  lines.push('## Learned from prior runs on this project');
  lines.push(
    `Patterns the postMortem agent has classified from past failures. Apply them PROACTIVELY — these traps have caught the agent before on THIS project. ${rows.length} pattern${rows.length === 1 ? '' : 's'} below, ordered by how often they\'ve recurred.`,
  );
  lines.push('');
  for (const p of rows) {
    const occ = p.occurrences > 1 ? ` (seen ${p.occurrences}×)` : '';
    lines.push(`### ${p.title}${occ}`);
    if (p.trigger) lines.push(`- **When**: ${p.trigger}`);
    if (p.resolution) lines.push(`- **Do**: ${p.resolution}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Lightweight keyword-based match used by rcaChat to surface relevant
 * patterns to the user without making another Claude call. Looks at the
 * failure's error + rcaClass + rcaWhy and ranks patterns by:
 *   - same category as rcaClass-derived hint (strong signal)
 *   - signature/title/description keyword overlap with the error text
 *
 * Returns up to 3 patterns, most-relevant first. Empty array is fine —
 * rcaChat already gracefully handles no matches.
 */
async function matchPatternsForResult(projectId, { error = '', rcaWhy = '', rcaFix = '', rcaClass = '' } = {}) {
  if (!projectId) return [];
  const all = await loadProjectPatterns(projectId, { limit: 50 });
  if (!all.length) return [];

  const haystack = `${error} ${rcaWhy} ${rcaFix}`.toLowerCase();
  // Map rcaClass into our soft category vocabulary. rcaClass is one of:
  // locator | data | timing | backend | env | unknown.
  const classHint = {
    locator: ['selector-drift', 'stale-snapshot-ref'],
    timing: ['redirect-race', 'async-content-load', 'animation-timing'],
    data: ['data-precondition-missing', 'form-validation-silent'],
    env: ['env-instability', 'auth-state-loss'],
    backend: ['rate-limited-by-sut'],
  }[rcaClass] || [];

  const scored = all.map((p) => {
    let score = 0;
    if (classHint.includes(p.category)) score += 10;
    const tokens = (p.title + ' ' + p.description + ' ' + p.signature)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    for (const t of tokens) {
      if (haystack.includes(t)) score += 1;
    }
    score += Math.min(5, p.occurrences || 0); // recurrence is itself signal
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, 3).map((s) => s.p);
}

module.exports = {
  upsertPatterns,
  loadProjectPatterns,
  buildLearnedPatternsBlock,
  matchPatternsForResult,
  MAX_EXAMPLES_PER_PATTERN,
};
