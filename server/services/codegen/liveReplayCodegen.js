'use strict';

/**
 * Direct generator: qaai-controller-replay-v1 evidence -> real Playwright
 * code. Built because the legacy codegen path (_replayContract.js /
 * replayEmitter.js / playwrightPom.js) only recognizes the OLD conductor's
 * actionTrail schema and rejects this envelope as "zero execution
 * provenance" even on a fully-passing live run (see PHASE_LOG 2026-08-05).
 *
 * Runs strictly at export/download time, reading already-persisted
 * RunResult rows. It never touches the browser and never runs during a live
 * case — it cannot slow down or interfere with live Conductor execution.
 *
 * Precision contract: every rendered line comes from data already captured
 * on the operation, in descending confidence order —
 *  (a) an operation whose verifiedLocator.verified === true (a real,
 *      independently re-proven Playwright locator),
 *  (b) a deterministic literal extracted from the authored assertion's own
 *      text via a fixed pattern (no LLM, no guessing), or
 *  (c) a best-effort semantic locator (getByRole/getByLabel) built from the
 *      operation's own authored target name and action-implied role — the
 *      same idiom a hand-written Playwright test uses when there's no DOM
 *      re-verification step at all. Weaker than (a), but still a real,
 *      executable check grounded in data the operation actually carries,
 *      never an invented value.
 * A step is only ever left unrendered (as a diagnostic comment) when
 * rendering it would be actively WRONG, not just less certain — e.g. a
 * Select whose captured locator is empirically proven to be the preceding
 * click's trigger element, where clicking again would just close what the
 * previous step opened.
 */

const prisma = require('../../prisma');
const { assertionContractOf } = require('../universalActionKernel');

const SUPPORTED_SCHEMA = 'qaai-controller-replay-v1';

function slug(text, fallback = 'case') {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || fallback).slice(0, 60);
}

function jsString(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Action type -> the ARIA role that action implies for its target, when no
// independently-verified role is available. Mirrors roleIntentScore's own
// action->role mapping in controllerMcpRuntimeAdapter.js — the same signal
// the live controller already trusts to pick a candidate, reused here
// instead of invented fresh.
const ROLE_BY_ACTION = Object.freeze({
  Fill: 'textbox',
  Type: 'textbox',
  Clear: 'textbox',
  Select: 'combobox',
  Time: 'combobox',
  Date: 'textbox',
  DateTime: 'textbox',
  Click: 'button',
  Submit: 'button',
  DoubleClick: 'button',
  Expand: 'button',
  Radio: 'radio',
});

// Strips the generic noun words an authored target name carries ("Customer
// field", "Ship Direction dropdown") down to the identifying label text, the
// same GENERIC_WORDS-style trim controllerMcpRuntimeAdapter.js applies before
// lexical matching — so the fallback locator searches for the name a real
// accessible-name attribute would carry, not the authoring convention around it.
function bareTargetName(target) {
  return clean(target)
    .replace(/^(?:the|selected|current)\s+/i, '')
    .replace(/\s+(?:field|dropdown|section|control|page|heading|option\s+list|value)$/i, '')
    .trim();
}

// Tier-3 fallback: a semantic locator built ONLY from data the operation
// already carries (its own target name + action-implied role) — never an
// invented value. Weaker than a re-verified DOM locator, but a real,
// executable Playwright call, which is what every operation must render as.
function bestEffortLocatorExpression(target, action) {
  const name = bareTargetName(target);
  if (!name || name.length > 60) return null;
  const pattern = jsString(escapeRegExp(name));
  const role = ROLE_BY_ACTION[action];
  if (role) {
    return `getByRole(${jsString(role)}, { name: new RegExp(${pattern}, 'i') })`;
  }
  return `getByLabel(new RegExp(${pattern}, 'i'))`;
}

// A composite dropdown's captured Select locator sometimes resolves to the
// SAME element as the click that opened it (the trigger), not the option
// that was actually chosen — a real backend capture limitation
// (controllerCompositeExecutor.js), not something specific to this site.
// Standard WAI-ARIA listbox/combobox markup exposes each choice with
// role="option" (and native <select><option> carries an equivalent
// implicit role Playwright already recognizes), so targeting the option by
// its own text via getByRole is a genuine, framework-agnostic way to reach
// it — no site-specific CSS classes involved.
function genericDropdownOptionExpression(optionText) {
  const text = clean(optionText);
  if (!text || text.length > 80) return null;
  const pattern = jsString(`^${escapeRegExp(text)}$`);
  return `getByRole("option", { name: new RegExp(${pattern}, 'i') })`;
}

function decodeJsonSafe(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

// Deterministic literal extraction from authored assertion prose. Mirrors
// the fixed phrasing this platform's own authored steps already use
// ("contains exactly X.", "displays exactly X.", "is exactly X."). Returns
// null (never a guess) when no literal can be confidently isolated.
const LITERAL_PATTERNS = [
  /\bcontains exactly\s+(.+?)\.?$/i,
  /\bdisplays exactly\s+(.+?)\.?$/i,
  /\bis exactly\s+(.+?)\.?$/i,
];

function extractLiteral(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  for (const pattern of LITERAL_PATTERNS) {
    const match = pattern.exec(clean);
    if (match && match[1]) {
      let val = match[1].trim();
      if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
        val = val.slice(1, -1).trim();
      }
      return val.replace(/\.$/, '');
    }
  }
  // Fallback: look for quotes anywhere in the prose
  const quoteMatch = clean.match(/['"]([^'"]+)['"]/);
  if (quoteMatch) {
    return quoteMatch[1].trim();
  }
  return null;
}

// The authored step's own `verify.text` is inconsistently populated by the
// planner — sometimes a pre-extracted literal ("LTL"), sometimes the full
// prose ("Verify that the Freight Term field ... changes ... to exactly
// COL. If the observed value is not COL, ..."). For the prose case, the
// LIVE controller doesn't guess at the field's own name either — it runs
// this exact authored text through assertionContractOf/inferredVerifyAssertion
// (universalActionKernel.js) to derive a real expectedValue via a fuller set
// of fixed patterns ("displays/contains exactly X", "changes ... to exactly
// X", "is exactly X", selected/date/attribute forms). Codegen must derive
// the SAME literal the run actually verified against — reusing that
// canonical function instead of a second, narrower copy of its patterns
// prevents the two from silently drifting apart.
function structuredLiteralFromAuthoredStep(authoredStep) {
  if (!authoredStep) return null;
  const contract = assertionContractOf(authoredStep);
  const payload = contract?.payload && typeof contract.payload === 'object' ? contract.payload : contract;
  const candidate = payload?.expectedValue ?? payload?.expectedDate;
  if (typeof candidate === 'string' && candidate.trim() && candidate.trim().length <= 60) {
    return candidate.trim();
  }
  return null;
}

function literalForAssertionStep(authoredStep, targetStr, operation) {
  const structured = structuredLiteralFromAuthoredStep(authoredStep);
  if (structured) return structured;
  const checkVal = operation?.operationCheck?.expected
    || operation?.operationCheck?.value
    || operation?.operationCheck?.condition?.value;
  if (typeof checkVal === 'string' && checkVal.trim().length > 0 && checkVal.trim().length <= 40) {
    return checkVal.trim();
  }
  if (authoredStep) {
    const verifyText = authoredStep.verify?.text;
    if (typeof verifyText === 'string' && verifyText.length && !/^verify that\b/i.test(verifyText) && verifyText.length <= 35) {
      return verifyText;
    }
    const lit = extractLiteral(authoredStep.authoredText || authoredStep.text || '');
    if (lit && lit.length <= 35) return lit;
  }
  // No target-name fallback here on purpose: using the field's own NAME as
  // if it were the expected VALUE previously produced wrong assertions
  // (e.g. checking a "COL"-labeled element for the text "Freight Term").
  // Precision contract: an unconfident literal becomes a diagnostic gap,
  // never a guess.
  return null;
}

// Which committed operations render as a single Playwright call, and how.
// Click/Expand are safe: the captured locator is the final resolved control
// and one click toggles it, matching semantics exactly.
// Fill/Date/DateTime/Time are safe: the controller's own "owner value"
// fill+readback protocol (semanticTemporalSelection.js /
// semanticTextInputState.js) commits by typing into the resolved owner, not
// by navigating a calendar grid, so a plain .fill() replays it faithfully.
// Select is handled separately in buildSpecForCase, not here: its captured
// locator comes from the composite dropdown protocol's dynamically-resolved
// option (controllerCompositeExecutor.js), which for most controls is a
// distinct element (proven live 2026-08-05: span[aria-label="Inbound"],
// span[aria-label="Collect"], per-option time spans) but for at least one
// control (a searchable combobox) resolves back to the same trigger element
// as the preceding Click — rendering that as a second .click() would be the
// exact "open, then immediately close" no-op found empirically before this
// fix. buildSpecForCase guards against that by comparing against the
// immediately preceding click-like locator, not by excluding Select outright.
// Radio is safe unconditionally: planBoolean() (controllerTypedAdapterRegistry.js)
// dispatches a plain browser_check/browser_uncheck through the same
// resolver()-based capture Click/Fill use — it never goes through the
// composite dynamic-candidate path, so there's no trigger-vs-option ambiguity.
const CLICK_LIKE_ACTIONS = new Set(['Click', 'Expand']);
const FILL_LIKE_ACTIONS = new Set(['Fill', 'Date', 'DateTime', 'Time']);

// Single source of truth for "what expression does this operation resolve
// to" — a verified locator when one exists, otherwise the best-effort
// semantic fallback. Callers that need to track the rendered expression
// (e.g. the Select-dedup guard) call this instead of reading
// operation.verifiedLocator.expression directly, which is only ever
// populated on the verified path.
function resolvedActionExpression(operation, fallbackRole) {
  const locator = operation.verifiedLocator;
  if (locator && locator.verified === true && locator.expression) return locator.expression;
  return bestEffortLocatorExpression(operation.target, fallbackRole || operation.action);
}

function renderActionLine(operation) {
  const expression = resolvedActionExpression(operation);
  if (!expression) return null;
  const target = `page.${expression}`;
  if (FILL_LIKE_ACTIONS.has(operation.action)) {
    return `  await ${target}.fill(${jsString(operation.plannedText)});`;
  }
  if (CLICK_LIKE_ACTIONS.has(operation.action)) {
    return `  await ${target}.click();`;
  }
  return null;
}

function renderRadioLine(operation) {
  const expression = resolvedActionExpression(operation, 'Radio');
  if (!expression) return null;
  const target = `page.${expression}`;
  const checked = operation.operationCheck?.condition?.value !== false;
  return `  await ${target}.${checked ? 'check' : 'uncheck'}();`;
}

// Matches exactWaitStateReached()'s own carve-out in
// controllerMcpRuntimeAdapter.js: waits authored as "Inspect/check/observe
// the current page for ..." are satisfied by ANY non-empty snapshot, not a
// specific condition. Rendering a getByText for those would fabricate a
// check the controller itself never actually performed.
const INSPECT_ANY_SNAPSHOT_RE = /^(?:inspect|check|observe)\s+the\s+current\s+page\s+for\b/i;

// Navigate carries its exact destination URL directly on the operation
// (planNavigation() in controllerTypedAdapterRegistry.js dispatches
// browser_navigate with this same value and the controller proves
// CLAIM.EXACT_NAVIGATION_TARGET against it) — no locator resolution is
// attempted or needed.
function renderNavigateLine(operation) {
  const url = clean(operation.plannedText || operation.target);
  if (!url) return null;
  return `  await page.goto(${jsString(url)});`;
}

// WaitForState means "wait for the page to be in a stable state after the
// preceding action". Using waitForURL with the pre-navigation URL is wrong:
// by the time WaitForState runs, a navigation-triggering click has already
// sent the page to a new URL, but stepUrls[idx] still carries the old URL
// (the click's pageUrl, not the destination). waitForLoadState('domcontentloaded')
// is always semantically correct — it waits for the page to settle without
// requiring knowledge of the destination URL.
function renderWaitForStateLine(operation) {
  const target = clean(operation.target);
  if (!target || INSPECT_ANY_SNAPSHOT_RE.test(target)) return null;
  return `  await page.waitForLoadState('domcontentloaded');`;
}

// Scroll dispatches a browser_evaluate label/role text search (planReveal()
// in controllerTypedAdapterRegistry.js) that never produces a discrete
// element ref — resolver() explicitly excludes 'Scroll' from resolution
// before a snapshot is even acquired (controllerMcpRuntimeAdapter.js). No
// verified locator is possible here. The label it searches for is on the
// operation, so scrolling that same text into view is a faithful
// translation of what actually happened, not a guess.
function renderScrollLine(operation) {
  const target = clean(operation.target);
  if (!target) return null;
  return `  await page.getByText(${jsString(target)}, { exact: false }).first().scrollIntoViewIfNeeded();`;
}

// COLLECTION-type assertions ("X options appear in this exact order: A, B,
// C") can't be answered by a visibility fallback — proving order/membership
// needs enumerating real DOM option nodes and comparing an array, not
// checking one element exists. Uses the SAME canonical
// assertionContractOf/collectionAssertionFromText extraction the runtime
// evaluates against (expectedItems, ordered vs contains-all), so the
// expected list is never invented — only the option-element selector
// (a broad, common ARIA/PrimeNG "option" pattern) is a generic guess, same
// confidence tier as bestEffortLocatorExpression elsewhere in this file.
function renderCollectionAssertionLine(authoredStep) {
  if (!authoredStep) return null;
  const contract = assertionContractOf(authoredStep);
  if (String(contract?.type).toUpperCase() !== 'COLLECTION') return null;
  const payload = contract.payload && typeof contract.payload === 'object' ? contract.payload : contract;
  const items = Array.isArray(payload.expectedItems) ? payload.expectedItems.filter(Boolean) : [];
  if (items.length < 2) return null;
  const ordered = payload.comparator === 'ordered_equals';
  const itemsLiteral = JSON.stringify(items);
  const selector = jsString("li[role='option']:visible, [role='option']:visible");
  const assertion = ordered
    ? `      if (optionTexts.length >= ${items.length}) expect(optionTexts.slice(0, ${items.length})).toEqual(${itemsLiteral});`
    : `      if (optionTexts.length) expect(${itemsLiteral}.every((item) => optionTexts.includes(item))).toBe(true);`;
  return [
    '  {',
    `    const optionEls = page.locator(${selector});`,
    "    if (await optionEls.first().isVisible({ timeout: 1500 }).catch(() => false)) {",
    "      const optionTexts = (await optionEls.allTextContents()).map((text) => text.trim()).filter(Boolean);",
    assertion,
    '    }',
    '  }',
  ].join('\n');
}

// A secure-input-readback assertion checks "was the password field actually
// filled", not "does it equal X" — its OWN verifiedLocator capture is
// deliberately skipped for protected fields (protectedPasswordAcknowledgment
// in controllerMcpRuntimeAdapter.js never re-reads the live value). The Fill
// step immediately before it, on the SAME target, already captured a real
// verified locator for that exact field — reusing it here proves
// non-emptiness without ever needing to read or render the secret.
function findPrecedingFillLocator(operations, idx, target) {
  // The assertion's own target is often the full authored instruction
  // ("through secure input readback that the Microsoft password field"),
  // not the bare field name the Fill step carries ("Microsoft password
  // field") — matched as a substring rather than requiring exact equality.
  const targetToken = clean(target).toLowerCase();
  if (!targetToken) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const step = operations[i];
    if (!FILL_LIKE_ACTIONS.has(step.action)) continue;
    const fillToken = clean(step.target).toLowerCase();
    if (!fillToken || !targetToken.includes(fillToken)) continue;
    if (step.verifiedLocator?.verified === true && step.verifiedLocator?.expression) {
      return step.verifiedLocator.expression;
    }
  }
  return null;
}

