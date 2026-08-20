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

      // 1. Select all available models from VS Code Language Model API
      let models = [];
      try {
        models = await vscode.lm.selectChatModels({});
      } catch (e) {
        log(`Select all models failed: ${e.message}`);
      }
      if (!models || models.length === 0) {
        try {
          models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        } catch (_) {}
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

      // Filter out restricted/internal models that reject standard LM sendRequest
      const isUsable = (m) => !/(fable|search-agent|exec-agent|compaction|aitk|no-project|^auto$)/i.test(m.id || '');
      const usable = models.filter(isUsable);

      const targetModelName = (payload.model || '').toLowerCase();
      let preferred = [];
      if (targetModelName.includes('sonnet') || targetModelName.includes('claude')) {
        preferred = usable.filter(m => /sonnet/i.test(m.id || m.name || ''));
      } else {
        preferred = [
          ...usable.filter(m => m.id === 'gpt-4o-2024-11-20' || m.family === 'gpt-4o'),
          ...usable.filter(m => m.id === 'gpt-4o-mini-2024-07-18' || m.family === 'gpt-4o-mini'),
          ...usable.filter(m => /gpt-4/i.test(m.id || '')),
        ];
      }

      const candidateModels = [
        ...preferred,
        ...usable,
      ].filter((m, idx, self) => self.findIndex((x) => x.id === m.id) === idx);

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

      // 3. Send request to Copilot via VS Code API with model fallback
      let textResult = '';
      let successfulModel = null;
      let lastErr = null;
      for (const modelCandidate of candidateModels) {
        try {
          log(`Attempting completion with model: ${modelCandidate.id} (${modelCandidate.name})`);
          const tokenSource = new vscode.CancellationTokenSource();
          req.on('close', () => tokenSource.cancel());
          const response = await modelCandidate.sendRequest(lmMessages, {}, tokenSource.token);
          let currentText = '';
          for await (const fragment of response.text) {
            currentText += fragment;
          }
          if (currentText.length > 0) {
            textResult = currentText;
            successfulModel = modelCandidate;
            log(`Copilot completion finished via ${modelCandidate.id} (${textResult.length} chars)`);
            break;
          }
        } catch (modelErr) {
          log(`Model ${modelCandidate.id} failed: ${modelErr.message}`);
          lastErr = modelErr;
        }
      }

      if (!textResult && lastErr) {
        throw lastErr;
      }

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
        model: successfulModel ? successfulModel.id : (payload.model || 'copilot-gpt-4o'),
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

    if (req.method === 'GET' && (req.url === '/models' || req.url === '/v1/models')) {
      (async () => {
        try {
          const models = await vscode.lm.selectChatModels({});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: models.map(m => ({
              id: m.id,
              name: m.name,
              family: m.family,
              vendor: m.vendor,
            })),
          }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
        }
      })();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });

  server.listen(port, '127.0.0.1', () => {
    log(`QAAI Copilot Bridge listening on http://127.0.0.1:${port}`);
    vscode.window.showInformationMessage(`QAAI Copilot Bridge active on http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port 5005 in use, retrying in 1s...`);
      setTimeout(() => startServer(5005), 1000);
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
