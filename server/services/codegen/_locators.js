'use strict';

const actionLocatorResolver = require('../actionLocatorResolver');

/**
 * Deterministic locator replay (P2 — architectural review 2026-06-02).
 *
 * THE PROBLEM
 * The MCP run resolves every click/fill/select against the LIVE DOM and records
 * the winning locator into KnowledgeBaseLocator (role, accessibleName, a
 * Playwright selector expression, healthScore, occurrences). Codegen then THREW
 * THAT AWAY and asked the LLM to re-derive a static locator from a textual
 * description of the trail — a second guess against a DOM it cannot see. When an
 * app's locators are non-obvious the guess diverges from what actually worked,
 * so a case that PASSED in the run exports to a spec that fails on
 * locator-not-found / strict-mode.
 *
 * THE FIX
 * Pass the resolved KnowledgeBaseLocator payload straight into codegen and bind
 * each recorded action to the locator the run ACTUALLY used:
 *   Primary  : role + accessibleName  → getByRole(role, { name })   (Playwright)
 *   Fallback : the recorded selector expression, or a name-grounded By (Selenium)
 * The model formats the file; it never invents DOM targeting again.
 *
 * Pure module — no prisma, no fs. The conductor fetches the KB rows and the
 * element-label function and hands both in (so this stays unit-testable).
 */

// A KB row is considered too unhealthy to replay (the healer keeps failing it).
// Below this we DON'T bind it — let the model derive, same threshold the
// Conductor quarantines at (CLAUDE.md: healthScore < 30).
const MIN_HEALTH = 30;

/** Lowercased, trimmed key for fuzzy element-label matching. */
function norm(s) {
  return String(s == null ? '' : s).toLowerCase().trim().replace(/\s+/g, ' ');
}

