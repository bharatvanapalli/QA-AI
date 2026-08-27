'use strict';

/**
 * Agent 5 — Critic.
 *
 * Reads the structured outcome of a Conductor run (per-case action trails
 * from the Playwright MCP tool-use loop) and rewrites failing/blocked test
 * cases using what the MCP transcripts ACTUALLY showed about the page.
 *
 * This closes the loop the user asked for:
 *   "playwright mcp ... should give proper response back to another agent
 *    that writes test cases and corrects the mcp."
 *
 * For each FAILED or BLOCKED case the Critic emits:
 *   { testCaseId, name, steps, assertions, reasoning }
 * — the route persists these onto TestCase rows (status reset to 'pending'
 *   so the user re-approves before re-running).
 *
 * For each PASSED case the Critic may emit nothing or a confidence note.
 * At suite level it returns a short `notes` string describing patterns
 * observed across the run.
 */

const { getProvider } = require('../../lib/llmProvider');
const { composeSystemPrompt, composeSystemPromptCached } = require('../../lib/promptCompose');

// P1-3 REVERTED (2026-05-29 evening) — inline Critic stays at flagship.
//
// The earlier audit-sweep change routed runInline through tier='mid' (Haiku
// 4.5) on the argument that monitoring is well within Haiku's capability.
// Per the user's later "no compromise on verdict integrity" directive, the
// inline Critic's job — detect agent confusion, abort hallucinated pass
// claims, suggest pivots — directly affects whether a live-passable case
// reaches its passable state before the turn ceiling. A weaker monitor
// that misses an intervention can turn "live would pass" into "agent gave
// up first." Keeping the flagship model removes that variable. Cost win
// reverted; correctness wins.
const { parseJsonResponse } = require('../../lib/parseJsonResponse');
const { normaliseStepShape } = require('../../lib/stepShape');

const SYSTEM_PROMPT = `You are a senior SDET reviewing a Playwright MCP test run.

You will receive a JSON object describing what happened for each test case:
  - testCaseId, name, status ('pass' | 'fail' | 'blocked')
  - originalSteps  (what the user approved before the run)
  - assertions     (the original assertions)
  - actionTrail    (the actual sequence of MCP tool calls the agent made,
                    in order — each entry includes the tool name, arguments,
                    whether it succeeded, the error message if it failed,
                    and a compact snippet of the page snapshot that was
                    visible when that action was attempted)
  - error          (the final error message if the test did not pass)
  - finalSnapshot  (the FULL accessibility snapshot of the page taken AFTER
                    the agent claimed to be done — your ground truth for
                    verifying "all assertions passed" claims. If the Conductor
                    said "pass" but the finalSnapshot contains an error banner
                    or doesn't show the expected element/text, the pass is
                    hallucinated. Emit a rewrite that flips the case to fail
                    with reasoning quoting the snapshot.)

Your job is to REWRITE the failing/blocked cases so they match what the page
actually showed. Use ONLY element names, labels, placeholders, and refs that
appeared in the actionTrail's snapshots. NEVER invent labels the page did
not have.

For PASSED cases you may emit a rewrite IF the original steps were misleading
(e.g. the page had different copy than the steps described, but the agent
adapted successfully). Otherwise leave them alone — empty omission is fine.

Output a SINGLE JSON object — no markdown, no preamble:
{
  "rewrites": [
    {
      "testCaseId": "<echo the id verbatim>",
      "name": "<short sentence; keep close to the original if still accurate>",
      "steps": [
        {"action":"<verb>","element":"<human description of the element, as it appears on the page>","locator_hint":"<optional CSS / role-name hint; omit when role+name is enough>","value":"<typed value or empty>","expected":"<expected outcome or empty>"}
      ],
      "assertions": "<comma-separated specific assertions, matched to real page text>",
      "reasoning": "<1-2 sentences: why the original failed and what changed>"
    }
  ],
  "notes": "<1-3 sentences of suite-level pattern observations>"
}

Rules:
- The "steps" array MUST have entries shaped { action, element, locator_hint?, value, expected }.
  Use "element" for the human description (passed directly to Playwright MCP's element parameter).
  Use "locator_hint" ONLY when role+name alone would be ambiguous. DO NOT emit a "target" field —
  the platform reads it from older cases for backwards-compat, but new output must use the new fields.
- Surface accessibility-name OR placeholder OR testid that was visible in the trail; never copy a guess.
- If the failure was network/server (not locator), say so in reasoning and leave steps largely intact.
- If a test passed but the trail shows the agent had to skip an approved step (because the page didn't render it), update the steps to match what really happened.
- If you have NO confident rewrite for a failure, omit it rather than guess.`;

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {object} opts.runOutcome
 * @param {string} opts.runOutcome.runId
 * @param {Array}  opts.runOutcome.history   per-case outcomes (see conductor.js)
 * @param {object} opts.runOutcome.summary   { passed, failed, skipped, total }
 * @param {function} [opts.onLog]
 * @returns {Promise<{ rewrites: Array, notes: string }>}
 */
