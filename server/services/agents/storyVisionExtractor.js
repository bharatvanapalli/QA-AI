'use strict';

/**
 * Agent — Story Vision Extractor (Multimodal Ingestion / Phase M0).
 *
 * Reads ONE screenshot from an uploaded requirements/user-story document (a
 * standalone image, a scanned PDF page, or a screenshot embedded in a PDF) and
 * TRANSCRIBES what is visible — faithfully and completely — plus the UI STATES
 * a tester must verify (disabled / required / checked / ABSENT controls).
 *
 * Design principle: ADAPTER, NOT REWRITE. The output `transcription` is treated
 * downstream as the document's source text, so the existing requirementOracle
 * extracts clauses from it with VERBATIM excerpts (verifyExcerpt). We never
 * paraphrase a requirement into a new shape — we transcribe and let the proven
 * extractor segregate it. The structured facts (controls / absentExpected /
 * candidateAssertions) are returned for later phases (clause merge, evidence,
 * pixel-accurate assertions) but the transcription alone makes M0 useful.
 *
 * Provider-agnostic via the canonical Anthropic image block; the gemini provider
 * translates to inlineData at its boundary. Mirrors instructionReader.js exactly.
 * Cancellation-aware. Routed to the mid tier (Haiku 4.5 / Gemini Flash — both
 * vision-capable) since faithful transcription is well within their range.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPromptCached } = require('../../lib/promptCompose');
const { parseJsonResponse } = require('../../lib/parseJsonResponse');
const { resolveModelForTier } = require('../../lib/modelRouter');

const TIER = 'mid';

const SYSTEM_PROMPT = `You are a requirements transcriber for a QA platform. You will receive ONE screenshot taken from a software requirements / user-story document. It usually shows an application UI (a form, dialog, screen, table) or a diagram.

Your job is to TRANSCRIBE what is visible — faithfully and completely — and to report the UI STATES a tester would need to verify. Do NOT invent, do NOT infer business rules, do NOT describe anything that is not actually visible.

Produce a SINGLE JSON object — no markdown, no preamble:
{
  "transcription": "<a faithful, readable text rendering of EVERYTHING visible, in reading order: titles, labels, field names, button text, placeholder/helper text, table headers and cells, validation/error copy. For each interactive control whose STATE is visually evident, note the state inline in parentheses, e.g. 'Partner Name (textbox, disabled)', 'Create (button, disabled)', 'Payor Type (radio, disabled)'. If a control the surrounding context clearly expects is NOT present, write a line 'NOT PRESENT: <control>'.>",
  "controls": [ { "label": "<visible label>", "role": "<button|textbox|radio|checkbox|combobox|link|tab|heading|...>", "state": "<enabled|disabled|required|readonly|checked|unchecked|selected|unknown>" } ],
  "absentExpected": [ "<a control a reader would expect from the document context but that is visibly absent>" ],
  "candidateAssertions": [ { "text": "<a single, independently checkable statement grounded ONLY in what is visible>", "kind": "<text|state|presence|absence>" } ],
  "confidence": <0-99 integer>
}

Rules:
- Transcribe VERBATIM where text is legible. NEVER paraphrase a label or a sentence — copy it.
- Only report a STATE when it is visually unambiguous (greyed-out = disabled; red asterisk = required; ticked box = checked; selected radio = selected). If unsure, use "unknown" and do NOT assert it.
- absentExpected / kind:"absence" ONLY when the document context makes the absence meaningful (e.g. a checkbox present on a sibling screen is missing here). Do NOT list every conceivable missing control.
- Each candidateAssertion must be independently checkable and grounded in the image. No business reasoning, no "should probably", no requirements you cannot see.
- If the image is decorative / a logo / blank / unreadable, return {"transcription":"","controls":[],"absentExpected":[],"candidateAssertions":[],"confidence":0}.
- JSON only. No code fences, no commentary outside the JSON.`;

const VALID_STATES = new Set([
  'enabled', 'disabled', 'required', 'readonly', 'checked', 'unchecked', 'selected', 'unknown',
]);
const VALID_KINDS = new Set(['text', 'state', 'presence', 'absence']);

function normaliseResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const transcription = String(raw.transcription || '').slice(0, 20_000).trim();
  const controls = (Array.isArray(raw.controls) ? raw.controls : [])
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const label = String(c.label || '').slice(0, 200).trim();
      if (!label) return null;
      const role = String(c.role || '').slice(0, 40).toLowerCase().trim() || 'unknown';
      let state = String(c.state || '').slice(0, 20).toLowerCase().trim();
      if (!VALID_STATES.has(state)) state = 'unknown';
      return { label, role, state };
    })
    .filter(Boolean)
    .slice(0, 60);
  const absentExpected = (Array.isArray(raw.absentExpected) ? raw.absentExpected : [])
    .map((s) => String(s || '').slice(0, 200).trim())
    .filter(Boolean)
    .slice(0, 20);
  const candidateAssertions = (Array.isArray(raw.candidateAssertions) ? raw.candidateAssertions : [])
    .map((a) => {
      if (!a || typeof a !== 'object') return null;
      const text = String(a.text || '').slice(0, 300).trim();
      if (!text) return null;
      let kind = String(a.kind || '').slice(0, 20).toLowerCase().trim();
      if (!VALID_KINDS.has(kind)) kind = 'text';
      return { text, kind };
    })
    .filter(Boolean)
    .slice(0, 40);
  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(99, Math.round(confidence)));
  return { transcription, controls, absentExpected, candidateAssertions, confidence };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.provider
 * @param {string} opts.imageBase64  Base64-encoded image bytes (no data: prefix)
 * @param {string} [opts.mediaType]  'image/png' (default) | 'image/jpeg' | 'image/webp'
 * @param {string} [opts.docContext] Optional: the document/file name or surrounding text,
 *                                    to help the model judge what an "expected" control is.
 * @param {function} [opts.onLog]
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onRateLimit]
 * @param {string} [opts.extraGuidance]
 * @returns {Promise<{ transcription, controls, absentExpected, candidateAssertions, confidence } | null>}
 */
