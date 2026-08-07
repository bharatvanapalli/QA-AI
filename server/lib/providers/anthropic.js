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

function boundedClientTimeout(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.min(600_000, Math.trunc(numeric)));
}

function boundedClientRetries(value, fallback = 1) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.max(0, Math.min(2, Math.trunc(numeric)));
}

function clientOptions(apiKey, timeoutMs, maxRetries, defaults) {
  return {
    apiKey,
    timeout: boundedClientTimeout(timeoutMs, defaults.timeout),
    maxRetries: boundedClientRetries(maxRetries, defaults.maxRetries),
  };
}

async function complete({ apiKey, model, system, messages, tools, maxTokens, signal, onRateLimit, responseFormat, cacheTools, temperature, timeoutMs, maxRetries }) {
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
  // Raised 180 s → 360 s. The Architect's expanded prompt + adaptive step
  // counts can legitimately push generation past the 3-minute mark on dense
  // source docs (24 K-char BRD + 16 K maxTokens of strict JSON streams at
  // ~50 tok/sec on Sonnet). 360 s covers the slowest realistic generation;
  // the request is still bounded so a truly stuck call won't hang forever.
  const client = new Anthropic(clientOptions(apiKey, timeoutMs, maxRetries, {
    timeout: 360_000,
    maxRetries: 1,
  }));
  const params = {
    model: model || 'claude-sonnet-4-6',
    max_tokens: maxTokens || 1500,
    messages,
  };
  // Optional caller-pinned sampling temperature. Default (unset) leaves the
  // Anthropic API default (1.0). Authoring stages (Architect) pin this LOW
  // (~0.3) to remove run-to-run scenario-count variance; everywhere else it
  // stays unset. Clamp to the valid [0,1] range Anthropic accepts.
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    params.temperature = Math.max(0, Math.min(1, temperature));
  }
  // Prompt caching support — callers can pass `system` as either:
  //   (a) a plain string (legacy path; no caching)
  //   (b) an array of content blocks: `[{ type: 'text', text: '...', cache_control: { type: 'ephemeral' }}, ...]`
  // Anthropic charges 10% of input price on cache reads (90% off the cached
  // portion) and the cache lives 5 minutes. The Conductor's static prefix
  // (SYSTEM_PROMPT_LOOP + KB block + test creds) is ~18kB and identical
  // across every turn of a case — caching it cuts input tokens dramatically.
  if (system) params.system = system;
  if (Array.isArray(tools) && tools.length) {
    if (cacheTools) {
      // Tool definitions are ~3-5kB and constant across the whole run. Tag
      // the LAST tool with cache_control so everything up to and including
      // tools is cached together with the system prefix.
      const cached = tools.map((t, i) => (i === tools.length - 1
        ? { ...t, cache_control: { type: 'ephemeral' } }
        : t));
      params.tools = cached;
    } else {
      params.tools = tools;
    }
  }

  return await callWithRateLimit(
    client.messages.create(params, { signal }),
    onRateLimit,
  );
}

/**
 * Streaming completion. Same canonical option bag as complete(), plus an
 * `onText(delta, snapshot)` callback for per-delta progress. Resolves to the
 * canonical { content, stop_reason, usage } once the stream finishes.
 *
 * Split out so llmProvider's wrap() can route the streaming path through the
 * SAME breaker + budget protection as the non-streaming path — the Architect
 * previously built a raw Anthropic client inline and bypassed both. The
 * provider stays oblivious to that infrastructure; it just streams.
 */
async function completeStream({ apiKey, model, system, messages, tools, maxTokens, signal, temperature, onText, cacheTools, timeoutMs, maxRetries }) {
  if (!apiKey) {
    const err = new Error('Claude API key missing. Configure it in Settings → Claude API.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  // Longer SDK timeout than complete(): a large 48K-token authoring stream at
  // ~90 tok/s can run ~530s. The streaming caller (Architect) sets max_tokens.
  const client = new Anthropic(clientOptions(apiKey, timeoutMs, maxRetries, {
    timeout: 600_000,
    maxRetries: 1,
  }));
  const params = {
    model: model || 'claude-sonnet-4-6',
    max_tokens: maxTokens || 1500,
    messages,
  };
  if (system) params.system = system;
  if (Array.isArray(tools) && tools.length) {
    if (cacheTools) {
      params.tools = tools.map((t, i) => (i === tools.length - 1
        ? { ...t, cache_control: { type: 'ephemeral' } }
        : t));
    } else {
      params.tools = tools;
    }
  }
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    params.temperature = Math.max(0, Math.min(1, temperature));
  }

  const stream = client.messages.stream(params, { signal });
  if (typeof onText === 'function') {
    stream.on('text', (delta, snapshot) => {
      try { onText(delta, snapshot); } catch (_) { /* progress must never break the stream */ }
    });
  }
  // finalMessage() throws on cancel/timeout/error like create() does, so the
  // breaker/budget wrapper sees real failures and successes alike.
  return await stream.finalMessage();
}

module.exports = {
  complete,
  completeStream,
  name: 'claude',
  __test__: {
    streamClientOptions: (apiKey, options = {}) => clientOptions(
      apiKey,
      options.timeoutMs,
      options.maxRetries,
      { timeout: 600_000, maxRetries: 1 },
    ),
  },
};