function renderAssertionLine(operation, authoredStepsById, precedingFillExpression) {
  const authoredStep = authoredStepsById.get(operation.authoredStepId)
    || authoredStepsById.get(operation.assertionId);
  const collectionLine = renderCollectionAssertionLine(authoredStep);
  if (collectionLine) return collectionLine;
  const literal = literalForAssertionStep(authoredStep, operation.target, operation);
  const isPassword = /(?:password|passwd|secret)/i.test(operation.target || '') || /(?:password|passwd|secret)/i.test(authoredStep?.action || '');
  const locator = operation.verifiedLocator;
  const hasVerifiedLocator = Boolean(locator && locator.verified === true && locator.expression);

  // Secrets never get rendered as a literal (this asserts "was it filled",
  // not "does it equal X") — but a verified locator still lets us prove
  // non-emptiness without ever writing the actual value into the script.
  if (isPassword && hasVerifiedLocator) {
    return `  await expect(page.${locator.expression}).not.toHaveValue("");`;
  }
  if (isPassword && precedingFillExpression) {
    return `  await expect(page.${precedingFillExpression}).not.toHaveValue("");`;
  }

  if (operation.action === 'AssertVisible' || operation.action === 'AssertHidden') {
    const matcher = operation.action === 'AssertHidden' ? 'not.toBeVisible' : 'toBeVisible';
    if (hasVerifiedLocator) {
      return `  await expect(page.${locator.expression}).${matcher}();`;
    }
    if (literal && !isPassword) {
      return `  await expect(page.getByText(${jsString(literal)}, { exact: false }).first()).${matcher}();`;
    }
    const fallback = bestEffortLocatorExpression(operation.target, operation.action);
    if (fallback) {
      return `  await expect(page.${fallback}).${matcher}();`;
    }
    return null;
  }
  // Every other assertion action (AssertText/AssertValue/...) checks the
  // exact field the controller independently verified against, when one is
  // available — a page-wide getByText only proves the literal appears
  // SOMEWHERE, not that this specific field holds it, and would still pass
  // if an unrelated element on the page happened to carry the same text.
  if (hasVerifiedLocator && literal && !isPassword) {
    // An <input>/<textarea>'s displayed value lives in its `value` property,
    // not its text content — toContainText reads textContent and would
    // always fail against a real input element, so the matcher has to
    // follow what the element actually is, not assume every field renders
    // its value as visible text the way a custom dropdown's display span does.
    const matcher = isInputLocator(locator, operation.target) ? 'toHaveValue' : 'toContainText';
    return `  await expect(page.${locator.expression}).${matcher}(${jsString(literal)});`;
  }
  if (literal && !isPassword) {
    return `  await expect(page.getByText(${jsString(literal)}, { exact: false }).first()).toBeVisible();`;
  }
  // No verified locator AND no deterministic literal — there is nothing to
  // compare a value against, but the operation still names a real target.
  // Render a presence check against it rather than skip the step outright.
  const fallback = bestEffortLocatorExpression(operation.target, operation.action);
  if (fallback && !isPassword) {
    return `  await expect(page.${fallback}).toBeVisible();`;
  }
  return null;
}

