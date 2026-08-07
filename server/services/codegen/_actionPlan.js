'use strict';

/**
 * Shared action-plan shaping for generated specs.
 *
 * Phase A — Action Journal + Disposition Filter
 *   Every MCP action is classified before reaching codegen. Only setup,
 *   committed, and assertion_support actions are exported. Cancel-loops,
 *   retry-fills, and dead navigation are dropped and kept as audit trail.
 *
 * Phase B — Action-Time Evidence Threading
 *   toCodegenAction forwards actionLocator/domFacts captured at click-time so
 *   buildManifest can use live evidence before falling back to KB lookup.
 */

const SCRIPTABLE_TOOLS = new Set([
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_click',
  'browser_mouse_click',
  'browser_click_xy',
  'browser_double_click',
  'browser_triple_click',
  'browser_type',
  'browser_fill',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_scroll',
  'browser_file_upload',
  'browser_handle_dialog',
  'browser_resize',
  'browser_close',
]);

const PLAYWRIGHT_HINTS = {
  browser_mouse_click: 'recover coordinates to a locator before export; never emit page.mouse.click in certified output',
  browser_click_xy: 'recover coordinates to a locator before export; never emit page.mouse.click in certified output',
  // LEGACY-TRACE TRANSLATOR: conductor emits no browser_triple_click; this hint only
  // maps a historical recorded triple-click to valid Playwright (clickCount:3).
  browser_triple_click: 'locator.click({ clickCount: 3 })',
  browser_double_click: 'locator.dblclick()',
  browser_scroll: 'locator.scrollIntoViewIfNeeded() or page.mouse.wheel(deltaX, deltaY)',
};

// ── Disposition helpers ───────────────────────────────────────────────────────

// Matches label text for authentication form fields
const CREDENTIAL_FIELD_RE = /(?:username|password|email|user[\s_]?id|log[\s_]?in\s+(?:name|id)|email[\s_]?address|pass[\s_]?word)/i;

// Matches button/link labels that submit login forms
const LOGIN_BUTTON_RE = /(?:^log[\s_]?in$|^sign[\s_]?in$|^submit$|^sign[\s_]?on$|^login$|log[\s_]?in\s+button|sign[\s_]?in\s+button)/i;

// Matches cancel/dismiss/close/back actions that undo an exploratory click
const CANCEL_DISMISS_RE = /(?:cancel|close\s*(?:button|modal|dialog|popup)?|dismiss|go[\s_]?back|discard|abort|no,?\s*(?:cancel|thanks))/i;

// Detects negative-path test cases (bad-credential, empty-field, rejection tests).
// Server-side detection is deterministic and more reliable than asking the LLM to
// infer from the name. The result is threaded into the action plan so the codegen
// prompt just needs to check actionPlan.testIntent === 'negative_path'.
const NEGATIVE_PATH_RE = /\b(?:invalid|wrong|incorrect|bad|empty|missing|null|no[\s_]?password|brute[\s_]?force|lockout|locked[\s_]?out|rejected?|denial|negative|failure[\s_]case)\b/i;

function primaryDomFacts(domFacts) {
  if (!domFacts || typeof domFacts !== 'object') return null;
  const target = domFacts.target && typeof domFacts.target === 'object' ? domFacts.target : null;
  const facts = target || domFacts;
  if (facts.role || facts.selector || facts.accessibleName || facts.text || facts.placeholder) return facts;
  return null;
}

function hasActionLocator(actionLocator) {
  if (!actionLocator || typeof actionLocator !== 'object') return false;
  if (actionLocator.expression || actionLocator.frameworkExpressions) return true;
  return actionLocator.kind === 'multi' && Array.isArray(actionLocator.fields) &&
    actionLocator.fields.some((field) => field && field.actionLocator);
}

/**
 * Return all field label strings for an action.
 * Handles browser_fill_form (fields array) and scalar-label tools.
 * Falls back to domFacts.accessibleName for ref-only MCP actions
 * (browser_fill { ref: "e144", value: "..." }) which carry no label in args.
 */
