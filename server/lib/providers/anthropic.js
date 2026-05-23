'use strict';

/**
 * Anthropic provider. Thin wrapper around @anthropic-ai/sdk that exposes the
 * canonical provider interface used by all 7 agent services.
 *
 * Canonical interface (see server/lib/llmProvider.js):
 *   provider.complete({ apiKey, model, system, messages, tools, maxTokens, signal, onRateLimit })
 *     -> { content, stop_reason, usage }
 *
 * Because Anthropic's response shape IS the canonical shape, this provider
 * passes through almost everything verbatim. Rate-limit headers are extracted
 * by callWithRateLimit and surfaced via onRateLimit so the UI chip stays live.
 */

const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const { callWithRateLimit } = require('../anthropicHeaders');

async function complete({ apiKey, model, system, messages, tools, maxTokens, signal, onRateLimit, responseFormat }) {
  if (!apiKey) {
    const err = new Error('Claude API key missing. Configure it in Settings → Claude API.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  // Claude follows the "Output ONLY JSON" prompt instruction reliably enough
  // that no API-level enforcement is needed. The parameter is accepted so
  // callers can opt into JSON mode uniformly without branching on provider.
  void responseFormat;
  const client = new Anthropic({ apiKey, timeout: 180_000, maxRetries: 1 });
  const params = {
    model: model || 'claude-sonnet-4-6',
    max_tokens: maxTokens || 1500,
    messages,
  };
  if (system) params.system = system;
  if (Array.isArray(tools) && tools.length) params.tools = tools;

  return await callWithRateLimit(
    client.messages.create(params, { signal }),
    onRateLimit,
  );
}

module.exports = { complete, name: 'claude' };
