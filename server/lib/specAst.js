'use strict';

/**
 * AST-based lint engine for Playwright spec code (Phase E6 / BUILD_PLAN_V2).
 *
 * Complements the regex engine in `services/lintGates.js`. The regex engine
 * does what regex is good at — string pattern matching for banned APIs,
 * leaked credentials, hardcoded URLs. This file adds the rules that
 * genuinely need scope awareness:
 *
 *   1. ast-missing-await-on-locator
 *      Page interaction calls (click, fill, press, type, goto, hover,
 *      check, uncheck, selectOption, dragTo, focus, dispatchEvent) used
 *      as expression statements with no `await` and no `.catch()` chain.
 *      Regex sees "page.click" anywhere on the line; AST sees that the
 *      CallExpression is a top-level ExpressionStatement returning an
 *      unawaited Promise.
 *
 *   2. ast-assertion-without-expect-per-test
 *      For each `test(...)` block: walk its callback body and confirm at
 *      least one `expect(...)` call. Today's regex check is global ("the
 *      file has at least one expect"); a file with one good test and one
 *      assertion-free test passes today. AST flags the empty one.
 *
 *   3. ast-screenshot-on-failure-missing
 *      `test.afterEach(...)` whose body has no conditional screenshot
 *      capture (`if (testInfo.status !== 'passed') await page.screenshot(...)`).
 *      Regex can't see "is this inside afterEach?".
 *
 *   4. ast-brittle-locator-css-with-dynamic-class
 *      `.locator('.btn-3a4f9')` or similar where the class name has a
 *      generated-looking suffix (hash-style, numeric tail). AST targets
 *      ONLY the first argument string of a `.locator()` call, drastically
 *      cutting the false positives a line-level regex would hit.
 *
 *   5. ast-unused-page-locator
 *      `page.locator('button')` (or `page.getByRole(...)`, etc.) appearing
 *      as a bare expression statement with no chained action and no
 *      assignment. Common LLM-generated noise: "I created a locator but
 *      did nothing with it."
 *
 *   6. ast-low-assertion-density
 *      A `test(...)` block whose body executes many interactions but
 *      asserts almost nothing — e.g. click → fill → click → fill → click,
 *      and a single terminal `expect(...)`. That test only checks the
 *      LAST thing the SUT did; if any of the intermediate steps quietly
 *      failed-soft (still rendered, wrong state), the test passes. The
 *      LLM-generated "happy path with a hopeful assertion at the end"
 *      pattern. Threshold: ≥ 3 interactions AND ≤ 1 expect. Tests with
 *      assertion-without-expect already fire rule 2, so we only flag the
 *      "some expect but not enough" case.
 *
 * Failure mode: if `@babel/parser` can't parse the code (malformed TS,
 * partial generation), `lintAst` returns `{ findings: [], parseError }`.
 * The caller in `lintGates.lint()` swallows the parseError and the
 * regex engine still contributes its findings — full graceful fallback.
 *
 * Caching: parses are SHA-1 keyed; identical content returns the cached
 * findings array without re-parsing. In-memory only (Map, capped at 50
 * entries — these specs are small and the LRU eviction is approximate).
 */

const parser = require('@babel/parser');
const traverseModule = require('@babel/traverse');
const crypto = require('crypto');

// @babel/traverse is exported as default in CJS interop. Handle both shapes.
const traverse = traverseModule.default || traverseModule;

// Page-interaction methods that return a Promise. Locator-returning
// methods (locator, getByRole, getByText, getByTestId, getByLabel,
// getByPlaceholder, getByAltText, getByTitle, frameLocator) are NOT in
// here — they're synchronous and don't need await.
const PAGE_INTERACTIONS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'pressSequentially',
  'check', 'uncheck', 'selectOption', 'setInputFiles', 'hover',
  'focus', 'blur', 'tap', 'dragTo', 'dispatchEvent', 'goto',
  'waitForLoadState', 'waitForURL', 'reload', 'goBack', 'goForward',
  'screenshot', 'evaluate', 'evaluateHandle', 'addInitScript',
]);

