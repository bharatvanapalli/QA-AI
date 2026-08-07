'use strict';

/**
 * Real Google Generative AI client (key validation only).
 * - validateApiKey: lists models, then makes a tiny generateContent call
 *   to test actual generation quota (not just authentication).
 * - The SDK doesn't expose /v1beta/models, so we call it directly via fetch.
 */

const KEY_RE = /^AIza[0-9A-Za-z_-]+$/;

const DEFAULT_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
];

// Fallback probe model — used only when no specific model is selected.
const FALLBACK_PROBE_MODEL = 'gemini-2.5-flash';

function looksLikeKey(apiKey) {
  if (typeof apiKey !== 'string') return false;
  const trimmed = apiKey.trim();
  return KEY_RE.test(trimmed) && trimmed.length >= 20;
}

/**
 * Probe whether the key can actually call generateContent against a specific model.
 * Returns { canGenerate: bool|null, isFreeQuota: bool, modelTested: string }.
 *
 * - canGenerate: true  → generation worked right now
 * - canGenerate: false → 429 (rate limited), isFreeQuota tells us tier
 * - canGenerate: null  → probe timed out, model not found, or unknown error
 */
async function probeGenerate(apiKey, model) {
  const probeModel = (typeof model === 'string' && model.startsWith('gemini-')) ? model : FALLBACK_PROBE_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${probeModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal: controller.signal,
      },
    );
    if (resp.status === 429) {
      const body = await resp.text().catch(() => '');
      return { canGenerate: false, isFreeQuota: /free_tier/i.test(body), modelTested: probeModel };
    }
    if (resp.status === 404) {
      // Model not accessible with this key/tier
      return { canGenerate: null, isFreeQuota: false, modelTested: probeModel, modelNotFound: true };
    }
    if (!resp.ok) {
      return { canGenerate: null, isFreeQuota: false, modelTested: probeModel };
    }
    return { canGenerate: true, isFreeQuota: false, modelTested: probeModel };
  } catch (err) {
    // Timeout or network — inconclusive, don't block validation
    return { canGenerate: null, isFreeQuota: false, modelTested: probeModel };
  } finally {
    clearTimeout(timeout);
  }
}

async function validateApiKey(apiKey, model) {
  if (!looksLikeKey(apiKey)) {
    return {
      valid: false,
      code: 'INVALID_FORMAT',
      message: 'Key should start with "AIza" — paste a Google AI Studio key from aistudio.google.com/apikey.',
    };
  }

  // Step 1: list models (authentication check)
  const listCtrl = new AbortController();
  const listTimeout = setTimeout(() => listCtrl.abort(), 10_000);
  let models = DEFAULT_MODELS;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey.trim())}`,
      { method: 'GET', signal: listCtrl.signal },
    );

    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      return { valid: false, code: 'AUTH_FAILED', message: `Google rejected this API key (${resp.status}).` };
    }
    if (resp.status === 429) {
      return { valid: false, code: 'RATE_LIMITED', message: 'Rate limited by Google. Retry shortly.' };
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { valid: false, code: 'UPSTREAM_ERROR', message: `Google returned ${resp.status}: ${txt.slice(0, 200)}` };
    }

    const body = await resp.json();
    const parsed = Array.isArray(body?.models)
      ? body.models
          .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
          .map((m) => String(m.name || '').replace(/^models\//, ''))
          .filter((id) => id.startsWith('gemini-'))
      : [];
    if (parsed.length) models = parsed;
  } catch (err) {
    if (err.name === 'AbortError') {
      return { valid: false, code: 'TIMEOUT', message: 'Google API did not respond in 10s.' };
    }
    return { valid: false, code: 'NETWORK', message: err.message };
  } finally {
    clearTimeout(listTimeout);
  }

  // Step 2: probe actual generation against the selected model.
  // Model listing succeeds for all keys (free and paid) — it does NOT prove
  // the key can make generateContent calls against a specific model.
  const probe = await probeGenerate(apiKey.trim(), model);

  const result = {
    valid: true,
    modelsAvailable: models,
    canGenerate: probe.canGenerate,
    isFreeQuota: probe.isFreeQuota,
    modelTested: probe.modelTested,
  };
  if (probe.modelNotFound) {
    result.modelWarning = `Model "${probe.modelTested}" returned 404 — it may not be available on your API tier. Try a different model.`;
  }
  return result;
}

module.exports = { validateApiKey, looksLikeKey, DEFAULT_MODELS };
