import { test } from '@playwright/test';
import { assertScopedText, assertProductCategory } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Category Filter — Happy Path", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test("Selecting Women > Dress category shows only Women Dress products", async ({ page }) => {
    const productsPage = new ProductsPage(page);
    await page.goto("/products");
    await productsPage.clickWomenCategoryHeading();
    await productsPage.clickDress();
    await assertProductCategory(page, "Women - Dress Products", 10000);
    await assertScopedText(page, ".features_items, [class*='product'], [class*='col-sm-9']", "Rs.", 10000);
    await page.screenshot({ path: "test-results/selecting-women-dress-category-shows-only-women-dress-products.png", fullPage: true });
  });

  test("Selecting Men > Tshirts category shows only Men Tshirts products", async ({ page }) => {
    const productsPage = new ProductsPage(page);
    await page.goto("/products");
    await productsPage.clickMenCategoryHeading();
    await productsPage.clickTshirts();
    await assertProductCategory(page, "Men - Tshirts Products", 10000);
    await page.screenshot({ path: "test-results/selecting-men-tshirts-category-shows-only-men-tshirts-products.png", fullPage: true });
  });
});
