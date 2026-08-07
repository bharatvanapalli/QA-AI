import { test } from '@playwright/test';
import { assertScopedText, assertProductCategory, readData, loadDataRows } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Search Clear Resets Product Grid", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  const _dataRows0 = loadDataRows("tests/data/clearing-search-input-restores-full-product-grid.json");
  for (const row of _dataRows0) {
    test("Clearing search input restores full product grid [" + row.label + ']', async ({ page }) => {
      const productsPage = new ProductsPage(page);
      await page.goto("/products");
      await productsPage.searchForProduct(readData(row, "searchProduct"));
      await assertProductCategory(page, "All Products", 10000);
      await assertScopedText(page, ".features_items, .productinfo, .single-products, .product-image-wrapper, [class*=\"product\"], [id*=\"product\"]", "Rs.", 10000);
      await page.screenshot({ path: "test-results/clearing-search-input-restores-full-product-grid.png", fullPage: true });
    });
  }
});
