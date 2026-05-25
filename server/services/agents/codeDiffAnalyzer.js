'use strict';

/**
 * Agent — Code-Diff Analyzer (Phase E3).
 *
 * Reads the changed-files list from a PR or branch comparison and decides
 * what the QA implications are:
 *
 *   - summary           : 1-3 sentence narrative of what changed at a
 *                          product-feature level (NOT a file-by-file
 *                          paraphrase — the LLM is supposed to abstract
 *                          "src/auth/login.jsx + src/auth/session.js touched"
 *                          up to "Login flow modified").
 *   - impactedModules   : array of existing project module names that map
 *                          to the changed surface area. Pulled from the
 *                          project's current TestCase.module set so the
 *                          Architect can scope its run.
 *   - suggestedScenarios: array of new scenario titles the diff implies
 *                          should be added or re-exercised, each with a
 *                          `module` it belongs to and a short `why`.
 *
 * Output feeds two consumers:
 *   1. Architect's priorContext block (so its scenario set leans into the
 *      diff instead of regenerating the same baseline every run).
 *   2. RunSuite "Diff context" card (so a human can see what the diff
 *      analyzer thought and decide whether to include it).
 *
 * Provider-agnostic — uses the canonical message shape, so both Claude and
 * Gemini are supported via the llmProvider boundary.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');
const { resolveModelForTier } = require('../../lib/modelRouter');

// Phase E5 — cost routing. Mapping changed files to product features /
// existing modules is well within Haiku-class capability.
const TIER = 'mid';

const SYSTEM_PROMPT = `You are a senior SDET reviewing a code diff to decide what to test.

You receive:
  - "projectName"     : the product the diff applies to.
  - "changedFiles"    : array of { path, additions, deletions, status } from
                         a PR or branch compare. status is GitHub's value:
                         "added" | "modified" | "removed" | "renamed".
  - "existingModules" : the modules the project currently groups test cases
                         under (e.g. "Login", "Checkout", "Profile"). Empty
                         when the project has not been architected yet.
  - "ref"             : the source ref ("#42" for PRs, branch name otherwise).
  - "baseRef"         : the base ref the diff is against (usually "main").

For this diff, produce:

  summary — 1-3 sentences describing what PRODUCT BEHAVIOUR likely changed.
            Abstract above file paths: "Login session handling moved to a
            new cookie format, password reset email template updated" is
            good; "src/auth/login.jsx and src/auth/session.js were modified"
            is bad. Quote the most telling file paths (a max of 2-3) only
            when they actually help the reader.

  impactedModules — array of strings. EACH string MUST come from
                     existingModules verbatim. Pick only the modules whose
                     test cases are likely to fail or need re-exercise based
                     on the diff. Empty array is allowed when no existing
                     module maps cleanly. Do NOT invent new module names
                     here — that's what suggestedScenarios is for.

  suggestedScenarios — array of NEW scenario titles the diff implies. Each:
                        { "name": "<scenario name>",
                          "module": "<existing module OR a new one>",
                          "why": "<one line — what in the diff prompts this>" }
                        Cap at 6 scenarios. Skip when the diff is purely
                        cosmetic (renames, lockfile churn, dependency bumps
                        with no behaviour change).

Output a SINGLE JSON object — no markdown, no preamble:
{
  "summary": "...",
  "impactedModules": ["..."],
  "suggestedScenarios": [
    { "name": "...", "module": "...", "why": "..." }
  ]
}

Rules:
- summary ≤ 480 chars.
- impactedModules entries MUST appear in existingModules. Drop any that
  don't match (you are NOT here to rename modules).
- suggestedScenarios.name ≤ 120 chars; why ≤ 160 chars.
- If changedFiles is empty, output { summary: "No changes detected.",
  impactedModules: [], suggestedScenarios: [] }.
- Lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock)
  and CI configs do NOT in themselves justify a suggested scenario unless
  a dependency with known behavioural impact was bumped.`;

function truncate(value, max) {
  const s = String(value || '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function normaliseOutput(raw, allowedModules) {
  if (!raw || typeof raw !== 'object') {
    return { summary: '', impactedModules: [], suggestedScenarios: [] };
  }
  const summary = truncate(raw.summary, 520);
  const allowed = new Set((allowedModules || []).map((m) => String(m).trim()).filter(Boolean));
  const impactedModules = Array.isArray(raw.impactedModules)
    ? Array.from(new Set(
        raw.impactedModules
          .map((m) => String(m || '').trim())
          .filter((m) => m && (allowed.size === 0 || allowed.has(m))),
      ))
    : [];
  const suggestedScenarios = Array.isArray(raw.suggestedScenarios)
    ? raw.suggestedScenarios
        .map((s) => ({
          name: truncate(s?.name, 140),
          module: truncate(s?.module, 80) || 'General',
          why: truncate(s?.why, 200),
        }))
        .filter((s) => s.name)
        .slice(0, 6)
    : [];
  return { summary, impactedModules, suggestedScenarios };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.provider
 * @param {string} opts.projectName
 * @param {Array}  opts.changedFiles    [{ path, additions, deletions, status }]
 * @param {Array}  opts.existingModules string[]
 * @param {string} [opts.ref]
 * @param {string} [opts.baseRef]
 * @param {function} [opts.onLog]
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onRateLimit]
 * @param {string} [opts.extraGuidance]
 * @returns {Promise<{ summary: string, impactedModules: string[], suggestedScenarios: Array }>}
 */