async function run({ apiKey, model, runOutcome, onLog = async () => {}, onRateLimit, extraGuidance, provider: providerName, signal } = {}) {
  if (!apiKey) {
    const err = new Error('AI provider API key missing.');
    err.code = 'NO_API_KEY';
    err.status = 400;
    throw err;
  }
  const history = Array.isArray(runOutcome?.history) ? runOutcome.history : [];
  if (history.length === 0) {
    return { rewrites: [], notes: 'No cases ran — nothing to critique.' };
  }
  const provider = getProvider(providerName);

  // Compact the history so each case fits comfortably under the model's
  // input budget. We keep the full step list but truncate per-action page
  // snippets to ~800 chars apiece.
  const compactHistory = history.map((h) => ({
    testCaseId: h.testCaseId,
    name: h.name,
    status: h.status,
    error: (h.error || '').slice(0, 800),
    originalSteps: h.originalSteps || [],
    assertions: h.assertions || '',
    actionTrail: (h.actionTrail || []).slice(0, 40).map((a) => ({
      turn: a.turn,
      tool: a.tool,
      args: a.args,
      ok: !!a.ok,
      error: a.error ? String(a.error).slice(0, 400) : undefined,
      pageSnippet: a.pageSnippet ? String(a.pageSnippet).slice(0, 800) : undefined,
    })),
    // D4 — final accessibility snapshot captured AFTER the agent finished.
    // Lets the Critic verify "all assertions passed" against ground truth and
    // catch hallucinated successes (e.g. agent emitted RESULT: pass but the
    // page still shows "Incorrect email address or password").
    finalSnapshot: h.finalSnapshot ? String(h.finalSnapshot).slice(0, 3000) : undefined,
  }));

  const failed = compactHistory.filter((h) => h.status !== 'pass').length;
  await onLog('info', `Reviewing ${compactHistory.length} case(s) (${failed} not passing)…`);

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model,
      maxTokens: 4000,
      system: composeSystemPromptCached(SYSTEM_PROMPT, extraGuidance),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '## Run summary' },
            { type: 'text', text: JSON.stringify(runOutcome.summary || {}, null, 2) },
            { type: 'text', text: '\n## Per-case outcomes' },
            { type: 'text', text: JSON.stringify(compactHistory, null, 2) },
          ],
        },
      ],
      onRateLimit,
      responseFormat: 'json',
      signal,
    });
  } catch (err) {
    await onLog('error', `Critic call failed: ${err.message}`);
    throw err;
  }

  const text = (resp.content?.[0]?.text || '').trim();
  const parsed = parseJsonResponse(text, { type: 'object' });
  if (!parsed) {
    await onLog('warn', 'Critic returned non-JSON; treating as no rewrites.');
    return { rewrites: [], notes: text.slice(0, 500) };
  }

  const rewrites = Array.isArray(parsed.rewrites) ? parsed.rewrites.map(normaliseRewrite).filter(Boolean) : [];
  const notes = typeof parsed.notes === 'string' ? parsed.notes.slice(0, 1000) : '';
  await onLog('info', `Produced ${rewrites.length} rewrite(s).`);
  return { rewrites, notes };
}

function normaliseRewrite(rw) {
  if (!rw || typeof rw !== 'object') return null;
  const id = String(rw.testCaseId || '').trim();
  if (!id) return null;
  // Phase F.3 — delegate to the canonical normalizer so Critic rewrites land
  // with element + locator_hint regardless of whether the LLM emitted the new
  // shape or the legacy `target` shape.
  const steps = Array.isArray(rw.steps)
    ? rw.steps
        .filter((s) => s && typeof s === 'object')
        .map((s, i) => normaliseStepShape(s, i + 1))
        .filter(Boolean)
    : [];
  return {
    testCaseId: id,
    name: rw.name ? String(rw.name).slice(0, 300) : '',
    steps,
    assertions: rw.assertions ? String(rw.assertions).slice(0, 1000) : '',
    reasoning: rw.reasoning ? String(rw.reasoning).slice(0, 600) : '',
  };
}

