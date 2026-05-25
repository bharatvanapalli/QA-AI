'use strict';

/**
 * Agent — Document Analyst.
 *
 * Two responsibilities:
 *   1. detectDiscrepancies(): given documents grouped by category, find items
 *      present in BRD but absent from Release Notes (or vice-versa), and other
 *      spec mismatches.
 *   2. selectImpactedScenarios(): given the current set of scenarios + the
 *      latest Release Notes, return which scenarios should be re-run because
 *      they touch a module/feature mentioned in the release notes.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');
const { resolveModelForTier } = require('../../lib/modelRouter');

// Phase E5 — cost routing. The Analyst doesn't need flagship intelligence
// for document comparison / impact selection; routing to Haiku-class cuts
// the per-call bill ~70% with no quality loss noticed in testing.
const TIER = 'mid';

const DISCREPANCY_SYSTEM = `You are a senior QA business analyst.

You receive product documents grouped by category: brd, user-stories, release-notes, api-spec, other.

Find DISCREPANCIES between them. Output a JSON array of objects with these fields:
- kind: 'in_brd_not_in_release' | 'in_release_not_in_brd' | 'spec_mismatch'
- summary: ONE sentence — the thing that is inconsistent
- detail: WHY this matters (2-3 sentences). Quote the conflicting passages.
- severity: 'info' | 'warning' | 'critical'

Rules:
- 'in_brd_not_in_release' = a feature/requirement is in the BRD but the release notes don't mention shipping it
- 'in_release_not_in_brd' = the release notes mention shipping something that has no acceptance criteria in the BRD
- 'spec_mismatch' = the same item is described differently across documents (e.g. BRD says password ≥ 8 chars, release notes mention 12 chars)
- Skip trivialities. Only surface things a tester would want to flag.
- Maximum 12 discrepancies. Quality over quantity.

Output ONLY a valid JSON array. NO markdown fences. NO preamble.`;

const IMPACT_SYSTEM = `You are a senior QA engineer doing impact analysis.

You receive:
- A list of test SCENARIOS (each with id, name, module, category)
- The text of the latest Release Notes

For EACH scenario, decide whether it is IMPACTED by something in the release notes.
A scenario is impacted if the release notes mention:
- the scenario's module by name, OR
- a feature that the scenario tests, OR
- a behavioural change that overlaps with the scenario's acceptance criteria.

Output a JSON array of objects, ONE PER IMPACTED scenario (skip non-impacted ones):
- id: the scenario id (echo back exactly)
- reason: ONE sentence — why this scenario is impacted (quote a relevant phrase from the release notes)

Output ONLY the JSON array. NO markdown fences. NO preamble.`;

function normaliseDiscrepancy(d) {
  if (!d || typeof d !== 'object') return null;
  const validKinds = ['in_brd_not_in_release', 'in_release_not_in_brd', 'spec_mismatch'];
  const kind = validKinds.includes(d.kind) ? d.kind : 'spec_mismatch';
  const summary = String(d.summary || '').slice(0, 300).trim();
  if (!summary) return null;
  const detail = String(d.detail || '').slice(0, 1500);
  const severity = ['info', 'warning', 'critical'].includes(d.severity) ? d.severity : 'info';
  return { kind, summary, detail, severity };
}

function normaliseImpact(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').trim();
  if (!id) return null;
  const reason = String(item.reason || '').slice(0, 500);
  return { id, reason };
}

async function detectDiscrepancies({ apiKey, model, documents, onLog = async () => {}, signal, onRateLimit, extraGuidance, provider: providerName }) {
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
  const provider = getProvider(providerName);
  const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });
  // Bucket by category
  const buckets = { brd: [], 'user-stories': [], 'release-notes': [], 'api-spec': [], other: [] };
  for (const d of documents) {
    const cat = buckets[d.category] ? d.category : 'other';
    buckets[cat].push({ name: d.name, content: (d.content || '').slice(0, 12_000) });
  }

  await onLog('info', `Comparing ${documents.length} document(s) across ${Object.values(buckets).filter((b) => b.length).length} categories…`);

  const userText = Object.entries(buckets)
    .filter(([, docs]) => docs.length)
    .map(([cat, docs]) =>
      `=== Category: ${cat} (${docs.length} doc${docs.length === 1 ? '' : 's'}) ===\n` +
      docs.map((d) => `--- ${d.name} ---\n${d.content}`).join('\n\n')
    )
    .join('\n\n\n')
    .slice(0, 80_000);

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model: routedModel,
      maxTokens: 4000,
      system: composeSystemPrompt(DISCREPANCY_SYSTEM, extraGuidance),
      messages: [{ role: 'user', content: userText }],
      signal,
      onRateLimit,
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
  const parsed = parseJsonResponse(text, { type: 'array' });
  if (!parsed) {
    console.error(`[analyst.discrepancies] PARSE FAILED. First 500 chars: ${text.slice(0, 500)}`);
    const err = new Error(`${provider.name} returned non-JSON.`);
    err.code = 'INVALID_AI_OUTPUT'; err.status = 502; throw err;
  }
  const discrepancies = parsed.map(normaliseDiscrepancy).filter(Boolean).slice(0, 12);
  await onLog('info', `Found ${discrepancies.length} discrepancy/-ies.`);
  return { discrepancies };
}

async function selectImpactedScenarios({ apiKey, model, scenarios, releaseNotesText, onLog = async () => {}, signal, onRateLimit, extraGuidance, provider: providerName }) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY'; err.status = 400; throw err;
  }
  if (signal?.aborted) {
    const err = new Error('Cancelled before start.');
    err.code = 'CANCELLED'; err.status = 499;
    throw err;
  }
  const provider = getProvider(providerName);
  const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });
  if (!scenarios?.length) return { impacted: [], code: 'NO_SCENARIOS' };
  if (!releaseNotesText || releaseNotesText.length < 20) {
    // Previously fell back to "mark ALL scenarios as impacted" — that was a
    // UI cliff: the user saw "20 of 20 impacted" and had no way to tell that
    // it actually meant "I don't have signal." Now we return nothing and a
    // `NO_RELEASE_NOTES` code; the route surfaces a clear banner asking the
    // user to upload a release-notes document.
    await onLog('warn', 'No release notes uploaded — cannot perform impact analysis.');
    return { impacted: [], code: 'NO_RELEASE_NOTES' };
  }

  await onLog('info', `Mapping ${scenarios.length} scenario(s) against release notes (${releaseNotesText.length} chars)…`);

  const compactScenarios = scenarios.map((s) => ({
    id: s.id, name: s.name, module: s.module, category: s.category, rationale: s.rationale,
  }));
  const userText = `## Scenarios\n${JSON.stringify(compactScenarios, null, 2)}\n\n## Release Notes\n${releaseNotesText.slice(0, 30_000)}`;

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model: routedModel,
      maxTokens: 3000,
      system: composeSystemPrompt(IMPACT_SYSTEM, extraGuidance),
      messages: [{ role: 'user', content: userText }],
      signal,
      onRateLimit,
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
  const parsed = parseJsonResponse(text, { type: 'array' });
  if (!parsed) {
    console.error(`[analyst.impact] PARSE FAILED. First 500 chars: ${text.slice(0, 500)}`);
    const err = new Error(`${provider.name} returned non-JSON.`);
    err.code = 'INVALID_AI_OUTPUT'; err.status = 502; throw err;
  }
  const impacted = parsed.map(normaliseImpact).filter(Boolean);
  await onLog('info', `${impacted.length} of ${scenarios.length} scenario(s) marked impacted.`);
  return { impacted };
}

module.exports = { detectDiscrepancies, selectImpactedScenarios, DISCREPANCY_SYSTEM, IMPACT_SYSTEM };
