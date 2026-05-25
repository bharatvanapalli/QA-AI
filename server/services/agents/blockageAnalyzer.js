'use strict';

/**
 * Agent — Blockage Analyzer (Phase 7 / M2).
 *
 * For each blocked / failed TestCase in a run, produce a structured
 * explanation:
 *   - category        : enum (dependency_failure | environment | data_unavailable | selector_drift | flake | unknown)
 *   - summary         : 1-2 sentence narrative ("TC-15 'Place order' blocked
 *                       because TC-12 'Login as admin' failed → cart session
 *                       never initialised.")
 *   - rootCauseTcId   : upstream TC id if this blocker is downstream of another
 *                       failure (null when standalone)
 *   - suggestedFix    : one-line actionable next step
 *   - severity        : 'low' | 'normal' | 'high' (release-criticality)
 *
 * Output drives the "Why blocked?" panel in BlockedItems.jsx and the
 * severity sort. Auto-runs when a Run completes with blockedCount > 0;
 * manually re-runnable via "Re-analyse" in the UI.
 *
 * Dependency-graph aware: receives `scenarios` with `dependencyOn` arrays
 * and the failure outcomes of every case in the run, so it can identify
 * cases blocked BY upstream failures (the most common real cause in QAAI
 * — a "Place order" test failing is rarely about checkout; it's about the
 * upstream login flow failing first).
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');
const { resolveModelForTier } = require('../../lib/modelRouter');

// Phase E5 — cost routing. Blocker triage is structured classification over
// already-recorded error text — mid-tier handles it cleanly.
const TIER = 'mid';

const SYSTEM_PROMPT = `You are a senior SDET doing post-mortem triage on a failed test run.

You receive:
  - "blockers"   : array of blockers from THIS run. Each blocker has:
                    { id, testCaseId, testCaseName, module, reason, locator,
                      message, severity, errorPreview }
  - "runCases"   : every case in the run with its status (pass | fail |
                    blocked | skipped), module, and assertions. Used to find
                    upstream causes — e.g. a blocker on "Place order" may be
                    caused by an upstream fail on "Log in".
  - "dependencies": map of testCaseId -> [upstream testCaseIds it depends on].
                    Empty when the Architect couldn't infer dependencies.

For EACH blocker, decide:

  category — one of:
    - "dependency_failure" : the blocker is downstream of another failing
                              case in the same run (the upstream failure
                              prevented this case from reaching its assertion).
    - "environment"        : Chromium not installed, MCP session failed,
                              network down, CAPTCHA, browser crashed. The
                              SUT itself was unreachable.
    - "data_unavailable"   : the case needed a logged-in user, a seeded
                              record, or fixture data that wasn't provided.
                              "BLOCKED: no credentials provided" lands here.
    - "selector_drift"     : an element the case expects exists on the page
                              but the selector or accessible name changed.
                              Locator-shape errors.
    - "flake"              : the case sometimes passes and sometimes fails
                              with the same code — timing-sensitive or
                              non-deterministic.
    - "unknown"            : you cannot confidently classify; explain why
                              in the summary.

  summary — ONE OR TWO sentences explaining WHY the blocker happened.
            Quote specific things: upstream TC names, page text from the
            error message, the failing selector. NEVER vague filler like
            "an issue occurred". If category is dependency_failure, the
            summary MUST name the upstream TC.

  rootCauseTcId — the testCaseId of the upstream case that caused this
                   blocker, when category="dependency_failure". null
                   otherwise. Use ONLY ids that appear in "runCases".

  suggestedFix — ONE actionable line. Examples:
    - "Add a test user under Project Setup → Test users; the agent can't
       fabricate credentials."
    - "Locator '#submit' no longer matches; replace with role=button
       name='Submit order' (visible in the snapshot)."
    - "Fix TC 'Log in as admin' first — every checkout case is blocked on
       that auth."
    - "Install Chromium: npx playwright install chromium."

  severity — 'high' if release-critical (auth, payment, P0 modules,
              dependency_failure where >2 cases depend on the root cause).
              'low' for flake-only or already-resolved-class noise.
              'normal' otherwise.

Output a SINGLE JSON object — no markdown, no preamble:
{
  "analyses": [
    {
      "id": "<echo the blocker id verbatim>",
      "category": "...",
      "summary": "...",
      "rootCauseTcId": "..." | null,
      "suggestedFix": "...",
      "severity": "low" | "normal" | "high"
    }
  ]
}

Rules:
- One analysis per blocker; omit nothing.
- rootCauseTcId must be present in runCases or be null.
- Keep summary under 280 chars, suggestedFix under 200 chars.
- If two blockers share the same upstream cause, name the SAME rootCauseTcId
  on both — that's how the UI groups them.`;

const VALID_CATEGORIES = ['dependency_failure', 'environment', 'data_unavailable', 'selector_drift', 'flake', 'unknown'];
const VALID_SEVERITIES = ['low', 'normal', 'high'];

function normaliseAnalysis(raw, blockerIds, tcIds) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id || !blockerIds.has(id)) return null;
  const category = VALID_CATEGORIES.includes(raw.category) ? raw.category : 'unknown';
  const summary = String(raw.summary || '').slice(0, 320).trim();
  const suggestedFix = String(raw.suggestedFix || '').slice(0, 220).trim();
  const severity = VALID_SEVERITIES.includes(raw.severity) ? raw.severity : 'normal';
  let rootCauseTcId = raw.rootCauseTcId ? String(raw.rootCauseTcId).trim() : null;
  if (rootCauseTcId && !tcIds.has(rootCauseTcId)) rootCauseTcId = null;
  return { id, category, summary, suggestedFix, severity, rootCauseTcId };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.provider
 * @param {Array}  opts.blockers     enriched BlockedItem rows (id, testCaseId, testCaseName, module, reason, locator, message, severity, errorPreview)
 * @param {Array}  opts.runCases     [{ id, name, module, status, assertions }]
 * @param {object} opts.dependencies map<tcId, tcId[]>
 * @param {function} [opts.onLog]
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onRateLimit]
 * @param {string} [opts.extraGuidance]
 * @returns {Promise<{ analyses: Array }>}
 */
