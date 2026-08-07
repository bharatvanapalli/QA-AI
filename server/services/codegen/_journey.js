'use strict';

/**
 * Playwright FLAT journey codegen (P1b — architectural review 2026-06-02).
 *
 * A "journey" = a dependsOnIds chain (a weakly-connected component, see
 * _journeys.js) emitted as ONE spec: a single test() with one test.step() per
 * case, in dependency order, sharing ONE browser page and ONE lexical scope.
 *
 * WHY FLAT (no Page Object): POM exists to spare HUMANS from editing 50 files
 * when a selector changes. When the suite is regenerated deterministically from
 * a live trace on demand, POM is pure overhead — and worse, it would force the
 * unique-data thread (P4) to cross five Page Object class boundaries inside an
 * LLM prompt. A flat spec lets the journey hoist `const firstName =
 * \`John${Date.now()}\`` at the top of the test body, and JS lexical scope
 * carries it to every step for free.
 *
 * Shared by pom.js (ts) and playwrightJs.js (js) via generatePlaywrightJourney.
 */

const envContract = require('./_env');
const { authPromptBlock } = require('./_login');
const fidelity = require('./_fidelity');
const locators = require('./_locators');
const storageStateLib = require('./_storageState');
const { recoverOne } = require('./_recoverJson');
const playwrightPomAdapter = require('./adapters/playwrightPom');
const playwrightReference = require('./adapters/playwrightReference');

function cleanSlug(s, fallback = 'journey') {
  const out = String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  return out || fallback;
}

/** Journey file path. Single file, no page object. */
function journeyLayout(scenario, journeyCases, lang = 'ts') {
  const ext = lang === 'js' ? 'js' : 'ts';
  const moduleSlug = cleanSlug(scenario && scenario.module, 'app');
  const root = (journeyCases && journeyCases[0]) || {};
  const slug = cleanSlug(root.name, (root.id || 'journey').slice(0, 8));
  const testFile = `tests/${moduleSlug}/${slug}-journey.spec.${ext}`;
  return { testFile, primaryFile: testFile, moduleSlug, slug, isJourney: true };
}

