'use strict';

/**
 * Agent — On-page Instruction Reader (Phase E1.6 / BUILD_PLAN_V2).
 *
 * Vision agent that reads a page screenshot and extracts what the page is
 * INSTRUCTING the user to do. Triggered by the Conductor when:
 *   1. The MCP loop-guard would otherwise fire (same tool called too many
 *      times — the agent is stuck retrying instead of reading the page),
 *      OR
 *   2. The cheap snapshot-text reader (`extractPageInstructions` in
 *      conductor.js) found nothing actionable but the page clearly has
 *      copy that should be read.
 *
 * Real failure mode this addresses: a login page whose copy says
 *   "Click Register first to create an account before logging in."
 * The Playwright-MCP snapshot DOES contain that text, but the agent's
 * D1 alert-extractor only surfaces role="alert" / role="status" nodes.
 * Plain paragraphs telling the user what to do slip through unread.
 *
 * Output: { instructions: string[], summary: string, confidence: 0-99 }
 *   - instructions : an ordered list of imperative steps the page is
 *                    instructing the user to follow ("Click Register first",
 *                    "Check your email for a confirmation link")
 *   - summary      : 1-sentence gist of what the page is telling the user
 *   - confidence   : 0 = nothing actionable found; > 0 = signal worth acting on
 *
 * Provider-agnostic via the canonical Anthropic image block; the gemini
 * provider translates to inlineData at its boundary. Cancellation-aware.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt, composeSystemPromptCached } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');
const { resolveModelForTier } = require('../../lib/modelRouter');

// Phase E5 — cost routing. Reading instructional copy off a screenshot
// is a small vision task that Haiku 4.5 handles well; the call fires on
// every loop-guard fallback so the savings compound.
const TIER = 'mid';

const SYSTEM_PROMPT = `You are an instruction-reader for a QA testing agent that drives a real browser.

The QA agent is currently stuck — it has tried the same action multiple times and it keeps failing. There is a strong chance the page contains visible copy telling the user what to do FIRST (e.g. "Click Register first to create an account", "Verify your email before logging in", "Activate your account via the link we sent").

You will receive ONE screenshot of the page. Your job:
  1. Look at the visible text on the page.
  2. Identify ANY instructional copy — sentences telling the user what they should DO. Examples:
       - "Click Register first to create an account."
       - "Check your inbox for a verification link."
       - "Use your Microsoft account to sign in."
       - "Complete the setup by enabling two-factor authentication."
       - "Follow these steps to reset your password..."
  3. IGNORE:
       - Cookie banners ("Accept all cookies").
       - Marketing copy ("Welcome to our app", "The best CRM").
       - Footer links ("Privacy Policy", "Terms of Service", "About us").
       - Form labels in isolation ("Email", "Password").
       - Help text that just describes a field ("Enter your email").

Output a SINGLE JSON object — no markdown, no preamble:
{
  "instructions": ["imperative step 1", "imperative step 2"],
  "summary": "one short sentence",
  "confidence": <0-99 integer>
}

Guidance for confidence:
  - 0       : the page has no instructional copy. Return [] and confidence=0.
  - 30-60   : there's instructional copy but it's not clearly relevant to the
              current action the agent is stuck on.
  - 70-99   : there's clear, actionable instructional copy that explains
              what the user should do to make progress.

Strict rules:
  - Return imperative steps in the user's voice ("Click Register first") —
    NOT in your voice ("the page says to click register"). Each step must
    be ≤ 120 chars.
  - Maximum 5 instructions; if the page has more, return the 5 most relevant.
  - If the page is blank / loading / shows nothing readable, return
    {"instructions": [], "summary": "page shows no instructional copy",
     "confidence": 0}.
  - JSON only. No code fences, no commentary, no explanation outside the JSON.`;

function normaliseResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const arr = Array.isArray(raw.instructions) ? raw.instructions : [];
  const instructions = arr
    .map((s) => String(s || '').trim())
    .filter((s) => s.length > 0)
    .slice(0, 5)
    .map((s) => s.slice(0, 120));
  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(99, Math.round(confidence)));
  const summary = String(raw.summary || '').slice(0, 200).trim();
  return { instructions, summary, confidence };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.provider
 * @param {string} opts.screenshotBase64  Base64-encoded image bytes (no data: prefix)
 * @param {string} [opts.mediaType]       'image/jpeg' (default) | 'image/png'
 * @param {string} [opts.stuckContext]    Optional: short string describing
 *                                         what the agent has been trying
 *                                         (e.g. "submitting login with these
 *                                         credentials") — helps the reader
 *                                         pick relevant copy.
 * @param {function} [opts.onLog]
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onRateLimit]
 * @param {string} [opts.extraGuidance]
 * @returns {Promise<{ instructions, summary, confidence } | null>}
 */
async function readInstructions({
  apiKey, model, provider: providerName,
  screenshotBase64, mediaType = 'image/jpeg', stuckContext,
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
  if (!screenshotBase64 || typeof screenshotBase64 !== 'string') {
    return null;
  }

  const provider = getProvider(providerName);
  const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });
  await onLog('info', 'InstructionReader analysing screenshot for on-page guidance…');

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model: routedModel,
      maxTokens: 800,
      system: composeSystemPromptCached(SYSTEM_PROMPT, extraGuidance),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: stuckContext
                ? `The agent is stuck. Context: ${stuckContext.slice(0, 300)}\n\nLook at this screenshot and tell me what the page is instructing the user to do.`
                : 'Look at this screenshot and tell me what the page is instructing the user to do.',
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: screenshotBase64,
              },
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
    await onLog('warn', `InstructionReader call failed: ${err.message}`);
    return null;
  }

  const text =
    resp?.content?.find?.((b) => b?.type === 'text')?.text ||
    resp?.text || resp?.output_text || '';
  let parsed;
  try {
    parsed = parseJsonResponse(text);
  } catch (err) {
    await onLog('warn', `InstructionReader returned unparseable JSON: ${err.message}`);
    return null;
  }
  const result = normaliseResult(parsed);
  if (!result) {
    await onLog('warn', 'InstructionReader output failed schema validation.');
    return null;
  }
  if (result.instructions.length === 0) {
    await onLog('info', `InstructionReader: no actionable instructions on page (confidence ${result.confidence}).`);
  } else {
    await onLog('info', `InstructionReader extracted ${result.instructions.length} instruction(s) (confidence ${result.confidence}).`);
  }
  return result;
}

module.exports = { readInstructions };
