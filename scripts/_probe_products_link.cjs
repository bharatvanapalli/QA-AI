"use strict";
const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("https://automationexercise.com/");
  await page.waitForLoadState("networkidle").catch(() => {});

  // Check Products link
  const prodLinks = page.getByRole("link", { name: "Products" });
  const count = await prodLinks.count();
  console.log("getByRole('link', {name:'Products'}) count:", count);

  // Check if click would be actionable
  if (count > 0) {
    const visible = await prodLinks.first().isVisible().catch(() => false);
    console.log("First Products link visible:", visible);
    const href = await prodLinks.first().getAttribute("href").catch(() => null);
    console.log("First Products link href:", href);
  }
  if (count > 1) {
    for (let i = 0; i < count; i++) {
      const href = await prodLinks.nth(i).getAttribute("href").catch(() => null);
      const txt = await prodLinks.nth(i).textContent().catch(() => null);
      console.log(`  [${i}] href="${href}" text="${txt?.trim()}"`);
    }
  }

  // Also check "Features Items" / "All Products" text
  await page.click("a[href='/products']").catch(async e => {
    console.log("Direct click /products failed:", e.message.slice(0,80));
    await page.goto("https://automationexercise.com/products");
  });
  await page.waitForLoadState("networkidle").catch(() => {});

  const featText = page.getByText("Features Items", { exact: false });
  console.log("\ngetByText('Features Items') count:", await featText.count());
  const allProd = page.getByText("All Products", { exact: false });
  console.log("getByText('All Products') count:", await allProd.count());

  await browser.close();
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
