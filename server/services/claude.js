'use strict';

/**
 * Real Anthropic API client.
 * - validateApiKey: lists models (auth check), then makes a 1-token
 *   messages.create call (generation quota check) — same two-step
 *   pattern as the Gemini validation.
 * - Model listing succeeds for ALL valid keys regardless of credit
 *   balance. Only an actual generation call reveals workspace limits.
 */

const KEY_RE = /^sk-ant-[a-zA-Z0-9_-]{20,}$/;

const DEFAULT_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5',
];

// Cheapest/fastest model for the generation probe — Haiku uses minimal
// tokens and won't burn meaningful credit on the validation call.
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

function looksLikeKey(apiKey) {
  return typeof apiKey === 'string' && KEY_RE.test(apiKey.trim());
}

/**
 * Probe whether the key can actually call messages.create right now.
 * Returns { canGenerate: bool|null, isUsageCap: bool }.
 *
 * - canGenerate: true  → generation worked
 * - canGenerate: false → blocked by rate limit or workspace usage cap
 * - canGenerate: null  → probe timed out or inconclusive (don't block)
 * - isUsageCap: true   → Anthropic confirmed workspace limit reached
 *                        (has a "regain access" reset date in the message)
 */
async function probeGenerate(apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });

    if (resp.ok) return { canGenerate: true, isUsageCap: false };

    const body = await resp.text().catch(() => '');

    if (resp.status === 429) {
      // Standard rate limit — transient, not a workspace cap.
      return { canGenerate: false, isUsageCap: false };
    }

    if (resp.status === 400) {
      // Workspace usage cap: "You have reached your specified workspace
      // API usage limits. You will regain access on …"
      const isUsageCap = /workspace.*usage.*limit|you will regain access|credit balance/i.test(body);
      return { canGenerate: false, isUsageCap };
    }

    // 401/403 shouldn't occur here (listing passed); 529 = overloaded → inconclusive.
    return { canGenerate: null, isUsageCap: false };
  } catch {
    return { canGenerate: null, isUsageCap: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function validateApiKey(apiKey) {
  if (!looksLikeKey(apiKey)) {
    return {
      valid: false,
      code: 'INVALID_FORMAT',
      message: 'Key must start with "sk-ant-" and be at least 27 characters.',
    };
  }

  // Step 1: list models (authentication check).
  // This endpoint succeeds for all valid keys regardless of credit balance.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let models = DEFAULT_MODELS;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    });

    if (resp.status === 401) {
      return { valid: false, code: 'AUTH_FAILED', message: 'Anthropic rejected this API key (401).' };
    }
    if (resp.status === 403) {
      return { valid: false, code: 'FORBIDDEN', message: 'Key is valid but lacks model access.' };
    }
    if (resp.status === 429) {
      return { valid: false, code: 'RATE_LIMITED', message: 'Rate limited by Anthropic. Retry shortly.' };
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return {
        valid: false,
        code: 'UPSTREAM_ERROR',
        message: `Anthropic returned ${resp.status}: ${txt.slice(0, 200)}`,
      };
    }

    const body = await resp.json();
    const parsed = Array.isArray(body?.data) ? body.data.map((m) => m.id) : [];
    if (parsed.length) models = parsed;
  } catch (err) {
    if (err.name === 'AbortError') {
      return { valid: false, code: 'TIMEOUT', message: 'Anthropic API did not respond in 10s.' };
    }
    return { valid: false, code: 'NETWORK', message: err.message };
  } finally {
    clearTimeout(timeout);
  }

  // Step 2: probe actual generation (quota check).
  // Model listing succeeds even when workspace credits are exhausted —
  // it does NOT prove the key can make messages.create calls.
  const probe = await probeGenerate(apiKey.trim());

  return {
    valid: true,
    modelsAvailable: models,
    canGenerate: probe.canGenerate,   // true | false | null
    isUsageCap: probe.isUsageCap,     // true if workspace limit confirmed
  };
}

module.exports = { validateApiKey, looksLikeKey, DEFAULT_MODELS };
