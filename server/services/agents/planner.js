'use strict';

/**
 * Agent 2 — Dependency Planner.
 *
 * P2-1 — replaces the previous LLM call with a deterministic Kahn topological
 * sort + indegree-wave partition + P0-first ordering + substring conflict
 * detection. Per CLAUDE.md "Operating principle — Node unless genuine
 * novelty": "Topological sorts, regex classification, keyword matching,
 * substring search... — Node."
 *
 * The planner's three previous goals are all deterministic:
 *   1. Respect dependencies                → topological sort (Kahn).
 *   2. Group P0 scenarios earliest         → stable sort by priority within wave.
 *   3. Maximise parallelism in each wave   → wave = scenarios at the same indegree level.
 *   4. Data-isolation separation           → substring conflict on scenario names.
 *
 * `riskFactors` was the only LLM-novel output and no UI surface currently
 * reads it; we emit it deterministically from the substring-conflict scan.
 *
 * Win: one LLM call eliminated per run; planner parse-failure failure mode
 * eliminated; zero quality regression (the LLM almost always produced one
 * parallel wave anyway).
 *
 * The SYSTEM_PROMPT constant is retained for backwards-compatible exports
 * (and as a documentation block describing the contract).
 */

const SYSTEM_PROMPT = `Deterministic planner (no LLM call).

The Node implementation respects dependencies via Kahn's topological sort,
emits the longest path's indegree level as the wave id, sorts P0 first
within each wave, and surfaces shared-keyword name conflicts as risk
factors. Output shape preserved:
  { waves: [{ id, scenarioIds, parallel, why }], estimatedDurationSec, riskFactors }`;

const STOP_WORDS = new Set([
  'the', 'and', 'or', 'a', 'an', 'is', 'are', 'was', 'were',
  'to', 'for', 'with', 'on', 'in', 'at', 'by', 'of',
  'as', 'be', 'do', 'can', 'should', 'would', 'will',
  'user', 'users', 'test', 'tests', 'case', 'cases',
  'verify', 'check', 'ensure', 'when', 'then', 'given',
]);

function _nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
}

/**
 * Kahn topological sort + indegree-wave partition.
 *
 * @param {Array<{id, name, priority, dependencyOn}>} scenarios
 * @returns {Array<Array<string>>} waves of scenario ids, in dependency order.
 *                                 Each inner array can run in parallel.
 */
function _topoWaves(scenarios) {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  // Preserve the original input order as a tie-breaker so scenarios run in
  // the order they were created (TS-1 before TS-2 etc.) when priority is equal.
  const inputIndex = new Map(scenarios.map((s, i) => [s.id, i]));
  // Build indegree map; only count deps that point at known scenarios so
  // dangling ids (Architect emitted a name we couldn't resolve) don't
  // permanently block a scenario.
  const indegree = new Map();
  const adj = new Map();
  for (const s of scenarios) {
    indegree.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const s of scenarios) {
    const deps = Array.isArray(s.dependencyOn) ? s.dependencyOn : [];
    for (const dep of deps) {
      if (!byId.has(dep)) continue;
      indegree.set(s.id, (indegree.get(s.id) || 0) + 1);
      adj.get(dep).push(s.id);
    }
  }

  const waves = [];
  const remaining = new Set(scenarios.map((s) => s.id));
  while (remaining.size > 0) {
    // Wave = every node currently at indegree 0.
    const wave = [];
    for (const id of remaining) {
      if ((indegree.get(id) || 0) === 0) wave.push(id);
    }
    if (wave.length === 0) {
      // Cycle detected (or all remaining nodes have unresolvable deps) —
      // dump the rest into a final wave deterministically by id so the
      // planner never hangs. The runs.js topo expansion does its own
      // dependency walk per case, so a wave with a cycle is harmless: it
      // just won't gain parallelism.
      waves.push([...remaining].sort());
      break;
    }
    // Sort P0 first within the wave, then by original creation order so
    // scenarios run as TS-1 → TS-2 → TS-N rather than alphabetically.
    wave.sort((a, b) => {
      const sa = byId.get(a);
      const sb = byId.get(b);
      const pa = sa?.priority === 'P0' ? 0 : sa?.priority === 'P1' ? 1 : 2;
      const pb = sb?.priority === 'P0' ? 0 : sb?.priority === 'P1' ? 1 : 2;
      if (pa !== pb) return pa - pb;
      return (inputIndex.get(a) ?? 0) - (inputIndex.get(b) ?? 0);
    });
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      for (const next of (adj.get(id) || [])) {
        indegree.set(next, indegree.get(next) - 1);
      }
    }
  }
  return waves;
}

