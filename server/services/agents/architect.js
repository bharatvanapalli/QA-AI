'use strict';

/**
 * Agent 1 — Scenario Architect.
 * Reads requirements → produces JSON array of test SCENARIOS.
 * A scenario is a behavioural area, not a single test. Each scenario
 * has priority, category, rationale, and child test cases.
 *
 * The agent calls Claude (claude-sonnet-4-6 by default) using the user's
 * configured key from the vault. Streaming reasoning is forwarded via
 * `onLog(level, message)` so the Theater UI can render it live.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt } = require('../../lib/promptCompose');

const SUPPORTED_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SUPPORTED_CATEGORIES = ['positive', 'negative', 'edge', 'boundary', 'empty', 'e2e'];
const SUPPORTED_TYPES = ['functional', 'smoke', 'regression', 'security', 'boundary', 'integration'];

const SYSTEM_PROMPT = `You are a senior QA scenario architect. Given product requirements, produce a JSON
array of test SCENARIOS. A scenario is a behavioural AREA, not a single test — each scenario
contains multiple specific test cases that exercise it.

OUTPUT FORMAT — STRICT:
- Output ONLY a valid JSON array starting with [ and ending with ].
- NO markdown code fences (no \`\`\` of any kind).
- NO preamble text, NO trailing text, NO explanation, NO closing summary.
- Do not say "Here is" or "I have created". JSON ONLY.

HARD SIZE LIMITS (to fit within token budget):
- Maximum 12 SCENARIOS total.
- Maximum 4 CASES per scenario.
- Maximum 5 STEPS per case.
- Keep names ≤ 100 chars. Rationale ≤ 200 chars. Assertions ≤ 250 chars.

SCHEMA — every scenario MUST have ALL these fields exactly:
{
  "name": "string",
  "module": "lowercase-single-word",
  "priority": "P0" | "P1" | "P2" | "P3",
  "category": "positive" | "negative" | "edge" | "boundary" | "empty" | "e2e",
  "rationale": "string (≤200 chars)",
  "dependencyOn": [],
  "cases": [
    {
      "name": "string",
      "type": "functional" | "smoke" | "regression" | "security" | "boundary" | "integration",
      "confidence": 70-99,
      "assertions": "string (comma-separated, ≤250 chars)",
      "steps": [
        { "order": 1, "action": "Navigate", "target": "Login page", "value": "https://...", "expected": "Login form visible" },
        { "order": 2, "action": "Click", "target": "Sign in button" }
      ]
    }
  ]
}

CRITICAL RULES:
1. For every POSITIVE scenario you propose, also propose at least one NEGATIVE scenario for the same module.
2. Surface BOUNDARY cases for any numeric/length constraint mentioned (e.g. "max 5MB" → boundary scenario).
3. Surface EMPTY-state scenarios where data may legitimately be absent.
4. E2E scenarios are reserved for genuine cross-module flows.
5. First step of every case is typically a Navigate. Last step is typically a Verify/Expect.
6. Be concise — every character costs tokens. Prefer short, behavioural language.

CATEGORY DIVERSITY (avoid happy-path-only output):
7. When the requirements describe a form, login, search box, file upload, URL parameter, or any
   user-supplied input, INCLUDE at least one scenario with category "negative" and type "security"
   covering the relevant class — SQL injection / XSS / auth bypass / path traversal / oversized
   payload — whichever applies. Skip ONLY when the feature genuinely has no user-supplied input.
8. INCLUDE at least one UI-validation scenario (error message renders, loading state appears,
   disabled state respected, success toast shown) per module that has interactive elements. Use
   category "edge" or "negative" with explicit assertions on the visible UI feedback.
9. Do NOT return a scenario list that is 100% category="positive". A real QA suite for any
   non-trivial feature has at minimum 3 categories represented.`;

/**
 * Robust JSON parser for the Architect's output.
 * Tries multiple recovery strategies in order:
 *   1. Plain JSON.parse on the trimmed text
 *   2. Strip markdown code fences and retry
 *   3. Extract the first '[' to its matching ']' and retry
 *   4. Find the first '[' and try truncating to last complete object, append ']' and parse
 * Returns the parsed array or null.
 */
function parseScenarioJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();

  // 1. Direct parse
  try { const v = JSON.parse(text); if (Array.isArray(v)) return v; } catch (_) {}

  // 2. Strip code fences (handles ```json, ``` , trailing fences, surrounding text)
  const fenceMatch = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { const v = JSON.parse(fenceMatch[1].trim()); if (Array.isArray(v)) return v; } catch (_) {}
  }

  // 3. Extract from first '[' to last ']' (covers preamble/postamble text)
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const slice = text.slice(firstBracket, lastBracket + 1);
    try { const v = JSON.parse(slice); if (Array.isArray(v)) return v; } catch (_) {}
  }

  // 4. Truncation recovery — find the last `}` that closes a complete scenario object,
  //    truncate there, append `]`.
  if (firstBracket !== -1) {
    const body = text.slice(firstBracket);
    // Walk forward, count braces; remember last position where depth returned to 1 (outside any object).
    let depth = 0;
    let inString = false;
    let escape = false;
    let lastSafeEnd = -1;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (c === '\\') { escape = true; continue; }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        // After a closing brace at array level (depth === 1), it's safe to truncate here
        if (depth === 1 && c === '}') lastSafeEnd = i;
      }
    }
    if (lastSafeEnd > 0) {
      const salvaged = body.slice(0, lastSafeEnd + 1) + ']';
      try {
        const v = JSON.parse(salvaged);
        if (Array.isArray(v) && v.length > 0) return v;
      } catch (_) {}
    }
  }

  return null;
}

function normaliseScenario(s) {
  if (!s || typeof s !== 'object') return null;
  const name = String(s.name || '').slice(0, 200).trim();
  if (!name) return null;
  const module = String(s.module || 'core').toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40) || 'core';
  const priority = SUPPORTED_PRIORITIES.includes(s.priority) ? s.priority : 'P2';
  const category = SUPPORTED_CATEGORIES.includes(s.category) ? s.category : 'positive';
  const rationale = String(s.rationale || '').slice(0, 1000);
  const dependencyOn = Array.isArray(s.dependencyOn)
    ? s.dependencyOn.map((d) => String(d).slice(0, 200)).slice(0, 10)
    : [];
  const cases = Array.isArray(s.cases)
    ? s.cases.map(normaliseCase).filter(Boolean).slice(0, 4)
    : [];
  if (cases.length === 0) return null;
  return { name, module, priority, category, rationale, dependencyOn, cases };
}

function normaliseCase(c) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name || '').slice(0, 200).trim();
  if (!name) return null;
  const type = SUPPORTED_TYPES.includes(c.type) ? c.type : 'functional';
  let confidence = parseInt(c.confidence, 10);
  if (!Number.isFinite(confidence)) confidence = 75;
  confidence = Math.max(70, Math.min(99, confidence));
  const assertions = String(c.assertions || '').slice(0, 1000);
  const steps = Array.isArray(c.steps)
    ? c.steps
        .map((s, i) => normaliseStep(s, i + 1))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  return { name, type, confidence, assertions, steps };
}

function normaliseStep(s, fallbackOrder) {
  if (!s || typeof s !== 'object') return null;
  const action = String(s.action || '').slice(0, 120).trim();
  if (!action) return null;
  return {
    order: Number.isFinite(s.order) ? s.order : fallbackOrder,
    action,
    target:   s.target   ? String(s.target).slice(0, 200)   : null,
    value:    s.value    ? String(s.value).slice(0, 200)    : null,
    expected: s.expected ? String(s.expected).slice(0, 200) : null,
  };
}

/**
 * Run the architect.
 * @param {object} opts
 * @param {string} opts.apiKey         Anthropic API key (decrypted)
 * @param {string} opts.model          Model id e.g. 'claude-sonnet-4-6'
 * @param {Array}  opts.requirements   [{ title, content }]
 * @param {function} opts.onLog        async (level, message) => void
 * @param {AbortSignal} [opts.signal]  Optional — passed to Anthropic SDK so a
 *                                     POST /agents/cancel actually aborts the
 *                                     in-flight HTTP request mid-stream.
 * @returns {Promise<{ scenarios: Array, raw: string, tokens: object }>}
 */
