'use strict';

/**
 * Provider factory. Resolves an LLM provider implementation from a name.
 *
 *   const provider = getProvider(project.aiProvider);
 *   const resp = await provider.complete({
 *     apiKey, model, system, messages, tools, maxTokens, signal, onRateLimit,
 *   });
 *
 * Canonical request shape: Anthropic-style (`messages`, `tools`, `system`).
 * Canonical response shape: Anthropic-style — `{ content, stop_reason, usage }`.
 *
 * The Gemini provider translates both directions internally so agent code
 * stays provider-agnostic and unchanged.
 *
 * Wrapping layer (E10): every complete() call passes through
 *   1. circuitBreaker — fail-fast when an upstream is in a 5xx storm
 *   2. budget         — block + record token usage when the user has
 *                       hit their daily ceiling (only when ALS context
 *                       carries a userId; non-request callers skip it)
 * Wrapper logic lives here so the two underlying provider files stay
 * single-purpose and the agents call complete() without knowing the
 * protective infrastructure exists.
 */

const anthropic = require('./providers/anthropic');
const gemini = require('./providers/gemini');
const copilot = require('./providers/copilot');
const breaker = require('./circuitBreaker');
const userContext = require('./userContext');
const budget = require('../services/budget');

const RAW_PROVIDERS = {
  claude: anthropic,
  gemini,
  copilot,
};

const VALID_PROVIDERS = Object.freeze(['claude', 'gemini', 'copilot']);

/**
 * Wrap a provider so .complete() runs through the breaker + budget
 * layers. The provider implementation itself stays oblivious — it just
 * sees the regular options bag and returns the canonical response.
 */
function wrap(impl, providerName) {
  // Shared breaker+budget envelope. `call` performs the actual provider
  // request (streaming or not) and returns the canonical response; this
  // function applies the identical protection around it for both paths.
  async function guarded(call) {
    const userId = userContext.getUserId();

    // 1. Breaker pre-flight. Throws BREAKER_OPEN if the provider is
    //    in cool-down. Returns a token when in half_open so we can
    //    release the probe slot on completion.
    const probeToken = breaker.check(providerName);

    // 2. Budget pre-flight. Only enforced when we have a request-bound
    //    userId (scripts/jobs without ALS context bypass — they're
    //    operator-initiated, not end-user runs).
    if (userId) await budget.assertWithinLimit(userId);

    try {
      const resp = await call();
      breaker.recordSuccess(providerName, probeToken);
      // Record usage AFTER a successful call. On error we don't bill —
      // the user shouldn't be charged for an upstream 5xx.
      if (userId && resp?.usage) {
        await budget.recordUsage(userId, providerName, resp.usage).catch((err) => {
          // Budget bookkeeping must never break a successful AI call.
          console.warn('[budget] record failed:', err.message);
        });
      }
      return resp;
    } catch (err) {
      breaker.recordFailure(providerName, err, probeToken);
      throw err;
    }
  }

  const wrapped = {
    name: impl.name,
    async complete(opts) {
      return guarded(() => impl.complete(opts));
    },
  };

  // Streaming path (Claude). Routed through the SAME breaker + budget
  // envelope as complete() — the Architect previously built a raw client
  // inline and bypassed both. Streaming progress events still flow via the
  // caller's onText callback (the provider wires it to stream.on('text')).
  if (typeof impl.completeStream === 'function') {
    wrapped.completeStream = async function completeStream(opts) {
      return guarded(() => impl.completeStream(opts));
    };
  }

  return wrapped;
}

const PROVIDERS = {
  claude: wrap(anthropic, 'claude'),
  gemini: wrap(gemini, 'gemini'),
  copilot: wrap(copilot, 'copilot'),
};

function getProvider(name) {
  const key = String(name || 'claude').toLowerCase();
  const p = PROVIDERS[key];
  if (!p) {
    const err = new Error(`Unknown AI provider: ${name}. Valid: ${VALID_PROVIDERS.join(', ')}.`);
    err.code = 'UNKNOWN_PROVIDER';
    err.status = 400;
    throw err;
  }
  return p;
}

function isValidProvider(name) {
  return VALID_PROVIDERS.includes(String(name || '').toLowerCase());
}

/**
 * Raw provider escape-hatch. Bypasses breaker + budget. Use only for:
 *   - Connection-test routes (Settings → Test API key) — single-shot,
 *     should still surface a real upstream failure even when the
 *     breaker is open so the user can diagnose.
 *   - Test scaffolding.
 */
function getRawProvider(name) {
  const key = String(name || 'claude').toLowerCase();
  const p = RAW_PROVIDERS[key];
  if (!p) {
    const err = new Error(`Unknown AI provider: ${name}. Valid: ${VALID_PROVIDERS.join(', ')}.`);
    err.code = 'UNKNOWN_PROVIDER';
    err.status = 400;
    throw err;
  }
  return p;
}

module.exports = { getProvider, getRawProvider, isValidProvider, VALID_PROVIDERS };
