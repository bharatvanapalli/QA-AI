# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: uncategorized\category-link-navigates-to-women-dress-category-independently-of-prior-search-te.spec.ts >> Category link navigates to Women Dress category independently of prior search term >> Category link navigates to Women Dress category independently of prior search term
- Location: tests\uncategorized\category-link-navigates-to-women-dress-category-independently-of-prior-search-te.spec.ts:9:7

# Error details

```
Error: QAAI parity: original browser run failed (browser run recorded a failed verdict). Generated script must not pass until the failing assertion is repaired or recaptured.
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - generic [ref=e5]:
      - link "Website for automation practice" [ref=e8] [cursor=pointer]:
        - /url: /
        - img "Website for automation practice" [ref=e9]
      - list [ref=e12]:
        - listitem [ref=e13]:
          - link " Home" [ref=e14] [cursor=pointer]:
            - /url: /
            - generic [ref=e15]: 
            - text: Home
        - listitem [ref=e16]:
          - link " Products" [ref=e17] [cursor=pointer]:
            - /url: /products
            - generic [ref=e18]: 
            - text: Products
        - listitem [ref=e19]:
          - link " Cart" [ref=e20] [cursor=pointer]:
            - /url: /view_cart
            - generic [ref=e21]: 
            - text: Cart
        - listitem [ref=e22]:
          - link " Signup / Login" [ref=e23] [cursor=pointer]:
            - /url: /login
            - generic [ref=e24]: 
            - text: Signup / Login
        - listitem [ref=e25]:
          - link " Test Cases" [ref=e26] [cursor=pointer]:
            - /url: /test_cases
            - generic [ref=e27]: 
            - text: Test Cases
        - listitem [ref=e28]:
          - link " API Testing" [ref=e29] [cursor=pointer]:
            - /url: /api_list
            - generic [ref=e30]: 
            - text: API Testing
        - listitem [ref=e31]:
          - link " Video Tutorials" [ref=e32] [cursor=pointer]:
            - /url: https://www.youtube.com/c/AutomationExercise
            - generic [ref=e33]: 
            - text: Video Tutorials
        - listitem [ref=e34]:
          - link " Contact us" [ref=e35] [cursor=pointer]:
            - /url: /contact_us
            - generic [ref=e36]: 
            - text: Contact us
  - generic [ref=e38]:
    - list [ref=e40]:
      - listitem [ref=e41]:
        - link "Products" [ref=e42] [cursor=pointer]:
          - /url: /products
      - listitem [ref=e43]: Women > Dress
    - generic [ref=e44]:
      - generic [ref=e46]:
        - heading "Category" [level=2] [ref=e47]
        - generic [ref=e48]:
          - heading " Women" [level=4] [ref=e51]:
            - link " Women" [ref=e52] [cursor=pointer]:
              - /url: "#Women"
              - generic [ref=e54]: 
              - text: Women
          - heading " Men" [level=4] [ref=e57]:
            - link " Men" [ref=e58] [cursor=pointer]:
              - /url: "#Men"
              - generic [ref=e60]: 
              - text: Men
          - heading " Kids" [level=4] [ref=e63]:
            - link " Kids" [ref=e64] [cursor=pointer]:
              - /url: "#Kids"
              - generic [ref=e66]: 
              - text: Kids
        - generic [ref=e67]:
          - heading "Brands" [level=2] [ref=e68]
          - list [ref=e70]:
            - listitem [ref=e71]:
              - link "(6) Polo" [ref=e72] [cursor=pointer]:
                - /url: /brand_products/Polo
                - generic [ref=e73]: (6)
                - text: Polo
            - listitem [ref=e74]:
              - link "(5) H&M" [ref=e75] [cursor=pointer]:
                - /url: /brand_products/H&M
                - generic [ref=e76]: (5)
                - text: H&M
            - listitem [ref=e77]:
              - link "(5) Madame" [ref=e78] [cursor=pointer]:
                - /url: /brand_products/Madame
                - generic [ref=e79]: (5)
                - text: Madame
            - listitem [ref=e80]:
              - link "(3) Mast & Harbour" [ref=e81] [cursor=pointer]:
                - /url: /brand_products/Mast & Harbour
                - generic [ref=e82]: (3)
                - text: Mast & Harbour
            - listitem [ref=e83]:
              - link "(4) Babyhug" [ref=e84] [cursor=pointer]:
                - /url: /brand_products/Babyhug
                - generic [ref=e85]: (4)
                - text: Babyhug
            - listitem [ref=e86]:
              - link "(3) Allen Solly Junior" [ref=e87] [cursor=pointer]:
                - /url: /brand_products/Allen Solly Junior
                - generic [ref=e88]: (3)
                - text: Allen Solly Junior
            - listitem [ref=e89]:
              - link "(3) Kookie Kids" [ref=e90] [cursor=pointer]:
                - /url: /brand_products/Kookie Kids
                - generic [ref=e91]: (3)
                - text: Kookie Kids
            - listitem [ref=e92]:
              - link "(5) Biba" [ref=e93] [cursor=pointer]:
                - /url: /brand_products/Biba
                - generic [ref=e94]: (5)
                - text: Biba
      - generic [ref=e96]:
        - heading "Women - Dress Products" [level=2] [ref=e97]
        - generic [ref=e99]:
          - generic [ref=e100]:
            - generic [ref=e101]:
              - img "ecommerce website products" [ref=e102]
              - heading "Rs. 1000" [level=2] [ref=e103]
              - paragraph [ref=e104]: Sleeveless Dress
              - link " Add to cart" [ref=e105] [cursor=pointer]:
                - /url: javascript:void();
                - generic [ref=e106]: 
                - text: Add to cart
            - generic [ref=e107]:
              - heading "Rs. 1000" [level=2] [ref=e108]
              - paragraph [ref=e109]: Sleeveless Dress
              - link " Add to cart" [ref=e110] [cursor=pointer]:
                - /url: javascript:void();
                - generic [ref=e111]: 
                - text: Add to cart
          - list [ref=e113]:
            - listitem [ref=e114]:
              - link " View Product" [ref=e115] [cursor=pointer]:
                - /url: /product_details/3
                - generic [ref=e116]: 
                - text: View Product
        - generic [ref=e118]:
          - generic [ref=e119]:
            - generic [ref=e120]:
              - img "ecommerce website products" [ref=e121]
              - heading "Rs. 1500" [level=2] [ref=e122]
              - paragraph [ref=e123]: Stylish Dress
              - link " Add to cart" [ref=e124] [cursor=pointer]:
                - /url: javascript:void();
                - generic [ref=e125]: 
                - text: Add to cart
            - generic [ref=e126]:
              - heading "Rs. 1500" [level=2] [ref=e127]
              - paragraph [ref=e128]: Stylish Dress
              - link " Add to cart" [ref=e129] [cursor=pointer]:
                - /url: javascript:void();
                - generic [ref=e130]: 
                - text: Add to cart
          - list [ref=e132]:
            - listitem [ref=e133]:
              - link " View Product" [ref=e134] [cursor=pointer]:
                - /url: /product_details/4
                - generic [ref=e135]: 
                - text: View Product
        - generic [ref=e137]:
          - generic [ref=e138]:
            - generic [ref=e139]:
              - img "ecommerce website products" [ref=e140]
              - heading "Rs. 2300" [level=2] [ref=e141]
              - paragraph [ref=e142]: Rose Pink Embroidered Maxi Dress
              - link " Add to cart" [ref=e143] [cursor=pointer]:
                - /url: javascript:void();
                - generic [ref=e144]: 
                - text: Add to cart
            - generic [ref=e145]:
              - heading "Rs. 2300" [level=2] [ref=e146]
              - paragraph [ref=e147]: Rose Pink Embroidered Maxi Dress
              - link " Add to cart" [ref=e148] [cursor=pointer]:
                - /url: javascript:void();
                - generic [ref=e149]: 
                - text: Add to cart
          - list [ref=e151]:
            - listitem [ref=e152]:
              - link " View Product" [ref=e153] [cursor=pointer]:
                - /url: /product_details/38
                - generic [ref=e154]: 
                - text: View Product
  - contentinfo [ref=e155]:
    - generic [ref=e160]:
      - heading "Subscription" [level=2] [ref=e161]
      - generic [ref=e162]:
        - textbox "Your email address" [ref=e163]
        - button "" [ref=e164] [cursor=pointer]:
          - generic [ref=e165]: 
        - paragraph [ref=e166]:
          - text: Get the most recent updates from
          - text: our site and be updated your self...
    - paragraph [ref=e170]: Copyright © 2021 All rights reserved
  - text: 
```

