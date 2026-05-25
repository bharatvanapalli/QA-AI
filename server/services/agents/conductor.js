'use strict';

/**
 * Agent 3 — Execution Conductor (Phase S — real `@playwright/mcp`).
 *
 * For each test case:
 *   1. Start an in-process MCP session (headed Chromium via @playwright/mcp)
 *   2. Pre-navigate to the start URL via `browser_navigate` (deterministic;
 *      saves a Claude turn)
 *   3. Run a Claude tool-use loop: every iteration Claude either calls one or
 *      more MCP tools (browser_snapshot, browser_click, browser_type, ...) or
 *      ends its turn. After each tool call we feed the snapshot/result back in
 *      and let Claude decide the next action — true per-action adaptive.
 *   4. Persist Run / RunResult / BlockedItem / GovernancePR with real lint findings.
 *   5. Build a structured `history` array of per-case outcomes (status, error,
 *      original steps, action trail). The route uses this to feed the Critic.
 *
 * If MCP can't start (no Chromium, etc.) we degrade to a dry-run that narrates
 * the approved steps without execution — so the pipeline still completes
 * end-to-end and the user sees what would have happened.
 */

const path = require('path');
const fs = require('fs');
const prisma = require('../../prisma');
const lintGates = require('../lintGates');
const { encodeJson, encodeArray } = require('../jsonField');
const mcp = require('../mcp');
const sessionRegistry = require('../sessionRegistry');
const downloadWatcher = require('../downloadWatcher');
const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt } = require('../../lib/promptCompose');
const codegen = require('../codegen');
const healer = require('./healer');
const instructionReader = require('./instructionReader');
const visualCritic = require('./visualCritic');

// Phase E4 — visual regression. Static-route prefix → on-disk dir mapping
// for /artifacts/* URLs (mounted in server/index.js). Used to read a stored
// screenshot back into memory for the VisualCritic vision call.
const ARTIFACT_DISK_ROOT = path.join(__dirname, '..', '..', '..', 'playwright', 'test-results');

function artifactUrlToDiskPath(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/artifacts/')) return null;
  return path.join(ARTIFACT_DISK_ROOT, url.slice('/artifacts/'.length));
}

function readArtifactAsBase64(url) {
  const disk = artifactUrlToDiskPath(url);
  if (!disk) return null;
  try {
    const buf = fs.readFileSync(disk);
    const lower = disk.toLowerCase();
    const mediaType = lower.endsWith('.png') ? 'image/png'
                    : lower.endsWith('.webp') ? 'image/webp'
                    : 'image/jpeg';
    return { data: buf.toString('base64'), mediaType };
  } catch (_) {
    return null;
  }
}

const MAX_TURNS = Number(process.env.QAAI_MCP_MAX_TURNS) || 30;
const SCREENSHOT_EVERY_N_TURNS = 2;
const INLINE_CRITIC_EVERY = Number(process.env.QAAI_INLINE_CRITIC_EVERY) || 5;
const MAX_IDENTICAL_TOOL_CALLS = Number(process.env.QAAI_MAX_IDENTICAL_TOOL_CALLS) || 3;
const MAX_CONSECUTIVE_ERRORS = Number(process.env.QAAI_MAX_CONSECUTIVE_ERRORS) || 3;
// Phase E1 — self-healing thresholds.
//   - HEAL_MIN_CONFIDENCE: below this, the healer's proposal is too uncertain
//     to retry server-side. We let Claude see the original error.
//   - QUARANTINE_HEALTH:   below this, the Conductor refuses to use the
//     locator at all and emits a BlockedItem upfront — prevents thrash on a
//     genuinely-deleted element.
//   - HEAL_BUMP / FAIL_HIT: per-success / per-failure delta on healthScore.
const HEAL_MIN_CONFIDENCE = Number(process.env.QAAI_HEAL_MIN_CONFIDENCE) || 70;
const QUARANTINE_HEALTH   = Number(process.env.QAAI_QUARANTINE_HEALTH) || 30;
const HEAL_BUMP           = 5;
const FAIL_HIT            = 20;

