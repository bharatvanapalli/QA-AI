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

async function complete({ apiKey, model, system, messages, tools, maxTokens, signal, onRateLimit }) {
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

  const geminiTools = Array.isArray(tools) && tools.length
    ? [{ functionDeclarations: tools.map(anthropicToolToGemini) }]
    : undefined;

  const generativeModel = client.getGenerativeModel({
    model: model || 'gemini-2.5-pro',
    systemInstruction: system ? { role: 'system', parts: [{ text: system }] } : undefined,
    tools: geminiTools,
    generationConfig: { maxOutputTokens: maxTokens || 1500 },
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
    if (!err.code) err.code = 'GEMINI_FAILED';
    if (!err.status) err.status = 502;
    throw err;
  }

  return geminiResponseToAnthropic(resp);
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
 * Strip JSON-Schema keys Gemini's function-declaration validator rejects.
 * Walks recursively into `properties` and `items`. `additionalProperties` in
 * particular causes 400 errors on Gemini.
 */
function sanitiseSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const REJECTED = new Set([
    '$schema', '$id', '$ref', 'definitions', '$defs', 'examples', 'additionalProperties',
  ]);
  if (Array.isArray(schema)) return schema.map(sanitiseSchemaForGemini);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (REJECTED.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) {
        out.properties[pk] = sanitiseSchemaForGemini(pv);
      }
    } else if (k === 'items') {
      out.items = sanitiseSchemaForGemini(v);
    } else if (v && typeof v === 'object') {
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
