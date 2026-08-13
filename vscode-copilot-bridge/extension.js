'use strict';

const vscode = require('vscode');
const http = require('http');

let server = null;
let outputChannel = null;

function log(msg) {
  if (outputChannel) outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  console.log(`[qaai-copilot-bridge] ${msg}`);
}

async function handleChatCompletion(req, res) {
  let bodyStr = '';
  req.on('data', (chunk) => { bodyStr += chunk; });
  req.on('end', async () => {
    try {
      const payload = JSON.parse(bodyStr || '{}');
      log(`Received request for model: ${payload.model || 'copilot-default'}`);

      // 1. Select Copilot chat model from VS Code Language Model API
      let models = [];
      try {
        models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
      } catch (e) {
        log(`Select gpt-4o failed: ${e.message}`);
      }
      if (!models || models.length === 0) {
        try {
          models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        } catch (_) {}
      }
      if (!models || models.length === 0) {
        models = await vscode.lm.selectChatModels({});
      }

      if (!models || models.length === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: {
            message: 'No active Copilot Language Model found in VS Code. Please ensure GitHub Copilot extension is signed in.',
            type: 'COPILOT_NOT_AVAILABLE',
          },
        }));
      }

      log(`Available VS Code LM models: ${models.map(m => `${m.id} (${m.name})`).join(', ')}`);

      // Pick selected model, preferring gpt-4o or standard copilot models over restricted ones
      const targetModelName = (payload.model || '').toLowerCase();
      let selectedModel = models.find((m) => (m.id.toLowerCase().includes(targetModelName) || m.name.toLowerCase().includes(targetModelName)) && !m.id.includes('fable'))
        || models.find((m) => m.id.includes('gpt-4o') || m.family === 'gpt-4o')
        || models.find((m) => !m.id.includes('fable'))
        || models[0];

      log(`Using Copilot Model: ${selectedModel.id} (${selectedModel.name})`);

      // 2. Build VS Code LanguageModelChatMessage array
      const lmMessages = [];

      if (payload.system) {
        lmMessages.push(vscode.LanguageModelChatMessage.User(`[SYSTEM INSTRUCTION]\n${payload.system}`));
      }

      if (Array.isArray(payload.messages)) {
        for (const msg of payload.messages) {
          if (msg.role === 'system') {
            lmMessages.push(vscode.LanguageModelChatMessage.User(`[SYSTEM INSTRUCTION]\n${msg.content}`));
          } else if (msg.role === 'user') {
            const textContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            lmMessages.push(vscode.LanguageModelChatMessage.User(textContent));
          } else if (msg.role === 'assistant') {
            const textContent = typeof msg.content === 'string' ? msg.content : (msg.content ? JSON.stringify(msg.content) : 'OK');
            lmMessages.push(vscode.LanguageModelChatMessage.Assistant(textContent));
          } else if (msg.role === 'tool') {
            lmMessages.push(vscode.LanguageModelChatMessage.User(`[TOOL RESULT for ${msg.tool_call_id || 'tool'}]\n${msg.content}`));
          }
        }
      }

      // 3. Send request to Copilot via VS Code API
      const tokenSource = new vscode.CancellationTokenSource();
      req.on('close', () => tokenSource.cancel());

      const response = await selectedModel.sendRequest(lmMessages, {}, tokenSource.token);

      let textResult = '';
      for await (const fragment of response.text) {
        textResult += fragment;
      }

      log(`Copilot completion finished (${textResult.length} chars)`);

      // 4. Check if textResult contains a JSON tool call or structured JSON
      let toolCalls = null;
      let finalContent = textResult;

      try {
        const parsed = JSON.parse(textResult.trim());
        if (parsed && typeof parsed === 'object' && (parsed.tool_calls || parsed.action || parsed.name || parsed.type)) {
          if (Array.isArray(parsed.tool_calls)) {
            toolCalls = parsed.tool_calls;
          } else if (parsed.name && parsed.arguments) {
            toolCalls = [{
              id: `call_${Date.now()}`,
              type: 'function',
              function: {
                name: parsed.name,
                arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments),
              },
            }];
          }
        }
      } catch (_) {}

      const responsePayload = {
        id: `chatcmpl-copilot-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: selectedModel.id,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: finalContent,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: toolCalls ? 'tool_calls' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(JSON.stringify(lmMessages).length / 4),
          completion_tokens: Math.ceil(textResult.length / 4),
          total_tokens: Math.ceil((JSON.stringify(lmMessages).length + textResult.length) / 4),
        },
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(responsePayload));
    } catch (err) {
      log(`Error handling completion: ${err.stack || err.message}`);
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({
        error: {
          message: err.message || 'Internal bridge error',
          type: 'BRIDGE_ERROR',
        },
      }));
    }
  });
}

function startServer(port = 5005) {
  if (server) {
    try { server.close(); } catch (_) {}
  }

  server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-csrf-token');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      return res.end();
    }

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        bridge: 'qaai-copilot-bridge',
        port,
        timestamp: new Date().toISOString(),
      }));
    }

    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
      return handleChatCompletion(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });

  server.listen(port, '127.0.0.1', () => {
    log(`QAAI Copilot Bridge listening on http://127.0.0.1:${port}`);
    vscode.window.showInformationMessage(`QAAI Copilot Bridge active on http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port === 5005) {
      log(`Port 5005 in use, trying 5006...`);
      startServer(5006);
    } else {
      log(`Server error: ${err.message}`);
    }
  });
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('QAAI Copilot Bridge');
  outputChannel.show(true);
  log('Activating QAAI Copilot Bridge extension...');

  startServer(5005);

  context.subscriptions.push(
    vscode.commands.registerCommand('qaai-copilot-bridge.start', () => {
      startServer(5005);
    }),
    vscode.commands.registerCommand('qaai-copilot-bridge.status', () => {
      vscode.window.showInformationMessage(`QAAI Copilot Bridge is active on port 5005.`);
    })
  );
}

function deactivate() {
  if (server) {
    try { server.close(); } catch (_) {}
  }
}

module.exports = {
  activate,
  deactivate,
};
