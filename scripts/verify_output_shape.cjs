'use strict';
/**
 * Shape guard: compiles a minimal ReplayIR through every adapter and asserts
 * none of the known pollution patterns appear in the generated test files.
 *
 *   node scripts/verify_output_shape.cjs
 *
 * Fails (exit 1) if any forbidden pattern is found.
 */

const { compileReplayIR } = require('../server/services/codegen/adapters/frameworkAdapter');
const playwrightReference = require('../server/services/codegen/adapters/playwrightReference');
const seleniumReference   = require('../server/services/codegen/adapters/seleniumReference');
const replayIrBdd         = require('../server/services/codegen/adapters/replayIrBdd');

let failures = 0;
const ok  = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
function assert(cond, m) { cond ? ok(m) : bad(m); }

// ── Minimal valid IR ─────────────────────────────────────────────────────────
// fill/type require valueRef with env:/vault: prefix (IR validator rule).
// Channel must be from the frozen ASSERT_CHANNELS enum (UI_TEXT, UI_ROLE, etc.).
const IR = {
  version: 1,
  caseId: 'shape-check-case',
  title: 'Login with valid credentials',
  authProfile: { id: 'default', strategy: 'none', disposition: 'bypass_fixture' },
  steps: [
    { op: 'act', action: 'navigate', url: 'https://example.com/login' },
    {
      op: 'resolve',
      candidates: [{ strategy: 'role', role: 'textbox', name: 'Username' }],
      as: 'usernameInput',
    },
    { op: 'act', action: 'fill', element: 'usernameInput', valueRef: 'env:QAAI_USERNAME' },
    {
      op: 'resolve',
      candidates: [{ strategy: 'role', role: 'button', name: 'Login' }],
      as: 'loginBtn',
    },
    { op: 'act', action: 'click', element: 'loginBtn' },
    {
      op: 'assert',
      channel: 'UI_TEXT',
      target: 'welcomeMsg',
      expected: 'Welcome, Test User',
      contractRef: 'A-1',
    },
  ],
  verdict: { status: 'pass', perAssertionOutcomes: [{ contractRef: 'A-1', status: 'pass' }] },
};

