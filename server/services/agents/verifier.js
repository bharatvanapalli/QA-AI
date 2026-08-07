'use strict';

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPromptCached } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');

/**
 * Agent — Verdict Verifier (THOROUGH mode only).
 *
 * Runs as a pipeline-level SECOND OPINION on cases the mechanical verdict
 * ladder marked PASS. `computeVerdict` already proves "every declared
 * assertion matched" — that is mechanical and authoritative and the Verifier
 * does NOT re-litigate it. What nothing else checks is whether those declared
 * assertions were SUFFICIENT to prove the requirement in the first place: a
 * case can pass on peripheral checks (page title present, a button exists)
 * while the actual required outcome (order confirmed, funds moved, access
 * granted, login rejected) was never asserted. That is a FALSE PASS — the most
 * dangerous error for a release gate, because it ships a green verdict over an
 * unproven behaviour.
 *
 * The Verifier reads {requirement, the case, the MUST assertions that passed}
 * and judges sufficiency ONLY. It NEVER auto-fails — an insufficient pass is
 * escalated to needs_human so a person decides, and a `suggestedAssertion` is
 * recorded to strengthen the next generation. It fails SAFE: any error or
 * unparseable response leaves the mechanical PASS untouched (a green case is
 * never punished for an LLM hiccup).
 *
 * Output (JSON only, no markdown fences):
 *   { "sufficient": true }
 *   { "sufficient": false, "concern": "<the unproven core outcome>",
 *     "suggestedAssertion": "<a concrete assertion that WOULD prove it>" }
 */

const SYSTEM_PROMPT = `You are a release-gate auditor reviewing a test case that PASSED. Every assertion
it declared was already mechanically verified to be TRUE on the live page — do NOT question whether
they matched; assume they did. Your ONLY job is to judge SUFFICIENCY: do the assertions that passed
actually PROVE the requirement was met, or did the case pass on peripheral checks while the core
required outcome was never asserted?

Examples of INSUFFICIENT passes (false passes):
- Requirement: "user completes checkout and sees an order confirmation with an order number." The
  passed assertions only checked the page title and that a "Place Order" button exists. The
  confirmation and order number were never asserted → INSUFFICIENT.
- Requirement: "invalid login shows an error AND the user is NOT logged in." The passed assertions
  only checked that an error message appeared. Whether the user stayed logged out was never
  asserted → INSUFFICIENT.

A SUFFICIENT pass: the assertions that passed, taken together, establish the requirement's core
observable outcome.

BE CONSERVATIVE. Default to sufficient. Only flag insufficient when there is a SPECIFIC, NAMED
required outcome in the requirement that NONE of the passed assertions establishes. Do NOT demand
assertions about things outside the requirement's scope. Do NOT flag a pass merely because more
assertions are theoretically possible — only when a CORE outcome is genuinely unproven. A false
alarm wastes a human's time and erodes trust in the gate, so when in doubt, return sufficient.

Output JSON only. No markdown fences. No preamble.
- If sufficient:   {"sufficient": true}
- If insufficient: {"sufficient": false, "concern": "<one or two sentences naming the unproven core outcome>", "suggestedAssertion": "<one concrete assertion that would prove it>"}`;

/**
 * @param {object}   opts
 * @param {string}   opts.apiKey
 * @param {string}   opts.model            Pre-resolved (thorough → strong model).
 * @param {string}   [opts.provider]       'claude' | 'gemini'
 * @param {string}   [opts.requirement]    Originating requirement text (best-effort).
 * @param {object}   opts.testCase         { name, steps, assertions }
 * @param {Array}    [opts.passedAssertions] [{ type, payload, note, outcome }]
 * @param {function} [opts.onLog]
 * @param {function} [opts.onRateLimit]
 * @param {string}   [opts.extraGuidance]
 * @returns {Promise<{ sufficient: boolean, concern?: string, suggestedAssertion?: string }>}
 */
async function run({
  apiKey, model, provider: providerName, requirement = '', testCase,
  passedAssertions = [], onLog = async () => {}, onRateLimit, extraGuidance,
} = {}) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  const provider = getProvider(providerName);

  const userMsg = [
    '## Requirement (the WHAT this case must prove)',
    String(requirement || '(not available)').slice(0, 4000),
    '',
    '## Case under review',
    JSON.stringify({
      name: testCase?.name,
      steps: testCase?.steps,
      assertions: testCase?.assertions,
    }, null, 2).slice(0, 3000),
    '',
    '## MUST assertions that PASSED (mechanically verified true on the live page)',
    JSON.stringify(passedAssertions, null, 2).slice(0, 3000),
    '',
    'Judge SUFFICIENCY per your instructions. JSON only.',
  ].join('\n');

  await onLog('info', `Auditing pass sufficiency for "${testCase?.name || 'case'}"…`);

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model,
      maxTokens: 700,
      system: composeSystemPromptCached(SYSTEM_PROMPT, extraGuidance),
      messages: [{ role: 'user', content: userMsg }],
      onRateLimit,
      responseFormat: 'json',
    });
  } catch (err) {
    await onLog('error', `verifier call failed: ${err.message}`);
    throw err;
  }

  const text = (resp.content?.[0]?.text || '').trim();
  const parsed = parseJsonResponse(text, { type: 'object' });
  // Fail SAFE: no parseable verdict → leave the mechanical PASS as-is. We do
  // NOT escalate on a parse error; a green case is never punished for an LLM
  // hiccup. The mechanical ladder already passed it on real evidence.
  if (!parsed || typeof parsed.sufficient === 'undefined') {
    await onLog('warn', 'Verifier returned no parseable verdict — treating the pass as sufficient.');
    return { sufficient: true };
  }
  if (parsed.sufficient === false) {
    return {
      sufficient: false,
      concern: parsed.concern
        ? String(parsed.concern).slice(0, 600)
        : "Passed assertions do not establish the requirement's core outcome.",
      suggestedAssertion: parsed.suggestedAssertion ? String(parsed.suggestedAssertion).slice(0, 400) : '',
    };
  }
  return { sufficient: true };
}

module.exports = { run, SYSTEM_PROMPT };
