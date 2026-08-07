'use strict';

/**
 * Agent — Story Behavior Extractor (ADO/text lane, Phase A).
 *
 * Turns a rich TEXT work item (ADO/Jira story: Title / Description / Acceptance
 * Criteria / Business Rules / a prose "Test Data" section) into a STRUCTURED
 * behavior model that storyBehaviorModel.generateScenariosFromBehaviorModel()
 * deterministically expands into scenarios + synthetic data + requiredEvidence.
 *
 * Why an LLM (per CLAUDE.md "Node unless genuine novelty"): EXTRACTING fields,
 * constraints (maxLength / counter / maxCount), and business rules from messy
 * prose is genuine semantic reasoning a regex can't do reliably. GENERATING the
 * test rows/evidence from the extracted constraints is deterministic and stays
 * in Node (storyBehaviorModel.js). So this agent only EXTRACTS.
 *
 * Flagship tier (not mid): missing a single constraint (a maxLength, a "max 5"
 * rule) silently drops a whole class of tests — extraction accuracy is
 * high-stakes, so it respects the project's chosen model.
 *
 * Output (schema-validated + coerced by normaliseBehaviorModel — never trusts
 * raw LLM JSON):
 *   { actor, feature, preconditions[], actions[],
 *     fields[{ name, role, optional?, maxLength?, minLength?, counterRequired?, format?, example? }],
 *     businessRules[{ kind, entity?, max?, action?, message?, order?, control? }] }
 *   businessRules.kind ∈ max_count | confirmation_required | ordering | edit_moves_to_top | disabled_when_full
 *
 * Provider-agnostic; cancellation-aware. Mirrors instructionReader.js.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPromptCached } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');

const STORY_BEHAVIOR_TIMEOUT_MS = Number(process.env.QAAI_STORY_BEHAVIOR_TIMEOUT_MS || 12_000);

const VALID_RULE_KINDS = new Set([
  'max_count', 'confirmation_required', 'ordering', 'edit_moves_to_top', 'disabled_when_full',
]);

const SYSTEM_PROMPT = `You are a Lead SDET reading a single work item (an ADO/Jira story, feature, or bug — Title, Description, Acceptance Criteria, Business Rules, and sometimes a "Test Data" section). Extract a STRUCTURED behavior model a test generator can use. Extract ONLY what the text states or clearly implies — do NOT invent constraints, limits, or fields the text does not mention.

Return a SINGLE JSON object, no markdown:
{
  "actor": "who performs the actions (e.g. 'authorized operations user')",
  "feature": "short capability name (e.g. 'User profile Notes')",
  "preconditions": ["e.g. 'Admin is logged in'"],
  "actions": ["the main user actions, e.g. 'add note', 'edit note', 'delete note'"],
  "fields": [
    {
      "name": "the field's UI name (e.g. 'Note', 'Email', 'Subsidiary')",
      "role": "one of: noteText | text | email | select | number | date | password | other",
      "optional": true,                         // ONLY if the text says the field is optional
      "maxLength": 200,                          // ONLY if the text states a max character limit
      "minLength": 0,
      "counterRequired": true,                   // ONLY if the text says a character counter is displayed
      "format": "email",                         // ONLY if the text states a value format
      "example": "user@example.com" // a sample value from the text, if any
    }
  ],
  "businessRules": [
    // Use ONLY these kinds. Omit fields you cannot fill from the text.
    { "kind": "max_count", "entity": "Notes", "max": 5, "control": "Add Note", "message": "the exact disabled message if stated" },
    { "kind": "confirmation_required", "action": "delete note", "message": "the exact confirmation prompt if stated" },
    { "kind": "ordering", "order": "newest_first" },
    { "kind": "edit_moves_to_top" },
    { "kind": "disabled_when_full", "control": "Add Note" }
  ]
}

Strict rules:
  - Include a numeric maxLength / max ONLY when the text gives a number. Never guess a limit.
  - Quote message/prompt text VERBATIM from the story when present (these become evidence hints).
  - Omit any field/property you cannot ground in the text. An empty array is fine.
  - JSON only. No code fences, no commentary.`;

function s(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : ''; }
function sArr(a, n, lim) { return Array.isArray(a) ? a.map((x) => s(x, n)).filter(Boolean).slice(0, lim) : []; }
function posIntOrNull(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; }

/**
 * Deterministically validate + coerce a raw LLM behavior model. NEVER trust raw
 * LLM JSON — a malformed/over-claimed model would generate wrong tests. Drops
 * unnamed fields and unknown rule kinds; coerces numbers/booleans; returns null
 * when there is no testable structure (no fields AND no rules). Pure; exported
 * for tests.
 */
