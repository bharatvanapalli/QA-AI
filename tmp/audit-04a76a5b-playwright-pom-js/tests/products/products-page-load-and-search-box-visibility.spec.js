import { test, expect } from '@playwright/test';
import { assertScopedText, assertProductCategory } from '../support/replayir.js';

test.describe("Products Page Load and Search Box Visibility", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test("Products page loads and displays product listing without authentication", async ({ page }) => {
    await page.goto("/products");
    await assertProductCategory(page, "All Products", 10000);
    await assertScopedText(page, ".features_items, .productinfo, .single-products, .product-image-wrapper, [class*=\"product\"], [id*=\"product\"]", "Rs.", 10000);
    await page.screenshot({ path: "test-results/products-page-loads-and-displays-product-listing-without-authentication.png", fullPage: true });
  });

  test("Search box is visible on the Products page", async ({ page }) => {
    await page.goto("/products");
    await expect(page.getByPlaceholder("Search Product")).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: "test-results/search-box-is-visible-on-the-products-page.png", fullPage: true });
  });

  test("Category filter list is visible with expected options on Products page", async ({ page }) => {
    await page.goto("/products");
    await expect(page.getByRole('link', { name: new RegExp("^Women$", 'i') })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('link', { name: new RegExp("^Men$", 'i') })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('link', { name: new RegExp("^Kids$", 'i') })).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: "test-results/category-filter-list-is-visible-with-expected-options-on-products-page.png", fullPage: true });
  });
});
