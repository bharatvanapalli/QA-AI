'use strict';

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');

/**
 * Agent 6 — Supervisor.
 *
 * After 3 Conductor attempts have all failed for a test case, the Supervisor
 * is escalated to. It reads the FULL history (every attempt's action trail,
 * errors, and the Critic's post-mortem) plus the originating requirement
 * text, and decides one of:
 *
 *   A) The test case can pass with better guidance. Produce a `revisedCase`
 *      and a `guidance` paragraph (injected as a system-prompt prefix in
 *      the 4th Conductor attempt).
 *   B) The page revealed missing context (2FA, consent, geolocation, etc.)
 *      that the original requirement didn't capture. Surface it in
 *      `contextNotes` and produce a revised case that accounts for it.
 *   C) The requirement is fundamentally untestable on this page. Set
 *      `giveUp.reason` — the case is marked blocked permanently.
 *
 * Output shape (JSON only, no markdown fences):
 *   {
 *     revisedCase?: { name, steps:[{action,target,value,expected}], assertions },
 *     guidance?: string,           // injected as a 2nd system-prompt block
 *     contextNotes?: string,       // missing context the page revealed
 *     giveUp?: { reason: string }, // exclusive with the above
 *   }
 */

const SYSTEM_PROMPT = `You are a principal SDET being escalated to. Three Conductor attempts
have failed for this test case. Read the full history — every action, every error, every Critic
post-mortem — and decide ONE of:

A) The test case can pass with better guidance.
   Produce \`revisedCase\` (name, steps, assertions) AND a \`guidance\` paragraph explaining
   EXACTLY what the Conductor must do differently: which element to use first, which
   assertion to drop, how to handle the unexpected modal, etc. Use REAL element names/refs
   that appeared in the trails.

B) The page revealed missing context the original requirement didn't have (e.g. "the
   page asks for 2FA which the requirement omitted", "a cookie consent banner blocks
   the form on first load"). Set \`contextNotes\` to describe the missing piece AND
   produce a \`revisedCase\` that accounts for it.

C) The requirement is fundamentally untestable on this page (feature isn't built, URL
   404s, requirement contradicts itself, the agent never reached the right page).
   Set \`giveUp.reason\` to one or two sentences explaining why.

Output rules:
- JSON only. No markdown fences. No preamble.
- Either (revisedCase + guidance + optional contextNotes) OR giveUp — not both.
- \`steps\` MUST be an array of { action, target, value, expected } objects matching
  the original step shape.
- \`assertions\` is a comma-separated string of specific assertions.
- \`guidance\` is short (1-3 sentences). It is prepended to the agent's system prompt.
- Keep everything grounded in what the trails actually showed.`;

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array}  opts.attempts        all attempt histories for this test case
 *                                      [{ attempt, status, error, actionTrail, originalSteps, assertions }]
 * @param {object} opts.originalCase    the TestCase row at first attempt time
 * @param {string} [opts.requirement]   originating requirement text (best-effort)
 * @param {function} [opts.onLog]
 * @returns {Promise<{revisedCase?, guidance?, contextNotes?, giveUp?}>}
 */
async function run({ apiKey, model, attempts, originalCase, requirement = '', onLog = async () => {}, onRateLimit, extraGuidance, provider: providerName } = {}) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  const provider = getProvider(providerName);

  // Compact attempts: each attempt's last 30 actions, full errors, full snippets
  const compactAttempts = (attempts || []).map((a) => ({
    attempt: a.attempt,
    status: a.status,
    error: (a.error || '').slice(0, 800),
    originalSteps: a.originalSteps || [],
    assertions: a.assertions || '',
    actionTrail: (a.actionTrail || []).slice(-30).map((t) => ({
      turn: t.turn,
      tool: t.tool,
      args: t.args,
      ok: !!t.ok,
      error: t.error ? String(t.error).slice(0, 300) : undefined,
      pageSnippet: t.pageSnippet ? String(t.pageSnippet).slice(0, 500) : undefined,
    })),
  }));

  await onLog('info', `Reviewing ${compactAttempts.length} failed attempt(s) for "${originalCase?.name || 'case'}"…`);

  const userMsg = [
    `## originalRequirement (truncated)`,
    String(requirement || '(not available)').slice(0, 4000),
    ``,
    `## originalCase`,
    JSON.stringify({
      name: originalCase?.name,
      type: originalCase?.type,
      module: originalCase?.module,
      assertions: originalCase?.assertions,
      steps: originalCase?.steps,
    }, null, 2),
    ``,
    `## attempts (oldest first)`,
    JSON.stringify(compactAttempts, null, 2),
  ].join('\n');

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model,
      maxTokens: 3500,
      system: composeSystemPrompt(SYSTEM_PROMPT, extraGuidance),
      messages: [{ role: 'user', content: userMsg }],
      onRateLimit,
      responseFormat: 'json',
    });
  } catch (err) {
    await onLog('error', `supervisor call failed: ${err.message}`);
    throw err;
  }

  const text = (resp.content?.[0]?.text || '').trim();
  const parsed = parseJsonResponse(text, { type: 'object' });
  if (!parsed) {
    await onLog('warn', 'Supervisor returned non-JSON; treating as giveUp.');
    return { giveUp: { reason: 'Supervisor returned unparseable JSON.' } };
  }

  if (parsed.giveUp && parsed.giveUp.reason) {
    return { giveUp: { reason: String(parsed.giveUp.reason).slice(0, 1000) } };
  }

  const revisedCase = normaliseCase(parsed.revisedCase);
  if (!revisedCase) {
    await onLog('warn', 'Supervisor produced no revisedCase and no giveUp — treating as giveUp.');
    return { giveUp: { reason: 'Supervisor returned no actionable revision.' } };
  }

  return {
    revisedCase,
    guidance: parsed.guidance ? String(parsed.guidance).slice(0, 1500) : '',
    contextNotes: parsed.contextNotes ? String(parsed.contextNotes).slice(0, 1500) : '',
  };
}

function normaliseCase(rc) {
  if (!rc || typeof rc !== 'object') return null;
  const steps = Array.isArray(rc.steps)
    ? rc.steps.filter((s) => s && typeof s === 'object').map((s) => ({
        action: String(s.action || '').slice(0, 120),
        target: String(s.target || '').slice(0, 200),
        value: s.value != null ? String(s.value).slice(0, 400) : '',
        expected: String(s.expected || '').slice(0, 200),
      }))
    : [];
  return {
    name: rc.name ? String(rc.name).slice(0, 300) : '',
    steps,
    assertions: rc.assertions ? String(rc.assertions).slice(0, 1000) : '',
  };
}

module.exports = { run, SYSTEM_PROMPT };
