'use strict';

/**
 * Semantic fallback verifier.
 *
 * Closes the architectural inversion the deterministic verifier carries:
 * QAAI generates assertions FROM the BRD, then runs them AGAINST the live
 * UI. When the assertion's wording ("confirmation page") differs from the
 * SUT's actual rendered copy ("Thank you for your order!"), the deterministic
 * substring check produces `not_matched` even though a human tester would
 * call it a pass on sight.
 *
 * This module is the second stage of a two-stage verifier:
 *
 *   Stage 1 (deterministic, free)      — _checkAssertionOnce normalised
 *                                        substring/role/url match. If it
 *                                        matches, we're done.
 *   Stage 2 (LLM, this module)         — ONLY on stage-1 misses, ONLY when
 *                                        Run.verifierMode === 'semantic_fallback'.
 *                                        Asks the model "does this snapshot
 *                                        satisfy the assertion's intent?"
 *                                        Returns matched / not_matched /
 *                                        uncheckable + one-line evidence.
 *
 * The result is recorded into assertionCheckResults with
 *   source: 'semantic_fallback'
 * so we can distinguish "deterministic pass", "semantic rescue", and
 * "true miss" in the disagreement dashboard and on Reports.
 *
 * Cost discipline:
 *   - mid tier (Haiku 4.5 / Gemini 2.5 Flash via resolveModelForTier).
 *   - 600-token output cap, ~2 KB snapshot excerpt input (tail-slice).
 *   - Called AT MOST once per declared assertion per case per rerun.
 *   - Strict JSON output schema (parseJsonResponse), no markdown fences.
 *
 * Generic rule: the verifier is allowed to use semantic judgment ONLY when
 * the deterministic layer has already said "no". A deterministic pass is
 * absolute — we never override it with an LLM second-guess.
 */

const { getProvider } = require('../lib/llmProvider');
const { composeSystemPromptCached } = require('../lib/promptCompose');
const { parseJsonResponse } = require('../lib/parseJsonResponse');
const { resolveModelForTier } = require('../lib/modelRouter');

const TIER = 'mid';

const SYSTEM_PROMPT = `You are the QAAI semantic verifier. You are called when the deterministic substring/role/url matcher could NOT find an exact match for a declared assertion in the page snapshot, and the operator explicitly enabled semantic-fallback verification for this run.

Your one job: decide whether the snapshot SEMANTICALLY satisfies the assertion's intent.

Examples of legitimate semantic matches a human tester would call PASS:
  - assertion "confirmation page" + snapshot shows "Thank you for your order!"
  - assertion "user logged in" + snapshot shows the user's avatar, logout link, and the inventory page
  - assertion "error message visible" + snapshot shows a red banner with "Sorry, please try again"
  - assertion "cart updated" + snapshot shows the cart badge changed from 0 to 1

Examples that are NOT semantic matches and should stay not_matched:
  - assertion "order confirmation" + snapshot shows the cart page (different page, same flow)
  - assertion "success" + snapshot shows a generic "Welcome" with no transaction indicator
  - assertion "logged out" + snapshot still shows the user's avatar
  - assertion "$100 total" + snapshot shows "$50 total" (numbers must be exact)
  - assertion "No products found" + snapshot shows product listings (behavior is the opposite)
  - assertion "No products found" + snapshot has no empty-state message at all (behavior is absent, not differently worded)
  - assertion "success message" + snapshot shows only a loading spinner (element absent entirely)
  - text on page has obvious spelling/typo errors compared to expected — e.g. expected "Password" but page shows "Pssword" (copy bug, not wording difference)

Hard rules:
  1. Numbers, prices, counts, IDs, exact identifiers — these must be exact. Do not paper over numeric mismatches with "close enough".
  2. URLs — exact paths matter. /inventory.html is not /cart.html even if both are post-login.
  3. If you cannot tell from the snapshot — return uncheckable with reason explaining what was missing. Do NOT guess matched.
  4. Single short reasoning sentence (≤140 chars). Cite the specific snapshot text that supports your decision.
  5. Absent behavior — this rescue handles WORDING differences, not missing behaviors. If the expected behavior/text is entirely absent from the snapshot (nothing equivalent, nothing conceptually close), return not_matched. "Order placed" vs "Order confirmed" is a wording difference (pass). "No products found" absent from a page that shows zero results is a missing behavior (fail).
  6. Spelling errors / typos — if the page text contains the right concept but with obvious spelling mistakes, return not_matched. Copy bugs are real product defects.

Output STRICT JSON, no markdown, no preamble:
{
  "outcome": "matched" | "not_matched" | "uncheckable",
  "reasoning": "<one short sentence citing snapshot evidence>"
}`;

