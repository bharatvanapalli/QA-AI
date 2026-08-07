import { test, expect } from '@playwright/test';
import { assertScopedText, readData, loadDataRows } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Triple Filter Combination — Zero Matches Empty State", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  const _dataRows0 = loadDataRows("tests/data/category-link-navigates-to-category-page-independently-of-prior-search-term.json");
  for (const row of _dataRows0) {
    test("Category link navigates to category page independently of prior search term [" + row.label + ']', async ({ page }) => {
      const productsPage = new ProductsPage(page);
      await page.goto("/products");
      await productsPage.searchForProduct(readData(row, "searchProduct"));
      await productsPage.selectCategory("Women", "Dress");
      await expect(page.getByPlaceholder("Search Product")).toBeVisible({ timeout: 10000 });
      await assertScopedText(page, ".features_items, .productinfo, .single-products, .product-image-wrapper, [class*=\"product\"], [id*=\"product\"]", "No products found", 10000);
      await page.screenshot({ path: "test-results/category-link-navigates-to-category-page-independently-of-prior-search-term.png", fullPage: true });
    });
  }
});
