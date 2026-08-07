import { test, expect, type Locator, type Page } from '@playwright/test';

type LocatorCandidate = {
  strategy: 'role' | 'css' | 'testId' | 'text' | 'placeholder' | 'label';
  role?: Parameters<Page['getByRole']>[0];
  name?: string;
  selector?: string;
  testId?: string;
  text?: string;
};

type DataRow = { index: number; label: string; fields?: Record<string, string> };

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function readData(row: DataRow, key: string): string {
  const value = row.fields?.[key];
  if (value == null || value === '') throw new Error(`Missing data field ${key} for ${row.label}`);
  return String(value);
}

async function resolveLocator(page: Page, candidates: LocatorCandidate[], label: string): Promise<Locator> {
  const errors: string[] = [];
  for (const c of candidates) {
    let locator: Locator | null = null;
    if (c.strategy === 'role' && c.role) locator = c.name ? page.getByRole(c.role, { name: c.name }) : page.getByRole(c.role);
    if (c.strategy === 'css' && c.selector) locator = page.locator(c.selector);
    if (c.strategy === 'testId' && c.testId) locator = page.getByTestId(c.testId);
    if (c.strategy === 'text' && c.text) locator = page.getByText(c.text);
    if (c.strategy === 'placeholder' && c.text) locator = page.getByPlaceholder(c.text);
    if (c.strategy === 'label' && c.text) locator = page.getByLabel(c.text);
    if (!locator) {
      errors.push(`unsupported candidate ${JSON.stringify(c)}`);
      continue;
    }
    await locator.first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    const count = await locator.count().catch(() => 0);
    if (count === 1) {
      const only = locator.first();
      if (await only.isVisible({ timeout: 750 }).catch(() => false)) return only;
      errors.push(`candidate matched one non-visible element: ${JSON.stringify(c)}`);
      continue;
    }
    if (count > 1) {
      errors.push(`candidate ambiguous: matched ${count} elements for ${JSON.stringify(c)}`);
      continue;
    }
    errors.push(`candidate matched ${count}: ${JSON.stringify(c)}`);
  }
  throw new Error(`Unable to resolve ${label}: ${errors.join('; ')}`);
}

async function assertUniqueVisibleText(page: Page, text: string, contractRef: string, timeoutMs: number): Promise<void> {
  const locator = page.getByText(text, { exact: false });
  await locator.first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  const count = await locator.count().catch(() => 0);
  if (count !== 1) {
    throw new Error(`Assertion ${contractRef || 'unknown'} expected exactly one visible text match for "${text}", found ${count}. The oracle is ambiguous and must be scoped by MCP evidence.`);
  }
  await expect(locator.first()).toBeVisible({ timeout: timeoutMs });
}

async function dismissKnownPopups(page: Page, candidates: LocatorCandidate[]): Promise<void> {
  for (const c of candidates) {
    const locator = await resolveLocator(page, [c], 'known popup').catch(() => null);
    if (locator && await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
      await locator.click();
    }
  }
}

test.describe("QAAI ReplayIR e3183ae3-b4fe-43ae-a796-7354e20745f6", () => {

  test.describe.configure({ mode: 'serial', retries: 1 });

  const dataRows: DataRow[] = [
    {
      "index": 0,
      "label": "default",
      "fields": {}
    }
  ];

  for (const row of dataRows) {
    test(row.label, async ({ page }) => {

  // Auth profile default: auth strategy none must be wired by the package shell.

      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");

      const el1 = await resolveLocator(page, [
    {
      "strategy": "role",
      "role": "textbox",
      "name": "Username"
    },
    {
      "strategy": "placeholder",
      "text": "Username"
    },
    {
      "strategy": "label",
      "text": "Username"
    },
    {
      "strategy": "text",
      "text": "Username"
    }
  ], "el1");

      await el1.fill(readEnv("QAAI_USERNAME"));

      const el2 = await resolveLocator(page, [
    {
      "strategy": "placeholder",
      "text": "Password"
    },
    {
      "strategy": "label",
      "text": "Password"
    },
    {
      "strategy": "role",
      "role": "textbox",
      "name": "Password"
    },
    {
      "strategy": "text",
      "text": "Password"
    }
  ], "el2");

      await el2.fill(readEnv("QAAI_PASSWORD"));

      const el3 = await resolveLocator(page, [
    {
      "strategy": "text",
      "text": "Login button"
    },
    {
      "strategy": "role",
      "role": "button",
      "name": "Login"
    },
    {
      "strategy": "text",
      "text": "Login"
    }
  ], "el3");

      await el3.click();

      await assertUniqueVisibleText(page, "Dashboard", "ASN-ed4b5020", 10000);

      await assertUniqueVisibleText(page, "PIM", "ASN-fc9e9304", 10000);

      await page.screenshot({ path: "test-results/e3183ae3-b4fe-43ae-a796-7354e20745f6.png", fullPage: true });
    });
  }
});
