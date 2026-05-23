'use strict';

/**
 * Gemini provider. Translates between Anthropic-canonical message/tool shape
 * (used internally by every agent) and Google Generative AI's `contents` +
 * `tools` shape.
 *
 * The agents never call this file directly — they go through llmProvider.js
 * which dispatches on `project.aiProvider`. Because the canonical shape is
 * Anthropic's, agent code is unchanged across providers; the translation lives
 * entirely here.
 *
 * Translation table:
 *   anthropic msg.role 'user'         <-> gemini content.role 'user'
 *   anthropic msg.role 'assistant'    <-> gemini content.role 'model'
 *   block {type:'text', text}                  <-> part {text}
 *   block {type:'tool_use', id, name, input}   <-> part {functionCall: {name, args}}
 *   block {type:'tool_result', tool_use_id, content}
 *                                              <-> part {functionResponse: {name, response:{result}}}
 *   block {type:'image', source:{type:'base64', media_type, data}}
 *                                              <-> part {inlineData: {mimeType, data}}
 *
 * Gemini's functionResponse needs a name, not a tool-use id. We walk the
 * full messages array once to build an id->name map, then translate. The
 * Conductor's loop guarantees tool_use blocks (with id+name) come before
 * their tool_result blocks, so the map is populated by the time we need it.
 *
 * Rate-limit: Gemini does not return per-request remaining-tokens headers.
 * onRateLimit is intentionally never called; the UI hides the rate-limit chip
 * when the active project is on Gemini.
 */

const crypto = require('crypto');

let _GoogleGenerativeAI = null;
function loadGoogle() {
  if (_GoogleGenerativeAI) return _GoogleGenerativeAI;
  try {
    _GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI;
    return _GoogleGenerativeAI;
  } catch (err) {
    const e = new Error(`@google/generative-ai not installed: ${err.message}`);
    e.code = 'GEMINI_SDK_MISSING';
    e.status = 500;
    throw e;
  }
}