function journeySystemPrompt({ lang = 'ts', preAuthenticated = false }) {
  const isJs = lang === 'js';
  const imp = isJs
    ? "const { test, expect } = require('@playwright/test');"
    : "import { test, expect } from '@playwright/test';";
  // Pre-authenticated (SSO) journeys start logged in via use.storageState — the
  // login line is REPLACED with a navigate-to-the-first-page line (the emphatic
  // PRE-AUTHENTICATED SUITE block, appended by the caller, forbids login()).
  const authLine = preAuthenticated
    ? `- This is a PRE-AUTHENTICATED suite (see the PRE-AUTHENTICATED SUITE block): do NOT import or call login(). Begin the test body by navigating to the first authenticated page the journey acts on.`
    : `- import { login } from the shared auth module (path in the LOGIN section). Call login(page) ONCE — \`await login(page)\` MUST be the FIRST statement of the test body.
  IMPORTANT: credential fill actions (username/password/email browser_fill calls) and login button clicks have been REMOVED from every step's actionPlan before this prompt was built — they will NOT appear in any step's action list. Do NOT add them back. Do NOT generate any .fill() for a username, password, or email field. Do NOT generate a Login button click. The single \`await login(page)\` at the top handles navigate → fill → click → wait entirely.
  If a LATER step requires logging in as a DIFFERENT user (e.g. after a logout, switching from one role to another), emit \`await login(page)\` again at the start of that step — do NOT inline fills.`;

  const loginContractBlock = preAuthenticated ? '' : `
## LOGIN CONTRACT — hard gate

Credential fill actions and login button clicks are NOT in the action plan. They were stripped before this prompt. Do not emit any of these:
  ❌ \`.fill(readEnv('QAAI_USERNAME'))\` / \`.fill(readEnv('QAAI_PASSWORD'))\`
  ❌ \`page.getByRole('textbox', { name: 'Username' }).fill(...)\`
  ❌ any click on a "Login" / "Sign in" / "Submit" button

If you believe credentials need to be filled inline, you have misread the action plan. Use \`await login(page)\` only.

NEGATIVE CREDENTIAL EXCEPTION: if this step is explicitly testing a REJECTED login (caseName contains "invalid", "wrong", "empty password", "negative"), THEN — and ONLY then — emit the credential fills and login click inline using wrong/empty values, NOT readEnv('QAAI_USERNAME'/'QAAI_PASSWORD').`;

  // negativeCredBlock is now merged into loginContractBlock above.
  const negativeCredBlock = '';
  return `You are a senior SDET writing a SINGLE Playwright ${isJs ? 'JavaScript' : 'TypeScript'} end-to-end JOURNEY spec.

These cases are NOT independent tests — they are sequential STEPS of ONE business journey that ran in ONE browser session, in the given order. A later case depends on state/data an earlier case created (e.g. case 1 CREATES a record, case 2 SEARCHES for that same record). You MUST emit them as ONE test with one test.step() per case, sharing a single \`page\` and a single lexical scope.

OUTPUT: a single JSON object { "test": { "path": "<relative/path/from/project-root>", "content": "<full file contents>" } }. NO markdown fences, NO other text.

STRUCTURE — exactly this shape:
- ${imp}
${authLine}
- ONE test.describe('<module> — <journey name>') containing ONE test('<journey title>', async ({ page }) => { ... }).
- SHARED DATA (the whole reason this is one file): any value the journey CREATES and then RE-USES later (a name, id, email, code) MUST be declared ONCE as a const at the TOP of the test body, made UNIQUE per run, and referenced by that const in EVERY later step. Example:
    const runId = Date.now();
    const firstName = \`John\${runId}\`;
  then the create step types firstName, and the search step searches for the SAME firstName. NEVER hard-code a literal that the journey both creates and later searches — it collides with prior runs (unique-constraint / duplicate rows) and the search matches the wrong row or nothing. If the action plan shows a create step typing a value that a later step searches, that value MUST become a shared unique const.
- One \`await test.step('<case name>', async () => { ... })\` per case, IN THE GIVEN ORDER (the "steps" array). Inside each step: the actions that case performed, then that case's declared assertions.
- End the test with: await page.screenshot({ path: 'test-results/<journey-slug>.png' });

NO INVENTED HELPERS — write assertions INLINE:
- Do NOT generate helper functions named assertTextPresent, assertVisible, checkText, or any custom assertion wrapper. Do NOT emit a support/replayir.ts or any file other than the single test file. Write all assertions inline using the OR-chain from VERDICT FIDELITY. NEVER scope assertions to page.locator('main') — sidebar navigation content (for example "Reports" or "Settings") can be outside main and will silently fail.

PER-STEP FIDELITY: each entry in "steps" carries its OWN caseStatus, declaredAssertions and actionPlan (with per-action resolved locators). Apply the VERDICT FIDELITY and LOCATOR REPLAY rules below to EACH step independently. A step whose caseStatus is "pass" must go green; a step whose caseStatus is "fail"/"blocked" asserts its declared values faithfully and may go red — do NOT repair it. The test naturally halts at the first failing step, which faithfully reproduces a chain breaking at its failure point.

DEPENDENCY COMPLETENESS: the ordered steps ARE the declared prerequisite chain. Replay every upstream setup/creation step before its dependents and reuse the same shared values. Never emit test.skip/test.fixme, conditionally return, or omit an upstream or dependent action because prerequisite data is absent. If a declared prerequisite still cannot be established, keep every step in the source and make the prerequisite check an explicit failing \`expect(..., 'QAAI_PREREQUISITE_MISSING: ...')\` assertion.

This is a FLAT spec — NO Page Object class, locators inline (from the resolved locators provided).
${loginContractBlock}
${negativeCredBlock}`;
}

