'use strict';

/**
 * storyId — the case↔workbook join key (Step 3B bridge).
 *
 * The workbook authors rows against user-story ids (e.g. US-OHRM-001); the
 * requirement clauses are content-hashed (REQ-<sha1>) and cases carry no story
 * id, so there was no shared key for storyId-first data binding. This extracts a
 * user-story id from source text GENERICALLY (never an OrangeHRM/site format),
 * so RequirementClause + TestCase can carry it and match RowContract.storyId.
 *
 * Pure (no DB / LLM / IO). Matching is normalized so "us-ohrm-001" === "US-OHRM-001".
 */

// Structured id: an UPPERCASE prefix + hyphen-separated segments ending in digits.
// Matches US-123, US-OHRM-001, STORY-ABC-001, ST-7. Requires ≥1 hyphen and a
// trailing number so it can't match a bare word.
const STRUCTURED_RE = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\b/g;
// Loose id: "User Story 12", "Story 12", "US 12", "US#12", "Story #12".
const LOOSE_STORY_RE = /\b(?:user\s+)?stor(?:y|ies)\b\s*#?\s*(\d+)\b/i;
const LOOSE_US_RE = /\bus\s*#?\s*(\d+)\b/i;

/** Canonical comparison form: uppercase, separators → single hyphen, trimmed. */
function normalizeStoryId(id) {
  if (id == null) return null;
  const s = String(id).toUpperCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').trim();
  return s || null;
}

/**
 * Extract the best user-story id from text, or null. Prefers a STRUCTURED id
 * (US-OHRM-001) over a loose "Story 12" form. Returns the normalized id.
 * @param {...string} parts  text fragments (excerpt, heading, behaviour, …)
 */
function extractStoryId(...parts) {
  const text = parts.map((p) => String(p == null ? '' : p)).join('\n');
  if (!text.trim()) return null;
  const structured = text.match(STRUCTURED_RE);
  if (structured && structured.length) {
    // Prefer a story-ish prefix when several structured tokens exist (US-/STORY-/
    // ST-/USR-), else take the first — matching is the safety net (a non-story
    // token simply won't equal any workbook storyId).
    const storyish = structured.find((t) => /^(us|usr|user|story|st|sty)-/i.test(t));
    return normalizeStoryId(storyish || structured[0]);
  }
  const loose = text.match(LOOSE_STORY_RE) || text.match(LOOSE_US_RE);
  if (loose) return normalizeStoryId(`US-${loose[1]}`);
  return null;
}

/**
 * The story id that OWNS a clause: the nearest story-id heading AT OR BEFORE the
 * clause's span position in the source document. Atomic clause excerpts rarely
 * contain the id (it lives in a section heading above), so this recovers it from
 * document structure. Prefers a story-ish prefix among the trailing matches.
 */
function storyIdNear(docText, spanStart) {
  const text = String(docText == null ? '' : docText);
  if (!text) return null;
  const upto = (typeof spanStart === 'number' && spanStart > 0 && spanStart <= text.length) ? text.slice(0, spanStart) : text;
  const re = new RegExp(STRUCTURED_RE.source, 'g');
  let last = null; let lastStoryish = null; let m;
  while ((m = re.exec(upto)) !== null) {
    last = m[0];
    if (/^(us|usr|user|story|st|sty)-/i.test(m[0])) lastStoryish = m[0];
  }
  if (lastStoryish || last) return normalizeStoryId(lastStoryish || last);
  // loose "Story N" / "US N" heading fallback — last occurrence before the span.
  let lm; let looseLast = null; const lre = /\b(?:user\s+)?stor(?:y|ies)\b\s*#?\s*(\d+)\b/ig;
  while ((lm = lre.exec(upto)) !== null) looseLast = lm[1];
  return looseLast ? normalizeStoryId(`US-${looseLast}`) : null;
}

/** True when two story ids refer to the same story (normalized compare). */
function storyIdsMatch(a, b) {
  const na = normalizeStoryId(a);
  const nb = normalizeStoryId(b);
  return !!na && !!nb && na === nb;
}

module.exports = { extractStoryId, storyIdNear, normalizeStoryId, storyIdsMatch };