async function extractStoryVisuals({
  apiKey, model, provider: providerName,
  imageBase64, mediaType = 'image/png', docContext,
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
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return null;
  }

  const provider = getProvider(providerName);
  const routedModel = resolveModelForTier({ provider: providerName, requestedModel: model, tier: TIER });
  await onLog('info', 'Vision: transcribing screenshot for requirement/assertion extraction…');

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model: routedModel,
      maxTokens: 3000,
      system: composeSystemPromptCached(SYSTEM_PROMPT, extraGuidance),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: docContext
                ? `This screenshot is from the document "${String(docContext).slice(0, 200)}". Transcribe everything visible and report the UI states a tester must verify.`
                : 'Transcribe everything visible in this screenshot and report the UI states a tester must verify.',
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64,
              },
            },
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
    await onLog('warn', `Vision extraction call failed: ${err.message}`);
    return null;
  }

  const text =
    resp?.content?.find?.((b) => b?.type === 'text')?.text ||
    resp?.text || resp?.output_text || '';
  let parsed;
  try {
    parsed = parseJsonResponse(text);
  } catch (err) {
    await onLog('warn', `Vision extraction returned unparseable JSON: ${err.message}`);
    return null;
  }
  const result = normaliseResult(parsed);
  if (!result) {
    await onLog('warn', 'Vision extraction output failed schema validation.');
    return null;
  }
  await onLog('info',
    `Vision extracted ${result.transcription.length} char(s), ${result.controls.length} control(s), ${result.absentExpected.length} absent-expected, ${result.candidateAssertions.length} candidate assertion(s) (confidence ${result.confidence}).`);
  return result;
}

/**
 * Render the structured vision result into a faithful text block suitable for
 * the requirementOracle (the ADAPTER output). The transcription leads; the
 * states / absences / candidate assertions are appended as clearly-delimited
 * verbatim lines so the oracle can extract them as testable clauses with
 * verbatim excerpts. SUT-generic — no site-specific strings.
 */
function visualResultToText(result, { sourceName } = {}) {
  if (!result) return '';
  const lines = [];
  if (sourceName) lines.push(`[Visual source: ${sourceName}]`);
  if (result.transcription) lines.push(result.transcription);
  const stateful = (result.controls || []).filter((c) => c.state && c.state !== 'unknown' && c.state !== 'enabled');
  if (stateful.length) {
    lines.push('', 'Visible UI states:');
    for (const c of stateful) lines.push(`- ${c.label} (${c.role}) is ${c.state}.`);
  }
  if ((result.absentExpected || []).length) {
    lines.push('', 'Controls not present on this screen:');
    for (const a of result.absentExpected) lines.push(`- ${a} is NOT present.`);
  }
  if ((result.candidateAssertions || []).length) {
    lines.push('', 'Observable from the screenshot:');
    for (const a of result.candidateAssertions) lines.push(`- ${a.text}`);
  }
  return lines.join('\n').trim();
}

module.exports = { extractStoryVisuals, visualResultToText };