function normaliseBehaviorModel(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const fields = (Array.isArray(raw.fields) ? raw.fields : [])
    .map((f) => {
      if (!f || typeof f !== 'object') return null;
      const name = s(f.name, 80);
      if (!name) return null;
      const out = { name, role: s(f.role, 40) || 'input' };
      if (f.optional === true) out.optional = true;
      const maxL = posIntOrNull(f.maxLength); if (maxL) out.maxLength = maxL;
      const minL = posIntOrNull(f.minLength); if (minL) out.minLength = minL;
      if (f.counterRequired === true) out.counterRequired = true;
      const fmt = s(f.format, 40); if (fmt) out.format = fmt;
      const ex = s(f.example, 120); if (ex) out.example = ex;
      return out;
    })
    .filter(Boolean)
    .slice(0, 40);

  const businessRules = (Array.isArray(raw.businessRules) ? raw.businessRules : [])
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const kind = s(r.kind, 40);
      if (!VALID_RULE_KINDS.has(kind)) return null;
      const out = { kind };
      const entity = s(r.entity, 60); if (entity) out.entity = entity;
      const max = posIntOrNull(r.max); if (max) out.max = max;
      const action = s(r.action, 60); if (action) out.action = action;
      const message = s(r.message, 300); if (message) out.message = message;
      const order = s(r.order, 40); if (order) out.order = order;
      const control = s(r.control, 60); if (control) out.control = control;
      return out;
    })
    .filter(Boolean)
    .slice(0, 30);

  const model = {
    actor: s(raw.actor, 120),
    feature: s(raw.feature, 160),
    preconditions: sArr(raw.preconditions, 200, 20),
    actions: sArr(raw.actions, 120, 30),
    fields,
    businessRules,
  };
  // No fields AND no rules → no testable structure to generate from.
  if (!model.fields.length && !model.businessRules.length) return null;
  return model;
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model           the project's resolved (flagship) model id
 * @param {string} opts.provider
 * @param {string} opts.storyText       the raw ADO/Jira work-item text
 * @param {function} [opts.onLog]
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onRateLimit]
 * @param {string} [opts.extraGuidance]
 * @returns {Promise<object|null>} normalised behavior model, or null
 */