/** Normalise a hint so we can dedupe semantically-equivalent strings. */
function normaliseHint(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[`'"*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** True if two errors describe the same root cause (rough heuristic). */
function sameRootCause(a, b) {
  if (!a || !b) return false;
  const na = normaliseHint(a);
  const nb = normaliseHint(b);
  if (na === nb) return true;
  // Match common environmental patterns even if wording varies
  const patterns = [
    /browser.*not installed/i,
    /chromium.*not installed/i,
    /unable to get local issuer cert/i,
    /econnrefused/i,
    /enetdown|enotfound|eai_again/i,
    /target page.*closed/i,
  ];
  for (const p of patterns) {
    if (p.test(a) && p.test(b)) return true;
  }
  return false;
}

/** Patterns that indicate a systemic failure (no point retrying). */
function isSystemicError(msg) {
  const s = String(msg || '').toLowerCase();
  return (
    /browser.*not installed/.test(s) ||
    /chromium.*not installed/.test(s) ||
    /executable doesn'?t exist/.test(s) ||
    /unable to get local issuer cert/.test(s) ||
    /mcp_missing|mcp_sdk_missing|mcp_no_session/.test(s) ||
    // Browser/page lifecycle deaths — once the browser context is gone,
    // retrying tool calls only spams the Critic. Abort the suite cleanly.
    /target.*(closed|crashed)/.test(s) ||
    /browser.*(closed|crashed|disconnect|crash|kill)/.test(s) ||
    /context.*(closed|destroyed)/.test(s) ||
    /page.*(closed|crashed)/.test(s) ||
    /failed to initialize/.test(s) ||
    /failing to relaunch/.test(s)
  );
}

/**
 * D1 — Scan a Playwright-MCP accessibility-tree snapshot for visible error
 * banners / status messages and return their text. The MCP snapshot is a
 * YAML-like aria tree where alerts surface as:
 *   - alert [ref=e42]: "Incorrect email address or password"
 * Plus a fallback: any quoted string whose content matches a common
 * error-phrasing vocabulary, even if the role isn't "alert".
 */
function extractPageErrors(snapshot) {
  if (!snapshot || typeof snapshot !== 'string') return [];
  const errors = new Set();
  const lines = snapshot.split('\n');
  for (const line of lines) {
    const roleMatch = line.match(/^\s*-?\s*(?:alert|status)\b[^:]*:\s*(.+)$/i);
    if (roleMatch) {
      const raw = roleMatch[1].trim().replace(/^["']|["']$/g, '');
      if (raw && raw.length <= 300) errors.add(raw);
      continue;
    }
    const quoted = line.match(/"([^"]{3,300})"/);
    if (quoted) {
      const text = quoted[1];
      if (/\b(incorrect|invalid|required|denied|not\s*found|error|failed|expired|locked|unauthori[sz]ed|forbidden|please\s+(?:enter|provide|use|fill|complete|select))\b/i.test(text)) {
        errors.add(text);
      }
    }
  }
  return Array.from(errors);
}

/**
 * Phase E1.6 — extract INSTRUCTIONAL text from a Playwright-MCP snapshot.
 * D1's `extractPageErrors` surfaces role="alert" / role="status" only. This
 * sibling helper catches the OTHER class of "the page is telling you what
 * to do" content: paragraph / heading / listitem nodes whose text contains
 * actionable verbs ("click Register first", "verify your email").
 *
 * Cheap: regex scan against the snapshot text — no Claude call. Returns
 * deduped imperative strings, cap 5. Skip patterns block cookie/privacy/
 * marketing noise so the prompt budget isn't burned on filler.
 *
 * If this returns nothing on a page where the agent is stuck, the vision
 * fallback (server/services/agents/instructionReader.js) reads the
 * screenshot instead.
 */
function extractPageInstructions(snapshot) {
  if (!snapshot || typeof snapshot !== 'string') return [];
  // Actionable-verb vocabulary the page might use to tell the user what to do.
  const VERB_RE = /\b(?:click(?:\s+(?:on\s+)?(?:the|here)?)?|press(?:\s+the)?|tap|select(?:\s+the)?|register|sign\s*up|create\s+(?:an?\s+)?account|verify\s+(?:your\s+)?email|confirm\s+(?:your\s+)?(?:account|email)|activate\s+(?:your\s+)?account|complete\s+(?:the\s+)?(?:setup|registration|profile)|set\s*up|enable|follow\s+(?:these\s+)?(?:steps|instructions)|request\s+(?:an?\s+)?(?:invite|access)|paste\s+(?:your|the)|enter\s+(?:your|the)|provide\s+(?:your|the)|use\s+(?:the|your)\s+\w+\s+(?:link|button|account)|check\s+(?:your\s+)?(?:inbox|email|spam)|first\s+create|first\s+register|your\s+account\s+(?:is\s+)?(?:not\s+yet|hasn['']?t\s+been|must\s+be))\b/i;
  // Skip patterns — copy that's verb-matching but not "instructional for
  // the agent's current action".
  const SKIP_RE = /\b(accept\s+(?:all\s+)?cookies?|privacy\s+policy|terms\s+of\s+service|cookie\s+(?:settings|preferences)|manage\s+(?:cookies|preferences)|opt[-\s]out|subscribe\s+(?:to\s+)?(?:our\s+)?(?:newsletter|emails?)|follow\s+us\s+on|about\s+us|contact\s+us|view\s+(?:our|the)\s+(?:demo|video|pricing))\b/i;

  const out = [];
  const seen = new Set();
  const lines = snapshot.split(/\r?\n/);

  // Walk every line; the MCP snapshot uses indented role/name pairs and
  // some role nodes carry their visible text via : "..." (alert, status,
  // paragraph, heading, listitem, etc.). Strip the role/ref prefix to get
  // at the raw user-facing string.
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Capture either `role "text"` or `role: "text"` or a bare quoted string.
    const quoted = line.match(/"([^"]{6,400})"/);
    if (!quoted) continue;
    const text = quoted[1].trim();
    if (text.length < 6 || text.length > 320) continue;
    if (SKIP_RE.test(text)) continue;
    if (!VERB_RE.test(text)) continue;
    // Lowercased dedup so paraphrased copy doesn't double-inject.
    const fp = text.toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(text);
    if (out.length >= 5) break;
  }
  return out;
}

/** Token-overlap dedup so paraphrased hints collapse to the same fingerprint. */
function hintFingerprint(s) {
  const stop = new Set([
    'the','a','an','to','is','of','in','on','for','and','or','but','with',
    'as','it','this','that','be','can','you','your','use','using','call',
    'calling','first','again','before','after','then','try','until','should',
    'just','only','now','via','one','two','more','next','out','if','will',
    'has','have','had','was','were','are','been','need','needs','run','runs',
  ]);
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9_ ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stop.has(w))
    .slice(0, 8)
    .sort()
    .join('|');
}

const SYSTEM_PROMPT_LOOP = `You drive a real Chromium browser via Playwright MCP tools to verify a test case.

Every tool call returns either:
  - a fresh accessibility snapshot of the page (browser_snapshot, browser_navigate,
    browser_click, browser_type, etc. all include the post-action snapshot), or
  - a screenshot image (browser_take_screenshot).

The snapshot lists every visible interactable element with its REAL role, name,
and ref (e.g. \`button "Sign in" [ref=e42]\`). Use ONLY refs you see in the
current snapshot — NEVER invent labels or refs the page didn't return.

You are given the user's approved steps as GUIDANCE. Adapt them to what the
page actually shows. If the page surfaces "Log in" but the steps say "Sign
in" — click "Log in". If a step is impossible (the element isn't on the page),
skip it and continue.

Verification:
- Every assertion in the test case MUST be checked against the current page
  before you finish.
- For UI assertions: take a fresh browser_snapshot and read the relevant element.
- For network assertions: use browser_network_requests if available, otherwise
  describe what was visible.
- BEFORE you emit "RESULT: pass" for an assertion, you MUST call the
  assertion_check tool to ratify it against the live page snapshot. Pass at
  least one of expectedRole, expectedText, or expectedUrlPattern that should
  be true if the assertion passed (e.g. expectedText="Welcome back" for a
  login-success assertion, or expectedUrlPattern="/dashboard" for a
  navigation assertion). If assertion_check returns matched=false for ANY
  assertion, that assertion FAILS — do not output "RESULT: pass" with a ✓
  next to it. The server uses these checks as the source of truth and will
  override a hallucinated pass.

Anti-loop discipline (CRITICAL):
- BEFORE every action, scan the LATEST snapshot for a visible error banner,
  toast, or inline error (look for role="alert", text containing "invalid",
  "incorrect", "required", "denied", "not found"). If one is present, READ
  IT — the page is telling you what's wrong. Do NOT click submit again with
  the same inputs.
- If the same tool with the same args has now failed twice in this case, STOP
  retrying it. Either pivot (e.g. navigate to /register if /login keeps
  rejecting credentials you fabricated) OR end the turn and report what
  blocked you.
- NEVER invent credentials. If the test case requires a logged-in user, use
  ONLY the accounts listed under "## Available test users" (if that section
  is present). If that section is absent or empty, end the turn with
  "BLOCKED: no credentials provided" — do not try to register a fresh
  account to log in with. Fabricated credentials are the #1 cause of
  agent loops on this product.

Tricky-page playbook (E10.5 — apply when the pattern fits):
- IFRAMES / nested frames: when the snapshot shows an iframe with its own
  accessibility subtree, target elements inside it by using browser_click /
  browser_type with the frame's ref — MCP handles frame switching
  automatically. Do NOT try to click an element by name when the same name
  exists in both the parent and a frame; disambiguate by ref.
- SHADOW DOM: Playwright (and our MCP wrapper) pierces open shadow DOM
  automatically via getByRole / getByText. Do NOT reach for ">>>" or
  custom selector syntax — just use the role + accessible name from the
  snapshot. Closed shadow DOM is opaque; if a target is genuinely inside
  one, end the turn with "BLOCKED: element in closed shadow DOM".
- UNEXPECTED MODALS / cookie banners / consent prompts: if the snapshot
  shows a modal/dialog with a role="dialog" that wasn't part of the test
  intent, dismiss it FIRST (close button, "Reject" or "Decline" if it's a
  consent prompt) before continuing — otherwise interactions behind it
  silently fail with no error.
- DOWNLOAD-TRIGGERING actions: after clicking a download link/button,
  call assertion_check with expectedDownload={"filenamePattern":"<regex>"}
  to verify the file was actually captured. The server's download watcher
  records every file the browser saves; you don't need to read the
  filesystem. If the assertion says "no downloads captured", the click
  didn't trigger a download — investigate (right link? popup blocker?).
- AJAX / dynamic loading: if your action looks like it should have
  rendered new content but the next snapshot still shows the old state,
  try ONE more browser_snapshot before declaring failure — slow XHR
  responses can land just after the action's snapshot. Beyond one retry,
  the page is genuinely not updating; report it.
- GEOLOCATION / PERMISSIONS: if the test requires geolocation, the
  browser context has already been configured with coords AND the
  geolocation permission is pre-granted. Do NOT click "Allow" on a
  permission prompt — there won't be one. If you see a "location
  required" error from the SUT, the project's geo config is missing;
  report "BLOCKED: project geolocation not configured".
- BASIC / DIGEST AUTH: if the project has httpCredentials configured,
  every fetch + XHR carries the Authorization header automatically.
  Native browser auth modals will NOT appear. If the page still asks for
  credentials, the auth scheme isn't Basic — report "BLOCKED: auth
  scheme not Basic".
- DIALOGS (alert/confirm/prompt): by default the project auto-accepts
  these via an init-script so the agent doesn't hang. If a test explicitly
  validates dialog copy, the project will have autoAcceptDialogs=false
  and you'll see the dialog text in the snapshot via the page's own
  rendering.

End-of-turn output format (STRICT — no paragraphs, no markdown headings):
When all assertions are checked OR you are blocked, output ONE final
assistant message in EXACTLY this shape:

  RESULT: pass | fail | blocked
  - ✓ **<assertion-1>** — <one-line outcome quoting the page text you read>
  - ✗ **<assertion-2>** — <one-line reason it failed, quoting the page>
  - … one bullet per assertion in order
  NOTE: <optional single line — only if something surprising came up>

Rules for the final message:
- No "## headings", no "---" rules, no preamble like "I have verified…".
- Bullets ONLY, max 8.
- Bold the assertion name with **double asterisks**. Use ✓ for pass, ✗ for fail.
- Quote the actual page text in the outcome ("Incorrect email address or
  password") instead of paraphrasing.
- Keep each bullet under 140 characters.

Do NOT call more than ${MAX_TURNS} tools per test — pace yourself.`;

function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Pick the URL to navigate to before the loop starts.
 * Prefers the first approved step if it looks like a navigation step.
 */
function pickStartUrl(tc, targetUrl) {
  const approvedSteps = Array.isArray(tc.steps) ? tc.steps : [];
  const firstStep = approvedSteps[0];
  if (firstStep && /^navigate|go to|open/i.test(firstStep.action || '')) {
    if (firstStep.value && /^https?:\/\//.test(firstStep.value)) return firstStep.value;
  }
  return targetUrl;
}

/**
 * Format a single action trail entry for the persisted run trace.
 * Phase E2 — assertion_check rows render in a distinguished shape so the
 * Reports trace pane can highlight them (the parser detects the leading
 * "ASSERTION:" token).
 */
function stringifyAction(a) {
  if (a.tool === 'assertion_check') {
    let parsed = null;
    try { parsed = a.pageSnippet ? JSON.parse(a.pageSnippet) : null; } catch (_) { parsed = null; }
    const claim = (a.args?.assertion || parsed?.assertion || '(unnamed)').slice(0, 120);
    if (parsed) {
      const marker = parsed.matched ? '✓' : '✗';
      const detail = (parsed.evidence || parsed.reason || '').slice(0, 200);
      return `ASSERTION: ${marker} "${claim}" — ${detail}`;
    }
    return `ASSERTION: … "${claim}"`;
  }
  const args = a.args ? JSON.stringify(a.args).slice(0, 200) : '';
  const marker = a.ok === true ? '✓' : a.error ? `✗ ${String(a.error).slice(0, 120)}` : '…';
  return `▶ ${a.tool}(${args}) ${marker}`;
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.projectId
 * @param {object} opts.plan
 * @param {Array}  opts.scenarios
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.framework
 * @param {string} opts.targetUrl
 * @param {function} opts.send
 * @param {function} [opts.inlineCritic]   (caseContext, trail, lastSnapshot) => Promise<{ok}|{hint, severity}>
 * @param {number}   [opts.attempt]        1..N, surfaced in WS events so the UI can label retries
 * @param {object}   [opts.guidanceByTcId] testCaseId -> Supervisor guidance string (system-prompt prefix)
 * @param {object}   [opts.cancelToken]    { cancelled, reason } — checked between cases/turns; aborts early when set
 * @returns {Promise<{ runId, summary, history, systemic, cancelled }>}
 */
async function run(opts) {
  const { userId, projectId, sprintId, plan, scenarios, apiKey, model, framework, targetUrl, send,
          inlineCritic, attempt, guidanceByTcId, cancelToken, onRateLimit, extraGuidance,
          testCredentialsBlock, knownLocatorsBlock, provider: providerName } = opts;

  const scenarioMap = new Map(scenarios.map((s) => [s.id, s]));

  const runRow = await prisma.run.create({
    data: {
      userId,
      projectId,
      sprintId: sprintId || null,
      sprintName: `Agent run · ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
      status: 'running',
      config: encodeJson({ targetUrl, framework, planWaves: plan.waves.length }),
    },
  });

  // Phase B / B3: record which TCs ran in which sprint. Captured up-front
  // so even a cancelled or partially-failed run leaves the membership trail
  // intact for sprint comparison and carry-forward queries later.
  if (sprintId) {
    const allTcIds = scenarios.flatMap((s) => (s.cases || []).map((c) => c.id));
    if (allTcIds.length) {
      await prisma.sprintTestCase.createMany({
        data: allTcIds.map((tcId) => ({ sprintId, testCaseId: tcId })),
        skipDuplicates: true,
      });
    }
  }

  const totalCases = scenarios.reduce((a, s) => a + (scenarioMap.get(s.id)?.cases.length || 0), 0);
  send({ type: 'run.started', runId: runRow.id, testCount: totalCases });
  send({ type: 'agent.phase.log', phase: 'conductor', level: 'info', message: `Starting run ${runRow.id.slice(0, 8)}… framework=${framework}` });

  // Try to start the MCP session. On failure, degrade to dry-run so the
  // pipeline still completes and the user sees narration.
  let mcpSession = null;
  let dryRun = false;
  const broadcast = (msg) => send(msg);

  // Phase E10.5 — load the full Project row so MCP can configure the
  // browser context (locale / geo / permissions / proxy / etc) and the
  // downloads watcher can attribute captures to the right project.
  // Select only the fields the context-config code reads, keeping the
  // query small.
  let projectRow = null;
  try {
    projectRow = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        contextViewport: true, contextDevice: true, contextLocale: true,
        contextUserAgent: true, contextColorScheme: true, contextPermissions: true,
        contextGeolocation: true, contextHttpCredentials: true, contextExtraHeaders: true,
        contextIgnoreHttpsErrors: true, contextProxyServer: true, contextProxyBypass: true,
        autoAcceptDialogs: true,
      },
    });
  } catch (_) { /* fall through with null */ }

  try {
    mcpSession = await mcp.startMcpSession({
      userId,
      targetUrl,
      broadcast,
      project: projectRow,
    });
    sessionRegistry.set(userId, mcpSession);
    mcp.startFramePoller(mcpSession, { fps: 2 });
    send({ type: 'agent.phase.log', phase: 'conductor', level: 'info', message: `MCP browser session started (${mcpSession.mcpTools.length} tools available)` });
    send({ type: 'browser.session', runId: runRow.id, sessionId: mcpSession.id, viewport: mcpSession.viewport });
  } catch (err) {
    dryRun = true;
    send({
      type: 'agent.phase.log',
      phase: 'conductor',
      level: 'warn',
      message: `MCP unavailable (${err.code || err.message}). Conductor will narrate without live execution.`,
    });
  }

  // Resolve the LLM provider once per run. Conductor uses the SAME provider
  // across every case in the run — switching mid-suite would orphan tool-use
  // history (a tool_use block generated by Claude has no matching functionResponse
  // shape on Gemini's side, and vice-versa).
  const provider = apiKey ? getProvider(providerName) : null;
  const stats = { passed: 0, failed: 0, skipped: 0 };
  const screenshotsByTc = {};
  const history = [];
  let systemic = false;
  let cancelledByUser = false;

  try {
    for (const wave of plan.waves) {
      if (cancelToken?.cancelled) { cancelledByUser = true; break; }
      send({ type: 'agent.phase.log', phase: 'conductor', level: 'info', message: `── Wave ${wave.id}: ${wave.scenarioIds.length} scenario(s) ${wave.parallel ? 'in parallel' : 'serial'} — ${wave.why}` });

      // Run scenarios serially within a wave — true parallelism would need
      // a separate MCP session per scenario.
      for (const sid of wave.scenarioIds) {
        if (cancelToken?.cancelled) { cancelledByUser = true; break; }
        const scenario = scenarioMap.get(sid);
        if (!scenario) continue;

        send({ type: 'agent.phase.log', phase: 'conductor', level: 'scenario', message: `▸ ${scenario.priority} · ${scenario.category} · ${scenario.name}` });

        for (const tc of scenario.cases) {
          if (cancelToken?.cancelled) { cancelledByUser = true; break; }
          const caseResult = await runOneCase({
            tc, scenario, mcpSession, dryRun, provider, apiKey, model, targetUrl, runId: runRow.id, projectId, sprintId, send, stats, screenshotsByTc, framework, history,
            inlineCritic, attempt, guidancePrefix: guidanceByTcId ? guidanceByTcId[tc.id] : undefined,
            cancelToken, onRateLimit, extraGuidance, testCredentialsBlock, knownLocatorsBlock,
          });
          if (caseResult?.systemic) systemic = true;
        }
        if (cancelledByUser) break;
      }
      if (cancelledByUser) break;
    }
  } finally {
    if (mcpSession) {
      try { await mcp.stopMcpSession(mcpSession); } catch (_) {}
      sessionRegistry.remove(userId);
      send({ type: 'browser.session.end', runId: runRow.id });
    }
  }

  const total = stats.passed + stats.failed + stats.skipped;
  const passRate = total ? Math.round((stats.passed / total) * 100) : 0;
  const summary = { ...stats, total, passRate };

  await prisma.run.update({
    where: { id: runRow.id },
    data: {
      status: 'completed',
      passed: stats.passed,
      failed: stats.failed,
      skipped: stats.skipped,
      completedAt: new Date(),
    },
  });

  if (cancelledByUser) {
    send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn', message: `⛔ Run cancelled by user (${cancelToken?.reason || 'user_requested'})` });
  } else if (systemic) {
    send({ type: 'agent.phase.log', phase: 'conductor', level: 'error', message: `⚠ Systemic failure detected — environment issue prevented execution. See per-case errors.` });
  }
  send({ type: 'agent.phase.log', phase: 'conductor', level: 'info', message: `Suite complete — ${stats.passed} pass · ${stats.failed} fail · ${stats.skipped} blocked (${passRate}%)` });
  send({ type: 'run.complete', runId: runRow.id, summary, cancelled: cancelledByUser, systemic });

  return { runId: runRow.id, summary, history, systemic, cancelled: cancelledByUser };
}

// ── Phase E1 — Self-healing locator helpers ─────────────────────────────
//
// These wrap the KnowledgeBaseLocator table so the inner tool-use loop can
// stay readable. All helpers are no-op safe when projectId is null.

/** Heuristic: does this MCP tool error look like a locator-class failure? */
function isLocatorClassError(errText) {
  if (!errText) return false;
  const s = String(errText).toLowerCase();
  return (
    /element\s+not\s+found/.test(s) ||
    /locator.*(not\s+found|resolved\s+to.*0\s+elements|timeout)/.test(s) ||
    /no\s+element(s)?\s+match/.test(s) ||
    /selector.*(not\s+found|did\s+not\s+match)/.test(s) ||
    /ref\s+(not\s+found|expired|stale|missing|no\s+longer)/.test(s) ||
    /aria(-snapshot)?\s+ref.*(stale|expired|not\s+found)/.test(s) ||
    /target\s+(closed|removed)/.test(s) ||
    // Generic Playwright wait timeouts often indicate locator drift; the
    // healer evaluating a fresh snapshot will detect quickly when the
    // element is truly gone (low confidence → BlockedItem path).
    /timeout.*exceeded.*waiting\s+for/.test(s)
  );
}

/**
 * Extract a human-readable element label from an MCP tool's input args. The
 * `@playwright/mcp` tools that interact with the page (browser_click,
 * browser_type, browser_hover, browser_select_option, etc.) all carry an
 * `element` field — that's our KB lookup key. Returns null for tools that
 * don't target a specific element (navigate, snapshot, screenshot).
 */
function elementLabelFromArgs(toolName, args) {
  if (!args) return null;
  if (typeof args.element === 'string' && args.element.trim()) {
    return args.element.trim().slice(0, 200);
  }
  // browser_fill_form has fields: [{name, value, ref}] — return first name
  // so a form-fill failure tags the first field for now. Better than null.
  if (toolName === 'browser_fill_form' && Array.isArray(args.fields) && args.fields[0]?.name) {
    return String(args.fields[0].name).slice(0, 200);
  }
  return null;
}

/**
 * Append a heal-history entry to the locator row. Stored as JSON-encoded
 * string for SQLite (per CLAUDE.md schema convention). Keeps the last 50
 * entries to bound row size on chatty locators.
 */
function appendHealHistory(prevJson, entry) {
  let arr = [];
  if (prevJson) {
    try { arr = JSON.parse(prevJson); } catch (_) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
  }
  arr.push(entry);
  if (arr.length > 50) arr = arr.slice(-50);
  return JSON.stringify(arr);
}

/**
 * Look up (or create) the KB row for {projectId, element}. Returns null on
 * any error — the heal flow is best-effort and never blocks the run on a
 * KB write hiccup.
 */
async function loadKbLocator(projectId, element) {
  if (!projectId || !element) return null;
  try {
    return await prisma.knowledgeBaseLocator.findUnique({
      where: { projectId_element: { projectId, element } },
    });
  } catch (_) {
    return null;
  }
}

/**
 * Record a failure on the locator: bump failureCount, drop healthScore,
 * stamp lastFailedAt. Idempotent-ish — a missing row is created so the
 * stats still land. Returns the post-update row (or null on error).
 */
async function recordLocatorFailure({ projectId, element, errText, healerAttempt }) {
  if (!projectId || !element) return null;
  try {
    const existing = await prisma.knowledgeBaseLocator.findUnique({
      where: { projectId_element: { projectId, element } },
    });
    const nextHistory = healerAttempt
      ? appendHealHistory(existing?.healHistory || null, {
          ts: new Date().toISOString(),
          oldSelector: existing?.selector || null,
          newSelector: typeof healerAttempt.selector === 'string'
            ? healerAttempt.selector
            : JSON.stringify(healerAttempt.selector || {}),
          strategy: healerAttempt.strategy || null,
          confidence: healerAttempt.confidence ?? null,
          reason: healerAttempt.reasoning || String(errText || '').slice(0, 200),
          outcome: 'failed',
        })
      : existing?.healHistory || null;
    const nextHealth = Math.max(0, (existing?.healthScore ?? 100) - FAIL_HIT);
    if (existing) {
      return await prisma.knowledgeBaseLocator.update({
        where: { id: existing.id },
        data: {
          failureCount: (existing.failureCount || 0) + 1,
          lastFailedAt: new Date(),
          healthScore: nextHealth,
          healHistory: nextHistory,
        },
      });
    }
    return await prisma.knowledgeBaseLocator.create({
      data: {
        projectId,
        element,
        selector: '(unknown)',
        strategy: null,
        failureCount: 1,
        lastFailedAt: new Date(),
        healthScore: 100 - FAIL_HIT,
        healHistory: nextHistory,
      },
    });
  } catch (_) {
    return null;
  }
}

/**
 * Record a successful heal: bump healthScore, append healHistory with
 * outcome=success, persist the new selector + strategy.
 */
async function recordLocatorHeal({ projectId, element, healed }) {
  if (!projectId || !element || !healed) return null;
  try {
    const existing = await prisma.knowledgeBaseLocator.findUnique({
      where: { projectId_element: { projectId, element } },
    });
    if (!existing) return null;
    const selectorStr = typeof healed.selector === 'string'
      ? healed.selector
      : JSON.stringify(healed.selector || {});
    const nextHistory = appendHealHistory(existing.healHistory || null, {
      ts: new Date().toISOString(),
      oldSelector: existing.selector,
      newSelector: selectorStr,
      strategy: healed.strategy || null,
      confidence: healed.confidence ?? null,
      reason: healed.reasoning || 'heal verified by successful retry',
      outcome: 'success',
    });
    const nextHealth = Math.min(100, (existing.healthScore ?? 0) + HEAL_BUMP);
    return await prisma.knowledgeBaseLocator.update({
      where: { id: existing.id },
      data: {
        selector: selectorStr,
        strategy: healed.strategy || existing.strategy,
        healthScore: nextHealth,
        // Decrement the failureCount by 1 — we recovered from the most
        // recent failure. Never drop below zero.
        failureCount: Math.max(0, (existing.failureCount || 0) - 1),
        lastHealedAt: new Date(),
        healHistory: nextHistory,
      },
    });
  } catch (_) {
    return null;
  }
}

/**
 * First-sighting capture (E1.3): when a tool succeeds against an element,
 * upsert the KB row with intent/accessibleName/role/pageUrl/domAnchor. Only
 * fills in fields that are NULL so we don't clobber a healer-promoted
 * selector with the raw tool args. Idempotent.
 */
async function recordSuccessfulLocator({ projectId, toolName, args, snapshotText }) {
  if (!projectId) return;
  const element = elementLabelFromArgs(toolName, args);
  if (!element) return;
  try {
    const existing = await prisma.knowledgeBaseLocator.findUnique({
      where: { projectId_element: { projectId, element } },
    });
    // Pluck the ARIA tree line that corresponds to this element so future
    // healer calls have context. Same parser the picker uses.
    const candidates = mcp.parseMcpSnapshotToCandidates(snapshotText || '');
    const ref = args?.ref || (args?.fields?.[0]?.ref);
    const match = ref
      ? candidates.find((c) => c.ref === ref)
      : candidates.find((c) => c.name && c.name.toLowerCase().includes(element.toLowerCase().slice(0, 40)));
    const accessibleName = match?.name || null;
    const role = match?.role || null;
    // 200-char nearby-DOM snippet: take ±2 lines around the match line.
    let domAnchor = null;
    if (snapshotText && match) {
      const lines = String(snapshotText).split(/\r?\n/);
      const idx = lines.findIndex((ln) => match.name && ln.includes(match.name));
      if (idx >= 0) {
        domAnchor = lines.slice(Math.max(0, idx - 2), idx + 3).join('\n').slice(0, 400);
      }
    }
    if (!existing) {
      await prisma.knowledgeBaseLocator.create({
        data: {
          projectId,
          element,
          selector: match?.strategy && match?.name ? `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(accessibleName)} })` : '(captured)',
          strategy: role ? 'role' : null,
          intent: element,
          accessibleName,
          role,
          domAnchor,
        },
      });
      return;
    }
    // Update only the still-null intent fields and bump occurrences.
    const data = { occurrences: (existing.occurrences || 0) + 1 };
    if (!existing.intent && element) data.intent = element;
    if (!existing.accessibleName && accessibleName) data.accessibleName = accessibleName;
    if (!existing.role && role) data.role = role;
    if (!existing.domAnchor && domAnchor) data.domAnchor = domAnchor;
    await prisma.knowledgeBaseLocator.update({ where: { id: existing.id }, data });
  } catch (_) {
    // First-sighting capture is best-effort — never let a KB write break the run.
  }
}

/**
 * Given the healer's `{ strategy, selector }` proposal and a fresh MCP
 * snapshot, find the accessibility-tree `ref` that matches. The MCP tools
 * are ref-based, so to "re-issue with the new selector" we translate the
 * healer's intent into the ref the tool needs.
 *
 * Returns the matching ref string, or null if no match found.
 */
function findRefForHealedProposal(snapshotText, proposal) {
  if (!proposal || !snapshotText) return null;
  const candidates = mcp.parseMcpSnapshotToCandidates(snapshotText);
  const { strategy, selector } = proposal;
  if (strategy === 'role') {
    const role = selector?.role;
    const name = selector?.name;
    if (!role) return null;
    const match = candidates.find((c) =>
      c.strategy === 'role' && c.role === role &&
      (!name || (c.name || '').toLowerCase() === String(name).toLowerCase()),
    );
    return match?.ref || null;
  }
  if (strategy === 'testid') {
    const match = candidates.find((c) => c.strategy === 'testid' && (c.expression || '').includes(String(selector)));
    return match?.ref || null;
  }
  if (strategy === 'text' || strategy === 'label') {
    const needle = String(selector || '').toLowerCase();
    const match = candidates.find((c) => (c.name || '').toLowerCase().includes(needle));
    return match?.ref || null;
  }
  // CSS — we can't resolve to a ref without evaluating against the page.
  // The healer's `selector` is still useful as a KB-stored recipe for the
  // NEXT run; for this run we just fail through.
  return null;
}

async function runOneCase({
  tc, scenario, mcpSession, dryRun, provider, apiKey, model, targetUrl, runId, projectId, sprintId, send, stats, screenshotsByTc, framework, history,
  inlineCritic, attempt, guidancePrefix, cancelToken, onRateLimit, extraGuidance, testCredentialsBlock, knownLocatorsBlock,
}) {
  const attemptLabel = attempt && attempt > 1 ? ` (attempt ${attempt})` : '';
  send({ type: 'agent.phase.log', phase: 'conductor', level: 'case.start', message: `   • ${tc.name}${attemptLabel}`, tcId: tc.id });
  await prisma.testCase.update({ where: { id: tc.id }, data: { status: 'running' } });

  // E10.5 — mark the case-start timestamp so the downloads watcher can
  // attribute files captured during this case to its RunResult once
  // RunResult.create finishes. Cleared per-case so download attribution
  // doesn't bleed across cases.
  if (mcpSession) {
    try { downloadWatcher.setCaseStart(mcpSession); } catch (_) {}
  }

  // Loop-detection bookkeeping (cleared per case)
  const toolCallCounts = new Map();   // `${tool}|${argsHash}` -> count
  const surfacedErrors = new Set();   // D1: page error texts already injected
  const surfacedInstructions = new Set(); // E1.6: page instruction texts already injected
  const visionFallbackTried = new Set();  // E1.6: tool|args keys we've vision-rescued once (no re-rescue)
  const warnedRepeats = new Set();    // D2: tool|args keys we've already soft-warned about
  // E2: every assertion_check call's parsed payload, in order. Used to
  // ratify the agent's end-of-turn "pass" claim — any matched=false here
  // overrides a hallucinated pass.
  const assertionCheckResults = [];
  const seenHintFingerprints = new Set();
  let consecutiveErrors = 0;
  let lastErrorMsg = null;
  let lastHintNorm = '';
  let hintsEmittedThisCase = 0;
  const MAX_HINTS_PER_CASE = Number(process.env.QAAI_MAX_HINTS_PER_CASE) || 2;
  let caseSystemic = false;

  const approvedSteps = Array.isArray(tc.steps) ? tc.steps : [];
  const assertions = tc.assertions || '';
  const startUrl = pickStartUrl(tc, targetUrl);

  const actionTrail = [];
  const screenshots = [];
  let status = 'pass';
  let error = null;
  let lastSnapshotText = '';

  // ── Dry-run path (MCP failed to start or no provider key) ──────────
  if (dryRun || !mcpSession || !provider) {
    for (const step of approvedSteps) {
      send({ type: 'browser.action', runId, tcId: tc.id, narration: `${step.action || ''}${step.target ? ' — ' + step.target : ''}`.trim() });
      actionTrail.push({ turn: 0, tool: 'narrate', args: { step }, ok: true });
      await pause(250);
    }
    if (!provider) {
      status = 'blocked';
      error = 'No AI provider API key configured — cannot drive MCP.';
    } else if (dryRun) {
      status = 'blocked';
      error = 'Browser unavailable — cannot execute test case.';
      caseSystemic = true;
    }
    history.push({ testCaseId: tc.id, name: tc.name, status, error, actionTrail, originalSteps: approvedSteps, assertions, finalSnapshot: '' });
    await persistResultAndCodegen({ tc, scenario, runId, projectId, sprintId, status, error, screenshots, actionTrail, lastSnapshotText, framework, provider, apiKey, model, targetUrl, send, mcpSession });
    if (status === 'pass') stats.passed++;
    else if (status === 'fail') stats.failed++;
    else stats.skipped++;
    return { systemic: caseSystemic };
  }

  // ── Real MCP tool-use loop ─────────────────────────────────────────

  // 1. Pre-navigate (deterministic, doesn't burn a Claude turn)
  try {
    send({ type: 'agent.phase.log', phase: 'conductor', level: 'tool', message: `   ↳ Navigating to ${startUrl}`, tcId: tc.id });
    const navRes = await mcp.callTool(mcpSession, 'browser_navigate', { url: startUrl });
    if (navRes?.content) lastSnapshotText = mcp.textOfContent(navRes.content);
    actionTrail.push({ turn: -1, tool: 'browser_navigate', args: { url: startUrl }, ok: !navRes?.isError, error: navRes?.isError ? mcp.textOfContent(navRes.content) : undefined, pageSnippet: lastSnapshotText.slice(0, 800) });
  } catch (navErr) {
    send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn', message: `   ⚠ Could not navigate: ${navErr.message}`, tcId: tc.id });
  }

  // 2. Build the Claude tool-use loop
  const anthropicTools = mcp.listAnthropicTools(mcpSession);

  const userMsg = [
    `## Test case`,
    tc.name,
    ``,
    `## Test type`,
    `${tc.type || 'functional'} (${scenario.category || 'general'}, ${scenario.priority || 'P2'})`,
    ``,
    `## Assertions to verify`,
    assertions || '(none specified)',
    ``,
    `## Approved user steps (GUIDANCE — adapt to the real page)`,
    JSON.stringify(approvedSteps, null, 2),
    ``,
    `## Start URL (already opened)`,
    startUrl,
    ``,
    `## Initial page snapshot`,
    lastSnapshotText ? lastSnapshotText.slice(0, 4000) : '(no snapshot returned)',
    ``,
    `Drive the browser to verify EVERY assertion. End your turn when done.`,
  ].join('\n');

  const messages = [{ role: 'user', content: userMsg }];

  // Layered system prompt for this case:
  //   1. SYSTEM_PROMPT_LOOP — the agent's domain rules
  //   2. + Supervisor guidance (when present) — case-specific instructions
  //      from the Supervisor's final-intervention pass
  //   3. + composeSystemPrompt prepends OPERATOR guidance (project-wide
  //      `Project.aiGuidance` + per-case `TestCase.userGuidance`, joined by
  //      the route before calling conductor.run)
  // Layer order: SYSTEM_PROMPT_LOOP (domain rules)
  //  → testCredentialsBlock (project's authorised test users, if any)
  //  → knownLocatorsBlock (Phase E1.7 — prior-run locators, prefer on first try)
  //  → Supervisor guidance (case-specific from prior attempt, if any)
  let baseSystem = SYSTEM_PROMPT_LOOP;
  if (testCredentialsBlock) {
    baseSystem += `\n\n${testCredentialsBlock}`;
  }
  if (knownLocatorsBlock) {
    baseSystem += `\n\n${knownLocatorsBlock}`;
  }
  if (guidancePrefix) {
    baseSystem += `\n\n## Supervisor guidance (case-specific)\n${guidancePrefix}`;
  }
  // If the route passed `extraGuidance` with a per-case section that names
  // this TC, lift it onto the per-case prompt — Claude sees it as immediate
  // operator instruction for THIS attempt, not generic project context.
  const systemPrompt = composeSystemPrompt(baseSystem, extraGuidance);
  if (guidancePrefix) {
    send({ type: 'agent.phase.log', phase: 'conductor', level: 'info',
           message: `   🧭 Supervisor guidance applied: ${guidancePrefix.slice(0, 160)}${guidancePrefix.length > 160 ? '…' : ''}`,
           tcId: tc.id });
  }

  let assistantClaimedDone = false;
  let loopAbortReason = null;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Honour user cancellation BEFORE we burn another Claude turn
    if (cancelToken?.cancelled) {
      loopAbortReason = `cancelled by user (${cancelToken.reason || 'user_requested'})`;
      send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn', message: `   ⛔ ${loopAbortReason}`, tcId: tc.id });
      break;
    }

    let resp;
    try {
      resp = await provider.complete({
        apiKey,
        model,
        maxTokens: 1500,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
        onRateLimit,
      });
    } catch (err) {
      status = 'fail';
      error = `${provider.name} call failed: ${err.message}`;
      send({ type: 'agent.phase.log', phase: 'conductor', level: 'error', message: `   ✗ ${error}`, tcId: tc.id });
      break;
    }

    // Stream narration / tool plans to the UI
    for (const block of resp.content || []) {
      if (block.type === 'text' && block.text) {
        send({ type: 'browser.action', runId, tcId: tc.id, narration: block.text });
      } else if (block.type === 'tool_use') {
        send({ type: 'browser.action', runId, tcId: tc.id, tool: block.name, args: block.input, narration: `${block.name}` });
        actionTrail.push({ turn, tool: block.name, args: block.input });
      }
    }

    if (resp.stop_reason === 'end_turn') {
      assistantClaimedDone = true;
      break;
    }
    if (resp.stop_reason !== 'tool_use') {
      // Unexpected (max_tokens, stop_sequence, etc.) — bail
      send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn', message: `   ⚠ Unexpected stop_reason=${resp.stop_reason}`, tcId: tc.id });
      break;
    }

    // Execute each tool_use
    const toolUses = (resp.content || []).filter((c) => c.type === 'tool_use');
    const toolResults = [];
    for (const tu of toolUses) {
      // ── Phase E1 — quarantine check BEFORE the call. If the targeted
      //    element has a KB row with healthScore < QUARANTINE_HEALTH, we've
      //    healed it too many times — the element is probably genuinely
      //    deleted. Skip the tool call entirely; emit a BlockedItem and
      //    feed Claude a synthetic "quarantined" tool result so it pivots.
      let quarantined = false;
      const targetElement = elementLabelFromArgs(tu.name, tu.input || {});
      if (projectId && targetElement) {
        const kbCheck = await loadKbLocator(projectId, targetElement);
        if (kbCheck && (kbCheck.healthScore ?? 100) < QUARANTINE_HEALTH) {
          quarantined = true;
          send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn',
                 message: `   🛑 Locator "${targetElement}" quarantined (health ${kbCheck.healthScore}) — refusing tool call.`, tcId: tc.id });
          try {
            await prisma.blockedItem.create({
              data: {
                projectId,
                sprintId: sprintId || null,
                runId,
                testCaseId: tc.id,
                reason: 'locator_quarantined',
                locator: kbCheck.selector || targetElement,
                message: `Locator "${targetElement}" quarantined (healthScore=${kbCheck.healthScore}). The element has failed too many times; the agent refused to retry.`,
                severity: 'high',
                aiCategory: 'selector_drift',
                aiSuggestedFix: 'Verify the element still exists; if it was renamed/removed, update the test case steps or delete the KB row to retry.',
                aiAnalyzedAt: new Date(),
              },
            });
          } catch (_) {}
        }
      }

      let result;
      if (quarantined) {
        result = {
          content: [{ type: 'text', text: `BLOCKED: locator "${targetElement}" was quarantined after repeated failures. Pivot — do NOT retry this element. End the turn with the BLOCKED status if no alternative exists.` }],
          isError: true,
        };
      } else {
        try {
          result = await mcp.callTool(mcpSession, tu.name, tu.input || {});
        } catch (callErr) {
          result = { content: [{ type: 'text', text: `MCP call failed: ${callErr.message}` }], isError: true };
        }
      }

      // ── Phase E1 — heal-on-failure intercept. If the tool errored with
      //    a locator-class message AND we have a targetable element, take
      //    a fresh snapshot, ask the healer for a proposal, and retry the
      //    tool with the matching ref. On success the healed result replaces
      //    the failure transparently (Claude doesn't see the original error).
      if (!quarantined && result.isError && projectId && targetElement && !cancelToken?.cancelled) {
        const errPreview = mcp.textOfContent(result.content) || '';
        if (isLocatorClassError(errPreview)) {
          send({ type: 'agent.phase.log', phase: 'conductor', level: 'info',
                 message: `   🩺 Locator-class failure on "${targetElement}" — invoking healer…`, tcId: tc.id });
          // Fresh snapshot (the failed call may have left state stale).
          let freshSnap = '';
          try {
            const snap = await mcp.snapshot(mcpSession);
            freshSnap = snap?.text || '';
          } catch (_) { freshSnap = mcp.getLastSnapshot(mcpSession) || ''; }
          const kb = await loadKbLocator(projectId, targetElement);
          let healHistoryArr = [];
          if (kb?.healHistory) {
            try { healHistoryArr = JSON.parse(kb.healHistory) || []; } catch (_) {}
          }
          let healed = null;
          try {
            healed = await healer.healLocator({
              apiKey, model, provider: provider?.name,
              intent: kb?.intent || targetElement,
              brokenLocator: kb?.selector || (tu.input?.ref ? `ref=${tu.input.ref}` : '(unknown)'),
              brokenStrategy: kb?.strategy || null,
              freshSnapshot: freshSnap,
              history: healHistoryArr,
              signal: cancelToken?.signal,
              onLog: async (lvl, msg) => send({ type: 'agent.phase.log', phase: 'healer', level: lvl, message: `   ${msg}`, tcId: tc.id }),
              onRateLimit,
              extraGuidance,
            });
          } catch (healErr) {
            send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn',
                   message: `   ⚠ Healer failed: ${healErr.message}`, tcId: tc.id });
          }

          if (healed && healed.confidence >= HEAL_MIN_CONFIDENCE) {
            const newRef = findRefForHealedProposal(freshSnap, healed);
            if (newRef) {
              send({ type: 'agent.phase.log', phase: 'conductor', level: 'tool',
                     message: `   ↻ Retrying ${tu.name} with healed ref=${newRef} (${healed.strategy}, conf ${healed.confidence})`, tcId: tc.id });
              let retryRes;
              try {
                const retryArgs = { ...tu.input, ref: newRef };
                retryRes = await mcp.callTool(mcpSession, tu.name, retryArgs);
              } catch (retryErr) {
                retryRes = { content: [{ type: 'text', text: `Heal retry failed: ${retryErr.message}` }], isError: true };
              }
              if (!retryRes.isError) {
                // Heal succeeded — record + replace the result so Claude sees a clean success.
                await recordLocatorHeal({ projectId, element: targetElement, healed });
                result = retryRes;
                send({ type: 'agent.phase.log', phase: 'conductor', level: 'info',
                       message: `   ✅ Heal succeeded — locator KB updated for "${targetElement}".`, tcId: tc.id });
              } else {
                // Retry failed: record failure (drops healthScore further), emit BlockedItem, keep original error for Claude.
                await recordLocatorFailure({ projectId, element: targetElement, errText: errPreview, healerAttempt: healed });
                try {
                  await prisma.blockedItem.create({
                    data: {
                      projectId, sprintId: sprintId || null, runId, testCaseId: tc.id,
                      reason: 'locator_drift',
                      locator: kb?.selector || targetElement,
                      message: `Healer proposed ${healed.strategy} → ${JSON.stringify(healed.selector)} (conf ${healed.confidence}) but retry still failed.`,
                      severity: 'normal',
                      aiCategory: 'selector_drift',
                      aiSummary: healed.reasoning || null,
                      aiSuggestedFix: healed.reasoning || 'Inspect the page manually and update the locator.',
                      aiAnalyzedAt: new Date(),
                    },
                  });
                } catch (_) {}
                send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn',
                       message: `   ⚠ Heal retry failed — keeping original error for the agent to handle.`, tcId: tc.id });
              }
            } else {
              await recordLocatorFailure({ projectId, element: targetElement, errText: errPreview, healerAttempt: healed });
              send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn',
                     message: `   ⚠ Healer's proposal (${healed.strategy}) doesn't map to a ref in the current snapshot — cannot retry server-side.`, tcId: tc.id });
            }
          } else if (healed) {
            // Low confidence — record the attempt for KB history, emit a BlockedItem hint, but let Claude see the original error.
            await recordLocatorFailure({ projectId, element: targetElement, errText: errPreview, healerAttempt: healed });
            try {
              await prisma.blockedItem.create({
                data: {
                  projectId, sprintId: sprintId || null, runId, testCaseId: tc.id,
                  reason: 'locator_drift',
                  locator: kb?.selector || targetElement,
                  message: `Healer found no high-confidence replacement for "${targetElement}". Snapshot may not contain the intended element.`,
                  severity: 'normal',
                  aiCategory: 'selector_drift',
                  aiSummary: healed.reasoning || null,
                  aiSuggestedFix: 'The element may have been removed or renamed. Update the test case steps or KB row.',
                  aiAnalyzedAt: new Date(),
                },
              });
            } catch (_) {}
          } else {
            // Healer returned nothing — still bump failureCount so quarantine eventually kicks in.
            await recordLocatorFailure({ projectId, element: targetElement, errText: errPreview, healerAttempt: null });
          }
        }
      }

      const trailEntry = actionTrail[actionTrail.length - 1];
      const errText = result.isError ? mcp.textOfContent(result.content) : null;
      if (trailEntry && trailEntry.tool === tu.name) {
        trailEntry.ok = !result.isError;
        if (errText) trailEntry.error = errText;
        const snippet = mcp.textOfContent(result.content);
        if (snippet) {
          // Phase E2: assertion_check returns a JSON payload, NOT a page
          // snapshot. Don't clobber `lastSnapshotText` with it — that would
          // corrupt downstream snapshot-readers (page-error extractor,
          // page-instructions extractor, the inline Critic). Snippet still
          // lands on the trail entry for the UI to render.
          if (tu.name !== 'assertion_check') {
            lastSnapshotText = snippet;
          }
          trailEntry.pageSnippet = snippet.slice(0, 800);
        }
      }

      // ── Phase E1.3 — first-sighting capture on successful tool call ───
      if (!result.isError && projectId && targetElement) {
        // Fire-and-forget; capture is best-effort and never blocks the loop.
        recordSuccessfulLocator({
          projectId,
          toolName: tu.name,
          args: tu.input || {},
          snapshotText: lastSnapshotText,
        }).catch(() => {});
      }

      // ── Loop-detection: same {tool, args} called too many times ─────
      const argsHash = JSON.stringify(tu.input || {}).slice(0, 500);
      const callKey = `${tu.name}|${argsHash}`;
      const newCount = (toolCallCounts.get(callKey) || 0) + 1;
      toolCallCounts.set(callKey, newCount);
      if (newCount > MAX_IDENTICAL_TOOL_CALLS) {
        // ── Phase E1.6 vision fallback ─────────────────────────────────
        // Before we abort, give the agent ONE chance to read the page via
        // vision. The cheap snapshot-text reader (extractPageInstructions)
        // already ran every turn — if it found nothing actionable but the
        // page genuinely has instructional copy (a paragraph the snapshot
        // text serializer didn't quote, an image-rendered notice, etc.),
        // vision catches it. Only fires once per (tool, args) pair so a
        // genuinely-broken loop still aborts on the second occurrence.
        if (
          provider && apiKey &&
          !visionFallbackTried.has(callKey) &&
          !cancelToken?.cancelled
        ) {
          visionFallbackTried.add(callKey);
          send({ type: 'agent.phase.log', phase: 'conductor', level: 'info',
                 message: `   📸 Loop-guard would fire — taking a screenshot and asking the AI what the page is saying first…`, tcId: tc.id });
          try {
            const shot = await mcp.screenshot(mcpSession);
            if (shot?.data) {
              const insn = await instructionReader.readInstructions({
                apiKey, model, provider: provider.name,
                screenshotBase64: shot.data,
                mediaType: shot.mediaType || 'image/jpeg',
                stuckContext: `Repeatedly calling ${tu.name} with the same arguments (${newCount}× now). Failing to make progress.`,
                signal: cancelToken?.signal,
                onLog: async (lvl, msg) => send({ type: 'agent.phase.log', phase: 'instructionReader', level: lvl, message: `   ${msg}`, tcId: tc.id }),
                onRateLimit,
                extraGuidance,
              });
              if (insn && insn.instructions.length > 0 && insn.confidence >= 30) {
                // Vision found something — inject as user-message guidance,
                // reset this tool's call counter once, and DO NOT abort.
                // The agent gets one more shot armed with real instructions.
                toolCallCounts.set(callKey, 0);
                send({ type: 'agent.phase.log', phase: 'conductor', level: 'info',
                       message: `   📜 Vision read the page (conf ${insn.confidence}): "${insn.summary || insn.instructions[0]}" — resetting loop counter for ${tu.name} once.`, tcId: tc.id });
                messages.push({
                  role: 'user',
                  content: `[page-instructions guidance — read these BEFORE retrying ${tu.name}]\nThe page is telling you what to do. Vision-extracted instructions:\n${insn.instructions.map((i) => `  • ${i}`).join('\n')}\n\nSummary: ${insn.summary || '(no summary)'}\n\nPivot to follow these instructions. Do NOT repeat ${tu.name} with the same arguments — read the page first.`,
                });
              } else {
                // Vision found nothing actionable — proceed with the abort.
                loopAbortReason = `loop_detected: agent called ${tu.name} with the same arguments ${newCount} times (vision-fallback found no actionable instructions on the page)`;
                send({ type: 'agent.phase.log', phase: 'conductor', level: 'error',
                       message: `   ⛔ ${loopAbortReason} — aborting case`, tcId: tc.id });
              }
            } else {
              loopAbortReason = `loop_detected: agent called ${tu.name} with the same arguments ${newCount} times (vision-fallback could not get a screenshot)`;
              send({ type: 'agent.phase.log', phase: 'conductor', level: 'error',
                     message: `   ⛔ ${loopAbortReason} — aborting case`, tcId: tc.id });
            }
          } catch (visionErr) {
            // If vision itself errored, fall through to the original abort.
            loopAbortReason = `loop_detected: agent called ${tu.name} with the same arguments ${newCount} times (vision-fallback failed: ${visionErr.message})`;
            send({ type: 'agent.phase.log', phase: 'conductor', level: 'error',
                   message: `   ⛔ ${loopAbortReason} — aborting case`, tcId: tc.id });
          }
        } else {
          // Already tried vision once OR no provider available — abort.
          loopAbortReason = `loop_detected: agent called ${tu.name} with the same arguments ${newCount} times`;
          send({ type: 'agent.phase.log', phase: 'conductor', level: 'error',
                 message: `   ⛔ ${loopAbortReason} — aborting case`, tcId: tc.id });
        }
      }

      // ── Consecutive-error tracking + systemic detection ──────────────
      if (result.isError) {
        if (sameRootCause(errText, lastErrorMsg)) consecutiveErrors++;
        else consecutiveErrors = 1;
        lastErrorMsg = errText;
        if (isSystemicError(errText)) {
          caseSystemic = true;
          loopAbortReason = loopAbortReason || `systemic_error: ${(errText || '').slice(0, 120)}`;
          send({ type: 'agent.phase.log', phase: 'conductor', level: 'error',
                 message: `   ⛔ Systemic error — aborting case: ${(errText || '').slice(0, 120)}`, tcId: tc.id });
        } else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          loopAbortReason = loopAbortReason || `consecutive_errors: same error ${consecutiveErrors}x in a row`;
          send({ type: 'agent.phase.log', phase: 'conductor', level: 'error',
                 message: `   ⛔ ${loopAbortReason} — aborting case`, tcId: tc.id });
        }
      } else {
        consecutiveErrors = 0;
        lastErrorMsg = null;
      }

      // E2 — capture every assertion_check result so we can ratify the
      // agent's final pass claim before persisting. Best-effort JSON parse:
      // on parse failure we treat as matched=false (the agent can't claim
      // pass on malformed checks either).
      if (tu.name === 'assertion_check') {
        const txt = mcp.textOfContent(result.content) || '';
        let parsed = null;
        try { parsed = JSON.parse(txt); } catch (_) { parsed = null; }
        const record = parsed
          ? {
              matched: !!parsed.matched,
              assertion: parsed.assertion || tu.input?.assertion || null,
              reason: parsed.reason || null,
              evidence: parsed.evidence || null,
              args: tu.input || {},
            }
          : {
              matched: false,
              assertion: tu.input?.assertion || null,
              reason: 'parse_error',
              evidence: txt.slice(0, 200),
              args: tu.input || {},
            };
        assertionCheckResults.push(record);
        send({
          type: 'agent.phase.log', phase: 'conductor',
          level: record.matched ? 'info' : 'warn',
          message: `   ${record.matched ? '✓' : '✗'} assertion_check "${(record.assertion || '').slice(0, 80)}" — ${(record.evidence || record.reason || '').slice(0, 160)}`,
          tcId: tc.id,
        });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: mcp.normaliseMcpContentForAnthropic(result.content),
        is_error: !!result.isError,
      });
    }

    // Opportunistic screenshot every N turns
    if (turn % SCREENSHOT_EVERY_N_TURNS === 1) {
      try {
        const shot = await mcp.screenshot(mcpSession);
        if (shot) {
          const url = mcp.saveScreenshotToDisk(shot, `${tc.id}-${turn}`);
          if (url) screenshots.push(url);
        }
      } catch (_) {}
    }

    messages.push({ role: 'assistant', content: resp.content });
    messages.push({ role: 'user', content: toolResults });

    // ── D1 + D2 — synthetic context guidance for the next turn ──
    // D1: surface visible page errors (alert / status / error-shaped text)
    //     from the post-action snapshot so the agent reads them instead of
    //     glossing past. Dedup against prior turns so repeated alerts don't
    //     spam the conversation.
    // D2: when a tool with identical args has now failed before in this case,
    //     append an explicit "do not retry" note BEFORE the conductor's hard
    //     stop at MAX_IDENTICAL_TOOL_CALLS.
    const guidanceLines = [];
    for (const text of extractPageErrors(lastSnapshotText)) {
      if (surfacedErrors.has(text)) continue;
      surfacedErrors.add(text);
      guidanceLines.push(`Page error visible: "${text}". Read this — the page is telling you what is wrong. Do NOT submit the same inputs again.`);
    }
    // E1.6 — surface page INSTRUCTIONS (paragraphs telling the user what to
    // do, e.g. "Click Register first to create an account"). D1 catches
    // alerts; this catches the OTHER class of visible copy that the agent
    // should follow but tends to ignore. Dedupe via a parallel Set so a
    // multi-turn sticky banner doesn't spam the conversation.
    const pageInstructions = extractPageInstructions(lastSnapshotText);
    if (pageInstructions.length) {
      const fresh = [];
      for (const text of pageInstructions) {
        if (surfacedInstructions.has(text)) continue;
        surfacedInstructions.add(text);
        fresh.push(text);
      }
      if (fresh.length) {
        guidanceLines.push(
          `Page instructions visible (FOLLOW these — they tell you what the user must do):\n${fresh.map((t) => `  • "${t}"`).join('\n')}`,
        );
        send({ type: 'agent.phase.log', phase: 'conductor', level: 'info',
               message: `   📜 Page instructions read: ${fresh.length} actionable line(s) injected.`, tcId: tc.id });
      }
    }
    for (const tu of toolUses) {
      const argsHash = JSON.stringify(tu.input || {}).slice(0, 500);
      const key = `${tu.name}|${argsHash}`;
      const count = toolCallCounts.get(key) || 0;
      const tr = toolResults.find((r) => r.tool_use_id === tu.id);
      if (tr?.is_error && count >= 2 && count < MAX_IDENTICAL_TOOL_CALLS && !warnedRepeats.has(key)) {
        warnedRepeats.add(key);
        guidanceLines.push(`You have called ${tu.name} with these exact arguments ${count} times in this test case and the previous attempts failed. Do NOT retry the same call — pivot to a different approach (read the page errors, navigate elsewhere, or end the turn with RESULT: blocked).`);
        send({ type: 'agent.phase.warn', phase: 'conductor', tcId: tc.id,
               message: `   ⚠ Conductor appears stuck: ${tu.name} repeated ${count}× — injecting pivot hint`, attempt });
      }
    }
    if (guidanceLines.length) {
      messages.push({
        role: 'user',
        content: `[context guidance]\n${guidanceLines.map((l) => `- ${l}`).join('\n')}`,
      });
    }

    // ── Inline Critic: monitor the trail and inject a hint if needed ──
    // The Critic runs after every turn that errored, OR every Nth turn
    // regardless. It returns either { ok: true } (silent pass) or a hint
    // that gets prepended as a user message before the next Claude turn.
    if (inlineCritic) {
      const lastTrailEntry = actionTrail[actionTrail.length - 1];
      const lastTurnErrored = !!(lastTrailEntry && lastTrailEntry.error);
      const periodic = (turn + 1) % INLINE_CRITIC_EVERY === 0;
      if (lastTurnErrored || periodic) {
        try {
          const verdict = await inlineCritic({
            caseContext: { name: tc.name, assertions, originalSteps: approvedSteps },
            trail: actionTrail,
            lastSnapshot: mcp.getLastSnapshot(mcpSession) || lastSnapshotText,
          });
          // ── Phase E2.2 — abort_pass_claim verdict ─────────────────────
          // The strongest Critic signal: snapshot contradicts the agent's
          // pass claim. Inject a forced-re-verify user message and DON'T
          // count this against the normal hint cap — this is a correctness
          // gate, not generic advice.
          if (verdict?.verdict === 'abort_pass_claim' && verdict.reasoning) {
            send({ type: 'agent.phase.log', phase: 'critic', level: 'warn',
                   message: `   🛑 Critic blocked pass claim — ${verdict.reasoning.slice(0, 160)}`,
                   tcId: tc.id, attempt });
            messages.push({
              role: 'user',
              content: `[Critic blocked your pass claim]\nThe Critic reviewed the page and disagrees:\n  "${verdict.reasoning}"\n\nBefore you emit RESULT: pass, you MUST:\n  1. Take a fresh browser_snapshot.\n  2. Call assertion_check for EACH assertion you intend to mark ✓, with concrete expectedRole / expectedText / expectedUrlPattern criteria.\n  3. If any assertion_check returns matched=false, you cannot pass that assertion — mark it ✗ and emit RESULT: fail.`,
            });
            // Skip the rest of the inline-critic branch this turn.
            continue;
          }
          if (verdict && !verdict.ok && verdict.hint) {
            const sev = verdict.severity || 'info';
            const hintFp = hintFingerprint(verdict.hint);
            const isDup = (hintFp && seenHintFingerprints.has(hintFp))
                       || normaliseHint(verdict.hint) === lastHintNorm;

            // The Critic's own language is often the clearest signal that the
            // browser died. If the hint mentions browser/page/context death
            // even once, treat it as systemic — no amount of retry will help.
            const looksLikeBrowserDeath = isSystemicError(verdict.hint)
              || /browser.*(closing|crashing|dying|dead|restart)/i.test(verdict.hint)
              || /relaunch|reset.*session|context.*closed/i.test(verdict.hint);

            if (looksLikeBrowserDeath) {
              caseSystemic = true;
              loopAbortReason = loopAbortReason || `browser_death_hint: ${verdict.hint.slice(0, 120)}`;
              send({ type: 'agent.phase.log', phase: 'critic', level: 'error',
                     message: `   ⛔ Browser appears dead/closed — aborting case (Critic: "${verdict.hint.slice(0, 100)}")`,
                     tcId: tc.id, attempt });
            } else if (isDup) {
              // Same family of advice already injected — don't spam the agent.
              send({ type: 'agent.phase.log', phase: 'critic', level: 'info',
                     message: `   ⚡ (duplicate hint suppressed)`,
                     tcId: tc.id, attempt });
            } else if (hintsEmittedThisCase >= MAX_HINTS_PER_CASE) {
              // Too many hints with no progress — abort the case.
              loopAbortReason = loopAbortReason || `hint_cap: emitted ${hintsEmittedThisCase} hint(s) without progress`;
              send({ type: 'agent.phase.log', phase: 'critic', level: 'warn',
                     message: `   ⛔ Critic ran out of new advice — aborting case after ${hintsEmittedThisCase} hint(s)`,
                     tcId: tc.id, attempt });
            } else {
              hintsEmittedThisCase++;
              if (hintFp) seenHintFingerprints.add(hintFp);
              lastHintNorm = normaliseHint(verdict.hint);
              send({
                type: 'agent.phase.log', phase: 'critic',
                level: sev,
                message: `   ⚡ live hint: ${verdict.hint}`,
                tcId: tc.id, attempt,
              });
              messages.push({
                role: 'user',
                content: `[live monitor hint, severity=${sev}]: ${verdict.hint}`,
              });
            }
          }
        } catch (_) {
          // Inline critic must never block the Conductor.
        }
      }
    }

    // ── Loop-abort: bail the per-case loop if loop detection tripped ──
    if (loopAbortReason) {
      status = caseSystemic ? 'blocked' : 'fail';
      error = error || loopAbortReason;
      break;
    }
  }

  // Did the agent fail to verify? Look at the trail.
  // - If the last action errored AND Claude ended its turn anyway, mark fail.
  // - If we hit MAX_TURNS without end_turn, mark blocked.
  if (!assistantClaimedDone) {
    status = 'blocked';
    error = error || `Hit ${MAX_TURNS}-turn ceiling without finishing.`;
  } else {
    // Look at the final few actions for unresolved errors.
    const lastErr = [...actionTrail].reverse().find((a) => a.error);
    if (lastErr) {
      // If the last action errored and Claude immediately ended its turn, treat as fail
      const lastTrail = actionTrail[actionTrail.length - 1];
      if (lastTrail && lastTrail.error) {
        status = 'fail';
        error = lastTrail.error;
      }
    }
  }

  // ── Phase E2 — ratify the agent's pass claim against assertion_check ──
  // If the case has assertions defined AND status survived as 'pass' so far,
  // the agent's claim must be backed by:
  //   (a) at least one assertion_check call (the agent didn't skip the gate)
  //   (b) every assertion_check returning matched=true (no contradicted claim)
  // Otherwise downgrade to fail with a clear reason. The Critic's post-hoc
  // review (D4) still runs separately — this is the in-loop ratification.
  if (status === 'pass' && assertions && assertions.trim().length > 0) {
    if (assertionCheckResults.length === 0) {
      status = 'fail';
      error = `Agent claimed pass without calling assertion_check on any declared assertion. Server requires every pass to be ratified against the live page snapshot.`;
      send({
        type: 'agent.phase.log', phase: 'conductor', level: 'warn',
        message: `   ⚠ Pass claim overridden — no assertion_check calls were made for this case.`,
        tcId: tc.id,
      });
    } else {
      const failed = assertionCheckResults.filter((r) => !r.matched);
      if (failed.length > 0) {
        status = 'fail';
        const first = failed[0];
        error = `assertion_check failed for "${first.assertion || '(unnamed)'}": ${first.evidence || first.reason || 'no evidence'}` +
                (failed.length > 1 ? ` (+ ${failed.length - 1} more failed check${failed.length - 1 === 1 ? '' : 's'})` : '');
        send({
          type: 'agent.phase.log', phase: 'conductor', level: 'warn',
          message: `   ⚠ Pass claim overridden — ${failed.length} assertion_check call(s) returned matched=false.`,
          tcId: tc.id,
        });
      }
    }
  }

  // Final screenshot
  if (mcpSession) {
    try {
      const shot = await mcp.screenshot(mcpSession);
      if (shot) {
        const url = mcp.saveScreenshotToDisk(shot, `${tc.id}-final`);
        if (url) screenshots.push(url);
      }
    } catch (_) {}
  }

  // D4 — re-read the live accessibility snapshot AFTER the agent finished so
  // the post-mortem Critic can verify "all assertions checked" claims against
  // what the page actually shows. Falls back to the last in-loop snapshot.
  let finalSnapshot = lastSnapshotText || '';
  if (mcpSession) {
    try {
      const snapRes = await mcp.callTool(mcpSession, 'browser_snapshot', {});
      const text = snapRes && !snapRes.isError ? mcp.textOfContent(snapRes.content) : '';
      if (text) finalSnapshot = text;
    } catch (_) {}
  }

  screenshotsByTc[tc.id] = screenshots;
  history.push({ testCaseId: tc.id, name: tc.name, status, error, actionTrail, originalSteps: approvedSteps, assertions, finalSnapshot });

  // Phase E4 — visual regression. Fires when (a) we have a final
  // screenshot, AND (b) either this is the case's first pass (we WRITE a
  // baseline) or a baseline exists from a prior run (we COMPARE). Strict
  // opt-out: any failure here is logged-and-skipped, never blocks the
  // result. visualCritic verdict ≠ test verdict; the underlying assertion
  // remains the source of truth, the vision pass is advisory.
  const visual = await analyseVisualRegression({
    tc, status, screenshots, provider, apiKey, model, send,
  });

  await persistResultAndCodegen({ tc, scenario, runId, projectId, status, error, screenshots, actionTrail, lastSnapshotText, framework, provider, apiKey, model, targetUrl, send, visual, mcpSession });

  if (status === 'pass') stats.passed++;
  else if (status === 'fail') stats.failed++;
  else stats.skipped++;

  return { systemic: caseSystemic };
}