// ── Forbidden patterns in generated output files ──────────────────────────────
const FORBIDDEN = [
  {
    re: /QAAI\s+ReplayIR\s+[0-9a-f]{8}-/i,
    label: 'UUID test title ("QAAI ReplayIR <uuid>")',
    specOnly: false,
  },
  {
    re: /test\s*\(\s*['"]default['"]/,
    label: 'test("default") placeholder title',
    specOnly: false,
  },
  {
    // resolveLocator function BODY inlined into a spec (must only live in support/ files)
    re: /async function resolveLocator\s*\(/,
    label: 'resolveLocator helper inlined into spec (boilerplate leak)',
    specOnly: true,
  },
  {
    re: /async function assertTextPresent\s*\(/,
    label: 'assertTextPresent helper inlined into spec (boilerplate leak)',
    specOnly: true,
  },
  {
    // Latin-1 Extended range — mojibake that should be stripped by _candidateNormalize
    re: /[-ÿ]/,
    label: 'Latin-1 / mojibake character in output',
    specOnly: false,
  },
  {
    // Private Use Area — garbage snapshot characters
    re: /[-]/,
    label: 'PUA-range garbage character in output',
    specOnly: false,
  },
  {
    // .first() before an action — silent first-match selection on an unknown set
    re: /\.first\(\)\s*\.\s*(click|fill|check|uncheck|selectOption|type|press|focus|hover|tap)\s*\(/,
    label: '.first() immediately before an action call',
    specOnly: false,
  },
  {
    // The removed textbox wildcard — getByRole('textbox') with no name
    re: /getByRole\s*\(\s*['"]textbox['"]\s*\)(?!\s*,)/,
    label: 'getByRole("textbox") with no name (wildcard fallback)',
    specOnly: false,
  },
];

function isSpecFile(filePath) {
  return /\/(tests?|specs?|features?)\//.test(filePath)
    || /\.(spec|test)\.(ts|js)$/.test(filePath)
    || filePath.endsWith('.feature')
    || (filePath.includes('test') && !filePath.includes('support'));
}

function checkFiles(adapterLabel, files) {
  console.log(`\n[${adapterLabel}]`);
  for (const [filePath, content] of Object.entries(files || {})) {
    const text = String(content || '');
    const specLike = isSpecFile(filePath);
    let fileOk = true;
    for (const { re, label, specOnly } of FORBIDDEN) {
      if (specOnly && !specLike) continue;
      if (re.test(text)) {
        bad(`${filePath}: ${label}`);
        fileOk = false;
      }
    }
    if (fileOk) ok(`${filePath}: clean`);
  }
}

// ── Playwright TS ─────────────────────────────────────────────────────────────
console.log('\n=== verify_output_shape: output shape guard ===');

let pwResult;
try {
  pwResult = compileReplayIR(playwrightReference, IR);
  checkFiles('playwright-reference', pwResult.files);
} catch (e) {
  bad('playwright-reference compile threw: ' + e.message);
}

// ── Playwright JS ──────────────────────────────────────────────────────────────
try {
  const jsAdapter = playwrightReference.playwrightReferenceJs;
  if (jsAdapter) {
    const jsResult = compileReplayIR(jsAdapter, IR);
    checkFiles('playwright-reference-js', jsResult.files);
  } else {
    ok('playwright-reference-js: not a top-level adapter (skipped)');
  }
} catch (e) {
  bad('playwright-reference-js compile threw: ' + e.message);
}

// ── Selenium ──────────────────────────────────────────────────────────────────
let seleniumResult;
try {
  seleniumResult = compileReplayIR(seleniumReference, IR);
  checkFiles('selenium-reference', seleniumResult.files);
} catch (e) {
  bad('selenium-reference compile threw: ' + e.message);
}

// ── BDD — uses renderIr (not compileReplayIR; different architecture) ─────────
try {
  const rendered = replayIrBdd.renderIr(IR);
  if (rendered && rendered.block) {
    bad('replayir-bdd renderIr blocked: ' + (rendered.block.detail || rendered.block.code));
  } else if (rendered && rendered.lines) {
    const featureText = rendered.lines.map((l) => l.text).join('\n');
    const bddFiles = { 'features/shape-check-case.feature': featureText };
    checkFiles('replayir-bdd', bddFiles);
  } else {
    bad('replayir-bdd renderIr returned unexpected shape: ' + JSON.stringify(rendered));
  }
} catch (e) {
  bad('replayir-bdd renderIr threw: ' + e.message);
}

// ── Title resolution ──────────────────────────────────────────────────────────
console.log('\n[title resolution]');
if (pwResult) {
  const specEntry = Object.entries(pwResult.files).find(([filePath]) => /\.spec\.(ts|js)$/.test(filePath));
  const spec = specEntry ? specEntry[1] : '';
  assert(spec.includes('Login with valid credentials'), 'playwright-reference: spec uses IR.title not a UUID');
}
if (seleniumResult) {
  // Class name is derived from ir.title with spaces → underscores (Java identifier).
  const filePath = Object.keys(seleniumResult.files)[0] || '';
  const spec = Object.values(seleniumResult.files)[0] || '';
  const titleSlug = IR.title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  assert(
    filePath.includes(titleSlug) || spec.includes(titleSlug),
    `selenium-reference: class name contains title slug "${titleSlug}" (not UUID-based)`
  );
}

// ── Final ─────────────────────────────────────────────────────────────────────
console.log('\n' + (failures === 0 ? '✅ All shape checks passed.' : `❌ ${failures} shape violation(s) found.`));
process.exit(failures > 0 ? 1 : 0);
