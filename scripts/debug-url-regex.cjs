'use strict';
// Tests the over-escape hypothesis: was the pattern passed to new RegExp
// `/inventory\.html` (matches) or `/inventory\\.html` (doesn't)?

const url = 'https://www.saucedemo.com/inventory.html';

// Case A: single-backslash pattern (what's stored in the DB)
const patternA = '/inventory\\.html';  // JS source: 16 chars in memory
console.log('Case A (correct):');
console.log('  pattern in memory =', JSON.stringify(patternA), 'len=', patternA.length);
console.log('  new RegExp(pat).source =', new RegExp(patternA).source);
console.log('  test(' + url + ') =', new RegExp(patternA).test(url));

// Case B: double-backslash pattern (what the LLM over-escapes to)
const patternB = '/inventory\\\\.html';  // JS source = 17 chars: ...y, \, \, ., h...
console.log('\nCase B (over-escaped):');
console.log('  pattern in memory =', JSON.stringify(patternB), 'len=', patternB.length);
console.log('  new RegExp(pat).source =', new RegExp(patternB).source);
console.log('  test(' + url + ') =', new RegExp(patternB).test(url));

// What the trace LITERALLY showed, character by character:
//   "/inventory\\.html"
// Template-literal interpolation in mcp.js line 1964 doesn't escape.
// So if the displayed evidence has \\ between y and ., the in-memory
// string has \\ (two backslashes) at that position. That's Case B.
console.log('\nIf the trace shows /inventory\\\\.html in the evidence, the in-memory pattern was Case B → fails on the URL.');