// Locator-creating methods. Bare expression statement using one of these
// is the `ast-unused-page-locator` smell.
const LOCATOR_CREATORS = new Set([
  'locator', 'getByRole', 'getByText', 'getByTestId', 'getByLabel',
  'getByPlaceholder', 'getByAltText', 'getByTitle', 'frameLocator',
]);

// User-driven interactions only — for the assertion-density rule. Excludes
// navigation / waits / screenshots / evaluates / addInitScript so a test that
// goto → wait → screenshot isn't flagged as "many actions, few asserts".
// The density signal we care about is the click/fill/type chain pattern.
const USER_INTERACTIONS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'pressSequentially',
  'check', 'uncheck', 'selectOption', 'setInputFiles', 'hover',
  'focus', 'tap', 'dragTo',
]);

// Density rule threshold — flag tests with at least this many user
// interactions AND at most this many expect() calls. Picked at 4 (not 3)
// so the canonical short login test (goto + fill + fill + click + 1 assert)
// passes; the smell kicks in on longer chains like a 5-step wizard with a
// single terminal assertion at the end.
const LOW_DENSITY_INTERACTIONS = 4;
const LOW_DENSITY_MAX_EXPECTS = 1;

// Find `.prefix-tail` style class selectors and capture the tail. The
// "looks generated" decision happens in `isGeneratedSuffix` so the heuristic
// is one place to tune (false positives on `.btn-primary` etc. would erode
// trust quickly). Examples we want to match:
//   .btn-3a4f9b   .css-1q2w3e4   .Header__title-93fa   .x-aB7cD8eF
// Examples we DO NOT want to match:
//   .btn-primary  .header-title  .icon-search  .nav-open
const DYNAMIC_CLASS_CANDIDATE_RE = /\.[A-Za-z][A-Za-z_-]*[-_]([A-Za-z0-9]{4,})\b/g;

function isGeneratedSuffix(tail) {
  if (!tail || tail.length < 4) return false;
  // Pure hex of length ≥ 4 — classic Emotion / styled-components.
  if (/^[a-f0-9]{4,}$/i.test(tail)) return true;
  // 3+ consecutive digits anywhere.
  if (/\d{3,}/.test(tail)) return true;
  // Mixed letters AND digits in a ≥ 5-char tail — covers css-1q2w3e4,
  // Tailwind JIT outputs, CSS-Modules hashes. We require ≥ 2 digits OR
  // ≥ 1 digit + ≥ 1 uppercase to keep `btn-primary` and `header-title`
  // OUT. Real generated tails almost always interleave digits.
  if (tail.length >= 5 && /[a-zA-Z]/.test(tail) && /\d/.test(tail)) {
    const digitCount = (tail.match(/\d/g) || []).length;
    const upperCount = (tail.match(/[A-Z]/g) || []).length;
    if (digitCount >= 2) return true;
    if (digitCount >= 1 && upperCount >= 1) return true;
  }
  return false;
}

const CACHE = new Map();
const CACHE_MAX = 50;

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function parseSpec(code) {
  return parser.parse(code, {
    sourceType: 'module',
    errorRecovery: true,
    allowImportExportEverywhere: true,
    plugins: [
      'typescript',
      'jsx',
      'objectRestSpread',
      'optionalChaining',
      'nullishCoalescingOperator',
      'topLevelAwait',
    ],
  });
}

function findingFromNode(rule, severity, node, message, snippet) {
  return {
    rule,
    severity,
    line: node?.loc?.start?.line || 1,
    column: node?.loc?.start?.column || 0,
    message,
    snippet: snippet ? String(snippet).slice(0, 120) : undefined,
    engine: 'ast',
  };
}

