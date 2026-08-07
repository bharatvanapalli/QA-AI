'use strict';

/**
 * Agent — Post-mortem (Phase G).
 *
 * Closes the cross-run learning loop. For each failed/blocked RunResult on a
 * just-finished run, this agent classifies the failure into a project-scoped
 * *pattern* — a reusable lesson the conductor can apply on the NEXT run.
 *
 *   Input  : RunResults with status fail|blocked AND a Reporter-produced RCA
 *            (rcaWhat / rcaWhy / rcaFix), plus the project's existing pattern
 *            store so we can grow/update rather than duplicate.
 *
 *   Output : array of { signature, category, title, description, trigger,
 *            resolution, exampleRunResultId } — one per failure. The caller
 *            upserts these into the FailurePattern table (occurrences++ on
 *            existing signatures).
 *
 * The conductor reads the resulting top-N patterns (by occurrences) at the
 * start of every subsequent run for the same project. rcaChat does the same
 * to ground per-failure user chat answers in real project history.
 *
 * Distinct from the Reporter, BlockageAnalyzer and rcaChat:
 *   - Reporter writes per-result narrative RCA (what / why / fix). One-shot.
 *   - BlockageAnalyzer classifies blockers into a fixed 6-category enum for
 *     the BlockedItems UI. Result-level.
 *   - rcaChat is conversational follow-up on ONE failure. Read-only context.
 *   - postMortem is the only agent that writes CROSS-RESULT, CROSS-RUN
 *     wisdom. Its output mutates how the next run BEHAVES.
 *
 * Cost note: this is a single Claude call per `analyze` invocation, batching
 * every failure in one prompt. Tier=mid because the input is already heavily
 * pre-digested (the Reporter has done the heavy reasoning); postMortem's job
 * is structured classification + lesson distillation, not free analysis.
 */

const crypto = require('crypto');
const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt, composeSystemPromptCached } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');
const { resolveModelForTier } = require('../../lib/modelRouter');

const TIER = 'mid';

// Soft category vocabulary — the agent picks ONE. New categories grow the
// vocabulary without a migration (the column is plain TEXT). Keep this list
// stable so cross-run aggregation by `category` stays meaningful.
const CATEGORY_HINTS = [
  'redirect-race',           // post-action snapshot caught the page pre-redirect
  'stale-snapshot-ref',      // ref like e54 no longer exists after a DOM swap
  'form-validation-silent',  // form rejected input without a visible error the agent could see
  'modal-blocking',          // a dialog/overlay intercepted clicks
  'async-content-load',      // assertion fired before AJAX content rendered
  'selector-drift',          // element exists but accessible-name/role changed
  'auth-state-loss',         // session/cookie expired mid-case
  'rate-limited-by-sut',     // SUT throttled the test
  'animation-timing',        // pre-animation snapshot caught hidden element
  'data-precondition-missing', // test assumed data that wasn't seeded
  'agent-tool-misuse',       // agent used a tool incorrectly (e.g. bad zod input)
  'env-instability',         // browser/MCP-level instability
  'unknown',                 // genuinely unclear from the evidence
];

