'use strict';

/**
 * MCP wrapper — drives `@playwright/mcp` as a **subprocess** over stdio.
 *
 * Why subprocess instead of in-process (Phase T2 rework):
 *   - Microsoft designed @playwright/mcp to be launched this way; in-process
 *     `InMemoryTransport` works for smoke tests but doesn't isolate Chromium
 *     crashes from our long-running Express server.
 *   - When Chromium dies (alpha Playwright is unstable, corp EDR may kill
 *     chrome.exe), the subprocess dies too — our server stays clean and
 *     spawns a fresh subprocess for the next session.
 *   - StdioClientTransport from the official MCP SDK handles process lifecycle:
 *     spawning, stdin/stdout framing, and clean shutdown.
 *
 * The Conductor calls `client.listTools()` to discover available tools and
 * `client.callTool()` to invoke them. Tool responses include text snapshots
 * (yaml/json describing the page) and optionally images (jpeg/png base64).
 * Image blocks are translated to Anthropic's `{type:'image', source:{...}}`
 * shape so Claude can see screenshots when MCP returns them.
 *
 * A `frame poller` polls `browser_take_screenshot` every ~500ms and broadcasts
 * each image as a `browser.frame` WS message for the Theater UI.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'playwright', 'test-results', 'live');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

// Resolve the @playwright/mcp CLI path once at module load so spawn() can find it.
// The package's `exports` field only allows '.' and './package.json' subpaths,
// so we resolve via package.json and join 'cli.js' manually.
let MCP_CLI_PATH = null;
function resolveMcpCliPath() {
  if (MCP_CLI_PATH) return MCP_CLI_PATH;
  try {
    const pkgPath = require.resolve('@playwright/mcp/package.json');
    const cliPath = path.join(path.dirname(pkgPath), 'cli.js');
    if (!fs.existsSync(cliPath)) {
      throw new Error(`cli.js not found at ${cliPath}`);
    }
    MCP_CLI_PATH = cliPath;
    return MCP_CLI_PATH;
  } catch (err) {
    const e = new Error(`@playwright/mcp not installed: ${err.message}`);
    e.code = 'MCP_MISSING';
    throw e;
  }
}

function loadSdk() {
  try {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    return { Client, StdioClientTransport };
  } catch (err) {
    const e = new Error(`@modelcontextprotocol/sdk not installed: ${err.message}`);
    e.code = 'MCP_SDK_MISSING';
    throw e;
  }
}

/**
 * Build CLI args for the @playwright/mcp subprocess based on our config.
 *
 * @param {object} opts
 * @returns {string[]}
 */
function buildMcpCliArgs({ viewport, headless, isolated, userDataDir, caps, noSandbox } = {}) {
  const args = [];
  // Browser channel — the alpha Playwright accepts 'chrome' / 'firefox' / 'webkit' / 'msedge';
  // omit to get the bundled Chromium build.
  // `--isolated` keeps the profile in memory (no disk persistence).
  if (isolated && !userDataDir) args.push('--isolated');
  if (userDataDir) { args.push('--user-data-dir', userDataDir); }
  if (viewport?.width && viewport?.height) {
    args.push('--viewport-size', `${viewport.width}x${viewport.height}`);
  }
  // Headless is OFF by default in @playwright/mcp; pass --browser is needed if forcing
  if (headless === true) {
    // The CLI doesn't expose a direct --headless flag; users pass --browser=chrome
    // and it picks headed/headless based on capability profile. We leave it default.
  }
  // Additional caps the CLI accepts: 'vision', 'pdf', 'devtools'
  // (core/navigation/tabs/input/network/storage/testing are always on)
  if (Array.isArray(caps) && caps.length) {
    args.push('--caps', caps.join(','));
  }
  if (noSandbox) args.push('--no-sandbox');
  args.push('--image-responses', 'allow');
  args.push('--snapshot-mode', 'full');
  return args;
}

/**
 * Start an MCP session by spawning @playwright/mcp as a stdio subprocess.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.targetUrl]      Initial URL to navigate to (best-effort)
 * @param {object} [opts.viewport]       { width, height }
 * @param {string} [opts.userDataDir]    Optional persistent profile path
 * @param {function} [opts.broadcast]    (msg) => void — for frame events and logs
 * @param {string[]} [opts.extraCaps]    Extra capabilities beyond core (vision, pdf, devtools)
 * @returns {Promise<object>} session
 */