function pageKey(s) {
  if (!s) return '';
  return String(s).split(/[?#]/)[0].trim().toLowerCase();
}

/**
 * Returns true when a string looks like an agent narration / element description
 * rather than actual visible DOM text. These strings must NOT be passed to
 * getByText() — the text they describe does not exist on screen.
 *
 * Indicators: length > 40 chars; contains parenthetical context "(top right)",
 * "(pencil)"; contains "for <word>" like "for emp0_0"; contains words that only
 * appear in descriptions (button, icon, menu, row, container, toggle, field,
 * panel, section, dropdown, checkbox, cell).
 */
function looksLikeDescription(s) {
  if (!s || typeof s !== 'string') return false;
  if (s.length > 40) return true;
  return /\bfor\s+\S|\([^)]+\)|\b(button|icon|menu|row|container|toggle|field|panel|section|dropdown|checkbox|cell)\b/i.test(s);
}

/**
 * Build a Playwright locator EXPRESSION (no `page.` prefix — the prompt adds
 * it) from a resolved-locator payload. Prefers role+name (the stable form the
 * review mandated); falls back to the recorded selector if it already looks
 * like a getBy* / locator() expression; returns null when no reliable expression
 * can be built (caller marks action as kbMiss so the model's keyword-extraction
 * guidance handles it instead of emitting a broken getByText(description)).
 */
function primaryDomFacts(domFacts) {
  if (!domFacts || typeof domFacts !== 'object') return null;
  const target = domFacts.target && typeof domFacts.target === 'object' ? domFacts.target : null;
  const facts = target || domFacts;
  if (facts.role || facts.selector || facts.accessibleName || facts.text || facts.placeholder) return facts;
  return null;
}

function playwrightExpression({ role, accessibleName, selector }) {
  if (role && accessibleName) {
    // Normalise whitespace and decide whether a regex match is safer.
    const raw = String(accessibleName || '');
    const name = raw.replace(/\s+/g, ' ').trim();
    const needsRegex = /\s/.test(name) || /[^\w\s\-]/.test(name) || name.toLowerCase() !== raw.toLowerCase().trim();
    if (needsRegex) {
      const esc = String(name).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      return `getByRole(${JSON.stringify(role)}, { name: /${esc}/i })`;
    }
    return `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`;
  }
  // KB.selector is stored as a Playwright expression already (recordSuccessfulLocator).
  // Guard: if the selector is a getByText(description) the conductor stored as a fallback
  // from its narration label (not visible text), don't use it — it's guaranteed to timeout.
  if (selector && /^(getBy[A-Z]|locator\(|frameLocator\(|getByRole|getByText|getByLabel|getByPlaceholder|getByTestId)/.test(selector)) {
    if (/^getByText\(/.test(selector)) {
      // Extract the text argument and check if it looks like a description.
      const m = selector.match(/^getByText\((['"])(.*?)\1/s);
      const textArg = m ? m[2] : selector;
      if (looksLikeDescription(textArg)) return null; // fall through to kbMiss
    }
    return selector;
  }
  // Only use accessibleName as visible text when it actually IS short visible text.
  // Long descriptions / narrations ("Edit (pencil) button for emp0_0 ESS user row")
  // must return null so the caller marks the action kbMiss and the model applies its
  // keyword-extraction rule instead of emitting getByText(<whole sentence>).
  if (accessibleName && !looksLikeDescription(accessibleName)) {
    return `getByText(${JSON.stringify(accessibleName)}, { exact: false })`;
  }
  if (selector) return `locator(${JSON.stringify(selector)})`;
  return null;
}

function decodeJsStringLiteral(s) {
  if (!s || typeof s !== 'string') return '';
  try { return JSON.parse(s); } catch (_) { return s.replace(/\\(["'\\/bfnrt])/g, '$1'); }
}

function quoteJava(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

function xpathLiteral(s) {
  const value = String(s == null ? '' : s);
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `concat(${value.split('"').map((part) => `"${part}"`).join(', "\\\"", ')})`;
}

function xpathForAccessibleName(name, role) {
  const n = xpathLiteral(name);
  const textPred = [
    `normalize-space(.)=${n}`,
    `@aria-label=${n}`,
    `@name=${n}`,
    `@value=${n}`,
    `@placeholder=${n}`,
    `@title=${n}`,
  ].join(' or ');
  const rolePredicates = {
    button: `self::button or @role="button" or (self::input and (@type="button" or @type="submit" or @type="reset"))`,
    link: `self::a or @role="link"`,
    textbox: `self::input or self::textarea or @role="textbox"`,
    searchbox: `self::input or @role="searchbox"`,
    combobox: `self::select or @role="combobox"`,
    checkbox: `(self::input and @type="checkbox") or @role="checkbox"`,
    radio: `(self::input and @type="radio") or @role="radio"`,
    option: `self::option or @role="option"`,
    tab: `@role="tab"`,
  };
  const rolePred = rolePredicates[String(role || '').toLowerCase()];
  return `//*[${textPred}${rolePred ? `][${rolePred}` : ''}]`;
}

function firstStringArg(selector, fnName) {
  const source = String(selector || '');
  const start = source.indexOf(`${fnName}(`);
  if (start < 0) return '';
  let i = start + fnName.length + 1;
  while (/\s/.test(source[i] || '')) i++;
  const quote = source[i];
  if (quote !== '"' && quote !== "'") return '';
  i++;
  let body = '';
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      body += ch + source[i + 1];
      i++;
      continue;
    }
    if (ch === quote) return decodeJsStringLiteral(body);
    body += ch;
  }
  return '';
}

function javaFromPlaywrightSelector(selector, role, accessibleName) {
  const s = String(selector || '').trim();
  if (!s) return null;
  if (/frameLocator\s*\(/.test(s)) return null;
  const cssArg = firstStringArg(s, 'locator');
  if (cssArg) {
    if (/^(xpath=|\/\/|\.\/\/)/.test(cssArg)) {
      return `By.xpath(${quoteJava(cssArg.replace(/^xpath=/, ''))})`;
    }
    return `By.cssSelector(${quoteJava(cssArg)})`;
  }
  const testId = firstStringArg(s, 'getByTestId');
  if (testId) {
    const escaped = String(testId).replace(/"/g, '\\"');
    return `By.cssSelector(${quoteJava(`[data-testid="${escaped}"], [data-test="${escaped}"], [data-qa="${escaped}"]`)})`;
  }
  const placeholder = firstStringArg(s, 'getByPlaceholder');
  if (placeholder) return `By.cssSelector(${quoteJava(`[placeholder="${String(placeholder).replace(/"/g, '\\"')}"]`)})`;
  const text = firstStringArg(s, 'getByText');
  if (text) return `By.xpath(${quoteJava(`//*[contains(normalize-space(.), ${xpathLiteral(text)})]`)})`;
  const roleMatch = s.match(/getByRole\(\s*(['"])(.*?)\1\s*,\s*\{[\s\S]*?name\s*:\s*(['"])(.*?)\3/);
  if (roleMatch) return `By.xpath(${quoteJava(xpathForAccessibleName(decodeJsStringLiteral(roleMatch[4]), decodeJsStringLiteral(roleMatch[2])))})`;
  if (role && accessibleName) return `By.xpath(${quoteJava(xpathForAccessibleName(accessibleName, role))})`;
  return null;
}

/**
 * Build a Selenium `By` from a resolved-locator payload. Selenium has no
 * getByRole, so translate the recorded Playwright selector when possible and
 * fall back to a role/name-aware XPath.
 */
function javaExpression({ role, accessibleName, selector }) {
  const fromSelector = javaFromPlaywrightSelector(selector, role, accessibleName);
  if (fromSelector) return fromSelector;
  if (!accessibleName) return null;
  const n = accessibleName;
  const xpath = xpathForAccessibleName(n, role);
  const roleHint = role ? ` /* role=${role} */` : '';
  return `By.xpath(${quoteJava(xpath)})${roleHint}`;
}

/**
 * Pick the best KB row for an element label from all the project's rows.
 * Exact (normalised) match first, then substring either direction; among
 * candidates prefer the most-seen, then highest health. Quarantined rows are
 * skipped so we never replay a locator the healer can't make work.
 */
function bestRowFor(label, byElement, pageUrl) {
  const key = norm(label);
  if (!key) return null;
  const wantedPage = pageKey(pageUrl);
  let cands = byElement.get(key);
  if (!cands || !cands.length) {
    // Substring fallback: the agent's label may be a fragment of the KB element
    // (or vice-versa) — e.g. "Search" vs "Search button".
    // Guard: only attempt substring matching when both strings are long enough
    // to be distinctive. Short words like "ok", "go", "id" match far too broadly
    // across unrelated elements and return the wrong locator.
    cands = [];
    if (key.length >= 4) {
      for (const [el, rows] of byElement.entries()) {
        if (el.length >= 4 && (el.includes(key) || key.includes(el))) cands.push(...rows);
      }
    }
  }
  const healthy = cands.filter((r) => (r.healthScore == null ? 100 : r.healthScore) >= MIN_HEALTH);
  if (!healthy.length) return null;
  const pageRank = (r) => {
    if (!wantedPage) return 0;
    const rowPage = pageKey(r.pageUrl);
    if (rowPage === wantedPage) return 3;
    if (!rowPage) return 1; // legacy/generic locator row
    return 0;
  };
  const pageAware = wantedPage ? healthy.filter((r) => pageRank(r) > 0) : healthy;
  const ranked = pageAware.length ? pageAware : healthy;
  ranked.sort((a, b) =>
    pageRank(b) - pageRank(a) ||
    (b.occurrences || 0) - (a.occurrences || 0) ||
    ((b.healthScore == null ? 100 : b.healthScore) - (a.healthScore == null ? 100 : a.healthScore)));
  return ranked[0];
}

/**
 * Enrich a run's action list with the locator each action actually resolved to,
 * and return a deduped manifest for the prompt.
 *
 * @param {object}   p
 * @param {Array}    p.actions   actionPlan.actions ({ tool, args, narration }[])
 * @param {Array}    p.kbRows    KnowledgeBaseLocator rows for the project
 * @param {Function} p.labelOf   (action) => element label (conductor's elementLabelFromArgs)
 * @param {string}   p.lang      'java' for Selenium, else Playwright
 * @returns {{ actions: Array, manifest: Array }}
 */
function buildManifest({ actions, kbRows, labelOf, lang = 'ts' }) {
  const safeActions = Array.isArray(actions) ? actions : [];
  const rows = Array.isArray(kbRows) ? kbRows : [];
  const isJava = lang === 'java';

  // Index KB rows by normalised element label (many rows per element across pages).
  const byElement = new Map();
  for (const r of rows) {
    const k = norm(r.element);
    if (!k) continue;
    if (!byElement.has(k)) byElement.set(k, []);
    byElement.get(k).push(r);
  }

  const manifest = [];
  const seen = new Set();
  const enriched = safeActions.map((a) => {
    // Action-time locator first: the conductor resolved this while the exact
    // target element was still present in the live browser. This is stronger
    // evidence than both inline domFacts and the historical KB row.
    const actionLocator = actionLocatorResolver.primaryActionLocator(a.actionLocator);
    if (actionLocator) {
      const targetFacts = actionLocator.targetFacts && typeof actionLocator.targetFacts === 'object'
        ? actionLocator.targetFacts
        : {};
      const actionName = targetFacts.accessibleName || targetFacts.text || targetFacts.placeholder || actionLocator.elementLabel || null;
      const playwrightExpr = actionLocator.frameworkExpressions?.playwright || actionLocator.expression || null;
      const expression = isJava
        ? (actionLocator.frameworkExpressions?.selenium || javaFromPlaywrightSelector(playwrightExpr, targetFacts.role, actionName))
        : playwrightExpr;
      if (expression) {
        let inlineLabel = null;
        try { inlineLabel = labelOf ? labelOf(a) : null; } catch (_) {}
        const locator = {
          intent: inlineLabel || actionLocator.elementLabel || a.narration || a.tool,
          role: targetFacts.role || null,
          name: actionName,
          pageUrl: a.pageUrl || actionLocator.pageUrl || null,
          expression,
          strategy: actionLocator.strategy || 'actionLocator',
          source: 'actionLocator',
        };
        const dedupeKey = `${norm(locator.intent || '')}|${expression}`;
        if (!seen.has(dedupeKey)) { seen.add(dedupeKey); manifest.push(locator); }
        return { ...a, locator };
      }
    }

    // ── Phase B: Inline domFacts first (v2 trace) ────────────────────────
    // If the action carries DOM evidence captured at click-time (role, accessibleName,
    // selector), use it directly instead of falling back to KB narration matching.
    // This eliminates kbMiss for every v2-trace action that resolved a real element.
    const facts = primaryDomFacts(a.domFacts);
    if (facts) {
      const factName = facts.accessibleName || facts.text || facts.placeholder || null;
      const inlineExpr = isJava
        ? javaExpression({ role: facts.role, accessibleName: factName, selector: facts.selector })
        : playwrightExpression({ role: facts.role, accessibleName: factName, selector: facts.selector });
      if (inlineExpr) {
        let inlineLabel = null;
        try { inlineLabel = labelOf ? labelOf(a) : null; } catch (_) {}
        const locator = {
          intent: inlineLabel || a.narration || a.tool,
          role: facts.role || null,
          name: factName,
          pageUrl: a.pageUrl || null,
          expression: inlineExpr,
          strategy: facts.strategy || 'inline',
          source: 'inline',
        };
        const dedupeKey = `${norm(inlineLabel || '')}|${inlineExpr}`;
        if (!seen.has(dedupeKey)) { seen.add(dedupeKey); manifest.push(locator); }
        return { ...a, domFacts: facts, locator };
      }
      // inlineExpr was null (descriptor text in domFacts) — fall through to KB
    }

    // ── KB fallback (legacy traces or domFacts that couldn't produce an expression) ──
    let label = null;
    try { label = labelOf ? labelOf(a) : null; } catch (_) { label = null; }
    if (!label) return a;
    const row = bestRowFor(label, byElement, a.pageUrl);
    if (!row) return { ...a, kbMiss: true };
    const expression = isJava
      ? javaExpression({ role: row.role, accessibleName: row.accessibleName, selector: row.selector })
      : playwrightExpression({ role: row.role, accessibleName: row.accessibleName, selector: row.selector });
    // KB row found but no reliable expression could be built (e.g. description-only
    // accessibleName, no role, no stored selector). Mark kbMiss so the model uses its
    // keyword-extraction rule rather than silently getting no locator at all.
    if (!expression) return { ...a, kbMiss: true };
    const locator = {
      intent: label,
      role: row.role || null,
      name: row.accessibleName || null,
      pageUrl: row.pageUrl || null,
      expression,
      strategy: row.strategy || (row.role ? 'role' : 'text'),
      source: 'kb',
    };
    const dedupeKey = `${norm(label)}|${expression}`;
    if (!seen.has(dedupeKey)) { seen.add(dedupeKey); manifest.push(locator); }
    return { ...a, locator };
  });

  const kbMissLabels = enriched.filter((a) => a.kbMiss).map((a) => {
    let label = null;
    try { label = labelOf ? labelOf(a) : null; } catch (_) {}
    return label || '(unknown)';
  });
  return { actions: enriched, manifest, kbMissLabels };
}

/** Human-readable digest of the manifest for the user message. */
function manifestDigest(manifest) {
  if (!Array.isArray(manifest) || !manifest.length) return null;
  return manifest.map((m, i) => `${i + 1}. "${m.intent}" → ${m.expression}`).join('\n');
}

/**
 * The locator-replay directive injected into the system prompt. Tells the model
 * the locators are ground truth captured at run time and must be used verbatim.
 */
function locatorPromptBlock({ lang = 'ts' } = {}) {
  if (lang === 'java') {
    return `## LOCATOR REPLAY — use the locators the run already resolved (do NOT re-invent)
Each entry in actionPlan.actions may carry a "locator" object: { intent, role, name, expression }.
"expression" is a Selenium \`By\` the engine built from the accessible name/role it resolved against the LIVE DOM at run time — the target that actually succeeded. It is GROUND TRUTH.
- When you interact with or assert on that element, locate it with the PROVIDED \`By\` expression VERBATIM (driver.findElement(<expression>) or a WebDriverWait on it). Strip any /* role=... */ comment if your line can't carry it.
- Do NOT invent, "improve", or substitute a By when one is already provided — a blind guess against a DOM you cannot see is exactly what this replaces.
- Verified-locator priority is absolute: only derive a locator when the action has NO locator expression or is annotated with "kbMiss": true.
- For a kbMiss, KEEP the complete action, its Page Object method, dependent steps, and assertions. Derive exactly ONE best-effort semantic \`By\` from the available targetFacts/domFacts, structured action arguments, and the literal control name in the narration. Prefer, in order: stable id/name/data-testid attributes; an explicit label/placeholder; role plus accessible name; then exact visible control text. Never use the entire narration sentence as visible text and never fabricate a DOM attribute value.
- Put this exact warning immediately above the guessed \`By\` field or the inline guessed locator statement:
    // QAAI_GUESSED_LOCATOR: live DOM evidence was unavailable; replace this guessed locator with a reliable DOM locator if needed.
- A locator-only gap is NOT a reason to emit an unresolved-locator marker, throw, disable/skip the test, hold output readiness, omit a method, or drop this or any dependent step. The generated source must remain complete; only the warned locator may need later replacement.
- Emit one locator, not a chain of guesses. Do not use positional XPath/CSS (including nth-child/nth-of-type) or a generic structural target merely to make the code compile.`;
  }
  return `## LOCATOR REPLAY — use the locators the run already resolved (do NOT re-invent)
Each entry in actionPlan.actions may carry a "locator" object: { intent, role, name, expression }.
"expression" is the EXACT Playwright locator the engine resolved against the LIVE DOM at run time — the target that actually succeeded. It is GROUND TRUTH, captured from the real page, not a description.
- When you interact with or assert on that element, USE THE PROVIDED expression VERBATIM, prefixed with the page handle: \`page.<expression>\` (or \`this.page.<expression>\` inside a Page Object). Example: a locator with expression \`getByRole("button", { name: "Search" })\` becomes \`page.getByRole('button', { name: 'Search' })\`. In a Page Object, ASSIGN the locator field from this same expression in the constructor.
- Do NOT "improve", re-derive, or substitute a locator that is already provided. Your guess against a DOM you cannot see is exactly the failure mode this replaces.
- Verified-locator priority is absolute: only derive a locator when the action has NO locator expression or is annotated with "kbMiss": true.
- For a kbMiss, KEEP the complete action, its Page Object method, dependent steps, and assertions. Derive exactly ONE best-effort semantic locator from the available targetFacts/domFacts, structured action arguments, and the literal control name in the narration. Prefer, in order: getByTestId; getByLabel only when an associated label is explicit; getByPlaceholder or a stable name attribute; getByRole with a supported accessible name; then getByText with exact literal visible text. Never use the entire narration sentence as visible text and never fabricate an ARIA role or DOM attribute value.
- Put this exact warning immediately above the guessed Page Object locator assignment/declaration, or immediately above the inline locator statement in a flat/BDD spec:
    // QAAI_GUESSED_LOCATOR: live DOM evidence was unavailable; replace this guessed locator with a reliable DOM locator if needed.
- A locator-only gap is NOT a reason to emit an unresolved-locator marker, throw, use test.skip/test.fixme, hold output readiness, omit a method, or drop this or any dependent step. The generated source must remain complete; only the warned locator may need later replacement.
- Never guess structural roles such as 'heading', 'listitem', or 'generic' for kbMiss actions. Those roles are page scaffolding unless the action facts explicitly identify that role.
- This rule applies EVERYWHERE you target that element — page-object fields, wait helpers (waitFor), actions, AND assertions — not just the final assertion. Do not add a speculative "waitForPageLoad" that waits on a guessed-role locator; web-first assertions already auto-wait.
- This does NOT change WHAT you assert — the VERDICT FIDELITY rules still govern the assertions. Locator replay only fixes HOW you target elements.
- For the single guessed locator, NEVER emit .first(), .nth(), or .last(); never emit :nth-child() or :nth-of-type(); and never use .or() to merge weak guesses. Choose the strongest one semantic locator supported by the action evidence.`;

}

/**
 * Vector-similarity fallback for KB locator lookup.
 *
 * Called when `bestRowFor()` returns null (the exact/substring search found
 * nothing) and a Gemini embedding key is available. Embeds the query label
 * and all healthy KB element labels, then returns the row whose label has the
 * highest cosine similarity to the query, provided it exceeds KB_SIM_THRESHOLD.
 *
 * Why this matters: between two runs of the same project the app may rename
 * a UI element — "Add to Cart" → "Add Item". The substring search misses it
 * (different words), but the embedding similarity scores ~0.86 and the correct
 * locator is recovered.
 *
 * Returns null when:
 *   - embedLib is not provided (Gemini key unavailable)
 *   - the nearest match is below the threshold
 *   - all KB rows are unhealthy
 *
 * @param {string}   label     element label to look up
 * @param {Array}    kbRows    KnowledgeBaseLocator rows for the project
 * @param {Function} embedFn   (text: string) => Promise<Float32Array|null>
 * @returns {Promise<{row: object, similarity: number}|null>}
 */
const KB_SIM_THRESHOLD = 0.80;

// Word-overlap pre-filter for KB rows: given a query label, rank KB rows by
// how many words they share with the query (case-insensitive, ≥3 chars) and
// return the top N candidates. This limits embedding calls to O(N) per lookup
// instead of O(all KB rows) — rate-limit friendly and cache-friendly.
const KB_OVERLAP_TOP = 10;

function _kbCandidates(label, kbRows) {
  const qWords = new Set(
    label.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3)
  );
  if (!qWords.size) return kbRows.slice(0, KB_OVERLAP_TOP); // fallback: first N rows
  const scored = kbRows
    .filter((r) => r && r.element && (r.healthScore == null ? 100 : r.healthScore) >= MIN_HEALTH)
    .map((r) => {
      const rWords = r.element.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
      const overlap = rWords.filter((w) => w.length >= 3 && qWords.has(w)).length;
      return { row: r, overlap };
    });
  // Sort by overlap DESC; take the top KB_OVERLAP_TOP, but only rows with ≥1 overlap
  const withOverlap = scored.filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, KB_OVERLAP_TOP);
  // If no word overlap, try the top rows by health+occurrences — they're
  // the most-seen elements and may still be a semantic match
  if (!withOverlap.length) {
    return kbRows
      .filter((r) => r && r.element && (r.healthScore == null ? 100 : r.healthScore) >= MIN_HEALTH)
      .sort((a, b) => ((b.occurrences || 0) - (a.occurrences || 0)) || ((b.healthScore || 100) - (a.healthScore || 100)))
      .slice(0, KB_OVERLAP_TOP);
  }
  return withOverlap.map((x) => x.row);
}

async function bestRowForSemantic(label, kbRows, embedFn) {
  if (!label || !Array.isArray(kbRows) || !kbRows.length || typeof embedFn !== 'function') return null;

  const candidates = _kbCandidates(label, kbRows);
  if (!candidates.length) return null;

  const queryVec = await embedFn(label);
  if (!queryVec) return null;

  const { cosineSim } = require('../../lib/similarity/embed');

  // Embed candidates in parallel (all go through the LRU cache — same KB
  // elements appear across multiple codegen runs of the same project, so
  // after the first run these are all cache hits).
  const embedResults = await Promise.all(candidates.map((r) => embedFn(r.element)));

  let bestRow = null;
  let bestSim = 0;
  for (let i = 0; i < candidates.length; i++) {
    const rowVec = embedResults[i];
    if (!rowVec) continue;
    const sim = cosineSim(queryVec, rowVec);
    if (sim > bestSim) { bestSim = sim; bestRow = candidates[i]; }
  }

  if (bestSim < KB_SIM_THRESHOLD || !bestRow) return null;
  return { row: bestRow, similarity: bestSim };
}

module.exports = {
  MIN_HEALTH,
  KB_SIM_THRESHOLD,
  playwrightExpression,
  primaryDomFacts,
  javaExpression,
  javaFromPlaywrightSelector,
  buildManifest,
  manifestDigest,
  locatorPromptBlock,
  bestRowForSemantic,
};
