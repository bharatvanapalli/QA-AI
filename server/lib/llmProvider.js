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
 */

const anthropic = require('./providers/anthropic');
const gemini = require('./providers/gemini');

const PROVIDERS = {
  claude: anthropic,
  gemini,
};

const VALID_PROVIDERS = Object.freeze(['claude', 'gemini']);

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

module.exports = { getProvider, isValidProvider, VALID_PROVIDERS };
