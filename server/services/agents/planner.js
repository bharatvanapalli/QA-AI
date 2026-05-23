'use strict';

/**
 * Agent 2 — Dependency Planner.
 * Given a list of test scenarios with dependencyOn arrays, produce a JSON
 * execution plan. Optimises for: dependency order, parallelism within a wave,
 * P0 scenarios in the earliest waves.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');

const SYSTEM_PROMPT = `You are a test execution planner. Given test SCENARIOS with their dependencies,
priorities and categories, produce a JSON execution PLAN.

Plan goals (in order of importance):
1. Respect dependencies — never schedule a scenario before its prerequisites.
2. Group P0 scenarios into the earliest waves so blockers surface fast.
3. Maximise parallelism within each wave (scenarios in the same wave run concurrently).
4. SEPARATE scenarios into different waves when they share mutable data state (e.g.
   two scenarios that both create a user with the same email — they would interfere).

Output schema (strict):
{
  "waves": [
    {
      "id": 1,
      "scenarioIds": ["uuid", "uuid"],
      "parallel": true,
      "why": "1-sentence rationale for this wave"
    },
    ...
  ],
  "estimatedDurationSec": number,
  "riskFactors": ["string", ...]
}

Rules:
- "scenarioIds" must reference IDs present in the input.
- "parallel": true means all scenarios in the wave may run concurrently.
- Group scenarios by data isolation, not by module — a P0 cart-add scenario can run in parallel with a P1 search scenario.
- "riskFactors" must surface concrete risks (e.g. "Two checkout scenarios share inventory state",
  "Locator XYZ has 42% health score — flaky").
- Output ONLY a single JSON object. No markdown fences. No preamble.`;

function normalisePlan(raw, knownIds) {
  if (!raw || typeof raw !== 'object') return null;
  const idSet = new Set(knownIds);
  const waves = Array.isArray(raw.waves) ? raw.waves : [];
  const cleanWaves = [];
  let nextId = 1;
  for (const w of waves) {
    if (!w || typeof w !== 'object') continue;
    const scenarioIds = Array.isArray(w.scenarioIds)
      ? w.scenarioIds.filter((id) => idSet.has(id))
      : [];
    if (!scenarioIds.length) continue;
    cleanWaves.push({
      id: typeof w.id === 'number' ? w.id : nextId,
      scenarioIds,
      parallel: w.parallel !== false,
      why: String(w.why || '').slice(0, 500),
    });
    nextId++;
  }
  return {
    waves: cleanWaves,
    estimatedDurationSec:
      Number.isFinite(raw.estimatedDurationSec) ? Math.round(raw.estimatedDurationSec) : 600,
    riskFactors: Array.isArray(raw.riskFactors)
      ? raw.riskFactors.map((r) => String(r).slice(0, 500)).slice(0, 10)
      : [],
  };
}

/**
 * @param {object} opts
 * @param {string}   opts.apiKey
 * @param {string}   opts.model
 * @param {Array}    opts.scenarios  Array of { id, name, module, priority, category, rationale, dependencyOn }
 * @param {function} opts.onLog
 */
async function run({ apiKey, model, scenarios, onLog = async () => {}, signal, onRateLimit, extraGuidance, provider: providerName }) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  if (!scenarios?.length) {
    const err = new Error('No scenarios to plan.');
    err.code = 'NO_SCENARIOS';
    err.status = 400;
    throw err;
  }
  if (signal?.aborted) {
    const err = new Error('Cancelled before start.');
    err.code = 'CANCELLED'; err.status = 499;
    throw err;
  }

  const provider = getProvider(providerName);
  await onLog('info', `Planning execution order for ${scenarios.length} scenarios…`);

  const payload = scenarios.map((s) => ({
    id: s.id,
    name: s.name,
    module: s.module,
    priority: s.priority,
    category: s.category,
    rationale: s.rationale,
    dependencyOn: s.dependencyOn || [],
  }));

  await onLog('tool', `Calling ${provider.name} with scenario dependency graph…`);

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model,
      maxTokens: 8000,
      system: composeSystemPrompt(SYSTEM_PROMPT, extraGuidance),
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
      signal,
      onRateLimit,
      // Forces Gemini's API-level JSON mode (responseMimeType: application/json).
      // Without this, Gemini wraps output in ```json fences regardless of prompt
      // instructions, breaking the parser when responses get truncated mid-fence.
      responseFormat: 'json',
    });
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      const aborted = new Error('Cancelled by user.');
      aborted.code = 'CANCELLED'; aborted.status = 499;
      throw aborted;
    }
    throw err;
  }

  const text = (resp.content?.[0]?.text || '').trim();

  // Robust JSON extraction — handles preamble/postamble prose that Gemini
  // sometimes adds even when prompted "JSON only", along with markdown
  // fences and truncated outputs.
  const parsed = parseJsonResponse(text, { type: 'object' });
  if (!parsed) {
    // Log head + tail of the response so we can tell at a glance whether it
    // was truncated (no closing brace), wrapped in fences, or just garbage.
    console.error(
      `[planner] PARSE FAILED. length=${text.length} head=${text.slice(0, 400)} `
      + `tail=${text.length > 800 ? text.slice(-400) : '(in head)'}`
    );
    await onLog(
      'error',
      `Could not parse plan JSON (${text.length} chars). Head: ${text.slice(0, 200)} `
      + `Tail: ${text.length > 400 ? text.slice(-200) : '(short response)'}`
    );
    const err = new Error(`${provider.name} returned non-JSON. Check the server log for the full output.`);
    err.code = 'INVALID_AI_OUTPUT';
    err.status = 502;
    throw err;
  }

  const plan = normalisePlan(parsed, scenarios.map((s) => s.id));
  if (!plan || !plan.waves.length) {
    const err = new Error('Planner produced an empty plan.');
    err.code = 'EMPTY_PLAN';
    err.status = 502;
    throw err;
  }

  await onLog(
    'info',
    `Plan: ${plan.waves.length} waves · ~${plan.estimatedDurationSec}s · ${plan.riskFactors.length} risk factor(s)`
  );

  return { plan, raw: text, tokens: resp.usage || null };
}

module.exports = { run, SYSTEM_PROMPT };
