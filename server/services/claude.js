'use strict';

/**
 * Real Anthropic API client.
 * - validateApiKey: lists models with the key. Fails fast on bad auth.
 * - The official SDK doesn't expose /v1/models, so we call it directly.
 */

const KEY_RE = /^sk-ant-[a-zA-Z0-9_-]{20,}$/;

const DEFAULT_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5',
];

function looksLikeKey(apiKey) {
  return typeof apiKey === 'string' && KEY_RE.test(apiKey.trim());
}

async function validateApiKey(apiKey) {
  if (!looksLikeKey(apiKey)) {
    return {
      valid: false,
      code: 'INVALID_FORMAT',
      message: 'Key must start with "sk-ant-" and be at least 27 characters.',
    };
  }

  // Use the /v1/models endpoint — cheap, validates auth without consuming credit
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
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
    const models = Array.isArray(body?.data) ? body.data.map((m) => m.id) : DEFAULT_MODELS;
    return { valid: true, modelsAvailable: models };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { valid: false, code: 'TIMEOUT', message: 'Anthropic API did not respond in 10s.' };
    }
    return { valid: false, code: 'NETWORK', message: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { validateApiKey, looksLikeKey, DEFAULT_MODELS };