async function run({ apiKey, model, requirements, onLog = async () => {}, signal, onRateLimit, extraGuidance, provider: providerName, priorContext }) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing. Configure it in Settings.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  const provider = getProvider(providerName);
  if (!requirements?.length) {
    const err = new Error('No requirements available. Pull or upload requirements first.');
    err.code = 'NO_REQUIREMENTS';
    err.status = 400;
    throw err;
  }
  if (signal?.aborted) {
    const err = new Error('Cancelled before start.');
    err.code = 'CANCELLED'; err.status = 499;
    throw err;
  }

  const userText = requirements
    .map((r, i) => {
      const head = r.title ? `[${i + 1}] ${r.title}` : `[${i + 1}]`;
      return `${head}\n${r.content || ''}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 80_000);

  await onLog('info', `Reading ${requirements.length} requirements (${userText.length} chars)…`);
  await onLog('info', `Calling ${provider.name} ${model || '(default)'} … (≤120s)`);
  console.log(`[architect] start provider=${provider.name} model=${model} reqs=${requirements.length} chars=${userText.length}`);

  const t0 = Date.now();
  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model,
      maxTokens: 16_000,
      // Phase E1.7 — prepend prior-runs preamble when the project has been
      // tested before. Signals to the Architect that the KB already holds
      // learned locators and bias scenarios toward continuity with prior
      // sprints. composeSystemPrompt then wraps in operator guidance.
      system: composeSystemPrompt(
        priorContext ? `${priorContext}\n\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT,
        extraGuidance,
      ),
      messages: [{ role: 'user', content: userText }],
      signal,
      onRateLimit,
    });
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (err?.name === 'AbortError' || signal?.aborted) {
      await onLog('warn', `${provider.name} call aborted after ${elapsed}s (user cancelled).`);
      const aborted = new Error('Cancelled by user.');
      aborted.code = 'CANCELLED'; aborted.status = 499;
      throw aborted;
    }
    console.error(`[architect] FAILED after ${elapsed}s:`, err.message, err.code || '');
    await onLog('error', `${provider.name} call failed after ${elapsed}s: ${err.message}`);
    if (!err.code) err.code = 'AI_PROVIDER_FAILED';
    if (!err.status) err.status = 502;
    throw err;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const stopReason = resp.stop_reason || 'unknown';
  console.log(`[architect] ${provider.name} responded in ${elapsed}s; stop=${stopReason}; ${resp.usage?.input_tokens || '?'} in / ${resp.usage?.output_tokens || '?'} out`);
  await onLog('info', `${provider.name} responded in ${elapsed}s (stop=${stopReason}, ${resp.usage?.output_tokens || '?'} tokens out).`);
  if (stopReason === 'max_tokens') {
    await onLog('warn', `Hit max_tokens limit — output is likely truncated. Recovery will salvage what's parseable.`);
  }

  const text = (resp.content?.[0]?.text || '').trim();
  await onLog('info', `${provider.name} returned ${text.length} chars. Parsing…`);

  const parsed = parseScenarioJson(text);
  if (!parsed) {
    console.error(`[architect] PARSE FAILED. First 500 chars: ${text.slice(0, 500)}`);
    await onLog('error', `Could not parse JSON. First 200 chars: ${text.slice(0, 200)}`);
    const err = new Error(
      stopReason === 'max_tokens'
        ? `${provider.name} ran out of tokens before finishing the JSON. Try uploading fewer / shorter documents, or use a smaller scope.`
        : `${provider.name} returned non-JSON. Check the server log to see what was emitted.`
    );
    err.code = 'INVALID_AI_OUTPUT';
    err.status = 502;
    throw err;
  }

  const scenarios = (Array.isArray(parsed) ? parsed : [])
    .map(normaliseScenario)
    .filter(Boolean)
    .slice(0, 12);

  if (scenarios.length === 0) {
    const err = new Error('Parsed JSON had no valid scenarios. The output may have been malformed.');
    err.code = 'EMPTY_OUTPUT';
    err.status = 502;
    throw err;
  }

  await onLog('info', `Parsed ${scenarios.length} scenarios with ${scenarios.reduce((a, s) => a + s.cases.length, 0)} test cases total.`);

  return {
    scenarios,
    raw: text,
    tokens: resp.usage || null,
  };
}

module.exports = { run, SYSTEM_PROMPT };
