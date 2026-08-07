'use strict';
const { sanitizeJsTs } = require('../server/services/codegen/_sanitize');

// Same literals as verify_codegen_contract.cjs
// JS string "await expect(page).toHaveURL(/\\d+/)" = actual /\d+/ (one backslash before d, no slash)
const t2input = "await expect(page).toHaveURL(/\\d+/);";
const t2 = sanitizeJsTs(t2input);
const t2pass = t2 === t2input;
console.log(t2pass ? '  ✓' : '  ✗', 'valid /\\d+/ left untouched');
if (!t2pass) console.log('    got:', t2);

// JS string "await expect(page).toHaveURL(/\\d+\\/x/)" = actual /\d+\/x/
const t3input = "await expect(page).toHaveURL(/\\d+\\/x/);";
const t3 = sanitizeJsTs(t3input);
// Expected: includes new RegExp('\\d+/x')   i.e. actual string contains: new RegExp('\\d+/x')
// as a JS string literal, to check .includes() we need to escape the backslash:
const t3needle = "new RegExp('\\\\d+/x')";  // checks for actual: new RegExp('\\d+/x')
const t3pass = t3.includes(t3needle);
console.log(t3pass ? '  ✓' : '  ✗', 'metachar+slash /\\d+\\/x/ → new RegExp with preserved backslash');
if (!t3pass) {
  console.log('    input actual:', JSON.stringify(t3input));
  console.log('    output:', JSON.stringify(t3));
  console.log('    needle:', JSON.stringify(t3needle));
}

// glob **/products
const t4input = "await page.waitForURL('**/products', { timeout: 10000 });";
const t4 = sanitizeJsTs(t4input);
const t4pass = t4.includes('waitForURL(/') && !t4.includes("waitForURL('");
console.log(t4pass ? '  ✓' : '  ✗', 'glob **/products → regex literal form');
if (!t4pass) console.log('    got:', t4);