/**
 * Phase E4 — decide what to do with the case's final screenshot:
 *   - First pass (status='pass' + no prior baseline): record this run's
 *     final screenshot URL as the baseline. No vision call.
 *   - Subsequent pass + baseline exists: run visualCritic against the
 *     baseline; persist verdict/diffs.
 *   - Fail + baseline exists + no obvious MCP error: still run
 *     visualCritic — the screenshot may show WHY (red error banner,
 *     missing CTA) better than the assertion log does.
 *   - Otherwise (no current screenshot, no baseline + fail, no provider
 *     credentials): no-op.
 *
 * Returns `{ baselineScreenshot, visualVerdict, visualDiffSummary,
 *           visualDiffs (JSON-stringified) }` or `null` when nothing
 * should be persisted. Errors are swallowed — visual checks are advisory
 * and must never block a result from being written.
 */
async function analyseVisualRegression({ tc, status, screenshots, provider, apiKey, model, send }) {
  try {
    const currentUrl = screenshots && screenshots.length ? screenshots[screenshots.length - 1] : null;
    if (!currentUrl) return null;

    const priorWithBaseline = await prisma.runResult.findFirst({
      where: { testCaseId: tc.id, baselineScreenshot: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { baselineScreenshot: true },
    });

    // First-time baseline: only on pass. We never baseline a failing run —
    // that would freeze a broken look in as "canonical".
    if (!priorWithBaseline) {
      if (status === 'pass') {
        return { baselineScreenshot: currentUrl, visualVerdict: null, visualDiffSummary: null, visualDiffs: null };
      }
      return null;
    }

    const baselineUrl = priorWithBaseline.baselineScreenshot;

    // No AI credentials → nothing to compare with. Carry the baseline
    // forward unchanged so it stays referenced and doesn't get reaped.
    if (!provider || !apiKey) {
      return { baselineScreenshot: baselineUrl, visualVerdict: null, visualDiffSummary: null, visualDiffs: null };
    }

    const baseline = readArtifactAsBase64(baselineUrl);
    const current = readArtifactAsBase64(currentUrl);
    if (!baseline || !current) {
      return { baselineScreenshot: baselineUrl, visualVerdict: null, visualDiffSummary: null, visualDiffs: null };
    }

    if (send) send({ type: 'agent.phase.start', phase: 'visual-critic', label: 'Visual Critic', tcId: tc.id });
    const result = await visualCritic.compare({
      apiKey, model, provider,
      baselineBase64: baseline.data,
      baselineMediaType: baseline.mediaType,
      currentBase64: current.data,
      currentMediaType: current.mediaType,
      expectedAssertion: tc.assertions || null,
      onLog: async (level, message) => {
        if (send) send({ type: 'agent.phase.log', phase: 'visual-critic', level, message, tcId: tc.id });
      },
    });
    if (send) send({ type: 'agent.phase.complete', phase: 'visual-critic', tcId: tc.id, verdict: result?.verdict || null });

    if (!result) {
      return { baselineScreenshot: baselineUrl, visualVerdict: null, visualDiffSummary: null, visualDiffs: null };
    }
    return {
      baselineScreenshot: baselineUrl,
      visualVerdict: result.verdict,
      visualDiffSummary: result.summary || null,
      visualDiffs: JSON.stringify(result.diffs || []),
    };
  } catch (err) {
    if (send) send({ type: 'agent.phase.log', phase: 'visual-critic', level: 'warn', message: `Visual analysis skipped: ${err.message}` });
    return null;
  }
}

/**
 * Persist RunResult + TestCase + (on pass) codegen+lint+PR + (on fail) BlockedItem.
 */
async function persistResultAndCodegen({ tc, scenario, runId, projectId, sprintId, status, error, screenshots, actionTrail, lastSnapshotText, framework, provider, apiKey, model, targetUrl, send, visual, mcpSession }) {
  const createdResult = await prisma.runResult.create({
    data: {
      runId,
      testCaseId: tc.id,
      status,
      durationMs: null,
      error: error || null,
      screenshots: encodeArray(screenshots),
      video: null,
      trace: actionTrail.map(stringifyAction).join('\n') || null,
      networkLog: encodeJson([]),
      baselineScreenshot: visual?.baselineScreenshot || null,
      visualVerdict: visual?.visualVerdict || null,
      visualDiffSummary: visual?.visualDiffSummary || null,
      visualDiffs: visual?.visualDiffs || null,
    },
    select: { id: true },
  });
  await prisma.testCase.update({ where: { id: tc.id }, data: { status } });

  // E10.5 — back-fill Download.runResultId for any files captured during
  // this case's window. Safe no-op when mcpSession or projectId is missing.
  if (mcpSession && projectId && createdResult?.id) {
    try {
      const n = await downloadWatcher.attributeRecentDownloads(mcpSession, createdResult.id, projectId);
      if (n > 0) {
        send?.({
          type: 'agent.phase.log', phase: 'conductor', level: 'info',
          message: `   📥 attributed ${n} download${n === 1 ? '' : 's'} to this case`,
          tcId: tc.id,
        });
      }
    } catch (_) { /* download attribution must never break the run */ }
  }

  send({ type: 'result', runId, tcId: tc.id, status, error });
  send({
    type: 'agent.phase.log', phase: 'conductor',
    level: status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'blocked',
    message: `   ${status === 'pass' ? '✓' : status === 'fail' ? '✗' : '⛔'} ${tc.name}`,
    tcId: tc.id,
  });

  // Codegen on pass — uses the same provider as the conductor.
  if (status === 'pass' && provider) {
    try {
      const actionPlan = {
        actions: actionTrail
          .filter((a) => a.tool && a.tool !== 'browser_snapshot' && a.tool !== 'browser_take_screenshot')
          .map((a) => ({ tool: a.tool, args: a.args || {}, narration: `${a.tool}${a.ok ? ' ok' : ''}` })),
        summary: `MCP tool-use loop drove ${actionTrail.length} action(s).`,
      };
      const code = await codegen.generate({
        framework, provider, apiKey, model,
        scenario, testCase: tc, actionPlan, targetUrl,
      });
      if (code) {
        const fileLayout = codegen.layoutFor(framework, scenario, tc);
        const projectRoot = path.join(__dirname, '..', '..', '..', 'playwright');

        if (framework === 'playwright-pom' || framework === 'playwright-flat') {
          try {
            const pomMod = require('../codegen/pom');
            const created = pomMod.ensureProjectShell(projectRoot);
            if (created.length) {
              send({ type: 'agent.phase.log', phase: 'conductor', level: 'codegen', message: `   📂 Created project shell: ${created.join(', ')}`, tcId: tc.id });
            }
          } catch (_) {}
        }

        const filesToWrite = (() => {
          if (framework === 'playwright-pom') {
            try {
              const pomMod = require('../codegen/pom');
              return pomMod.splitFiles(code, fileLayout);
            } catch (_) {
              return { [fileLayout.primaryFile]: code };
            }
          }
          return { [fileLayout.primaryFile]: code };
        })();

        for (const [relPath, content] of Object.entries(filesToWrite)) {
          if (!content) continue;
          const full = path.join(projectRoot, relPath);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, content, 'utf8');
        }

        await prisma.testCase.update({ where: { id: tc.id }, data: { specCode: code.slice(0, 60_000) } });
        const lint = lintGates.lint(filesToWrite[fileLayout.testFile || fileLayout.primaryFile] || code);
        const prCount = await prisma.governancePR.count({ where: { projectId } });
        await prisma.governancePR.create({
          data: {
            projectId, sprintId: sprintId || null, runId, testCaseId: tc.id,
            number: `#${100 + prCount + 1}`,
            filename: fileLayout.primaryFile,
            requirement: (tc.assertions || '').split(',')[0]?.trim() || tc.name,
            specCode: code,
            lintPassed: lint.lintPassed,
            lintFindings: encodeJson(lint.findings),
            status: 'pending',
          },
        });

        const fileSummary = Object.keys(filesToWrite).filter((k) => filesToWrite[k]).join(', ');
        send({ type: 'agent.phase.log', phase: 'conductor', level: 'codegen',
          message: `   📝 Wrote ${fileSummary} · lint ${lint.lintPassed ? '✓' : `✗ ${lint.errorCount} err`}`, tcId: tc.id });
      }
    } catch (err) {
      send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn', message: `   ⚠ codegen failed: ${err.message}`, tcId: tc.id });
    }
  }

  // Blocked item on failure
  if (status !== 'pass' && error) {
    await prisma.blockedItem.create({
      data: {
        projectId,
        sprintId: sprintId || null,
        runId,
        testCaseId: tc.id,
        reason: classifyError(error),
        locator: extractLocator(error),
        message: String(error).slice(0, 1000),
      },
    });
  }
}

