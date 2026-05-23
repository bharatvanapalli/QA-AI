'use strict';

/**
 * Test-case generator — uses Claude to derive structured test cases from real
 * requirements. NO hardcoded fallback masquerading as AI: if no key, we return
 * an explicit "not generated" status so the UI can surface the gap.
 */

const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are a senior QA analyst. Given product requirements, produce a JSON array of test cases.

Each test case MUST have:
- name: string — concise behavioural sentence
- type: 'functional' | 'smoke' | 'regression' | 'security' | 'boundary' | 'integration'
- module: lowercase single-word identifier of the area under test
- confidence: integer 70-99 — how testable is this from the requirement
- assertions: short comma-separated list of what must be verified

Rules:
- Cover happy path + at least one negative/edge case per requirement.
- Output ONLY valid JSON (an array). No markdown, no preamble.
- Maximum 20 test cases per response.`;

const SUPPORTED_TYPES = ['functional', 'smoke', 'regression', 'security', 'boundary', 'integration'];

function normalise(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const tc of raw) {
    if (!tc || typeof tc !== 'object') continue;
    const name = String(tc.name || '').slice(0, 200).trim();
    if (!name) continue;
    const type = SUPPORTED_TYPES.includes(tc.type) ? tc.type : 'functional';
    const module = String(tc.module || 'core').toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40) || 'core';
    let confidence = parseInt(tc.confidence, 10);
    if (!Number.isFinite(confidence)) confidence = 75;
    confidence = Math.max(70, Math.min(99, confidence));
    const assertions = String(tc.assertions || '').slice(0, 1000);
    out.push({ name, type, module, confidence, assertions });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Generate test cases from a list of requirements via Claude.
 *
 * @param {object} opts
 * @param {string} opts.apiKey - Anthropic API key (decrypted from vault)
 * @param {string} opts.model  - e.g. 'claude-sonnet-4-6'
 * @param {Array}  opts.requirements - [{title, content}]
 * @returns {Promise<{cases: Array, raw: string}>}
 */
async function generate({ apiKey, model, requirements }) {
  if (!apiKey) {
    const err = new Error('Claude API key missing. Configure it in Settings.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  if (!requirements?.length) {
    const err = new Error('No requirements selected.');
    err.code = 'NO_REQUIREMENTS';
    err.status = 400;
    throw err;
  }

  const userText = requirements
    .map((r, i) => {
      const head = r.title ? `[${i + 1}] ${r.title}` : `[${i + 1}]`;
      return `${head}\n${r.content || ''}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 60_000);

  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: model || 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
  });

  const text = (resp.content?.[0]?.text || '').trim();
  // Strip code fences if present
  const stripped = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    const err = new Error('Claude returned non-JSON. Try again with simpler requirements.');
    err.code = 'INVALID_AI_OUTPUT';
    err.status = 502;
    throw err;
  }
  return { cases: normalise(parsed), raw: text };
}

module.exports = { generate, normalise };