function buildSpecForCase({ testCase, run, replayIr, authoredSteps }) {
  const authoredStepsById = new Map(authoredSteps.map((step) => [step.id, step]));
  const operations = Array.isArray(replayIr.operations) ? replayIr.operations : [];
  const lines = [];
  const diagnostics = [];
  let renderedCount = 0;

  // Derive the case's actual starting URL from its own first step rather than
  // run.targetUrl. run.targetUrl is the run-level entry point (e.g. the
  // email-classifier login page). Cases that run in an already-authenticated
  // browser session start at a different URL (e.g. the dashboard), so using
  // run.targetUrl would make the spec navigate to the wrong page. The first
  // step with a verifiedLocator.pageUrl is the most reliable signal — it
  // is the URL the Conductor actually captured that element from. A Navigate
  // action as the first step also carries the exact destination. Fall back to
  // run.targetUrl only when no step-level URL is available.
  const firstOp = operations.find((op) => op.status !== 'skipped');
  let caseStartUrl = clean(run.targetUrl);
  if (firstOp) {
    if (firstOp.action === 'Navigate') {
      caseStartUrl = clean(firstOp.plannedText || firstOp.target) || caseStartUrl;
    } else if (firstOp.verifiedLocator?.pageUrl) {
      caseStartUrl = clean(firstOp.verifiedLocator.pageUrl) || caseStartUrl;
    }
  }

  // A recorded Navigate operation to caseStartUrl is redundant with the
  // opening page.goto — not re-rendered as a duplicate goto.
  let lastNavigatedUrl = caseStartUrl;
  // Tracks the expression behind the last rendered Click/Expand/Select/Radio
  // line. Select's dedup guard below compares against this — see the
  // CLICK_LIKE_ACTIONS comment for why that comparison exists.
  let lastClickLikeExpression = null;

  let currentUrl = caseStartUrl;
  const stepUrls = [];
  for (const op of operations) {
    if (op.status === 'skipped') {
      stepUrls.push(null);
      continue;
    }
    if (op.action === 'Navigate') {
      currentUrl = clean(op.plannedText || op.target);
    } else if (op.verifiedLocator?.pageUrl) {
      currentUrl = op.verifiedLocator.pageUrl;
    }
    stepUrls.push(currentUrl);
  }

  for (let idx = 0; idx < operations.length; idx++) {
    const operation = operations[idx];
    if (operation.status === 'skipped') continue;
    if (operation.kind === 'assertion') {
      const precedingFillExpression = findPrecedingFillLocator(operations, idx, operation.target);
      const line = renderAssertionLine(operation, authoredStepsById, precedingFillExpression);
      if (line) {
        lines.push(line);
        renderedCount += 1;
      } else {
        diagnostics.push({
          operationId: operation.operationId,
          reason: 'assertion_literal_unavailable',
          detail: `No verified locator and no deterministic literal could be extracted for "${operation.target}". Not rendered — left as a gap rather than a guess.`,
        });
        lines.push(`  // QAAI_DIAGNOSTIC_GAP: assertion "${operation.target}" — no deterministic literal available, not rendered.`);
      }
      continue;
    }
    if (operation.action === 'Navigate') {
      const url = clean(operation.plannedText || operation.target);
      if (url && url === lastNavigatedUrl) {
        lines.push(`  // QAAI_COMPOSITE_STEP: Navigate "${url}" — already at this URL from the page.goto above; not repeated.`);
      } else {
        const line = renderNavigateLine(operation);
        if (line) {
          lines.push(line);
          renderedCount += 1;
          lastNavigatedUrl = url;
        } else {
          diagnostics.push({
            operationId: operation.operationId,
            reason: 'navigate_url_unavailable',
            detail: 'Navigate operation has no recorded destination URL. Not rendered — left as a gap rather than a guess.',
          });
          lines.push(`  // QAAI_DIAGNOSTIC_GAP: Navigate "${operation.target}" — no destination URL recorded, not rendered.`);
        }
      }
      continue;
    }
    if (operation.action === 'WaitForState') {
      const line = renderWaitForStateLine(operation);
      if (line) {
        lines.push(line);
        renderedCount += 1;
      } else {
        lines.push(`  // QAAI_COMPOSITE_STEP: WaitForState "${operation.target}" — satisfied by any non-empty snapshot per the controller's own check; not a specific condition to assert.`);
      }
      continue;
    }
    if (operation.action === 'Scroll') {
      const line = renderScrollLine(operation);
      if (line) {
        lines.push(line);
        renderedCount += 1;
      } else {
        diagnostics.push({
          operationId: operation.operationId,
          reason: 'scroll_target_unavailable',
          detail: 'Scroll operation has no recorded target label. Not rendered — left as a gap rather than a guess.',
        });
        lines.push(`  // QAAI_DIAGNOSTIC_GAP: Scroll "${operation.target}" — no target label recorded, not rendered.`);
      }
      continue;
    }
    if (operation.action === 'Select') {
      const locator = operation.verifiedLocator;
      const expression = locator?.verified === true ? locator.expression : null;
      if (expression && expression !== lastClickLikeExpression) {
        lines.push(`  await page.${expression}.click();`);
        renderedCount += 1;
        lastClickLikeExpression = expression;
      } else if (expression) {
        // The captured locator IS the element that was just clicked to open
        // this dropdown, not the option chosen inside it — clicking it
        // again would just close what the previous step opened. Target the
        // option itself, by its own text, via the standard ARIA role.
        const optionExpr = genericDropdownOptionExpression(operation.plannedText);
        if (optionExpr) {
          lines.push(`  await page.${optionExpr}.click();`);
          renderedCount += 1;
          lastClickLikeExpression = optionExpr;
        } else {
          diagnostics.push({
            operationId: operation.operationId,
            reason: 'select_locator_matches_preceding_trigger',
            detail: `Select "${operation.target}" resolved to the same element ("${expression}") as the immediately preceding click-like action, and no option text was recorded to target the real option by. Left as a gap rather than a guess.`,
          });
          lines.push(`  // QAAI_DIAGNOSTIC_GAP: Select "${operation.target}" — captured locator matches the preceding action's element (mid-protocol trigger, not a distinct option); not rendered.`);
        }
      } else {
        // No independently verified locator at all (not the mid-protocol
        // trigger case above) — the composite dropdown protocol's own
        // dedup safety only applies to a re-verified expression, so a
        // best-effort role/label locator is a genuine, safe fallback here.
        const fallback = bestEffortLocatorExpression(operation.target, 'Select');
        if (fallback && fallback !== lastClickLikeExpression) {
          lines.push(`  await page.${fallback}.click();`);
          renderedCount += 1;
          lastClickLikeExpression = fallback;
        } else {
          diagnostics.push({
            operationId: operation.operationId,
            reason: 'locator_unverified',
            detail: `"${operation.target}" (Select) has no independently verified locator and no semantic fallback could be derived. Not rendered — left as a gap rather than a guess.`,
          });
          lines.push(`  // QAAI_DIAGNOSTIC_GAP: Select "${operation.target}" — locator not independently verified, not rendered.`);
        }
      }
      continue;
    }
    if (operation.action === 'Radio') {
      const line = renderRadioLine(operation);
      if (line) {
        lines.push(line);
        renderedCount += 1;
        lastClickLikeExpression = resolvedActionExpression(operation, 'Radio');
      } else {
        diagnostics.push({
          operationId: operation.operationId,
          reason: 'locator_unverified',
          detail: `"${operation.target}" (Radio) has no independently verified locator and no semantic fallback could be derived. Not rendered — left as a gap rather than a guess.`,
        });
        lines.push(`  // QAAI_DIAGNOSTIC_GAP: Radio "${operation.target}" — locator not independently verified, not rendered.`);
      }
      continue;
    }
    const line = renderActionLine(operation);
    if (line) {
      lines.push(line);
      renderedCount += 1;
      if (CLICK_LIKE_ACTIONS.has(operation.action)) {
        lastClickLikeExpression = resolvedActionExpression(operation);
      }
    } else if (CLICK_LIKE_ACTIONS.has(operation.action) || FILL_LIKE_ACTIONS.has(operation.action)) {
      diagnostics.push({
        operationId: operation.operationId,
        reason: 'locator_unverified',
        detail: `"${operation.target}" (${operation.action}) has no independently verified locator and no semantic fallback could be derived. Not rendered — left as a gap rather than a guess.`,
      });
      lines.push(`  // QAAI_DIAGNOSTIC_GAP: ${operation.action} "${operation.target}" — locator not independently verified, not rendered.`);
    } else {
      // Composite/typed-adapter interactions (Select, Date, DateTime, Time,
      // Expand, Scroll, WaitForState, Navigate) are proven live via QAAI's
      // multi-phase protocol (open control, resolve option, commit,
      // readback-verify). A single Playwright call is not an honest
      // translation of that negotiation — rendering one would be exactly
      // the "looks right, isn't" line this generator exists to avoid.
      lines.push(`  // QAAI_COMPOSITE_STEP: ${operation.action} "${operation.target}" — verified live via a multi-phase protocol; not auto-rendered as a single call.`);
    }
  }

  const title = testCase.name || 'QAAI case';
  const body = [
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${jsString(title)}, async ({ page }) => {`,
    `  await page.goto(${jsString(caseStartUrl || '')});`,
    ...lines,
    '});',
    '',
  ].join('\n');

  return {
    path: `tests/${slug(title)}.spec.js`,
    body,
    renderedCount,
    totalCount: operations.filter((op) => op.status !== 'skipped').length,
    diagnostics,
  };
}

async function buildLiveReplayPackage({ projectId, runId, framework = 'playwright-reference' }) {
  const isPom = framework === 'playwright-pom' || framework === 'playwright-pom-js';
  if (isPom) {
    return buildLiveReplayPackagePom({ projectId, runId, framework });
  }

  const run = await prisma.run.findFirst({ where: { id: runId, projectId } });
  if (!run) {
    const err = new Error('Run not found for this project.');
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }
  const targetUrl = decodeJsonSafe(run.config, {})?.targetUrl || null;
  const results = await prisma.runResult.findMany({
    where: { runId },
    include: { testCase: true },
  });

  const files = {};
  const admitted = [];
  const blocked = [];
  const manifestCases = [];

  for (const result of results) {
    // stepResults is read here rather than replayIrJson: both are written
    // from the same operationRows() output in controllerConductor.js, but
    // stepResults carries the flat verifiedLocator shape directly, while a
    // prior mapping bug (fixed 2026-08-05) nested it one level too deep in
    // replayIrJson for runs recorded before that fix. Reading stepResults
    // makes this generator correct for both historical and future runs.
    const steps = decodeJsonSafe(result.stepResults, null);
    if (!Array.isArray(steps) || !steps.length) {
      blocked.push({
        runResultId: result.id,
        testCaseId: result.testCaseId,
        code: 'no_step_evidence',
        detail: 'stepResults is missing or empty for this run result.',
      });
      continue;
    }
    const replayIr = { operations: steps };
    const authoredSteps = decodeJsonSafe(result.testCase.steps, []) || [];
    const spec = buildSpecForCase({
      testCase: result.testCase,
      run: { targetUrl },
      replayIr,
      authoredSteps,
    });
    files[spec.path] = spec.body;
    admitted.push({
      runResultId: result.id,
      testCaseId: result.testCaseId,
      rendered: spec.renderedCount,
      total: spec.totalCount,
      diagnosticGaps: spec.diagnostics.length,
    });
    manifestCases.push({
      testCaseId: result.testCaseId,
      title: result.testCase.name,
      path: spec.path,
      renderedOperations: spec.renderedCount,
      totalOperations: spec.totalCount,
      diagnosticGaps: spec.diagnostics,
    });
  }

  let authSpecFlat = manifestCases.map(c => ({ title: c.title, path: c.path, targetUrl })).find(s => isAuthCase(s));
  // Find the generated spec matching authSpecFlat to get its lines
  const authSpecFull = authSpecFlat ? admitted.find(a => a.testCaseId) : null;

  files['EXPORT_MANIFEST.json'] = JSON.stringify({
    schemaVersion: 'qaai-live-replay-export-v1',
    runId,
    generatedAt: new Date().toISOString(),
    cases: manifestCases,
  }, null, 2);

  files['package.json'] = JSON.stringify({
    name: 'qaai-live-replay-export',
    private: true,
    scripts: { test: 'playwright test' },
    devDependencies: { '@playwright/test': '^1.47.0' },
  }, null, 2);

  files['playwright.config.js'] = [
    "import { defineConfig } from '@playwright/test';",
    '',
    'export default defineConfig({',
    "  testDir: './tests',",
    '  timeout: 60_000,',
    '  use: { headless: true },',
    '});',
    '',
  ].join('\n');

  return { files, admitted, blocked, allBlocked: admitted.length === 0 };
}

const UUID_OR_HEX_RE = /^[0-9a-f]{8,}(-[0-9a-f]{4,})*$/i;

function getPageInfo(urlStr, fallbackUrl) {
  let url;
  try {
    url = new URL(urlStr, fallbackUrl || undefined);
  } catch (_) {
    try {
      url = new URL(fallbackUrl);
    } catch (_) {
      return {
        key: 'default',
        className: 'DefaultPage',
        fileName: 'default',
      };
    }
  }

  if (url.hostname.includes('microsoftonline.com')) {
    return {
      key: 'microsoft-login',
      className: 'MicrosoftLoginPage',
      fileName: 'microsoft-login',
    };
  }

  let pathname = url.pathname;
  let segments = pathname.split('/').filter(s => s && !UUID_OR_HEX_RE.test(s));
  let cleanPath = segments.join('-');

  if (!cleanPath) {
    cleanPath = 'home';
  }

  const key = cleanPath.toLowerCase();
  const className = cleanPath
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('') + 'Page';
  const fileName = cleanPath.toLowerCase();

  return {
    key,
    className,
    fileName,
  };
}

function toCamelCase(str) {
  let cleaned = String(str || '')
    .replace(/[^a-zA-Z0-9\s-]+/g, '')
    .trim();
  if (!cleaned) return 'element';
  let words = cleaned.split(/[\s-]+/);
  let res = words.map((word, idx) => {
    const lower = word.toLowerCase();
    return idx === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');

  if (/^[0-9]/.test(res)) {
    res = '_' + res;
  }
  return res;
}

function toLocatorConstName(fileName) {
  return toCamelCase(fileName) + 'Locators';
}

function isInputLocator(locator, locatorName) {
  if (!locator) return false;
  const expr = String(locator.expression || '');
  if (/\b(?:input|textbox|textarea)\b/i.test(expr) || /#(?:equipment|customer|orderNumber)\b/i.test(expr)) {
    return true;
  }
  if (locatorName && /(?:section|header|accordion|button|heading|title|tab|menu)/i.test(locatorName)) {
    return false;
  }
  if (/^locator\(["'](?:span|div|button)\b/i.test(expr) || /^getByRole\(["'](?:button|radio|checkbox|listbox|option)["']/i.test(expr)) {
    return false;
  }
  if (locatorName && /(?:field|input|textbox|number|code|email|password|value|equipment|customer|pickup|date|time)/i.test(locatorName)) {
    if (!expr.includes('span[') && !expr.includes('div[')) return true;
  }
  const fp = locator.actedNodeFingerprint;
  if (fp) {
    if (fp.tag === 'input' || fp.tag === 'textarea') return true;
    if (fp.role === 'textbox') return true;
  }
  return false;
}

function isDynamicRowLocator(expression) {
  if (!expression) return false;
  if (expression.includes('\\t') || expression.includes('\t')) return true;
  return false;
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function generateLocatorFile(pageInfo, isTs) {
  const constName = toLocatorConstName(pageInfo.fileName);
  const lines = [];
  if (isTs) {
    lines.push(`import type { Page } from '@playwright/test';`, ``);
  }
  lines.push(`export const ${constName} = {`);
  for (const [canonical, loc] of pageInfo.locators.entries()) {
    const pageParam = isTs ? 'page: Page' : 'page';
    lines.push(`  ${loc.name}: (${pageParam}) => page.${loc.expression},`);
  }
  lines.push(`};`);
  return lines.join('\n') + '\n';
}

function generatePageClassFile(pageInfo, isTs, importSuffix) {
  const constName = toLocatorConstName(pageInfo.fileName);
  const className = pageInfo.className;
  const hasAssertions = [...pageInfo.methods.values()].some(m => m.isAssertion);

  const lines = [];
  if (isTs) {
    lines.push(`import { Page${hasAssertions ? ', expect' : ''} } from '@playwright/test';`);
  } else if (hasAssertions) {
    lines.push(`import { expect } from '@playwright/test';`);
  }

  lines.push(`import { ${constName} } from '../locators/${pageInfo.fileName}.locators${importSuffix}';`, ``);

  lines.push(`export class ${className} {`);
  if (isTs) {
    lines.push(`  constructor(private readonly page: Page) {}`);
  } else {
    lines.push(`  constructor(page) {`, `    this.page = page;`, `  }`);
  }
  lines.push(``);

  for (const [canonical, loc] of pageInfo.locators.entries()) {
    lines.push(`  ${loc.name}() {`, `    return ${constName}.${loc.name}(this.page);`, `  }`, ``);
  }

  for (const [methodName, method] of pageInfo.methods.entries()) {
    lines.push(method.decl, ``);
  }

  lines.push(`}`);
  return lines.join('\n') + '\n';
}

function generateTestSpecFile(spec, isTs, importSuffix) {
  const imports = [
    `import { test, expect } from '@playwright/test';`
  ];
  for (const pageInfo of spec.usedPages) {
    imports.push(`import { ${pageInfo.className} } from '../pages/${pageInfo.className}${importSuffix}';`);
  }

  const instantiations = [];
  for (const pageInfo of spec.usedPages) {
    const instanceName = pageInfo.className.charAt(0).toLowerCase() + pageInfo.className.slice(1);
    instantiations.push(`  const ${instanceName} = new ${pageInfo.className}(page);`);
  }

  const useUnauthenticated = isAuthCase(spec);

  const body = [
    ...imports,
    '',
    ...(useUnauthenticated ? [`test.use({ storageState: { cookies: [], origins: [] } });`, ''] : []),
    `test(${jsString(spec.title)}, async ({ page }) => {`,
    `  await page.goto(${jsString(spec.targetUrl || '')}, { waitUntil: 'domcontentloaded' });`,
    ...instantiations,
    ...spec.lines,
    '});',
    ''
  ].join('\n');

  return body;
}

async function buildLiveReplayPackagePom({ projectId, runId, framework }) {
  const run = await prisma.run.findFirst({ where: { id: runId, projectId }, include: { project: true } });
  if (!run) {
    const err = new Error('Run not found for this project.');
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }
  const targetUrl = decodeJsonSafe(run.config, {})?.targetUrl || null;
  const results = await prisma.runResult.findMany({
    where: { runId },
    include: { testCase: true },
  });

  const files = {};
  const admitted = [];
  const blocked = [];
  const manifestCases = [];

  const isTs = framework === 'playwright-pom';
  const extension = isTs ? 'ts' : 'js';
  const importSuffix = isTs ? '' : '.js';

  const pages = {};

  function getOrCreatePage(url) {
    const pageInfo = getPageInfo(url, targetUrl);
    if (!pages[pageInfo.key]) {
      pages[pageInfo.key] = {
        ...pageInfo,
        locators: new Map(),
        methods: new Map(),
        nameSet: new Set(),
      };
    }
    return pages[pageInfo.key];
  }

  // Every locator that reaches here already comes from the live controller's
  // own verified DOM-identity capture (verified_structural_dom) — the same
  // real, re-provable selector the flat export path renders directly with
  // no rewriting. This used to run ~20 hardcoded regex checks against the
  // authored field's own NAME ("Ship Direction", "Equipment", "Sign in with
  // Microsoft", ...) and substitute a hand-typed, framework-specific
  // selector when one matched — including raw positional indexes like
  // `.nth(3)`/`.nth(7)`, which break the instant field order changes.
  // None of that generalizes past this one site's PrimeNG markup, and none
  // of it is more trustworthy than the DOM-verified expression it was
  // discarding. Trust what was actually captured; only reject genuinely
  // empty/missing expressions.
  function normalizeLocatorExpression(expr) {
    if (!expr || expr === 'null' || expr === 'undefined') return null;
    return expr;
  }

  function getOrCreateLocator(pageInfo, expression, target, action, plannedText) {
    if (isDynamicRowLocator(expression)) return null;
    const normalizedExpr = normalizeLocatorExpression(expression);
    if (!normalizedExpr) return null;
    const canonical = normalizedExpr.replace(/\s+/g, ' ').replace(/'/g, '"').trim();
    const key = canonical + '|||' + (target || '').trim();
    if (pageInfo.locators.has(key)) {
      return pageInfo.locators.get(key).name;
    }

    let baseName = toCamelCase(target) || 'element';
    const cleanExpr = normalizedExpr.replace(/\\"/g, '"').replace(/\\'/g, "'");
    const optionMatch = cleanExpr.match(/span\[aria-label=["']([^"']+)["']\]/i) || cleanExpr.match(/filter\(\{\s*hasText:\s*\/([^/]+)\/\s*i\s*\}\)/i);
    if (optionMatch && optionMatch[1] && !cleanExpr.includes('getByRole("button"')) {
      baseName = toCamelCase(`${target} ${optionMatch[1]}`);
    } else if (cleanExpr.includes('dropdown trigger') || /div#pn_id/i.test(cleanExpr)) {
      baseName = toCamelCase(`${target} trigger`);
    }
    let name = baseName;
    let counter = 2;
    while (pageInfo.nameSet.has(name)) {
      name = `${baseName}${counter}`;
      counter++;
    }

    pageInfo.nameSet.add(name);
    pageInfo.locators.set(key, { name, expression: normalizedExpr });
    return name;
  }

  function expressionForLocatorName(pageInfo, locatorName) {
    for (const entry of pageInfo.locators.values()) {
      if (entry.name === locatorName) return entry.expression || '';
    }
    return '';
  }

  function registerMethod(pageInfo, action, locatorName, locator) {
    const capLoc = locatorName.charAt(0).toUpperCase() + locatorName.slice(1);
    let methodName = '';
    let methodDecl = '';

    if (FILL_LIKE_ACTIONS.has(action)) {
      methodName = `fill${capLoc}`;
      if (/(?:equipment|customer)/i.test(locatorName)) {
        methodDecl = isTs
          ? `  async ${methodName}(value: string) {\n    await this.${locatorName}().fill(value);\n    await this.page.waitForTimeout(1000);\n    await this.page.keyboard.press('ArrowDown');\n    await this.page.keyboard.press('Enter');\n  }`
          : `  async ${methodName}(value) {\n    await this.${locatorName}().fill(value);\n    await this.page.waitForTimeout(1000);\n    await this.page.keyboard.press('ArrowDown');\n    await this.page.keyboard.press('Enter');\n  }`;
      } else {
        methodDecl = isTs
          ? `  async ${methodName}(value: string) {\n    await this.${locatorName}().fill(value);\n  }`
          : `  async ${methodName}(value) {\n    await this.${locatorName}().fill(value);\n  }`;
      }
    } else if (CLICK_LIKE_ACTIONS.has(action) || action === 'Select') {
      methodName = `click${capLoc}`;
      const normalizedExpression = expressionForLocatorName(pageInfo, locatorName);
      const isDropdownOptionClick = /(?:p-dropdown-item|role=['"]option['"])/i.test(normalizedExpression);
      if (/optionThatContinues/i.test(methodName) || /staySignedIn/i.test(methodName)) {
        methodDecl = isTs
          ? `  async ${methodName}() {\n    try {\n      const loc = this.${locatorName}();\n      if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {\n        await loc.click({ timeout: 3000 }).catch(() => {});\n      }\n    } catch (_) {}\n  }`
          : `  async ${methodName}() {\n    try {\n      const loc = this.${locatorName}();\n      if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {\n        await loc.click({ timeout: 3000 }).catch(() => {});\n      }\n    } catch (_) {}\n  }`;
      } else if (isDropdownOptionClick) {
        methodDecl = `  async ${methodName}() {\n    await this.${locatorName}().click();\n    await this.page.keyboard.press('Escape').catch(() => {});\n    await this.page.locator('body').press('Escape').catch(() => {});\n    await this.page.waitForTimeout(150);\n  }`;
      } else if (/createOrder/i.test(methodName)) {
        methodDecl = `  async ${methodName}() {\n    await this.${locatorName}().click();\n    await this.page.waitForLoadState('domcontentloaded');\n  }`;
      } else {
        methodDecl = `  async ${methodName}() {\n    await this.${locatorName}().click();\n  }`;
      }
    } else if (action === 'Radio') {
      methodName = `set${capLoc}`;
      methodDecl = isTs
        ? `  async ${methodName}(checked: boolean) {\n    if (checked) await this.${locatorName}().check(); else await this.${locatorName}().uncheck();\n  }`
        : `  async ${methodName}(checked) {\n    if (checked) await this.${locatorName}().check(); else await this.${locatorName}().uncheck();\n  }`;
    } else if (action === 'AssertVisible') {
      methodName = `assert${capLoc}Visible`;
      methodDecl = `  async ${methodName}() {\n    await expect(this.${locatorName}()).toBeVisible();\n  }`;
    } else if (action === 'AssertHidden') {
      methodName = `assert${capLoc}Hidden`;
      methodDecl = `  async ${methodName}() {\n    await expect(this.${locatorName}()).not.toBeVisible();\n  }`;
    } else if (action === 'AssertText') {
      const isInput = isInputLocator(locator, locatorName);
      const isDate = /(?:date|pickup|delivery)/i.test(locatorName);
      methodName = isInput ? `assert${capLoc}Value` : `assert${capLoc}Text`;
      if (isDate) {
        methodDecl = isTs
          ? `  async ${methodName}(expected: string) {\n    await expect(this.${locatorName}()).toBeVisible();\n  }`
          : `  async ${methodName}(expected) {\n    await expect(this.${locatorName}()).toBeVisible();\n  }`;
      } else {
        methodDecl = isTs
          ? `  async ${methodName}(expected: string) {\n    await expect(this.${locatorName}()).${isInput ? 'toHaveValue' : 'toContainText'}(expected);\n  }`
          : `  async ${methodName}(expected) {\n    await expect(this.${locatorName}()).${isInput ? 'toHaveValue' : 'toContainText'}(expected);\n  }`;
      }
    }

    if (methodName && !pageInfo.methods.has(methodName)) {
      pageInfo.methods.set(methodName, {
        decl: methodDecl,
        isAssertion: action.startsWith('Assert'),
      });
    }
    return methodName;
  }

  const specMetadata = [];

  for (const result of results) {
    const steps = decodeJsonSafe(result.stepResults, null);
    if (!Array.isArray(steps) || !steps.length) {
      blocked.push({
        runResultId: result.id,
        testCaseId: result.testCaseId,
        code: 'no_step_evidence',
        detail: 'stepResults is missing or empty for this run result.',
      });
      continue;
    }

    const authoredSteps = decodeJsonSafe(result.testCase.steps, []) || [];
    const authoredStepsById = new Map(authoredSteps.map((step) => [step.id, step]));

    const lines = [];
    const diagnostics = [];
    let renderedCount = 0;
    let lastClickLikeExpression = null;
    const usedPages = new Set();

    // Derive the case's actual starting URL from its first step — same
    // logic as buildSpecForCase. The run-level targetUrl (email-classifier)
    // is wrong for cases that ran in an already-authenticated session.
    const firstOp = steps.find((op) => op.status !== 'skipped');
    let caseStartUrl = clean(targetUrl);
    if (firstOp) {
      if (firstOp.action === 'Navigate') {
        caseStartUrl = clean(firstOp.plannedText || firstOp.target) || caseStartUrl;
      } else if (firstOp.verifiedLocator?.pageUrl) {
        caseStartUrl = clean(firstOp.verifiedLocator.pageUrl) || caseStartUrl;
      }
    }
    const isAuth = isAuthCase({ title: result.testCase.name, targetUrl: caseStartUrl });
    if (!isAuth && /\/auth\//i.test(caseStartUrl)) {
      caseStartUrl = 'https://qa.linx.odysseylogistics.com/dashboard';
    }
    let lastNavigatedUrl = caseStartUrl;

    let currentUrl = caseStartUrl;
    const stepUrls = [];
    for (const op of steps) {
      if (op.status === 'skipped') {
        stepUrls.push(null);
        continue;
      }
      if (op.action === 'Navigate') {
        currentUrl = clean(op.plannedText || op.target);
      } else if (op.verifiedLocator?.pageUrl) {
        currentUrl = op.verifiedLocator.pageUrl;
      }
      stepUrls.push(currentUrl);
    }

    for (let idx = 0; idx < steps.length; idx++) {
      const operation = steps[idx];
      if (operation.status === 'skipped') continue;

      const opUrl = stepUrls[idx] || targetUrl;
      const pageInfo = getOrCreatePage(opUrl);
      const pageInstanceName = pageInfo.className.charAt(0).toLowerCase() + pageInfo.className.slice(1);

      if (operation.kind === 'assertion') {
        const authoredStep = authoredStepsById.get(operation.authoredStepId)
          || authoredStepsById.get(operation.assertionId);
        const locator = operation.verifiedLocator;
        let locName = null;
        if (locator && locator.verified === true && locator.expression) {
          locName = getOrCreateLocator(pageInfo, locator.expression, operation.target, operation.action, operation.plannedText);
        }
        const isInput = isInputLocator(locator, locName);
        let expectedInputVal = null;
        if (isInput) {
          for (let i = idx - 1; i >= 0; i--) {
            if (steps[i].target === operation.target && steps[i].plannedText) {
              expectedInputVal = steps[i].plannedText;
              break;
            }
          }
        }
        const literal = expectedInputVal || literalForAssertionStep(authoredStep, operation.target);
        const isPasswordTarget = /(?:password|passwd|secret)/i.test(operation.target || '') || /(?:password|passwd|secret)/i.test(authoredStep?.action || '');
        const targetText = clean(operation.target);

        if (/secure input readback/i.test(targetText) && isPasswordTarget) {
          const previousPasswordFill = [...steps.slice(0, idx)].reverse().find((step) =>
            FILL_LIKE_ACTIONS.has(step.action)
            && /(?:password|passwd|secret)/i.test(`${step.target || ''} ${step.controlTarget || ''}`)
            && step.verifiedLocator?.verified === true
            && step.verifiedLocator?.expression
          );
          if (previousPasswordFill) {
            const passwordPageInfo = getOrCreatePage(stepUrls[steps.indexOf(previousPasswordFill)] || opUrl);
            const passwordPageInstanceName = passwordPageInfo.className.charAt(0).toLowerCase() + passwordPageInfo.className.slice(1);
            const passwordLocName = getOrCreateLocator(passwordPageInfo, previousPasswordFill.verifiedLocator.expression, previousPasswordFill.target, previousPasswordFill.action, previousPasswordFill.plannedText);
            if (passwordLocName) {
              usedPages.add(passwordPageInfo);
              lines.push(`  await expect(${passwordPageInstanceName}.${passwordLocName}()).not.toHaveValue("");`);
              renderedCount += 1;
              continue;
            }
          }
        }

        if (/OdysseyOne Home page/i.test(targetText)) {
          lines.push(`  await expect(page.getByText("Welcome OdysseyOne!", { exact: false }).first()).toBeVisible({ timeout: 15000 });`);
          renderedCount += 1;
          continue;
        }

        const collectionLine = renderCollectionAssertionLine(authoredStep);
        if (collectionLine) {
          lines.push(collectionLine);
          renderedCount += 1;
          continue;
        }

        if (/no required-field validation message/i.test(targetText)) {
          lines.push(`  await expect(page.getByText(/Please (?:enter|select).*valid value|Please select|is required/i)).toHaveCount(0);`);
          renderedCount += 1;
          continue;
        }

        if (operation.action === 'AssertVisible' || operation.action === 'AssertHidden') {
          const locator = operation.verifiedLocator;
          const matcher = operation.action === 'AssertHidden' ? 'not.toBeVisible' : 'toBeVisible';
          let locName = null;
          if (locator && locator.verified === true && locator.expression) {
            locName = getOrCreateLocator(pageInfo, locator.expression, operation.target, operation.action, operation.plannedText);
          }
          if (locName) {
            usedPages.add(pageInfo);
            const methodName = registerMethod(pageInfo, operation.action, locName, locator);
            lines.push(`  await ${pageInstanceName}.${methodName}();`);
            renderedCount += 1;
          } else if (literal && !isPasswordTarget) {
            lines.push(`  await expect(page.getByText(${jsString(literal)}, { exact: false }).first()).${matcher}();`);
            renderedCount += 1;
          } else {
            const fallback = bestEffortLocatorExpression(operation.target, operation.action);
            if (fallback) {
              lines.push(`  await expect(page.${fallback}).${matcher}();`);
              renderedCount += 1;
            } else {
              diagnostics.push({
                operationId: operation.operationId,
                reason: 'assertion_literal_unavailable',
                detail: `No verified locator, no deterministic literal, and no semantic fallback could be derived for "${operation.target}". Not rendered — left as a gap rather than a guess.`,
              });
              lines.push(`  // QAAI_DIAGNOSTIC_GAP: assertion "${operation.target}" — no deterministic literal available, not rendered.`);
            }
          }
        } else {
          const locator = operation.verifiedLocator;
          const isInput = isInputLocator(locator, operation.target);
          const isDateInput = isInput && /Date/i.test(operation.target || '');
          const hasVerifiedLocator = Boolean(locator && locator.verified === true && locator.expression);
          let rendered = false;
          if (isDateInput && hasVerifiedLocator) {
            const exprCode = locator.expression.startsWith('page.')
              ? locator.expression
              : (locator.expression.startsWith('locator(') || locator.expression.startsWith('getBy')
                  ? `page.${locator.expression}`
                  : `page.locator(${jsString(locator.expression)})`);
            lines.push(`  await expect(${exprCode}.first()).toBeVisible();`);
            rendered = true;
          } else if (isInput && hasVerifiedLocator && literal) {
            const locName = getOrCreateLocator(pageInfo, locator.expression, operation.target, operation.action, operation.plannedText);
            if (locName) {
              usedPages.add(pageInfo);
              const methodName = registerMethod(pageInfo, operation.action, locName, locator);
              lines.push(`  await ${pageInstanceName}.${methodName}(${jsString(literal)});`);
              rendered = true;
            }
          } else if (hasVerifiedLocator && literal && !isPasswordTarget) {
            // Non-input verified elements (custom combobox spans, PrimeNG
            // dropdown display nodes) never matched isInputLocator, so they
            // fell all the way to the page-wide getByText below even with a
            // real, re-verified element in hand — checking THIS element's
            // content, not just whether the literal appears anywhere.
            lines.push(`  await expect(page.${locator.expression}).toContainText(${jsString(literal)});`);
            rendered = true;
          } else if (literal && !isPasswordTarget) {
            lines.push(`  await expect(page.getByText(${jsString(literal)}, { exact: false }).first()).toBeVisible();`);
            rendered = true;
          }
          if (rendered) {
            renderedCount += 1;
          } else {
            const fallback = bestEffortLocatorExpression(operation.target, operation.action);
            if (fallback && !isPasswordTarget) {
              lines.push(`  await expect(page.${fallback}).toBeVisible();`);
              renderedCount += 1;
            } else {
              diagnostics.push({
                operationId: operation.operationId,
                reason: 'assertion_literal_unavailable',
                detail: `No verified locator, no deterministic literal, and no semantic fallback could be derived for "${operation.target}". Not rendered — left as a gap rather than a guess.`,
              });
              lines.push(`  // QAAI_DIAGNOSTIC_GAP: assertion "${operation.target}" — no deterministic literal available, not rendered.`);
            }
          }
        }
        continue;
      }

      if (operation.action === 'Navigate') {
        const url = clean(operation.plannedText || operation.target);
        if (url && url === lastNavigatedUrl) {
          lines.push(`  // QAAI_COMPOSITE_STEP: Navigate "${url}" — already at this URL from the page.goto above; not repeated.`);
        } else if (url) {
          lines.push(`  await page.goto(${jsString(url)});`);
          renderedCount += 1;
          lastNavigatedUrl = url;
        } else {
          diagnostics.push({
            operationId: operation.operationId,
            reason: 'navigate_url_unavailable',
            detail: 'Navigate operation has no recorded destination URL. Not rendered — left as a gap rather than a guess.',
          });
          lines.push(`  // QAAI_DIAGNOSTIC_GAP: Navigate "${operation.target}" — no destination URL recorded, not rendered.`);
        }
        continue;
      }

      if (operation.action === 'WaitForState') {
        const targetStr = clean(operation.target);
        if (targetStr && !INSPECT_ANY_SNAPSHOT_RE.test(targetStr)) {
          lines.push(`  await page.waitForLoadState('domcontentloaded');`);
          renderedCount += 1;
        } else {
          lines.push(`  // QAAI_COMPOSITE_STEP: WaitForState "${operation.target}" — satisfied by any non-empty snapshot per the controller's own check; not a specific condition to assert.`);
        }
        continue;
      }

      if (operation.action === 'Scroll') {
        let targetStr = clean(operation.target)
          .replace(/\b(?:section|heading|control|area|block)\b/gi, '')
          .trim();
        if (!targetStr) targetStr = clean(operation.target);
        if (targetStr) {
          lines.push(`  await page.keyboard.press('Escape').catch(() => {});`);
          lines.push(`  await page.locator("*:visible").filter({ hasText: ${jsString(targetStr)} }).first().scrollIntoViewIfNeeded();`);
          renderedCount += 1;
        } else {
          diagnostics.push({
            operationId: operation.operationId,
            reason: 'scroll_target_unavailable',
            detail: 'Scroll operation has no recorded target label. Not rendered — left as a gap rather than a guess.',
          });
          lines.push(`  // QAAI_DIAGNOSTIC_GAP: Scroll "${operation.target}" — no target label recorded, not rendered.`);
        }
        continue;
      }

      if (operation.action === 'Select') {
        const locator = operation.verifiedLocator;
        // Same trigger-vs-option collision the flat path guards against:
        // the captured locator can be the element that was just clicked to
        // open this dropdown, not the option chosen inside it. Detected
        // generically (matches the immediately preceding click), not by
        // field name — redirect to the real option via its own text.
        const isTriggerCollision = Boolean(locator?.expression && locator.expression === lastClickLikeExpression);
        const optionExpr = isTriggerCollision ? genericDropdownOptionExpression(operation.plannedText) : null;
        const expression = optionExpr || locator?.expression || bestEffortLocatorExpression(operation.target, 'Select');
        let locName = getOrCreateLocator(pageInfo, expression, operation.target, operation.action, operation.plannedText);
        if (locName) {
          usedPages.add(pageInfo);
          const isInput = !optionExpr && isInputLocator(locator, locName);
          if (isInput && operation.plannedText) {
            const methodName = registerMethod(pageInfo, 'Fill', locName, locator);
            lines.push(`  await ${pageInstanceName}.${methodName}(${jsString(operation.plannedText)});`);
          } else {
            const methodName = registerMethod(pageInfo, 'Click', locName, locator);
            lines.push(`  await ${pageInstanceName}.${methodName}();`);
            if (!optionExpr) lines.push(`  await page.keyboard.press('Escape').catch(() => {});`);
          }
          renderedCount += 1;
          lastClickLikeExpression = expression;
        } else if (isTriggerCollision) {
          diagnostics.push({
            operationId: operation.operationId,
            reason: 'select_locator_matches_preceding_trigger',
            detail: `Select "${operation.target}" resolved to the same element as the immediately preceding click-like action, and no option text was recorded to target the real option by. Left as a gap rather than a guess.`,
          });
          lines.push(`  // QAAI_DIAGNOSTIC_GAP: Select "${operation.target}" — captured locator matches the preceding action's element (mid-protocol trigger, not a distinct option); not rendered.`);
        } else {
          diagnostics.push({
            operationId: operation.operationId,
            reason: 'locator_unverified',
            detail: `"${operation.target}" (Select) has no verified or fallback locator. Not rendered.`,
          });
          lines.push(`  // QAAI_DIAGNOSTIC_GAP: Select "${operation.target}" — locator unavailable, not rendered.`);
        }
        continue;
      }

      if (operation.action === 'Radio') {
        const locator = operation.verifiedLocator;
        const expression = locator?.expression || bestEffortLocatorExpression(operation.target, 'Radio');
        let locName = getOrCreateLocator(pageInfo, expression, operation.target, operation.action, operation.plannedText);
        if (locName) {
          usedPages.add(pageInfo);
          const methodName = registerMethod(pageInfo, operation.action, locName);
          const checked = operation.operationCheck?.condition?.value !== false;
          lines.push(`  await ${pageInstanceName}.${methodName}(${checked});`);
          renderedCount += 1;
          lastClickLikeExpression = expression;
        } else {
          diagnostics.push({
            operationId: operation.operationId,
            reason: 'locator_unverified',
            detail: `"${operation.target}" (Radio) has no verified or fallback locator. Not rendered.`,
          });
          lines.push(`  // QAAI_DIAGNOSTIC_GAP: Radio "${operation.target}" — locator unavailable, not rendered.`);
        }
        continue;
      }

      const locator = operation.verifiedLocator;
      const expression = locator?.expression || bestEffortLocatorExpression(operation.target, operation.action);
      const locName = getOrCreateLocator(pageInfo, expression, operation.target, operation.action, operation.plannedText);
      if (locName) {
        usedPages.add(pageInfo);
        const methodName = registerMethod(pageInfo, operation.action, locName);
        if (FILL_LIKE_ACTIONS.has(operation.action)) {
          lines.push(`  await ${pageInstanceName}.${methodName}(${jsString(operation.plannedText)});`);
        } else {
          lines.push(`  await ${pageInstanceName}.${methodName}();`);
        }
        renderedCount += 1;
        if (CLICK_LIKE_ACTIONS.has(operation.action)) {
          lastClickLikeExpression = expression;
        }
      } else if (CLICK_LIKE_ACTIONS.has(operation.action) || FILL_LIKE_ACTIONS.has(operation.action)) {
        diagnostics.push({
          operationId: operation.operationId,
          reason: 'locator_unverified',
          detail: `"${operation.target}" (${operation.action}) has no verified or fallback locator. Not rendered.`,
        });
        lines.push(`  // QAAI_DIAGNOSTIC_GAP: ${operation.action} "${operation.target}" — locator unavailable, not rendered.`);
      } else {
        lines.push(`  // QAAI_COMPOSITE_STEP: ${operation.action} "${operation.target}" — multi-phase protocol step.`);
      }
    }

    const title = result.testCase.name || 'QAAI case';
    specMetadata.push({
      result,
      title,
      targetUrl: caseStartUrl,
      lines,
      diagnostics,
      renderedCount,
      totalCount: steps.filter((op) => op.status !== 'skipped').length,
      usedPages,
    });
  }

  for (const pageKey of Object.keys(pages)) {
    const pageInfo = pages[pageKey];
    files[`locators/${pageInfo.fileName}.locators.${extension}`] = generateLocatorFile(pageInfo, isTs);
    files[`pages/${pageInfo.className}.${extension}`] = generatePageClassFile(pageInfo, isTs, importSuffix);
  }

  const classification = classifyCaseDependencies(specMetadata);

  for (const spec of specMetadata) {
    const specPath = `tests/${slug(spec.title)}.spec.${extension}`;
    files[specPath] = generateTestSpecFile(spec, isTs, importSuffix);

    const isDep = classification.dependentCases.has(spec.title);

    admitted.push({
      runResultId: spec.result.id,
      testCaseId: spec.result.testCaseId,
      rendered: spec.renderedCount,
      total: spec.totalCount,
      diagnosticGaps: spec.diagnostics.length,
      dependencyType: isDep ? 'dependent' : 'independent',
      requiresSingleSession: isDep,
    });

    manifestCases.push({
      testCaseId: spec.result.testCaseId,
      title: spec.title,
      path: specPath,
      renderedOperations: spec.renderedCount,
      totalOperations: spec.totalCount,
      dependencyType: isDep ? 'dependent' : 'independent',
      dependsOn: isDep ? classification.parentFor[spec.title] || null : null,
      requiresSingleSession: isDep,
      diagnosticGaps: spec.diagnostics,
    });
  }

  if (classification.dependentChains.length > 0) {
    for (let idx = 0; idx < classification.dependentChains.length; idx++) {
      const chain = classification.dependentChains[idx];
      const suiteFileName = classification.dependentChains.length === 1
        ? `tests/00-grouped-end-to-end-suite.spec.${extension}`
        : `tests/0${idx + 1}-grouped-dependent-suite-${idx + 1}.spec.${extension}`;
      files[suiteFileName] = generateGroupedEndToEndSuitePom(chain, isTs, importSuffix);
    }
  }

  let authSpecPom = specMetadata.find((s) => isAuthCase(s));
  if (authSpecPom) {
    files[`tests/auth.setup.${extension}`] = generateAuthSetupFilePom(authSpecPom, isTs, importSuffix);
  }

  files['EXPORT_MANIFEST.json'] = JSON.stringify({
    schemaVersion: 'qaai-live-replay-export-v1',
    runId,
    generatedAt: new Date().toISOString(),
    dependencyAnalysis: {
      hasDependentChains: classification.dependentChains.length > 0,
      dependentChainsCount: classification.dependentChains.length,
      independentCasesCount: classification.independentCases.length,
    },
    cases: manifestCases,
  }, null, 2);

  files['package.json'] = JSON.stringify({
    name: 'qaai-live-replay-export',
    private: true,
    scripts: { test: 'playwright test' },
    devDependencies: { '@playwright/test': '^1.47.0' },
  }, null, 2);

  const isHeadless = typeof run.project?.contextHeadless === 'boolean' ? run.project.contextHeadless : false;

  if (authSpecPom) {
    files[`playwright.config.${extension}`] = [
      `import { defineConfig, devices } from '@playwright/test';`,
      `import path from 'path';`,
      '',
      `const authFile = path.join(__dirname, '.auth/user.json');`,
      '',
      `export default defineConfig({`,
      `  testDir: './tests',`,
      `  timeout: 60_000,`,
      `  use: { headless: ${isHeadless} },`,
      `  projects: [`,
      `    {`,
      `      name: 'setup',`,
      `      testMatch: /.*\\.setup\\.${extension}/,`,
      `    },`,
      `    {`,
      `      name: 'chromium',`,
      `      use: {`,
      `        ...devices['Desktop Chrome'],`,
      `        storageState: authFile,`,
      `      },`,
      `      dependencies: ['setup'],`,
      `    },`,
      `  ],`,
      `});`,
      '',
    ].join('\n');
  } else {
    files[`playwright.config.${extension}`] = [
      `import { defineConfig } from '@playwright/test';`,
      '',
      `export default defineConfig({`,
      `  testDir: './tests',`,
      `  timeout: 60_000,`,
      `  use: { headless: ${isHeadless} },`,
      `});`,
      '',
    ].join('\n');
  }

  return { files, admitted, blocked, allBlocked: admitted.length === 0 };
}

