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
const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt } = require('../../lib/promptCompose');
const codegen = require('../codegen');

const MAX_TURNS = Number(process.env.QAAI_MCP_MAX_TURNS) || 30;
const SCREENSHOT_EVERY_N_TURNS = 2;
const INLINE_CRITIC_EVERY = Number(process.env.QAAI_INLINE_CRITIC_EVERY) || 5;
const MAX_IDENTICAL_TOOL_CALLS = Number(process.env.QAAI_MAX_IDENTICAL_TOOL_CALLS) || 3;
const MAX_CONSECUTIVE_ERRORS = Number(process.env.QAAI_MAX_CONSECUTIVE_ERRORS) || 3;

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

End your turn (no more tool calls) when:
  - all assertions are verified ✓ — say what you verified in plain English
  - OR you cannot make progress — say what blocked you in plain English

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
 */
function stringifyAction(a) {
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
  const { userId, projectId, plan, scenarios, apiKey, model, framework, targetUrl, send,
          inlineCritic, attempt, guidanceByTcId, cancelToken, onRateLimit, extraGuidance,
          provider: providerName } = opts;

  const scenarioMap = new Map(scenarios.map((s) => [s.id, s]));

  const runRow = await prisma.run.create({
    data: {
      userId,
      projectId,
      sprintName: `Agent run · ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
      status: 'running',
      config: encodeJson({ targetUrl, framework, planWaves: plan.waves.length }),
    },
  });

  const totalCases = scenarios.reduce((a, s) => a + (scenarioMap.get(s.id)?.cases.length || 0), 0);
  send({ type: 'run.started', runId: runRow.id, testCount: totalCases });
  send({ type: 'agent.phase.log', phase: 'conductor', level: 'info', message: `Starting run ${runRow.id.slice(0, 8)}… framework=${framework}` });

  // Try to start the MCP session. On failure, degrade to dry-run so the
  // pipeline still completes and the user sees narration.
  let mcpSession = null;
  let dryRun = false;
  const broadcast = (msg) => send(msg);
  try {
    mcpSession = await mcp.startMcpSession({
      userId,
      targetUrl,
      broadcast,
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
            tc, scenario, mcpSession, dryRun, provider, apiKey, model, targetUrl, runId: runRow.id, projectId, send, stats, screenshotsByTc, framework, history,
            inlineCritic, attempt, guidancePrefix: guidanceByTcId ? guidanceByTcId[tc.id] : undefined,
            cancelToken, onRateLimit, extraGuidance,
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

async function runOneCase({
  tc, scenario, mcpSession, dryRun, provider, apiKey, model, targetUrl, runId, projectId, send, stats, screenshotsByTc, framework, history,
  inlineCritic, attempt, guidancePrefix, cancelToken, onRateLimit, extraGuidance,
}) {
  const attemptLabel = attempt && attempt > 1 ? ` (attempt ${attempt})` : '';
  send({ type: 'agent.phase.log', phase: 'conductor', level: 'case.start', message: `   • ${tc.name}${attemptLabel}`, tcId: tc.id });
  await prisma.testCase.update({ where: { id: tc.id }, data: { status: 'running' } });

  // Loop-detection bookkeeping (cleared per case)
  const toolCallCounts = new Map();   // `${tool}|${argsHash}` -> count
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
    history.push({ testCaseId: tc.id, name: tc.name, status, error, actionTrail, originalSteps: approvedSteps, assertions });
    await persistResultAndCodegen({ tc, scenario, runId, projectId, status, error, screenshots, actionTrail, lastSnapshotText, framework, provider, apiKey, model, targetUrl, send });
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
  let baseSystem = guidancePrefix
    ? `${SYSTEM_PROMPT_LOOP}\n\n## Supervisor guidance (case-specific)\n${guidancePrefix}`
    : SYSTEM_PROMPT_LOOP;
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
      let result;
      try {
        result = await mcp.callTool(mcpSession, tu.name, tu.input || {});
      } catch (callErr) {
        result = { content: [{ type: 'text', text: `MCP call failed: ${callErr.message}` }], isError: true };
      }
      const trailEntry = actionTrail[actionTrail.length - 1];
      const errText = result.isError ? mcp.textOfContent(result.content) : null;
      if (trailEntry && trailEntry.tool === tu.name) {
        trailEntry.ok = !result.isError;
        if (errText) trailEntry.error = errText;
        const snippet = mcp.textOfContent(result.content);
        if (snippet) {
          lastSnapshotText = snippet;
          trailEntry.pageSnippet = snippet.slice(0, 800);
        }
      }

      // ── Loop-detection: same {tool, args} called too many times ─────
      const argsHash = JSON.stringify(tu.input || {}).slice(0, 500);
      const callKey = `${tu.name}|${argsHash}`;
      const newCount = (toolCallCounts.get(callKey) || 0) + 1;
      toolCallCounts.set(callKey, newCount);
      if (newCount > MAX_IDENTICAL_TOOL_CALLS) {
        loopAbortReason = `loop_detected: agent called ${tu.name} with the same arguments ${newCount} times`;
        send({ type: 'agent.phase.log', phase: 'conductor', level: 'error',
               message: `   ⛔ ${loopAbortReason} — aborting case`, tcId: tc.id });
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

  screenshotsByTc[tc.id] = screenshots;
  history.push({ testCaseId: tc.id, name: tc.name, status, error, actionTrail, originalSteps: approvedSteps, assertions });

  await persistResultAndCodegen({ tc, scenario, runId, projectId, status, error, screenshots, actionTrail, lastSnapshotText, framework, provider, apiKey, model, targetUrl, send });

  if (status === 'pass') stats.passed++;
  else if (status === 'fail') stats.failed++;
  else stats.skipped++;

  return { systemic: caseSystemic };
}

/**
 * Persist RunResult + TestCase + (on pass) codegen+lint+PR + (on fail) BlockedItem.
 */
async function persistResultAndCodegen({ tc, scenario, runId, projectId, status, error, screenshots, actionTrail, lastSnapshotText, framework, provider, apiKey, model, targetUrl, send }) {
  await prisma.runResult.create({
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
    },
  });
  await prisma.testCase.update({ where: { id: tc.id }, data: { status } });

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
            projectId, runId, testCaseId: tc.id,
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