async function complete({ apiKey, model, system, messages, tools, maxTokens, signal, onRateLimit, responseFormat }) {
  if (!apiKey) {
    const err = new Error('Gemini API key missing. Configure it in Settings → Gemini API.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  // onRateLimit is unused for Gemini — Google's API doesn't return the same
  // per-request remaining-tokens headers Anthropic does. Suppress the lint
  // warning by referencing it without invoking it.
  void onRateLimit;

  const GoogleGenerativeAI = loadGoogle();
  const client = new GoogleGenerativeAI(apiKey);

  const idToName = collectToolUseNames(messages);
  const contents = toGeminiMessages(messages, idToName);

  const hasTools = Array.isArray(tools) && tools.length > 0;
  const geminiTools = hasTools
    ? [{ functionDeclarations: tools.map(anthropicToolToGemini) }]
    : undefined;

  // JSON mode: Gemini guarantees a single raw JSON value with no markdown
  // fences or preamble when responseMimeType is 'application/json'. This is
  // the only reliable way to stop Gemini wrapping output in ```json fences —
  // it ignores the prompt instruction "no markdown fences" often enough that
  // we have to enforce it at the API level.
  //
  // The Gemini SDK rejects responseMimeType when functionDeclarations are
  // present in the same request, so we skip JSON mode whenever tools are
  // active (Architect, Conductor — those agents don't expect a JSON envelope
  // anyway; they read tool_use blocks).
  const generationConfig = { maxOutputTokens: maxTokens || 1500 };
  if (responseFormat === 'json' && !hasTools) {
    generationConfig.responseMimeType = 'application/json';
  }

  const generativeModel = client.getGenerativeModel({
    model: model || 'gemini-2.5-pro',
    systemInstruction: system ? { role: 'system', parts: [{ text: system }] } : undefined,
    tools: geminiTools,
    generationConfig,
    // Default safety filters on Gemini block legitimate QA content (form
    // errors, login pages, "invalid password" messages). The user owns the
    // SUT and the agent runs in a sandboxed automation context, so disable.
    safetySettings: [
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    ],
  });

  let resp;
  try {
    const result = await generativeModel.generateContent({ contents }, { signal });
    resp = result.response;
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      const aborted = new Error('Cancelled by user.');
      aborted.code = 'CANCELLED';
      aborted.status = 499;
      throw aborted;
    }
    // Translate the noisy `GoogleGenerativeAI Error: Error fetching from ...`
    // blob into a short, user-readable line. The original message is kept on
    // err.raw for debugging but the surfaced .message is clean.
    throw cleanGeminiError(err, model);
  }

  return geminiResponseToAnthropic(resp);
}

/**
 * Classify the noisy GoogleGenerativeAI error string into one of:
 *   - RATE_LIMIT       (429: quota exhausted; includes retry seconds)
 *   - MODEL_OVERLOADED (503: try again later)
 *   - GEMINI_SCHEMA_REJECTED (400: tool-schema field Gemini doesn't accept)
 *   - GEMINI_INVALID_KEY     (401/403: bad/missing key)
 *   - GEMINI_FAILED          (everything else — fallback)
 *
 * The clean message is what the agent logger surfaces to the Theater UI.
 */
function cleanGeminiError(err, model) {
  const raw = String(err?.message || err || '');
  const statusMatch = raw.match(/\[(\d{3})\s/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : (err?.status || 502);
  const modelLabel = model || 'gemini';

  if (status === 429) {
    // "Please retry in 58.81s" OR "retryDelay":"58s"
    let retrySec = null;
    const m1 = raw.match(/retry in (\d+(?:\.\d+)?)s/i);
    const m2 = raw.match(/"retryDelay"\s*:\s*"(\d+)s/);
    if (m1) retrySec = Math.ceil(parseFloat(m1[1]));
    else if (m2) retrySec = parseInt(m2[1], 10);
    const wait = retrySec ? ` Retry in ${retrySec}s.` : '';
    const tip = /free_tier/i.test(raw)
      ? ` Free-tier ${modelLabel} is rate-limited (5 RPM); switch to gemini-2.5-pro or a paid key.`
      : '';
    const clean = new Error(`Gemini quota exceeded.${wait}${tip}`);
    clean.code = 'RATE_LIMIT';
    clean.status = 429;
    if (retrySec != null) clean.retryAfter = retrySec;
    clean.raw = raw;
    return clean;
  }

  if (status === 503) {
    const clean = new Error(`Gemini model "${modelLabel}" is overloaded. Try again in a moment or switch model.`);
    clean.code = 'MODEL_OVERLOADED';
    clean.status = 503;
    clean.raw = raw;
    return clean;
  }

  if (status === 400) {
    const fieldMatch = raw.match(/Unknown name ["']([^"']+)["']/);
    if (fieldMatch) {
      const clean = new Error(`Gemini rejected tool-schema field "${fieldMatch[1]}". (Update sanitiseSchemaForGemini whitelist.)`);
      clean.code = 'GEMINI_SCHEMA_REJECTED';
      clean.status = 400;
      clean.raw = raw;
      return clean;
    }
    const clean = new Error(`Gemini rejected the request (400). Check the system prompt and tool schemas.`);
    clean.code = 'GEMINI_BAD_REQUEST';
    clean.status = 400;
    clean.raw = raw;
    return clean;
  }

  if (status === 401 || status === 403) {
    const clean = new Error('Gemini API key was rejected. Re-enter it in Settings → Gemini API.');
    clean.code = 'GEMINI_INVALID_KEY';
    clean.status = status;
    clean.raw = raw;
    return clean;
  }

  // Fallback — strip the noisy prefix but keep the gist.
  const tail = raw.replace(/^\[GoogleGenerativeAI Error\][:\s]+/, '').slice(0, 240);
  const clean = new Error(tail || 'Gemini call failed.');
  clean.code = err?.code || 'GEMINI_FAILED';
  clean.status = status;
  clean.raw = raw;
  return clean;
}

function collectToolUseNames(messages) {
  const map = new Map();
  for (const m of messages || []) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_use' && b.id && b.name) map.set(b.id, b.name);
      }
    }
  }
  return map;
}

function toGeminiMessages(messages, idToName) {
  const out = [];
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') {
      out.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    const parts = [];
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push({ text: b.text });
      } else if (b.type === 'tool_use') {
        parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      } else if (b.type === 'tool_result') {
        const name = idToName.get(b.tool_use_id) || 'unknown_tool';
        const text = stringifyToolResultContent(b.content);
        parts.push({ functionResponse: { name, response: { result: text } } });
      } else if (b.type === 'image' && b.source?.type === 'base64') {
        parts.push({
          inlineData: { mimeType: b.source.media_type || 'image/jpeg', data: b.source.data },
        });
      }
    }
    if (parts.length) out.push({ role, parts });
  }
  return out;
}

function stringifyToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c?.type === 'text') return c.text || '';
        if (c?.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
}

function anthropicToolToGemini(t) {
  return {
    name: t.name,
    description: t.description || '',
    parameters: sanitiseSchemaForGemini(t.input_schema) || { type: 'object', properties: {} },
  };
}

/**
 * Convert a JSON-Schema fragment into the subset Gemini's function-declaration
 * validator accepts. WHITELIST approach — the previous blacklist kept missing
 * keys (additionalProperties, then propertyNames, then patternProperties…).
 * Each new key dropped from upstream MCP tools tripped a 400. Whitelisting
 * fixes that class of bug at the root.
 *
 * Gemini supports an OpenAPI 3.0 schema subset. Per Google's docs, these are
 * explicitly NOT supported and cause 400 Bad Request: propertyNames,
 * patternProperties, additionalProperties, dependencies, dependentSchemas,
 * dependentRequired, not, if, then, else, $schema, $id, $ref, $defs,
 * definitions, examples, contentEncoding, contentMediaType.
 *
 * The Playwright MCP package ships tool schemas with several of these keys,
 * so the function-declarations payload would always fail without this filter.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  // Core type info
  'type', 'description', 'nullable', 'title',
  // Object shape
  'properties', 'required',
  // Array shape
  'items', 'minItems', 'maxItems',
  // Numeric constraints
  'minimum', 'maximum',
  // String constraints
  'minLength', 'maxLength', 'format', 'pattern',
  // Enumerations
  'enum',
  // Compositions (OpenAPI 3.0 supports these)
  'oneOf', 'anyOf', 'allOf',
]);

function sanitiseSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitiseSchemaForGemini);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) {
        out.properties[pk] = sanitiseSchemaForGemini(pv);
      }
    } else if (k === 'items') {
      out.items = sanitiseSchemaForGemini(v);
    } else if ((k === 'oneOf' || k === 'anyOf' || k === 'allOf') && Array.isArray(v)) {
      out[k] = v.map(sanitiseSchemaForGemini);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitiseSchemaForGemini(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Convert Gemini's response shape into Anthropic-canonical so callers
 * (architect.js reads resp.content[0].text; conductor.js iterates content
 * for tool_use blocks) keep working unchanged.
 */
function geminiResponseToAnthropic(resp) {
  const cand = resp?.candidates?.[0];
  const content = [];
  const parts = cand?.content?.parts || [];

  for (const p of parts) {
    if (typeof p.text === 'string' && p.text.length) {
      content.push({ type: 'text', text: p.text });
    } else if (p.functionCall) {
      content.push({
        type: 'tool_use',
        id: 'toolu_' + crypto.randomBytes(12).toString('hex'),
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      });
    }
  }

  if (content.length === 0) content.push({ type: 'text', text: '' });

  const fr = cand?.finishReason;
  let stop_reason = 'end_turn';
  if (fr === 'MAX_TOKENS') stop_reason = 'max_tokens';
  else if (fr === 'STOP') {
    stop_reason = content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn';
  } else if (fr === 'SAFETY' || fr === 'RECITATION' || fr === 'OTHER') {
    stop_reason = 'stop_sequence';
  } else if (content.some((c) => c.type === 'tool_use')) {
    stop_reason = 'tool_use';
  }

  const u = resp?.usageMetadata || {};
  const usage = {
    input_tokens: u.promptTokenCount ?? null,
    output_tokens: u.candidatesTokenCount ?? null,
  };

  return { content, stop_reason, usage };
}

module.exports = { complete, name: 'gemini' };
