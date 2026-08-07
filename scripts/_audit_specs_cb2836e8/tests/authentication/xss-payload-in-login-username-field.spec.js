const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("XSS Payload in Login Username Field", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── XSS payload in username is not executed and no alert fires ──────
    await test.step("XSS payload in username is not executed and no alert fires", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill("<script>alert('xss')</script>");
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      await assertTextPresent(page, "Username", "ASN-adccbf65", 10000);
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var scripts = document.querySelectorAll('script'); var injected = Array.from(scripts).some(s => s.textContent.includes('alert') && !s.src); return !injected; })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-1c501bf0: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-1c501bf0: expected \"true\"").toContain("true");
      }
      {
        const _evalResult = String(await evaluateSettled(page, () => (Array.from(document.querySelectorAll('*')).every(el => !el.innerHTML.includes('<script>alert')))).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-b001368f: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-b001368f: expected \"true\"").toContain("true");
      }
      await page.screenshot({ path: "test-results/xss-payload-in-username-is-not-executed-and-no-alert-fires.png", fullPage: true });
    });

    // ─── XSS payload via img onerror attribute is not executed ───────────
    await test.step("XSS payload via img onerror attribute is not executed", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill("<img src=x onerror=alert(1)>");
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      await assertTextPresent(page, "Username", "ASN-fc773f04", 10000);
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var imgs = Array.from(document.querySelectorAll('img')).filter(img => img.getAttribute('onerror') && img.getAttribute('onerror').includes('alert')); return imgs.length === 0; })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-056880ce: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-056880ce: expected \"true\"").toContain("true");
      }
      await page.screenshot({ path: "test-results/xss-payload-via-img-onerror-attribute-is-not-executed.png", fullPage: true });
    });
  });
});