function getFieldLabels(action) {
  const args = action.args || {};
  if (action.tool === 'browser_fill_form') {
    const fields = args.fields;
    if (Array.isArray(fields)) {
      return fields.map((f) => String(f.label || f.name || f.placeholder || ''));
    }
    return [];
  }
  const label = String(args.label || args.element || args.name || args.placeholder || '');
  if (label) return [label];
  // Ref-based actions carry no label in args — fall back to the accessible name
  // captured at interaction-time so dead-fill detection and credential matching work.
  const facts = primaryDomFacts(action.domFacts);
  const domName = facts && (facts.accessibleName || facts.placeholder || facts.text);
  return domName ? [String(domName)] : [];
}

function getButtonLabel(action) {
  const args = action.args || {};
  const label = String(args.element || args.label || args.text || args.value || '');
  if (label) return label;
  // Fallback for ref-only click actions.
  const facts = primaryDomFacts(action.domFacts);
  return String((facts && (facts.accessibleName || facts.text || facts.placeholder)) || '');
}

/**
 * Classify the disposition of every action in the raw scriptable trail.
 *
 * Dispositions:
 *   setup            – login/auth/precondition sequence at the start of the run
 *   committed        – real business action that belongs in the exported spec
 *   assertion_support – hover/scroll needed to enable an assertion (no primary interaction)
 *   exploratory      – wrong click / probe / accidental modal open
 *   recovery         – cancel/close/dismiss that directly undoes an exploratory click
 *   dead             – fill overwritten by a later fill on the same field
 *
 * Only setup + committed + assertion_support reach codegen.
 * exploratory + recovery + dead are kept in droppedActions as audit trail.
 *
 * @param {Array} rawActions  — already isScriptableAction-filtered actions from the trail
 * @returns {string[]}         — disposition for each action at the same index
 */
