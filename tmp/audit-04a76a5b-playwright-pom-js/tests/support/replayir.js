import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

async function resolveLocator(page, candidates, label) {
  const errors = [];
  for (const c of candidates) {
    let locator = null;
    if (c.strategy === 'role' && c.role && c.name && String(c.name).trim()) locator = page.getByRole(c.role, { name: c.name });
    if (c.strategy === 'css' && c.selector) locator = page.locator(c.selector);
    if (c.strategy === 'testId' && c.testId) locator = page.getByTestId(c.testId);
    if (c.strategy === 'text' && c.text) locator = page.getByText(c.text);
    if (c.strategy === 'placeholder' && c.text) locator = page.getByPlaceholder(c.text);
    if (c.strategy === 'label' && c.text) locator = page.getByLabel(c.text);
    if (!locator) {
      errors.push(`unsupported candidate ${JSON.stringify(c)}`);
      continue;
    }
    await locator.waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
    const count = await locator.count().catch(() => 0);
    if (count === 1) {
      if (await locator.isVisible({ timeout: 750 }).catch(() => false)) return locator;
      errors.push(`candidate matched one non-visible element: ${JSON.stringify(c)}`);
      continue;
    }
    if (count > 1) {
      if (c.strategy === 'role' && c.role && c.name) {
        const exactL = page.getByRole(c.role, { name: c.name, exact: true });
        const exactN = await exactL.count().catch(() => 0);
        if (exactN === 1 && await exactL.isVisible({ timeout: 750 }).catch(() => false)) return exactL;
        if (exactN !== 1) {
          const lname = c.name.toLowerCase();
          const prefixFiltered = [];
          for (let idx = 0; idx < count; idx++) {
            const acc = await locator.nth(idx).evaluate((el) => {
              return (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/^\W+/, '').toLowerCase();
            }).catch(() => '');
            if (acc === lname) prefixFiltered.push(idx);
          }
          if (prefixFiltered.length === 1 && await locator.nth(prefixFiltered[0]).isVisible({ timeout: 750 }).catch(() => false)) {
            return locator.nth(prefixFiltered[0]);
          }
        }
      }
      const context = (c.contextText || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
      if (context.length) {
        const scoped = [];
        for (let index = 0; index < count; index += 1) {
          const ok = await locator.nth(index).evaluate((el, expected) => {
            let node = el;
            for (let depth = 0; node && depth < 5; depth += 1) {
              const text = String(node.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
              if (expected.some((item) => item && text.includes(item))) return true;
              node = node.parentElement;
            }
            return false;
          }, context).catch(() => false);
          if (ok) scoped.push(index);
        }
        if (scoped.length === 1) return locator.nth(scoped[0]);
        errors.push(`candidate context narrowed to ${scoped.length} of ${count} matches for ${JSON.stringify(c)}`);
        continue;
      }
      errors.push(`candidate ambiguous: matched ${count} elements for ${JSON.stringify(c)}`);
      continue;
    }
    // When named-role returns 0 matches the element likely has no accessible name
    // (icon-only buttons, inputs without labels). Fall back to role-only + sibling-
    // attribute proximity: find a same-role element whose parent also contains a
    // sibling with an attribute (placeholder/aria-label/title/name) that matches
    // one of the contextText hints. This handles icon-only submit buttons adjacent
    // to a labeled input without hardcoding any site-specific selector.
    if (count === 0 && c.strategy === 'role' && c.role && c.name) {
      const ctxItems = (c.contextText || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
      if (ctxItems.length) {
        const roleAny = page.getByRole(c.role);
        const roleAnyCount = await roleAny.count().catch(() => 0);
        if (roleAnyCount > 0 && roleAnyCount <= 30) {
          const sibMatch = [];
          for (let i = 0; i < roleAnyCount; i++) {
            const matched = await roleAny.nth(i).evaluate((el, ctx) => {
              let node = el;
              for (let depth = 0; node && depth < 8; depth++) {
                if (node.parentElement) {
                  for (const sib of node.parentElement.children) {
                    if (sib === node) continue;
                    const attrs = [
                      sib.getAttribute('placeholder'),
                      sib.getAttribute('aria-label'),
                      sib.getAttribute('title'),
                      sib.getAttribute('name')
                    ].filter(Boolean).join(' ').toLowerCase();
                    if (ctx.some((c) => attrs.includes(c))) return true;
                  }
                }
                node = node.parentElement;
              }
              return false;
            }, ctxItems).catch(() => false);
            if (matched) sibMatch.push(i);
          }
          if (sibMatch.length === 1) {
            const el = roleAny.nth(sibMatch[0]);
            if (await el.isVisible({ timeout: 750 }).catch(() => false)) return el;
          }
        }
      }
    }
    errors.push(`candidate matched ${count}: ${JSON.stringify(c)}`);
  }
  throw new Error(`Unable to resolve ${label}: ${errors.join('; ')}`);
}

async function assertTextPresent(page, text, _hint, timeoutMs) {
  // Mirror how the live agent verified this: the WHOLE-page accessibility surface —
  // visible TEXT *and* accessible NAMES (aria-label/title/placeholder/alt).
  // The live assertion_check scans the MCP ARIA snapshot, which includes content from
  // accessible-but-non-visible nodes (aria-live regions, role=status, etc.).
  // We accept any match — visible or hidden — to maintain parity with that scope.
  const t = String(text);
  const byText = page.getByText(t, { exact: false });
  const safe = !/["']/.test(t);
  const locator = safe
    ? byText.or(page.locator(`[aria-label*="${t}" i], [title*="${t}" i], [placeholder*="${t}" i], [alt*="${t}" i]`))
    : byText;
  await expect(locator).not.toHaveCount(0, { timeout: timeoutMs });
}

function qaaiEscapeRegex(value) {
  return String(value || '').replace(/[-/\^$*+?.()|[]{}]/g, '\$&');
}

function productLikeLocator(page) {
  return page.locator('[class*="product" i], [data-testid*="product" i], [data-test*="product" i], article, li, tr, .card');
}

async function assertScopedText(page, selector, text, timeoutMs) {
  const scope = page.locator(selector);
  await expect(scope, 'assertion scope must exist before checking text').not.toHaveCount(0, { timeout: timeoutMs });
  await expect(scope.filter({ hasText: String(text) }), 'scoped assertion text must appear inside the recorded container').not.toHaveCount(0, { timeout: timeoutMs });
}

async function assertProductNamesContain(page, expected, timeoutMs) {
  const namePattern = new RegExp(qaaiEscapeRegex(expected), 'i');
  const productMatches = productLikeLocator(page).filter({ hasText: namePattern });
  const namedLinks = page.getByRole('link', { name: namePattern });
  await expect(productMatches.or(namedLinks), 'expected product name must be present in a product/card/link surface').not.toHaveCount(0, { timeout: timeoutMs });
}

async function assertProductCategory(page, expected, timeoutMs) {
  const categoryPattern = new RegExp(qaaiEscapeRegex(expected), 'i');
  const headings = page.getByRole('heading', { name: categoryPattern });
  const productRegion = productLikeLocator(page).filter({ hasText: categoryPattern });
  await expect(headings.or(productRegion), 'expected product category must appear as a heading or product-list context').not.toHaveCount(0, { timeout: timeoutMs });
}

async function assertPricesBetween(page, min, max, timeoutMs) {
  const lower = Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY;
  const upper = Number.isFinite(max) && max > 0 ? max : Number.POSITIVE_INFINITY;
  const surface = productLikeLocator(page);
  await expect(surface, 'price assertion needs product/result containers').not.toHaveCount(0, { timeout: timeoutMs });
  const texts = await surface.evaluateAll((els) => els.map((el) => String(el.textContent || '')).filter(Boolean));
  const prices = [];
  for (const text of texts) {
    const rx = /(?:Rs\.?|₹|\$|£|€)\s*([0-9][0-9,]*(?:\.\d+)?)/gi;
    let match;
    while ((match = rx.exec(text)) !== null) {
      const value = Number(String(match[1] || '').replace(/,/g, ''));
      if (Number.isFinite(value)) prices.push(value);
    }
  }
  if (!prices.length) throw new Error('No product prices were found in the product/result containers.');
  const outside = prices.filter((price) => price < lower || price > upper);
  if (outside.length) throw new Error('Product price range assertion failed. Outside range: ' + outside.join(', ') + '; expected between ' + lower + ' and ' + upper + '.');
}

async function dismissKnownPopups(page, candidates) {
  for (const c of candidates) {
    const locator = await resolveLocator(page, [c], 'known popup').catch(() => null);
    if (locator && await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
      await locator.click();
    }
  }
}

async function dismissCommonOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const closeByRole = page.getByRole('button', { name: /^(close|dismiss|no thanks|not now|skip|×|x)$/i });
  const count = Math.min(await closeByRole.count().catch(() => 0), 5);
  for (let i = 0; i < count; i += 1) {
    const btn = closeByRole.nth(i);
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
      await btn.click({ timeout: 1000 }).catch(() => {});
    }
  }
}

async function safeClick(page, locator, popupCandidates = []) {
  try {
    await locator.click();
    return;
  } catch (err) {
    const message = String((err && err.message) || err || '');
    if (!/intercept|obscur|covered|receives pointer events|not visible|detached|timeout/i.test(message)) throw err;
    await dismissKnownPopups(page, popupCandidates).catch(() => {});
    await dismissCommonOverlays(page).catch(() => {});
    await locator.click();
  }
}

function readEnv(name) {
  const value = process.env[name];
  if (value == null) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function readData(row, key, options = {}) {
  const required = options.required !== false;
  const type = options.type || 'string';
  const raw = row && row.fields && row.fields[key];
  const label = row && row.label || 'data row';
  const explicitBlank = raw === '<empty>' || raw === '<blank>' || raw === '<null>';
  if (raw == null || raw === '' || explicitBlank) {
    if (!required) return options.defaultValue != null ? options.defaultValue : (type === 'number' ? 0 : type === 'boolean' ? false : '');
    if (explicitBlank && type === 'string') return '';
    throw new Error(`QAAI data contract: required field "${key}" is empty for ${label}`);
  }
  const value = String(raw).trim();
  if (type === 'number') {
    const num = Number(value.replace(/,/g, ''));
    if (!Number.isFinite(num)) throw new Error(`QAAI data contract: field "${key}" for ${label} must be numeric, got "${value}"`);
    return num;
  }
  if (type === 'boolean') {
    if (/^(true|1|yes|y)$/i.test(value)) return true;
    if (/^(false|0|no|n)$/i.test(value)) return false;
    throw new Error(`QAAI data contract: field "${key}" for ${label} must be boolean, got "${value}"`);
  }
  return value;
}

function loadDataRows(relPath) {
  const full = path.resolve(process.cwd(), relPath);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Data file ${relPath} must contain an array of rows`);
  return parsed;
}

const _A11Y_IMPACT = { minor: 0, moderate: 1, serious: 2, critical: 3 };

async function checkAccessibility(page, minImpact = 'critical') {
  const minLevel = _A11Y_IMPACT[minImpact] != null ? _A11Y_IMPACT[minImpact] : 3;
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter(
    (v) => (_A11Y_IMPACT[v.impact || 'critical'] != null ? _A11Y_IMPACT[v.impact || 'critical'] : 3) >= minLevel
  );
  if (violations.length > 0) {
    const summary = violations.map((v) => `${v.id}(${v.impact}): ${v.description}`).join('\n  ');
    throw new Error(`Accessibility violations [${violations.length}] at impact >= "${minImpact}":\n  ${summary}`);
  }
}

// EVALUATE fidelity: re-run the recorded browser script against a SETTLED page and survive a
// mid-evaluate navigation by retrying once. Uses 'load' not 'networkidle' — networkidle hangs
// permanently on ad-heavy SPAs and resolves before render on fast SPAs; 'load' is deterministic.
async function evaluateSettled(page, fn) {
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
  try {
    return await page.evaluate(fn);
  } catch (e) {
    if (/Execution context was destroyed|context was destroyed|navigation|detached/i.test(String(e && e.message))) {
      await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
      return await page.evaluate(fn);
    }
    throw e;
  }
}

export { resolveLocator, assertTextPresent, assertScopedText, assertProductNamesContain, assertProductCategory, assertPricesBetween, dismissKnownPopups, safeClick, readEnv, readData, loadDataRows, checkAccessibility, evaluateSettled };
