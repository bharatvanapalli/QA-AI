'use strict';

/**
 * Deterministic safety-net for generated spec/page source. The LLM occasionally
 * emits a small set of mechanical syntax mistakes that make the file fail to
 * PARSE — which means the exported suite won't even collect, regardless of how
 * correct the logic is. These are not judgement calls; they are exact, safe
 * rewrites. Applied at write time (conductor) so EVERY emitted file is repaired
 * before it lands, on top of the prompt rules that try to prevent them.
 *
 * Rule 1 — URL matcher fed a path as a regex literal.
 *   await expect(page).toHaveURL(//pim/viewEmployeeList/, { timeout: 10_000 });
 *   await expect(page).toHaveURL(/pim/viewEmployeeList/, { ... });
 *   A path contains '/', which is the regex delimiter: a leading '//' starts a
 *   line comment (eats the line), and an internal '/' ends the regex early so
 *   the trailing text is read as invalid flags ("Invalid regular expression
 *   flag"). Either way the file won't PARSE. The robust, semantics-preserving
 *   fix is to convert the literal to new RegExp('<path>') — inside a string the
 *   '/' is an ordinary character, so it matches the same substring without any
 *   delimiter hazard. Properly-flagged regexes (e.g. /dashboard/i) don't match
 *   this pattern and are left untouched.
 */

/**
 * Returns true when a string looks like an agent narration / element description
 * rather than actual visible DOM text. Mirrors the check in _locators.js so the
 * sanitizer and the KB layer agree on what "looks like a description" means.
 *
 * Indicators: length > 40 chars; contains a parenthetical context "(top right)";
 * contains descriptor words: button, icon, menu, row, container, toggle, field,
 * panel, section, dropdown, checkbox, cell (standalone — these appear in
 * narrations like "Edit button for emp0_0 row" but rarely as visible DOM text).
 */
function looksLikeDescriptorText(s) {
  if (!s || typeof s !== 'string') return false;
  // Lowered from 40 → 25: catches "Change Password toggle container" (32 chars),
  // "Edit button for emp row" (23 chars), etc. Short UI labels ("Products", "Save",
  // "Sign in") are all well under 25 and are left untouched.
  if (s.length > 25) return true;
  if (/\([^)]+\)/.test(s)) return true; // "(top right)", "(pencil icon)", etc.
  // "button for X", "row in Y", "menu of Z" — preposition confirms narration context
  if (/\b(button|icon|menu|row|container|toggle|field|panel|section|dropdown|checkbox|cell)\s+(?:for|in|of)\b/i.test(s)) return true;
  // Layout/structural slot words that ONLY appear in agent narration, never in visible DOM text:
  // "trigger", "topbar", "wrapper", "bounding" — a single occurrence is conclusive.
  if (/\b(?:trigger|topbar|wrapper|bounding|slot|overlay|skeleton|backdrop)\b/i.test(s)) return true;
  // standalone descriptor words that strongly imply narration when combined e.g.
  // "toggle container", "icon button" — two descriptor words on one short string
  const keywords = (s.match(/\b(?:button|icon|menu|row|container|toggle|field|panel|section|dropdown|checkbox|cell)\b/gi) || []);
  if (keywords.length >= 2) return true;
  return false;
}

/**
 * Rule 8 helper — balanced-paren walk.
 *
 * The old regex ([^;,\n]+?) excluded commas, so any page.evaluate() whose
 * argument contained a CSS selector with a comma (querySelector('a, b')) would
 * silently pass through un-fixed. This function walks the source character by
 * character, tracking string literals and paren depth, so commas inside strings
 * are ignored and compound expressions with && / || work correctly.
 */