const SYSTEM_PROMPT = `You are a senior staff QA architect doing CROSS-RUN post-mortem on Playwright test failures driven by an autonomous Claude agent (the "Conductor").

Your job is to turn raw failure evidence into REUSABLE PATTERNS the agent can apply on the NEXT run. You are NOT writing per-failure RCA — that's already been done (you'll see it in the input). You are extracting the underlying *trap* so the agent stops falling into it.

You receive:
  - failures        : array of failed/blocked RunResults from THIS run, each with:
                       { id, testCaseName, status, error, tracePreview,
                         rcaWhat, rcaWhy, rcaFix, rcaClass }
  - existingPatterns: this project's current FailurePattern rows:
                       { signature, category, title, occurrences, description, resolution }
                      so you can MATCH a new failure to an existing pattern instead of
                      creating a near-duplicate.

For EACH failure, decide:

  signature — a stable, deterministic 8-12 char ID (lowercase kebab-case) that
              uniquely identifies the underlying pattern. SAME pattern across
              failures MUST get the SAME signature. Examples:
                  "redirect-race-post-submit"
                  "stale-ref-after-dom-swap"
                  "modal-intercepts-click"
              When the failure matches an existingPattern, REUSE that pattern's
              signature exactly. Don't fork the vocabulary.

  category  — one of: ${CATEGORY_HINTS.map((c) => `'${c}'`).join(' | ')}
              or a new short kebab-case category if NONE fit. Prefer reuse.

  title     — short human-readable name (<= 80 chars). Title-case.
              e.g. "Post-click snapshot races page redirect"

  description — 1-2 sentences explaining WHAT happens when this pattern fires.
                Refer to specific tools/state ("agent calls browser_snapshot before
                the redirect lands, sees stale URL, …"). NEVER vague filler.

  trigger    — ONE sentence: the conditions under which the agent should expect
               this pattern. Used by the next run's conductor to know WHEN the
               lesson applies. e.g. "After clicking a submit/login/register
               button on a multi-step flow."

  resolution — THE ACTIONABLE LESSON for the next run, phrased as guidance to
               the agent itself. Concrete and short. Examples:
               - "After a navigation-triggering click, call browser_evaluate(() => location.href) before relying on browser_snapshot — snapshots can be stale during redirects."
               - "If a ref like 'e54' fails to match, take a fresh browser_snapshot and re-derive refs from it before retrying."
               - "When a click does nothing visible, check for an open dialog with browser_evaluate before re-typing the field."
               NEVER suggest "add a sleep" — that's a smell. Prefer tools that
               read current state.

  exampleRunResultId — echo back the input failure id you classified.

If a failure matches an existing pattern (semantically — not just same words),
REUSE that signature, category, title, description, trigger, and resolution
verbatim. The caller will increment occurrences on the existing row and add
this failure id to its examples list. Only emit a NEW pattern when the failure
is genuinely a new trap.

Output a SINGLE JSON object — no markdown, no preamble:
{
  "patterns": [
    {
      "signature": "...",
      "category": "...",
      "title": "...",
      "description": "...",
      "trigger": "...",
      "resolution": "...",
      "exampleRunResultId": "..."
    }
  ]
}

Rules:
- ONE entry per input failure; omit nothing.
- Two different failures that share the same root cause MUST produce the SAME signature.
- Keep title under 80 chars, description under 280 chars, trigger under 160 chars, resolution under 320 chars.
- Never invent a failure id; echo the input ids verbatim.
- If you genuinely cannot classify a failure, use category='unknown' but still write a useful description/resolution.`;

function normalisePattern(raw, validIds) {
  if (!raw || typeof raw !== 'object') return null;
  const exampleRunResultId = String(raw.exampleRunResultId || '').trim();
  if (!exampleRunResultId || !validIds.has(exampleRunResultId)) return null;
  let signature = String(raw.signature || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!signature) {
    signature = `auto-${crypto.createHash('sha1').update(String(raw.title || exampleRunResultId)).digest('hex').slice(0, 10)}`;
  }
  // Cap signature length so the unique index stays reasonable.
  signature = signature.slice(0, 64);
  const category = String(raw.category || 'unknown').trim().slice(0, 64) || 'unknown';
  const title = String(raw.title || '(untitled pattern)').trim().slice(0, 120);
  const description = String(raw.description || '').trim().slice(0, 400);
  const trigger = String(raw.trigger || '').trim().slice(0, 240);
  const resolution = String(raw.resolution || '').trim().slice(0, 480);
  if (!resolution) return null; // a pattern with no lesson is useless
  return { signature, category, title, description, trigger, resolution, exampleRunResultId };
}