async function startMcpSession({ userId, targetUrl, viewport, userDataDir, broadcast, extraCaps } = {}) {
  const cliPath = resolveMcpCliPath();
  const { Client, StdioClientTransport } = loadSdk();
  const vp = viewport || { width: 1280, height: 720 };

  const args = [
    cliPath,
    ...buildMcpCliArgs({
      viewport: vp,
      isolated: !userDataDir,
      userDataDir,
      caps: Array.isArray(extraCaps) && extraCaps.length ? extraCaps : ['vision', 'pdf', 'devtools'],
      // --no-sandbox helps on corp laptops where EDR/AV blocks sandboxed launches.
      // Safe in dev; do NOT enable for production multi-tenant scenarios.
      noSandbox: process.env.QAAI_MCP_NO_SANDBOX === '1' || process.env.QAAI_MCP_NO_SANDBOX === 'true',
    }),
  ];

  // The MCP SDK's StdioClientTransport spawns the subprocess and pipes JSON-RPC
  // over stdin/stdout. The subprocess inherits NODE_TLS_REJECT_UNAUTHORIZED so
  // corp-proxy MITM doesn't kill Playwright's internal HTTPS calls.
  const subprocessEnv = {
    ...process.env,
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0',
    // Suppress Playwright's own debug noise unless explicitly asked for.
    DEBUG: process.env.QAAI_MCP_DEBUG ? process.env.DEBUG : '',
  };

  const transport = new StdioClientTransport({
    command: process.execPath,   // current node binary
    args,
    env: subprocessEnv,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'qaai-conductor', version: '2.0.0' }, { capabilities: {} });
  await client.connect(transport);

  // Cache the tool list once — stable for the session lifetime.
  const toolList = await client.listTools();

  const session = {
    id: crypto.randomBytes(8).toString('hex'),
    userId,
    client,
    transport,
    mcpTools: toolList.tools || [],
    viewport: vp,
    broadcast: broadcast || (() => {}),
    framePoller: null,
    framePollerPaused: false,
    closed: false,
    lastSnapshot: '',
  };

  // Capture subprocess stderr to the broadcast channel — these are the real
  // Playwright/Chromium errors. The Critic and the Theater log both consume them.
  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (!text.trim()) return;
      // Most stderr lines from MCP are info-level launch logs; pipe them through
      // verbatim so debugging the next crash doesn't need server-side log digging.
      try {
        session.broadcast({
          type: 'agent.phase.log', phase: 'conductor', level: 'info',
          message: `[mcp.stderr] ${text.trim().slice(0, 600)}`,
        });
      } catch (_) {}
    });
  }

  // Best-effort initial navigation. If the subprocess died during boot the
  // first callTool will reject — we surface and re-throw so the caller knows.
  if (targetUrl) {
    try {
      await callTool(session, 'browser_navigate', { url: targetUrl });
    } catch (err) {
      session.broadcast({
        type: 'agent.phase.log', phase: 'conductor', level: 'warn',
        message: `MCP initial navigate failed: ${err.message}`,
      });
    }
  }

  return session;
}

/**
 * Stop the MCP session cleanly. Closes the client, which terminates the
 * subprocess. The frame poller is stopped first to prevent racing tool calls.
 */
async function stopMcpSession(session) {
  if (!session || session.closed) return;
  session.closed = true;
  stopFramePoller(session);
  try { await session.client.close(); } catch (_) {}
  // StdioClientTransport.close() kills the subprocess for us. Belt and braces:
  try { await session.transport?.close?.(); } catch (_) {}
}

/**
 * Invoke an MCP tool. Returns the raw MCP CallToolResult
 * (`{ content: [...], isError?: boolean }`).
 *
 * NEVER throws on tool errors — those come back as `result.isError = true`
 * with the failure message in `content`. Throws only on transport-level
 * failures (client disconnected, etc.).
 */
async function callTool(session, name, args) {
  if (!session?.client) {
    const e = new Error('MCP session not connected');
    e.code = 'MCP_NO_SESSION';
    throw e;
  }
  // Pause frame polling while a "real" tool is in flight — otherwise polled
  // screenshots compete with the tool call and we get flaky responses.
  session.framePollerPaused = true;
  try {
    const result = await session.client.callTool({ name, arguments: args || {} });
    // Cache the snapshot text on the session so the inline Critic (and the
    // picker) can read it without burning another tool call.
    const txt = textOfContent(result?.content);
    if (txt) session.lastSnapshot = txt;
    return result;
  } finally {
    session.framePollerPaused = false;
  }
}

