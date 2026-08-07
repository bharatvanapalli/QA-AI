// Token + cost estimation for Claude calls.
//
// The Architect prompt is fixed (~1500 tokens), the user payload is the
// concatenated requirements text. We use the ≈4 chars/token rule that
// Anthropic publishes for English prose — close enough for a pre-flight
// estimate to set user expectations.
//
// Pricing reflects Claude Sonnet 4.6 list price as of late 2025:
//   $3 / 1M input tokens
//   $15 / 1M output tokens
// Output budget is the architect's `max_tokens` setting (16_000 — see
// server/services/agents/architect.js). Treated as the worst-case cost.

const CHARS_PER_TOKEN = 4;
const ARCHITECT_SYSTEM_PROMPT_TOKENS = 1500;
const ARCHITECT_MAX_OUTPUT_TOKENS = 16_000;

const INPUT_PRICE_PER_M = 3;    // USD per million input tokens
const OUTPUT_PRICE_PER_M = 15;  // USD per million output tokens

/**
 * Estimate the input-side token cost of running the Architect on the given
 * requirement texts.
 *
 * @param {string[]} texts  Each requirement's full content.
 * @returns {{ inputTokens, outputTokensMax, costUsd, costDisplay, secondsEstimate }}
 */
export function estimateArchitectCost(texts) {
  const userChars = texts.reduce((a, t) => a + (t?.length || 0), 0);
  const userTokens = Math.ceil(userChars / CHARS_PER_TOKEN);
  const inputTokens = userTokens + ARCHITECT_SYSTEM_PROMPT_TOKENS;
  const outputTokensMax = ARCHITECT_MAX_OUTPUT_TOKENS;

  const inputCost  = (inputTokens / 1_000_000) * INPUT_PRICE_PER_M;
  const outputCost = (outputTokensMax / 1_000_000) * OUTPUT_PRICE_PER_M;
  const costUsd = inputCost + outputCost;

  // Duration: Claude Sonnet 4.6 on 16k output budget runs ≈ 30-60 s depending
  // on input size. Linear approximation: 20 s base + 1 s per 2k input tokens.
  const secondsEstimate = Math.min(120, Math.round(20 + inputTokens / 2_000));

  return {
    inputTokens,
    outputTokensMax,
    costUsd,
    costDisplay: formatUsd(costUsd),
    secondsEstimate,
  };
}

function formatUsd(value) {
  if (value < 0.01) return '< $0.01';
  if (value < 1)    return `$${value.toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Compact "Xk" / "Xm" formatter for token counts.
 */
export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Estimate the input + output token cost of executing a Conductor run.
 *
 * Math is conservative — assumes the bulk of cost is per-case turn loops
 * dominated by the cached static system prefix + per-turn snapshot diff.
 * Cached input is priced at 10% of standard; the static prefix is ~18kB
 * (~4500 tokens) and identical across every turn after the first one.
 *
 * Per-turn cost components:
 *   - First call per case: 4500 input tokens (cache WRITE: 1.25x mult)
 *   - Subsequent calls:    4500 input cached (0.10x mult) + 1500 dynamic
 *   - Tool result back:    ~1000 tokens (trimmed snapshot)
 *   - Assistant output:    ~600 tokens (reasoning + tool calls)
 *
 * @param {object} opts
 * @param {number} opts.caseCount       cases the run will attempt
 * @param {'fast'|'thorough'} opts.execMode
 * @returns {{ inputTokens, outputTokens, costUsd, costDisplay, secondsEstimate }}
 */
export function estimateConductorRunCost({ caseCount, execMode = 'fast' }) {
  const safe = Math.max(0, Math.floor(Number(caseCount) || 0));
  if (safe === 0) {
    return {
      inputTokens: 0, outputTokens: 0, costUsd: 0,
      costDisplay: '$0.00', secondsEstimate: 0,
      perCaseTokens: 0,
    };
  }

  const profile = execMode === 'thorough'
    ? { turns: 14, attempts: 2, supervisor: true,  criticEvery: 5 }
    : { turns: 8,  attempts: 1, supervisor: false, criticEvery: 0 };
  // ↑ "turns" is the AVERAGE active turn count, not the cap. Most cases
  // finish in 5–10 turns even when the cap is 12 or 22.

  // Static prefix that gets cached after the first call within a case.
  const STATIC_PREFIX_TOKENS = 4500;
  const DYNAMIC_PER_TURN     = 1500; // operator guidance + dynamic suffix
  const TOOL_RESULT_TOKENS   = 1100; // trimmed snapshot returning to Claude
  const ASSISTANT_OUTPUT     = 600;  // per turn

  const CACHE_WRITE_MULT = 1.25;
  const CACHE_READ_MULT  = 0.10;

  // Per-case input:
  const firstCallInput = STATIC_PREFIX_TOKENS * CACHE_WRITE_MULT + DYNAMIC_PER_TURN;
  const laterCallInput = STATIC_PREFIX_TOKENS * CACHE_READ_MULT + DYNAMIC_PER_TURN + TOOL_RESULT_TOKENS;
  const perCaseInputTokens = firstCallInput + (profile.turns - 1) * laterCallInput;
  const perCaseOutputTokens = profile.turns * ASSISTANT_OUTPUT;

  // Multiplier for retries — assumes worst case (every case fails and re-runs)
  // dampened by 0.6 to reflect that only failing cases re-run.
  const retryMultiplier = 1 + (profile.attempts - 1) * 0.6;

  // Supervisor pass: one flagship call per failing case + one extra conductor wave.
  // Approximate as 30% of perCaseInput * caseCount when enabled.
  const supervisorOverhead = profile.supervisor
    ? Math.round(perCaseInputTokens * 0.30) * safe
    : 0;

  // Inline Critic — flagship calls; Thorough fires every-N turns.
  const inlineCriticTokens = profile.criticEvery > 0
    ? Math.round(profile.turns / profile.criticEvery) * 2500 * safe
    : 0;

  const inputTokens = Math.round(perCaseInputTokens * safe * retryMultiplier + supervisorOverhead + inlineCriticTokens);
  const outputTokens = Math.round(perCaseOutputTokens * safe * retryMultiplier);

  const inputCost  = (inputTokens / 1_000_000) * INPUT_PRICE_PER_M;
  const outputCost = (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_M;
  const costUsd = inputCost + outputCost;

  // ~25s per case average wall-clock — dominated by MCP browser navigations,
  // not LLM latency. Thorough adds the supervisor finalise pass.
  const secondsEstimate = Math.round(safe * 25 * (profile.supervisor ? 1.4 : 1));

  return {
    inputTokens,
    outputTokens,
    costUsd,
    costDisplay: formatUsd(costUsd),
    secondsEstimate,
    perCaseTokens: Math.round((inputTokens + outputTokens) / safe),
  };
}
