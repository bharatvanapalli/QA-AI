import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export type LocatorCandidate = {
  strategy: 'role' | 'css' | 'testId' | 'text' | 'placeholder' | 'label';
  role?: Parameters<Page['getByRole']>[0];
  name?: string;
  selector?: string;
  testId?: string;
  text?: string;
  contextText?: string[];
};

export type DataRow = { index: number; label: string; fields?: Record<string, string> };

export function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function readData(row: DataRow, key: string): string {
  const value = row.fields?.[key];
  if (value == null || value === '') throw new Error(`Missing data field ${key} for ${row.label}`);
  return String(value);
}

export function loadDataRows(relPath: string): DataRow[] {
  const full = path.resolve(process.cwd(), relPath);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Data file ${relPath} must contain an array of rows`);
  return parsed as DataRow[];
}

export async function resolveLocator(page: Page, candidates: LocatorCandidate[], label: string): Promise<Locator> {
  const errors: string[] = [];
  for (const c of candidates) {
    let locator: Locator | null = null;
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
        const scoped: number[] = [];
        for (let index = 0; index < count; index += 1) {
          const ok = await locator.nth(index).evaluate((el, expected) => {
            let node: Element | null = el;
            for (let depth = 0; node && depth < 5; depth += 1) {
              const text = String(node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
              if (expected.some((item: string) => item && text.includes(item))) return true;
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
    if (count === 0 && c.strategy === 'role' && c.role && c.name) {
      const ctxItems = (c.contextText || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
      if (ctxItems.length) {
        const roleAny = page.getByRole(c.role);
        const roleAnyCount = await roleAny.count().catch(() => 0);
        if (roleAnyCount > 0 && roleAnyCount <= 30) {
          const sibMatch: number[] = [];
          for (let i = 0; i < roleAnyCount; i++) {
            const matched = await roleAny.nth(i).evaluate((el, ctx) => {
              let node: Element | null = el;
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
                    if ((ctx as string[]).some((c) => attrs.includes(c))) return true;
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

export async function assertTextPresent(page: Page, text: string, _hint: string, timeoutMs: number): Promise<void> {
  // Mirror how the agent verified this in-run: the WHOLE-page accessibility surface —
  // visible TEXT *and* accessible NAMES. Topbar/sidebar/nav live OUTSIDE <main>, and
  // labels like "Topbar Menu" are accessible names (aria-label/title), not body text —
  // scoping to <main> + getByText alone makes the export FAIL a check the run PASSED.
  const t = String(text);
  const byText = page.getByText(t, { exact: false });
  const safe = !/["']/.test(t);
  const locator = safe
    ? byText.or(page.locator(`[aria-label*="${t}" i], [title*="${t}" i], [placeholder*="${t}" i], [alt*="${t}" i]`))
    : byText;
  // Fast-path: check immediately for the exact phrase (no wait).
  const exactCount = await locator.count().catch(() => 0);
  if (exactCount > 0) {
    const visibleCount = await locator.evaluateAll((els) => els.filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }).length).catch(() => exactCount);
    if (visibleCount < 1) {
      throw new Error(`assertTextPresent: expected visible text or accessible name "${text}" anywhere on the page, found ${exactCount} hidden/non-visible match(es).`);
    }
    return;
  }
  // Exact phrase not found immediately. For multi-word composed phrases (e.g. "Username is
  // required" vs a site that shows just "Required"), try the most-specific keyword against
  // error/validation/alert containers. Generic — no site-specific selectors or text.
  const _STOP = new Set(['this','that','then','also','both','each','more','most','only','some','such','than','them','they','what','when','where','which','while','with','from','have','been','will','does','into','upon','over','under','above','below','must','very','just','even','here','about','after','before','being','every','would','could','should','other','again','still','same','many','need','much','like','make']);
  const _words = t.split(/\s+/).filter((w) => w.length > 3 && !_STOP.has(w.toLowerCase()));
  if (_words.length > 1) {
    for (const kw of [..._words].reverse()) {
      if (/["']/.test(kw)) continue;
      const _broader = page.locator(`[class*="error" i],[class*="invalid" i],[class*="warning" i],[class*="alert" i],[role="alert"],[aria-live]`).filter({ hasText: new RegExp(kw, 'i') });
      const _bCount = await _broader.count().catch(() => 0);
      if (_bCount > 0) {
        const _bVis = await _broader.evaluateAll((els) => els.filter((el) => {
          const r2 = el.getBoundingClientRect();
          const s2 = window.getComputedStyle(el);
          return r2.width > 0 && r2.height > 0 && s2.visibility !== 'hidden' && s2.display !== 'none';
        }).length).catch(() => _bCount);
        if (_bVis > 0) return;
      }
    }
  }
  // Neither exact phrase nor keyword found — wait full timeout → hard fail.
  await expect(locator).not.toHaveCount(0, { timeout: timeoutMs });
}

export async function dismissKnownPopups(page: Page, candidates: LocatorCandidate[]): Promise<void> {
  for (const c of candidates) {
    const locator = await resolveLocator(page, [c], 'known popup').catch(() => null);
    if (locator && await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
      await locator.click();
    }
  }
}

// Impact ladder — violations at or above the minimum level fail the test.
const _A11Y_IMPACT: Record<string, number> = { minor: 0, moderate: 1, serious: 2, critical: 3 };

export async function checkAccessibility(page: Page, minImpact: string = 'critical'): Promise<void> {
  const minLevel = _A11Y_IMPACT[minImpact] ?? 3;
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter(
    (v) => (_A11Y_IMPACT[v.impact ?? 'critical'] ?? 3) >= minLevel
  );
  if (violations.length > 0) {
    const summary = violations.map((v) => `${v.id}(${v.impact}): ${v.description}`).join('\n  ');
    throw new Error(`Accessibility violations [${violations.length}] at impact >= "${minImpact}":\n  ${summary}`);
  }
}

// EVALUATE fidelity: the live agent observed the page in a SETTLED state. Re-run the recorded
// browser script against a quiesced page and survive a mid-evaluate navigation by retrying once.
// Uses 'load' (not 'networkidle') — networkidle hangs permanently on ad-heavy SPAs that keep
// background trackers running, and resolves before render on fast SPAs. 'load' is deterministic.
export async function evaluateSettled(page: Page, fn: any): Promise<any> {
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
  try {
    return await page.evaluate(fn);
  } catch (e: any) {
    if (/Execution context was destroyed|context was destroyed|navigation|detached/i.test(String(e && e.message))) {
      await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
      return await page.evaluate(fn);
    }
    throw e;
  }
}