function classifyDisposition(rawActions) {
  const n = rawActions.length;
  const dispositions = new Array(n).fill('committed');

  // ── Pass 1: Setup (login/auth sequence) ──────────────────────────────────
  // The setup sequence is: [optional navigate to login URL] → credential fills
  // → login button click. Ends immediately after the first login button click.
  let seenCredentialFill = false;
  let setupEnded = false;

  for (let i = 0; i < n && !setupEnded; i++) {
    const a = rawActions[i];

    // Initial navigate before any credential fill: opening the app / login page
    if (a.tool === 'browser_navigate' && !seenCredentialFill) {
      dispositions[i] = 'setup';
      continue;
    }

    // Credential field fill (browser_fill, browser_type, browser_fill_form)
    const isCredFill = (
      (a.tool === 'browser_fill' || a.tool === 'browser_type' ||
       a.tool === 'browser_triple_click' || a.tool === 'browser_fill_form') &&
      getFieldLabels(a).some((l) => CREDENTIAL_FIELD_RE.test(l))
    );
    if (isCredFill) {
      dispositions[i] = 'setup';
      seenCredentialFill = true;
      continue;
    }

    // Login button click — must follow at least one credential fill.
    // Three detection paths cover the ways an agent submits a login form:
    //   1. button label matches LOGIN_BUTTON_RE (ideal: args.element = "Login")
    //   2. action narration contains a login-submit keyword (covers the case
    //      where MCP records only a ref with no human-readable element label)
    //   3. browser_press_key with Enter (form submit via keyboard)
    // All three force disposition = 'setup' so Pass 2's cancel-loop detector
    // can NEVER mark a login submit as exploratory regardless of what follows.
    const buttonLabel = getButtonLabel(a);
    const actionNarration = String(a.narration || '').toLowerCase();
    const isLoginButton =
      LOGIN_BUTTON_RE.test(buttonLabel) ||
      /\b(?:log[\s_]?in|sign[\s_]?in|submit(?:\s+form)?|log[\s_]?on)\b/.test(actionNarration) ||
      (a.tool === 'browser_press_key' && /^enter$/i.test(String((a.args || {}).key || '')));
    if (
      seenCredentialFill &&
      (a.tool === 'browser_click' || a.tool === 'browser_double_click' || a.tool === 'browser_press_key') &&
      isLoginButton
    ) {
      dispositions[i] = 'setup';
      setupEnded = true; // login submitted: setup is done
      continue;
    }

    // Anything else before any credential fill was seen: no auth step in this trail
    if (!seenCredentialFill) {
      setupEnded = true;
    }
  }

  // ── Pass 2: Cancel/exploratory loops ─────────────────────────────────────
  // A committed click followed within CANCEL_WINDOW actions by a cancel/dismiss/back
  // → mark the click as exploratory, the cancel as recovery, intermediates as exploratory.
  // Window expanded from 3→5: agents sometimes fill a field in the wrong modal before
  // closing it, placing the Cancel 4-5 actions after the wrong click.
  const CANCEL_WINDOW = 5;
  for (let i = 0; i < n; i++) {
    if (dispositions[i] !== 'committed') continue;
    const a = rawActions[i];
    if (a.tool !== 'browser_click' && a.tool !== 'browser_double_click') continue;

    for (let j = i + 1; j < Math.min(n, i + 1 + CANCEL_WINDOW); j++) {
      if (dispositions[j] !== 'committed') continue;
      const b = rawActions[j];
      const isCancel = (
        b.tool === 'browser_navigate_back' ||
        (
          (b.tool === 'browser_click' || b.tool === 'browser_double_click') &&
          CANCEL_DISMISS_RE.test(getButtonLabel(b))
        )
      );
      if (isCancel) {
        dispositions[i] = 'exploratory';
        dispositions[j] = 'recovery';
        // Intermediate committed actions between the click and the cancel
        for (let k = i + 1; k < j; k++) {
          if (dispositions[k] === 'committed') dispositions[k] = 'exploratory';
        }
        break;
      }
    }
  }

  // ── Pass 2b: Dead navigates ───────────────────────────────────────────────
  // When the agent navigates to a wrong URL and then immediately navigates to a
  // different URL (without browser_navigate_back), the first navigate is a dead
  // probe. Detection: two consecutive committed browser_navigate calls where the
  // URLs are different. The first is marked dead; the second stays committed.
  // Guard: do not mark setup navigates dead (those are classified before this pass).
  for (let i = 0; i < n - 1; i++) {
    if (dispositions[i] !== 'committed') continue;
    const a = rawActions[i];
    if (a.tool !== 'browser_navigate') continue;
    // Look forward up to CANCEL_WINDOW actions for the next committed navigate
    for (let j = i + 1; j < Math.min(n, i + 1 + CANCEL_WINDOW); j++) {
      if (dispositions[j] !== 'committed') continue;
      const b = rawActions[j];
      if (b.tool !== 'browser_navigate') break; // non-navigate committed action intervenes — stop
      const urlA = String((a.args || {}).url || '');
      const urlB = String((b.args || {}).url || '');
      if (urlA && urlB && urlA !== urlB) {
        dispositions[i] = 'dead';
      }
      break;
    }
  }

  // ── Pass 2c: Same-step wrong-click detection ─────────────────────────────
  // When the agent retries a step without using cancel/back (e.g. clicked the
  // wrong row's Edit button, then the page changes, then it returns and clicks
  // the correct row), Pass 2 misses it because there was no cancel signal.
  // Signal: two committed clicks with the SAME stepIndex on DIFFERENT elements
  // where the earlier click's pageUrlAfter ≠ the later click's pageUrl (the
  // agent crossed a page boundary between attempts). Without a URL crossing,
  // we cannot tell a wrong-click from a legitimate expand-then-select sequence,
  // so we leave same-page multi-clicks alone.
  // Guard: only applies when stepIndex is a positive integer (step tracking was
  // active — stepIndex=0 means before first step recognition, too ambiguous).
  {
    // Group committed clicks by stepIndex
    const clicksByStep = new Map();
    for (let i = 0; i < n; i++) {
      if (dispositions[i] !== 'committed') continue;
      const a = rawActions[i];
      if (a.tool !== 'browser_click' && a.tool !== 'browser_double_click') continue;
      const si = typeof a.stepIndex === 'number' && a.stepIndex > 0 ? a.stepIndex : null;
      if (si === null) continue;
      const entries = clicksByStep.get(si) || [];
      entries.push(i);
      clicksByStep.set(si, entries);
    }
    for (const [, idxs] of clicksByStep) {
      if (idxs.length < 2) continue;
      // For each pair (earlier, later), check URL crossing
      for (let p = 0; p < idxs.length - 1; p++) {
        const earlyIdx = idxs[p];
        const laterIdx = idxs[p + 1];
        const early = rawActions[earlyIdx];
        const later = rawActions[laterIdx];
        const earlyUrlAfter = String(early.pageUrlAfter || '');
        const laterUrlBefore = String(later.pageUrl || '');
        // Both URLs must be non-empty and different for URL-crossing detection.
        // If they match or are missing, the agent stayed on the same page —
        // that is an ambiguous legitimate two-click pattern; leave it alone.
        if (!earlyUrlAfter || !laterUrlBefore) continue;
        if (earlyUrlAfter === laterUrlBefore) continue;
        // URLs differ → the agent crossed a page boundary between the two clicks
        // for the same step. Mark the earlier click (and everything between it and
        // the later click that is still committed) as exploratory.
        dispositions[earlyIdx] = 'exploratory';
        for (let k = earlyIdx + 1; k < laterIdx; k++) {
          if (dispositions[k] === 'committed') dispositions[k] = 'exploratory';
        }
      }
    }
  }

  // ── Pass 3: Dead fills ───────────────────────────────────────────────────
  // Same field filled multiple times with DIFFERENT values → all fills except
  // the final one are dead. Identical re-fills (autocomplete quirks) are kept.
  const fillsByLabel = new Map();

  for (let i = 0; i < n; i++) {
    const d = dispositions[i];
    if (d === 'setup' || d === 'exploratory' || d === 'recovery') continue;
    const a = rawActions[i];
    const isFill = a.tool === 'browser_fill' || a.tool === 'browser_type' || a.tool === 'browser_fill_form';
    if (!isFill) continue;

    if (a.tool === 'browser_fill_form') {
      const fields = (a.args || {}).fields;
      if (!Array.isArray(fields)) continue;
      for (const f of fields) {
        const label = String(f.label || f.name || f.placeholder || '').toLowerCase().trim();
        const value = String(f.value || '');
        if (!label) continue;
        const entries = fillsByLabel.get(label) || [];
        entries.push({ idx: i, value });
        fillsByLabel.set(label, entries);
      }
    } else {
      const labels = getFieldLabels(a);
      const label = labels[0] ? labels[0].toLowerCase().trim() : '';
      const value = String((a.args || {}).value || (a.args || {}).text || '');
      if (!label) continue;
      const entries = fillsByLabel.get(label) || [];
      entries.push({ idx: i, value });
      fillsByLabel.set(label, entries);
    }
  }

  for (const [, entries] of fillsByLabel) {
    if (entries.length < 2) continue;
    // Mark ALL earlier fills as dead — keep only the last committed fill.
    // Same-value re-fills are also dead: when the agent stumbled and re-filled
    // the same field with the same value (e.g. Password + Confirm Password both
    // filled twice), the exported spec only needs the final committed write.
    // The prior guard `entries[e].value !== lastValue` was preserving stumbled
    // same-value re-fills, which produced the duplicate el2/el3 + el4/el5 pattern.
    for (let e = 0; e < entries.length - 1; e++) {
      dispositions[entries[e].idx] = 'dead';
    }
  }

  // ── Pass 4: Assertion support ────────────────────────────────────────────
  // A browser_hover with no subsequent click on the same element within
  // HOVER_WINDOW actions → the hover was to reveal/inspect state (tooltip,
  // popover), not to trigger a UI transition. Keep it but flag as support.
  // Lost-form-state restores replay a completed approved step after a page
  // refresh erased the form. Keep the restore as the canonical action and drop
  // earlier actions for that same approved step so generated files do not
  // contain duplicate logical steps.
  for (let i = 0; i < n; i++) {
    const a = rawActions[i];
    if (!a || a.recoveryReason !== 'lost_form_state') continue;
    const canonicalStep = Number.isFinite(Number(a.canonicalForStepIndex))
      ? Number(a.canonicalForStepIndex)
      : Number.isFinite(Number(a.supersedesStepIndex))
        ? Number(a.supersedesStepIndex)
        : Number.isFinite(Number(a.stepIndex))
          ? Number(a.stepIndex)
          : null;
    if (canonicalStep == null) continue;
    for (let j = 0; j < i; j++) {
      if (dispositions[j] !== 'committed' && dispositions[j] !== 'assertion_support') continue;
      if (Number(rawActions[j]?.stepIndex) === canonicalStep) dispositions[j] = 'dead';
    }
  }

  const HOVER_WINDOW = 2;
  for (let i = 0; i < n; i++) {
    if (dispositions[i] !== 'committed') continue;
    const a = rawActions[i];
    if (a.tool !== 'browser_hover') continue;

    const hoverLabel = getButtonLabel(a).toLowerCase();
    let hasFollowUpClick = false;
    for (let j = i + 1; j < Math.min(n, i + 1 + HOVER_WINDOW); j++) {
      const b = rawActions[j];
      if (b.tool === 'browser_click' || b.tool === 'browser_double_click') {
        const bLabel = getButtonLabel(b).toLowerCase();
        if (bLabel && bLabel === hoverLabel) {
          hasFollowUpClick = true;
          break;
        }
      }
    }
    if (!hasFollowUpClick) {
      dispositions[i] = 'assertion_support';
    }
  }

  return dispositions;
}