/**
 * Return the most recent snapshot text captured from any tool result.
 * Used by the inline Critic to evaluate where the page currently is without
 * spending another MCP roundtrip.
 */
function getLastSnapshot(session) {
  return session?.lastSnapshot || '';
}

/**
 * Convenience: ask for a page snapshot (yaml/json text describing every
 * visible element with role/name/ref). Returns the raw text, suitable for
 * embedding in a prompt or parsing for the picker.
 */
async function snapshot(session) {
  const result = await callTool(session, 'browser_snapshot', {});
  if (result.isError) {
    return { text: '', error: textOfContent(result.content) };
  }
  return { text: textOfContent(result.content), error: null };
}

/**
 * Convenience: take a screenshot. Returns the first image block as
 * `{ data: base64, mediaType }`, or null if no image was returned.
 */
async function screenshot(session, params = {}) {
  const result = await callTool(session, 'browser_take_screenshot', {
    type: params.type || 'jpeg',
    ...params,
  });
  if (result.isError) return null;
  const img = (result.content || []).find((c) => c.type === 'image');
  if (!img) return null;
  return { data: img.data, mediaType: img.mimeType || 'image/jpeg' };
}

/**
 * Save a screenshot blob to disk and return the served URL path.
 */
function saveScreenshotToDisk(imgBlock, label) {
  if (!imgBlock?.data) return null;
  const safe = String(label || crypto.randomBytes(4).toString('hex')).replace(/[^a-zA-Z0-9_-]/g, '_');
  const ext = imgBlock.mediaType === 'image/png' ? '.png' : '.jpg';
  const file = path.join(ARTIFACT_DIR, `${safe}${ext}`);
  try {
    fs.writeFileSync(file, Buffer.from(imgBlock.data, 'base64'));
    return '/artifacts/live/' + path.basename(file);
  } catch (_) {
    return null;
  }
}

/**
 * Start polling browser_take_screenshot at ~2 fps. Each frame is broadcast
 * via the session's `broadcast` function as `{ type:'browser.frame', frame, sessionId }`.
 */
function startFramePoller(session, { fps = 2 } = {}) {
  if (!session || session.framePoller) return;
  const intervalMs = Math.max(200, Math.floor(1000 / Math.max(1, fps)));
  session.framePoller = setInterval(async () => {
    if (session.closed) return;
    if (session.framePollerPaused) return;
    try {
      const shot = await screenshot(session, { type: 'jpeg' });
      if (shot && !session.closed) {
        session.broadcast({
          type: 'browser.frame',
          sessionId: session.id,
          frame: shot.data,
          mediaType: shot.mediaType,
          ts: Date.now(),
        });
      }
    } catch (_) {
      // Polled screenshots are best-effort
    }
  }, intervalMs);
}

function stopFramePoller(session) {
  if (session?.framePoller) {
    clearInterval(session.framePoller);
    session.framePoller = null;
  }
}

/**
 * Map MCP tools to Anthropic's tool-use schema. Strip keys Anthropic rejects.
 */
function listAnthropicTools(session) {
  const REJECTED = new Set(['outputSchema', 'annotations', '_meta', 'execution', 'icons', 'title']);
  return (session.mcpTools || []).map((t) => {
    const inputSchema = sanitiseSchema(t.inputSchema) || { type: 'object', properties: {} };
    const tool = {
      name: t.name,
      description: t.description || `MCP tool ${t.name}`,
      input_schema: inputSchema,
    };
    for (const k of REJECTED) delete tool[k];
    return tool;
  });
}

/**
 * Map MCP tools to Anthropic's tool-use schema shape ALSO used as the
 * canonical input to the provider abstraction. The Gemini provider re-shapes
 * `input_schema` -> `parameters` internally; callers don't have to branch
 * on provider. This is just listAnthropicTools by another name — kept as
 * a separate export so the intent is visible at call sites that loop over
 * providers (e.g. the future failover work).
 */
function listProviderTools(session) {
  return listAnthropicTools(session);
}

/**
 * Strip JSON Schema keys that Anthropic's tool-use validator rejects.
 * Walks recursively into `properties` and `items`.
 */
function sanitiseSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const REJECTED_AT_ANY_LEVEL = new Set(['$schema', '$id', '$ref', 'definitions', '$defs', 'examples']);
  const out = Array.isArray(schema) ? [] : {};
  for (const [k, v] of Object.entries(schema)) {
    if (REJECTED_AT_ANY_LEVEL.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) {
        out.properties[pk] = sanitiseSchema(pv);
      }
    } else if (k === 'items') {
      out.items = sanitiseSchema(v);
    } else if (v && typeof v === 'object') {
      out[k] = sanitiseSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Extract concatenated text from an MCP content array.
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

/**
 * Translate an MCP content array into Anthropic-friendly content blocks
 * suitable for a `tool_result` message:
 *   - text → text block
 *   - image (base64) → image block with base64 source
 *   - resource_link → text block pointing at the resource
 *
 * Anthropic accepts an array OR a plain string for tool_result content.
 * We return an array to preserve any image blocks.
 */
function normaliseMcpContentForAnthropic(content) {
  if (!Array.isArray(content) || content.length === 0) {
    return [{ type: 'text', text: '(empty result)' }];
  }
  const out = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') {
      out.push({ type: 'text', text: c.text });
    } else if (c.type === 'image' && c.data) {
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: c.mimeType || 'image/jpeg',
          data: c.data,
        },
      });
    } else if (c.type === 'resource_link') {
      out.push({ type: 'text', text: `[resource: ${c.uri || c.name || 'link'}]` });
    } else if (c.type === 'resource' && c.resource) {
      const r = c.resource;
      if (r.text) out.push({ type: 'text', text: r.text });
      else out.push({ type: 'text', text: `[resource ${r.uri || ''}]` });
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '(unrecognised MCP content)' });
  return out;
}

/**
 * Parse the MCP page snapshot text into picker-candidate rows. The snapshot
 * from `@playwright/mcp` is a YAML-ish accessibility tree where each
 * interactable line looks like:
 *
 *   - button "Sign in" [ref=e42]
 *   - textbox "Email" [ref=e10] [placeholder="you@example.com"]
 *   - link "Forgot password?" [ref=e51]
 *
 * We extract role + name + ref and synthesise Playwright locator expressions
 * for each candidate. The `ref=` value is the MCP element ref — useful for
 * subsequent `browser_click({ element, ref })` calls.
 */
function parseMcpSnapshotToCandidates(snapText) {
  if (!snapText || typeof snapText !== 'string') return [];
  const out = [];
  const lineRe = /^\s*-\s+(\w[\w-]*)\b\s*(?:"([^"]+)"|'([^']+)')?\s*(.*)$/;
  const refRe = /\[ref=([\w-]+)\]/;
  const placeholderRe = /\[placeholder="([^"]+)"\]/;
  const testIdRe = /\[testid="([^"]+)"\]/;
  const idRe = /\[id="([^"]+)"\]/;

  for (const line of snapText.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    const role = m[1];
    const name = m[2] || m[3] || '';
    const rest = m[4] || '';
    const refMatch = rest.match(refRe);
    const ref = refMatch ? refMatch[1] : null;
    const placeholder = (rest.match(placeholderRe) || [])[1] || null;
    const testid = (rest.match(testIdRe) || [])[1] || null;
    const idAttr = (rest.match(idRe) || [])[1] || null;

    if (testid) {
      out.push({ strategy: 'testid', expression: `getByTestId("${escapeJs(testid)}")`, stability: 98, ref, role, name });
    }
    if (role && name) {
      out.push({ strategy: 'role', expression: `getByRole("${escapeJs(role)}", { name: ${JSON.stringify(name)} })`, stability: 92, ref, role, name });
    }
    if (placeholder) {
      out.push({ strategy: 'placeholder', expression: `getByPlaceholder(${JSON.stringify(placeholder)})`, stability: 80, ref, role, name });
    }
    if (name && /\S/.test(name) && name.length < 80) {
      out.push({ strategy: 'text', expression: `getByText(${JSON.stringify(name)})`, stability: 65, ref, role, name });
    }
    if (idAttr) {
      out.push({ strategy: 'css', expression: `locator("#${escapeCss(idAttr)}")`, stability: 60, ref, role, name });
    }
  }
  return out;
}

function escapeJs(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function escapeCss(s) { return String(s).replace(/([^\w-])/g, '\\$1'); }

module.exports = {
  startMcpSession,
  stopMcpSession,
  callTool,
  snapshot,
  screenshot,
  saveScreenshotToDisk,
  startFramePoller,
  stopFramePoller,
  listAnthropicTools,
  listProviderTools,
  normaliseMcpContentForAnthropic,
  textOfContent,
  parseMcpSnapshotToCandidates,
  getLastSnapshot,
};
