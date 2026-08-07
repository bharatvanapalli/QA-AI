'use strict';

/**
 * Enterprise Mode P2 — the requirements oracle.
 *
 * Turns BRD / user-story / release-note documents into ATOMIC, independently-
 * verifiable RequirementClause rows that the rest of the pipeline traces to.
 * This is the INDEPENDENT oracle: a case's `must` assertion must cite one of
 * these, and its expected value comes from the requirement — never from the
 * live app (the anti-circular rule).
 *
 * PRINCIPLE: the LLM proposes, Node disposes. The model may split prose into
 * candidate clauses and flag candidate conflicts, but NODE owns and verifies
 * everything an auditor relies on:
 *   - the content-addressed id (stable across re-uploads of the same text),
 *   - that the excerpt is a VERBATIM substring of the source (audit proof),
 *   - dedupe/merge across sources,
 *   - the RTM (every clause covered | excluded | not_automatable | uncovered).
 *
 * The pure functions (computeRequirementId, verifyExcerpt, dedupeAndMerge,
 * buildConflictFindings, buildRTM) take no DB/LLM and are fully guarded by
 * scripts/verify_contract.cjs. extractRequirements() is the thin LLM wrapper
 * (degrades to a deterministic split when no provider is supplied).
 *
 * See ENTERPRISE_MODE.md → "P2 — Requirement extraction (frozen mini-spec)".
 */

const crypto = require('crypto');
const { recordDegradation } = require('../lib/degradationSignal');

const SOURCE_TYPES = new Set(['BRD', 'USER_STORY', 'RELEASE_NOTE', 'VISUAL']);

