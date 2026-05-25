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
});

// Flagship fallbacks, used only when the caller didn't supply a
// `requestedModel` (defensive — every call site SHOULD supply one).
const FLAGSHIP_FALLBACKS = Object.freeze({
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-pro',
});

function normaliseProvider(name) {
  const s = String(name || '').toLowerCase();
  if (s === 'claude' || s === 'gemini') return s;
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

module.exports = {
  resolveModelForTier,
  TIERS,
  MID_TIER_MODELS,
  FLAGSHIP_FALLBACKS,
};