async function run({
  apiKey, model, provider: providerName,
  blockers, runCases, dependencies = {},
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
  const list = Array.isArray(blockers) ? blockers.filter(Boolean) : [];
  if (list.length === 0) {
    return { analyses: [] };
  }
  const provider = getProvider(providerName);

  const blockerIds = new Set(list.map((b) => b.id));
  const tcIds = new Set((runCases || []).map((c) => c.id));

  // Cap payload sizes per-blocker so a single noisy traceback doesn't blow
  // out the prompt budget. The actual error/message gets truncated to
  // ~600 chars per blocker, which is enough to surface the meaningful
  // line without dragging in stack frames.
  const compactBlockers = list.map((b) => ({
    id: b.id,
    testCaseId: b.testCaseId || null,
    testCaseName: b.testCaseName || null,
    module: b.module || null,
    reason: b.reason || 'unknown',
    locator: b.locator || null,
    severity: b.severity || 'normal',
    message: String(b.message || '').slice(0, 600),
    errorPreview: String(b.errorPreview || '').slice(0, 600),
  }));

  const compactRunCases = (runCases || []).map((c) => ({
    id: c.id,
    name: c.name,
    module: c.module || null,
    status: c.status,
    assertions: String(c.assertions || '').slice(0, 240),
  }));

  await onLog('info', `Analysing ${compactBlockers.length} blocker(s) across ${compactRunCases.length} case(s)…`);

  let resp;
  try {
    const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });
    resp = await provider.complete({
      apiKey,
      model: routedModel,
      maxTokens: 4000,
      system: composeSystemPrompt(SYSTEM_PROMPT, extraGuidance),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '## blockers' },
            { type: 'text', text: JSON.stringify(compactBlockers, null, 2) },
            { type: 'text', text: '\n## runCases' },
            { type: 'text', text: JSON.stringify(compactRunCases, null, 2) },
            { type: 'text', text: '\n## dependencies' },
            { type: 'text', text: JSON.stringify(dependencies, null, 2) },
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
    await onLog('error', `Blockage analyzer call failed: ${err.message}`);
    throw err;
  }

  const text = (resp.content?.[0]?.text || '').trim();
  const parsed = parseJsonResponse(text, { type: 'object' });
  if (!parsed) {
    await onLog('warn', 'Analyzer returned non-JSON; no analyses persisted.');
    return { analyses: [] };
  }

  const analyses = Array.isArray(parsed.analyses)
    ? parsed.analyses.map((a) => normaliseAnalysis(a, blockerIds, tcIds)).filter(Boolean)
    : [];

  await onLog('info', `Produced ${analyses.length}/${list.length} analyses.`);
  return { analyses };
}

module.exports = { run, SYSTEM_PROMPT, VALID_CATEGORIES, VALID_SEVERITIES };