// ──────────────────────────────────────────────────────────────────────
// runInline — live monitor invoked between Conductor turns
// ──────────────────────────────────────────────────────────────────────

const INLINE_SYSTEM_PROMPT = `You monitor a Playwright MCP test run while it is happening.

You receive:
  - "caseContext": the test case (name, assertions, original approved steps)
  - "trail": the actions taken so far (tool, args, ok/error)
  - "lastSnapshot": the most recent accessibility snapshot of the page
  - "liveDomContext" (when present): the REAL DOM — tag/type/role/class/value/
    aria-expanded for the page's interactive elements. This is RICHER than the
    accessibility snapshot: custom dropdowns, autocomplete fields, and icon
    buttons that the snapshot shows as nameless "generic [ref=eN]" appear here
    with their actual tag/class/value. USE IT to name the right element and the
    right interaction when the snapshot alone is ambiguous.

Custom-widget patterns to recognise from liveDomContext:
  - A custom dropdown (div/span with class containing select/dropdown and an
    aria-expanded, NOT a real <select>) needs a CLICK to open then a CLICK on
    the option — never browser_select_option.
  - An autocomplete field that already holds a doubled/garbled value (e.g.
    "JamesJames") means an earlier type was not cleared. Hint: clear the field
    (select-all + delete or triple-click) then type the value ONCE, then click
    the matching suggestion option.

Your job is to catch problems EARLY. Patterns to flag:
  - **Wrong tool for the element type** (PRIORITY — common agent mistake):
      · browser_type / browser_fill_form used on a submit button, checkbox,
        radio, file input, or any non-text element. Fix: switch to browser_click.
      · browser_click on a text field when the intent was to type. Fix: browser_type.
      · browser_select_option on a custom (non-<select>) dropdown that needs
        a click to open then a click on the option. Fix: two browser_clicks.
    These show up as errors like "Input of type 'submit' cannot be filled"
    or "<element> is not a select" — your hint should name the right tool.
  - The agent is in a loop (clicking the same wrong element repeatedly)
  - The agent missed a step from the approved plan
  - The page is asking for something the test case didn't anticipate
    (consent banner, captcha, password mismatch, unexpected modal, 2FA prompt)
  - The agent invented an element name/ref that isn't in the snapshot
  - Assertions are about to be missed because the agent is heading the wrong way
  - The agent typed credentials but never submitted (no click on Login/Submit)
    — frequent stall pattern. Hint: "Click the <Login/Submit> button at ref=eN
    to submit the form."

If everything is on track, respond with exactly:
  {"ok": true}

If you need to intervene with general guidance, respond with:
  {"hint": "<one short sentence using REAL element names/refs from the snapshot>", "severity": "info" | "warn" | "error"}

The hint is injected verbatim as a user message into the agent's next turn.
Keep it SHORT (under 200 chars), ACTIONABLE, and grounded in the snapshot.
Name the specific tool the agent should use next, and the specific ref / element
label from the snapshot. Never say "try something else" — say WHAT and WHERE.

** Phase E2 — abort-pass-claim verdict **
If the trail shows the agent is about to (or just did) emit "RESULT: pass"
but the snapshot CONTRADICTS the claim (visible error banner, wrong page,
required field still empty, no assertion_check call was made to verify it),
respond with:
  {"verdict": "abort_pass_claim", "reasoning": "<one sentence quoting what the page actually shows>"}

This is the strongest verdict — Conductor will inject a synthetic user
message forcing the agent to re-verify before ending its turn. Use it only
when you have HARD evidence in the snapshot that the assertion failed.

Output ONLY JSON. No markdown fences, no preamble.`;

/**
 * Fast, cheap monitor invoked between Conductor turns. Returns either
 * { ok: true } (no intervention) or { hint, severity }.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {object} opts.caseContext     { name, assertions, originalSteps }
 * @param {Array}  opts.trail           actionTrail-so-far
 * @param {string} opts.lastSnapshot
 * @param {function} [opts.onLog]
 * @returns {Promise<{ok:true} | {hint:string, severity:'info'|'warn'|'error'}>}
 */