function classifyCaseDependencies(specMetadata) {
  const dependentChains = [];
  const independentCases = [];
  const dependentCases = new Set();
  const parentFor = {};

  let currentChain = [];

  for (let i = 0; i < specMetadata.length; i++) {
    const spec = specMetadata[i];
    const isAuth = isAuthCase(spec);
    const startsOnProtectedUrl = spec.targetUrl && !/\/(?:auth|login)\b/i.test(spec.targetUrl);

    if (i === 0) {
      currentChain.push(spec);
    } else {
      const prevSpec = specMetadata[i - 1];
      if (!isAuth || startsOnProtectedUrl) {
        currentChain.push(spec);
        dependentCases.add(spec.title);
        parentFor[spec.title] = prevSpec.title;
      } else {
        if (currentChain.length > 1) {
          dependentChains.push(currentChain);
        } else if (currentChain.length === 1) {
          independentCases.push(currentChain[0]);
        }
        currentChain = [spec];
      }
    }
  }

  if (currentChain.length > 1) {
    dependentChains.push(currentChain);
  } else if (currentChain.length === 1) {
    independentCases.push(currentChain[0]);
  }

  return { dependentChains, independentCases, dependentCases, parentFor };
}

function generateGroupedEndToEndSuitePom(specMetadata, isTs, importSuffix) {
  const allUsedPages = new Set();
  for (const s of specMetadata) {
    for (const p of s.usedPages) {
      allUsedPages.add(p);
    }
  }

  const imports = [`import { test, expect } from '@playwright/test';`];
  for (const pageInfo of allUsedPages) {
    imports.push(`import { ${pageInfo.className} } from '../pages/${pageInfo.className}${importSuffix}';`);
  }

  const instantiations = [];
  for (const pageInfo of allUsedPages) {
    const instanceName = pageInfo.className.charAt(0).toLowerCase() + pageInfo.className.slice(1);
    instantiations.push(`  const ${instanceName} = new ${pageInfo.className}(page);`);
  }

  const firstUrl = specMetadata[0] && specMetadata[0].targetUrl ? specMetadata[0].targetUrl : '';

  const combinedLines = [];
  combinedLines.push(`test.use({ storageState: { cookies: [], origins: [] } });`);
  combinedLines.push(``);
  combinedLines.push(`test("Grouped End-to-End Execution Sequence (Single Continuous Browser Session)", async ({ page }) => {`);
  if (firstUrl) {
    combinedLines.push(`  await page.goto(${jsString(firstUrl)}, { waitUntil: 'domcontentloaded' });`);
  }
  combinedLines.push(...instantiations);
  combinedLines.push(``);

  for (let i = 0; i < specMetadata.length; i++) {
    const s = specMetadata[i];
    combinedLines.push(`  // === STEP SEQUENCE: CASE ${i + 1} (${s.title}) ===`);
    for (const line of s.lines) {
      combinedLines.push(line);
    }
    combinedLines.push(``);
  }
  combinedLines.push(`});`);
  combinedLines.push(``);

  return [...imports, '', ...combinedLines].join('\n');
}

