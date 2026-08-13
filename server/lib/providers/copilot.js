'use strict';

/**
 * GitHub Copilot provider adapter.
 * Connects QAAI Portal to the VS Code GitHub Copilot Bridge (http://127.0.0.1:5005)
 * or direct Copilot endpoints.
 *
 * Translates canonical Anthropic-style request/response shapes to OpenAI/Copilot
 * Chat Completions payloads.
 */

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:5005';

function transformMessagesToOpenAI(system, messages) {
  const openAiMessages = [];

  if (system) {
    openAiMessages.push({ role: 'system', content: String(system) });
  }

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          openAiMessages.push({ role: 'user', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const textPart = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
          openAiMessages.push({ role: 'user', content: textPart || JSON.stringify(msg.content) });
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          openAiMessages.push({ role: 'assistant', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const textPart = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
          const toolCalls = msg.content
            .filter((c) => c.type === 'tool_use')
            .map((c) => ({
              id: c.id || `call_${Date.now()}`,
              type: 'function',
              function: {
                name: c.name,
                arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input || {}),
              },
            }));

          openAiMessages.push({
            role: 'assistant',
            content: textPart || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
      }
    }
  }

  return openAiMessages;
}

function transformToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
    },
  }));
}

function transformResponseToCanonical(data) {
  const choice = data?.choices?.[0];
  const msg = choice?.message;
  const contentBlocks = [];

  if (msg?.content) {
    contentBlocks.push({ type: 'text', text: msg.content });
  }

  if (Array.isArray(msg?.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let parsedArgs = {};
      try {
        parsedArgs = typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : (tc.function?.arguments || {});
      } catch (_) {
        parsedArgs = { raw: tc.function?.arguments };
      }

      contentBlocks.push({
        type: 'tool_use',
        id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
        name: tc.function?.name,
        input: parsedArgs,
      });
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: 'text', text: '' });
  }

  const isTool = contentBlocks.some((b) => b.type === 'tool_use');
  const stopReason = isTool ? 'tool_use' : (choice?.finish_reason === 'stop' ? 'end_turn' : 'end_turn');

  return {
    content: contentBlocks,
    stop_reason: stopReason,
    usage: {
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    },
  };
}

async function complete({ apiKey, model, system, messages, tools, maxTokens, signal, baseUrl }) {
  const targetUrl = (baseUrl || process.env.COPILOT_BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
  const endpoint = `${targetUrl}/v1/chat/completions`;

  const payload = {
    model: model || 'copilot-gpt-4o',
    messages: transformMessagesToOpenAI(system, messages),
    ...(tools ? { tools: transformToolsToOpenAI(tools) } : {}),
    ...(maxTokens ? { max_tokens: Math.min(16384, maxTokens) } : {}),
  };

  console.log(`[COPILOT BRIDGE] Routing LLM call to VS Code Bridge (${endpoint}) for model: ${payload.model}`);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (netErr) {
    const err = new Error(`Failed to connect to GitHub Copilot Bridge at ${targetUrl}. Is VS Code running with the QAAI Copilot Bridge extension active? (${netErr.message})`);
    err.code = 'COPILOT_BRIDGE_UNREACHABLE';
    err.status = 503;
    throw err;
  }

  if (!response.ok) {
    let errBody = '';
    try { errBody = await response.text(); } catch (_) {}
    const err = new Error(`GitHub Copilot Bridge returned HTTP ${response.status}: ${errBody}`);
    err.status = response.status;
    err.code = 'COPILOT_API_ERROR';
    throw err;
  }

  const data = await response.json();
  return transformResponseToCanonical(data);
}

module.exports = {
  name: 'copilot',
  complete,
};
