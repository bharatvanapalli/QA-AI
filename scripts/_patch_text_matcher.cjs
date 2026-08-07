'use strict';
// Deterministic transform (no LLM): rewrite `page.getByText(X,{exact:false}).first()`
// TEXT presence assertions into the tolerant .or() chain (text|placeholder|role|label),
// to PROVE the fidelity matcher fix flips the journey spec green in isolation.
const fs = require('fs');
const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');
const re = /page\.getByText\((('[^']*'|"[^"]*")), \{ exact: false \}\)\.first\(\)/g;
let n = 0;
src = src.replace(re, (_m, lit) => {
  n++;
  return `page.getByText(${lit}, { exact: false })`
    + `.or(page.getByPlaceholder(${lit}, { exact: false }))`
    + `.or(page.getByRole('textbox', { name: ${lit} }))`
    + `.or(page.getByLabel(${lit}, { exact: false }))`
    + `.first()`;
});
fs.writeFileSync(file, src, 'utf8');
console.log(`Patched ${n} TEXT matcher(s) → tolerant .or() chain in ${file}`);
