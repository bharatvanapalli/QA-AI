'use strict';

/**
 * Agent — RCA Chat.
 *
 * Conversational follow-up on a specific failed RunResult. The user asks
 * questions like "Why did the locator fail?" or "Could this be a race
 * condition?" — Claude responds with context-aware analysis. The full
 * conversation history is persisted on `RunResult.chatHistory` so reloads
 * preserve the thread.
 *
 * Distinct from the one-shot Reporter agent:
 *   - Reporter produces the initial structured RCA (what / why / fix) and
 *     persists it as `rcaWhat / rcaWhy / rcaFix / rcaClass / rcaConfidence`.
 *   - rcaChat is for everything AFTER: clarifying questions, suggestions
 *     from the user, deeper diagnostic asks.
 *
 * Context the agent sees on every turn:
 *   - Test case name + module + type
 *   - Run result status + error + first chunk of trace + network log tail
 *   - Prior structured RCA (what / why / fix) if it exists
 *   - The full chat history so the conversation has memory
 *   - Project-level + case-level user guidance (prepended to the system
 *     prompt via the standard `composeSystemPrompt` helper)
 *
 * The agent does NOT have tools. This is text-only chat.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt, joinGuidance } = require('../../lib/promptCompose');
const { resolveModelForTier } = require('../../lib/modelRouter');

// Phase E5 — cost routing. RCA follow-up chat is question/answer over
// already-analysed context; Haiku-class models keep up easily and the
// chat is high-volume (one call per user message).
const TIER = 'mid';

const SYSTEM_PROMPT = `You are a senior QA engineer helping the user understand and resolve a specific Playwright test failure.

You have access to:
- The failed test case (name, module, type)
- The run result (status, error message, stack trace, network log)
- Any prior root-cause analysis already produced (what / why / suggested fix)
- The full conversation history so far

Your job:
- Answer the user's questions about THIS failure specifically, using the evidence above. Quote relevant lines from the error or trace when you can.
- If the user offers a hypothesis, evaluate it against the evidence. Don't just agree — say whether the evidence supports it.
- If the user proposes a fix, evaluate whether it would address the root cause as you understand it. Say so honestly if you're not sure.
- When suggesting fixes, prefer SPECIFIC remediation (the exact locator, the exact wait, the exact API endpoint) over generic advice.
- Keep replies under ~200 words unless the question genuinely needs more.
- NEVER claim you executed anything or saw something happen — you only know what's in the context.
- If the user is going off-topic (asking about unrelated tests, the framework in general, etc.) gently redirect to the failure at hand.

Output plain text. No markdown fences. Markdown formatting (lists, code blocks, bold) is fine.`;

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {object} opts.context        { testCase, result }
 * @param {Array}  opts.history        Existing chat history: [{ role, content, ts }, ...]
 * @param {string} opts.userMessage    The new user message
 * @param {string} [opts.projectGuidance]
 * @param {string} [opts.caseGuidance]
 * @param {function} [opts.onRateLimit]
 * @returns {Promise<{ reply: string }>}
 */
async function chat({ apiKey, model, context, history, userMessage, projectGuidance, caseGuidance, onRateLimit, provider: providerName }) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  const trimmed = String(userMessage || '').trim();
  if (!trimmed) {
    const err = new Error('Message is empty.');
    err.code = 'EMPTY_MESSAGE';
    err.status = 400;
    throw err;
  }

  const provider = getProvider(providerName);

  // Build the conversation:
  //  1. A single primer user turn with the failure context
  //  2. The prior chat history (alternating user/assistant)
  //  3. The new user message
  const primer = buildPrimer(context);
  const priorTurns = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));

  const messages = [
    { role: 'user', content: primer },
    // Claude expects a first assistant message before the next user — when
    // there's no prior turn we synthesise a brief acknowledgement so the
    // alternation rule holds.
    ...(priorTurns.length === 0
      ? [{ role: 'assistant', content: 'Understood. What would you like to dig into?' }]
      : priorTurns),
    { role: 'user', content: trimmed },
  ];

  const guidance = joinGuidance({ projectGuidance, caseGuidance });
  const system = composeSystemPrompt(SYSTEM_PROMPT, guidance);

  const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });
  const resp = await provider.complete({
    apiKey,
    model: routedModel,
    maxTokens: 800,
    system,
    messages,
    onRateLimit,
  });

  const reply = (resp.content?.[0]?.text || '').trim();
  if (!reply) {
    const err = new Error(`${provider.name} returned an empty reply.`);
    err.code = 'EMPTY_REPLY';
    err.status = 502;
    throw err;
  }
  return { reply };
}

function buildPrimer({ testCase, result }) {
  const lines = [];
  lines.push('I want to discuss a Playwright test failure with you.');
  lines.push('');
  lines.push('## Test case');
  lines.push(`- Name: ${testCase?.name || '—'}`);
  if (testCase?.module) lines.push(`- Module: ${testCase.module}`);
  if (testCase?.type) lines.push(`- Type: ${testCase.type}`);
  lines.push('');
  lines.push('## Run result');
  lines.push(`- Status: ${result?.status || '—'}`);
  if (typeof result?.durationMs === 'number') lines.push(`- Duration: ${result.durationMs}ms`);
  if (result?.error) lines.push(`- Error: ${String(result.error).slice(0, 1500)}`);
  if (result?.trace) lines.push(`- Trace (first 1500 chars):\n${String(result.trace).slice(0, 1500)}`);
  if (Array.isArray(result?.networkLog) && result.networkLog.length) {
    const tail = result.networkLog.slice(-5);
    lines.push(`- Network log (last 5 entries): ${JSON.stringify(tail)}`);
  }
  if (result?.rcaWhat || result?.rcaWhy || result?.rcaFix) {
    lines.push('');
    lines.push('## Prior structured RCA (from the Reporter agent)');
    if (result.rcaWhat) lines.push(`- What: ${result.rcaWhat}`);
    if (result.rcaWhy)  lines.push(`- Why: ${result.rcaWhy}`);
    if (result.rcaFix)  lines.push(`- Suggested fix: ${result.rcaFix}`);
    if (result.rcaClass) lines.push(`- Classification: ${result.rcaClass}`);
    if (typeof result.rcaConfidence === 'number') lines.push(`- Confidence: ${result.rcaConfidence}%`);
  }
  return lines.join('\n');
}

module.exports = { chat, SYSTEM_PROMPT };