function wrapBareEvaluateLine(line) {
  const MARKER = 'page.evaluate(';
  const mi = line.indexOf(MARKER);
  if (mi === -1) return line;

  const argStart = mi + MARKER.length;

  // Walk forward to find the balanced closing ')' of page.evaluate(...).
  let depth = 1;
  let inSQ = false, inDQ = false, inBT = false, escape = false;
  let j = argStart;
  while (j < line.length && depth > 0) {
    const c = line[j];
    if (escape) { escape = false; j++; continue; }
    if (c === '\\' && (inSQ || inDQ)) { escape = true; j++; continue; }
    if (inSQ) { if (c === "'") inSQ = false; }
    else if (inDQ) { if (c === '"') inDQ = false; }
    else if (inBT) { if (c === '`') inBT = false; }
    else {
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
      else if (c === "'") inSQ = true;
      else if (c === '"') inDQ = true;
      else if (c === '`') inBT = true;
    }
    j++;
  }
  if (depth !== 0) return line; // unbalanced paren — leave unchanged

  const expr = line.slice(argStart, j).trim();

  // Already correctly wrapped — leave alone:
  //   arrow fn:  () => expr  /  async () => expr  /  (x) => expr
  //   function:  function(){} or (function(){})
  //   string:    'some.code.string' (eval-as-string pattern)
  if (/^(?:async\s*)?\(/.test(expr) && expr.includes('=>')) return line;
  if (/^(?:async\s+)?function\b/.test(expr)) return line;
  if (/^(['"`])/.test(expr)) return line;

  // IIFE: (function(){BODY})() → strip the call () so Playwright serialises
  // the function to the browser instead of executing it in Node.
  const iifeMatch = expr.match(/^(\(function\b[\s\S]*?\}\s*\))\s*\(\s*\)\s*$/);
  if (iifeMatch) {
    return line.slice(0, argStart) + iifeMatch[1] + line.slice(j);
  }

  // Bare DOM expression referencing a browser-only global. The previous
  // /^!*(?:document|window)\./ anchor only matched expressions whose VERY FIRST
  // token was document/window (optionally bang-prefixed). It missed the common
  // shapes the recorder emits with a leading group — !(document.querySelector(…) != null),
  // (document…), Array.from(document…), foo && window.bar — leaving a bare
  // expression that Node evaluates LOCALLY and throws "document is not defined",
  // killing the test before the trailing .catch() can ever attach (the throw is
  // synchronous, during argument evaluation, so .catch() cannot swallow it).
  // Generic rule: the arrow/function/IIFE/string forms are already returned above,
  // so anything still here is a bare expression — if it references ANY browser-only
  // global, ship it to the page via () => so it runs where that global exists.
  // A Node-side function reference or literal never contains these tokens, so this
  // does not over-wrap.
  if (/\b(?:document|window|navigator|localStorage|sessionStorage|location|getComputedStyle)\b/.test(expr)) {
    return line.slice(0, argStart) + '() => ' + expr + line.slice(j);
  }

  return line;
}

/**
 * Rule 0 — collapse duplicate destructured import / require declarations.
 *
 * The #1 cause of a generated spec being commented-out as un-loadable is an
 * "ast-parse-error … Duplicate declaration X". It happens whenever the SAME
 * module gets pulled in twice with overlapping named bindings, e.g.:
 *   - a Page Object body and its test get concatenated and both
 *     `import { clickFirstVisible } from '../utils/test-helpers'`;
 *   - the model emits `const { test, expect } = require('@playwright/test')`
 *     AND an injected `import { … } from '@playwright/test'`;
 *   - the model + the sanitizer/POM both pull the helper module.
 *
 * Generic rule (encodes "a file may declare a binding once"): for each module
 * specifier, keep the FIRST destructured import/require statement, UNION every
 * later statement's names into it, and delete the later statements. Only the
 * `import { … } from 'M'` and `const { … } = require('M')` shapes are touched —
 * default/namespace imports and side-effect imports are left untouched.
 */
function dedupeImportDeclarations(src) {
  if (typeof src !== 'string' || !src || (!src.includes('import') && !src.includes('require'))) return src;
  const importRe = /^(\s*)import\s+\{([^}]*)\}\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/;
  const requireRe = /^(\s*)const\s+\{([^}]*)\}\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)\s*;?\s*$/;
  const lines = src.split('\n');
  const groups = new Map(); // moduleSpecifier -> { keeperIdx, kind, indent, quote, spec, names[], dropIdx[] }
  lines.forEach((line, idx) => {
    let m = line.match(importRe); let kind = 'import';
    if (!m) { m = line.match(requireRe); kind = m ? 'require' : null; }
    if (!m) return;
    const [, indent, namesRaw, quote, spec] = m;
    const names = namesRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!groups.has(spec)) {
      groups.set(spec, { keeperIdx: idx, kind, indent, quote, spec, names: [...names], dropIdx: [] });
    } else {
      const g = groups.get(spec);
      for (const n of names) if (!g.names.includes(n)) g.names.push(n);
      g.dropIdx.push(idx);
    }
  });
  let anyDup = false;
  for (const g of groups.values()) if (g.dropIdx.length) { anyDup = true; break; }
  if (!anyDup) return src;
  const out = lines.slice();
  const DROP = ' __QAAI_DROP__ ';
  for (const g of groups.values()) {
    if (!g.dropIdx.length) continue;
    const namesStr = g.names.join(', ');
    out[g.keeperIdx] = g.kind === 'import'
      ? `${g.indent}import { ${namesStr} } from ${g.quote}${g.spec}${g.quote};`
      : `${g.indent}const { ${namesStr} } = require(${g.quote}${g.spec}${g.quote});`;
    for (const d of g.dropIdx) out[d] = DROP;
  }
  return out.filter((l) => l !== DROP).join('\n');
}