// Modal / action-verb signal: a clause that describes verifiable behaviour
// almost always carries a modal ("must"/"shall"/…) or an action verb. Keyed off
// SHAPE, never specific titles. Used by both the deterministic split and the
// testability classifier below.
const MODAL_RE = /\b(must|shall|should|will|would|can|cannot|can't|is required to|are required to|needs? to|has to|have to|is able to|are able to|allows?|enables?|supports?|displays?|shows?|returns?|validates?|verif(?:y|ies)|prevents?|rejects?|accepts?|requires?|generates?|creates?|updates?|deletes?|sends?|stores?|calculates?|redirects?|navigates?)\b/i;

// Map a Document.category to a clause sourceType. Unknown categories are not
// part of the oracle (returns null → caller skips the doc).
function sourceTypeForCategory(category) {
  switch (String(category || '').toLowerCase()) {
    case 'brd': return 'BRD';
    case 'user-stories': case 'user_stories': case 'userstories': return 'USER_STORY';
    case 'release-notes': case 'release_notes': case 'releasenotes': return 'RELEASE_NOTE';
    // Phase M0/M1 — a document whose text is a vision transcription of an
    // uploaded/embedded screenshot. Its clauses are real requirements/assertions
    // grounded in the image; tagged VISUAL so provenance is preserved and the
    // architect can later attach the screenshot (M3). dedupeAndMerge merges these
    // with prose clauses describing the same thing (Jaccard, cross-sourceType).
    case 'visual': case 'screenshot': case 'screenshots': case 'image': return 'VISUAL';
    default: return null;
  }
}

function normalizeForId(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * #14 — generic, SHAPE-BASED testability filter. Decides whether a candidate
 * clause describes verifiable behaviour, or is structural noise that inflates
 * the RTM denominator and feeds junk to the architect. Keys off SHAPE only
 * (length, word count, punctuation, presence of a verb/modal, story-preamble
 * shape) — NEVER specific section titles or site strings.
 *
 * Non-testable shapes detected:
 *   - document section HEADINGS: very short, no terminal punctuation, no verb,
 *     title-case / ALL-CAPS (e.g. "Business Requirements", "Assumptions & Constraints").
 *   - table-of-contents lines: leading section number + title + dot/space leaders
 *     + trailing page number (e.g. "3.1  Login Flow ........ 12").
 *   - bare story PREAMBLES: "As a X, I want Y" with no acceptance-criterion clause
 *     (no "so that"/"so as to" outcome AND no modal verb).
 *
 * @returns {{ testable: boolean, reason: string|null }}
 */
function classifyTestability(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { testable: false, reason: 'empty' };

  const oneLine = raw.replace(/\s+/g, ' ').trim();
  const words = oneLine.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const hasTerminalPunct = /[.!?:;]$/.test(oneLine);
  const hasModal = MODAL_RE.test(oneLine);

  // Table-of-contents line: dotted/space leaders to a trailing page number, or a
  // leading dotted section number followed by a short title and a trailing number.
  if (/\.{3,}\s*\d{1,4}\s*$/.test(oneLine)
      || (/^\d+(?:\.\d+)*\s+\S/.test(oneLine) && /\s\d{1,4}\s*$/.test(oneLine) && wordCount <= 12 && !hasModal)) {
    return { testable: false, reason: 'table_of_contents' };
  }

  // Heading: short, no terminal sentence punctuation, no modal, and STRICT
  // title-shaped — either ALL-CAPS / no-lowercase, or every significant word is
  // capitalized (Title Case) with only small connector words lowercase. This
  // shape is what discriminates a heading ("Assumptions & Constraints") from a
  // real sentence ("Users can create a new employee record" — has lowercase
  // verbs mid-sentence, so it is NOT title-shaped). Keyed off shape, not titles.
  // (We deliberately do NOT gate on a verb probe: a fully title-cased plural noun
  // like "Constraints" trips loose verb heuristics, so shape alone decides.)
  const looksTitleCase = /^[A-Z0-9][^a-z]*$/.test(oneLine)               // ALL CAPS / no lowercase
    || (wordCount <= 8 && /^(?:\d+(?:\.\d+)*\.?\s+)?(?:[A-Z][a-z0-9&/-]*|&|of|and|the|for|to)(?:\s+(?:[A-Z][a-z0-9&/-]*|&|of|and|the|for|to))*$/.test(oneLine));
  if (!hasTerminalPunct && !hasModal && wordCount <= 8 && looksTitleCase) {
    return { testable: false, reason: 'section_heading' };
  }

  // Bare user-story preamble with no acceptance criterion: "As a <role>, I want
  // <goal>" but no outcome clause ("so that…") AND no modal — nothing to assert.
  if (/^as\s+an?\b/i.test(oneLine) && /\bi\s+(?:want|need|would like|wish)\b/i.test(oneLine)) {
    const hasOutcome = /\bso\s+(?:that|as\s+to)\b/i.test(oneLine);
    if (!hasOutcome && !hasModal) {
      return { testable: false, reason: 'bare_story_preamble' };
    }
  }

  // ── M4 — non-testable PROSE NOISE (dev notes / cross-refs / scope statements) ──
  // Real user-story docs interleave guidance that must NOT become test targets.
  // Gate ALL of these on "no action modal" so a genuine requirement that merely
  // mentions one of these phrases (e.g. "User MUST be able to X. This is covered
  // separately.") stays testable — only a clause whose SOLE content is the note
  // is dropped. CRITICAL: a UI ABSENCE ("checkbox will NOT be present") is a real
  // testable negative (→ FORBIDDEN assertion) and is preserved — scope-noise is
  // keyed off "applicable/apply/scope", NEVER off "present/shown/displayed/visible"
  // (and "will/must NOT be present" carries a modal, so it skips this block anyway).
  if (!hasModal) {
    // Developer-directed note — guidance to the dev team, not user-facing behaviour.
    if (/\bnote\s+for\s+(?:the\s+)?dev(?:elopment)?\s+team\b/i.test(oneLine)
        || /\bfor\s+(?:the\s+)?dev(?:elopment)?\s+team['’]?s?\s+reference\b/i.test(oneLine)
        || /\b(?:developer|implementation)\b[^.]*\bnote\b/i.test(oneLine)) {
      return { testable: false, reason: 'dev_note' };
    }
    // Cross-reference — the behaviour is owned/tested by a different story.
    if (/\bcovered\s+(?:in|as\s+part\s+of|under|by|separately)\b/i.test(oneLine)
        || /\bsee\s+(?:the\s+)?(?:separate\s+)?(?:user\s+)?story\b/i.test(oneLine)
        || /\btracked\s+(?:in|under)\s+(?:a\s+)?separate\b/i.test(oneLine)) {
      return { testable: false, reason: 'cross_reference' };
    }
    // Scope statement ("not applicable" / "out of scope" / "does not apply").
    // Excludes UI-absence wording, which is a testable requirement.
    if (/\b(?:not\s+applicable|does\s+not\s+apply|out\s+of\s+scope)\b/i.test(oneLine)
        && !/\b(?:present|displayed|shown|visible|appears?)\b/i.test(oneLine)) {
      return { testable: false, reason: 'out_of_scope' };
    }
  }

  // Too short to carry a verifiable behaviour and carries no verb at all.
  if (wordCount < 3 && !hasModal) return { testable: false, reason: 'too_short' };

  return { testable: true, reason: null };
}

/**
 * Content-addressed, deterministic id. Same (sourceType, excerpt-up-to-
 * whitespace) → same id on every re-upload. The LLM never invents ids.
 */
function computeRequirementId(sourceType, excerpt) {
  const basis = `${String(sourceType || '').toUpperCase()}\n${normalizeForId(excerpt)}`;
  const hash = crypto.createHash('sha1').update(basis).digest('hex').slice(0, 10);
  return `REQ-${hash}`;
}

/**
 * Verify an excerpt is a genuine span of the source document. Exact substring
 * first (audit-perfect); else a whitespace-normalized match (bounded span);
 * else not found → rejected. Never paraphrases.
 * @returns {{ ok, spanStart, spanEnd, normalized }}
 */
function verifyExcerpt(excerpt, sourceText) {
  const ex = String(excerpt == null ? '' : excerpt);
  const src = String(sourceText == null ? '' : sourceText);
  if (!ex.trim() || !src) return { ok: false, spanStart: null, spanEnd: null, normalized: false };

  const exact = src.indexOf(ex);
  if (exact !== -1) return { ok: true, spanStart: exact, spanEnd: exact + ex.length, normalized: false };

  // Whitespace-tolerant fallback: build a regex from the excerpt where any run
  // of whitespace matches any run of whitespace in the source.
  const escaped = ex.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  try {
    const m = new RegExp(escaped).exec(src);
    if (m) return { ok: true, spanStart: m.index, spanEnd: m.index + m[0].length, normalized: true };
  } catch (_) { /* excerpt too pathological to regex — fall through to reject */ }
  return { ok: false, spanStart: null, spanEnd: null, normalized: false };
}

// #12 — normalized token SET for cross-source near-duplicate detection. Lower-
// cased alphanumeric tokens, ≥3 chars, deduped. Generic (no domain words); the
// shape of the requirement text alone decides similarity, not its source.
function tokenSetForDedup(text) {
  const set = new Set();
  for (const t of String(text == null ? '' : text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3) set.add(t);
  }
  return set;
}

// Jaccard overlap of two token sets. 1 == identical set, 0 == disjoint.
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Conservative near-duplicate threshold. High on purpose: only collapse clauses
// that are clearly the same requirement restated/paraphrased — never distinct
// behaviours that merely share vocabulary.
const NEAR_DUP_JACCARD = 0.85;

/**
 * Group verified candidates by content-hash id. Exact-id duplicates collapse to
 * ONE clause; the duplicates' provenance is preserved under sourcesJson so an
 * auditor sees every place the requirement appeared (cross-reference, not a
 * second oracle row).
 *
 * #12 — CROSS-SOURCE / SEMANTIC dedup: because computeRequirementId hashes
 * (sourceType + excerpt), the SAME requirement stated in a BRD and a user story
 * (or paraphrased) gets DIFFERENT ids and never merges. After the exact-id pass
 * we do a CONSERVATIVE normalized-text near-duplicate merge ACROSS sourceTypes:
 * clauses whose normalized token sets are near-identical (Jaccard ≥ threshold)
 * collapse onto one canonical clause, with the merged ids recorded as aliases.
 * High threshold + token-set shape only → distinct requirements are preserved.
 *
 * @param {Array} candidates - [{ id, projectId, sprintId, sourceType, sourceDocId, excerpt, spanStart, spanEnd, behaviourText }]
 * @returns {{ requirements, mergedCount }}
 */
function dedupeAndMerge(candidates) {
  const byId = new Map();
  let mergedCount = 0;
  for (const c of candidates || []) {
    if (!c || !c.id) continue;
    const existing = byId.get(c.id);
    if (!existing) {
      byId.set(c.id, { ...c, sources: [] });
    } else {
      mergedCount++;
      existing.sources.push({
        sourceType: c.sourceType,
        sourceDocId: c.sourceDocId || null,
        spanStart: c.spanStart ?? null,
        spanEnd: c.spanEnd ?? null,
      });
    }
  }

  // Cross-source near-duplicate pass. Keep the FIRST-seen clause of a near-dup
  // group as canonical (stable + deterministic by insertion order), fold the
  // rest in as aliases under sourcesJson and aliasIds. O(n²) over distinct ids —
  // fine for the clause counts the oracle produces (hundreds, capped upstream).
  const canon = [];
  const canonTokens = [];
  for (const r of byId.values()) {
    const toks = tokenSetForDedup(`${r.behaviourText || ''} ${r.excerpt || ''}`);
    let mergedInto = null;
    for (let i = 0; i < canon.length; i++) {
      if (jaccard(toks, canonTokens[i]) >= NEAR_DUP_JACCARD) { mergedInto = canon[i]; break; }
    }
    if (mergedInto) {
      mergedCount++;
      mergedInto.sources.push({
        sourceType: r.sourceType,
        sourceDocId: r.sourceDocId || null,
        spanStart: r.spanStart ?? null,
        spanEnd: r.spanEnd ?? null,
        aliasId: r.id,
      });
      if (!Array.isArray(mergedInto.aliasIds)) mergedInto.aliasIds = [];
      mergedInto.aliasIds.push(r.id);
      // also carry the alias's own recorded sources so provenance is complete
      for (const s of r.sources) mergedInto.sources.push(s);
    } else {
      canon.push(r);
      canonTokens.push(toks);
    }
  }

  const requirements = canon.map((r) => ({
    ...r,
    sourcesJson: r.sources.length ? JSON.stringify(r.sources) : null,
  }));
  return { requirements, mergedCount };
}

/**
 * Validate LLM-proposed conflicts against the real clause set and turn them into
 * Discrepancy findings (kind='requirement_conflict'). A conflict referencing an
 * unknown clause id is dropped (the model can't invent oracle rows). Never
 * auto-resolves — the disagreement is surfaced for human decision (HOLD-class).
 * @param {Array} conflicts - [{ aId, bId, detail }]
 * @param {Map}   byId       - Map<id, clause>
 */
function buildConflictFindings(conflicts, byId) {
  const findings = [];
  for (const c of conflicts || []) {
    if (!c) continue;
    const a = byId.get(c.aId);
    const b = byId.get(c.bId);
    if (!a || !b || c.aId === c.bId) continue; // both ends must be real, distinct clauses
    findings.push({
      kind: 'requirement_conflict',
      severity: 'warning',
      summary: `Requirement conflict: ${c.aId} ↔ ${c.bId}`,
      detail: `${String(c.detail || 'Contradictory expected outcomes for the same behaviour.').slice(0, 1000)}\n\nA (${a.sourceType}): "${a.behaviourText}"\nB (${b.sourceType}): "${b.behaviourText}"`,
    });
  }
  return findings;
}

/**
 * THE single authoritative requirement-coverage disposition. Step 6 (RTM single
 * source of truth): coverage is DERIVED — a clause is 'covered' iff a live test case
 * references it (`isCovered`), NEVER from the stored RequirementClause.coverageDisposition
 * column (which can go stale). The stored column is honoured ONLY for the two EXPLICIT
 * HUMAN dispositions (manually_excluded / not_automatable), and only when the clause
 * isn't already covered by a real case. A non-testable clause (#13/#14/#15: headings,
 * TOC lines, bare preambles) is 'not_testable' and never counts as uncovered. Every
 * consumer (buildRTM here AND the evidence-bundle RTM export) calls THIS, so no caller
 * can resurrect a stale 'covered' from the column.
 * @param {object} clause  - { sourceType, testable?, coverageDisposition? }
 * @param {boolean} isCovered - a live case references this clause
 * @returns {'not_testable'|'covered'|'manually_excluded'|'not_automatable'|'uncovered'}
 */
function clauseCoverageDisposition(clause, isCovered) {
  const c = clause || {};
  const isTestable = !(c.testable === false || c.sourceType === 'NON_TESTABLE');
  if (!isTestable) return 'not_testable';
  if (isCovered) return 'covered'; // DERIVED from live refs — the only source of 'covered'
  if (c.coverageDisposition === 'manually_excluded' || c.coverageDisposition === 'not_automatable') {
    return c.coverageDisposition; // explicit human disposition stands (never a stale derived value)
  }
  return 'uncovered';
}

/**
 * Build the Requirement Traceability Matrix. Every clause lands with a
 * disposition; an uncovered, non-excluded clause becomes a finding.
 * @param {Array} requirements   - [{ id, coverageDisposition?, dispositionReason? }]
 * @param {Array} casesWithRefs  - [{ caseId, requirementRefs: string[] }]
 * @returns {{ matrix, uncovered, findings }}
 */
function buildRTM(requirements, casesWithRefs) {
  const coveringByReq = new Map(); // id -> [caseId]
  for (const c of casesWithRefs || []) {
    for (const rid of (c && Array.isArray(c.requirementRefs) ? c.requirementRefs : [])) {
      if (!coveringByReq.has(rid)) coveringByReq.set(rid, []);
      coveringByReq.get(rid).push(c.caseId);
    }
  }
  const matrix = [];
  const uncovered = [];
  const findings = [];
  for (const r of requirements || []) {
    const covering = coveringByReq.get(r.id) || [];
    // Single authority — coverage DERIVED from live refs; stored column honoured only
    // for explicit human dispositions (see clauseCoverageDisposition).
    const disposition = clauseCoverageDisposition(r, covering.length > 0);
    if (disposition === 'uncovered') {
      uncovered.push(r.id);
      findings.push({
        kind: 'requirement_uncovered',
        severity: 'warning',
        summary: `Uncovered requirement: ${r.id}`,
        detail: `No test case references ${r.id} and it was not explicitly excluded. ${r.behaviourText ? `Behaviour: "${r.behaviourText}"` : ''}`.trim(),
      });
    }
    matrix.push({ id: r.id, disposition, coveringCaseIds: covering });
  }
  return { matrix, uncovered, findings };
}

// Deterministic, no-LLM fallback split. Sentence-aware: each non-empty line is
// segmented into sentences, then each candidate is kept ONLY if it reads like a
// verifiable requirement (carries a verb/modal AND is long enough) and is NOT
// structural noise (#14: heading / TOC / bare preamble). The result is capped so
// a pathological document can't flood the oracle. Crude vs. the LLM path, but no
// longer over-admits via a blanket "any bullet" branch.
const DETERMINISTIC_SPLIT_CAP = 300;

function deterministicSectionHeader(line) {
  const m = String(line || '').trim().match(/^([A-Za-z][A-Za-z0-9 /_-]{0,90})\s*:\s*(.*)$/);
  if (!m) return null;
  return {
    name: m[1].replace(/\s+/g, ' ').trim().toLowerCase(),
    inline: String(m[2] || '').trim(),
  };
}

const SUPPORTING_TEST_FLOW_SECTIONS = new Set([
  'requirement title',
  'target url',
  'test data',
  'authoring rule',
  'test case',
  'steps',
  'session policy',
  'data binding rule',
  'expected scenario/test case shape',
  'expected scenario shape',
  'expected test case shape',
]);

function shouldSkipDeterministicLine(line, activeSection) {
  const raw = String(line || '').trim();
  if (!raw) return true;
  const section = String(activeSection || '').toLowerCase();
  if (SUPPORTING_TEST_FLOW_SECTIONS.has(section)) return true;
  if (/^[-*\u2022]\s+/.test(raw) && /(?:final validation|valid final|dashboard signals?|visible signals?|oracle signals?)/i.test(section)) {
    return true;
  }
  return false;
}
function deterministicSplit(text) {
  const out = [];
  let activeSection = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (out.length >= DETERMINISTIC_SPLIT_CAP) break;
    const line = rawLine.trim();
    if (!line) continue;
    const header = deterministicSectionHeader(line);
    if (header) {
      activeSection = header.name;
      if (!header.inline || SUPPORTING_TEST_FLOW_SECTIONS.has(activeSection)) continue;
    }
    if (shouldSkipDeterministicLine(line, activeSection)) continue;
    // Strip a single leading bullet / numbered-list marker, then segment into
    // sentences on terminal punctuation (keeping the delimiter).
    const body = line.replace(/^([-*•]|\d+[.)])\s+/, '').trim();
    if (!body) continue;
    const sentences = body.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [body];
    for (const rawSeg of sentences) {
      if (out.length >= DETERMINISTIC_SPLIT_CAP) break;
      const seg = rawSeg.trim();
      if (seg.length < 12) continue;                  // too short to be a behaviour
      if (seg.split(/\s+/).filter(Boolean).length < 4) continue; // needs real content
      const cls = classifyTestability(seg);
      if (!cls.testable) continue;                    // drop headings / TOC / preambles
      // Require an actual modal/action verb — line-presence alone over-admits.
      if (!MODAL_RE.test(seg)) continue;
      out.push(seg.slice(0, 400));
    }
  }
  return out;
}

/**
 * Extract requirement clauses from a project's documents.
 *   - With a provider: ONE LLM call per doc proposes candidate {excerpt,
 *     behaviourText}; Node verifies each excerpt is verbatim, computes the id,
 *     and dedupes. Bad/paraphrased excerpts are dropped (logged), never trusted.
 *   - Without a provider: deterministicSplit fallback (excerpt === behaviour).
 * Pure w.r.t. the DB — returns the verified set; persistClauses writes it.
 *
 * @returns {{ requirements, findings, candidateCount, rejectedCount }}
 */
async function extractRequirements({ documents = [], projectId, sprintId = null, provider = null, apiKey = null, model = null, send = null, degradations = null } = {}) {
  const candidates = [];
  let rejectedCount = 0;
  let nonTestableCount = 0;
  // onLog adapter over the WS `send` so recordDegradation can speak the same channel.
  const onLog = typeof send === 'function'
    ? (level, message) => send({ type: 'agent.phase.log', phase: 'oracle', level: level === 'warn' ? 'warn' : level, message })
    : null;
  const collector = Array.isArray(degradations) ? degradations : null;

  for (const doc of documents) {
    const sourceType = sourceTypeForCategory(doc && doc.category);
    if (!sourceType) continue; // only BRD / US / RN feed the oracle
    const text = String(doc.content || '');
    if (!text.trim()) continue;

    let proposed = [];
    let usedFallback = false;
    if (provider && apiKey && typeof provider.complete === 'function') {
      try {
        proposed = await llmProposeClauses({ provider, apiKey, model, sourceType, text, docName: doc.name });
      } catch (e) {
        if (typeof send === 'function') send({ type: 'agent.phase.log', phase: 'oracle', level: 'warn', message: `requirement extraction LLM error on "${doc.name}" — falling back to deterministic split: ${e.message}` });
        proposed = deterministicSplit(text).map((b) => ({ excerpt: b, behaviourText: b }));
        usedFallback = true;
      }
    } else {
      proposed = deterministicSplit(text).map((b) => ({ excerpt: b, behaviourText: b }));
      usedFallback = true;
    }

    // #11 — when the deterministic fallback fires, the clause set is coarser /
    // noisier than the LLM path. Emit an honest degradation signal rather than
    // returning quietly-lower-quality output.
    if (usedFallback) {
      recordDegradation({
        onLog, collector,
        stage: 'requirement-extraction',
        reason: `LLM extraction unavailable for "${doc && doc.name ? doc.name : sourceType}"; using deterministic split`,
        impact: 'clauses are coarser/noisier (line/sentence-level, not LLM-atomic)',
        severity: 'warning',
      });
    }

    for (const p of proposed) {
      const v = verifyExcerpt(p.excerpt, text);
      if (!v.ok) { rejectedCount++; continue; } // never trust an excerpt we can't find in the source
      const id = computeRequirementId(sourceType, p.excerpt);
      // #14 — shape-based testability classification. Non-testable clauses are
      // kept (provenance/audit) but flagged so the RTM denominator (#13/#15) and
      // the architect index (requirementContext) exclude them.
      const cls = classifyTestability(p.behaviourText || p.excerpt);
      if (!cls.testable) nonTestableCount++;
      candidates.push({
        id,
        projectId,
        sprintId,
        sourceType,
        sourceDocId: doc.id || null,
        excerpt: p.excerpt,
        spanStart: v.spanStart,
        spanEnd: v.spanEnd,
        behaviourText: String(p.behaviourText || p.excerpt).slice(0, 600),
        testable: cls.testable,
        nonTestableReason: cls.testable ? null : cls.reason,
      });
    }
  }

  const { requirements, mergedCount } = dedupeAndMerge(candidates);
  return { requirements, findings: [], candidateCount: candidates.length, mergedCount, rejectedCount, nonTestableCount };
}

async function llmProposeClauses({ provider, apiKey, model, sourceType, text, docName }) {
  const sys = 'You split a software requirements document into ATOMIC, independently-verifiable requirement clauses. '
    + 'For each clause return the VERBATIM excerpt (an EXACT substring copied from the document — do not paraphrase, do not fix typos) '
    + 'and a one-line behaviourText restating the single testable behaviour. Split compound sentences into separate clauses. '
    + 'Return ONLY JSON: { "clauses": [ { "excerpt": "...", "behaviourText": "..." } ] }.';
  const user = `Document "${docName}" (sourceType ${sourceType}):\n\n${text.slice(0, 24000)}`;
  const res = await provider.complete({
    apiKey,
    model,
    system: sys,
    messages: [{ role: 'user', content: user }],
    maxTokens: 4000,
  });
  const raw = (res && (res.content?.[0]?.text || res.text || res.content)) || '';
  const jsonText = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch (_) {
    const m = String(raw).match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { clauses: [] };
  }
  const clauses = Array.isArray(parsed && parsed.clauses) ? parsed.clauses : [];
  return clauses
    .filter((c) => c && typeof c.excerpt === 'string' && c.excerpt.trim())
    .map((c) => ({ excerpt: c.excerpt, behaviourText: c.behaviourText || c.excerpt }));
}

/**
 * Idempotently persist the verified clause set (upsert by content-hash id, so
 * re-extraction of the same text is a no-op rather than a duplicate). Needs a
 * Prisma client that knows the RequirementClause model (regenerate after the
 * P2 migration). Wrapped by the caller so a pre-regen client degrades.
 */
async function persistClauses({ prisma, projectId, sprintId = null, requirements = [] }) {
  if (!prisma || !prisma.requirementClause) throw new Error('persistClauses requires a prisma client with RequirementClause');
  // Step 3B bridge — extract the user-story id GENERICALLY so cases/workbook rows
  // share a join key. First from the verbatim span + phrased behaviour; if the
  // atomic clause doesn't carry the id (the common case — it lives in a section
  // HEADING above), recover it from the owning document section (nearest story-id
  // heading at/before the clause's span). null when no story id anywhere.
  const { extractStoryId, storyIdNear } = require('../lib/storyId');
  const docCache = new Map();
  const docContent = async (docId) => {
    if (!docId) return '';
    if (docCache.has(docId)) return docCache.get(docId);
    let content = '';
    try { const d = await prisma.document.findUnique({ where: { id: docId }, select: { content: true } }); content = (d && d.content) || ''; } catch (_) { content = ''; }
    docCache.set(docId, content);
    return content;
  };
  const written = [];
  for (const r of requirements) {
    let storyId = extractStoryId(r.excerpt, r.behaviourText) || null;
    if (!storyId && r.sourceDocId) {
      storyId = storyIdNear(await docContent(r.sourceDocId), r.spanStart) || null;
    }
    const data = {
      projectId,
      sprintId: sprintId || null,
      sourceType: r.sourceType,
      sourceDocId: r.sourceDocId || null,
      excerpt: r.excerpt,
      spanStart: r.spanStart ?? null,
      spanEnd: r.spanEnd ?? null,
      behaviourText: r.behaviourText,
      sourcesJson: r.sourcesJson || null,
      storyId,
    };
    const row = await prisma.requirementClause.upsert({
      where: { id: r.id },
      create: { id: r.id, ...data },
      // Re-extraction refreshes the spans/sources but never resets a human
      // disposition (coverageDisposition / dispositionReason are owned by the RTM).
      update: data,
    });
    // Carry the in-memory shape-based testability flag (#14) onto the returned
    // row. The DB schema may predate a `testable` column, so we never persist it
    // here — but the downstream RTM (#13/#15) and architect index must still see
    // it, so we attach it to the object we hand back.
    written.push({ ...row, testable: r.testable !== false, nonTestableReason: r.nonTestableReason || null });
  }
  return written;
}

/**
 * P2-integration orchestrator. Turns a project's source documents into the
 * verified clause set the Architect will cite, HONORING THE DLP EGRESS GATE:
 *   - loads only BRD / user-story / release-note Documents,
 *   - if the provider is egress-allowed → LLM extraction; otherwise → a
 *     deterministic, NO-EGRESS split (document text never leaves),
 *   - persists clauses idempotently (graceful pre-regen ladder: a Prisma client
 *     that predates the RequirementClause migration keeps the in-memory set),
 *   - decides the Architect context mode (Hybrid the moment verified clauses
 *     exist — the enterprise default that stops source bodies flowing to the
 *     LLM; QAAI_ARCHITECT_CONTEXT_MODE=additive is the explicit dev override).
 *
 * Never throws — any failure degrades to the legacy (additive, bodies) path so
 * generation is never blocked by the oracle. Returns what architect.run needs.
 *
 * sourceDocumentIds is an optional generation-scope boundary. Omitted keeps
 * the legacy whole-project document scope; an explicit array (including an
 * empty array) limits extraction to exactly those Document ids.
 *
 * @returns {{ requirementClauses, contextMode, knownModules, stats }}
 */
async function prepareArchitectClauses({ prisma, projectId, sprintId = null, sourceDocumentIds, providerName, apiKey, model, knownModules = [], send = null, log = console, degradations = null }) {
  const out = { requirementClauses: [], contextMode: 'additive', knownModules, stats: { clauseCount: 0 }, degradations: Array.isArray(degradations) ? degradations : [] };
  const logWarn = (m) => { if (log && typeof log.warn === 'function') log.warn(`[oracle] ${m}`); };

  const scopedDocumentIds = sourceDocumentIds == null
    ? null
    : Array.from(new Set((Array.isArray(sourceDocumentIds) ? sourceDocumentIds : [sourceDocumentIds])
      .map((id) => String(id == null ? '' : id).trim())
      .filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));

  let documents = [];
  try {
    documents = await prisma.document.findMany({
      where: {
        projectId,
        ...(sprintId ? { sprintId } : {}),
        ...(scopedDocumentIds == null ? {} : { id: { in: scopedDocumentIds } }),
      },
      select: { id: true, name: true, content: true, category: true },
    });
  } catch (e) { logWarn(`document load failed (non-fatal): ${e.message}`); return out; }

  const oracleDocs = documents.filter((d) => sourceTypeForCategory(d.category));
  if (!oracleDocs.length) return out; // no requirement docs → legacy path (additive)

  // DLP egress gate — may document text be sent to this provider?
  let provider = null;
  try {
    const { egressDisposition } = require('../lib/dlpEgress');
    const disp = egressDisposition(providerName);
    if (send) send({ type: 'agent.phase.log', phase: 'oracle', level: disp.allowed ? 'info' : 'warn', message: `DLP egress: ${disp.reason}` });
    if (disp.allowed && apiKey) {
      try { provider = require('../lib/llmProvider').getProvider(providerName); } catch (_) { provider = null; }
    }
  } catch (e) { logWarn(`DLP gate error (treating as deny): ${e.message}`); provider = null; }

  let extracted;
  try {
    extracted = await extractRequirements({
      documents: oracleDocs, projectId, sprintId,
      provider, apiKey: provider ? apiKey : null, model, send,
      degradations: out.degradations,
    });
  } catch (e) { logWarn(`extraction failed (non-fatal): ${e.message}`); return out; }

  let clauses = Array.isArray(extracted.requirements) ? extracted.requirements : [];
  if (clauses.length) {
    try {
      const written = await persistClauses({ prisma, projectId, sprintId, requirements: clauses });
      if (Array.isArray(written) && written.length) clauses = written; // prefer persisted rows
    } catch (e) { logWarn(`persistClauses degraded (client pre-regen?) — using in-memory clauses: ${e.message}`); }
  }

  out.requirementClauses = clauses;
  out.stats = {
    docCount: oracleDocs.length, clauseCount: clauses.length,
    testableCount: clauses.filter((c) => c && c.testable !== false).length,
    nonTestableCount: extracted.nonTestableCount || clauses.filter((c) => c && c.testable === false).length,
    candidateCount: extracted.candidateCount || 0, mergedCount: extracted.mergedCount || 0,
    rejectedCount: extracted.rejectedCount || 0, egressUsed: !!provider,
  };
  const override = String(process.env.QAAI_ARCHITECT_CONTEXT_MODE || '').toLowerCase();
  if (override === 'additive') out.contextMode = 'additive';
  else if (override === 'hybrid') out.contextMode = 'hybrid';
  else out.contextMode = clauses.length ? 'hybrid' : 'additive';
  return out;
}

/**
 * P2-integration — build the RTM after cases are persisted and write coverage
 * findings as Discrepancy rows (findings-only / non-blocking until P9). Reuses
 * the existing Discrepancy table with the requirement_uncovered kind. Graceful:
 * a write failure stops the loop rather than crashing the generation.
 *
 * @returns {{ matrix, uncovered, findingsCount, written }}
 */
async function persistRtmFindings({ prisma, projectId, requirements, casesWithRefs, log = console }) {
  const { matrix, uncovered, findings } = buildRTM(requirements, casesWithRefs);
  // REFRESH, don't accumulate. The RTM represents the CURRENT generation's
  // coverage of the in-scope clause set. persistRtmFindings used to .create() a
  // fresh `requirement_uncovered` Discrepancy on EVERY generation with no
  // generationId and no dedup, so the rows piled up across regenerations (the
  // observed 782 findings for 133 clauses — mathematically misleading). Clear
  // this project's prior RTM-owned rows first so the table reflects the latest
  // run, mirroring the project's regenerate-replace semantics. Scoped to the
  // RTM-owned kind ONLY — doc-diff kinds (in_brd_not_in_release, spec_mismatch,
  // requirement_conflict) and site-mismatch rows are owned by other flows and
  // are left untouched.
  try {
    await prisma.discrepancy.deleteMany({ where: { projectId, kind: 'requirement_uncovered' } });
  } catch (e) {
    if (log && typeof log.warn === 'function') log.warn(`[oracle] could not clear prior RTM findings (continuing): ${e.message}`);
  }
  let written = 0;
  // Dedup within this build too — one row per requirement id, never repeats.
  const seenReqKeys = new Set();
  for (const f of findings) {
    const dedupKey = `${f.kind}::${f.summary}`;
    if (seenReqKeys.has(dedupKey)) continue;
    seenReqKeys.add(dedupKey);
    try {
      await prisma.discrepancy.create({
        data: {
          projectId,
          kind: f.kind,
          severity: f.severity || 'warning',
          summary: String(f.summary || 'Requirement coverage finding').slice(0, 300),
          detail: String(f.detail || f.summary || '').slice(0, 4000) || f.kind,
        },
      });
      written++;
    } catch (e) {
      if (log && typeof log.warn === 'function') log.warn(`[oracle] discrepancy write degraded (stopping): ${e.message}`);
      break;
    }
  }
  return { matrix, uncovered, findingsCount: findings.length, written };
}

module.exports = {
  SOURCE_TYPES,
  sourceTypeForCategory,
  normalizeForId,
  classifyTestability,
  tokenSetForDedup,
  jaccard,
  computeRequirementId,
  verifyExcerpt,
  dedupeAndMerge,
  buildConflictFindings,
  buildRTM,
  clauseCoverageDisposition,
  deterministicSplit,
  extractRequirements,
  persistClauses,
  prepareArchitectClauses,
  persistRtmFindings,
};
