'use strict';
/**
 * Guard: scan generated Playwright/Selenium output files for patterns that
 * indicate broken codegen — descriptor-text locators, .first() ambiguity
 * suppressors, and QAAI_UNRESOLVED_LOCATOR markers.
 *
 * Usage:
 *   node scripts/verify_no_descriptor_locators.cjs [output-dir]
 *
 * Exits 0 if clean, 1 if violations found.
 * Default scan path: playwright/generated/
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'playwright', 'generated');

// ── Rules ────────────────────────────────────────────────────────────────────

const RULES = [
  {
    id: 'descriptor_locator_long',
    desc: 'getByText with a long descriptor argument (not visible DOM text)',
    // Match getByText("...40+ chars...") or getByText('...')
    re: /getByText\s*\(\s*["'`]([^"'`]{40,})["'`]/g,
    safe: null,
  },
  {
    id: 'descriptor_locator_paren',
    desc: 'getByText with parenthetical context (agent narration leaked as locator)',
    re: /getByText\s*\(\s*["'`][^"'`]*\([^)]+\)[^"'`]*["'`]/g,
    safe: null,
  },
  {
    id: 'descriptor_locator_keyword',
    desc: 'getByText with descriptor keyword (button/icon/row/menu/container/toggle for/in/of)',
    re: /getByText\s*\(\s*["'`][^"'`]*\b(?:button|icon|menu|row|container|toggle|field|panel|section|dropdown|checkbox|cell)\s+(?:for|in|of)\b[^"'`]*["'`]/gi,
    safe: null,
  },
  {
    id: 'first_ambiguity',
    desc: '`.first()` suppresses strict-mode — locator must match exactly one element',
    re: /\.first\s*\(\s*\)/g,
    // Allow in support/helper/fixture files
    safe: /[\\/](?:support|helpers?|fixtures?|utils?|replayir|_[a-z])/,
  },
  {
    id: 'unresolved_locator',
    desc: 'QAAI_UNRESOLVED_LOCATOR marker — action has no verified DOM locator',
    re: /QAAI_UNRESOLVED_LOCATOR\s*:/g,
    safe: null,
  },
  {
    id: 'broken_login_flow',
    desc: 'QAAI_BROKEN_LOGIN_FLOW marker — page.goto() was substituted for a Login button click',
    re: /QAAI_BROKEN_LOGIN_FLOW\s*:/g,
    safe: null,
  },
];

// ── Scanner ──────────────────────────────────────────────────────────────────

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function scanFile(filePath) {
  const rel = path.relative(ROOT, filePath);
  const code = fs.readFileSync(filePath, 'utf8');
  const violations = [];
  for (const rule of RULES) {
    if (rule.safe && rule.safe.test(rel)) continue;
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(code)) !== null) {
      violations.push({
        rule: rule.id,
        file: rel,
        line: lineOf(code, m.index),
        snippet: m[0].slice(0, 120),
        desc: rule.desc,
      });
    }
  }
  return violations;
}

function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (/\.(ts|js)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const files = collectFiles(TARGET);
if (!files.length) {
  console.log(`[verify_no_descriptor_locators] No .ts/.js files found in ${TARGET}`);
  process.exit(0);
}

let totalViolations = 0;
for (const f of files) {
  const v = scanFile(f);
  if (v.length) {
    for (const viol of v) {
      console.error(`FAIL [${viol.rule}] ${viol.file}:${viol.line}`);
      console.error(`     ${viol.desc}`);
      console.error(`     ${viol.snippet}`);
    }
    totalViolations += v.length;
  }
}

if (totalViolations === 0) {
  console.log(`[verify_no_descriptor_locators] PASS — ${files.length} file(s) scanned, no violations.`);
  process.exit(0);
} else {
  console.error(`\n[verify_no_descriptor_locators] FAIL — ${totalViolations} violation(s) across ${files.length} file(s).`);
  process.exit(1);
}