/**
 * @param {object} opts
 * @param {string}  opts.apiKey
 * @param {string}  opts.model
 * @param {string}  opts.provider
 * @param {Array}   opts.failures         RunResults with RCA already populated
 * @param {Array}   opts.existingPatterns FailurePattern rows for the project
 * @param {function} [opts.onLog]
 * @param {function} [opts.onRateLimit]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ patterns: Array }>}
 */
async function run({
  apiKey, model, provider: providerName,
  failures, existingPatterns = [],
  onLog = async () => {}, onRateLimit, signal, extraGuidance,
} = {}) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  const list = Array.isArray(failures) ? failures.filter(Boolean) : [];
  if (list.length === 0) {
    return { patterns: [] };
  }
  if (signal?.aborted) {
    const err = new Error('Cancelled before start.');
    err.code = 'CANCELLED'; err.status = 499;
    throw err;
  }

  const provider = getProvider(providerName);
  const validIds = new Set(list.map((f) => f.id));

  // Trim each failure to the signal-rich bits. Trace is most useful; cap at
  // 1.2kB per failure so a 10-failure run keeps the prompt under budget.
  const compactFailures = list.map((f) => ({
    id: f.id,
    testCaseName: f.testCaseName || null,
    status: f.status,
    error: String(f.error || '').slice(0, 600),
    tracePreview: String(f.trace || '').slice(-1200),
    rcaWhat: String(f.rcaWhat || '').slice(0, 300),
    rcaWhy: String(f.rcaWhy || '').slice(0, 400),
    rcaFix: String(f.rcaFix || '').slice(0, 400),
    rcaClass: f.rcaClass || null,
  }));

  // Existing patterns — only the fields the agent needs to dedupe against.
  // Cap at 30 patterns; if a project has more, the highest-occurrence ones win.
  const compactExisting = (Array.isArray(existingPatterns) ? existingPatterns : [])
    .slice()
    .sort((a, b) => (b.occurrences || 0) - (a.occurrences || 0))
    .slice(0, 30)
    .map((p) => ({
      signature: p.signature,
      category: p.category,
      title: p.title,
      occurrences: p.occurrences,
      description: String(p.description || '').slice(0, 240),
      resolution: String(p.resolution || '').slice(0, 320),
    }));

  await onLog('info', `Classifying ${compactFailures.length} failure(s) against ${compactExisting.length} existing pattern(s)…`);

  let resp;
  try {
    const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });
    resp = await provider.complete({
      apiKey,
      model: routedModel,
      maxTokens: 4000,
      system: composeSystemPromptCached(SYSTEM_PROMPT, extraGuidance),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '## failures' },
            { type: 'text', text: JSON.stringify(compactFailures, null, 2) },
            { type: 'text', text: '\n## existingPatterns (reuse signatures when a failure matches one)' },
            { type: 'text', text: JSON.stringify(compactExisting, null, 2) },
          ],
        },
      ],
      signal,
      onRateLimit,
      responseFormat: 'json',
    });
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) {
      const cancelled = new Error('Cancelled.');
      cancelled.code = 'CANCELLED'; cancelled.status = 499;
      throw cancelled;
    }
    await onLog('error', `Post-mortem call failed: ${err.message}`);
    throw err;
  }

  const text = (resp.content?.[0]?.text || '').trim();
  const parsed = parseJsonResponse(text, { type: 'object' });
  if (!parsed) {
    await onLog('warn', 'Post-mortem returned non-JSON; no patterns recorded.');
    return { patterns: [] };
  }

  const patterns = Array.isArray(parsed.patterns)
    ? parsed.patterns.map((p) => normalisePattern(p, validIds)).filter(Boolean)
    : [];

  await onLog('info', `Produced ${patterns.length}/${list.length} pattern classification(s).`);
  return { patterns };
}

module.exports = { run, SYSTEM_PROMPT, CATEGORY_HINTS };