const SNAPSHOT_CAP = 8_000;

/**
 * Run a single semantic verification.
 *
 * @param {object}   opts
 * @param {string}   opts.apiKey
 * @param {string}   opts.model
 * @param {string}   [opts.provider]            'claude' | 'gemini'
 * @param {string}   opts.assertionText         Human description of the assertion
 *                                              (declared.description ?? declared.payload.expectedText)
 * @param {string}   [opts.assertionType]       Type tag for context ('TEXT'|'URL'|'ROLE'|...)
 * @param {string}   opts.snapshot              MCP accessibility-tree text (will be tail-sliced)
 * @param {string}   [opts.intent]              Optional case-level intent / user guidance
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onLog]
 * @param {function} [opts.onRateLimit]
 * @returns {Promise<{outcome: string, reasoning: string} | null>}
 *          Returns null on transport error so the caller can fall back to
 *          the deterministic not_matched it already had.
 */
async function verifySemantically({
  apiKey, model, provider: providerName,
  assertionText, assertionType, snapshot, intent,
  signal, onLog = async () => {}, onRateLimit,
} = {}) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY'; err.status = 400;
    throw err;
  }
  if (signal?.aborted) {
    const err = new Error('Cancelled before start.');
    err.code = 'CANCELLED'; err.status = 499;
    throw err;
  }
  if (!assertionText || !String(assertionText).trim()) return null;
  if (!snapshot || !String(snapshot).trim()) {
    // No snapshot = no evidence = uncheckable. Cheaper than burning an LLM call.
    return { outcome: 'uncheckable', reasoning: 'no snapshot available for semantic verification' };
  }

  const provider = getProvider(providerName);
  const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });

  // Tail-slice the snapshot — failure site / modal / new content is at
  // the bottom of MCP's top-to-bottom accessibility tree. Same rule as
  // the healer (P1-5).
  const fullSnap = String(snapshot);
  const snapExcerpt = fullSnap.length > SNAPSHOT_CAP ? fullSnap.slice(-SNAPSHOT_CAP) : fullSnap;

  const userMessage = {
    assertion: {
      text: assertionText,
      type: assertionType || 'TEXT',
    },
    intent: intent || null,
    snapshot: snapExcerpt,
  };

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model: routedModel,
      maxTokens: 600,
      system: composeSystemPromptCached(SYSTEM_PROMPT, null),
      messages: [{ role: 'user', content: JSON.stringify(userMessage, null, 2) }],
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
    await onLog('warn', `semantic verifier transport failed: ${err.message}`);
    return null;
  }

  const text =
    resp?.content?.find?.((b) => b?.type === 'text')?.text ||
    resp?.text || resp?.output_text || '';
  let parsed = null;
  try { parsed = parseJsonResponse(text); } catch (_) {}
  if (!parsed || typeof parsed !== 'object') {
    await onLog('warn', 'semantic verifier returned non-JSON');
    return null;
  }

  const outcome = ['matched', 'not_matched', 'uncheckable'].includes(parsed.outcome)
    ? parsed.outcome
    : null;
  if (!outcome) {
    await onLog('warn', `semantic verifier outcome invalid: ${JSON.stringify(parsed.outcome)}`);
    return null;
  }
  const reasoning = typeof parsed.reasoning === 'string'
    ? parsed.reasoning.slice(0, 240)
    : '';

  return { outcome, reasoning };
}

module.exports = { verifySemantically, SYSTEM_PROMPT };