function envNameForSecretKey(key) {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k === 'password' || k === 'passwd' || k === 'pwd') return 'QAAI_PASSWORD';
  if (k === 'apikey') return 'QAAI_API_KEY';
  if (k === 'token') return 'QAAI_TOKEN';
  if (k === 'secret') return 'QAAI_SECRET';
  return null;
}

function rewriteSecretLiterals(src) {
  if (typeof src !== 'string' || !src) return src;
  const SECRET_ASSIGN_RE = /((?:['"])?(password|passwd|pwd|secret|api[_-]?key|token)(?:['"])?\s*[:=]\s*)(['"`])([^'"`]{4,})\3/gi;
  const AUTH_BEARER_RE = /(Authorization\s*:\s*)(['"`])Bearer\s+[a-zA-Z0-9._-]{8,}\2/g;
  return src.split('\n').map((line) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line) || /process\.env\./.test(line)) return line;
    let out = line.replace(SECRET_ASSIGN_RE, (m, prefix, key) => {
      const envName = envNameForSecretKey(key);
      return envName ? `${prefix}process.env.${envName} || ''` : m;
    });
    out = out.replace(AUTH_BEARER_RE, (_m, prefix) => `${prefix}\`Bearer \${process.env.QAAI_TOKEN || ''}\``);
    return out;
  }).join('\n');
}