/**
 * Detect substring conflicts on scenario names. If two scenarios in the
 * same wave share a significant token (e.g. both contain "checkout"), that
 * may indicate shared mutable state — surface as a risk factor so QA can
 * decide whether to split them across waves.
 *
 * Returns Array<string> of human-readable risk descriptions.
 */
function _detectConflicts(waves, byId) {
  const risks = [];
  for (const wave of waves) {
    if (wave.length < 2) continue;
    const tokenIndex = new Map(); // token -> [scenarioId, ...]
    for (const id of wave) {
      const tokens = _nameTokens(byId.get(id)?.name);
      for (const t of tokens) {
        if (!tokenIndex.has(t)) tokenIndex.set(t, []);
        tokenIndex.get(t).push(id);
      }
    }
    for (const [token, ids] of tokenIndex.entries()) {
      if (ids.length < 2) continue;
      const names = ids.map((id) => byId.get(id)?.name || id).slice(0, 3);
      risks.push(`Wave shares token "${token}" across: ${names.join('; ')}. Possible shared mutable state.`);
    }
  }
  // Dedupe + cap to keep the UI usable.
  return [...new Set(risks)].slice(0, 10);
}

function _estimatedDuration(scenarios, waves) {
  // Rough heuristic: 25s per case-equivalent (3 cases ≈ 75s; previous LLM
  // emitted similar magnitudes). Per-wave duration is the max case-count in
  // the wave because cases in a wave run in parallel.
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  let total = 0;
  for (const wave of waves) {
    const cases = wave.map((id) => {
      const s = byId.get(id);
      return Array.isArray(s?.cases) ? s.cases.length : 1;
    });
    total += Math.max(0, ...cases) * 25;
  }
  return Math.max(60, total);
}

/**
 * Public entry — same signature as the old LLM-backed run. The provider /
 * apiKey / model / signal / onRateLimit fields are accepted for backwards
 * compatibility but ignored (no LLM call is made).
 */
async function run({ scenarios, onLog = async () => {} } = {}) {
  if (!scenarios?.length) {
    const err = new Error('No scenarios to plan.');
    err.code = 'NO_SCENARIOS';
    err.status = 400;
    throw err;
  }
  await onLog('info', `Planning execution order for ${scenarios.length} scenarios (deterministic, no LLM call)…`);

  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const waves = _topoWaves(scenarios);
  const cleanWaves = waves.map((scenarioIds, i) => {
    const names = scenarioIds.map((id) => byId.get(id)?.name || id);
    return {
      id: i + 1,
      scenarioIds,
      parallel: scenarioIds.length > 1,
      why: scenarioIds.length === 1
        ? `Only ${names[0]} is ready at this indegree level.`
        : `${scenarioIds.length} scenario(s) share no dependency in this wave: ${names.slice(0, 3).join('; ')}${names.length > 3 ? '…' : ''}.`,
    };
  });

  const riskFactors = _detectConflicts(waves, byId);
  const estimatedDurationSec = _estimatedDuration(scenarios, waves);

  const plan = { waves: cleanWaves, estimatedDurationSec, riskFactors };

  await onLog(
    'info',
    `Plan: ${plan.waves.length} waves · ~${plan.estimatedDurationSec}s · ${plan.riskFactors.length} risk factor(s)`,
  );

  // raw + tokens kept for shape parity with the old return value.
  return { plan, raw: JSON.stringify(plan), tokens: null };
}

module.exports = { run, SYSTEM_PROMPT, _topoWaves };
