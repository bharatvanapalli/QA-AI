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

const mcpContextConfig = require('./mcpContextConfig');
const downloadWatcher = require('./downloadWatcher');

const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'playwright', 'test-results', 'live');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

/**
 * Parse Project.contextViewport ("{width:1920,height:1080}" or
 * '{"width":...}') into a {width, height} object. Returns null on
 * garbage so the caller falls back to the default.
 */
function parseProjectViewport(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.width === 'number' && typeof v.height === 'number'
        && v.width > 0 && v.height > 0) return { width: v.width, height: v.height };
  } catch (_) {}
  return null;
}

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
 * @param {object}  [opts.project]       Project row — drives browser context
 *                                       configuration (Phase E10.5). When omitted,
 *                                       the session boots with MCP defaults +
 *                                       auto-accept dialogs.
 * @returns {Promise<object>} session
 */
async function startMcpSession({ userId, targetUrl, viewport, userDataDir, broadcast, extraCaps, project } = {}) {
  const cliPath = resolveMcpCliPath();
  const { Client, StdioClientTransport } = loadSdk();
  const projectViewport = parseProjectViewport(project?.contextViewport);
  const vp = projectViewport || viewport || { width: 1280, height: 720 };

  // Generate a stable session id BEFORE the context-config call so the
  // downloads dir + init-script paths are deterministic.
  const sessionId = crypto.randomBytes(8).toString('hex');

  // Phase E10.5 — browser context configuration. Adds CLI args + writes
  // a per-session init-script with locale / geo / color-scheme / fetch
  // header / dialog shims as needed. Always sets --output-dir so the
  // downloads watcher has a known location to poll.
  let contextExtras = { cliArgs: [], initScriptPath: null, downloadsDir: null };
  try {
    contextExtras = mcpContextConfig.buildContextArgs(project || {}, { id: sessionId });
  } catch (err) {
    // Bad project config shouldn't prevent the session — log and continue
    // with MCP defaults.
    try {
      (broadcast || (() => {}))({
        type: 'agent.phase.log', phase: 'conductor', level: 'warn',
        message: `[mcp] browser context config failed: ${err.message} — booting with defaults`,
      });
    } catch (_) {}
  }

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
    ...contextExtras.cliArgs,
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
    id: sessionId,
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
    // Phase E10.5 — context-config bookkeeping. The download watcher
    // polls `downloadsDir`; init-script path is held so we can unlink
    // it at session close.
    downloadsDir: contextExtras.downloadsDir,
    initScriptPath: contextExtras.initScriptPath,
    projectId: project?.id || null,
  };

  // Start the downloads watcher as soon as we have the session shell.
  // Safe to start before initial navigate — no downloads can fire yet.
  if (session.downloadsDir && session.projectId) {
    try {
      downloadWatcher.startWatcher(session, session.projectId);
    } catch (err) {
      try {
        session.broadcast({
          type: 'agent.phase.log', phase: 'conductor', level: 'warn',
          message: `[mcp] downloadWatcher start failed: ${err.message}`,
        });
      } catch (_) {}
    }
  }

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
  // Phase E10.5 — stop the downloads watcher and unlink the init-script
  // BEFORE killing the subprocess so we don't race on file handles.
  try { downloadWatcher.stopWatcher(session); } catch (_) {}
  try {
    mcpContextConfig.cleanupContextArtifacts({
      initScriptPath: session.initScriptPath,
      downloadsDir: session.downloadsDir,
      // Keep the downloads dir on disk — the Download rows reference it
      // and Reports needs to serve the bytes. Periodic cleanup is a
      // separate concern handled by the reaper.
      keepDownloads: true,
    });
  } catch (_) {}
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
  // Phase E2.1 — `assertion_check` is a SYNTHETIC tool. Instead of round-
  // tripping to the MCP subprocess (which doesn't know about it), the
  // server fabricates the response from the cached snapshot. Verifies a
  // declared assertion against the live page accessibility tree. Used by
  // the Conductor to ratify "RESULT: pass" claims BEFORE end_turn, so a
  // hallucinated success can self-correct mid-run instead of being caught
  // post-hoc by the Critic.
  if (name === 'assertion_check') {
    const result = await checkAssertion(session, args || {});
    // Don't update lastSnapshot — this tool reads cache, doesn't refresh it.
    return result;
  }
  // Pause frame polling while a "real" tool is in flight — otherwise polled
  // screenshots compete with the tool call and we get flaky responses.
  session.framePollerPaused = true;
  try {
    const result = await session.client.callTool({ name, arguments: args || {} });
    // Cache the snapshot text on the session so the inline Critic (and the
    // picker) can read it without burning another tool call.
    const txt = textOfContent(result?.content);
    if (txt) {
      session.lastSnapshot = txt;
      // Phase E1.4 — broadcast a truncated preview of the accessibility tree
      // so the Theater DOM-snapshot pane can render what the agent is
      // actually looking at. 8 KB is enough for the visible viewport on
      // typical SaaS pages; the picker / healer already operate on the
      // (untruncated) `lastSnapshot`. Best-effort — never throws.
      try {
        session.broadcast({
          type: 'mcp.snapshot.preview',
          sessionId: session.id,
          tool: name,
          snapshot: txt.slice(0, 8_000),
          truncated: txt.length > 8_000,
          length: txt.length,
          ts: Date.now(),
        });
      } catch (_) {}
    }
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

// ── Phase E2.1 — synthetic `assertion_check` tool ───────────────────────
//
// The Conductor calls this BEFORE emitting `RESULT: pass` for a test case.
// We don't roundtrip MCP — instead, we read the cached accessibility-tree
// snapshot and verify the declared assertion against it. Fast (sub-millisecond),
// no extra browser cost.
//
// Schema:
//   { assertion: string,            // human-readable claim being checked
//     expectedRole?: string,         // e.g. "heading", "alert"
//     expectedText?: string,         // case-insensitive substring match
//     expectedUrlPattern?: string }  // RegExp pattern matched against any url=
//
// Response:
//   { matched: bool, evidence: string, reason: string }
//
// At least one of expectedRole / expectedText / expectedUrlPattern must be
// supplied — passing none returns matched=false with reason=missing_criteria.

const ASSERTION_CHECK_TOOL = {
  name: 'assertion_check',
  description:
    'Verify an assertion against the current page snapshot AND/OR the captured downloads for this case. Call this for EACH assertion BEFORE you emit RESULT: pass — any matched=false flips the test case to fail. Pass at least one of expectedRole, expectedText, expectedUrlPattern, or expectedDownload.',
  input_schema: {
    type: 'object',
    properties: {
      assertion: { type: 'string', description: 'Human-readable claim being verified (e.g. "user lands on dashboard").' },
      expectedRole: { type: 'string', description: 'ARIA role expected to appear (e.g. "heading", "alert", "main").' },
      expectedText: { type: 'string', description: 'Case-insensitive substring expected on the page.' },
      expectedUrlPattern: { type: 'string', description: 'JavaScript-regex pattern expected to match a URL on the page (e.g. "/dashboard").' },
      expectedDownload: {
        type: 'object',
        description: 'Verify a file was actually downloaded during this case. The download watcher records every file the browser saves; provide a filenamePattern (regex) and/or minSize (bytes) and/or mimeType.',
        properties: {
          filenamePattern: { type: 'string', description: 'Case-insensitive regex against suggested filename (e.g. "report.*\\\\.pdf$").' },
          minSize: { type: 'number', description: 'Minimum file size in bytes — guards against empty/0-byte downloads.' },
          mimeType: { type: 'string', description: 'Exact MIME type (e.g. "application/pdf").' },
        },
      },
    },
    required: ['assertion'],
  },
};

async function checkAssertion(session, args) {
  const snap = session?.lastSnapshot || '';
  const { assertion, expectedRole, expectedText, expectedUrlPattern, expectedDownload } = args || {};
  // Guard: at least one criterion must be supplied — otherwise we can't
  // verify anything and a naive matched=true would let hallucinated passes
  // through. Reject explicitly so the agent learns to supply criteria.
  if (!expectedRole && !expectedText && !expectedUrlPattern && !expectedDownload) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: false,
        reason: 'missing_criteria',
        evidence: 'No expectedRole / expectedText / expectedUrlPattern / expectedDownload supplied. Provide at least one so the assertion can actually be checked.',
      }) }],
      isError: false,
    };
  }
  // Download-only assertion: no snapshot needed.
  const isPageCriterion = !!(expectedRole || expectedText || expectedUrlPattern);
  if (isPageCriterion && !snap) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: false,
        reason: 'no_snapshot',
        evidence: 'No page snapshot is cached. Call browser_snapshot first, then re-run assertion_check.',
      }) }],
      isError: false,
    };
  }

  const reasons = [];
  const evidenceBits = [];

  if (expectedRole) {
    // Snapshot lines look like: `- role "name" [ref=eN] ...`. Match the
    // role token at the start of any line, optionally indented.
    const roleRe = new RegExp(`^\\s*-?\\s*${expectedRole.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'mi');
    const m = snap.match(roleRe);
    if (m) {
      // Capture the line for evidence so the agent can see WHAT matched.
      const line = snap.split(/\r?\n/).find((l) => roleRe.test(l));
      evidenceBits.push(`role:OK (${(line || '').trim().slice(0, 120)})`);
    } else {
      reasons.push(`expectedRole "${expectedRole}" not found in snapshot`);
    }
  }

  if (expectedText) {
    const needle = String(expectedText).toLowerCase();
    if (snap.toLowerCase().includes(needle)) {
      // Pull the surrounding 60 chars so the agent sees the context, not
      // just "matched".
      const idx = snap.toLowerCase().indexOf(needle);
      const start = Math.max(0, idx - 20);
      const end = Math.min(snap.length, idx + needle.length + 40);
      evidenceBits.push(`text:OK ("…${snap.slice(start, end).replace(/\s+/g, ' ').trim()}…")`);
    } else {
      reasons.push(`expectedText "${String(expectedText).slice(0, 80)}" not found in page text`);
    }
  }

  if (expectedUrlPattern) {
    let urlRe;
    try { urlRe = new RegExp(expectedUrlPattern); } catch (_) { urlRe = null; }
    if (!urlRe) {
      reasons.push(`expectedUrlPattern "${expectedUrlPattern}" is not a valid regex`);
    } else {
      // MCP snapshots from @playwright/mcp include the current URL at the
      // top as `Page URL: https://...`. Fall back to any URL-shaped string
      // in the snapshot when that header isn't present.
      const urlMatch = snap.match(/Page URL:\s*(\S+)/i) || snap.match(/https?:\/\/[^\s"'<>]+/);
      const url = urlMatch?.[1] || urlMatch?.[0] || '';
      if (url && urlRe.test(url)) {
        evidenceBits.push(`url:OK (${url.slice(0, 120)})`);
      } else {
        reasons.push(`expectedUrlPattern "${expectedUrlPattern}" did not match current URL "${url || '(unknown)'}"`);
      }
    }
  }

  // E10.5 — Download verification. Reads the watcher's records for the
  // active RunResult and matches against the spec. Async so the prisma
  // query can complete before we shape the response.
  if (expectedDownload) {
    const activeRunResultId = session?._dlWatcher?.activeRunResultId;
    if (!activeRunResultId) {
      reasons.push('expectedDownload was set but no RunResult is active — the watcher cannot attribute downloads to a case');
    } else {
      try {
        const dlCheck = await downloadWatcher.checkDownloadExpectation(activeRunResultId, expectedDownload);
        if (dlCheck.matched) evidenceBits.push(`download:OK (${dlCheck.evidence})`);
        else reasons.push(`expectedDownload not satisfied: ${dlCheck.evidence}`);
      } catch (err) {
        reasons.push(`download check threw: ${err.message}`);
      }
    }
  }

  const matched = reasons.length === 0;
  const payload = matched
    ? { matched: true, assertion: assertion || null, evidence: evidenceBits.join(' · ') || 'all criteria matched' }
    : { matched: false, assertion: assertion || null, reason: 'criteria_failed', evidence: reasons.join(' · ') };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: false,
  };
}

/**
 * Map MCP tools to Anthropic's tool-use schema. Strip keys Anthropic rejects.
 * Phase E2.1 — also appends the synthetic `assertion_check` tool so the
 * Conductor can call it like any other MCP tool.
 */
function listAnthropicTools(session) {
  const REJECTED = new Set(['outputSchema', 'annotations', '_meta', 'execution', 'icons', 'title']);
  const real = (session.mcpTools || []).map((t) => {
    const inputSchema = sanitiseSchema(t.inputSchema) || { type: 'object', properties: {} };
    const tool = {
      name: t.name,
      description: t.description || `MCP tool ${t.name}`,
      input_schema: inputSchema,
    };
    for (const k of REJECTED) delete tool[k];
    return tool;
  });
  // Append the synthetic assertion_check tool. Server-side handled in callTool.
  return [...real, ASSERTION_CHECK_TOOL];
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
