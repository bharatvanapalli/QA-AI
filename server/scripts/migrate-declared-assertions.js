'use strict';

/**
 * Phase H M3 — legacy migration: convert prose TestCase.assertions into
 * structured TestCase.declaredAssertions via Haiku (mid-tier, BYOK).
 *
 * Idempotent: skips rows where declaredAssertions is already non-null.
 * Run with: node server/scripts/migrate-declared-assertions.js [--dry-run]
 *
 * The script is intentionally NOT auto-invoked at server boot. Operator runs
 * it once after deploying M3, optionally re-runs after a backfill of new
 * cases. Per [[preserve-trial-data]] this script ONLY adds data — it never
 * deletes or alters the prose `assertions` field, never touches RunResult,
 * never touches any other column.
 *
 * Per CLAUDE.md model routing: declared as TIER='mid' so the model router
 * pins to Haiku 4.5 / Gemini 2.5 Flash regardless of project Settings choice.
 * BYOK budget is enforced by the provider wrapper; failed budget = TC marked
 * parseFailed and migration continues.
 *
 * Cost: ~100-200 TestCases × ~300 input tokens + ~150 output tokens at
 * Haiku rates ≈ a few cents total. One-time.
 */

const prisma = require('../prisma');
const { encodeJson, decodeJson } = require('../services/jsonField');
const declaredAssertionsLib = require('../lib/declaredAssertions');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const { getProvider } = require('../lib/llmProvider');
const { resolveModelForTier } = require('../lib/modelRouter');

const TIER = 'mid';
const DRY_RUN = process.argv.includes('--dry-run');

const SYSTEM_PROMPT = `You convert free-form QA test assertions into a structured JSON array.

INPUT: a prose string listing what a test case verifies, often comma-separated.
OUTPUT: a JSON array of records. EACH record has exactly these fields:

  type:    one of "TEXT" | "URL" | "ROLE" | "DOWNLOAD" | "FORBIDDEN_TEXT" | "FORBIDDEN_ROLE" | "EVALUATE"
  payload: object whose shape depends on type:
    TEXT             → { "expectedText": "<substring to match>" }
    FORBIDDEN_TEXT   → { "unexpectedText": "<substring that should NOT appear>" }
    URL              → { "expectedUrlPattern": "<JS regex>" }
    ROLE             → { "expectedRole": "<ARIA role>" }
    FORBIDDEN_ROLE   → { "unexpectedRole": "<ARIA role>" }
    DOWNLOAD         → { "filenamePattern"?: "regex", "minSize"?: number, "mimeType"?: "..." }
    EVALUATE         → { "script": "<JS>", "expectedReturn": "<value>" }
  targetUrl: optional path string ("/dashboard") where the assertion is checkable, or omit.
  checkAt:   optional "end" or "transient", default "end".

RULES:
  · Do NOT invent assertions that aren't expressed in the prose.
  · Do NOT emit HTTP-status-code checks (those are not verifiable in the page DOM).
  · Do NOT emit console-error checks (not in the page snapshot).
  · If a clause is too vague to map ("everything works correctly"), OMIT it rather than invent.
  · If the entire prose is unparseable, return an empty array [].
  · Output ONLY the JSON array. No markdown, no prose, no preamble.

EXAMPLES:

Input: "Cart badge shows 2, URL contains /cart"
Output: [
  {"type":"TEXT","payload":{"expectedText":"2"},"targetUrl":"/cart"},
  {"type":"URL","payload":{"expectedUrlPattern":"/cart"},"targetUrl":"/cart"}
]

Input: "user lands on dashboard, no error banner visible, page does not contain 'undefined'"
Output: [
  {"type":"URL","payload":{"expectedUrlPattern":"/dashboard"},"targetUrl":"/dashboard"},
  {"type":"FORBIDDEN_TEXT","payload":{"unexpectedText":"undefined"}}
]
(Note: "no error banner visible" was omitted — too vague without source text.)

Input: "PDF report downloads with filename starting 'invoice-' and size > 1KB"
Output: [
  {"type":"DOWNLOAD","payload":{"filenamePattern":"^invoice-.*\\\\.pdf$","minSize":1024}}
]`;

