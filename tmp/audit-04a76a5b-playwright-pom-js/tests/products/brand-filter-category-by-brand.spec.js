import { test } from '@playwright/test';
import { assertScopedText, assertProductCategory } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Brand Filter — Category by Brand", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test("Selecting Polo brand shows only Polo brand products", async ({ page }) => {
    const productsPage = new ProductsPage(page);
    await page.goto("/products");
    await productsPage.selectBrand("Polo");
    await assertProductCategory(page, "Brand - Polo Products", 10000);
    await assertScopedText(page, ".features_items, .productinfo, .single-products, .product-image-wrapper, [class*=\"product\"], [id*=\"product\"]", "Rs.", 10000);
    await page.screenshot({ path: "test-results/selecting-polo-brand-shows-only-polo-brand-products.png", fullPage: true });
  });
});
