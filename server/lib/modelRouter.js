'use strict';

/**
 * Model cost routing (Phase E5 / BUILD_PLAN_V2).
 *
 * Every QAAI agent declares its own tier — `flagship` or `mid`. This file
 * is the single source of truth for the tier-to-model mapping per provider.
 *
 *   const { resolveModelForTier, TIERS, MID_TIER_MODELS } = require('./modelRouter');
 *
 *   // Inside an agent's run():
 *   const TIER = 'mid';
 *   const routedModel = resolveModelForTier({ provider, requestedModel: model, tier: TIER });
 *
 * Policy (decided 2026-05-25):
 *   - Mid-tier agents ALWAYS route to the mid model for the provider,
 *     regardless of what the user picked in Settings. Maximum cost savings
 *     for BYOK users — Reporter/Analyst/RCA-chat etc. don't need flagship
 *     intelligence and routing them to Haiku-class models drops the bill
 *     on those calls by ~60-80%.
 *   - Flagship-tier agents respect the user's Settings choice. If they
 *     picked Opus, flagship agents get Opus. If they picked Sonnet, they
 *     get Sonnet. Whatever they configured at the integration level wins.
 *
 * Vision is flagship-only: instructionReader is the exception — it's a
 * tiny vision task and Haiku 4.5 handles screenshots well — so it's
 * declared mid. VisualCritic stays flagship because semantic diffing
 * across two images is a harder task.
 *
 * To add a new tier later (e.g. `cheap` for Haiku-3.5 or Gemini Nano):
 *   1. Add the model IDs under that key in MID_TIER_MODELS-style block.
 *   2. Add the tier to TIERS.
 *   3. Declare it as the TIER constant in the relevant agent file.
 *
 * Per-project override is intentionally NOT implemented in v1. If an
 * operator wants Opus for the Critic, they pick it in Settings — that
 * already covers all flagship-tier agents. Mid-tier is the cost-floor;
 * if you want to override it, the right surface is a future Project-
 * level toggle, not this resolver.
 */

const TIERS = Object.freeze(['flagship', 'mid']);

// Mid-tier model IDs by provider. These are the routed-to defaults for
// any agent declaring `TIER = 'mid'`. Update these in lockstep when newer
// fast/cheap models ship.
const MID_TIER_MODELS = Object.freeze({
  claude:  'claude-haiku-4-5-20251001',
  gemini:  'gemini-2.5-flash',
  copilot: 'copilot-gpt-4o',
});

// Flagship fallbacks, used only when the caller didn't supply a
// `requestedModel` (defensive — every call site SHOULD supply one).
const FLAGSHIP_FALLBACKS = Object.freeze({
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-pro',
  copilot: 'copilot-gpt-4o',
});

// Strong-tier model IDs by provider. Used by THOROUGH-mode high-stakes
// agents (Supervisor, Verifier) to bump to the provider's most capable
// model even when the main loop runs a fast model for speed. This is the
// "thorough buys you a stronger second opinion" lever: the Conductor can
// run gemini-2.5-flash (fast, per the operator's Settings choice) while the
// Verifier that double-checks PASS verdicts runs gemini-2.5-pro. Same API
// key calls every model — bumping costs more tokens, not a new credential.
const STRONG_MODELS = Object.freeze({
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-pro',
  copilot: 'copilot-gpt-4o',
});

// The set of mid/fast model IDs we treat as "needs a bump" for strong-tier.
const MID_MODEL_VALUES = Object.freeze(new Set(Object.values(MID_TIER_MODELS)));

function normaliseProvider(name) {
  const s = String(name || '').toLowerCase();
  if (s === 'claude' || s === 'gemini' || s === 'copilot') return s;
  return 'claude';
}

/**
 * @param {object} opts
 * @param {string} opts.provider        'claude' | 'gemini'
 * @param {string} [opts.requestedModel] The model the operator picked in
 *                                        Settings (flows from resolveAiCredentials).
 * @param {string} [opts.tier]           'flagship' (default) | 'mid'
 * @returns {string} The model ID the agent should actually call.
 */
function resolveModelForTier({ provider, requestedModel, tier } = {}) {
  const p = normaliseProvider(provider);
  const t = TIERS.includes(tier) ? tier : 'flagship';

  if (t === 'mid') {
    return MID_TIER_MODELS[p];
  }
  // flagship: respect the operator's chosen model. Fall back to the
  // provider-default flagship only when the caller forgot to pass one.
  return requestedModel || FLAGSHIP_FALLBACKS[p];
}

/**
 * Resolve the STRONGEST appropriate model for a high-stakes thorough-mode
 * agent. If the operator's chosen model is a mid/fast model (Haiku, Flash —
 * e.g. they picked Flash for Conductor speed), bump to the provider's strong
 * model so the verdict-critical second opinion isn't made on the weak model.
 * If they already picked a flagship model (Sonnet/Opus/Pro), respect it.
 *
 * @param {object} opts
 * @param {string} opts.provider          'claude' | 'gemini'
 * @param {string} [opts.requestedModel]  The operator's chosen model.
 * @returns {string} The model ID the thorough-mode agent should call.
 */
function resolveStrongModel({ provider, requestedModel } = {}) {
  const p = normaliseProvider(provider);
  const m = String(requestedModel || '').trim();
  if (!m) return STRONG_MODELS[p];
  // Operator picked a mid/fast model → bump to strong for this high-stakes call.
  if (MID_MODEL_VALUES.has(m) || /haiku|flash/i.test(m)) return STRONG_MODELS[p];
  // Already a flagship-class model (sonnet/opus/pro) → respect their choice.
  return m;
}

module.exports = {
  resolveModelForTier,
  resolveStrongModel,
  TIERS,
  MID_TIER_MODELS,
  FLAGSHIP_FALLBACKS,
  STRONG_MODELS,
};
