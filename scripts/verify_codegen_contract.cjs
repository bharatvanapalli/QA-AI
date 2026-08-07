'use strict';
/**
 * Regression guard for the codegen-fidelity fix (shared credential contract +
 * shared login helper + per-case page objects + prompt hardening across all 5
 * frameworks). Deterministic — no LLM, no credits. Run:
 *   node scripts/verify_codegen_contract.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const env = require('../server/services/codegen/_env');
const loginLib = require('../server/services/codegen/_login');
const pom = require('../server/services/codegen/pom');
const pwjs = require('../server/services/codegen/playwrightJs');
const selenium = require('../server/services/codegen/selenium');
const pwbdd = require('../server/services/codegen/playwrightBdd');
const selbdd = require('../server/services/codegen/seleniumBdd');
const replayEmitter = require('../server/services/codegen/replayEmitter');
const replayExport = require('../server/services/codegen/replayExport');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
function assert(cond, m) { cond ? ok(m) : bad(m); }

const scenario = { name: 'PIM module', module: 'PIM', category: 'functional' };
const caseA = { id: 'aaaaaaaa', name: 'Create employee with first and last name' };
const caseB = { id: 'bbbbbbbb', name: 'Search employee by name' };

console.log('\n[1] PER-CASE files — two cases in one module must NOT collide');
for (const [name, mod, key] of [
  ['pom', pom, 'pageObjectFile'],
  ['playwrightJs', pwjs, 'pageObjectFile'],
  ['selenium', selenium, 'pageObjectFile'],
  ['playwrightBdd', pwbdd, 'stepsFile'],
  ['seleniumBdd', selbdd, 'stepsFile'],
]) {
  const a = mod.layout(scenario, caseA);
  const b = mod.layout(scenario, caseB);
  assert(a[key] && b[key] && a[key] !== b[key], `${name}: ${key} differs per case (${path.basename(a[key])} vs ${path.basename(b[key])})`);
}
// Selenium also needs a per-case CLASS name (file name must match class)
{
  const a = selenium.layout(scenario, caseA);
  const b = selenium.layout(scenario, caseB);
  assert(a.className !== b.className, `selenium: page object CLASS differs per case (${a.className} vs ${b.className})`);
}

console.log('\n[2] CREDENTIAL PROFILE — null store falls back to observed trail creds');
const prof = env.buildCredentialProfile({ testCredentials: null, observed: { username: 'Admin', password: 'admin123', name: 'Admin' } });
assert(prof.hasCreds && prof.users[0].userEnv === 'QAAI_USERNAME', 'canonical env names assigned (QAAI_USERNAME/QAAI_PASSWORD)');
assert(prof.users[0].username === 'Admin' && prof.users[0].password === 'admin123', 'observed creds captured');

console.log('\n[3] SHELL EMISSION — render each Playwright shell into a temp dir');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-cg-'));
const baseUrl = 'https://opensource-demo.orangehrmlive.com';
function checkShell(label, mod, sub, envFile, accessorNeedle) {
  const dir = path.join(tmp, sub);
  fs.mkdirSync(dir, { recursive: true });
  mod.ensureProjectShell(dir, { targetUrl: baseUrl, credProfile: prof });
  const envPath = path.join(dir, envFile);
  const dotenv = path.join(dir, '.env');
  assert(fs.existsSync(envPath), `${label}: ${envFile} written`);
  if (fs.existsSync(envPath)) {
    const c = fs.readFileSync(envPath, 'utf8');
    assert(c.includes(accessorNeedle) && c.includes('Admin'), `${label}: accessor uses ${accessorNeedle} + bakes real value`);
    assert(!/TEST_EMAIL|changeme|demo@example/.test(c), `${label}: no stale TEST_EMAIL/changeme defaults`);
  }
  assert(fs.existsSync(dotenv), `${label}: .env written`);
  if (fs.existsSync(dotenv)) assert(fs.readFileSync(dotenv, 'utf8').includes('QAAI_USERNAME=Admin'), `${label}: .env has QAAI_USERNAME=Admin`);
  return dir;
}
const pomDir = checkShell('pom', pom, 'pom', 'utils/env.ts', 'QAAI_USERNAME');
checkShell('playwrightJs', pwjs, 'pwjs', 'utils/env.js', 'QAAI_USERNAME');
checkShell('playwrightBdd', pwbdd, 'pwbdd', 'utils/env.ts', 'QAAI_USERNAME');

console.log('\n[4] SHARED AUTH FALLBACK — compiles as valid TS, uses shared env, no getByLabel');
const ctx = loginLib.extractLoginContext({ actions: [
  { tool: 'browser_navigate', args: { url: baseUrl + '/web/index.php/auth/login' } },
  { tool: 'browser_type', args: { element: 'Username textbox', text: 'Admin' } },
  { tool: 'browser_type', args: { element: 'Password textbox', text: 'admin123' } },
  { tool: 'browser_click', args: { element: 'Login button' } },
  { tool: 'browser_navigate', args: { url: baseUrl + '/web/index.php/dashboard/index' } },
] }, baseUrl);
assert(ctx.loginPath === '/web/index.php/auth/login', `login path extracted (${ctx.loginPath})`);
assert(ctx.observed.username === 'Admin' && ctx.observed.password === 'admin123', 'creds extracted from trail');
const authTs = loginLib.fallbackHelperTs(ctx, prof);
assert(/from '\.\/env'/.test(authTs) && /QAAI_USERNAME/.test(authTs), 'auth helper imports shared env');
assert(!/getByLabel/.test(authTs), 'auth helper does NOT use getByLabel');
assert(!/waitForResponse/.test(authTs), 'auth helper does NOT use brittle waitForResponse');
// write into pom utils/ and esbuild-validate env+auth together
fs.writeFileSync(path.join(pomDir, 'utils', 'auth.ts'), authTs, 'utf8');
try {
  // Bundle auth.ts alone — it imports ./env, so esbuild resolves & type-strips
  // BOTH. A syntax/type-strip error in either fails the build.
  const cmd = `npx esbuild "${path.join(pomDir, 'utils', 'auth.ts')}" --bundle --platform=node --external:@playwright/test --outfile="${path.join(tmp, 'out.js')}"`;
  cp.execSync(cmd, { stdio: 'pipe', shell: true });
  ok('utils/auth.ts + utils/env.ts compile (esbuild)');
} catch (e) {
  bad('utils/auth.ts + utils/env.ts compile (esbuild): ' + String(e.stderr || e.message).slice(0, 300));
}

console.log('\n[5] PROMPT HARDENING — mandates removed / discipline added');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'codegen', p), 'utf8');
const readSrv = (p) => fs.readFileSync(path.join(__dirname, '..', 'server', 'services', p), 'utf8');
for (const f of ['pom.js', 'playwrightJs.js', 'playwrightBdd.js']) {
  const s = read(f);
  assert(!/waitForResponse\(\) for any backend call/.test(s), `${f}: no "waitForResponse for any backend call" mandate`);
  assert(/getByLabel/.test(s) && /DO NOT use|do NOT use|Do NOT use/.test(s), `${f}: getByLabel discipline present`);
  assert(/guessed URL|EXACT response/.test(s), `${f}: anti-brittle-waitForResponse rule present`);
}
for (const f of ['selenium.js', 'seleniumBdd.js']) {
  const s = read(f);
  assert(/Config\.username\(\)/.test(s), `${f}: credentials via shared Config`);
  assert(!/System\.getenv\("VAR/.test(s), `${f}: no generic System.getenv("VAR") instruction`);
}

console.log('\n[6] VERDICT FIDELITY — declaredAssertions plumbed + criticality-aware rule');
const fidelity = require('../server/services/codegen/_fidelity');
const sampleTc = { declaredAssertions: JSON.stringify([
  { id: 'A1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Employee List' }, targetUrl: '/pim/viewEmployeeList', checkAt: 'end' },
  { id: 'A2', type: 'TEXT', criticality: 'incidental', payload: { expectedText: 'TestFirst' } },
]) };
const decl = fidelity.declaredAssertionsFor(sampleTc);
assert(decl.length === 2 && decl[0].payload.expectedText === 'Employee List', 'declaredAssertionsFor parses structured assertions');
assert(decl[0].criticality === 'must' && decl[1].criticality === 'incidental', 'criticality preserved per assertion');
const dig = fidelity.assertionDigest(decl);
assert(/\[MUST\] TEXT expected="Employee List"/.test(dig), 'digest surfaces criticality + expected value');
const fb = fidelity.fidelityBlock({ lang: 'ts' });
assert(/caseStatus is "pass"[\s\S]*GREEN/.test(fb) && /caseStatus is "fail"[\s\S]*RED/.test(fb), 'fidelity rule: pass→green, fail→red');
assert(/NEVER omit|NEVER weaken|swallow/.test(fb), 'fidelity rule forbids weakening/omitting/swallowing');
// every generator must pass declaredAssertions to the model
for (const f of ['pom.js', 'playwrightJs.js', 'selenium.js', 'playwrightBdd.js', 'seleniumBdd.js']) {
  assert(/declaredAssertions/.test(read(f)) && /fidelityBlock/.test(read(f)), `${f}: feeds declaredAssertions + fidelityBlock`);
}

console.log('\n[7] PAGE-OBJECT CONSTRUCTION — prompts forbid the field-init crash');
for (const f of ['pom.js', 'playwrightJs.js']) {
  const s = read(f);
  assert(/field initialiser|field initializer|constructor body/i.test(s), `${f}: requires locators assigned in the constructor body`);
  assert(/undefined/.test(s) && /this\.page/.test(s), `${f}: warns this.page is undefined in a field initialiser`);
}

console.log('\n[8] SYNTAX SANITIZER — repairs the URL-regex parse bug, spares valid regexes');
const { sanitizeJsTs } = require('../server/services/codegen/_sanitize');
assert(/new RegExp\('pim\/viewEmployeeList'\)/.test(sanitizeJsTs("await expect(page).toHaveURL(//pim/viewEmployeeList/, { timeout: 10_000 });")), 'doubled-slash //path/ → new RegExp(...)');
assert(/new RegExp\('pim\/viewEmployeeList'\)/.test(sanitizeJsTs("await expect(page).toHaveURL(/pim/viewEmployeeList/, { timeout: 10 });")), 'internal-slash /path/ → new RegExp(...)');
assert(sanitizeJsTs("await expect(page).toHaveURL(/dashboard/i);") === "await expect(page).toHaveURL(/dashboard/i);", 'flagged regex /dashboard/i left untouched');
// A valid metacharacter regex with NO internal slash must be left ENTIRELY alone
// — rewriting it to new RegExp('\d+') would collapse to /d+/ (matches the letter
// d, not digits). This was a real corruption bug.
assert(sanitizeJsTs("await expect(page).toHaveURL(/\\d+/);") === "await expect(page).toHaveURL(/\\d+/);", 'valid metachar regex /\\d+/ left untouched (no false rewrite)');
// When a rewrite IS warranted (internal slash), genuine backslashes must SURVIVE
// the new RegExp(...) string literal: /\d+\/x/ → new RegExp('\\d+/x'), not '\d+/x'.
assert(sanitizeJsTs("await expect(page).toHaveURL(/\\d+\\/x/);").includes("new RegExp('\\\\d+/x')"), 'metachar+slash regex keeps its backslash (digits stay digits, not the letter d)');
assert(/require\(.*_sanitize.*\)\.sanitizeGenerated/.test(readSrv('agents/conductor.js')), 'conductor applies sanitizeGenerated to codegen output');

console.log('\n[9] LOCATOR REPLAY — verified DOM evidence first, explicit warned semantic guess when unavailable');
const locators = require('../server/services/codegen/_locators');
const actionPlanLib = require('../server/services/codegen/_actionPlan');
{
  const kbRows = [
    { element: 'Username', role: 'textbox', accessibleName: 'Username', selector: 'getByRole("textbox", { name: "Username" })', strategy: 'role', healthScore: 100, occurrences: 9, pageUrl: '/auth/login' },
    { element: 'Search', role: 'button', accessibleName: 'Search', selector: 'getByRole("button", { name: "Search" })', strategy: 'role', healthScore: 100, occurrences: 4, pageUrl: '/pim' },
    { element: 'Flaky', role: 'button', accessibleName: 'Flaky', selector: 'getByText("Flaky")', strategy: 'text', healthScore: 11, occurrences: 1, pageUrl: '/x' },
  ];
  const acts = [
    { tool: 'browser_type', args: { element: 'Username', text: 'Admin' } },
    { tool: 'browser_click', args: { element: 'Search' } },
    { tool: 'browser_click', args: { element: 'Flaky' } },           // quarantined → skipped
    { tool: 'browser_click', args: { element: 'Ghost' } },           // unknown → skipped
  ];
  const labelOf = (a) => (a.args && a.args.element) || null;
  const pw = locators.buildManifest({ actions: acts, kbRows, labelOf, lang: 'ts' });
  assert(pw.actions[0].locator && pw.actions[0].locator.expression === 'getByRole("textbox", { name: "Username" })', 'PW: action bound to recorded role+name verbatim');
  assert(!pw.actions[2].locator, 'PW: quarantined KB row (health<30) is NOT replayed');
  assert(pw.actions[3].kbMiss && !pw.actions[3].locator, 'PW: unknown element is marked kbMiss, not model-derived');
  assert(pw.manifest.length === 2, 'PW: manifest deduped to healthy bound elements');
  const jv = locators.buildManifest({ actions: acts, kbRows, labelOf, lang: 'java' });
  assert(/^By\.xpath\(/.test(jv.actions[1].locator.expression), 'Java: emits By.xpath grounded in the accessible name');
  // Java SELECTOR TRANSLATION — the recorded Playwright selector is translated to
  // a real Selenium By (not just role/name). The regex builder MUST NOT throw.
  assert(locators.javaExpression({ selector: 'locator("#btnLogin")' }) === 'By.cssSelector("#btnLogin")', 'Java: locator("#css") → By.cssSelector');
  assert(/^By\.xpath\(/.test(locators.javaExpression({ selector: 'getByText("Welcome")' })), 'Java: getByText(...) → By.xpath(contains text)');
  assert(/By\.cssSelector\(.*placeholder/.test(locators.javaExpression({ selector: 'getByPlaceholder("Email")' })), 'Java: getByPlaceholder(...) → By.cssSelector([placeholder=...])');
  assert(/^By\.xpath\(/.test(locators.javaExpression({ selector: 'getByRole("button", { name: "Search" })' })), 'Java: getByRole(...) → By.xpath grounded in the accessible name');
  // fallback hierarchy: no role/name but a raw selector → use the selector
  assert(locators.playwrightExpression({ selector: '#btnLogin' }) === 'locator("#btnLogin")', 'PW: falls back to recorded raw selector when a11y data missing');
  const nestedPlan = actionPlanLib.buildActionPlan({
    trail: [{
      tool: 'browser_click',
      ok: true,
      args: { ref: 'e123' },
      narration: 'Clicked Search submit button',
      domFacts: { target: { role: 'button', accessibleName: 'Search submit button', selector: '#submit-search' } },
    }],
    status: 'pass',
    stepResults: [],
    testCaseName: 'Search products',
  });
  assert(nestedPlan.traceVersion === 'v2', 'actionPlan: nested domFacts.target marks the trace as v2');
  assert(nestedPlan.actions[0].domFacts?.accessibleName === 'Search submit button', 'actionPlan: nested domFacts.target is normalized for codegen');
  const inline = locators.buildManifest({ actions: nestedPlan.actions, kbRows: [], labelOf: () => null, lang: 'ts' });
  assert(inline.actions[0].locator?.expression === 'getByRole("button", { name: /Search submit button/i })', 'PW: inline domFacts.target certifies a locator without KB narration matching');
  const actionLocatorPlan = actionPlanLib.buildActionPlan({
    trail: [{
      tool: 'browser_click',
      ok: true,
      args: { element: 'Search submit button', ref: 'e9' },
      narration: 'Clicked Search submit button',
      actionLocator: {
        kind: 'playwright',
        verified: true,
        verificationSource: 'verified_dom_inspection',
        evidenceSource: 'verified_dom_inspection',
        expression: 'getByRole("button", { name: "Search" })',
        frameworkExpressions: { playwright: 'getByRole("button", { name: "Search" })', selenium: 'By.xpath("//button[normalize-space()=\\"Search\\"]")' },
        strategy: 'role',
        targetFacts: { role: 'button', accessibleName: 'Search' },
        captureBinding: { kind: 'mcp_bound_ref', ref: 'e9' },
        proof: {
          count: 1,
          sameElement: true,
          visible: true,
          enabled: true,
          source: 'verified_dom_inspection',
          verified: true,
          actionTimeResolved: true,
          resolutionMode: 'bound_mcp_ref',
          identityVerified: true,
          targetIdentity: { scheme: 'qaai-dom-node-v1', connected: true, documentId: 'document:products', nodeId: 'node:search-submit' },
          matchedIdentity: { scheme: 'qaai-dom-node-v1', connected: true, documentId: 'document:products', nodeId: 'node:search-submit' },
        },
        domAtlas: {
          schemaVersion: 'qaai-dom-atlas-v1',
          url: 'https://example.test/products',
          routeKey: '/products',
          title: null,
          counts: { controls: 1 },
          controls: [{ selector: 'getByRole("button", { name: "Search" })', role: 'button', name: 'Search', visible: true, enabled: true, source: 'verified_dom_inspection' }],
          forms: [],
          tables: [],
          dialogs: [],
          landmarks: [],
          frames: [],
          shadowHosts: [],
          headings: [],
          verifiedActions: [{
            toolName: 'browser_click',
            elementLabel: 'Search submit button',
            strategy: 'role',
            expression: 'getByRole("button", { name: "Search" })',
            frameworkExpressions: { playwright: 'getByRole("button", { name: "Search" })', selenium: 'By.xpath("//button[normalize-space()=\\"Search\\"]")' },
            targetFacts: { role: 'button', accessibleName: 'Search' },
            context: {},
            proof: {
              count: 1,
              sameElement: true,
              visible: true,
              enabled: true,
              source: 'verified_dom_inspection',
              verified: true,
              actionTimeResolved: true,
              resolutionMode: 'bound_mcp_ref',
              identityVerified: true,
              targetIdentity: { scheme: 'qaai-dom-node-v1', connected: true, documentId: 'document:products', nodeId: 'node:search-submit' },
              matchedIdentity: { scheme: 'qaai-dom-node-v1', connected: true, documentId: 'document:products', nodeId: 'node:search-submit' },
            },
          }],
        },
        candidates: [{ strategy: 'role', role: 'button', name: 'Search' }],
      },
    }],
    status: 'pass',
    stepResults: [],
    testCaseName: 'Search products',
  });
  assert(actionLocatorPlan.traceVersion === 'v2', 'actionPlan: actionLocator marks the trace as v2');
  assert(actionLocatorPlan.actions[0].actionLocator?.expression === 'getByRole("button", { name: "Search" })', 'actionPlan: actionLocator is threaded into codegen actions');
  const actionBound = locators.buildManifest({ actions: actionLocatorPlan.actions, kbRows: [], labelOf: (a) => a.args.element, lang: 'ts' });
  assert(actionBound.actions[0].locator?.source === 'actionLocator', 'PW: actionLocator is preferred over KB/domFacts');
  assert(actionBound.actions[0].locator?.expression === 'getByRole("button", { name: "Search" })', 'PW: actionLocator expression is used verbatim');
  const replay = replayEmitter.buildReplayIR({
    caseId: 'action-locator-case',
    title: 'Action locator case',
    trail: [{
      tool: 'browser_click',
      ok: true,
      pageUrl: 'https://example.test/products',
      args: { element: 'Search button', ref: 'e7' },
      actionLocator: actionLocatorPlan.actions[0].actionLocator,
    }],
    declaredAssertions: [],
    assertionOutcomes: [],
  });
  const resolveStep = replay.ir.steps.find((s) => s.op === 'resolve');
  assert(resolveStep?.actionLocator?.expression === 'getByRole("button", { name: "Search" })', 'ReplayIR resolve step carries exact action-time locator expression');
}
// every generator wires the locator-replay rule into its system prompt
for (const f of ['pom.js', 'playwrightJs.js', 'playwrightBdd.js', 'selenium.js', 'seleniumBdd.js']) {
  const s = read(f);
  assert(/locatorPromptBlock/.test(s), `${f}: composes locatorPromptBlock into the system prompt`);
}
const locatorPromptTs = locators.locatorPromptBlock({ lang: 'ts' });
const locatorPromptJava = locators.locatorPromptBlock({ lang: 'java' });
assert(/GROUND TRUTH/.test(locatorPromptTs) && /VERBATIM/.test(locatorPromptTs), 'prompt mandates verbatim use of ground-truth locators');
assert(/QAAI_GUESSED_LOCATOR/.test(locatorPromptTs) && /exactly ONE/.test(locatorPromptTs) && !/QAAI_UNRESOLVED_LOCATOR/.test(locatorPromptTs), 'Playwright prompt preserves kbMiss actions with one warned semantic locator guess');
assert(/QAAI_GUESSED_LOCATOR/.test(locatorPromptJava) && /exactly ONE/.test(locatorPromptJava) && !/QAAI_UNRESOLVED_LOCATOR/.test(locatorPromptJava), 'Java prompt preserves kbMiss actions with one warned semantic locator guess');
// conductor binds the run-resolved locators onto the actionPlan before codegen
{
  const c = readSrv('agents/conductor.js');
  assert(/_locators/.test(c) && /buildManifest/.test(c), 'conductor enriches actionPlan via _locators.buildManifest');
  assert(/locatorManifest/.test(c), 'conductor attaches locatorManifest to the actionPlan');
  assert(/guessedLocatorFallback/.test(c) && /locatorWarnings/.test(c) && /qaai_guessed_locator/.test(c), 'conductor preserves locator misses with explicit guessed-locator metadata');
  assert(!/Certified export blocked: LOCATOR_UNRECOVERABLE/.test(c), 'conductor no longer blocks generated output for locator-only misses');
  assert(/exhaustiveRatify:\s*true/.test(c), 'default execution profile retries transient uncheckables with bounded ratification');
  assert(/normalizeAssertionCheckInputForDeclared/.test(c) && /FORBIDDEN_TEXT[\s\S]*unexpectedText/.test(c), 'conductor rewrites forbidden assertion_check payloads before MCP execution');
  assert(/assertion\.scope\.warning/.test(c) && /page_text_unscoped/.test(c), 'conductor warns when text assertions match without a container scope');
  assert(/internal_evidence_gap/.test(c) && /complete === false/.test(c), 'conductor converts incomplete ReplayIR into an internal evidence gap');
  assert(/actionLocatorResolver/.test(c) && /resolveVerifiedForTool/.test(c) && /dispatching_with_locator_warning/.test(c), 'conductor attempts verified actionLocator first and dispatches with truthful warning when capture is unavailable');
  assert(/annotateLastToolResult/.test(c) && /actionLocator/.test(c), 'conductor persists actionLocator into rich trace telemetry');
}
{
  const t = readSrv('turnTelemetry.js');
  assert(/annotateLastToolResult/.test(t) && /actionLocator/.test(t), 'turnTelemetry can annotate completed tool results with actionLocator');
}
{
  const t = readSrv('codegen/_replayTrace.js');
  assert(/actionLocator:\s*tr\.actionLocator/.test(t), 'replayTrace reconstructs actionLocator for journey/offline codegen');
}
{
  const r = readSrv('postLoopRatify.js');
  assert(/captureDomTextFallback/.test(r) && /document\.body\.innerText/.test(r), 'post-loop ratifier probes DOM text before accepting retryable uncheckable outcomes');
}
{
  const runs = readSrv('runs.js');
  const reports = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'Reports.jsx'), 'utf8');
  assert(/buildExportPreflight/.test(runs) && /exportPreflight/.test(runs), 'runs API returns export preflight readiness summary');
  assert(/Output preparing/.test(reports) && /Output files are still preparing/.test(reports), 'Reports uses compact human-readable output readiness details');
}

console.log('\n[10] PRE-AUTH EXPORT (SSO) — storageState baked + login skipped, TS+JS parity');
const ss = require('../server/services/codegen/_storageState');
const journey = require('../server/services/codegen/_journey');
const fakeState = { cookies: [{ name: 'session', value: 'abc', domain: 'example.com', path: '/' }], origins: [] };
assert(ss.isUsableState(fakeState) && !ss.isUsableState({ cookies: [], origins: [] }), 'isUsableState accepts a real session, rejects an empty one');
assert(/storageState/.test(ss.configUseLine(true)) && ss.configUseLine(false) === '', 'configUseLine wires storageState only when pre-authed');
assert(/Do NOT call login\(\)/.test(ss.preAuthPromptBlock()) && /storageState/.test(ss.preAuthPromptBlock()), 'preAuth prompt forbids login + cites storageState');
// Both Playwright shells must bake .auth/state.json + wire use.storageState.
for (const [label, mod, cfg] of [['pom', pom, 'playwright.config.ts'], ['playwrightJs', pwjs, 'playwright.config.js']]) {
  const dir = path.join(tmp, 'preauth-' + label);
  fs.mkdirSync(dir, { recursive: true });
  mod.ensureProjectShell(dir, { targetUrl: baseUrl, credProfile: prof, storageState: fakeState });
  assert(fs.existsSync(path.join(dir, '.auth', 'state.json')), `${label}: .auth/state.json baked`);
  assert(/storageState:/.test(fs.readFileSync(path.join(dir, cfg), 'utf8')), `${label}: config wires use.storageState`);
}
// generate() prompt parity: BOTH TS + JS support the preAuthenticated branch.
for (const f of ['pom.js', 'playwrightJs.js']) {
  const s = read(f);
  assert(/preAuthenticated/.test(s) && /preAuthPromptBlock/.test(s), `${f}: generate() honours preAuthenticated (skips login)`);
}
// Journey system prompt: requires the shared login normally, SKIPS it pre-authed.
assert(/Call login\(page\) ONCE/.test(journey.journeySystemPrompt({ lang: 'ts' })), 'journey (normal): calls the shared login once');
const jPre = journey.journeySystemPrompt({ lang: 'ts', preAuthenticated: true });
assert(/PRE-AUTHENTICATED/.test(jPre) && !/Call login\(page\) ONCE/.test(jPre), 'journey (pre-auth): skips login, navigates to the authed page');
// Conductor wires SSO end-to-end: resolves the fixture state + threads it through.
{
  const c = readSrv('agents/conductor.js');
  assert(/runPreAuthState/.test(c) && /defaultAuthFixtureId/.test(c), 'conductor resolves the run pre-auth state from the project AuthFixture');
  assert(/preAuthenticated: preAuthed/.test(c), 'conductor passes preAuthenticated into codegen.generate/generateJourney');
  assert(/storageState: preAuthState \|\| undefined/.test(c), 'conductor bakes the captured state into the exported shell');
}

console.log('\n[11] PARITY ENFORCEMENT — a non-pass case must not export an all-green spec');
{
  // MY half (landed): both lint sites feed caseStatus + framework so the parity
  // gate has what it needs. These pass now, independent of the friend's module.
  const c = readSrv('agents/conductor.js');
  assert(/caseStatus:\s*status,\s*framework/.test(c), 'conductor: per-case lint receives { caseStatus, framework }');
  assert(/journeyHadFailure/.test(c) && /aggregateStatus\s*=\s*journeyHadFailure\s*\?\s*'fail'\s*:\s*'pass'/.test(c) && /caseStatus:\s*aggregateStatus/.test(c), 'conductor: journey lint receives an aggregate caseStatus');
}
// FRIEND's half — self-activates the moment server/services/codegen/_parity.js
// lands (F1) + the lintGates parity gate is wired (F2). Until then this is a
// PENDING skip (not a failure) so the guard stays green during parallel work.
let parity = null;
try { parity = require('../server/services/codegen/_parity'); } catch (_) { parity = null; }
if (!parity || typeof parity.assessParity !== 'function') {
  console.log('  ⧖ pending — _parity.js not landed yet; detector + lint-gate checks activate on merge (NOT a failure)');
} else {
  const ap = (framework, caseStatus, code) => parity.assessParity({ framework, caseStatus, code });
  assert(ap('playwright-pom', 'pass', '// no asserts').enforced === true, 'parity: a PASS case is always enforced (green parity is the run\'s job)');
  assert(ap('playwright-pom', 'fail', 'await expect.soft(page.getByText("x")).toBeVisible();').enforced === false, 'parity: fail case with ONLY expect.soft → NOT enforced (would falsely pass)');
  assert(ap('playwright-pom', 'fail', 'await expect(page.getByText("x")).toBeVisible();').enforced === true, 'parity: fail case with a hard expect → enforced');
  assert(ap('playwright-js', 'blocked', 'await expect(page).toHaveURL(new RegExp("x"));').enforced === true, 'parity: blocked case with a hard expect → enforced');
  assert(ap('selenium-java', 'fail', 'assertTrue(driver.getPageSource().contains("x"), "msg");').enforced === true, 'parity (java): hard assertTrue → enforced');
  assert(ap('selenium-java', 'fail', 'softAssert.assertTrue(x, "m");').enforced === false, 'parity (java): softAssert with no assertAll() → NOT enforced');
  assert(ap('totally-unknown-framework', 'fail', '').enforced === true, 'parity: an unknown framework is never blocked');

  // The lintGates parity gate surfaces the inversion (lint accepts { caseStatus, framework }).
  let lintGatesMod = null;
  try { lintGatesMod = require('../server/services/lintGates'); } catch (_) { lintGatesMod = null; }
  if (lintGatesMod && typeof lintGatesMod.lint === 'function') {
    const hasParity = (r) => Array.isArray(r && r.findings) && r.findings.some((f) => /parity/i.test(f.rule || f.id || f.message || ''));
    const inv = lintGatesMod.lint('await expect.soft(page.getByText("x")).toBeVisible();', { caseStatus: 'fail', framework: 'playwright-pom' });
    assert(hasParity(inv), 'lint: a non-pass all-soft spec raises a parity_inversion finding');
    const okLint = lintGatesMod.lint('await expect(page.getByText("x")).toBeVisible();', { caseStatus: 'fail', framework: 'playwright-pom' });
    assert(!hasParity(okLint), 'lint: a hard-assert non-pass spec has NO parity finding');
    const bc = lintGatesMod.lint('await expect(page.getByText("x")).toBeVisible();');
    assert(bc && Array.isArray(bc.findings), 'lint: back-compat lint(content) with no opts still works');
  }
}

console.log('\n[12] EXPORT VALIDATION - generated packages are checked before review');
{
  const exportValidate = require('../server/services/codegen/_exportValidate');
  const bddExportGate = require('../server/services/codegen/_bddExportGate');
  assert(/_exportValidate/.test(readSrv('agents/conductor.js')) && /validateExport/.test(readSrv('agents/conductor.js')), 'conductor runs _exportValidate.validateExport before persisting review metadata');
  assert(/_bddExportGate/.test(readSrv('agents/conductor.js')) && /bddExportGate\.findings/.test(readSrv('agents/conductor.js')), 'conductor retains BDD operation-plan diagnostics alongside generated output');

  const badTs = exportValidate.validateExport({
    framework: 'playwright-pom',
    caseStatus: 'pass',
    files: {
      'tests/auth/login.spec.ts': 'import { test } from "@playwright/test"; test("x", async () => { const broken = ; });',
    },
  });
  assert(badTs.exportPassed === false && badTs.findings.some((f) => f.rule === 'export_syntax_error'), 'export validator: malformed Playwright TS is rejected');

  const seleniumSoft = exportValidate.validateExport({
    framework: 'selenium-java',
    caseStatus: 'fail',
    files: {
      'src/test/java/com/qaai/tests/LoginTest.java': 'import org.testng.annotations.Test; public class LoginTest { @Test public void login() { softAssert.assertTrue(true); } }',
    },
  });
  assert(seleniumSoft.exportPassed === false && seleniumSoft.findings.some((f) => f.rule === 'export_parity_inversion'), 'export validator: Selenium non-pass all-soft export is rejected');

  const javaMismatch = exportValidate.validateExport({
    framework: 'selenium-java',
    caseStatus: 'pass',
    files: {
      'src/test/java/com/qaai/tests/LoginTest.java': 'import org.testng.annotations.Test; public class WrongName { @Test public void login() {} }',
    },
  });
  assert(javaMismatch.findings.some((f) => f.rule === 'export_java_class_filename_mismatch'), 'export validator: Java class/file mismatch is rejected');

  const dupBdd = exportValidate.validateExport({
    framework: 'playwright-bdd',
    caseStatus: 'pass',
    files: {
      'features/a.feature': 'Feature: A\n  Scenario: first\n    Given I am logged in',
      'features/b.feature': 'Feature: B\n  Scenario: second\n    Given I am logged in.',
      'steps/a.steps.ts': 'import { createBdd } from "playwright-bdd"; const { Given } = createBdd(); Given("I am logged in", async () => {});',
    },
  });
  assert(dupBdd.exportPassed === false && dupBdd.findings.some((f) => f.rule === 'export_bdd_duplicate_step'), 'export validator: duplicate BDD step sentences are rejected');

  const droppedBdd = bddExportGate.assessBddOperationsForExport({
    framework: 'playwright-bdd',
    testCase: {
      name: 'Place order',
      operationsJson: JSON.stringify({
        status: 'incomplete',
        operations: [],
        dropped: [{ operation: 'invokeAction', reason: 'capability_not_in_atlas', detail: 'Place Order not crawled' }],
      }),
    },
  });
  assert(droppedBdd.exportable === true && droppedBdd.findings.some((f) => f.rule === 'bdd_export_operation_dropped' && f.severity === 'warning'), 'BDD output retains dropped-plan diagnostics without suppressing authored files');
}

console.log('\n[13] ASSEMBLEPACKAGE ESM/CJS CONSISTENCY — every Playwright adapter ships a matching support file');
{
  const { assemblePackage } = require('../server/services/codegen/replayExport');

  // For each Playwright adapter, assemble a minimal package and verify the support file
  // module style is consistent with the specs the adapter emits.
  //   POM adapters and playwright-reference (TS):  always ESM → support file has `export function`
  //   playwright-reference-js:                     always CJS → support file has `module.exports`
  const cases = [
    { adapterId: 'playwright-reference',    ext: '.ts', expectCjs: false },
    { adapterId: 'playwright-pom',          ext: '.ts', expectCjs: false },
    { adapterId: 'playwright-pom-js',       ext: '.js', expectCjs: false }, // POM JS always ESM
    { adapterId: 'playwright-reference-js', ext: '.js', expectCjs: true  },
  ];
  for (const { adapterId, ext, expectCjs } of cases) {
    const admitted = [{ filePath: `tests/case.spec${ext}`, content: `import { test } from '@playwright/test';` }];
    const files = assemblePackage({ adapterId, admitted, envVars: [] });
    const packageJson = JSON.parse(files['package.json'] || '{}');
    const supportTs = files['tests/support/replayir.ts'] || '';
    const supportJs = files['tests/support/replayir.js'] || '';
    const supportContent = supportTs || supportJs;
    if (expectCjs) {
      assert(packageJson.type !== 'module', `${adapterId}: CommonJS adapter package must not opt into ESM`);
      assert(supportContent.includes('module.exports'), `${adapterId}: support file must use CJS (module.exports). Got keys: ${Object.keys(files).filter(k=>k.includes('support')).join(', ')}`);
      assert(!supportContent.includes('export function'), `${adapterId}: support file must NOT use ESM export function`);
    } else {
      if (adapterId === 'playwright-pom-js') {
        assert(packageJson.type === 'module', `${adapterId}: package.json must set type=module`);
        assert(!!files['qaai.preflight.cjs'] && !files['qaai.preflight.js'], `${adapterId}: ESM package must ship CommonJS preflight as .cjs`);
        assert(files['playwright.config.ts'].includes("globalSetup: './qaai.preflight.cjs'"), `${adapterId}: config must reference .cjs preflight`);
        assert((files['utils/test-helpers.js'] || '').includes('export async function safeGoto'), `${adapterId}: JS test helper must be ESM`);
      } else {
        assert(packageJson.type !== 'module', `${adapterId}: TS adapters must not need package-level type=module`);
      }
      assert(/\bexport\s+(?:async\s+)?function\b|export\s*\{/.test(supportContent), `${adapterId}: support file must use ESM exports. Got keys: ${Object.keys(files).filter(k=>k.includes('support')).join(', ')}`);
      assert(!supportContent.includes('module.exports'), `${adapterId}: support file must NOT use CJS module.exports`);
    }
  }
}

console.log('\n[14] LOCATOR EXPRESSION SAFETY — role-only candidates are weak, not emitted');
{
  const { selectStaticLocator } = require('../server/services/codegen/adapters/playwrightReference');
  const { chooseCandidate } = require('../server/services/codegen/pageObjectRepository');

  // Empty string — no accessible name, so do not emit a bare role locator.
  const emptyResult = selectStaticLocator([{ strategy: 'role', role: 'button', name: '' }]);
  assert(emptyResult === null, `empty name → weak/null. Got: ${emptyResult}`);

  // Whitespace-only — do not emit { name: "  " } or a bare role fallback.
  const wsResult = selectStaticLocator([{ strategy: 'role', role: 'textbox', name: '  ' }]);
  assert(wsResult === null, `whitespace-only name → weak/null. Got: ${wsResult}`);

  // undefined name — role-only is not reliable enough for static emission.
  const undefResult = selectStaticLocator([{ strategy: 'role', role: 'link', name: undefined }]);
  assert(undefResult === null, `undefined name → weak/null. Got: ${undefResult}`);

  // If a weaker but named strategy exists, demote to it instead of stopping at role-only.
  const fallbackResult = selectStaticLocator([
    { strategy: 'role', role: 'textbox' },
    { strategy: 'placeholder', text: 'Username' },
  ]);
  assert(fallbackResult === `page.getByPlaceholder("Username")`, `role-only + placeholder → placeholder. Got: ${fallbackResult}`);
  const chosen = chooseCandidate([
    { strategy: 'role', role: 'textbox' },
    { strategy: 'placeholder', text: 'Username' },
  ]);
  assert(chosen && chosen.strategy === 'placeholder', `chooseCandidate mirrors selectStaticLocator demotion. Got: ${JSON.stringify(chosen)}`);

  // Valid non-empty name — must still produce the name option.
  const validResult = selectStaticLocator([{ strategy: 'role', role: 'button', name: 'Login' }]);
  assert(validResult && validResult.includes('"Login"'), `valid name → includes name in option. Got: ${validResult}`);
}

console.log('\n[15] ASSERTION CARDINALITY GAP — declared/live outcome count mismatches are visible');
{
  const { reduceAssertionOutcomes, buildAssertionCardinalityFindings } = require('../server/services/codegen/replayExport');

  // Two declared assertions; only A1 was actually checked during the run.
  const declaredRaw = JSON.stringify([
    { id: 'A1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Dashboard' } },
    { id: 'A2', type: 'TEXT', criticality: 'should', payload: { expectedText: 'Welcome' } },
  ]);
  const checkResults = JSON.stringify([
    { assertionId: 'A1', outcome: 'matched', ts: 1 },
    // A2 intentionally absent — never checked by the conductor
  ]);

  const liveOutcomes = reduceAssertionOutcomes(checkResults);
  const declared = fidelity.declaredAssertionsFor({ declaredAssertions: declaredRaw });
  const presentState = fidelity.declaredAssertionsStateFor({ declaredAssertions: declaredRaw });
  const missingState = fidelity.declaredAssertionsStateFor({});
  const emptyState = fidelity.declaredAssertionsStateFor({ declaredAssertions: '[]' });
  const uncovered = declared.filter((a) => a.id && !(a.id in liveOutcomes));
  const cardinalityGap = buildAssertionCardinalityFindings([{
    runResultId: 'RR1',
    testCaseId: 'TC1',
    declaredAssertionsRaw: declaredRaw,
    liveOutcomes,
  }]);

  assert(declared.length === 2, `expected 2 declared assertions, got ${declared.length}`);
  assert(presentState.state === 'present' && presentState.declaredCount === 2, `present declaredAssertions state is explicit. Got: ${JSON.stringify(presentState)}`);
  assert(missingState.state === 'missing', `missing declaredAssertions is distinguishable. Got: ${JSON.stringify(missingState)}`);
  assert(emptyState.state === 'empty' && emptyState.declaredCount === 0, `empty declaredAssertions is distinguishable. Got: ${JSON.stringify(emptyState)}`);
  assert('A1' in liveOutcomes, 'A1 has a live outcome (matched)');
  assert(!('A2' in liveOutcomes), 'A2 has no live outcome — correctly identified as unchecked');
  assert(uncovered.length === 1 && uncovered[0].id === 'A2',
    `uncovered should be [A2], got ${JSON.stringify(uncovered.map(a => a.id))}`);
  assert(cardinalityGap.length === 1 && cardinalityGap[0].rule === 'assertion_cardinality_gap',
    `cardinality gap finding emitted. Got: ${JSON.stringify(cardinalityGap)}`);
  assert(cardinalityGap[0].declaredCount === 2 && cardinalityGap[0].liveOutcomeCount === 1,
    `cardinality finding carries declared/live counts. Got: ${JSON.stringify(cardinalityGap[0])}`);
  assert(cardinalityGap[0].missingAssertions.length === 1 && cardinalityGap[0].missingAssertions[0].id === 'A2',
    `cardinality finding carries missing assertion IDs. Got: ${JSON.stringify(cardinalityGap[0])}`);

  // When all declared assertions ARE covered (even as uncheckable), no gap
  const allCheckedRaw = JSON.stringify([
    { assertionId: 'A1', outcome: 'matched', ts: 1 },
    { assertionId: 'A2', outcome: 'uncheckable', ts: 2 },
  ]);
  const allOutcomes = reduceAssertionOutcomes(allCheckedRaw);
  const noGap = declared.filter((a) => a.id && !(a.id in allOutcomes));
  assert(noGap.length === 0, `all assertions covered (uncheckable counts) — expected 0 gap, got ${noGap.length}`);
  assert(buildAssertionCardinalityFindings([{ declaredAssertionsRaw: declaredRaw, liveOutcomes: allOutcomes }]).length === 0,
    'all declared assertions covered — no cardinality finding');

  // Empty liveOutcomes (conductor never ran assertion_check at all)
  const noneChecked = reduceAssertionOutcomes('[]');
  const allUncovered = declared.filter((a) => a.id && !(a.id in noneChecked));
  assert(allUncovered.length === 2, `conductor checked nothing — both assertions flagged as uncovered`);
  const missingDeclared = buildAssertionCardinalityFindings([{ runResultId: 'RR2', testCaseId: 'TC2', declaredAssertionsRaw: null, liveOutcomes: {} }]);
  assert(missingDeclared.length === 1 && missingDeclared[0].gapKind === 'declared_assertions_missing',
    `missing declaredAssertions emits explicit cardinality warning. Got: ${JSON.stringify(missingDeclared)}`);
  const intentionallyEmpty = buildAssertionCardinalityFindings([{ runResultId: 'RR3', testCaseId: 'TC3', declaredAssertionsRaw: '[]', liveOutcomes: {} }]);
  assert(intentionallyEmpty.length === 0, `intentionally empty declaredAssertions with zero outcomes is not a gap. Got: ${JSON.stringify(intentionallyEmpty)}`);
  const extraLive = buildAssertionCardinalityFindings([{ runResultId: 'RR4', testCaseId: 'TC4', declaredAssertionsRaw: '[]', liveOutcomes: { A99: { outcome: 'matched' } } }]);
  assert(extraLive.length === 1 && extraLive[0].extraLiveOutcomeIds[0] === 'A99',
    `live outcomes with intentionally empty declaredAssertions are visible as extras. Got: ${JSON.stringify(extraLive)}`);
}

console.log('\n[16] SANITIZER OBSERVABILITY — sanitizeGeneratedDetailed + certifyFile return rewrites');
{
  const { sanitizeGeneratedDetailed } = require('../server/services/codegen/_sanitize');
  const { certifyFile } = require('../server/services/codegen/_certify');

  // Clean code: spec that already includes the test-helpers import so the sanitizer
  // has nothing to add. All rules are no-ops: no page.goto, no descriptor text, no
  // bare evaluate, no credential fills. The helper-injection rule also skips because
  // utils/test-helpers (including safeGoto) is already present.
  const cleanCode = [
    `import { test, expect } from '@playwright/test';`,
    `import { clickFirstVisible, safeClick, safeGoto } from '../../utils/test-helpers';`,
    ``,
    `test('verify title', async ({ page }) => {`,
    `  await expect(page).toHaveTitle(/Example/);`,
    `});`,
    ``,
  ].join('\n');
  const cleanResult = sanitizeGeneratedDetailed(cleanCode, 'tests/suite/clean.spec.ts');
  assert(cleanResult.code === cleanCode, '[16] clean input: code must be unchanged (all sanitizer rules are no-ops)');
  assert(Array.isArray(cleanResult.rewrites), '[16] clean input: rewrites must be an array');
  assert(cleanResult.rewrites.length === 0, `[16] clean input: rewrites must be empty. Got: ${JSON.stringify(cleanResult.rewrites)}`);

  // Descriptor-text getByText: rule 5 fires → rewrites is non-empty.
  // "User profile menu top right section" is > 25 chars → looksLikeDescriptorText → throw injected.
  const dirtyCode = [
    `import { test, expect } from '@playwright/test';`,
    `import { clickFirstVisible, safeClick, safeGoto } from '../../utils/test-helpers';`,
    ``,
    `test('dirty', async ({ page }) => {`,
    `  await page.getByText("User profile menu top right section", { exact: true }).click();`,
    `});`,
    ``,
  ].join('\n');
  const dirtyResult = sanitizeGeneratedDetailed(dirtyCode, 'tests/suite/dirty.spec.ts');
  assert(dirtyResult.rewrites.length > 0, `[16] dirty input: rewrites must be non-empty (sanitizer fired). Got: ${JSON.stringify(dirtyResult.rewrites)}`);
  assert(dirtyResult.rewrites[0].relPath === 'tests/suite/dirty.spec.ts', `[16] rewrite entry must carry relPath. Got: ${JSON.stringify(dirtyResult.rewrites[0])}`);
  assert(typeof dirtyResult.rewrites[0].linesIn === 'number', `[16] rewrite entry must carry linesIn`);
  assert(typeof dirtyResult.rewrites[0].linesOut === 'number', `[16] rewrite entry must carry linesOut`);

  // certifyFile on clean code: rewrites is empty
  const certClean = certifyFile({ relPath: 'tests/suite/clean.spec.ts', content: cleanCode });
  assert(Array.isArray(certClean.rewrites), '[16] certifyFile: rewrites must be an array');
  assert(certClean.rewrites.length === 0, `[16] certifyFile clean: rewrites must be empty. Got: ${JSON.stringify(certClean.rewrites)}`);

  // certifyFile on dirty code: rewrites is non-empty
  const certDirty = certifyFile({ relPath: 'tests/suite/dirty.spec.ts', content: dirtyCode });
  assert(certDirty.rewrites.length > 0, `[16] certifyFile dirty: rewrites must be non-empty. Got: ${JSON.stringify(certDirty.rewrites)}`);
}

console.log('\n[17] POM-JS PACKAGE SMOKE — ESM package collects with validateAssembled');
{
  const smokeSource = `
const path = require('path');
const X = require('./server/services/codegen/replayExport');
const adapter = require('./server/services/codegen/adapters/playwrightPomJs');
(async () => {
  const usernameActionLocator = {
    kind: 'playwright',
    verified: true,
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    expression: 'getByRole("textbox", { name: "Username" })',
    frameworkExpressions: { playwright: 'getByRole("textbox", { name: "Username" })' },
    strategy: 'role',
    targetFacts: { tag: 'input', role: 'textbox', accessibleName: 'Username' },
    proof: { count: 1, sameElement: true, visible: true, enabled: true, source: 'verified_dom_inspection', verified: true },
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      url: 'https://example.com/login',
      routeKey: '/login',
      title: null,
      counts: { controls: 1 },
      controls: [{ selector: 'getByRole("textbox", { name: "Username" })', tag: 'input', role: 'textbox', name: 'Username', visible: true, enabled: true, source: 'verified_dom_inspection' }],
      forms: [],
      tables: [],
      dialogs: [],
      landmarks: [],
      frames: [],
      shadowHosts: [],
      headings: [],
      verifiedActions: [{
        toolName: 'browser_type',
        elementLabel: 'Username',
        strategy: 'role',
        expression: 'getByRole("textbox", { name: "Username" })',
        frameworkExpressions: { playwright: 'getByRole("textbox", { name: "Username" })' },
        targetFacts: { tag: 'input', role: 'textbox', accessibleName: 'Username' },
        context: {},
        proof: { count: 1, sameElement: true, visible: true, enabled: true, source: 'verified_dom_inspection', verified: true },
      }],
    }
  };
  const steps = [
    { op: 'act', action: 'navigate', url: 'https://example.com/login' },
    { op: 'resolve', as: 'user', pageUrl: 'https://example.com/login', actionLocator: usernameActionLocator, candidates: [{ strategy: 'role', role: 'textbox', name: 'Username' }] },
    { op: 'act', target: 'user', action: 'fill', dataRole: 'username' },
    { op: 'assert', channel: 'EVALUATE', script: 'document.body.textContent.includes("Example")', expected: 'true', liveOutcome: 'matched' },
  ];
  const emitted = adapter.emitJourneySpec([{ caseName: 'Login', ir: { title: 'Login', steps, dataRows: [{ index: 0, label: 'Admin', fields: { username: 'admin' } }] } }], { scenarioName: 'Login', scenarioId: 'SC', specDir: 'tests/auth' });
  const files = X.assemblePackage({
    adapterId: 'playwright-pom-js',
    admitted: [{ filePath: 'tests/auth/login.spec.js', content: emitted.content, extraFiles: emitted.extraFiles }],
    envVars: [],
  });
  const validation = await X.validateAssembled({ adapterId: 'playwright-pom-js', files });
  let depAvailable = false;
  try {
    require.resolve('@playwright/test/package.json', { paths: [path.resolve('server'), process.cwd()] });
    depAvailable = true;
  } catch (_) {}
  const output = {
    pkgType: JSON.parse(files['package.json']).type,
    hasCjsPreflight: !!files['qaai.preflight.cjs'],
    configPreflight: files['playwright.config.ts'].includes("globalSetup: './qaai.preflight.cjs'"),
    supportEsm: /export\\s*\\{/.test(files['tests/support/replayir.js'] || ''),
    helperEsm: /export async function safeGoto/.test(files['utils/test-helpers.js'] || ''),
    specSupportExt: (files['tests/auth/login.spec.js'] || '').includes("../support/replayir.js"),
    specPageExt: (files['tests/auth/login.spec.js'] || '').includes("../../pages/LoginPage.js"),
    pageLocatorExt: (files['pages/LoginPage.js'] || '').includes("../locators/loginPage.locators.js"),
    shimGeneratedExt: (files['locators/loginPage.locators.js'] || '').includes("./generated/loginPage.generated.locators.js"),
    evalSupportExt: (files['pages/EvaluateMethods.js'] || '').includes("../tests/support/replayir.js"),
    depAvailable,
    checked: validation.checked,
    skipped: validation.skipped,
    packagePassed: validation.packagePassed,
    commands: (validation.commands || []).map((c) => c.cmd),
    findings: validation.findings || [],
  };
  console.log(JSON.stringify(output));
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
`;
  const smoke = cp.spawnSync(process.execPath, ['-e', smokeSource], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert(smoke.status === 0, `[17] smoke subprocess exits 0. stdout=${smoke.stdout} stderr=${smoke.stderr}`);
  let payload = null;
  try {
    const lines = String(smoke.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    payload = JSON.parse(lines[lines.length - 1] || '{}');
  } catch (err) {
    bad(`[17] smoke JSON parse failed: ${err.message}. stdout=${smoke.stdout} stderr=${smoke.stderr}`);
  }
  if (payload) {
    assert(payload.pkgType === 'module', '[17] POM-JS package.json sets type=module');
    assert(payload.hasCjsPreflight && payload.configPreflight, '[17] POM-JS uses qaai.preflight.cjs from config');
    assert(payload.supportEsm && payload.helperEsm, '[17] POM-JS support/helper JS files are ESM');
    assert(payload.specSupportExt && payload.specPageExt && payload.pageLocatorExt && payload.shimGeneratedExt && payload.evalSupportExt,
      `[17] POM-JS relative imports include .js extensions. Payload=${JSON.stringify(payload)}`);
    if (payload.depAvailable) {
      assert(payload.checked === true && payload.skipped === false, `[17] validateAssembled must not skip when Playwright is locally available. Payload=${JSON.stringify(payload)}`);
      assert(payload.commands.includes('playwright test --list'), `[17] validateAssembled runs playwright test --list. Commands=${JSON.stringify(payload.commands)}`);
      assert(payload.packagePassed === true, `[17] POM-JS package collection passes. Findings=${JSON.stringify(payload.findings)}`);
    }
  }
}

console.log('\n[18] DIAGNOSTIC-ONLY OUTPUT — environment flags cannot promote warnings into export gates');
{
  const packageValidateSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'codegen', '_packageValidate.js'), 'utf8');
  const replayEmitterSource = readSrv('codegen/replayEmitter.js');
  const replayExportSource = readSrv('codegen/replayExport.js');
  const diagnosticSources = packageValidateSource + replayEmitterSource + replayExportSource;
  assert(!/QAAI_RELEASE_CERTIFICATION/.test(diagnosticSources), '[18] codegen has no environment-controlled release certification gate');
  assert(!/releaseCertificationEnabled|buildReleaseCertificationFindings|releaseCertification:\s*true/.test(diagnosticSources), '[18] warning-to-error certification promotion is removed');
  assert(/finding\(\s*'package_[^']+',\s*'warning',[^\n]*validation skipped/i.test(packageValidateSource) && /skipped:\s*true/.test(packageValidateSource), '[18] skipped package validation remains a visible warning');
}

console.log('\n[19] UNABLE-TO CONTRACTS — ratification/package gaps cannot ship silently');
{
  const replayEmitter = require('../server/services/codegen/replayEmitter');
  const emitted = replayEmitter.buildReplayIR({
    caseId: 'TC-RATIFY',
    title: 'Ratification failed case',
    trail: [{ tool: 'browser_navigate', ok: true, args: { url: 'https://example.com' } }],
    declaredAssertions: [],
    assertionOutcomes: [],
    platformGaps: [{ code: 'ratification_failed', where: 'TC-RATIFY', detail: 'synthetic ratifier crash' }],
    verdictStatus: 'blocked',
  });
  assert(emitted.complete === false, '[19] ratification_failed platform gap makes ReplayIR incomplete');
  assert((emitted.gaps || []).some((g) => g.code === 'ratification_failed'), '[19] ReplayIR carries ratification_failed gap');

  const replayExportSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'codegen', 'replayExport.js'), 'utf8');
  const conductorSource = readSrv('agents/conductor.js');
  const { repairTypeScriptDiagnostics } = require('../server/services/codegen/_certify');
  const repairedTs = repairTypeScriptDiagnostics({
    'tests/card.spec.ts': [
      "const maybeText: string | null = process.env.CARD_TITLE || null;",
      "await assertTextPresent(page, maybeText, 'body');",
      "const payload: unknown = {};",
      "console.log(payload.total);",
    ].join('\n'),
  }, [
    "tests/card.spec.ts(2,31): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.",
    "tests/card.spec.ts(4,21): error TS2339: Property 'total' does not exist on type 'unknown'.",
  ].join('\n'));
  const skippedValidationIsDiagnostic = /package_validation_skipped_export_gate[\s\S]{0,220}severity:\s*'warning'[\s\S]{0,120}nonBlocking:\s*true/.test(replayExportSource);
  const artifactAvailabilityIsIndependent = /manifest\.outputAvailable\s*=\s*scriptArtifacts\.length\s*>\s*0\s*&&\s*secretFindings\.length\s*===\s*0/.test(replayExportSource);
  assert(skippedValidationIsDiagnostic && artifactAvailabilityIsIndependent, '[19] replay export reports skipped package validation without blocking generated output');
  assert(/ratification_failed/.test(conductorSource) && /platformGaps/.test(conductorSource), '[19] conductor sends ratification failure into ReplayIR platformGaps');
  assert(/codegen-failures\.json/.test(conductorSource) && /packageValidation/.test(conductorSource) && !/gateBlocked\s*=\s*!!\([^\n]*packageSkipped/.test(conductorSource), '[19] inline codegen retains validation diagnostics without blocking when package validation is skipped');
  assert((repairedTs.repairs || []).length === 2, '[19] TypeScript diagnostic repair handles nullable strings and missing properties');
  assert(/\(\(maybeText\) \?\? ''\)/.test(repairedTs.files['tests/card.spec.ts']) && /\(payload as any\)\.total/.test(repairedTs.files['tests/card.spec.ts']), '[19] TypeScript diagnostic repair rewrites known generated-code failures');
  assert(/repairTypeScriptDiagnostics/.test(conductorSource) && /codegenAutoRepairs/.test(conductorSource), '[19] conductor retries tsc after bounded TypeScript auto-repair');
  assert(/findRefForKbLocator/.test(conductorSource) && /KB-ref translation/.test(conductorSource), '[19] conductor attempts deterministic live locator ref recovery before explicit semantic guessing');
  assert(/UNRECOVERABLE_RETRY_LIMIT/.test(conductorSource) && /case and codegen continue without claiming success/.test(conductorSource) && !/giving up on this element \(escalate to abort\)/.test(conductorSource), '[19] exhausted live locator retries preserve the failed step and continue case/codegen without claiming success');
}

console.log('\n[20] POM GRAPH CONTRACT â€” assembled package links are validated before runnable export');
{
  const brokenPom = {
    '.env.example': 'QAAI_TARGET_URL=\n',
    'tests/catalog/search.spec.js': [
      "import { test } from '@playwright/test';",
      "import { ProductsPage } from '../../pages/ProductsPage.js';",
      "test('search', async ({ page }) => {",
      "  const productsPage = new ProductsPage(page);",
      "  await productsPage.fillSearchProduct('Printed');",
      "});",
      '',
    ].join('\n'),
    'pages/ProductsPage.js': [
      "import { productsPageLocators } from '../locators/productsPage.locators.js';",
      'export class ProductsPage { constructor(page) { this.page = page; } }',
      '',
    ].join('\n'),
    'locators/productsPage.locators.js': "export * from './generated/productsPage.generated.locators.js';\n",
    'locators/generated/productsPage.generated.locators.js': 'export const productsPageLocators = {};\n',
    'evidence/locator-manifest.json': '[]\n',
    'evidence/certification-report.json': JSON.stringify({ spec: { status: 'runnable' } }) + '\n',
  };
  const findings = replayExport.validatePomFileGraph('playwright-pom-js', brokenPom);
  const rules = new Set(findings.map((f) => f.rule));
  assert(typeof replayExport.validatePomFileGraph === 'function', '[20] replayExport exposes validatePomFileGraph');
  assert(rules.has('pom_graph_missing_page_method'), '[20] graph validator catches spec calls to missing page methods');
  assert(rules.has('pom_graph_report_false_runnable'), '[20] runnable report is rejected when graph links are broken');

  const brokenDataPom = {
    '.env.example': 'QAAI_TARGET_URL=\n',
    'tests/products/search.spec.js': [
      "import { test } from '@playwright/test';",
      "import { loadDataRows, readData } from '../support/replayir.js';",
      "const rows = loadDataRows('tests/data/search-cases.json');",
      "for (const row of rows) {",
      "  test('search ' + row.label, async ({ page }) => {",
      "    await page.goto('/products');",
      "    await page.getByPlaceholder('Search Product').fill(readData(row, 'searchName'));",
      "    await page.getByText('Printed').click();",
      "    await page.locator('#missing').fill(readData(row, 'missingColumn'));",
      "  });",
      "}",
      '',
    ].join('\n'),
    'tests/data/search-cases.json': JSON.stringify([
      { index: 0, label: 'Row 1', fields: { searchName: 'Printed' } },
    ], null, 2) + '\n',
  };
  const dataFindings = replayExport.validatePomFileGraph('playwright-pom-js', brokenDataPom);
  const dataRules = new Set(dataFindings.map((f) => f.rule));
  assert(dataRules.has('pom_graph_missing_data_column'), '[20] graph validator catches readData(row, ...) columns absent from JSON slices');
  assert(dataRules.has('pom_graph_hardcoded_data_value'), '[20] graph validator catches uploaded row values hardcoded into specs');

  const weakDomainPom = {
    '.env.example': 'QAAI_TARGET_URL=\n',
    'tests/products/filter.spec.js': [
      "import { test } from '@playwright/test';",
      "import { loadDataRows, readData, assertTextPresent } from '../support/replayir.js';",
      "const rows = loadDataRows('tests/data/filter-cases.json');",
      "for (const row of rows) {",
      "  test('filter ' + row.label, async ({ page }) => {",
      "    await assertTextPresent(page, readData(row, 'expectedContainsProductName'), '', 10000);",
      "    await assertTextPresent(page, 'Rs.', '', 10000);",
      "  });",
      "}",
      '',
    ].join('\n'),
    'tests/data/filter-cases.json': JSON.stringify([
      { index: 0, label: 'Row 1', fields: { expectedContainsProductName: 'Printed', assertProductCategory: 'Women - Dress Products', priceMin: '50', priceMax: '150' } },
    ], null, 2) + '\n',
  };
  const weakDomainRules = new Set(replayExport.validatePomFileGraph('playwright-pom-js', weakDomainPom).map((f) => f.rule));
  assert(weakDomainRules.has('pom_graph_product_name_data_not_asserted'), '[20] graph validator rejects product-name data checked with generic text-only assertions');
  assert(weakDomainRules.has('pom_graph_product_category_data_not_asserted'), '[20] graph validator rejects category data without product-category assertion helper');
  assert(weakDomainRules.has('pom_graph_price_data_not_asserted'), '[20] graph validator rejects price-range data without assertPricesBetween');

  const XLSX = require('xlsx');
  const exportedDataFiles = replayExport.buildTestDataFiles([{
    id: 'TD-SEARCH',
    name: 'AutomationExercise ProductSearchFilter TestData.xlsx',
    sheetsJson: JSON.stringify({
      sheets: [{
        name: 'FilterData',
        headers: ['testCaseID', 'searchName', 'expectedContainsProductName'],
        rows: [{ testCaseID: 'TC-FILTER-01', searchName: 'Printed', expectedContainsProductName: 'Printed' }],
      }],
    }),
  }], 'tests/data');
  const workbookPath = Object.keys(exportedDataFiles).find((k) => k.endsWith('.xlsx'));
  const csvPath = Object.keys(exportedDataFiles).find((k) => k.endsWith('-filterdata.csv'));
  assert(workbookPath && Buffer.isBuffer(exportedDataFiles[workbookPath]), '[20] test data export includes a real binary .xlsx workbook');
  assert(csvPath && /TC-FILTER-01/.test(exportedDataFiles[csvPath]), '[20] test data export keeps CSV sheet fallback with original rows');
  const wb = XLSX.read(exportedDataFiles[workbookPath], { type: 'buffer' });
  const sheet = XLSX.utils.sheet_to_json(wb.Sheets.FilterData || wb.Sheets[wb.SheetNames[0]], { defval: '' });
  assert(sheet.length === 1 && sheet[0].searchName === 'Printed', '[20] exported workbook preserves headers and row values for human editing');
}

console.log('\n[21] ACTIVE PROJECT MEMORY - reruns try stable action memory before model fallback');
{
  const conductorSource = readSrv('agents/conductor.js');
  const memorySource = readSrv('projectActionMemory.js');
  const resolveIdx = conductorSource.indexOf('projectActionMemory.resolveActionMemory');
  const captureIdx = conductorSource.indexOf('actionLocatorResolver.resolveVerifiedForTool');
  // Match the call prefix only — the signature legitimately gained a trailing
  // cancelSignal/options argument, so don't pin the closing paren.
  const callIdx = conductorSource.indexOf('mcp.callTool(mcpSession, tu.name, resolvedInput');
  assert(resolveIdx > 0 && captureIdx > resolveIdx && callIdx > captureIdx, '[21] conductor resolves project memory before action-time capture and MCP execution');
  assert(/recordActionMemorySuccess/.test(conductorSource) && /recordActionMemoryFailure/.test(conductorSource), '[21] conductor records both successful and failed memory-backed actions');
  assert(/tryMemoryFirstReplay/.test(conductorSource) && /memoryReplayToolForStep/.test(conductorSource), '[21] conductor has a deterministic memory-first replay path before model fallback');
  assert(/Project memory already executed/.test(conductorSource), '[21] conductor tells the model which leading actions memory already completed');
  assert(/stepIntentHashVersion/.test(memorySource) && /qaai-step-intent-v1/.test(memorySource), '[21] ProjectActionMemory uses a versioned stable intent hash');
  assert(!/stepOrdinal[^;\n]*sha256/.test(memorySource), '[21] stepOrdinal is not part of the hash identity');
  assert(/parseMcpSnapshotToCandidates/.test(memorySource) && /drift_repaired/.test(memorySource), '[21] memory resolution translates remembered locators through the current snapshot');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${failures === 0 ? 'PASS — all codegen-contract checks green' : 'FAIL — ' + failures + ' check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