/**
 * Generate one flat Playwright journey spec from an ordered list of member
 * cases. Each member: { testCase, actionPlan } where actionPlan is already
 * locator-enriched (action.locator + actionPlan.locatorManifest).
 *
 * Returns the spec file CONTENT (string). On unrecoverable model output returns
 * a clearly-marked stub (never a raw JSON blob).
 */
async function generatePlaywrightJourney({ provider, apiKey, model, scenario, journeyCases, targetUrl, credProfile, authInfo, lang = 'ts', preAuthenticated = false }) {
  const cases = (journeyCases || []).filter((c) => c && c.testCase);
  const lay = journeyLayout(scenario, cases.map((c) => c.testCase), lang);

  let system = journeySystemPrompt({ lang, preAuthenticated });
  if (preAuthenticated) {
    // SSO / pre-authenticated journey: the session is baked via storageState —
    // no login to author or call, so skip the credential + auth blocks.
    system += `\n\n${storageStateLib.preAuthPromptBlock()}`;
  } else {
    if (credProfile) system += `\n\n${envContract.promptBlock(credProfile, { lang, accessorImportPath: '../../utils/env' })}`;
    if (authInfo && authInfo.authImportPath) system += `\n\n${authPromptBlock(authInfo.authImportPath, lang)}`;
  }
  system += `\n\n${fidelity.fidelityBlock({ lang })}`;
  system += `\n\n${locators.locatorPromptBlock({ lang })}`;

  const steps = cases.map((c) => {
    // Strip login-sequence actions before they reach the LLM.
    // setup-disposition = initial login sequence (guaranteed to be stripped).
    // _isLoginAction = catches second-login fills/clicks in multi-user flows that
    //   were classified as 'committed' because the initial login already ended the
    //   setup window. Both classes belong inside login() and must not appear in the
    //   LLM's input — their presence causes the LLM to emit a broken inline login
    //   (fills without the button click, or fills without login(), etc.).
    const isNegativeCred = /invalid|wrong|incorrect|empty.?password|negative/i.test(c.testCase && c.testCase.name || '');
    const codegenActions = (c.actionPlan && c.actionPlan.actions || []).filter((a) => {
      if (a.disposition === 'setup') return false;        // initial login sequence
      if (!isNegativeCred && _isLoginAction(a)) return false; // subsequent login actions
      return true;
    });
    const codegenPlan = c.actionPlan ? { ...c.actionPlan, actions: codegenActions } : c.actionPlan;

    const declared = fidelity.declaredAssertionsFor(c.testCase);
    return {
      caseName: c.testCase.name,
      caseStatus: c.actionPlan && c.actionPlan.caseStatus,
      declaredAssertions: declared,
      assertionDigest: fidelity.assertionDigest(declared),
      resolvedLocators: locators.manifestDigest(c.actionPlan && c.actionPlan.locatorManifest),
      stepsHint: c.testCase.steps || [],
      actionPlan: codegenPlan,
    };
  });

  const userMsg = JSON.stringify({
    targetUrl,
    journey: {
      module: scenario && scenario.module,
      name: scenario && scenario.name,
      caseCount: steps.length,
    },
    steps,
    expectedFiles: { test: { path: lay.testFile } },
  }, null, 2);

  const resp = await provider.complete({
    apiKey, model,
    maxTokens: 8000, // a journey is N cases in one file — needs more room than a single case
    system,
    messages: [{ role: 'user', content: userMsg }],
  });
  const rawText = (resp.content?.[0]?.text || '').trim();
  const parsed = recoverOne(rawText, 'test');

  if (!parsed || !parsed.content) {
    const comment = '//'; // journeys are Playwright TS/JS only — always a // comment
    return (
      `${comment} ─── Journey: ${lay.testFile} ───\n` +
      `${comment} QAAI CODEGEN FAILED — model did not return a recoverable { test: { content } } object.\n` +
      `${comment} The journey ran in the agent; only the spec emission failed. Re-merge to regenerate.\n` +
      rawText.split('\n').map((l) => `${comment}   ${l}`).join('\n') + '\n'
    );
  }
  return parsed.content;
}

