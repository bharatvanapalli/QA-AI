'use strict';

/**
 * Real Google Generative AI client (key validation only).
 * - validateApiKey: lists models with the key. Fails fast on bad auth.
 * - The SDK doesn't expose /v1beta/models, so we call it directly via fetch.
 */

// Format check is intentionally LENIENT — Google rotates key formats and the
// length varies. We only catch the most common error (pasting an Anthropic
// key by mistake) by requiring the "AIza" prefix. Everything else we delegate
// to Google's actual validation via /v1beta/models.
const KEY_RE = /^AIza[0-9A-Za-z_-]+$/;

const DEFAULT_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
];

function looksLikeKey(apiKey) {
  if (typeof apiKey !== 'string') return false;
  const trimmed = apiKey.trim();
  // Must start with the Google prefix and be at least 20 chars (no real key
  // is shorter than this — the trim is just to avoid empty / single-word
  // pastes producing a Google round-trip).
  return KEY_RE.test(trimmed) && trimmed.length >= 20;
}

async function validateApiKey(apiKey) {
  if (!looksLikeKey(apiKey)) {
    return {
      valid: false,
      code: 'INVALID_FORMAT',
      message: 'Key should start with "AIza" — paste a Google AI Studio key from aistudio.google.com/apikey.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey.trim())}`,
      { method: 'GET', signal: controller.signal },
    );

    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      return { valid: false, code: 'AUTH_FAILED', message: `Google rejected this API key (${resp.status}).` };
    }
    if (resp.status === 429) {
      return { valid: false, code: 'RATE_LIMITED', message: 'Rate limited by Google. Retry shortly.' };
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return {
        valid: false,
        code: 'UPSTREAM_ERROR',
        message: `Google returned ${resp.status}: ${txt.slice(0, 200)}`,
      };
    }

    const body = await resp.json();
    // body.models is an array of { name: 'models/gemini-2.5-pro', supportedGenerationMethods: [...] }
    // Only keep models that support generateContent (chat models).
    const models = Array.isArray(body?.models)
      ? body.models
          .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
          .map((m) => String(m.name || '').replace(/^models\//, ''))
          .filter((id) => id.startsWith('gemini-'))
      : DEFAULT_MODELS;
    return { valid: true, modelsAvailable: models.length ? models : DEFAULT_MODELS };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { valid: false, code: 'TIMEOUT', message: 'Google API did not respond in 10s.' };
    }
    return { valid: false, code: 'NETWORK', message: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { validateApiKey, looksLikeKey, DEFAULT_MODELS };