// ── Core functions ────────────────────────────────────────────────────────────

function isScriptableAction(a) {
  if (!a || typeof a.tool !== 'string') return false;
  if (!SCRIPTABLE_TOOLS.has(a.tool)) return false;
  return a.ok !== false;
}

/**
 * Convert a raw trail entry to the shape the LLM and locator manifests consume.
 * Phase B: actionLocator/domFacts are threaded through so buildManifest can use
 * action-time evidence before falling back to the KB fuzzy-match path.
 */
function toCodegenAction(a) {
  const out = {
    tool: a.tool,
    args: a.args || {},
    narration: a.narration || `${a.tool}${a.ok === false ? '' : ' ok'}`,
  };
  if (a.pageUrl) out.pageUrl = a.pageUrl;
  if (a.pageUrlAfter) out.pageUrlAfter = a.pageUrlAfter;
  if (PLAYWRIGHT_HINTS[a.tool]) out.playwrightHint = PLAYWRIGHT_HINTS[a.tool];
  if (hasActionLocator(a.actionLocator)) out.actionLocator = a.actionLocator;
  // Codegen flooding: when an action did not reach gold-standard KB verification
  // (no count=1/sameElement proof — common on SPA re-renders and nameless
  // elements) but DID resolve a real, export-safe Playwright expression, the
  // conductor stashes it on `codegenLocator`. Use it so the generated page
  // object gets a real per-step locator instead of nothing. KB/memory/verdict
  // never read this field, so promotion gating stays strict.
  else if (hasActionLocator(a.codegenLocator)) out.actionLocator = a.codegenLocator;
  if (a.stepAuthoring) out.stepAuthoring = a.stepAuthoring;
  if (a.locatorRecipe) out.locatorRecipe = a.locatorRecipe;
  if (a.locatorEvidenceV2 || a.stepAuthoring?.locatorEvidenceV2) out.locatorEvidenceV2 = a.locatorEvidenceV2 || a.stepAuthoring.locatorEvidenceV2;
  if (a.actionLocatorGap) out.actionLocatorGap = a.actionLocatorGap;
  if (a.transitionProof) out.transitionProof = a.transitionProof;
  if (a.recoveryReason) out.recoveryReason = a.recoveryReason;
  if (Number.isFinite(Number(a.supersedesStepIndex))) out.supersedesStepIndex = Number(a.supersedesStepIndex);
  if (Number.isFinite(Number(a.canonicalForStepIndex))) out.canonicalForStepIndex = Number(a.canonicalForStepIndex);
  // Thread inline DOM evidence: role, accessibleName, selector captured at click-time.
  // This is the root fix for kbMiss on v2 traces — the run already resolved these facts;
  // no need to rediscover via KB narration matching.
  const facts = primaryDomFacts(a.domFacts);
  if (facts) {
    out.domFacts = facts;
  }
  // Thread structured DOM anchor context for table/grid operations.
  // context: { tableSelector, rowSelector, columnName, sectionSelector, formSelector }
  // Set by the conductor when it resolves a table-row action; used by validateContract
  // to enforce the table-context contract without requiring a locator rebuild.
  if (a.domFacts && a.domFacts.context && typeof a.domFacts.context === 'object') {
    out.context = a.domFacts.context;
  }
  return out;
}