// Scan the first-argument string of a `.locator()` call for any
// dynamic-looking class selector. Returns the offending tail or null.
function firstArgLooksDynamicClass(callExpr) {
  const arg = callExpr.arguments?.[0];
  if (!arg) return null;
  let value = null;
  if (arg.type === 'StringLiteral') value = arg.value;
  else if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) {
    value = arg.quasis.map((q) => q.value.raw).join('');
  }
  if (!value) return null;
  DYNAMIC_CLASS_CANDIDATE_RE.lastIndex = 0;
  let m;
  while ((m = DYNAMIC_CLASS_CANDIDATE_RE.exec(value)) !== null) {
    if (isGeneratedSuffix(m[1])) {
      // Return the full selector match (`.css-1q2w3e4`) so the finding
      // message can quote it verbatim.
      return m[0];
    }
  }
  return null;
}

// Resolve the callee's method name when the expression is `X.method(...)`
// or `X.method.subMethod(...)`. Returns null if the callee shape isn't a
// MemberExpression with an identifier property.
function memberMethodName(node) {
  if (!node || node.type !== 'CallExpression') return null;
  const cal = node.callee;
  if (!cal || cal.type !== 'MemberExpression') return null;
  if (cal.computed) return null;
  if (cal.property?.type !== 'Identifier') return null;
  return cal.property.name;
}

// True if this CallExpression is "wrapped" in something that makes the
// missing-await acceptable — `await x.click()`, `return x.click()`,
// `x.click().catch(...)`, `Promise.all([x.click(), ...])`, etc.
function isPromiseHandled(callPath) {
  // Walk up to detect any of: AwaitExpression, ReturnStatement (returning
  // this expression), .catch / .then chains, or being an argument to
  // Promise.all / Promise.allSettled / await of an outer ArrayExpression.
  let p = callPath.parentPath;
  let cur = callPath;
  while (p) {
    const node = p.node;
    if (!node) return false;
    if (node.type === 'AwaitExpression') return true;
    if (node.type === 'ReturnStatement') return true;
    if (node.type === 'YieldExpression') return true;
    if (node.type === 'ArrowFunctionExpression' && node.body === cur.node) return true;
    if (node.type === 'VariableDeclarator' && node.init === cur.node) return true;
    if (node.type === 'AssignmentExpression') return true;
    if (node.type === 'LogicalExpression') return true;
    // Chained .then / .catch / .finally — the resulting Promise is
    // handled even if the original call wasn't awaited.
    if (node.type === 'MemberExpression' && node.object === cur.node) {
      // We're the object of a member expression — keep walking up.
      cur = p;
      p = p.parentPath;
      continue;
    }
    if (node.type === 'CallExpression') {
      // If the parent call is Promise.all / allSettled / race / any,
      // someone is handling the array — accept.
      const m = memberMethodName(node);
      if (m && ['all', 'allSettled', 'race', 'any'].includes(m)) return true;
      // If we're an argument of another CallExpression, we're being
      // passed somewhere — accept (e.g. expect(page.locator(...)).toX()).
      if (node.arguments?.includes(cur.node)) return true;
      // Otherwise the outer call IS the chained one — keep climbing
      // because `x.click().then(...)` is the .then() being the outer
      // call and we want to detect that.
    }
    // Stop at statement boundaries — if we hit ExpressionStatement we're
    // at the top of the expression and unhandled.
    if (node.type === 'ExpressionStatement') return false;
    if (node.type === 'BlockStatement' || node.type === 'Program') return false;
    cur = p;
    p = p.parentPath;
  }
  return false;
}

// True if a node is the call expression `test(...)` or `test.skip/only/...(...)`
// — used to identify a top-level test block.
function isTestCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const c = node.callee;
  if (c.type === 'Identifier' && c.name === 'test') return true;
  if (c.type === 'MemberExpression' && c.object?.type === 'Identifier' && c.object.name === 'test') {
    // test.only / test.serial / test.fixme (not test.skip — skipped tests
    // legitimately have no expect)
    if (c.property?.type === 'Identifier' && ['only', 'serial', 'fixme'].includes(c.property.name)) {
      return true;
    }
    return false;
  }
  return false;
}