async function run({
  apiKey, model, provider: providerName,
  projectName, changedFiles, existingModules = [],
  ref, baseRef,
  onLog = async () => {}, signal, onRateLimit, extraGuidance,
} = {}) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  if (signal?.aborted) {
    const err = new Error('Cancelled before start.');
    err.code = 'CANCELLED'; err.status = 499;
    throw err;
  }
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  if (files.length === 0) {
    return { summary: 'No changes detected.', impactedModules: [], suggestedScenarios: [] };
  }

  // Cap the changed-files list at 150 — beyond that the diff stops being
  // diagnostically useful and starts being prompt-cost noise. Keep the most
  // recently churning files (highest additions+deletions).
  const ranked = files
    .map((f) => ({
      path: String(f.path || '').slice(0, 240),
      additions: Number.isFinite(f.additions) ? f.additions : 0,
      deletions: Number.isFinite(f.deletions) ? f.deletions : 0,
      status: String(f.status || 'modified'),
    }))
    .filter((f) => f.path)
    .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
    .slice(0, 150);

  const provider = getProvider(providerName);
  const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });
  await onLog('info', `Analysing ${ranked.length} changed file(s)…`);

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model: routedModel,
      maxTokens: 1800,
      system: composeSystemPrompt(SYSTEM_PROMPT, extraGuidance),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `## projectName\n${projectName || '(unnamed)'}` },
            { type: 'text', text: `\n## ref\n${ref || '(unknown)'} (base: ${baseRef || 'main'})` },
            { type: 'text', text: '\n## existingModules' },
            { type: 'text', text: JSON.stringify(existingModules, null, 2) },
            { type: 'text', text: '\n## changedFiles' },
            { type: 'text', text: JSON.stringify(ranked, null, 2) },
          ],
        },
      ],
      signal,
      onRateLimit,
      responseFormat: 'json',
    });
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) {
      const cancelled = new Error('Cancelled.');
      cancelled.code = 'CANCELLED'; cancelled.status = 499;
      throw cancelled;
    }
    await onLog('error', `Diff analyzer call failed: ${err.message}`);
    throw err;
  }

  const text = (resp.content?.[0]?.text || '').trim();
  const parsed = parseJsonResponse(text, { type: 'object' });
  if (!parsed) {
    await onLog('warn', 'Diff analyzer returned non-JSON; storing empty analysis.');
    return { summary: '', impactedModules: [], suggestedScenarios: [] };
  }

  const normalised = normaliseOutput(parsed, existingModules);
  await onLog('info', `Diff analyzed — ${normalised.impactedModules.length} impacted module(s), ${normalised.suggestedScenarios.length} suggested scenario(s).`);
  return normalised;
}

module.exports = { run, SYSTEM_PROMPT };
