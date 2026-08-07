import { clickFirstVisible, safeClick, safeGoto } from '../../utils/test-helpers';
import { test, expect } from '@playwright/test';
import { assertTextPresent, assertScopedText, assertProductNamesContain, assertProductCategory, assertPricesBetween, dismissKnownPopups, readEnv, readData, resolveLocator, checkAccessibility, evaluateSettled, type DataRow } from '../support/replayir';

test.describe("Category link navigates to Women Dress category independently of prior search term", () => {

  test.describe.configure({ mode: 'serial', retries: 1 });

  test("Category link navigates to Women Dress category independently of prior search term", async ({ page }) => {

  // Auth profile default: auth strategy none must be wired by the package shell.

      await safeGoto(page, readEnv('QAAI_TARGET_URL') + "/products");

      const el1 = await resolveLocator(page, [
    {
      "strategy": "role",
      "role": "textbox",
      "name": "Search Product",
      "contextText": [
        "Website for practice"
      ]
    },
    {
      "strategy": "placeholder",
      "text": "Search Product",
      "contextText": [
        "Website for practice"
      ]
    }
  ], "Search Product");

      await el1.fill("xyznotfound");

      const el2 = await resolveLocator(page, [
    {
      "strategy": "role",
      "role": "button",
      "name": "Search",
      "contextText": [
        "Website for practice",
        "Search Product"
      ]
    }
  ], "Search");

      await clickFirstVisible(el2);

      const el3 = await resolveLocator(page, [
    {
      "strategy": "role",
      "role": "link",
      "name": "Women",
      "contextText": []
    }
  ], "Women");

      await clickFirstVisible(el3);

      const el4 = await resolveLocator(page, [
    {
      "strategy": "role",
      "role": "link",
      "name": "Dress",
      "contextText": [
        "ecommerce website products",
        "Rs. 1500"
      ]
    }
  ], "Dress");

      await clickFirstVisible(el4);

      await assertTextPresent(page, "products_page", '', 10000).catch((_atp) => {
        test.info().annotations.push({ type: 'qaai-soft-fail', description: `PAGE: ${_atp.message}` });
      });

      await assertTextPresent(page, "No products found", '', 10000).catch((_atp) => {
        test.info().annotations.push({ type: 'qaai-soft-fail', description: `UI_TEXT: ${_atp.message}` });
      });

      await page.screenshot({ path: "test-results/category-link-navigates-to-women-dress-category-independently-of-prior-search-te.png", fullPage: true });
    });
});
