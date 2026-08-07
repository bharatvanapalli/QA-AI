'use strict';

/**
 * Agent — Visual Critic (Phase E4 / BUILD_PLAN_V2).
 *
 * Semantic screenshot diff. Receives two images (baseline + current) plus
 * the assertion the test was checking, and returns a structured verdict:
 *
 *   verdict  : 'pass' | 'fail' | 'inconclusive'
 *               - 'pass'         — nothing UI-relevant changed; the assertion
 *                                  still holds visually.
 *               - 'fail'         — a real visual regression: layout broke,
 *                                  copy changed, colour-coded state changed,
 *                                  expected element disappeared.
 *               - 'inconclusive' — diffs are cosmetic / non-deterministic
 *                                  (timestamps, ads, anti-flicker shimmer,
 *                                  carousel auto-rotation) and we can't say
 *                                  one way or the other.
 *   diffs    : ordered list of {region, before, after, severity} describing
 *              what changed. Region is a human label ("top navigation",
 *              "primary CTA"), NOT pixel coords. Severity ∈ low|medium|high.
 *   summary  : 1-3 sentence narration the Reports panel renders verbatim.
 *
 * Pixel-diff (resemble.js / pixelmatch) flags noise: timestamps, blinking
 * cursors, AB-test variants, anti-flicker shimmer. The Visual Critic looks
 * at the same pair and decides what matters to a QA lead.
 *
 * Two policies the caller controls:
 *   - SKIP entirely when only one image exists (no baseline yet, or current
 *     screenshot missing). The first pass writes the baseline; the second
 *     pass starts comparing. Callers should check both URLs before calling.
 *   - The Conductor calls this on EVERY pass and on visual-class failures.
 *     'pass' verdict is a confirmation; 'fail' marks the result as a
 *     visual regression even when the underlying assertion logic passed.
 *
 * Provider-agnostic via the canonical Anthropic image block; the gemini
 * provider translates to inlineData at its boundary. Cancellation-aware.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt, composeSystemPromptCached } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');

const SYSTEM_PROMPT = `You are a senior QA visual critic comparing two screenshots of the SAME page taken at two points in time.

You receive:
  - One BASELINE screenshot (the historically-passing look of this page).
  - One CURRENT screenshot (this run's final state).
  - The assertion the test was checking ("homepage shows the welcome banner",
    "order confirmation page shows the order number", etc.). May be empty
    when the test had no explicit assertion.

Your job: decide whether anything the QA team would care about changed.

Verdict — exactly one of:
  - "pass"         : the visuals are equivalent. Minor sub-pixel rendering
                      differences, timestamp ticks, scrollbar shimmer, and
                      browser-injected overlays are NOT a regression. The
                      assertion still holds.
  - "fail"         : a real regression. Pick this when ANY of the following
                      are true:
                        - An element from the baseline is GONE in the current.
                        - The primary call-to-action moved, changed copy, or
                          changed colour-coded state (success→danger, etc.).
                        - Layout broke (overlapping elements, content cut off,
                          unscrollable modal).
                        - Page-level error state visible in current that was
                          NOT in baseline (red banner, "Something went wrong",
                          empty data table where data existed).
                        - The assertion would no longer be true given what
                          you see in the current screenshot.
  - "inconclusive" : the screenshots differ but the differences are non-
                      deterministic (timestamps, dates, weather widgets,
                      carousel auto-rotation, ad slots, A/B test variants
                      that flip per-session) AND none of the "fail" criteria
                      above are met. Use sparingly — when in doubt between
                      pass and inconclusive, lean pass.

Diffs — an ORDERED array of structured regions that changed. Each entry:
  {
    "region":   "human label, e.g. 'primary CTA' or 'top navigation'",
    "before":   "what the baseline shows there (≤140 chars)",
    "after":    "what the current shows there (≤140 chars)",
    "severity": "low" | "medium" | "high"
  }
  - low    : visual but not semantic (font weight changed, padding shift).
  - medium : a CTA or content change that a user would notice but the page
             still works.
  - high   : an element vanished, layout broke, or an error state appeared.
  - Cap diffs at 6 entries. Skip when nothing notably changed (verdict=pass
    with an empty array is fine).
  - If verdict=fail, diffs MUST have ≥ 1 entry of severity high or medium.

Summary — 1-3 sentences in a QA reviewer's voice, narrating what changed.
  - Lead with the most important change.
  - Be specific: name elements ("Place order button", "address form"),
    quote visible text, name colours when colour matters.
  - Bad: "Some UI changed."
  - Good: "Primary 'Place order' CTA changed colour from green to amber and
          its copy now reads 'Pending review'. Order-confirmation banner is
          missing entirely."
  - Cap at 480 chars.

Output a SINGLE JSON object — no markdown, no preamble:
{
  "verdict": "pass" | "fail" | "inconclusive",
  "diffs": [
    { "region": "...", "before": "...", "after": "...", "severity": "low" | "medium" | "high" }
  ],
  "summary": "..."
}

Hard rules:
- JSON only. No code fences, no commentary outside the JSON.
- When the two screenshots are visually identical, return
  {"verdict":"pass","diffs":[],"summary":"No visual regression detected."}.
- Do not fabricate diffs to fill the array. An honest empty array is the
  right answer when nothing meaningful changed.`;

const VALID_VERDICTS = ['pass', 'fail', 'inconclusive'];
const VALID_SEVERITIES = ['low', 'medium', 'high'];

function clamp(s, max) {
  const t = String(s || '').trim();
  return t.length > max ? t.slice(0, max) : t;
}

function normaliseResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const verdict = VALID_VERDICTS.includes(raw.verdict) ? raw.verdict : 'inconclusive';
  const diffs = Array.isArray(raw.diffs)
    ? raw.diffs
        .map((d) => ({
          region: clamp(d?.region, 100) || 'unspecified',
          before: clamp(d?.before, 160),
          after: clamp(d?.after, 160),
          severity: VALID_SEVERITIES.includes(d?.severity) ? d.severity : 'low',
        }))
        .filter((d) => d.before || d.after)
        .slice(0, 6)
    : [];
  const summary = clamp(raw.summary, 520);
  return { verdict, diffs, summary };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.provider
 * @param {string} opts.baselineBase64       Base64-encoded image bytes (no data: prefix)
 * @param {string} opts.currentBase64        Base64-encoded image bytes (no data: prefix)
 * @param {string} [opts.baselineMediaType]  'image/jpeg' (default) | 'image/png'
 * @param {string} [opts.currentMediaType]   'image/jpeg' (default) | 'image/png'
 * @param {string} [opts.expectedAssertion]  The assertion the test was checking
 * @param {function} [opts.onLog]
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onRateLimit]
 * @param {string} [opts.extraGuidance]
 * @returns {Promise<{ verdict, diffs, summary } | null>}
 */