// Classify a blocker message into a stable kind. The kind drives both the
// UI (which input fields to show, which "action" hint to surface) and the
// dashboard counters, so we need to recognise the agent-side signals
// (loop detection, retry caps, supervisor giveup, browser crashes) and not
// dump them all into "unknown". Order matters — more specific patterns
// must come first.
function classifyError(msg) {
  const s = String(msg || '').toLowerCase();

  // Agent loop / hint cap / retry exhaustion. These are written by the
  // conductor's own loop-detection code; they have nothing to do with
  // locators — the user cannot fix them by supplying a selector.
  if (s.includes('hint_cap') || s.includes('hint(s) without progress')) return 'agent_loop';
  if (s.includes('consecutive_errors') || s.includes('same error 3x') || s.includes('same error in a row')) return 'agent_repeating';
  if (s.includes('30-turn ceiling') || s.includes('turn ceiling') || s.includes('max turns reached')) return 'agent_loop';
  if (s.includes('identical tool calls') || s.includes('identical_tool')) return 'agent_loop';

  // Browser / page lifecycle. Surfaced when chromium isn't installed, the
  // page crashes, or the agent tries to talk to a closed page.
  if (s.includes('browser is not installed') || s.includes('chromium is not installed')) return 'browser_missing';
  if (s.includes('target closed') || s.includes('browser has been closed') ||
      s.includes('page closed') || s.includes('page crashed') ||
      s.includes('execution context was destroyed') || s.includes('context closed')) return 'browser_crash';

  // External challenges the user is expected to know about.
  if (s.includes('captcha') || s.includes('recaptcha') || s.includes('hcaptcha') || s.includes('cloudflare challenge')) return 'captcha';
  if (s.includes('consent banner') || s.includes('cookie banner') || s.includes('cookie consent') ||
      s.includes('modal') || s.includes('popup') || s.includes('dialog blocked')) return 'popup';

  // Auth / permission.
  if (s.includes('401') || s.includes('unauthorized') || s.includes('unauthenticated')) return 'auth';
  if (s.includes('403') || s.includes('forbidden')) return 'permission';

  // Network / connectivity.
  if (s.includes('network') || s.includes('econnrefused') || s.includes('enotfound') ||
      s.includes('dns') || s.includes('net::err')) return 'network';

  // Locator-shaped. Includes Playwright's "Unknown engine ref" and the
  // generic "not found / locator / selector" phrasings.
  if (s.includes('unknown engine "ref"') || (s.includes('ref=') && s.includes('not found'))) return 'locator_missing';
  if (s.includes('locator') || s.includes('selector') || s.includes('no element matches')) return 'locator_missing';

  // Timing.
  if (s.includes('timeout') || s.includes('timed out')) return 'timeout';

  // Assertion.
  if (s.includes('expect(') || s.includes('expected ') || s.includes('assertion')) return 'assertion';

  return 'unknown';
}
function extractLocator(msg) {
  if (!msg) return null;
  const m = String(msg).match(/ref=([\w-]+)|locator\(['"]([^'"]+)['"]\)|getBy(?:Role|TestId|Label|Text)\(['"]([^'"]+)['"]\)/i);
  return m ? (m[1] || m[2] || m[3]) : null;
}

module.exports = { run, SYSTEM_PROMPT_LOOP };