async function extractBehaviorModel({
  apiKey, model, provider: providerName, storyText,
  onLog = async () => {}, signal, onRateLimit, extraGuidance,
} = {}) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY'; err.status = 400;
    throw err;
  }
  if (signal?.aborted) {
    const err = new Error('Cancelled before start.');
    err.code = 'CANCELLED'; err.status = 499;
    throw err;
  }
  const text = typeof storyText === 'string' ? storyText.trim() : '';
  if (!text) return null;

  const provider = getProvider(providerName);
  // Flagship: extraction accuracy is high-stakes, so use the project's model
  // (NOT the mid-tier downgrade) — a missed constraint drops a whole test class.
  await onLog('info', 'StoryBehaviorExtractor parsing requirement text into a behavior model…');

  let resp;
  try {
    const controller = new AbortController();
    let parentAbortHandler = null;
    let timedOut = false;
    let timeout = null;
    if (signal && typeof signal.addEventListener === 'function') {
      parentAbortHandler = () => {
        try { controller.abort(); } catch (_) { /* ignore */ }
      };
      signal.addEventListener('abort', parentAbortHandler, { once: true });
    }
    try {
      const callPromise = provider.complete({
        apiKey,
        model,
        maxTokens: 2000,
        system: composeSystemPromptCached(SYSTEM_PROMPT, extraGuidance),
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `Extract the behavior model from this work item:\n\n${text.slice(0, 16000)}` }],
        }],
        signal: controller.signal,
        onRateLimit,
        responseFormat: 'json',
      });
      // Some provider SDK paths do not settle promptly after AbortController
      // aborts. Race the call so this optional enrichment can never pin the
      // whole scenario generation pipeline.
      callPromise.catch(() => {});
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          try { controller.abort(); } catch (_) { /* ignore */ }
          reject(new Error(`StoryBehaviorExtractor exceeded ${Math.round(STORY_BEHAVIOR_TIMEOUT_MS / 1000)}s.`));
        }, STORY_BEHAVIOR_TIMEOUT_MS);
      });
      resp = await Promise.race([callPromise, timeoutPromise]);
    } catch (err) {
      if (timedOut) {
        await onLog('warn', `StoryBehaviorExtractor exceeded ${Math.round(STORY_BEHAVIOR_TIMEOUT_MS / 1000)}s; continuing without behavior-model enrichment.`);
        return null;
      }
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal && parentAbortHandler && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', parentAbortHandler);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) {
      const cancelled = new Error('Cancelled.');
      cancelled.code = 'CANCELLED'; cancelled.status = 499;
      throw cancelled;
    }
    await onLog('warn', `StoryBehaviorExtractor call failed: ${err.message}`);
    return null;
  }

  const out = resp?.content?.find?.((b) => b?.type === 'text')?.text || resp?.text || resp?.output_text || '';
  let parsed;
  try {
    parsed = parseJsonResponse(out);
  } catch (err) {
    await onLog('warn', `StoryBehaviorExtractor returned unparseable JSON: ${err.message}`);
    return null;
  }
  const model2 = normaliseBehaviorModel(parsed);
  if (!model2) {
    await onLog('info', 'StoryBehaviorExtractor: no testable structure found in this work item.');
    return null;
  }
  await onLog('info', `StoryBehaviorExtractor extracted ${model2.fields.length} field(s) + ${model2.businessRules.length} business rule(s).`);
  return model2;
}

// Story-like content gate — avoid spending an LLM call on a doc that carries no
// constraints/rules to extract. Generic signals, not site strings.
const STORY_SIGNAL = /acceptance criteria|business rule|given\b[\s\S]*\bwhen\b[\s\S]*\bthen\b|max(?:imum)?\s+(?:of\s+)?\d|character\s+(?:limit|count)|optional field|confirmation|must not/i;

/**
 * Shared ADO-grounding builder used by BOTH generation routes (agents.js +
 * scenarios.js) so the wiring can't drift. Best-effort: extracts a behavior
 * model from each story-like requirement, generates its scenario classes, and
 * returns one combined Architect grounding block (or null). Propagates CANCELLED
 * (so Terminate works); skips a requirement on any other extraction error.
 */
async function buildBehaviorGroundingFromRequirements({
  requirements, apiKey, model, provider, signal, onRateLimit,
  onLog = async () => {}, isCancelled,
} = {}) {
  const { generateScenariosFromBehaviorModel, behaviorModelToGroundingBlock } = require('../storyBehaviorModel');
  const blocks = [];
  for (const r of (Array.isArray(requirements) ? requirements : [])) {
    if (typeof isCancelled === 'function' && isCancelled()) break;
    const storyText = (r && typeof r.content === 'string') ? r.content : '';
    if (storyText.trim().length < 60 || !STORY_SIGNAL.test(storyText)) continue;
    let bm = null;
    try {
      bm = await extractBehaviorModel({ apiKey, model, provider, storyText, signal, onRateLimit, onLog });
    } catch (e) {
      if (e && e.code === 'CANCELLED') throw e;
      continue; // best-effort per requirement
    }
    if (!bm) continue;
    const block = behaviorModelToGroundingBlock(bm, generateScenariosFromBehaviorModel(bm));
    if (block) blocks.push(block);
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

module.exports = { extractBehaviorModel, normaliseBehaviorModel, buildBehaviorGroundingFromRequirements };
