'use strict';

/**
 * Phase H+1 — Project-level "known popups" framework.
 *
 * Operators declare popups that may appear on the project's site in a
 * generic schema. Two consumers downstream:
 *
 *   1. Conductor (live agent run)  — injects a prompt block teaching the
 *      agent to proactively dismiss these popups whenever they're visible.
 *   2. Codegen   (generated specs) — emits a `dismissKnownPopups` helper
 *      and a `beforeEach` hook so spec re-runs survive the same popups.
 *
 * Flexible by design — no hardcoded site assumptions. Five matcher
 * strategies cover virtually every popup pattern:
 *   role     — Playwright getByRole({ name }) — the most resilient default
 *   text     — Playwright getByText() — exact or regex substring match
 *   label    — Playwright getByLabel() — for form-attached close X's
 *   testId   — Playwright getByTestId() — when the dev set data-testid
 *   css      — Playwright locator(css) — escape hatch for legacy sites
 *
 * Pure functions. No DB. No LLM. No side effects.
 */

const VALID_STRATEGIES = new Set(['role', 'text', 'label', 'testId', 'css']);
const VALID_SCOPES = new Set(['global', 'first-page-load', 'after-auth']);
const VALID_AFTER_DISMISS = new Set(['wait-hidden', 'reload', null, undefined]);

/**
 * Validate a knownPopups JSON array. Returns { ok, issues, normalized }
 * where `normalized` is the cleaned-up array (drops invalid records,
 * fills missing optional fields).
 *
 * Issues are reported as strings; never throws. The caller decides
 * whether to reject (PUT) or silently filter (consumption).
 */
function normalize(raw) {
  const issues = [];
  const input = Array.isArray(raw) ? raw : [];
  const normalized = [];
  for (let i = 0; i < input.length; i++) {
    const rec = input[i] || {};
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : null;
    if (!name) { issues.push(`popup[${i}] missing 'name'`); continue; }
    const m = rec.matcher || {};
    const strategy = String(m.strategy || '').toLowerCase();
    if (!VALID_STRATEGIES.has(strategy)) {
      issues.push(`popup[${i}] (${name}) invalid matcher.strategy '${strategy}'`);
      continue;
    }
    const value = typeof m.value === 'string' && m.value.trim() ? m.value.trim() : null;
    if (!value) { issues.push(`popup[${i}] (${name}) missing matcher.value`); continue; }
    const role = typeof m.role === 'string' ? m.role.trim() : null;
    // Role strategy needs both role + value (name). Other strategies just need value.
    if (strategy === 'role' && !role) {
      issues.push(`popup[${i}] (${name}) role strategy requires matcher.role`);
      continue;
    }
    const scope = VALID_SCOPES.has(rec.scope) ? rec.scope : 'global';
    const afterDismiss = VALID_AFTER_DISMISS.has(rec.afterDismiss)
      ? (rec.afterDismiss || null)
      : null;
    normalized.push({ name, matcher: { strategy, value, role: role || null }, scope, afterDismiss });
  }
  return { ok: issues.length === 0, issues, normalized };
}

/**
 * Render a Playwright locator expression from a matcher. Used inside the
 * generated spec's helper. Returns a TS-safe expression string like:
 *   page.getByRole('button', { name: /accept all/i })
 *
 * Values starting and ending with '/' are treated as regex bodies.
 */
function renderLocator(matcher) {
  const { strategy, value, role } = matcher;
  const valueExpr = renderValueExpr(value);
  switch (strategy) {
    case 'role':   return `page.getByRole('${escapeTs(role)}', { name: ${valueExpr} })`;
    case 'text':   return `page.getByText(${valueExpr})`;
    case 'label':  return `page.getByLabel(${valueExpr})`;
    case 'testId': return `page.getByTestId('${escapeTs(value)}')`;
    case 'css':    return `page.locator('${escapeTs(value)}')`;
    default:       return `page.locator('${escapeTs(value)}')`;
  }
}

function renderValueExpr(value) {
  // /pattern/flags → regex literal
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(value);
  if (m) return `/${m[1]}/${m[2] || ''}`;
  // Otherwise quoted string with case-insensitive substring matcher? No —
  // Playwright's getByText/Role accept strings as substrings already.
  // Keep as a literal string so authors get exact behaviour they expect.
  return `'${escapeTs(value)}'`;
}

function escapeTs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Render the TypeScript helper file body that the generated specs import.
 * One async function `dismissKnownPopups(page)` that conditionally
 * dismisses each declared popup in order. Defensive — every check uses
 * a short timeout and swallows ".isVisible" exceptions so missing
 * popups don't break the spec.
 *
 * Returns a `{ rel, content }` pair the codegen layer can write.
 */
function renderHelperFile(knownPopups) {
  const dismissals = (knownPopups || []).map((p, i) => {
    const loc = renderLocator(p.matcher);
    const after = p.afterDismiss === 'wait-hidden'
      ? `    await target.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});\n`
      : p.afterDismiss === 'reload'
        ? `    await page.reload().catch(() => {});\n`
        : '';
    return (
      `  // ${i + 1}. ${p.name} (scope: ${p.scope})\n` +
      `  {\n` +
      `    const target = ${loc};\n` +
      `    if (await target.isVisible({ timeout: 1500 }).catch(() => false)) {\n` +
      `      await target.click({ timeout: 5000 }).catch(() => {});\n` +
      after +
      `    }\n` +
      `  }`
    );
  }).join('\n');

  const content =
`import { Page } from '@playwright/test';

/**
 * Project-level known-popup dismissal. Generated from Project.knownPopups
 * — re-running this spec on a different day will still survive whatever
 * popups the SUT shows (cookie consent, newsletter modal, onboarding tour, etc.).
 *
 * Each check uses a short timeout (1.5s) and swallows visibility errors,
 * so popups that don't appear today do not slow the test down or break it.
 */
export async function dismissKnownPopups(page: Page): Promise<void> {
${dismissals || '  // No project-level popups declared.'}
}
`;
  return { rel: 'utils/known-popups.ts', content };
}

/**
 * Render the Conductor prompt block teaching the live agent about the
 * project's known popups. Injected into the per-case user message so
 * the agent dismisses them proactively (cheaper than reacting to a
 * locator failure mid-flow). Empty string when no popups declared.
 */
function renderPromptBlock(knownPopups) {
  const list = (knownPopups || []);
  if (!list.length) return '';
  const lines = list.map((p, i) => {
    const m = p.matcher;
    const human = m.strategy === 'role'
      ? `getByRole('${m.role}', { name: '${m.value}' })`
      : m.strategy === 'testId'
        ? `getByTestId('${m.value}')`
        : m.strategy === 'css'
          ? `locator('${m.value}')`
          : `${m.strategy}: ${m.value}`;
    return `  ${i + 1}. "${p.name}" — match via ${human}; scope=${p.scope}` +
      (p.afterDismiss ? `; after: ${p.afterDismiss}` : '');
  }).join('\n');
  return (
`## KNOWN POPUPS (project-declared)
The operator has declared these popups for this project. If you see one of
them on the page at any point, dismiss it BEFORE continuing with the test
steps. Use a short check (~1.5s) so a missing popup does not block progress.
Declared popups:
${lines}
`);
}

module.exports = {
  normalize,
  renderLocator,
  renderHelperFile,
  renderPromptBlock,
  VALID_STRATEGIES,
  VALID_SCOPES,
};
