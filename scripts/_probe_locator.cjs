"use strict";
// Probe automationexercise.com/products to see what role/name the category links have
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("https://automationexercise.com/products");
  await page.waitForLoadState("networkidle").catch(() => {});

  // Dismiss any overlay
  await page.evaluate(() => {
    const overlays = document.querySelectorAll("[id*='google'], [class*='adsbygoogle'], iframe[src*='google']");
    overlays.forEach(el => { try { el.remove(); } catch(e) {} });
  });

  // Find all links and report accessible names
  const links = await page.evaluate(() => {
    const allLinks = Array.from(document.querySelectorAll('a'));
    return allLinks
      .filter(a => {
        const txt = (a.textContent || '').trim();
        return /Women|Men|Kids|Dress|T-shirts|Tops|Tshirts|category/i.test(txt) ||
               /Women|Men|Kids|Dress/i.test(a.getAttribute('aria-label') || '');
      })
      .map(a => ({
        text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        ariaLabel: a.getAttribute('aria-label'),
        title: a.getAttribute('title'),
        href: a.getAttribute('href'),
        ariaExpanded: a.getAttribute('aria-expanded'),
        id: a.id
      }));
  });

  console.log("Category-related links on /products:");
  links.forEach(l => console.log(JSON.stringify(l)));

  // Also try to get the element the spec would look for
  const womenEl = page.getByRole("link", { name: "Women category" });
  const count = await womenEl.count();
  console.log("\ngetByRole('link', {name:'Women category'}) count:", count);

  const womenEl2 = page.getByRole("link", { name: "Women" });
  const count2 = await womenEl2.count();
  console.log("getByRole('link', {name:'Women'}) count:", count2);

  // Try text-based
  const womenText = page.getByText("Women", { exact: true });
  const count3 = await womenText.count();
  console.log("getByText('Women', exact:true) count:", count3);

  await browser.close();
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
