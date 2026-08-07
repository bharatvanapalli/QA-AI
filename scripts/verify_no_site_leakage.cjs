'use strict';
/*
 * SITE-LEAKAGE GUARD (universal-design discipline).
 *
 * Runtime modules under server/services and server/lib must NOT contain
 * website-specific selectors, app names, URLs, or data values. OrangeHRM is only
 * a TEST HARNESS — never the design target. Site specifics belong in tests /
 * fixtures / scripts / docs, or in CODE COMMENTS (which are skipped here), but
 * NEVER in runtime logic or LLM-prompt strings.
 *
 * The guard scans non-comment lines of every runtime .js under those dirs and
 * fails on any forbidden token. Comment lines (// or * or /*) are allowed.
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['server/services', 'server/lib'].map((r) => path.join(__dirname, '..', r));
const SKIP_DIR = /(^|[\\/])(__tests__|node_modules|\.prisma)([\\/]|$)/;
// Forbidden in runtime/prompt text. Word-boundaried where a substring would
// false-positive (ESS in "process", Alice rare, gaurav rare).
const TOKENS = [
  { name: 'orangehrm', re: /orangehrm/i },
  { name: 'opensource-demo', re: /opensource-demo/i },
  { name: 'oxd- selector', re: /oxd-/ },
  { name: 'User Role', re: /\bUser Role\b/ },
  { name: 'ESS', re: /\bESS\b/ },
  { name: 'Alice', re: /\bAlice\b/ },
  { name: 'AdminAuto', re: /AdminAuto/i },
  { name: 'gaurav', re: /\bgaurav\b/i },
];

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(full)) walk(full, out); }
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t === '*/';
}

const files = [];
ROOTS.forEach((r) => walk(r, files));
const hits = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return; // comments are allowed
    for (const t of TOKENS) {
      if (t.re.test(line)) hits.push({ file: path.relative(path.join(__dirname, '..'), f), line: i + 1, token: t.name, text: line.trim().slice(0, 100) });
    }
  });
}

if (hits.length) {
  console.log(`FAILED — ${hits.length} site-leakage hit(s) in runtime code (move to tests/fixtures/comments, or genericize):`);
  hits.forEach((h) => console.log(`  ${h.file}:${h.line}  [${h.token}]  ${h.text}`));
  process.exit(1);
}
console.log(`OK — no site-specific selectors/names/URLs/data in runtime code (scanned ${files.length} files under server/services + server/lib)`);
