'use strict';

/**
 * Helpers for extracting and broadcasting Anthropic rate-limit info from
 * the `anthropic-ratelimit-*` response headers.
 *
 * Anthropic returns six headers on every messages.create() response:
 *   - anthropic-ratelimit-tokens-remaining
 *   - anthropic-ratelimit-tokens-limit
 *   - anthropic-ratelimit-tokens-reset       (ISO timestamp)
 *   - anthropic-ratelimit-requests-remaining
 *   - anthropic-ratelimit-requests-limit
 *   - anthropic-ratelimit-requests-reset     (ISO timestamp)
 *
 * Headers can be parsed from either:
 *   - a fetch Response (response.headers.get('…'))         — SDK v0.30+ via .withResponse()
 *   - a plain object   ({ 'anthropic-ratelimit-…': '12' })  — tests / mocks
 *
 * The SDK exposes `await client.messages.create({...}).withResponse()` which
 * returns `{ data, response }`. Call this helper with the `response` half.
 */

function readHeader(headers, name) {
  if (!headers) return null;
  // Fetch Response.headers (has .get())
  if (typeof headers.get === 'function') return headers.get(name);
  // Plain object — Anthropic SDK normalises to lower-case keys
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function asInt(v) {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Returns `{ tokens: {remaining,limit,resetAt}, requests: {remaining,limit,resetAt} }`
 * or `null` if no rate-limit headers were present (e.g. mocked test response).
 */
function extractRateLimitInfo(headers) {
  const tokensRemaining = asInt(readHeader(headers, 'anthropic-ratelimit-tokens-remaining'));
  const tokensLimit     = asInt(readHeader(headers, 'anthropic-ratelimit-tokens-limit'));
  const tokensReset     =      readHeader(headers, 'anthropic-ratelimit-tokens-reset');
  const requestsRemaining = asInt(readHeader(headers, 'anthropic-ratelimit-requests-remaining'));
  const requestsLimit     = asInt(readHeader(headers, 'anthropic-ratelimit-requests-limit'));
  const requestsReset     =      readHeader(headers, 'anthropic-ratelimit-requests-reset');

  // Bail if no signal at all — don't broadcast meaningless events.
  if (tokensRemaining == null && tokensLimit == null
   && requestsRemaining == null && requestsLimit == null) {
    return null;
  }
  return {
    tokens:   { remaining: tokensRemaining,   limit: tokensLimit,   resetAt: tokensReset },
    requests: { remaining: requestsRemaining, limit: requestsLimit, resetAt: requestsReset },
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Convenience: wraps a `client.messages.create(...)` call with
 * `.withResponse()`, extracts rate-limit info, fires the optional callback
 * with it, and returns the original data so callers don't need to refactor
 * their existing usage.
 *
 *   const data = await callWithRateLimit(
 *     client.messages.create(params),
 *     onRateLimit,
 *   );
 *
 * The first argument is the in-flight promise from `messages.create()`.
 * SDK v0.30+ attaches `.withResponse()` to that promise.
 */
async function callWithRateLimit(messagesCreatePromise, onRateLimit) {
  // Some SDK versions / mocks won't expose .withResponse() — fall back to
  // the bare promise so tests don't have to mock the wrapper.
  if (typeof messagesCreatePromise.withResponse !== 'function') {
    return await messagesCreatePromise;
  }
  const { data, response } = await messagesCreatePromise.withResponse();
  if (typeof onRateLimit === 'function') {
    try {
      const info = extractRateLimitInfo(response?.headers);
      if (info) onRateLimit(info);
    } catch (_) {
      // Never let header parsing break the agent call. Best-effort metric.
    }
  }
  return data;
}

module.exports = { extractRateLimitInfo, callWithRateLimit };