async function runInline({ apiKey, model, caseContext, trail, lastSnapshot, domContext, onLog = async () => {}, onRateLimit, extraGuidance, provider: providerName } = {}) {
  if (!apiKey) return { ok: true };  // silent skip — never throw from inline path
  const provider = getProvider(providerName);

  const compactTrail = (trail || []).slice(-20).map((a) => ({
    turn: a.turn,
    tool: a.tool,
    args: a.args,
    ok: !!a.ok,
    error: a.error ? String(a.error).slice(0, 200) : undefined,
  }));

  // P1-7 — caseContext block (case name, declared assertions, original
  // steps) is identical across every turn within one case. Hoist it into
  // the cached system array with its own cache_control breakpoint so
  // within-case turn calls share the cache; only the per-turn trail and
  // snapshot live in the uncached user message. The SYSTEM_PROMPT block
  // ALSO gets cache_control so cross-case hits keep saving on the static
  // monitor instructions.
  //
  // Generic rule: per-case static context is per-case cached. Caller-side
  // per-turn dynamic content (trail, snapshot) lives in the message body.
  const caseContextBlock = `## caseContext\n${JSON.stringify({
    name: caseContext?.name || '',
    assertions: caseContext?.assertions || '',
    originalSteps: caseContext?.originalSteps || [],
  }, null, 2)}`;
  const turnPayload = [
    `## trail (last ${compactTrail.length} action(s))\n${JSON.stringify(compactTrail, null, 2)}`,
    `\n## lastSnapshot (truncated)\n${String(lastSnapshot || '').slice(0, 3000)}`,
    // K1 — deeper-than-snapshot DOM context (tag/type/role/class/value/expanded
    // for the page's interactive elements, incl. custom dropdowns & autocomplete
    // that the ARIA snapshot renders as nameless "generic"). When present, the
    // Critic can name the right element/recipe the text snapshot alone can't.
    domContext ? `\n## liveDomContext (real DOM — richer than the accessibility snapshot)\n${String(domContext).slice(0, 3000)}` : '',
  ].filter(Boolean).join('\n');

  // Build the system array with TWO cache breakpoints:
  //   [INLINE_SYSTEM_PROMPT (cached)] — cross-case stable
  //   [caseContext (cached)]          — within-case stable across turns
  //   [operator guidance (uncached)]  — project/case overrides
  // Anthropic caches everything up to and including the LAST block tagged
  // cache_control; with two tags we get two cache layers.
  const systemBlocks = [
    { type: 'text', text: INLINE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: caseContextBlock, cache_control: { type: 'ephemeral' } },
  ];
  const trimmedGuidance = (typeof extraGuidance === 'string' ? extraGuidance.trim() : '');
  if (trimmedGuidance) {
    systemBlocks.push({
      type: 'text',
      text: `## OPERATOR GUIDANCE (apply when in conflict with the rules above)\n${trimmedGuidance}`,
    });
  }

  // Use the requested model (flagship by default — see header comment).
  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model,
      maxTokens: 250,
      system: systemBlocks,
      messages: [{ role: 'user', content: turnPayload }],
      onRateLimit,
      responseFormat: 'json',
    });
  } catch (err) {
    await onLog('warn', `inline critic call failed: ${err.message}`);
    return { ok: true };  // fail-open — don't block the Conductor
  }

  const text = (resp.content?.[0]?.text || '').trim();
  const parsed = parseJsonResponse(text, { type: 'object' });
  if (parsed) {
    if (parsed.ok === true) return { ok: true };
    // Phase E2 — strongest verdict: agent's pass claim contradicted by the
    // snapshot. Conductor will block end_turn and force re-verification.
    if (parsed.verdict === 'abort_pass_claim' && typeof parsed.reasoning === 'string' && parsed.reasoning.trim()) {
      return {
        verdict: 'abort_pass_claim',
        reasoning: parsed.reasoning.slice(0, 400).trim(),
      };
    }
    if (typeof parsed.hint === 'string' && parsed.hint.trim()) {
      const sev = ['info', 'warn', 'error'].includes(parsed.severity) ? parsed.severity : 'info';
      return { hint: parsed.hint.slice(0, 400).trim(), severity: sev };
    }
  }
  // Parse failure → treat as no-intervention. The inline critic must
  // never block the Conductor.
  return { ok: true };
}

module.exports = { run, runInline, SYSTEM_PROMPT, INLINE_SYSTEM_PROMPT };