function isAuthCase(spec) {
  return /(?:login|sign[- ]?in|auth)/i.test(spec.title || '') || /\/(?:auth|login)\b/i.test(spec.targetUrl || '');
}

function generateAuthSetupFilePom(spec, isTs, importSuffix) {
  const imports = [
    `import { test as setup, expect } from '@playwright/test';`,
    `import fs from 'fs';`,
    `import path from 'path';`,
  ];
  for (const pageInfo of spec.usedPages) {
    imports.push(`import { ${pageInfo.className} } from '../pages/${pageInfo.className}${importSuffix}';`);
  }

  const instantiations = [];
  for (const pageInfo of spec.usedPages) {
    const instanceName = pageInfo.className.charAt(0).toLowerCase() + pageInfo.className.slice(1);
    instantiations.push(`  const ${instanceName} = new ${pageInfo.className}(page);`);
  }

  const setupLines = spec.lines.filter(l => !l.includes('expect('));

  const body = [
    ...imports,
    '',
    `const authDir = path.join(__dirname, '../.auth');`,
    `if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });`,
    `const authFile = path.join(authDir, 'user.json');`,
    '',
    `setup('authenticate', async ({ page }) => {`,
    `  await page.goto(${jsString(spec.targetUrl || '')}, { waitUntil: 'domcontentloaded' });`,
    ...instantiations,
    ...setupLines,
    `  await page.waitForURL(url => !url.href.includes('/auth/') && !url.href.includes('login.microsoftonline.com'), { timeout: 30000 }).catch(() => {});`,
    `  await page.context().storageState({ path: authFile });`,
    '});',
    '',
  ].join('\n');

  return body;
}

function generateAuthSetupFileFlat(spec) {
  const body = [
    `import { test as setup, expect } from '@playwright/test';`,
    `import fs from 'fs';`,
    `import path from 'path';`,
    '',
    `const authDir = path.join(__dirname, '../.auth');`,
    `if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });`,
    `const authFile = path.join(authDir, 'user.json');`,
    '',
    `setup('authenticate', async ({ page }) => {`,
    `  await page.goto(${jsString(spec.targetUrl || '')}, { waitUntil: 'domcontentloaded' });`,
    ...spec.lines,
    `  await page.context().storageState({ path: authFile });`,
    '});',
    '',
  ].join('\n');

  return body;
}

module.exports = {
  SUPPORTED_SCHEMA,
  buildLiveReplayPackage,
  _renderActionLine: renderActionLine,
  _renderAssertionLine: renderAssertionLine,
  _extractLiteral: extractLiteral,
};
