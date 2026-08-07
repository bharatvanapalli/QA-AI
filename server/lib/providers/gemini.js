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
const { recordDegradation } = require('../degradationSignal');

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

function boundedRequestRetries(value, fallback = 1) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(2, Math.floor(parsed)));
}

function boundedRequestTimeout(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(600_000, Math.floor(parsed)));
}

function requestPolicy({ timeoutMs, maxRetries } = {}) {
  const retries = boundedRequestRetries(maxRetries, 1);
  return {
    timeoutMs: boundedRequestTimeout(timeoutMs),
    maxRetries: retries,
    maxAttempts: retries + 1,
  };
}

function requestSignal(parentSignal, timeoutMs) {
  const boundedTimeout = boundedRequestTimeout(timeoutMs);
  if (boundedTimeout == null) {
    return { signal: parentSignal, timedOut: () => false, cleanup: () => {} };
  }

  const controller = new AbortController();
  let timeoutReached = false;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, boundedTimeout);

  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.('abort', abortFromParent);
    },
  };
}

async function complete({ apiKey, model, system, messages, tools, maxTokens, signal, onRateLimit, responseFormat, temperature, timeoutMs, maxRetries }) {
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
  // Optional caller-pinned sampling temperature. Authoring stages (Architect)
  // pin this LOW (~0.3) to kill run-to-run scenario-count variance; everywhere
  // else it stays unset → Gemini's default. Clamp to the valid [0,2] range.
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    generationConfig.temperature = Math.max(0, Math.min(2, temperature));
  }

  // SPEED + CORRECTNESS — Gemini 2.5 models run extended "thinking" by DEFAULT.
  // Two distinct failures in a multi-turn agent loop (30+ calls per case):
  //   1) Latency: thinking adds many seconds to EVERY call — the single
  //      largest time sink.
  //   2) Empty responses: thinking tokens draw down maxOutputTokens. With a
  //      tight cap (the Conductor uses 1500) Pro can spend the ENTIRE budget
  //      thinking and return finishReason=MAX_TOKENS with ZERO content parts.
  //      The agent loop then sees an assistant turn with no text and no tool
  //      call — i.e. "no response from the Conductor" — and stalls until the
  //      turn ceiling. This is the Pro-specific breakage.
  //
  // Flash-class models let us disable thinking outright (thinkingBudget: 0).
  // Pro CANNOT disable it (valid floor is 128) — so we cap it LOW and, whenever
  // a budget is in play, add that budget ON TOP of maxOutputTokens so the real
  // answer always has room. Override with QAAI_GEMINI_THINKING_BUDGET (clamped
  // to >= 128 for non-flash models, since 0 would 400 on Pro).
  const modelStr = String(model || '').trim();
  const envBudgetRaw = process.env.QAAI_GEMINI_THINKING_BUDGET;
  const envBudget = envBudgetRaw != null && envBudgetRaw !== '' ? Number(envBudgetRaw) : null;
  let thinkingBudget = null;
  if (/flash/i.test(modelStr)) {
    // Flash: 0 = thinking off (fastest, the default).
    thinkingBudget = (envBudget != null && Number.isFinite(envBudget) && envBudget >= 0) ? envBudget : 0;
  } else if (/gemini-2|2\.5|2\.0/i.test(modelStr)) {
    // Pro / other non-flash 2.x: thinking can't be disabled. Keep it low so
    // Pro stays usable in the loop and never starves output. Clamp to >= 128.
    const want = (envBudget != null && Number.isFinite(envBudget)) ? envBudget : 256;
    thinkingBudget = Math.max(128, want);
  } else {
    // UNKNOWN / future model string — the flash-vs-Pro heuristic is keyed off the
    // model name, which we don't recognise here. Do NOT guess a thinkingConfig:
    // sending thinkingBudget=0 to a model that requires a floor 400s the request,
    // and sending a floor to a non-thinking model is equally wrong. The only safe
    // move on an unrecognised name is to OMIT thinkingConfig entirely and let the
    // API apply its own default — but honour an explicit operator override when set.
    if (envBudget != null && Number.isFinite(envBudget) && envBudget >= 0) {
      thinkingBudget = envBudget;
    }
  }
  if (thinkingBudget != null && Number.isFinite(thinkingBudget) && thinkingBudget >= 0) {
    generationConfig.thinkingConfig = { thinkingBudget };
    // Thinking tokens count against maxOutputTokens — guarantee headroom for
    // the actual answer on top of the thinking budget, or the model can spend
    // the whole cap thinking and return nothing (the failure described above).
    if (thinkingBudget > 0) {
      generationConfig.maxOutputTokens = (maxTokens || 1500) + thinkingBudget;
    }
  }

  // P1-4 — accept the Anthropic-style array-of-content-blocks `system`
  // shape so the same composeSystemPrompt() output works for both
  // providers. Cache hints are silently dropped here (Gemini has no
  // equivalent today); the text content is concatenated.
  const systemText = Array.isArray(system)
    ? system.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n\n')
    : (typeof system === 'string' ? system : '');
  const generativeModel = client.getGenerativeModel({
    model: model || 'gemini-2.5-pro',
    systemInstruction: systemText ? { role: 'system', parts: [{ text: systemText }] } : undefined,
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

  // BOUNDED retry on 429 — a single short backoff for a transient burst, then
  // FAIL FAST. The previous policy (10 attempts × up to 90s) let an exhausted
  // key hang a run for ~10 minutes with no honest signal — the breaker can't
  // help because it deliberately excludes 429. We now cap the TOTAL in-process
  // wait so the run fails promptly and the operator can switch keys/provider.
  //   - at most 2 attempts (1 retry)
  //   - single wait clamped to 30s AND the cumulative wait clamped to 60s
  // On exhaustion we recordDegradation (honest, loud) and throw the clean 429.
  const policy = requestPolicy({ timeoutMs, maxRetries });
  const MAX_ATTEMPTS = policy.maxAttempts;
  const MAX_SINGLE_WAIT_MS = 30_000;
  const MAX_TOTAL_WAIT_MS = 60_000;
  let spentWaitMs = 0;

  let resp;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const activeRequest = requestSignal(signal, policy.timeoutMs);
    try {
      const result = await generativeModel.generateContent({ contents }, { signal: activeRequest.signal });
      resp = result.response;
      break;
    } catch (err) {
      if (activeRequest.timedOut() && !signal?.aborted) {
        const timedOut = new Error(`Gemini request exceeded its ${policy.timeoutMs}ms deadline.`);
        timedOut.code = 'GEMINI_TIMEOUT';
        timedOut.status = 504;
        throw timedOut;
      }
      if (err?.name === 'AbortError' || signal?.aborted) {
        const aborted = new Error('Cancelled by user.');
        aborted.code = 'CANCELLED';
        aborted.status = 499;
        throw aborted;
      }
      const clean = cleanGeminiError(err, model);
      if (clean.code === 'RATE_LIMIT' && !signal?.aborted) {
        // Use Gemini's suggested delay when offered; else a single short backoff.
        const suggestedMs = clean.retryAfter != null ? clean.retryAfter * 1000 : 15_000;
        let waitMs = Math.min(suggestedMs, MAX_SINGLE_WAIT_MS);
        // Never let the cumulative wait exceed the total budget; if even the
        // clamped wait would blow it, don't bother waiting — fail fast now.
        const remainingBudget = MAX_TOTAL_WAIT_MS - spentWaitMs;
        if (attempt < MAX_ATTEMPTS - 1 && waitMs <= remainingBudget && remainingBudget > 0) {
          spentWaitMs += waitMs;
          console.log(`[gemini] 429 rate-limit (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — retrying in ${Math.round(waitMs / 1000)}s (bounded fail-fast)`);
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, waitMs);
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('Cancelled by user.'), { code: 'CANCELLED', status: 499 })); }, { once: true });
          });
          continue;
        }
        // Out of retries / out of budget — surface honestly and fail fast.
        recordDegradation({
          onLog: (level, message) => console.warn(`[gemini] ${level}: ${message}`),
          stage: 'gemini-rate-limit',
          severity: 'error',
          reason: `Gemini returned 429 (quota exhausted) and the bounded in-process retry budget (<=${MAX_TOTAL_WAIT_MS / 1000}s) is spent`,
          impact: 'the LLM call failed fast instead of hanging; the run will not complete until the key/provider has quota — switch provider or wait for the quota window to reset',
          code: 'degraded_gemini_rate_limit',
        });
      }
      throw clean;
    } finally {
      activeRequest.cleanup();
    }
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
    // "free_tier" appears in Google's quota-exceeded body only for keys that
    // are genuinely on the free AI Studio tier (no GCP billing). Show a
    // targeted tip in that case; for paid keys just point to the quota console.
    const isFreeQuota = /free_tier/i.test(raw);
    const tip = isFreeQuota
      ? ` Your AI Studio key is on the free tier (5–15 RPM limit). To remove limits, link your Google Cloud project to a billing account at console.cloud.google.com and re-generate your key.`
      : ` Your quota has been exhausted. Check usage and limits at console.cloud.google.com/apis/api/generativelanguage.googleapis.com.`;
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

module.exports = {
  complete,
  name: 'gemini',
  __test__: {
    requestPolicy,
    setGoogleGenerativeAI(value) { _GoogleGenerativeAI = value; },
  },
};
