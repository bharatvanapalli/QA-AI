'use strict';

/**
 * Agent 4 — Reporter.
 * For each failed RunResult in a Run, asks Claude for a root-cause analysis:
 *   - what (one-sentence summary of what was observed)
 *   - why (the likely cause — locator, data, timing, backend, env)
 *   - fix (the EXACT remediation: change the locator, wait for the response, fix the API, etc.)
 *   - classification ('locator' | 'data' | 'timing' | 'backend' | 'env' | 'unknown')
 *   - confidence (0-100)
 *
 * Returns analysis keyed by runResult.id. The caller persists these onto
 * RunResult and optionally calls issueCreator to file Jira/ADO tickets.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');

const SYSTEM_PROMPT = `You are a senior QA engineer doing root-cause analysis on Playwright test failures.

For EACH failed test in the input, produce a JSON object with these fields:
- id: the runResultId you were given (echo it back exactly)
- what: ONE sentence describing what was observed (e.g. "Click on Sign-in button timed out after 8s because the locator getByRole('button',{name:'Sign in'}) matched zero elements.")
- why: ONE-TO-TWO sentence likely cause. Be specific. Refer to the actual error / trace / network log if relevant.
- fix: THE EXACT remediation. If a locator is wrong, write the corrected locator expression. If timing, say which wait to add. If backend, say which endpoint is failing and what to check.
- classification: one of: 'locator' | 'data' | 'timing' | 'backend' | 'env' | 'unknown'
- confidence: integer 0-100, your confidence in this analysis (use 90+ only when the error message is unambiguous)

OUTPUT ONLY a JSON array of these objects — one per failed test. NO markdown fences, NO preamble.`;

function normaliseAnalysis(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').trim();
  if (!id) return null;
  const what = String(item.what || '').slice(0, 500);
  const why = String(item.why || '').slice(0, 800);
  const fix = String(item.fix || '').slice(0, 1500);
  const cls = ['locator', 'data', 'timing', 'backend', 'env', 'unknown'].includes(item.classification)
    ? item.classification : 'unknown';
  let conf = parseInt(item.confidence, 10);
  if (!Number.isFinite(conf)) conf = 60;
  conf = Math.max(0, Math.min(100, conf));
  return { id, what, why, fix, classification: cls, confidence: conf };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey  Claude API key
 * @param {string} opts.model
 * @param {Array}  opts.failures  Array of { id, testCase, status, error, trace, networkLog, screenshots }
 * @param {function} opts.onLog
 * @returns {Promise<{ analyses: Array }>}
 */
async function run({ apiKey, model, failures, onLog = async () => {}, onRateLimit, extraGuidance, provider: providerName }) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  if (!failures?.length) {
    return { analyses: [] };
  }
  const provider = getProvider(providerName);

  await onLog('info', `Analyzing ${failures.length} failure(s)…`);

  const compactFailures = failures.map((f) => ({
    id: f.id,
    testName: f.testCase?.name || f.testCaseId,
    module: f.testCase?.module || null,
    type: f.testCase?.type || null,
    status: f.status,
    error: (f.error || '').slice(0, 1500),
    trace: (f.trace || '').slice(0, 2000),
    networkLog: Array.isArray(f.networkLog) ? f.networkLog.slice(-10) : null,
  }));

  const resp = await provider.complete({
    apiKey,
    model,
    maxTokens: 4000,
    system: composeSystemPrompt(SYSTEM_PROMPT, extraGuidance),
    messages: [{ role: 'user', content: JSON.stringify(compactFailures, null, 2) }],
    onRateLimit,
    responseFormat: 'json',
  });

  const text = (resp.content?.[0]?.text || '').trim();
  const parsed = parseJsonResponse(text, { type: 'array' });
  if (!parsed) {
    console.error(`[reporter] PARSE FAILED. First 500 chars: ${text.slice(0, 500)}`);
    const err = new Error(`${provider.name} returned non-JSON.`);
    err.code = 'INVALID_AI_OUTPUT';
    err.status = 502;
    throw err;
  }

  const analyses = parsed.map(normaliseAnalysis).filter(Boolean);
  await onLog('info', `Produced ${analyses.length} root-cause analyses.`);
  return { analyses };
}

module.exports = { run, SYSTEM_PROMPT };
