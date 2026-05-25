'use strict';

/**
 * Agent — Locator Healer (Phase E1 / BUILD_PLAN_V2).
 *
 * The Conductor calls this when an `isError: true` tool result comes back
 * with a locator-class failure (element not found, timeout on locator,
 * "no element matches selector", etc.).
 *
 * Healer reads the FRESH accessibility-tree snapshot (Playwright MCP YAML)
 * plus the semantic intent of the target element, and proposes a NEW
 * Playwright locator that should resolve to the intended element on THIS
 * DOM. The Conductor retries the tool with the healer's selector; on
 * success the heal is recorded into `KnowledgeBaseLocator.healHistory` and
 * `healthScore` is bumped.
 *
 * Selector strategy preference (encoded in the prompt):
 *   1. `getByRole(role, { name })`      ← most resilient to DOM churn
 *   2. `getByTestId(...)`               ← if the page uses test-ids
 *   3. `getByLabel(...)`                ← form fields
 *   4. `getByText(...)`                 ← visible text content
 *   5. CSS as a last resort
 *
 * Output is strict JSON: `{ strategy, selector, confidence: 0-99,
 * reasoning }`. Confidence reflects ambiguity in the tree — multiple
 * matches lowers confidence, exact unique role+name match maxes it.
 *
 * Per CLAUDE.md cancellation pattern: accepts `signal` and propagates to
 * `provider.complete`. Per Phase A: provider-agnostic.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');
const { resolveModelForTier } = require('../../lib/modelRouter');

// Phase E5 — cost routing. The healer reads a freshly-captured DOM snapshot
// and proposes one locator string. Pure pattern-recognition over structured
// input; well within mid-tier capability and called often during real runs.
const TIER = 'mid';

const SYSTEM_PROMPT = `You are a Playwright locator-healing agent. The current Playwright run hit a locator failure (timeout / element-not-found). Your job: read the FRESH page snapshot (Playwright MCP accessibility tree) and propose a single Playwright locator that targets the user's intended element on THIS DOM.

Inputs you receive (as user message JSON):
  - "intent"        : semantic description of the target ("primary login submit button")
  - "brokenLocator" : the selector that just failed (for reference, do NOT just return it)
  - "brokenStrategy": its strategy ('role' | 'testid' | 'css' | 'xpath' | null)
  - "freshSnapshot" : the current accessibility-tree text from browser_snapshot
  - "history"       : past heals on this locator (may be empty) — avoid repeating
                       suggestions that previously failed

Output a SINGLE JSON object — no markdown, no preamble:
{
  "strategy"  : "role" | "testid" | "label" | "text" | "css",
  "selector"  : "<Playwright locator expression>",
  "confidence": <0-99 integer>,
  "reasoning" : "<one sentence explaining the choice>"
}

Selector preference order (strict):
  1. role  — emit selector as JSON object: {"role":"button","name":"Sign in"}
            (Conductor converts to getByRole). ALWAYS check both role AND
            accessible name from the snapshot. Prefer this when a unique
            role+name pair exists.
  2. testid — emit the bare data-testid value, e.g. "auth-submit".
              Use only if the snapshot shows a [testid=...] attribute.
  3. label — emit the visible label text. Use for form inputs.
  4. text  — emit the visible text. Use for unique buttons/links not
              well-described by role.
  5. css   — last resort. NEVER return generated class names with numeric
              tails (e.g. ".btn-x9k3z" — that's exactly the broken-locator
              class). Prefer attribute selectors and structural css.

Confidence guidance:
  - 90-99 : exact unique role+name match found in the snapshot
  - 70-89 : strong unique match via testid/label/text
  - 40-69 : reasonable match but the tree has ambiguity (multiple matches
            for the chosen strategy)
  - 0-39  : nothing in the snapshot clearly matches the intent — the
            page probably navigated away or the element is genuinely
            missing. Return your best guess; the Conductor will use the
            low confidence to refuse the heal and emit a BlockedItem.

Strict rules:
  - NEVER return the same selector that's already in "brokenLocator".
  - NEVER return a selector that was tried in "history" (it failed before).
  - If the snapshot doesn't contain anything close to the intent, RETURN
    a low-confidence (≤30) guess with reasoning="snapshot does not contain
    a matching element". Do NOT fabricate.
  - Strict JSON. No prose. No code fences. No trailing comments.`;

const VALID_STRATEGIES = ['role', 'testid', 'label', 'text', 'css'];

function normaliseResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const strategy = VALID_STRATEGIES.includes(raw.strategy) ? raw.strategy : null;
  if (!strategy) return null;
  // Selector for role strategy comes as { role, name } object; flatten to a
  // structured value the conductor can hand to getByRole.
  let selector = raw.selector;
  if (strategy === 'role') {
    if (typeof selector === 'string') {
      try { selector = JSON.parse(selector); } catch (_) { /* fall through */ }
    }
    if (!selector || typeof selector !== 'object' || !selector.role) return null;
    selector = { role: String(selector.role).trim(), name: selector.name ? String(selector.name).trim() : undefined };
  } else {
    if (typeof selector !== 'string' || !selector.trim()) return null;
    selector = selector.trim();
  }
  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(99, Math.round(confidence)));
  const reasoning = String(raw.reasoning || '').slice(0, 400).trim();
  return { strategy, selector, confidence, reasoning };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.provider
 * @param {string} opts.intent           semantic description of the target
 * @param {string} opts.brokenLocator    selector that just failed
 * @param {string} [opts.brokenStrategy] strategy of the broken locator
 * @param {string} opts.freshSnapshot    Playwright-MCP accessibility tree text
 * @param {Array}  [opts.history]        prior heal attempts (from healHistory)
 * @param {function} [opts.onLog]
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onRateLimit]
 * @param {string} [opts.extraGuidance]
 * @returns {Promise<{strategy, selector, confidence, reasoning} | null>}
 */