// Regexes mirroring _actionPlan.js — used to strip login-sequence actions
// before they reach the LLM. Any fill on a credential field or click on a
// login button belongs inside login() and must never appear in the LLM's
// action plan input, regardless of what disposition was assigned.
const _CRED_FIELD_RE = /(?:username|password|email|user[\s_]?id|log[\s_]?in\s+(?:name|id)|email[\s_]?address|pass[\s_]?word)/i;
const _LOGIN_BTN_RE  = /(?:^log[\s_]?in$|^sign[\s_]?in$|^submit$|^sign[\s_]?on$|^login$|log[\s_]?in\s+button|sign[\s_]?in\s+button)/i;

function _isLoginAction(a) {
  const args = a.args || {};
  const domName = (a.domFacts && a.domFacts.accessibleName) || '';
  if (a.tool === 'browser_fill' || a.tool === 'browser_type') {
    const label = String(args.label || args.element || args.name || args.placeholder || domName || '');
    if (_CRED_FIELD_RE.test(label)) return true;
  }
  if (a.tool === 'browser_fill_form') {
    const fields = args.fields;
    if (Array.isArray(fields) && fields.some((f) => _CRED_FIELD_RE.test(String(f.label || f.name || f.placeholder || '')))) return true;
  }
  if (a.tool === 'browser_click' || a.tool === 'browser_double_click') {
    const label = String(args.element || args.label || args.text || args.value || domName || '');
    if (_LOGIN_BTN_RE.test(label)) return true;
  }
  return false;
}

/** Single-file journey → one entry. (Kept symmetric with splitFiles.) */
function splitFilesJourney(content, lay) {
  return { [lay.testFile]: content };
}

function supportFilesForPomJourney(lang, moduleFormat) {
  if (lang === 'js' && moduleFormat === 'cjs') return playwrightReference.playwrightReferenceJs.supportFiles();
  if (lang === 'js') return playwrightReference.supportFilesJsEsm();
  return playwrightReference.supportFiles();
}

function parseReplayIr(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

/**
 * Live dependsOnIds journey → ReplayIR POM artifact.
 *
 * This is the enterprise POM path for dependency chains. It deliberately avoids
 * the legacy flat LLM journey prompt above and reuses the ReplayIR POM adapter,
 * so live-run journeys and downloadable ReplayIR exports share the same
 * locators/ + pages/ + tests/ architecture.
 */
function generatePlaywrightPomJourney({ scenario, journeyCases, lang = 'ts', moduleFormat = 'esm' }) {
  const cases = (journeyCases || [])
    .map((c, index) => {
      const ir = parseReplayIr(c && (c.replayIr || c.replayIrJson));
      if (!ir || !Array.isArray(ir.steps)) return null;
      const name = (c.testCase && c.testCase.name) || ir.title || ir.caseId || `Step ${index + 1}`;
      return { caseName: name, ir: { ...ir, title: name } };
    })
    .filter(Boolean);

  const lay = journeyLayout(scenario, (journeyCases || []).map((c) => c && c.testCase).filter(Boolean), lang);
  if (!cases.length) {
    const comment = '//';
    return {
      content:
        `${comment} QAAI POM JOURNEY EXPORT BLOCKED\n` +
        `${comment} No persisted ReplayIR was available for this dependency chain.\n` +
        `${comment} Re-run the suite so each dependency member records replayIrJson before export.\n`,
      extraFiles: {},
    };
  }

  const specDir = lay.testFile.split('/').slice(0, -1).join('/') || 'tests';
  const emitted = playwrightPomAdapter.emitJourneySpec(cases, {
    scenarioName: (scenario && scenario.name) || cases[0].caseName || 'Journey',
    specDir,
    lang,
    moduleFormat,
  });
  const extraFiles = { ...(emitted.extraFiles || {}), ...supportFilesForPomJourney(lang, moduleFormat) };
  return { content: emitted.content, extraFiles };
}

module.exports = {
  journeyLayout,
  journeySystemPrompt,
  generatePlaywrightJourney,
  generatePlaywrightPomJourney,
  splitFilesJourney,
  cleanSlug,
};
