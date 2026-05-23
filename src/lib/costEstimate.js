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