# Test source

```ts
  1  | import { clickFirstVisible, safeClick, safeGoto } from '../../utils/test-helpers';
  2  | import { test, expect } from '@playwright/test';
  3  | import { assertTextPresent, assertScopedText, assertProductNamesContain, assertProductCategory, assertPricesBetween, dismissKnownPopups, readEnv, readData, resolveLocator, checkAccessibility, evaluateSettled, type DataRow } from '../support/replayir';
  4  | 
  5  | test.describe("Category link navigates to Women Dress category independently of prior search term", () => {
  6  | 
  7  |   test.describe.configure({ mode: 'serial', retries: 1 });
  8  | 
  9  |   test("Category link navigates to Women Dress category independently of prior search term", async ({ page }) => {
  10 | 
  11 |   // Auth profile default: auth strategy none must be wired by the package shell.
  12 | 
  13 |       await safeGoto(page, readEnv('QAAI_TARGET_URL') + "/products");
  14 | 
  15 |       const el1 = await resolveLocator(page, [
  16 |     {
  17 |       "strategy": "role",
  18 |       "role": "textbox",
  19 |       "name": "Search Product",
  20 |       "contextText": [
  21 |         "Website for practice"
  22 |       ]
  23 |     },
  24 |     {
  25 |       "strategy": "placeholder",
  26 |       "text": "Search Product",
  27 |       "contextText": [
  28 |         "Website for practice"
  29 |       ]
  30 |     }
  31 |   ], "Search Product");
  32 | 
  33 |       await el1.fill("xyznotfound");
  34 | 
  35 |       const el2 = await resolveLocator(page, [
  36 |     {
  37 |       "strategy": "role",
  38 |       "role": "button",
  39 |       "name": "Search",
  40 |       "contextText": [
  41 |         "Website for practice",
  42 |         "Search Product"
  43 |       ]
  44 |     }
  45 |   ], "Search");
  46 | 
  47 |       await clickFirstVisible(el2);
  48 | 
  49 |       const el3 = await resolveLocator(page, [
  50 |     {
  51 |       "strategy": "role",
  52 |       "role": "link",
  53 |       "name": "Women",
  54 |       "contextText": []
  55 |     }
  56 |   ], "Women");
  57 | 
  58 |       await clickFirstVisible(el3);
  59 | 
  60 |       const el4 = await resolveLocator(page, [
  61 |     {
  62 |       "strategy": "role",
  63 |       "role": "link",
  64 |       "name": "Dress",
  65 |       "contextText": [
  66 |         "ecommerce website products",
  67 |         "Rs. 1500"
  68 |       ]
  69 |     }
  70 |   ], "Dress");
  71 | 
  72 |       await clickFirstVisible(el4);
  73 | 
  74 |       await assertTextPresent(page, "products_page", '', 10000).catch((_atp) => {
  75 |         test.info().annotations.push({ type: 'qaai-soft-fail', description: `PAGE: ${_atp.message}` });
  76 |       });
  77 | 
  78 |       await assertTextPresent(page, "No products found", '', 10000).catch((_atp) => {
  79 |         test.info().annotations.push({ type: 'qaai-soft-fail', description: `UI_TEXT: ${_atp.message}` });
  80 |       });
  81 | 
> 82 |             throw new Error("QAAI parity: original browser run failed (browser run recorded a failed verdict). Generated script must not pass until the failing assertion is repaired or recaptured.");
     |                   ^ Error: QAAI parity: original browser run failed (browser run recorded a failed verdict). Generated script must not pass until the failing assertion is repaired or recaptured.
  83 |       await page.screenshot({ path: "test-results/category-link-navigates-to-women-dress-category-independently-of-prior-search-te.png", fullPage: true });
  84 |     });
  85 | });
  86 | 
```