'use strict';
/**
 * Guard: framework-registry invariants in outputFiles.js.
 *
 * Generic rule encoded: all framework routing goes through one registry
 * (PROJECT_REPLAY_FRAMEWORKS + UNSUPPORTED_REPLAY_FRAMEWORKS). No route
 * re-implements the mapping. Unsupported frameworks are blocked at the
 * registry layer, not silently defaulted to the wrong adapter.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'outputFiles.js'), 'utf8');

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { console.error('  FAIL:', msg); fail++; } else { console.log('  ok:', msg); }
};

// ── [1] registry constants exist ─────────────────────────────────────────────
console.log('\n[1] registry constants defined');
ok(/const PROJECT_REPLAY_FRAMEWORKS\s*=\s*\{/.test(src), 'PROJECT_REPLAY_FRAMEWORKS constant defined');
ok(/const UNSUPPORTED_REPLAY_FRAMEWORKS\s*=\s*\{/.test(src), 'UNSUPPORTED_REPLAY_FRAMEWORKS constant defined');

// ── [2] registry contents correct ────────────────────────────────────────────
console.log('\n[2] registry contents');
{
  const projM = src.match(/const PROJECT_REPLAY_FRAMEWORKS\s*=\s*(\{[\s\S]*?\})\s*;/);
  const unsupM = src.match(/const UNSUPPORTED_REPLAY_FRAMEWORKS\s*=\s*(\{[\s\S]*?\})\s*;/);
  ok(projM, 'PROJECT_REPLAY_FRAMEWORKS source extractable');
  ok(unsupM, 'UNSUPPORTED_REPLAY_FRAMEWORKS source extractable');
  if (projM && unsupM) {
    let PROJECT_REPLAY_FRAMEWORKS, UNSUPPORTED_REPLAY_FRAMEWORKS;
    try {
      // eslint-disable-next-line no-eval
      PROJECT_REPLAY_FRAMEWORKS = eval('(' + projM[1] + ')');
      // eslint-disable-next-line no-eval
      UNSUPPORTED_REPLAY_FRAMEWORKS = eval('(' + unsupM[1] + ')');
    } catch (e) {
      ok(false, `failed to eval registry constants: ${e.message}`);
      PROJECT_REPLAY_FRAMEWORKS = null;
      UNSUPPORTED_REPLAY_FRAMEWORKS = null;
    }
    if (PROJECT_REPLAY_FRAMEWORKS && UNSUPPORTED_REPLAY_FRAMEWORKS) {
      // Known supported frameworks and their adapter IDs
      ok(PROJECT_REPLAY_FRAMEWORKS['playwright-pom'] === 'playwright-pom', "playwright-pom → playwright-pom (not playwright-reference)");
      ok(PROJECT_REPLAY_FRAMEWORKS['playwright-flat'] === 'playwright-reference', "playwright-flat → playwright-reference");
      ok(PROJECT_REPLAY_FRAMEWORKS['playwright-js'] === 'playwright-reference-js', "playwright-js → playwright-reference-js");
      ok(PROJECT_REPLAY_FRAMEWORKS['playwright-bdd'] === 'replayir-bdd', "playwright-bdd → replayir-bdd");
      ok(PROJECT_REPLAY_FRAMEWORKS['cucumber-playwright'] === 'replayir-bdd', "cucumber-playwright → replayir-bdd");
      ok(PROJECT_REPLAY_FRAMEWORKS['selenium-java'] === 'selenium-pom', "selenium-java → selenium-pom");
      ok(PROJECT_REPLAY_FRAMEWORKS['selenium-bdd'] === 'selenium-bdd-reference', "selenium-bdd → selenium-bdd-reference");
      ok(!('selenium-bdd' in UNSUPPORTED_REPLAY_FRAMEWORKS), "selenium-bdd is no longer blocked from ReplayIR export");
    }
  }
}

// ── [3] replayFramework() uses both registries; no hand-rolled if-chain ───────
console.log('\n[3] replayFramework() wired to registry');
{
  // Extract the function body: from the function declaration to just before the next function.
  const fnStart = src.indexOf('\nfunction replayFramework(');
  const nextFn = src.indexOf('\nfunction ', fnStart + 1);
  const nextAsyncFn = src.indexOf('\nasync function ', fnStart + 1);
  const fnEnd = Math.min(
    nextFn > fnStart ? nextFn : Infinity,
    nextAsyncFn > fnStart ? nextAsyncFn : Infinity,
  );
  const replayFnSrc = fnStart >= 0 && fnEnd !== Infinity ? src.slice(fnStart, fnEnd) : '';
  ok(replayFnSrc.length > 0, 'replayFramework() body found');
  if (replayFnSrc.length > 0) {
    ok(/PROJECT_REPLAY_FRAMEWORKS/.test(replayFnSrc), 'replayFramework() references PROJECT_REPLAY_FRAMEWORKS');
    ok(/UNSUPPORTED_REPLAY_FRAMEWORKS/.test(replayFnSrc), 'replayFramework() references UNSUPPORTED_REPLAY_FRAMEWORKS');
    ok(/UNSUPPORTED_REPLAY_FRAMEWORK/.test(replayFnSrc), "replayFramework() throws error with code 'UNSUPPORTED_REPLAY_FRAMEWORK'");
    // Must NOT have the old hand-rolled if-chain
    ok(!/if\s*\(\s*f\s*===\s*'playwright-js'\)/.test(replayFnSrc), 'replayFramework(): no hand-rolled if-chain for playwright-js');
    ok(!/if\s*\(\s*f\s*===\s*'playwright-bdd'\)/.test(replayFnSrc), 'replayFramework(): no hand-rolled if-chain for playwright-bdd');
    ok(!/if\s*\(\s*f\s*===\s*'selenium-java'\)/.test(replayFnSrc), 'replayFramework(): no hand-rolled if-chain for selenium-java');
  }
}

// ── [4] no inline defaultFramework chain in download.zip ─────────────────────
console.log('\n[4] download.zip uses replayFramework(), not inline mapping');
{
  // The old inline mapping pattern: `const defaultFramework = projectFramework === 'playwright-js' ?`
  ok(!/const\s+defaultFramework\s*=\s*projectFramework\s*===/.test(src),
    'no inline defaultFramework if-chain (projectFramework === ...) in source');
  // The route must call replayFramework(req, project) — should appear at least twice
  // (once in buildReplayWorkspace, once in download.zip).
  const calls = (src.match(/replayFramework\s*\(\s*req\s*,\s*project\s*\)/g) || []).length;
  ok(calls >= 2, `replayFramework(req, project) called in ≥2 places (buildReplayWorkspace + download.zip), found ${calls}`);
}

// ── [5] buildReplayWorkspace catches UNSUPPORTED_REPLAY_FRAMEWORK ─────────────
console.log('\n[5] buildReplayWorkspace catches UNSUPPORTED_REPLAY_FRAMEWORK');
{
  const bwStart = src.indexOf('\nasync function buildReplayWorkspace(');
  // This is the only async function in the file; the next landmark is a router.get call.
  const bwEndCandidate = src.indexOf('\nrouter.get(', bwStart + 1);
  const bwEnd = bwEndCandidate > bwStart ? bwEndCandidate : src.length;
  const bwSrc = bwStart >= 0 ? src.slice(bwStart, bwEnd) : '';
  ok(bwSrc.length > 0, 'buildReplayWorkspace() body found');
  if (bwSrc.length > 0) {
    ok(/UNSUPPORTED_REPLAY_FRAMEWORK/.test(bwSrc), 'buildReplayWorkspace() handles UNSUPPORTED_REPLAY_FRAMEWORK');
    ok(/try\s*\{[\s\S]*?replayFramework\s*\(/.test(bwSrc), 'buildReplayWorkspace() wraps replayFramework() in try-catch');
  }
}

// ── [6] download.zip route handles UNSUPPORTED_REPLAY_FRAMEWORK ───────────────
console.log('\n[6] download.zip route handles UNSUPPORTED_REPLAY_FRAMEWORK');
{
  // The download.zip route block starts with router.get('/download.zip'
  const dlStart = src.indexOf("router.get('/download.zip'");
  ok(dlStart >= 0, "download.zip route found");
  if (dlStart >= 0) {
    // Extract a generous slice of the route (first 3000 chars covers the replayir block)
    const dlSlice = src.slice(dlStart, dlStart + 3500);
    ok(/UNSUPPORTED_REPLAY_FRAMEWORK/.test(dlSlice), 'download.zip route handles UNSUPPORTED_REPLAY_FRAMEWORK');
    ok(/replayFramework\s*\(\s*req\s*,\s*project\s*\)/.test(dlSlice), 'download.zip calls replayFramework(req, project)');
    // Must NOT have the old inline mapping
    ok(!/const\s+projectFramework\s*=\s*typeof\s+project\.framework/.test(dlSlice),
      'download.zip has no projectFramework inline variable');
  }
}

// ── summary ───────────────────────────────────────────────────────────────────
if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
console.log('\nverify_framework_registry: all checks passed');