async function healLocator({
  apiKey, model, provider: providerName,
  intent, brokenLocator, brokenStrategy, freshSnapshot,
  history = [],
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
  if (!freshSnapshot || !String(freshSnapshot).trim()) {
    // Without a snapshot we can't reason at all — refuse cleanly so the
    // Conductor can fall back to its existing error path instead of burning
    // a Claude call that's guaranteed to fail.
    return null;
  }

  const provider = getProvider(providerName);
  const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });

  // Cap snapshot to ~16k chars so a noisy page doesn't blow the budget; the
  // most recent slice is the most useful because MCP emits the visible tree
  // top-to-bottom and bottom-up failures (sticky footers, modals) get cut
  // first under this cap. 16k of YAML accessibility tree is typically the
  // entire visible page.
  const snapshot = String(freshSnapshot).slice(0, 16_000);

  // History is the structured `healHistory` array — keep the most recent 5
  // attempts so the model knows what NOT to repeat.
  const recent = Array.isArray(history) ? history.slice(-5) : [];

  await onLog('info', `Healer reading snapshot (${snapshot.length} chars) for "${intent || brokenLocator}"…`);

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model: routedModel,
      maxTokens: 1200,
      system: composeSystemPrompt(SYSTEM_PROMPT, extraGuidance),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                intent: intent || null,
                brokenLocator: brokenLocator || null,
                brokenStrategy: brokenStrategy || null,
                history: recent,
              }, null, 2),
            },
            { type: 'text', text: '\n## freshSnapshot\n' },
            { type: 'text', text: snapshot },
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
    await onLog('warn', `Healer call failed: ${err.message}`);
    return null;
  }

  const text =
    resp?.content?.find?.((b) => b?.type === 'text')?.text ||
    resp?.text || resp?.output_text || '';
  let parsed;
  try {
    parsed = parseJsonResponse(text);
  } catch (err) {
    await onLog('warn', `Healer returned unparseable JSON: ${err.message}`);
    return null;
  }
  const result = normaliseResult(parsed);
  if (!result) {
    await onLog('warn', 'Healer output failed schema validation.');
    return null;
  }
  await onLog('info', `Healer proposed ${result.strategy} → ${typeof result.selector === 'string' ? result.selector : JSON.stringify(result.selector)} (confidence ${result.confidence}).`);
  return result;
}

module.exports = { healLocator };