async function migrateOne({ tc, apiKey, model, provider }) {
  const prose = String(tc.assertions || '').trim();
  if (!prose) {
    // No prose to convert — automatable case routes to parseFailed via empty array.
    const result = declaredAssertionsLib.normalizeForCase(
      [],
      { automatability: tc.automatability || 'automatable', caseName: tc.name }
    );
    return { tc, normalized: result.normalized, source: 'empty_prose' };
  }
  try {
    const providerImpl = getProvider(provider);
    const completion = await providerImpl.complete({
      apiKey,
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Convert this assertion prose into the JSON array per the rules above:\n\n${prose}` }],
      maxTokens: 800,
      responseFormat: 'json',
    });
    const text = (completion.content || []).find((c) => c.type === 'text')?.text || '';
    let parsed;
    try {
      // Strip ``` fences if Haiku slipped one in despite the prompt.
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (_) {
      // Salvage: regex-extract the first [...] block.
      const m = text.match(/\[[\s\S]*\]/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!Array.isArray(parsed)) {
      throw new Error('non-array response');
    }
    const result = declaredAssertionsLib.normalizeForCase(
      parsed,
      { automatability: tc.automatability || 'automatable', caseName: tc.name }
    );
    return { tc, normalized: result.normalized, source: 'haiku_parsed', issues: result.issues };
  } catch (err) {
    // Convert failure → parseFailed placeholder so M4 routes to needs_human
    // rather than silently passing.
    const result = declaredAssertionsLib.normalizeForCase(
      [],
      { automatability: tc.automatability || 'automatable', caseName: tc.name }
    );
    return { tc, normalized: result.normalized, source: 'haiku_failed', error: err.message };
  }
}

async function main() {
  console.log(`[migrate-declared-assertions] starting (dry-run=${DRY_RUN})`);

  // Find every TC that doesn't yet have declaredAssertions populated.
  // Includes both automatable and manual — manual cases get empty arrays,
  // automatable get either parsed records or parseFailed placeholders.
  const rows = await prisma.testCase.findMany({
    where: { declaredAssertions: null },
    include: { project: { select: { id: true, userId: true, aiProvider: true } } },
  });
  console.log(`[migrate-declared-assertions] found ${rows.length} candidate TC(s)`);

  if (rows.length === 0) {
    console.log('[migrate-declared-assertions] nothing to do');
    return;
  }

  // Group by project so we resolve credentials once per project.
  const byProject = new Map();
  for (const tc of rows) {
    const pid = tc.project.id;
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(tc);
  }

  let processed = 0;
  let backfilled = 0;
  let parseFailed = 0;
  for (const [projectId, projectTcs] of byProject) {
    const project = projectTcs[0].project;
    let creds;
    try {
      creds = await resolveAiCredentials(project.userId, { aiProvider: project.aiProvider || 'claude' });
    } catch (err) {
      console.warn(`[migrate-declared-assertions] project ${projectId}: cannot resolve creds (${err.message}); skipping ${projectTcs.length} TCs`);
      continue;
    }
    const model = resolveModelForTier({ provider: project.aiProvider || 'claude', requestedModel: creds.model, tier: TIER });

    for (const tc of projectTcs) {
      const outcome = await migrateOne({ tc, apiKey: creds.apiKey, model, provider: project.aiProvider || 'claude' });
      processed += 1;
      const hasParseFailed = outcome.normalized.some((n) => n.parseFailed);
      if (hasParseFailed) parseFailed += 1; else backfilled += 1;
      if (!DRY_RUN) {
        await prisma.testCase.update({
          where: { id: tc.id },
          data: { declaredAssertions: encodeJson(outcome.normalized) },
        });
      }
      console.log(`  ${outcome.source.padEnd(14)} TC=${tc.id.slice(0, 8)} "${tc.name.slice(0, 50)}" → ${outcome.normalized.length} record(s)${hasParseFailed ? ' [parseFailed]' : ''}${outcome.error ? ` err=${outcome.error}` : ''}`);
    }
  }

  console.log(`[migrate-declared-assertions] processed=${processed} backfilled=${backfilled} parseFailed=${parseFailed}${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error('[migrate-declared-assertions] fatal:', err);
    return prisma.$disconnect().then(() => process.exit(1));
  });