// True for `test.afterEach(...)` specifically.
function isAfterEachCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const c = node.callee;
  return c.type === 'MemberExpression'
    && c.object?.type === 'Identifier' && c.object.name === 'test'
    && c.property?.type === 'Identifier' && c.property.name === 'afterEach';
}

// Per-test and per-afterEach state is tracked on stacks during the main
// traversal (rules 2 and 3 below). Using enter/exit hooks avoids the
// "raw node has no scope" trap that bare `traverse(node, ...)` falls into.

function lintAst(code) {
  if (typeof code !== 'string' || code.length === 0) {
    return { findings: [], parseError: null };
  }
  const key = sha1(code);
  if (CACHE.has(key)) return { findings: CACHE.get(key), parseError: null };

  let ast;
  try {
    ast = parseSpec(code);
  } catch (err) {
    return { findings: [], parseError: err.message || 'parse failed' };
  }

  const findings = [];
  // Stack-based context tracking — enter pushes, exit pops. Lets the
  // CallExpression visitor know whether it's inside a test() / afterEach()
  // so we can score per-block rules without re-walking subtrees.
  const testStack = [];        // { node, title, hasFn, hasExpect }
  const afterEachStack = [];   // { node, hasFailureScreenshot }

  try {
    traverse(ast, {
      CallExpression: {
        enter(path) {
          const node = path.node;

          // Push test() context. We check at enter and decide at exit so
          // every expect(...) inside the body (no matter how nested)
          // gets credited via the inner expect-counter below.
          if (isTestCall(node)) {
            const titleArg = node.arguments[0];
            const fnArg = node.arguments.find((a) =>
              a && (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression'),
            );
            testStack.push({
              node,
              title: titleArg?.type === 'StringLiteral' ? titleArg.value : '(anonymous test)',
              hasFn: !!fnArg,
              hasExpect: false,
              expectCount: 0,
              actionCount: 0,
            });
            return;
          }
          if (isAfterEachCall(node)) {
            afterEachStack.push({ node, hasFailureScreenshot: false });
            return;
          }

          // Credit expect() to the innermost enclosing test.
          if (node.callee?.type === 'Identifier' && node.callee.name === 'expect' && testStack.length) {
            const top = testStack[testStack.length - 1];
            top.hasExpect = true;
            top.expectCount += 1;
          }

          // Credit page-interaction calls (click/fill/press/etc) to the
          // innermost test for the assertion-density rule. Counts ALL
          // interaction calls — both awaited and bare — so the density
          // signal isn't muddied by rule-1's await-vs-no-await axis.
          if (testStack.length) {
            const method = memberMethodName(node);
            if (method && USER_INTERACTIONS.has(method)) {
              testStack[testStack.length - 1].actionCount += 1;
            }
          }

          // Rule 4: brittle-locator-css-with-dynamic-class. Fire on every
          // matching .locator() call, anywhere — not scoped to test().
          const method = memberMethodName(node);
          if (method === 'locator') {
            const dyn = firstArgLooksDynamicClass(node);
            if (dyn) {
              findings.push(findingFromNode(
                'ast-brittle-locator-css-with-dynamic-class', 'warning', node,
                `Locator string \`${dyn}\` looks like a build-generated class (hash or numeric suffix). These break on every CSS-Modules / Tailwind JIT rebuild — prefer getByRole / getByTestId.`,
              ));
            }
          }
        },
        exit(path) {
          if (isTestCall(path.node)) {
            const ctx = testStack.pop();
            if (ctx && ctx.hasFn && !ctx.hasExpect) {
              findings.push(findingFromNode(
                'ast-assertion-without-expect-per-test', 'error', path.node,
                `test "${ctx.title}" has no expect() assertion in its body. A test without an assertion only verifies that the steps didn't throw — it doesn't verify the SUT did the right thing.`,
              ));
            } else if (ctx && ctx.hasFn
                && ctx.actionCount >= LOW_DENSITY_INTERACTIONS
                && ctx.expectCount <= LOW_DENSITY_MAX_EXPECTS) {
              // Rule 6 — only fires when rule 2 didn't. Test has SOME
              // assertion but not enough relative to the action density.
              findings.push(findingFromNode(
                'ast-low-assertion-density', 'warning', path.node,
                `test "${ctx.title}" performs ${ctx.actionCount} user interactions but only ${ctx.expectCount} expect() assertion${ctx.expectCount === 1 ? '' : 's'}. Add intermediate expect() calls after the major actions — a single terminal assertion only verifies the LAST step, not the chain.`,
              ));
            }
          }
          if (isAfterEachCall(path.node)) {
            const ctx = afterEachStack.pop();
            if (ctx && !ctx.hasFailureScreenshot) {
              findings.push(findingFromNode(
                'ast-screenshot-on-failure-missing', 'warning', path.node,
                `test.afterEach is defined but doesn't take a screenshot on failure. Add \`if (testInfo.status !== 'passed') await page.screenshot({ path: ... })\` so failed runs have visual evidence.`,
              ));
            }
          }
        },
      },

      // Rule 1: missing-await-on-locator + rule 5 (unused page locator).
      // Both look at bare expression statements whose expression is a call.
      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (!expr || expr.type !== 'CallExpression') return;
        const method = memberMethodName(expr);
        if (!method) return;

        // Rule 5 — unused page locator. Bare `page.locator('button')` as a
        // statement with no assignment, no chained call.
        if (LOCATOR_CREATORS.has(method)) {
          findings.push(findingFromNode(
            'ast-unused-page-locator', 'warning', expr,
            `\`${method}(...)\` is called as a bare statement — the locator is created and immediately discarded. Either await an action on it (.click() / .fill() / ...) or assert on it via expect(...).`,
          ));
          return;
        }

        // Rule 1 — page interaction without await.
        if (PAGE_INTERACTIONS.has(method)) {
          if (!isPromiseHandled(path.get('expression'))) {
            findings.push(findingFromNode(
              'ast-missing-await-on-locator', 'error', expr,
              `\`${method}(...)\` returns a Promise but is neither awaited nor handled — the assertion that follows can race the action.`,
            ));
          }
        }
      },

      // Rule 3 helper: when we see an IfStatement inside an afterEach
      // whose test mentions testInfo.status AND whose consequent contains
      // a .screenshot() call, mark the surrounding afterEach as "ok".
      IfStatement(path) {
        if (!afterEachStack.length) return;
        const ctx = afterEachStack[afterEachStack.length - 1];

        let mentionsStatus = false;
        try {
          path.get('test').traverse({
            MemberExpression(p) {
              if (p.node.object?.type === 'Identifier'
                  && p.node.object.name === 'testInfo'
                  && p.node.property?.type === 'Identifier'
                  && p.node.property.name === 'status') {
                mentionsStatus = true;
                p.stop();
              }
            },
          });
        } catch (_) { /* swallow — leave mentionsStatus false */ }
        if (!mentionsStatus) return;

        let hasScreenshot = false;
        try {
          path.get('consequent').traverse({
            CallExpression(p) {
              if (memberMethodName(p.node) === 'screenshot') {
                hasScreenshot = true;
                p.stop();
              }
            },
          });
        } catch (_) { /* swallow — leave hasScreenshot false */ }
        if (hasScreenshot) ctx.hasFailureScreenshot = true;
      },
    });
  } catch (err) {
    // Traversal blew up mid-walk. Return whatever findings we collected
    // and surface the error so the caller can log it.
    return { findings, parseError: err.message || 'traverse failed' };
  }

  // Cap-and-evict the cache. Map preserves insertion order, so the
  // oldest key is the first one when we exceed the cap.
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, findings);

  return { findings, parseError: null };
}

module.exports = {
  lintAst,
  // exposed for tests / debugging only
  _internals: { CACHE, parseSpec },
};