function sanitizeJsTs(content) {
  if (typeof content !== 'string' || !content) return content;
  let out = content;

  // Rule 0 — kill duplicate import/require declarations BEFORE anything else so
  // the file at least PARSES (otherwise the whole spec gets commented out).
  out = dedupeImportDeclarations(out);

  // Rule 1 — hardcoded credential/secret object fields or assignments are
  // deterministic to repair: keep the generated shape but source the value from
  // environment variables so the later lint gate does not have to block.
  out = rewriteSecretLiterals(out);

  // Rule 2a — replace flaky page.goto calls with a retrying helper so transient
  // network changes do not fail the first navigation attempt.
  out = out.replace(/\b(await\s+)?(this\.page|page)\.goto\(([^)]*?)\)/g,
    (_m, _await, target, args) => `await safeGoto(${target}, ${args})`);

  // Rule 2 — waitForURL glob string that embeds a query-param segment.
  //   page.waitForURL('**/products**search=Printed**', ...)
  //   page.waitForURL("**/products", ...)
  //   Playwright globs don't support literal '=' or query params. Convert to
  //   a proper regex so the URL wait actually fires.
  //   Handles both single- and double-quoted globs. Also catches a bare leading
  //   '**/path' without trailing ** (the LLM sometimes omits the trailing **).
  out = out.replace(
    /\bwaitForURL\(\s*(['"])(\*+\/[^'"]+)\1\s*(,|\))/g,
    (_m, quote, glob, tail) => {
      // Only rewrite when the string contains glob indicators (leading **/).
      // A plain string that accidentally matches but has no glob character is
      // left alone (shouldn't happen given the **/ anchor, but guard anyway).
      if (!glob.includes('*')) return _m;
      // Normalise: strip leading ** and trailing ** so /products**search=X** → /products.*search=X
      const body = glob
        .replace(/^\*+/, '')         // remove leading *
        .replace(/\*+$/, '')         // remove trailing *
        .replace(/\*+/g, '.*');      // remaining ** → .*
      // Escape regex metacharacters that should match literally (=, ?, +, etc.).
      // Keep .* (from ** above) and leading-slash intact.
      const escaped = body.replace(/[+?^${}()|[\]\\]/g, '\\$&');
      // Ensure the path starts with / then escape all slashes for the regex delimiter.
      const regexBody = escaped.startsWith('/') ? escaped : `/${escaped}`;
      return `waitForURL(/${regexBody.replace(/\//g, '\\/')}/${tail}`;
    },
  );

  // Rule 3 — .catch(() => {}) silently swallowing a waitForURL failure.
  //   These were generated defensively but hide real navigation misses.
  out = out.replace(/\bwaitForURL\(([^)]+)\)\s*\.catch\(\(\)\s*=>\s*\{\}\)/g,
    (_m, args) => `waitForURL(${args})`);

  // Rule 3b — avoid swallowing waitForLoadState errors.
  out = out.replace(/\bwaitForLoadState\(([^)]+)\)\s*\.catch\(\(\)\s*=>\s*\{\}\)/g,
    (_m, args) => `waitForLoadState(${args})`);

  // Rule 3c — generic locator.waitFor(...).catch(() => {}) -> locator.waitFor(...)
  out = out.replace(/(\.[a-zA-Z0-9_]+\.waitFor\([^)]*\))\s*\.catch\(\(\)\s*=>\s*\{\}\)/g,
    (_m, call) => call);

  // Rule 4 — getByRole with a leading-space name literal.
  //   getByRole('link', { name: ' Products' })
  //   getByRole('link', { name: ' Products', exact: false })
  //   The leading space usually comes from an icon before the link text.
  //   Use a case-insensitive regex so the locator is robust to minor
  //   whitespace/capitalisation differences. The [^}]* tail handles extra
  //   properties (e.g. exact: false) that were previously causing this rule to miss.
  out = out.replace(
    /getByRole\((['"])([\w-]+)\1,\s*\{\s*name:\s*(['"])([\s\S]*?)\3[^}]*\}\)/g,
    (_m, q1, role, _q2, nameRaw) => {
      const name = String(nameRaw || '').replace(/\s+/g, ' ').trim();
      if (!name) return _m; // empty name — leave untouched
      // Only rewrite when the raw value had leading/trailing whitespace.
      if (name === String(nameRaw || '')) return _m;
      const esc = name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      return `getByRole(${q1}${role}${q1}, { name: /${esc}/i })`;
    }
  );

  // Rule 1 — URL matcher fed a path as a regex literal.
  //   await expect(page).toHaveURL(//pim/viewEmployeeList/, { timeout: 10_000 });
  //   await expect(page).toHaveURL(/pim/viewEmployeeList/, { ... });
  //   A path contains '/', which is the regex delimiter: a leading '//' starts a
  //   line comment (eats the line), and an internal '/' ends the regex early so
  //   the trailing text is read as invalid flags ("Invalid regular expression
  //   flag"). Either way the file won't PARSE. The robust, semantics-preserving
  //   fix is to convert the literal to new RegExp('<path>') — inside a string the
  //   '/' is an ordinary character, so it matches the same substring without any
  //   delimiter hazard. Properly-flagged regexes (e.g. /dashboard/i) don't match
  //   this pattern and are left untouched.
  //   - a doubled leading `//` (JS reads `//` as the start of a line comment), or
  //   - an internal unescaped `/` in the body (it ends the regex early, so the
  //     trailing text is parsed as invalid flags → "Invalid regular expression").
  // A clean regex with neither — /dashboard/, /\d+/, /foo|bar/ — parses fine and
  // MUST be left untouched, otherwise we corrupt its metacharacters.
  out = out.replace(
    /\b(toHaveURL|waitForURL)\(\s*(\/+)([^,){}\n]*?)\/\s*(,|\))/g,
    (_m, fn, slashes, body, tail) => {
      // An unescaped slash in the body breaks the regex literal (ends it early).
      // An ESCAPED slash (\/) in the body combined with other metachar backslash
      // sequences (e.g. \d, \w, \s) also needs rewriting — the backslash must be
      // doubled to survive new RegExp('\\d+/x'), not collapsed to /d+/x/.
      // A body that is ONLY escaped delimiters (\/path) is already valid and must
      // NOT be rewritten again (it was already normalised by an earlier rule).
      const unescapedBody = body.replace(/\\\//g, '');
      const hasNonDelimiterBackslash = /\\(?!\/)/.test(body);
      const hazard = slashes.length >= 2
        || unescapedBody.includes('/')
        || (body.includes('/') && hasNonDelimiterBackslash);
      if (!hazard) return _m; // valid regex literal — do not touch it
      // Recover the INTENDED pattern as a string literal for new RegExp(...):
      //   1. an escaped delimiter `\/` is just a slash once it's inside a string;
      //   2. every REMAINING backslash must be doubled to survive the JS string
      //      literal — so `/\d+/` becomes new RegExp('\\d+') (pattern \d+), NOT
      //      new RegExp('\d+') which the literal collapses to /d+/;
      //   3. escape single quotes.
      const pattern = body
        .replace(/\\\//g, '/')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
      return `${fn}(new RegExp('${pattern}')${tail}`;
    },
  );

  // Rule 5 — Descriptor-text getByText → QAAI_UNRESOLVED_LOCATOR throw.
  // The LLM disobeys the kbMiss instruction and invents
  //   page.getByText("User profile menu (top right)", { exact: true })
  //   this.page.getByText("Change Password toggle container", { exact: true })
  // locators that ALWAYS timeout — the string is the agent's narration, not
  // visible DOM text. Replace the ENTIRE LINE (assignment, action chain, or
  // assertion) with a hard-fail throw so the test fails immediately at the
  // right line with a clear message instead of a 30-second locator timeout.
  // This is a deterministic post-LLM rewrite — no prompt compliance needed.
  // NOTE: looksLikeDescriptorText threshold is 25 chars — any getByText with
  // a string longer than 25 chars is almost certainly a narration, not DOM copy.
  try {
    if (out.includes('getByText')) {
      out = out.split('\n').map((line) => {
        try {
          if (!line.includes('getByText')) return line;
          // Match page.getByText(...) and this.page.getByText(...) uniformly.
          const m = line.match(/getByText\s*\(\s*(['"`])([\s\S]*?)\1/);
          if (!m) return line;
          const textArg = m[2];
          if (!looksLikeDescriptorText(textArg)) return line;
          const indent = (line.match(/^(\s*)/) || [])[1] || '';
          const label = textArg.slice(0, 100).replace(/'/g, "\\'");
          return `${indent}throw new Error('QAAI_UNRESOLVED_LOCATOR: ${label}');`;
        } catch (_) { return line; }
      }).join('\n');
    }
  } catch (_) { /* rule 5 failed — leave output unchanged */ }

  // Rule 7 — Broken login flow: fill(credential) + page.goto() without a Login click.
  // The LLM sometimes inlines username/password fills and then substitutes
  // page.goto(url) for the Login button click. This creates a session-less
  // navigation — the credentials were filled but no submit happened, so the app
  // redirects back to login. Replace the goto() line with a hard-fail throw so
  // the test fails explicitly at the right line instead of silently landing on the
  // wrong page and producing a cascade of unrelated assertion failures.
  //
  // Detection: within any 5-line window, if there is a .fill() on what looks like
  // a password field AND the window contains a page.goto(), replace the goto line.
  // NOTE: Rule 2a above converts page.goto → safeGoto, so check for safeGoto too.
  const isReplayIrExport = /support\/replayir|QAAI ReplayIR|replayIrJson/i.test(out);
  if (!isReplayIrExport && /(page\.goto|safeGoto)\s*\(/.test(out) && /\.fill\(/.test(out)) {
    const lines = out.split('\n');
    const taintedGotoLines = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Detect fill on a password-like field
      if (/\.fill\(/.test(line) && /pass(?:word)?/i.test(line)) {
        // Look forward up to 4 lines for any goto/navigation call
        for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
          if (/\b(?:page\.goto|safeGoto)\s*\(/.test(lines[j])) taintedGotoLines.add(j);
        }
      }
    }
    if (taintedGotoLines.size) {
      out = lines.map((line, idx) => {
        if (!taintedGotoLines.has(idx)) return line;
        const indent = (line.match(/^(\s*)/) || [])[1] || '';
        return `${indent}throw new Error('QAAI_BROKEN_LOGIN_FLOW: page.goto() cannot substitute a Login button click — use the login() helper instead, or add an explicit Login button click before navigating');`;
      }).join('\n');
    }
  }

  // Rule 7b — Credential fills present but no login() call (variant 2 of broken login flow).
  // Rule 7 above catches "fill + goto" within 5 lines. This rule catches the OTHER
  // broken pattern: the LLM emitted inline credential fills but produced no login()
  // call anywhere in the file. That happens when the action plan filter (_journey.js
  // _isLoginAction) misses a credential action — the LLM sees fills and emits them,
  // but the login button click stays suppressed, leaving the session unestablished.
  // Replacing each fill with a throw gives a clear, immediate failure at the right
  // line instead of a cascade of stale-session assertion failures.
  try {
    if (!isReplayIrExport &&
        /\.fill\(readEnv\(['"]QAAI_(?:USERNAME|PASSWORD)['"]\)/.test(out) &&
        !/\bawait\s+login\s*\(/.test(out)) {
      out = out.split('\n').map((line) => {
        try {
          if (!/\.fill\(readEnv\(['"]QAAI_(?:USERNAME|PASSWORD)['"]\)/.test(line)) return line;
          const indent = (line.match(/^(\s*)/) || [])[1] || '';
          return `${indent}throw new Error('QAAI_BROKEN_LOGIN: inline credential fill without login() call — remove this line and ensure await login(page) is the first statement of the test body');`;
        } catch (_) { return line; }
      }).join('\n');
    }
  } catch (_) { /* rule 7b failed — leave output unchanged */ }

  // Rule 5b — getByRole with a suspicious name argument.
  // Rule 5 already covers getByText with descriptor/narration strings. This rule covers the SAME
  // problem when the narration or programmatic identifier ends up in a getByRole NAME argument.
  //
  // Two patterns are caught:
  //   A. Descriptor text: name matches looksLikeDescriptorText (long, contains "topbar"/"dropdown"/etc.)
  //      e.g. getByRole('button', { name: 'User profile dropdown in topbar' })
  //   B. camelCase programmatic identifier: name has [lowercase][uppercase] AND (length>10 OR digit)
  //      e.g. getByRole('textbox', { name: 'initialPassword' }), { name: 'newPassword456' }
  // Both cause a 30-second locator timeout because no real element has these accessible names.
  try {
    if (out.includes('getByRole')) {
      out = out.split('\n').map((line) => {
        try {
          if (!line.includes('getByRole')) return line;
          // Match the name: '...' / name: "..." argument — skip if it is a regex (/.../)
          const m = line.match(/getByRole\s*\(\s*(['"`])[^'"]+\1\s*,\s*\{[^}]*\bname\s*:\s*(['"`])([\s\S]*?)\2/);
          if (!m) return line;
          const nameArg = m[3];
          if (!nameArg) return line;
          const isDescriptor = looksLikeDescriptorText(nameArg);
          const hasCamelCase = /[a-z][A-Z]/.test(nameArg);
          const isProgrammatic = hasCamelCase && (nameArg.length > 10 || /\d/.test(nameArg));
          if (!isDescriptor && !isProgrammatic) return line;
          const indent = (line.match(/^(\s*)/) || [])[1] || '';
          const label = nameArg.slice(0, 100).replace(/'/g, "\\'");
          return `${indent}throw new Error('QAAI_UNRESOLVED_LOCATOR: getByRole name is agent narration or a field identifier, not a DOM accessible name: ${label}');`;
        } catch (_) { return line; }
      }).join('\n');
    }
  } catch (_) { /* rule 5b failed — leave output unchanged */ }

  // Rule 8 — page.evaluate(bare_expression) without an arrow-function wrapper.
  //   page.evaluate(document.cookie.length > 0)  → crashes: document not defined in Node
  //   page.evaluate(!!document.querySelector('a, b')) → same (comma in CSS selector
  //     broke the old [^;,\n] regex — fixed by balanced-paren walk in wrapBareEvaluateLine)
  //   page.evaluate((function(){...})())          → IIFE runs in Node, not the browser
  try {
    if (out.includes('page.evaluate(')) {
      out = out.split('\n').map((line) => {
        if (!line.includes('page.evaluate(')) return line;
        try { return wrapBareEvaluateLine(line); } catch (_) { return line; }
      }).join('\n');
    }
  } catch (_) { /* rule 8 failed — leave output unchanged */ }

  // Rule 9 — readData(row, key) without a for-loop.
  //   The LLM occasionally emits readData() calls when no data loop was generated
  //   (e.g. the test case name contains "Data-Driven" but actionPlan.dataRows was absent).
  //   This causes an instant ReferenceError: "row is not defined". Replace with a throw
  //   so the failure is immediate and descriptive rather than a confusing scope error.
  try {
    const hasReadData = out.includes('readData(row,') || out.includes('readData(row ,');
    const hasLoop = out.includes('for (const row of') || out.includes('for(const row of');
    if (hasReadData && !hasLoop) {
      out = out.replace(
        /\breadData\s*\(\s*row\s*,\s*([^)]+)\)/g,
        (_, key) => {
          const k = key.trim().replace(/'/g, "\\'");
          return `(() => { throw new Error('QAAI_DDT_NO_ROW: readData(${k}) called without a data loop — re-generate with data rows or use a literal value'); })()`;
        }
      );
    }
  } catch (_) { /* rule 9 failed — leave output unchanged */ }

  // Rule 6 — Strip unused resolveLocator from the replayir require import.
  // resolveLocator was used by old codegen; native getBy* locators replaced it.
  // Remove it from the destructured import when it is not called anywhere in
  // the file body, so generated specs have no dead imports.
  if (out.includes('resolveLocator') && /require\(['"]/.test(out) && /replayir/.test(out)) {
    const importRe = /(const\s*\{)([^}]*\bresolveLocator\b[^}]*)(\}\s*=\s*require\(['"][^'"]*replayir[^'"]*['"]\);)/;
    const imp = out.match(importRe);
    if (imp) {
      const withoutImportLine = out.replace(imp[0], '');
      if (!/\bresolveLocator\b/.test(withoutImportLine)) {
        const cleanNames = imp[2].split(',').map((s) => s.trim()).filter((s) => s && s !== 'resolveLocator').join(', ');
        out = out.replace(imp[0], `${imp[1]}${cleanNames ? ` ${cleanNames} ` : ''}${imp[3]}`);
      }
    }
  }

  return out;
}

/**
 * Sanitize one generated file by extension. Java/feature files pass through
 * unchanged for now (the doubled-slash regex bug is JS/TS-specific).
 */
function sanitizeGenerated(content, relPath = '') {
  if (/\.(ts|js)$/.test(relPath) || relPath === '') {
    let out = sanitizeJsTs(content);

    // If this is a test file, ensure defensive helper imports and replace
    // brittle `.click()` calls with `clickFirstVisible(...)` so generated
    // specs consistently use the shared helper.
    try {
      const isTest = /tests\//.test(relPath) || /\.spec\.(ts|js)$/.test(relPath);
        const isPageObject = /pages\//.test(relPath) && /\.page\.(ts|js)$/.test(relPath);
        if ((isTest || isPageObject) && typeof out === 'string') {
          const depth = relPath.split('/').length - 1;
          const relPrefix = depth > 0 ? '../'.repeat(depth) : './';

          // Inject import/require for helpers depending on module style.
          const hasEsmPlaywrightImport = /import\s+.*from\s+['"]@playwright\/test['"]/.test(out) || /import\s+test\b/.test(out);
          const hasCjsPlaywrightImport = /require\(['"]@playwright\/test['"]\)/.test(out) || /const\s+\{\s*test,\s*expect\s*\}\s*=\s*require\(['"][^'"]+['"]\)/.test(out);
          const helperImportExt = /\.js$/.test(relPath) && (hasEsmPlaywrightImport || /^\s*import\b/.test(out)) ? '.js' : '';
          const helperImportPath = (relPrefix + 'utils/test-helpers' + helperImportExt).replace(/\\/g, '/');

          if (hasEsmPlaywrightImport) {
          // TypeScript/ESM style
          if (!/utils\/test-helpers/.test(out)) {
            out = `import { clickFirstVisible, safeClick, safeGoto } from '${helperImportPath}';\n` + out;
          } else if (!/safeGoto/.test(out)) {
            out = out.replace(/import\s+\{([^}]*)\}\s+from\s+['"][^'"]*utils\/test-helpers[^'"]*['"];?/,
              (_m, names) => `import { ${names.trim()}, safeGoto } from '${helperImportPath}';`);
          }
        } else if (hasCjsPlaywrightImport) {
          // CommonJS style
          if (!/utils\/test-helpers/.test(out)) {
            out = `const { clickFirstVisible, safeClick, safeGoto } = require('${helperImportPath}');\n` + out;
          } else if (!/safeGoto/.test(out)) {
            out = out.replace(/const\s+\{([^}]*)\}\s*=\s*require\(['\"][^'\"]*utils\/test-helpers[^'\"]*['\"]\);?/,
              (_m, names) => `const { ${names.trim()}, safeGoto } = require('${helperImportPath}');`);
          }
        } else if (/^\s*import\b/.test(out)) {
          // ESM file with no Playwright import (e.g. page object helper file).
          if (!/utils\/test-helpers/.test(out)) {
            out = `import { clickFirstVisible, safeClick, safeGoto } from '${helperImportPath}';\n` + out;
          }
        } else {
          // CommonJS file with no Playwright import (e.g. page object helper file).
          if (!/utils\/test-helpers/.test(out)) {
            out = `const { clickFirstVisible, safeClick, safeGoto } = require('${helperImportPath}');\n` + out;
          }
        }

        // Replace `await <expr>.click()` with `await clickFirstVisible(<expr>)`.
        out = out.replace(/await\s+([^\n;]+?)\.click\(\)/g, (m, expr) => `await clickFirstVisible(${expr})`);
        // Replace `await <expr>.dblclick()` with clickFirstVisible + clickCount.
        out = out.replace(/await\s+([^\n;]+?)\.dblclick\(\)/g, (m, expr) => `await clickFirstVisible(${expr}, { clickCount: 2 })`);
      }
    } catch (e) {
      // don't let sanitizer throw; return the best-effort sanitized output
    }

    // Rule 0 (again) — the helper-import injection above can introduce a second
    // declaration of a binding the file already had; collapse any duplicate so
    // the emitted file still parses.
    out = dedupeImportDeclarations(out);

    // Detect forbidden tokens emitted by the model and annotate them so the
    // conductor/transpile gate can spot model tool tokens that shouldn't land
    // in source. Replace them with a harmless comment to avoid syntax errors.
    const forbidden = ['browser_triple_click', 'browser_double_click', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_scroll', 'browser_navigate'];
    const found = forbidden.filter((t) => out.includes(t));
    if (found.length) {
      const note = `// QAAI_SANITIZER_FORBIDDEN_TOKENS: ${found.join(', ')} — replaced by sanitizer\n`;
      let replaced = out;
      found.forEach((tok) => {
        replaced = replaced.split(tok).join('/*[forbidden token removed]*/');
      });
      out = note + replaced;
    }

    return out;
  }
  return content;
}

/**
 * Like sanitizeGenerated but returns { code, rewrites: Array } instead of a plain string.
 * rewrites is empty when the sanitizer made no changes; otherwise contains one entry per
 * file with the relative path + line-count delta. Use this in export/certification paths
 * where you want to know what changed. Existing callers of sanitizeGenerated are unchanged.
 *
 * Enterprise rule: sanitizer rewrites are allowed during development. Before release they
 * should be rare. Long-term they should be zero — each entry is a generator defect waiting
 * to be fixed at the source rather than repaired at export time.
 */
function sanitizeGeneratedDetailed(content, relPath = '') {
  const original = content;
  const code = sanitizeGenerated(content, relPath);
  if (code === original) return { code, rewrites: [] };
  return {
    code,
    rewrites: [{
      relPath,
      linesIn: typeof original === 'string' ? original.split('\n').length : 0,
      linesOut: typeof code === 'string' ? code.split('\n').length : 0,
    }],
  };
}

module.exports = { sanitizeGenerated, sanitizeGeneratedDetailed, sanitizeJsTs, dedupeImportDeclarations };