/**
 * Build the Evidence Bundle from a case's MCP trail.
 *
 * Returns:
 *   actions       – setup + committed + assertion_support (what codegen sees)
 *   droppedActions – exploratory + recovery + dead (audit trail)
 *   traceVersion  – 'v2' if any action has domFacts; 'legacy' otherwise
 *   caseStatus    – passed through from the run result
 *   stepResults   – assertion outcomes from the run
 *   summary       – human-readable pipeline summary string
 *   testIntent    – 'negative_path' when the test case name matches NEGATIVE_PATH_RE;
 *                   undefined otherwise. Threads a deterministic server-side signal to
 *                   codegen so the LLM does not need to infer negative-path intent from
 *                   the name — it can just check actionPlan.testIntent === 'negative_path'.
 */
function buildActionPlan({ trail, status, stepResults, testCaseName }) {
  const source = Array.isArray(trail) ? trail : [];
  const rawActions = source.filter(isScriptableAction);

  // Detect trace version: v2 traces carry action-time DOM evidence.
  const traceVersion = rawActions.some((a) => primaryDomFacts(a.domFacts) || hasActionLocator(a.actionLocator) || hasActionLocator(a.codegenLocator)) ? 'v2' : 'legacy';

  const dispositions = classifyDisposition(rawActions);
  const actions = [];
  const droppedActions = [];

  for (let i = 0; i < rawActions.length; i++) {
    const d = dispositions[i];
    const action = { ...toCodegenAction(rawActions[i]), disposition: d };
    if (d === 'setup' || d === 'committed' || d === 'assertion_support') {
      actions.push(action);
    } else {
      droppedActions.push(action);
    }
  }

  const droppedBreakdown = droppedActions.length
    ? ` (${droppedActions.length} dropped: ${[...new Set(droppedActions.map((a) => a.disposition))].join(', ')})`
    : '';

  const testIntent = testCaseName && NEGATIVE_PATH_RE.test(String(testCaseName))
    ? 'negative_path'
    : undefined;

  return {
    actions,
    droppedActions,
    summary: `MCP: ${source.length} total → ${rawActions.length} scriptable → ${actions.length} exported${droppedBreakdown}.`,
    caseStatus: status,
    stepResults: Array.isArray(stepResults) ? stepResults : null,
    droppedToolCount: source.length - rawActions.length,
    traceVersion,
    ...(testIntent ? { testIntent } : {}),
  };
}

module.exports = {
  SCRIPTABLE_TOOLS,
  PLAYWRIGHT_HINTS,
  isScriptableAction,
  toCodegenAction,
  buildActionPlan,
  classifyDisposition,
  primaryDomFacts,
  hasActionLocator,
};