async function compare({
  apiKey, model, provider: providerName,
  baselineBase64, currentBase64,
  baselineMediaType = 'image/jpeg', currentMediaType = 'image/jpeg',
  expectedAssertion,
  onLog = async () => {}, signal, onRateLimit, extraGuidance,
} = {}) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  if (signal?.aborted) {
    const err = new Error('Cancelled before start.');
    err.code = 'CANCELLED'; err.status = 499;
    throw err;
  }
  if (!baselineBase64 || !currentBase64) {
    // The caller is expected to short-circuit when either image is missing
    // (no baseline yet, or screenshot failed). Returning null lets the
    // conductor treat this as "nothing to compare" without raising.
    return null;
  }

  const provider = getProvider(providerName);
  await onLog('info', 'VisualCritic comparing baseline vs current screenshot…');

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model,
      maxTokens: 1500,
      system: composeSystemPromptCached(SYSTEM_PROMPT, extraGuidance),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: expectedAssertion
                ? `Assertion the test was checking: "${String(expectedAssertion).slice(0, 280)}"\n\nBaseline (historically-passing look):`
                : 'Baseline (historically-passing look):',
            },
            {
              type: 'image',
              source: { type: 'base64', media_type: baselineMediaType, data: baselineBase64 },
            },
            { type: 'text', text: 'Current (this run\'s final state):' },
            {
              type: 'image',
              source: { type: 'base64', media_type: currentMediaType, data: currentBase64 },
            },
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
    await onLog('warn', `VisualCritic call failed: ${err.message}`);
    return null;
  }

  const text =
    resp?.content?.find?.((b) => b?.type === 'text')?.text ||
    resp?.text || resp?.output_text || '';
  let parsed;
  try {
    parsed = parseJsonResponse(text);
  } catch (err) {
    await onLog('warn', `VisualCritic returned unparseable JSON: ${err.message}`);
    return null;
  }
  const result = normaliseResult(parsed);
  if (!result) {
    await onLog('warn', 'VisualCritic output failed schema validation.');
    return null;
  }
  await onLog(
    result.verdict === 'fail' ? 'warn' : 'info',
    `VisualCritic verdict: ${result.verdict}${result.diffs.length ? ` · ${result.diffs.length} diff(s)` : ''}.`,
  );
  return result;
}

module.exports = { compare, VALID_VERDICTS, VALID_SEVERITIES };
