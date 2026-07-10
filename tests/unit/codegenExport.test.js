import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const actionPlan = require('../../server/services/codegen/_actionPlan');
const exportValidate = require('../../server/services/codegen/_exportValidate');
const locators = require('../../server/services/codegen/_locators');
const login = require('../../server/services/codegen/_login');
const packageValidate = require('../../server/services/codegen/_packageValidate');
const parity = require('../../server/services/codegen/_parity');
const replayTrace = require('../../server/services/codegen/_replayTrace');
const replayEmitter = require('../../server/services/codegen/replayEmitter');
const bddExportGate = require('../../server/services/codegen/_bddExportGate');
const actionLocatorResolver = require('../../server/services/actionLocatorResolver');
const pageObjectRepository = require('../../server/services/codegen/pageObjectRepository');
const lintGates = require('../../server/services/lintGates');
const sanitizer = require('../../server/services/codegen/_sanitize');
const playwrightPom = require('../../server/services/codegen/pom');
const playwrightPomAdapter = require('../../server/services/codegen/adapters/playwrightPom');
const playwrightJs = require('../../server/services/codegen/playwrightJs');
const journeys = require('../../server/services/codegen/_journeys');
const replayExport = require('../../server/services/codegen/replayExport');
const liveScriptRecorder = require('../../server/services/liveScriptRecorder');

async function captureStructuralLocatorFromDom(html, targetSelector, options = {}) {
  const dom = new JSDOM(html);
  if (typeof options.prepare === 'function') options.prepare(dom);
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const target = typeof targetSelector === 'function'
    ? targetSelector(dom)
    : dom.window.document.querySelector(targetSelector);
  expect(target).toBeTruthy();

  try {
    const session = {
      client: {
        callTool: async (call) => {
          const fn = eval(call.arguments.function);
          const result = fn(target);
          return { content: [{ type: 'text', text: `Result: ${JSON.stringify(result)}` }] };
        },
      },
    };
    return await actionLocatorResolver.captureStructuralLocator({
      session,
      ref: 'e42',
      element: typeof targetSelector === 'string' ? targetSelector : 'target',
      pageUrl: options.pageUrl || 'https://example.test/phase-3',
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

async function captureStructuralLocatorFromFrameDom(parentHtml, frameSelector, frameHtml, targetSelector) {
  const parentDom = new JSDOM(parentHtml);
  const frameDom = new JSDOM(frameHtml, { url: 'https://example.test/frame' });
  const frameElement = parentDom.window.document.querySelector(frameSelector);
  expect(frameElement).toBeTruthy();
  Object.defineProperty(frameDom.window, 'frameElement', {
    configurable: true,
    value: frameElement,
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = frameDom.window;
  globalThis.document = frameDom.window.document;
  const target = frameDom.window.document.querySelector(targetSelector);
  expect(target).toBeTruthy();

  try {
    const session = {
      client: {
        callTool: async (call) => {
          const fn = eval(call.arguments.function);
          const result = fn(target);
          return { content: [{ type: 'text', text: `Result: ${JSON.stringify(result)}` }] };
        },
      },
    };
    return await actionLocatorResolver.captureStructuralLocator({
      session,
      ref: 'frame-e42',
      element: targetSelector,
      pageUrl: 'https://example.test/host',
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    frameDom.window.close();
    parentDom.window.close();
  }
}

async function captureCoordinateLocatorFromDom(html, targetSelector, args = { x: 12, y: 34 }) {
  const dom = new JSDOM(html);
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const target = dom.window.document.querySelector(targetSelector);
  expect(target).toBeTruthy();
  dom.window.document.elementFromPoint = () => target;

  try {
    const session = {
      client: {
        callTool: async (call) => {
          const fn = eval(call.arguments.function);
          const result = fn();
          return { content: [{ type: 'text', text: `Result: ${JSON.stringify(result)}` }] };
        },
      },
    };
    return await actionLocatorResolver.captureCoordinateLocator({
      session,
      toolName: 'browser_click_xy',
      args,
      element: 'visual target',
      pageUrl: 'https://example.test/visual',
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

describe('codegen export hardening', () => {
  it('exports only successful scriptable browser actions', () => {
    const plan = actionPlan.buildActionPlan({
      status: 'pass',
      stepResults: [],
      trail: [
        { tool: 'browser_snapshot', ok: true },
        { tool: 'browser_click', args: { element: 'Save' }, ok: false },
        { tool: 'assertion_check', args: { assertion: 'Save worked' }, ok: true },
        { tool: 'browser_click', args: { element: 'Add' }, ok: true, pageUrl: 'https://app.test/pim' },
      ],
    });

    expect(plan.actions).toEqual([
      { tool: 'browser_click', args: { element: 'Add' }, narration: 'browser_click ok', pageUrl: 'https://app.test/pim', disposition: 'committed' },
    ]);
    expect(plan.droppedToolCount).toBe(3);
  });

  it('keeps independent scenarios as standalone output specs', () => {
    const planned = journeys.planJourneys([
      { id: 'case-a', name: 'Scenario A case' },
      { id: 'case-b', name: 'Scenario B case' },
    ]);

    expect(planned).toEqual([
      { id: 'case-a', caseIds: ['case-a'], size: 1, isJourney: false },
      { id: 'case-b', caseIds: ['case-b'], size: 1, isJourney: false },
    ]);
  });

  it('emits generated script files when every case still has script-health notes', () => {
    const files = replayExport.buildBlockedPreviewPackage({
      adapterId: 'playwright-reference',
      adapterVersion: 'playwright-reference-1',
      targetUrl: 'https://app.example.test',
      results: [{
        runResultId: 'rr-1',
        testCaseId: 'tc-1',
        caseName: 'User administration search',
        moduleName: 'Administration',
        status: 'blocked',
        readinessStatus: 'needs_auth_setup',
        declaredSteps: [
          { action: 'fill', target: 'Email Address', valueToken: '{{loginusername}}' },
          { action: 'click', target: 'Sign in with Microsoft' },
          { action: 'fill', target: 'Username search field', valueToken: '{{usernamefilter}}' },
        ],
        declaredAssertionsRaw: JSON.stringify([{ kind: 'text', target: 'Results table', expected: 'matching user row' }]),
      }],
      blocked: [{
        runResultId: 'rr-1',
        testCaseId: 'tc-1',
        code: 'export_readiness_blocked',
        readinessStatus: 'needs_auth_setup',
        reasons: [{ code: 'auth_setup_missing' }],
      }],
      findings: [{ rule: 'export_readiness_blocked', severity: 'error' }],
    });

    const specPath = Object.keys(files).find((rel) => rel.endsWith('.preview.spec.ts'));
    expect(specPath).toBeTruthy();
    expect(files[specPath]).toContain('test.describe.skip');
    expect(files[specPath]).toContain('Username search field');
    expect(files['README.md']).toContain('generated script bundle');
    expect(files['evidence/live-output-status.json']).toContain('"allBlocked": true');
    const manifest = JSON.parse(files['EXPORT_MANIFEST.json']);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]).toMatchObject({
      testCaseId: 'tc-1',
      scriptGenerationStatus: 'skeleton_only',
      certificationStatus: 'uncertified',
    });
  });

  it('emits framework-shaped POM draft actions for blocked incomplete ReplayIR instead of comment-only skeleton', () => {
    const files = replayExport.buildBlockedPreviewPackage({
      adapterId: 'playwright-pom-js',
      adapterVersion: 'playwright-pom-js-1',
      targetUrl: 'https://app.example.test',
      results: [{
        runResultId: 'rr-partial',
        testCaseId: 'tc-partial',
        caseName: 'Login through email classifier and Microsoft sign-in',
        moduleName: 'Authentication',
        readinessStatus: 'needs_auth_setup',
        readinessReasons: [{ code: 'auth_setup_missing' }, { code: 'assertion_invalid' }],
        envelope: {
          complete: false,
          ir: {
            title: 'Login through email classifier and Microsoft sign-in',
            steps: [
              { op: 'act', action: 'navigate', url: 'https://qa.example.test/auth/email-classifier', target: 'https://qa.example.test/auth/email-classifier' },
              {
                op: 'resolve',
                as: 'emailField',
                pageUrl: 'https://qa.example.test/auth/email-classifier',
                candidates: [{ strategy: 'label', text: 'Email Address', expression: 'getByLabel("Email Address")' }],
                actionLocator: {
                  expression: 'getByLabel("Email Address")',
                  frameworkExpressions: { playwright: 'getByLabel("Email Address")' },
                  verificationSource: 'verified_mcp_accessibility_snapshot',
                  verified: true,
                  proof: { sameElement: true, count: 1, verified: true, source: 'verified_mcp_accessibility_snapshot' },
                  domAtlas: { verifiedActions: [{ expression: 'getByLabel("Email Address")' }] },
                },
              },
              { op: 'act', action: 'fill', target: 'emailField', valueRef: 'env:LOGIN_EMAIL' },
              {
                op: 'resolve',
                as: 'continueButton',
                pageUrl: 'https://qa.example.test/auth/email-classifier',
                candidates: [{ strategy: 'role', role: 'button', name: 'Continue', expression: 'getByRole("button", { name: "Continue" })' }],
                actionLocator: {
                  expression: 'getByRole("button", { name: "Continue" })',
                  frameworkExpressions: { playwright: 'getByRole("button", { name: "Continue" })' },
                  verificationSource: 'verified_mcp_accessibility_snapshot',
                  verified: true,
                  proof: { sameElement: true, count: 1, verified: true, source: 'verified_mcp_accessibility_snapshot' },
                  domAtlas: { verifiedActions: [{ expression: 'getByRole("button", { name: "Continue" })' }] },
                },
              },
              { op: 'act', action: 'click', target: 'continueButton' },
            ],
          },
        },
        declaredAssertionsRaw: JSON.stringify([{ kind: 'text', expected: 'parse_failed', id: 'ASN-07fbcb64' }]),
      }],
      blocked: [{
        runResultId: 'rr-partial',
        testCaseId: 'tc-partial',
        code: 'export_readiness_blocked',
        readinessStatus: 'needs_auth_setup',
      }],
    });

    const specPath = Object.keys(files).find((rel) => rel.endsWith('.preview.spec.js'));
    expect(specPath).toBeTruthy();
    expect(files[specPath]).toContain('test.describe.skip');
    expect(files[specPath]).toContain('test.fixme');
    expect(files[specPath]).toMatch(/await .*\.fill.*Email|await .*\.fill/i);
    expect(Object.keys(files).some((rel) => rel.startsWith('locators/generated/') && rel.endsWith('.js'))).toBe(true);
    expect(Object.keys(files).some((rel) => rel.startsWith('pages/') && rel.endsWith('.js'))).toBe(true);
    const locatorFile = Object.entries(files).find(([rel]) => rel.startsWith('locators/generated/') && rel.endsWith('.js'))?.[1] || '';
    expect(locatorFile).toContain('getByLabel("Email Address")');
    const manifest = JSON.parse(files['EXPORT_MANIFEST.json']);
    expect(manifest.artifacts[0]).toMatchObject({
      testCaseId: 'tc-partial',
      source: 'partial_replayir',
      scriptGenerationStatus: 'generated_with_repairs_needed',
    });
  });

  it('emits runnable live-ledger scripts for failed runs with executable failure boundaries', () => {
    const ledger = liveScriptRecorder.newLedger({
      runResultId: 'rr-ledger',
      testCaseId: 'tc-ledger',
      scriptMode: 'failed_run_script',
    });
    liveScriptRecorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_navigate',
        args: { url: 'https://app.example.test/dashboard' },
        ok: true,
      },
    });
    liveScriptRecorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_click',
        args: { element: 'User Management button' },
        ok: true,
      },
    });
    liveScriptRecorder.appendScriptLine(ledger, {
      kind: 'assert',
      trailEntry: {
        tool: 'assertion_check',
        args: { expectedText: 'Active 61', actualText: 'Active 62' },
        ok: false,
      },
    });

    const files = replayExport.buildBlockedPreviewPackage({
      adapterId: 'playwright-pom-js',
      adapterVersion: 'playwright-pom-js-1',
      targetUrl: 'https://app.example.test',
      results: [{
        runResultId: 'rr-ledger',
        testCaseId: 'tc-ledger',
        caseName: 'User Management count failure',
        moduleName: 'User Management',
        status: 'failed',
        liveScriptLedger: ledger,
      }],
      blocked: [{
        runResultId: 'rr-ledger',
        testCaseId: 'tc-ledger',
        code: 'run_failed',
      }],
    });

    const specPath = Object.keys(files).find((rel) => rel.includes('tests/recorded/') && rel.endsWith('.spec.js'));
    expect(specPath).toBeTruthy();
    expect(files[specPath]).not.toContain('test.describe.skip');
    expect(files[specPath]).toContain('await page.goto');
    expect(files[specPath]).toContain('await recordedPage.clickUserManagementButton()');
    expect(files[specPath]).toContain('Active 61');
    const pagePath = Object.keys(files).find((rel) => rel === 'pages/UserManagementRecordedPage.js');
    const locatorPath = Object.keys(files).find((rel) => rel === 'locators/generated/user-management.recorded.locators.js');
    expect(pagePath).toBeTruthy();
    expect(locatorPath).toBeTruthy();
    expect(files[pagePath]).toContain('.click()');
    expect(files[locatorPath]).toContain("getByRole('button'");

    const status = JSON.parse(files['evidence/live-output-status.json']);
    expect(status.status).toBe('script_generated');
    expect(status.scriptArtifacts[0]).toMatchObject({
      source: 'script_ledger',
      scriptGenerationStatus: 'generated',
      scriptMode: 'failed_run_script',
    });
    const manifest = JSON.parse(files['EXPORT_MANIFEST.json']);
    expect(manifest.artifacts[0]).toMatchObject({
      testCaseId: 'tc-ledger',
      source: 'script_ledger',
      scriptGenerationStatus: 'generated',
    });
  });

  it('adds artifact metadata to non-Playwright blocked preview packages', () => {
    const files = replayExport.buildBlockedPreviewPackage({
      adapterId: 'selenium-pom',
      adapterVersion: 'selenium-pom-1',
      results: [{
        runResultId: 'rr-selenium-preview',
        testCaseId: 'tc-selenium-preview',
        caseName: 'Blocked Selenium preview',
        moduleName: 'Preview',
        declaredSteps: [{ action: 'click', target: 'Save button' }],
      }],
      blocked: [{
        runResultId: 'rr-selenium-preview',
        testCaseId: 'tc-selenium-preview',
        code: 'auth_setup_missing',
      }],
    });

    const javaPath = Object.keys(files).find((rel) => rel.endsWith('PreviewTest.java'));
    expect(javaPath).toBeTruthy();
    const manifest = JSON.parse(files['EXPORT_MANIFEST.json']);
    const live = JSON.parse(files['evidence/live-output-status.json']);
    expect(manifest.artifacts[0]).toMatchObject({
      testCaseId: 'tc-selenium-preview',
      source: 'skeleton',
      scriptGenerationStatus: 'skeleton_only',
      certificationStatus: 'uncertified',
    });
    expect(live.artifacts[0].file).toBe(javaPath);
  });

  it('strict export blocks non-ReplayIR artifacts from certification', () => {
    const findings = replayExport.assessStrictReplayExport({
      results: [],
      scriptArtifacts: [{
        testCaseId: 'tc-draft',
        file: 'tests/preview/draft.preview.spec.ts',
        source: 'testcase_contract',
        scriptGenerationStatus: 'generated_with_repairs_needed',
      }],
    });

    expect(findings.map((finding) => finding.rule)).toContain('strict_export_non_replayir_artifact');
  });

  it('strict export blocks incomplete ReplayIR, gaps, and missing assertions', () => {
    const findings = replayExport.assessStrictReplayExport({
      results: [{
        runResultId: 'rr-incomplete',
        testCaseId: 'tc-incomplete',
        envelope: {
          complete: false,
          gaps: [{ code: 'locator_missing', stepIndex: 1 }],
          ir: {
            steps: [
              { op: 'act', action: 'navigate', url: 'https://app.example.test' },
            ],
          },
        },
      }],
      scriptArtifacts: [{
        testCaseId: 'tc-incomplete',
        runResultId: 'rr-incomplete',
        file: 'tests/incomplete.spec.ts',
        source: 'replayir',
        scriptGenerationStatus: 'generated',
      }],
    });

    expect(findings.map((finding) => finding.rule)).toEqual(expect.arrayContaining([
      'strict_export_replayir_incomplete',
      'strict_export_replayir_gaps',
      'strict_export_assertion_evidence_missing',
    ]));
  });

  it('strict export accepts complete ReplayIR with locator and assertion evidence', () => {
    const actionLocator = {
      expression: 'getByRole("button", { name: "Continue" })',
      frameworkExpressions: { playwright: 'getByRole("button", { name: "Continue" })' },
      verificationSource: 'verified_mcp_accessibility_snapshot',
      verified: true,
      proof: { sameElement: true, count: 1, verified: true, source: 'verified_mcp_accessibility_snapshot' },
      domAtlas: { verifiedActions: [{ expression: 'getByRole("button", { name: "Continue" })' }] },
    };
    const findings = replayExport.assessStrictReplayExport({
      results: [{
        runResultId: 'rr-complete',
        testCaseId: 'tc-complete',
        envelope: {
          complete: true,
          gaps: [],
          evidenceCompletenessLedger: {
            evidenceStatus: 'complete',
            missingEvidenceCount: 0,
            actionEvidenceCount: 1,
            assertionEvidenceCount: 1,
          },
          ir: {
            steps: [
              {
                op: 'resolve',
                as: 'continueButton',
                candidates: [{ strategy: 'role', role: 'button', name: 'Continue', expression: 'getByRole("button", { name: "Continue" })' }],
                actionLocator,
              },
              { op: 'act', action: 'click', target: 'continueButton', actionLocator },
              { op: 'assert', contractRef: 'ASN-dashboard-visible', channel: 'UI_TEXT', expected: 'Dashboard' },
            ],
          },
        },
      }],
      scriptArtifacts: [{
        testCaseId: 'tc-complete',
        runResultId: 'rr-complete',
        file: 'tests/complete.spec.ts',
        source: 'replayir',
        scriptGenerationStatus: 'generated',
      }],
    });

    expect(findings).toEqual([]);
  });

  it('strict export blocks generated artifacts when capture-first ledger is missing or incomplete', () => {
    const actionLocator = {
      expression: 'getByRole("button", { name: "Continue" })',
      frameworkExpressions: { playwright: 'getByRole("button", { name: "Continue" })' },
      verificationSource: 'verified_mcp_accessibility_snapshot',
      verified: true,
      proof: { sameElement: true, count: 1, verified: true, source: 'verified_mcp_accessibility_snapshot' },
      domAtlas: { verifiedActions: [{ expression: 'getByRole("button", { name: "Continue" })' }] },
    };
    const result = {
      runResultId: 'rr-ledger-missing',
      testCaseId: 'tc-ledger-missing',
      envelope: {
        complete: true,
        gaps: [],
        ir: {
          steps: [
            { op: 'resolve', as: 'continueButton', candidates: [{ strategy: 'role', role: 'button', name: 'Continue', expression: 'getByRole("button", { name: "Continue" })' }], actionLocator },
            { op: 'act', action: 'click', target: 'continueButton', actionLocator },
            { op: 'assert', contractRef: 'ASN-dashboard-visible', channel: 'UI_TEXT', expected: 'Dashboard' },
          ],
        },
      },
    };

    const missing = replayExport.assessStrictReplayExport({
      results: [result],
      scriptArtifacts: [{
        testCaseId: result.testCaseId,
        runResultId: result.runResultId,
        file: 'tests/complete.spec.ts',
        source: 'replayir',
        scriptGenerationStatus: 'generated',
      }],
    });
    expect(missing.map((finding) => finding.rule)).toContain('strict_export_evidence_ledger_missing');

    const incomplete = replayExport.assessStrictReplayExport({
      results: [{
        ...result,
        envelope: {
          ...result.envelope,
          evidenceCompletenessLedger: { evidenceStatus: 'capture_failed', missingEvidenceCount: 1 },
        },
      }],
      scriptArtifacts: [{
        testCaseId: result.testCaseId,
        runResultId: result.runResultId,
        file: 'tests/complete.spec.ts',
        source: 'replayir',
        scriptGenerationStatus: 'generated',
      }],
    });
    expect(incomplete.map((finding) => finding.rule)).toContain('strict_export_evidence_incomplete');
  });

  it('writes capture-first evidence files for Output Files bundles', () => {
    const files = {};
    const evidencePackage = replayExport.addCaptureFirstEvidenceFiles(files, [{
      runResultId: 'rr-evidence',
      testCaseId: 'tc-evidence',
      caseName: 'Evidence backed test',
      status: 'pass',
      envelope: {
        complete: true,
        gaps: [],
        evidenceBuiltReplayIr: { evidenceStatus: 'complete', missingEvidenceCount: 0 },
        evidenceCompletenessLedger: {
          evidenceStatus: 'complete',
          missingEvidenceCount: 0,
          actionEvidenceCount: 1,
          assertionEvidenceCount: 1,
        },
        ir: { steps: [{ op: 'act', action: 'navigate', url: 'https://app.example.test' }] },
      },
      captureFirstEvidence: {
        evidenceStatus: 'complete',
        actionEvidences: [{ id: 'act-1', runResultId: 'rr-evidence', sequenceIndex: 0, toolName: 'browser_click', evidenceJson: '{"ok":true}' }],
        locatorRecipes: [{ id: 'loc-1', runResultId: 'rr-evidence', sequenceIndex: 0, locatorRecipeJson: '{"expression":"getByRole(\\"button\\")"}' }],
        assertionEvidences: [{ id: 'asn-1', runResultId: 'rr-evidence', assertionId: 'ASN-1', expectedJson: '"Dashboard"', actualJson: '"Dashboard"', matched: true }],
        authSetupEvidences: [],
        navigationEvidences: [],
        traceArtifacts: [],
        replayIrCertifications: [],
        evidenceCompletenessLedgers: [],
      },
    }]);

    expect(evidencePackage.summary.resultCount).toBe(1);
    expect(files['evidence/action-evidence.json']).toContain('"actionEvidences"');
    expect(files['evidence/replayir.json']).toContain('"evidenceBuiltReplayIr"');
    expect(files['evidence/completeness-ledger.json']).toContain('"missingEvidenceCount"');
  });

  it('chains scenario-dependent cases into one output journey', () => {
    const planned = journeys.planJourneys([
      { id: 'login-case', name: 'Scenario A case' },
      { id: 'downstream-case', name: 'Scenario B case' },
    ], {
      extraEdges: [{ from: 'login-case', to: 'downstream-case' }],
    });

    expect(planned).toEqual([
      { id: 'login-case', caseIds: ['login-case', 'downstream-case'], size: 2, isJourney: true },
    ]);
  });

  it('removes invented logout cleanup from generated Playwright specs when logout is not in the contract', async () => {
    const fakeProvider = {
      complete: async () => ({
        content: [{ text: JSON.stringify({
          pageObject: {
            path: 'pages/session/admin-session.page.ts',
            content: 'export class SessionPage { async clickLogout() { await this.page.getByRole("link", { name: /logout/i }).click(); } }',
          },
          test: {
            path: 'tests/session/admin-session.spec.ts',
            content: [
              'import { test, expect } from "@playwright/test";',
              'test("session persists", async ({ page }) => {',
              '  await page.goto("/web/index.php/auth/login");',
              '  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();',
              '  await dashboardPage.clickLogout();',
              '});',
            ].join('\n'),
          },
        }) }],
      }),
    };
    const generated = await playwrightPom.generate({
      provider: fakeProvider,
      apiKey: 'test',
      model: 'fake',
      scenario: { name: 'Admin Session Persistence', module: 'session', category: 'auth' },
      testCase: {
        id: 'tc-1',
        name: 'Admin session persists across navigation',
        steps: [{ action: 'Verify', target: 'Dashboard heading' }],
        assertions: 'Dashboard remains visible and user remains authenticated; no redirect to /auth/login.',
      },
      actionPlan: {
        actions: [{ tool: 'browser_click', args: { element: 'Dashboard' } }],
      },
      targetUrl: 'https://example.test',
    });

    expect(generated).not.toContain('await dashboardPage.clickLogout();');
    expect(generated).toContain('QAAI removed an invented cleanup/logout call');
  });

  it('preserves generated logout when logout is an approved step', async () => {
    const fakeProvider = {
      complete: async () => ({
        content: [{ text: JSON.stringify({
          pageObject: { path: 'pages/auth/logout.page.js', content: 'class AuthPage {}' },
          test: { path: 'tests/auth/logout.spec.js', content: 'await authPage.clickLogout();' },
        }) }],
      }),
    };
    const generated = await playwrightJs.generate({
      provider: fakeProvider,
      apiKey: 'test',
      model: 'fake',
      scenario: { name: 'Logout', module: 'auth', category: 'auth' },
      testCase: {
        id: 'tc-logout',
        name: 'Admin can logout',
        steps: [{ action: 'Click', target: 'Logout menu item' }],
        assertions: 'User reaches login page after logout.',
      },
      actionPlan: {
        actions: [{ tool: 'browser_click', args: { element: 'Logout' } }],
      },
      targetUrl: 'https://example.test',
    });

    expect(generated).toContain('await authPage.clickLogout();');
  });

  it('blocks ReplayIR stranded logout preconditions instead of composing hidden logout steps', () => {
    const admitted = [];
    const blocked = [];
    const manifestEntries = [];
    const findings = [];
    const adapter = {
      emitJourneySpec: () => {
        throw new Error('hidden logout precondition should block before emit');
      },
    };

    replayExport._compileJourneyGroup({
      adapter,
      adapterId: 'playwright-pom-js',
      adapterVersion: 'test',
      isJs: true,
      group: {
        scenarioId: 'scenario-logout-state',
        scenarioName: 'Verify logout redirects user',
        items: [{
          r: {
            runResultId: 'rr-1',
            testCaseId: 'tc-1',
            caseName: 'Verify logout redirects user to login page',
            moduleName: 'auth',
            status: 'pass',
            envelope: { ir: { title: 'verify logged out', steps: [{ op: 'assert', channel: 'UI_TEXT', expected: 'logged out' }] } },
          },
        }],
      },
      admitted,
      blocked,
      manifestEntries,
      findings,
      usedPaths: new Set(),
      loginPrecondition: { steps: [{ op: 'act', action: 'navigate', url: '/web/index.php/auth/login' }] },
      scenariosWithOwnLogin: new Set(),
      logoutUrl: '/web/index.php/auth/logout',
      logoutActionSteps: [{ op: 'act', action: 'click', target: 'logout' }],
    });

    expect(admitted).toEqual([]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].code).toBe('replayir_logout_precondition_unapproved');
    expect(findings.some((f) => f.rule === 'composed_logout_precondition')).toBe(false);
  });

  it('allows ReplayIR logout output when logout is recorded inside the case steps', () => {
    const emitted = [];
    const admitted = [];
    const blocked = [];
    const manifestEntries = [];
    const findings = [];
    const adapter = {
      emitJourneySpec: (cases) => {
        emitted.push(cases);
        return { content: 'await dashboardPage.clickLogout();', extraFiles: {} };
      },
    };

    replayExport._compileJourneyGroup({
      adapter,
      adapterId: 'playwright-pom-js',
      adapterVersion: 'test',
      isJs: true,
      group: {
        scenarioId: 'scenario-approved-logout',
        scenarioName: 'Verify logout redirects user',
        items: [{
          r: {
            runResultId: 'rr-2',
            testCaseId: 'tc-2',
            caseName: 'Verify logout redirects user to login page',
            moduleName: 'auth',
            status: 'pass',
            envelope: {
              complete: true,
              ir: {
                title: 'approved logout',
                steps: [
                  { op: 'act', action: 'click', target: 'userMenu' },
                  { op: 'act', action: 'click', target: 'logout', actionLocator: { selector: 'text=Logout' } },
                  { op: 'assert', channel: 'UI_TEXT', expected: 'Login' },
                ],
              },
            },
          },
        }],
      },
      admitted,
      blocked,
      manifestEntries,
      findings,
      usedPaths: new Set(),
      loginPrecondition: null,
      scenariosWithOwnLogin: new Set(),
      logoutUrl: null,
      logoutActionSteps: null,
    });

    expect(blocked).toEqual([]);
    expect(admitted).toHaveLength(1);
    expect(emitted[0]).toHaveLength(1);
  });

  it('replays rich traces from executed tool results instead of requested tool uses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-replay-'));
    const traceFile = path.join(dir, 'trace.json.gz');
    fs.writeFileSync(traceFile, zlib.gzipSync(JSON.stringify({
      turns: [{
        toolUses: [
          { name: 'browser_click', input: { element: 'Save' } },
          { name: 'assertion_check', input: { assertion: 'saved' } },
        ],
        toolResults: [
          { name: 'browser_click', input: { element: 'Save' }, ok: true, isError: false, pageUrlBefore: 'https://app.test/form' },
        ],
      }],
    })));

    const trail = replayTrace.reconstructTrail(traceFile);
    expect(trail).toEqual([
      { tool: 'browser_click', args: { element: 'Save' }, ok: true, error: undefined, pageUrl: 'https://app.test/form', pageUrlAfter: undefined },
    ]);
  });

  it('prefers locator rows recorded on the action page', () => {
    const result = locators.buildManifest({
      actions: [{ tool: 'browser_click', args: { element: 'Search' }, pageUrl: 'https://app.test/admin/users' }],
      kbRows: [
        { element: 'Search', pageUrl: 'https://app.test/pim/list', selector: 'getByRole("button", { name: "Search PIM" })', role: 'button', accessibleName: 'Search PIM', occurrences: 99, healthScore: 100 },
        { element: 'Search', pageUrl: 'https://app.test/admin/users', selector: 'getByRole("button", { name: "Search" })', role: 'button', accessibleName: 'Search', occurrences: 1, healthScore: 100 },
      ],
      labelOf: (a) => a.args.element,
      lang: 'ts',
    });

    expect(result.actions[0].locator.expression).toBe('getByRole("button", { name: "Search" })');
  });

  it('emits password locators from export-safe action evidence instead of semantic OR fallbacks', () => {
    const actionLocator = {
      kind: 'playwright',
      verified: false,
      diagnosticOnly: true,
      expression: 'locator("input[type=\\"password\\"]")',
      frameworkExpressions: { playwright: 'locator("input[type=\\"password\\"]")' },
      strategy: 'password_type',
      verificationSource: 'snapshot_ref_fallback',
      evidenceSource: 'snapshot_ref_fallback',
      proof: { source: 'snapshot_ref_fallback' },
      targetFacts: { role: 'textbox', accessibleName: 'Password' },
    };

    expect(actionLocatorResolver.isExportSafeActionLocator(actionLocator)).toBe(true);
    expect(actionLocatorResolver.isVerifiedActionLocator(actionLocator)).toBe(false);

    const repo = pageObjectRepository.buildLocatorRepository({
      cases: [{
        ir: {
          steps: [
            { op: 'act', action: 'navigate', url: 'https://app.test/auth/login' },
            {
              op: 'resolve',
              as: 'el2',
              pageUrl: 'https://app.test/auth/login',
              actionLocator,
              candidates: [
                { strategy: 'placeholder', text: 'Password' },
                { strategy: 'label', text: 'Password' },
                { strategy: 'role', role: 'textbox', name: 'Password' },
              ],
            },
          ],
        },
      }],
    });

    const entry = repo.files.loginPage.passwordInput;
    expect(entry.source).toBe('actionLocator');
    expect(entry.expr).toBe('page.locator("input[type=\\"password\\"]")');

    const generated = playwrightPomAdapter._emitLocatorFileGenerated('loginPage', repo.files.loginPage, 'js', 'esm');
    expect(generated).toContain('passwordInput: (page) => page.locator("input[type=\\"password\\"]")');
    expect(generated).not.toContain('.or(');
    expect(generated).not.toContain('getByRole("textbox", { name: /password/i })');
    expect(generated).not.toContain('getByPlaceholder(/password/i)');
  });

  it('repairs password-only candidate ReplayIR to a precise locator instead of semantic OR fallback', () => {
    const repo = pageObjectRepository.buildLocatorRepository({
      cases: [{
        ir: {
          steps: [
            { op: 'act', action: 'navigate', url: 'https://app.test/auth/login' },
            {
              op: 'resolve',
              as: 'el2',
              pageUrl: 'https://app.test/auth/login',
              candidates: [
                { strategy: 'placeholder', text: 'Password' },
                { strategy: 'label', text: 'Password' },
                { strategy: 'role', role: 'textbox', name: 'Password' },
              ],
              elementLabel: 'Password textbox',
            },
          ],
        },
      }],
    });

    const entry = repo.files.loginPage.passwordInput;
    expect(entry.source).toBe('passwordStructuralFallback');
    expect(entry.expr).toBe('page.locator("input[type=\\"password\\"]")');

    const generated = playwrightPomAdapter._emitLocatorFileGenerated('loginPage', repo.files.loginPage, 'js', 'esm');
    expect(generated).toContain('passwordInput: (page) => page.locator("input[type=\\"password\\"]")');
    expect(generated).not.toContain('.or(');
    expect(generated).not.toContain('getByRole("textbox", { name: /password/i })');
    expect(generated).not.toContain('getByPlaceholder(/password/i)');
  });

  it('reconstructs codegenLocator from rich trace so ReplayIR keeps password action evidence', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-replay-trace-'));
    const traceFile = path.join(tmpDir, 'trace.json.gz');
    const codegenLocator = {
      kind: 'playwright',
      verified: false,
      diagnosticOnly: true,
      expression: 'locator("input[type=\\"password\\"]")',
      frameworkExpressions: { playwright: 'locator("input[type=\\"password\\"]")' },
      strategy: 'password_type',
      verificationSource: 'active_dom_excavation',
      evidenceSource: 'active_dom_excavation',
      proof: { source: 'active_dom_excavation', count: 1, sameElement: true },
      targetFacts: { role: 'textbox', accessibleName: 'Password', type: 'password' },
    };
    const trace = {
      turns: [{
        toolResults: [{
          name: 'browser_type',
          input: { element: 'Password textbox', target: 'e7', text: 'admin123' },
          ok: true,
          isError: false,
          pageUrlBefore: 'https://app.test/auth/login',
          pageUrlAfter: 'https://app.test/auth/login',
          codegenLocator,
        }],
      }],
    };
    fs.writeFileSync(traceFile, zlib.gzipSync(JSON.stringify(trace)));

    const trail = replayTrace.reconstructTrail(traceFile);
    expect(trail[0].codegenLocator).toMatchObject({ strategy: 'password_type' });

    const plan = replayTrace.buildActionPlan({ trail, status: 'pass', stepResults: [] });
    expect(plan.actions[0].actionLocator).toMatchObject({ strategy: 'password_type' });

    const replay = replayEmitter.buildReplayIR({
      caseId: 'password-trace',
      title: 'Password trace',
      trail: plan.actions,
      verdictStatus: 'pass',
      credentialValues: new Set(['admin123']),
    });
    const resolve = replay.ir.steps.find((step) => step.op === 'resolve');
    expect(resolve.actionLocator.expression).toBe('locator("input[type=\\"password\\"]")');
  });

  it('translates recorded Playwright locators into Selenium By expressions', () => {
    expect(locators.javaFromPlaywrightSelector('locator("input[name=\\"username\\"]")'))
      .toBe('By.cssSelector("input[name=\\"username\\"]")');
    expect(locators.javaFromPlaywrightSelector('getByTestId("save-user")'))
      .toContain('By.cssSelector');
    expect(locators.javaExpression({ role: 'button', accessibleName: 'Save', selector: 'getByRole("button", { name: "Save" })' }))
      .toContain('By.xpath');
  });

  it('supports shared auth helper layouts beyond Playwright POM', () => {
    expect(login.authLayoutFor('playwright-bdd')).toMatchObject({ file: 'utils/auth.ts', importFromSpec: '../utils/auth' });
    expect(login.authLayoutFor('selenium-java')).toMatchObject({ file: 'src/main/java/com/qaai/util/Auth.java', importFromSpec: 'com.qaai.util.Auth' });
    expect(login.authPromptBlock('com.qaai.util.Auth', 'java')).toContain('Auth.login(driver)');
  });

  it('flags generated-code failure patterns before governance approval', () => {
    const raw = lintGates.lint('{\n  "pageObject": { "content": "not split" }\n}');
    const wait = lintGates.lint('import { test, expect } from "@playwright/test"; test("x", async ({ page }) => { await page.waitForResponse("/api"); expect(1).toBe(1); });');
    const label = lintGates.lint('import { test, expect } from "@playwright/test"; test("x", async ({ page }) => { await page.getByLabel("Username").fill("a"); expect(1).toBe(1); });');

    expect(raw.findings.some((f) => f.rule === 'no-raw-codegen-json-envelope' && f.severity === 'error')).toBe(true);
    expect(wait.findings.some((f) => f.rule === 'no-waitForResponse' && f.severity === 'error')).toBe(true);
    expect(label.findings.some((f) => f.rule === 'avoid-getByLabel-without-proof' && f.severity === 'warning')).toBe(true);
  });

  it('enforces parity for non-pass Playwright exports', () => {
    expect(parity.assessParity({ framework: 'playwright-pom', caseStatus: 'pass', code: '' }))
      .toEqual({ enforced: true, reason: null });

    const softOnly = parity.assessParity({
      framework: 'playwright-pom',
      caseStatus: 'fail',
      code: 'test("x", async ({ page }) => { await expect.soft(page.getByRole("alert")).toBeVisible(); });',
    });
    const hard = parity.assessParity({
      framework: 'playwright-js',
      caseStatus: 'blocked',
      code: 'test("x", async ({ page }) => { await expect(page.getByRole("alert")).toBeVisible(); });',
    });
    const swallowedHard = parity.assessParity({
      framework: 'playwright-bdd',
      caseStatus: 'fail',
      code: 'Then("I see an alert", async ({ page }) => { try { await expect(page.getByRole("alert")).toBeVisible(); } catch (error) {} });',
    });

    expect(softOnly.enforced).toBe(false);
    expect(hard.enforced).toBe(true);
    expect(swallowedHard.enforced).toBe(false);
  });

  it('enforces parity for Selenium hard and soft assertion variants', () => {
    expect(parity.assessParity({
      framework: 'selenium-java',
      caseStatus: 'fail',
      code: 'softAssert.assertTrue(driver.getTitle().contains("Home"));',
    }).enforced).toBe(false);

    expect(parity.assessParity({
      framework: 'selenium-bdd',
      caseStatus: 'fail',
      code: 'softAssert.assertTrue(driver.getTitle().contains("Home")); softAssert.assertAll();',
    }).enforced).toBe(true);

    expect(parity.assessParity({
      framework: 'selenium-java',
      caseStatus: 'blocked',
      code: 'Assert.fail("Live execution failed");',
    }).enforced).toBe(true);

    expect(parity.assessParity({
      framework: 'selenium-java',
      caseStatus: 'fail',
      code: 'Assert.assertEquals(driver.getTitle(), "Home");',
    }).enforced).toBe(true);
  });

  it('adds a parity inversion lint error for failed exports without hard assertions', () => {
    const result = lintGates.lint(
      'import { test, expect } from "@playwright/test"; test("x", async ({ page }) => { await page.goto("/"); await expect.soft(page.getByRole("alert")).toBeVisible(); await page.screenshot(); });',
      { framework: 'playwright-pom', caseStatus: 'fail' }
    );

    expect(result.lintPassed).toBe(false);
    expect(result.findings.some((f) => f.rule === 'parity_inversion' && f.severity === 'error')).toBe(true);
  });

  it('rejects positional Playwright locator narrowing as export-safe', () => {
    expect(actionLocatorResolver.locatorExpressionIsExportSafe('getByRole("button", { name: "Save" }).nth(0)')).toBe(false);
    expect(actionLocatorResolver.locatorExpressionIsExportSafe('getByRole("button", { name: "Save" }).last()')).toBe(false);
    expect(actionLocatorResolver.locatorExpressionIsExportSafe('locator("tbody > tr:nth-of-type(2) button")')).toBe(false);

    const result = exportValidate.validateExport({
      framework: 'playwright-pom',
      caseStatus: 'pass',
      files: {
        'tests/auth/login.spec.ts': 'import { test, expect } from "@playwright/test"; test("x", async ({ page }) => { await page.getByRole("button", { name: "Save" }).nth(0).click(); await page.locator("tbody > tr:nth-of-type(2) button").click(); await expect(page.getByText("Done")).toBeVisible(); });',
      },
    });

    expect(result.exportPassed).toBe(false);
    expect(result.findings.some((f) => f.rule === 'export_positional_locator')).toBe(true);
  });

  it('captures repeated controls with a scoped non-positional locator', async () => {
    const locator = await captureStructuralLocatorFromDom(`
      <table>
        <tbody>
          <tr><td>Alice Admin </td><td><button>Edit</button></td></tr>
          <tr><td>Bob Builder </td><td><button>Edit</button></td></tr>
        </tbody>
      </table>
    `, 'tbody tr:nth-child(2) button');
    const expr = locator?.frameworkExpressions?.playwright || '';

    expect(expr).toContain('locator("tr").filter({ hasText: "Bob Builder Edit" }).getByRole("button", { name: "Edit" })');
    expect(expr).not.toMatch(/nth-(?:of-type|child)|\.(?:nth|first|last)\s*\(/);
    expect(actionLocatorResolver.actionLocatorNeedsPrecisionUpgrade(locator, { toolName: 'browser_click' })).toBe(false);
  });

  it('captures repeated dialog controls with dialog-scoped non-positional locators', async () => {
    const locator = await captureStructuralLocatorFromDom(`
      <main>
        <div role="dialog"><h2>Archive user </h2><button>Confirm</button></div>
        <div role="dialog"><h2>Delete user </h2><button>Confirm</button></div>
      </main>
    `, '[role="dialog"]:nth-child(2) button');
    const expr = locator?.frameworkExpressions?.playwright || '';

    expect(expr).toContain('locator("[role=\\"dialog\\"]").filter({ hasText: "Delete user Confirm" })');
    expect(expr).toContain('.getByRole("button", { name: "Confirm" })');
    expect(expr).not.toMatch(/nth-(?:of-type|child)|\.(?:nth|first|last)\s*\(/);
    expect(actionLocatorResolver.actionLocatorNeedsPrecisionUpgrade(locator, { toolName: 'browser_click' })).toBe(false);
  });

  it('captures repeated form submits with form-scoped non-positional locators', async () => {
    const locator = await captureStructuralLocatorFromDom(`
      <section>
        <form><span>Shipping </span><button>Submit</button></form>
        <form><span>Billing </span><button>Submit</button></form>
      </section>
    `, 'form:nth-child(2) button');
    const expr = locator?.frameworkExpressions?.playwright || '';

    expect(expr).toContain('locator("form").filter({ hasText: "Billing Submit" })');
    expect(expr).toContain('.getByRole("button", { name: "Submit" })');
    expect(expr).not.toMatch(/nth-(?:of-type|child)|\.(?:nth|first|last)\s*\(/);
    expect(actionLocatorResolver.actionLocatorNeedsPrecisionUpgrade(locator, { toolName: 'browser_click' })).toBe(false);
  });

  it('captures frame-contained controls with stable frameLocator context', async () => {
    const locator = await captureStructuralLocatorFromFrameDom(
      '<main><iframe id="checkout-frame" title="Checkout"></iframe></main>',
      'iframe',
      '<button>Pay now</button>',
      'button'
    );
    const expr = locator?.frameworkExpressions?.playwright || '';

    expect(expr).toBe('frameLocator("iframe#checkout-frame").getByRole("button", { name: "Pay now" })');
    expect(expr).not.toMatch(/nth-(?:of-type|child)|\.(?:nth|first|last)\s*\(/);
    expect(actionLocatorResolver.actionLocatorNeedsPrecisionUpgrade(locator, { toolName: 'browser_click' })).toBe(false);
  });

  it('does not certify frame-contained controls without a stable iframe selector', async () => {
    const locator = await captureStructuralLocatorFromFrameDom(
      '<main><iframe></iframe></main>',
      'iframe',
      '<button>Pay now</button>',
      'button'
    );

    expect(locator).toBeNull();
  });

  it('captures repeated shadow-root controls with host-scoped non-positional locators', async () => {
    const locator = await captureStructuralLocatorFromDom(`
      <main>
        <div data-testid="archive-widget"></div>
        <div data-testid="delete-widget"></div>
      </main>
    `, (dom) => {
      const archive = dom.window.document.querySelector('[data-testid="archive-widget"]');
      const deletion = dom.window.document.querySelector('[data-testid="delete-widget"]');
      archive.attachShadow({ mode: 'open' }).innerHTML = '<button>Confirm</button>';
      deletion.attachShadow({ mode: 'open' }).innerHTML = '<button>Confirm</button>';
      return deletion.shadowRoot.querySelector('button');
    });
    const expr = locator?.frameworkExpressions?.playwright || '';

    expect(expr).toBe('locator("div[data-testid=\\"delete-widget\\"]").getByRole("button", { name: "Confirm" })');
    expect(expr).not.toMatch(/nth-(?:of-type|child)|\.(?:nth|first|last)\s*\(/);
    expect(actionLocatorResolver.actionLocatorNeedsPrecisionUpgrade(locator, { toolName: 'browser_click' })).toBe(false);
  });

  it('converts coordinate actions into certified DOM locators before export', async () => {
    const locator = await captureCoordinateLocatorFromDom(`
      <main>
        <button data-testid="confirm-delete">Confirm</button>
      </main>
    `, 'button');
    const expr = locator?.frameworkExpressions?.playwright || '';

    expect(actionLocatorResolver.isVerifiedActionLocator(locator)).toBe(true);
    expect(expr).toBe('getByTestId("confirm-delete")');
    expect(expr).not.toMatch(/nth-(?:of-type|child)|\.(?:nth|first|last)\s*\(/);
    expect(locator?.targetFacts?.coordinate).toEqual({ x: 12, y: 34 });
  });

  it('keeps failed coordinate conversion as locator_unverified repair evidence', () => {
    const gap = actionLocatorResolver.coordinateGap({
      toolName: 'browser_click_xy',
      args: { x: 44, y: 88 },
      pageUrl: 'https://example.test/visual',
      elementLabel: 'visual target',
    });
    const plan = actionPlan.buildActionPlan({
      trail: [{
        tool: 'browser_click_xy',
        ok: true,
        args: { x: 44, y: 88 },
        pageUrl: 'https://example.test/visual',
        actionLocatorGap: gap,
      }],
      status: 'pass',
      stepResults: [],
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].actionLocatorGap.code).toBe('locator_unverified');

    const emit = replayEmitter.buildReplayIR({
      caseId: 'tc-visual',
      title: 'Visual rescue',
      trail: plan.actions,
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'pass',
    });

    expect(emit.complete).toBe(false);
    expect(emit.gaps.some((item) => item.code === 'locator_unverified')).toBe(true);
    expect(emit.gaps.find((item) => item.code === 'locator_unverified')?.coordinate).toEqual({ x: 44, y: 88 });
  });

  it('lints generated spec files independently from page objects', () => {
    const result = lintGates.lintFiles({
      'pages/login.page.ts': 'import { Page } from "@playwright/test"; export class LoginPage { constructor(private page: Page) {} }',
      'tests/login.spec.ts': 'import { test, expect } from "@playwright/test"; test("x", async ({ page }) => { await page.goto("/"); await expect(page).toHaveURL(/.*/); });',
    }, { framework: 'playwright-pom', caseStatus: 'pass' });

    expect(result.lintPassed).toBe(true);
    expect(result.findings.some((f) => f.rule === 'ast-parse-error')).toBe(false);
  });

  it('rewrites generated secret literals to environment accessors before lint', () => {
    const out = sanitizer.sanitizeJsTs([
      'const credentials = { password: "admin123", token: "abc12345" };',
      "let password = 'secret123';",
      "const headers = { Authorization: 'Bearer abcdefghijk' };",
    ].join('\n'));

    expect(out).not.toContain('admin123');
    expect(out).not.toContain('secret123');
    expect(out).not.toContain('abcdefghijk');
    expect(out).toContain('process.env.QAAI_PASSWORD');
    expect(out).toContain('process.env.QAAI_TOKEN');
  });

  it('warns when BDD exports contain duplicate step sentences', () => {
    const result = lintGates.lint([
      'Feature: Search',
      '  Scenario: first path',
      '    Given I am logged in',
      '    When I search for a user',
      '    Then I see the user',
      '  Scenario: repeated setup',
      '    Given I am logged in.',
    ].join('\n'));

    expect(result.findings.some((f) => f.rule === 'duplicate_step' && f.severity === 'warning')).toBe(true);
  });

  it('rejects generated Playwright exports that do not parse', () => {
    const result = exportValidate.validateExport({
      framework: 'playwright-pom',
      caseStatus: 'pass',
      files: {
        'tests/auth/login.spec.ts': 'import { test, expect } from "@playwright/test"; test("x", async ({ page }) => { const broken = ; await expect(page).toHaveURL(/login/); });',
      },
    });

    expect(result.exportPassed).toBe(false);
    expect(result.findings.some((f) => f.rule === 'export_syntax_error' && f.severity === 'error')).toBe(true);
  });

  it('applies parity validation to Selenium exports', () => {
    const result = exportValidate.validateExport({
      framework: 'selenium-java',
      caseStatus: 'fail',
      files: {
        'src/test/java/com/qaai/tests/LoginTest.java': [
          'package com.qaai.tests;',
          'import org.testng.annotations.Test;',
          'public class LoginTest {',
          '  @Test public void login() {',
          '    softAssert.assertTrue(true, "would stay green");',
          '  }',
          '}',
        ].join('\n'),
      },
    });

    expect(result.exportPassed).toBe(false);
    expect(result.findings.some((f) => f.rule === 'export_parity_inversion' && f.severity === 'error')).toBe(true);
  });

  it('checks Java class names against generated filenames', () => {
    const result = exportValidate.validateExport({
      framework: 'selenium-java',
      caseStatus: 'pass',
      files: {
        'src/test/java/com/qaai/tests/LoginTest.java': [
          'package com.qaai.tests;',
          'import org.testng.annotations.Test;',
          'public class WrongName {',
          '  @Test public void login() {}',
          '}',
        ].join('\n'),
      },
    });

    expect(result.exportPassed).toBe(false);
    expect(result.findings.some((f) => f.rule === 'export_java_class_filename_mismatch')).toBe(true);
  });

  it('blocks duplicate BDD step sentences at export validation time', () => {
    const result = exportValidate.validateExport({
      framework: 'playwright-bdd',
      caseStatus: 'pass',
      files: {
        'features/auth/login.feature': [
          'Feature: Login',
          '  Scenario: first',
          '    Given I am logged in',
        ].join('\n'),
        'features/auth/logout.feature': [
          'Feature: Logout',
          '  Scenario: second',
          '    Given I am logged in.',
        ].join('\n'),
        'steps/login.steps.ts': 'import { createBdd } from "playwright-bdd"; const { Given } = createBdd(); Given("I am logged in", async ({ page }) => { await expect(page).toHaveURL(/dashboard/); });',
      },
    });

    expect(result.exportPassed).toBe(false);
    expect(result.findings.some((f) => f.rule === 'export_bdd_duplicate_step' && f.severity === 'error')).toBe(true);
  });

  it('blocks BDD package export when operationsJson reports dropped operations', () => {
    const result = bddExportGate.assessBddOperationsForExport({
      framework: 'playwright-bdd',
      testCase: {
        name: 'Place order with selected product',
        operationsJson: JSON.stringify({
          status: 'incomplete',
          operations: [{ operation: 'selectEntityWhere', capabilityRef: 'cap-products', params: {} }],
          dropped: [
            { operation: 'invokeAction', reason: 'capability_not_in_atlas', detail: 'No verified Place Order action in PIM slice.' },
          ],
        }),
      },
    });

    expect(result.exportable).toBe(false);
    expect(result.findings.some((f) => f.rule === 'bdd_export_operations_incomplete')).toBe(true);
    expect(result.findings.some((f) => f.rule === 'bdd_export_operation_dropped' && /Place Order/.test(f.message))).toBe(true);
    expect(bddExportGate.blockedSpecMessage({ framework: 'playwright-bdd', testCase: { name: 'Place order' }, gate: result }))
      .toContain('QAAI BDD EXPORT BLOCKED');
  });

  it('keeps complete or legacy operationsJson exportable until Enterprise Mode requires operations', () => {
    expect(bddExportGate.assessBddOperationsForExport({
      framework: 'playwright-bdd',
      testCase: { name: 'Legacy BDD case' },
    }).exportable).toBe(true);

    expect(bddExportGate.assessBddOperationsForExport({
      framework: 'selenium-bdd',
      operationsJson: JSON.stringify({ status: 'complete', operations: [{ operation: 'navigateToModule', params: { module: 'PIM' } }], dropped: [] }),
    }).exportable).toBe(true);

    expect(bddExportGate.assessBddOperationsForExport({
      framework: 'playwright-pom',
      operationsJson: JSON.stringify({ status: 'incomplete', dropped: [{ reason: 'not relevant to non-BDD' }] }),
    }).exportable).toBe(true);
  });

  it('collects a generated Playwright package with --list when dependencies are available', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-pw-package-'));
    try {
      fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'qaai-package-check',
        private: true,
        devDependencies: { '@playwright/test': '^1.48.0' },
      }), 'utf8');
      fs.writeFileSync(path.join(dir, 'playwright.config.ts'), [
        'import { defineConfig } from "@playwright/test";',
        'export default defineConfig({ testDir: "./tests" });',
      ].join('\n'), 'utf8');
      fs.writeFileSync(path.join(dir, 'tests', 'smoke.spec.ts'), [
        'import { test, expect } from "@playwright/test";',
        'test("collects", async () => { expect(1).toBe(1); });',
      ].join('\n'), 'utf8');

      const result = await packageValidate.validatePackage({
        framework: 'playwright-pom',
        projectRoot: dir,
        timeoutMs: 30_000,
      });

      expect(result.packagePassed).toBe(true);
      expect(result.checked).toBe(true);
      expect(result.findings.some((f) => f.rule === 'package_playwright_collect_failed')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers Selenium TestNG tests before Maven compile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-selenium-discovery-'));
    try {
      const testDir = path.join(dir, 'src', 'test', 'java', 'com', 'qaai', 'tests');
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, 'LoginTest.java'), [
        'package com.qaai.tests;',
        'import org.testng.annotations.Test;',
        'public class LoginTest { @Test public void login() {} }',
      ].join('\n'), 'utf8');

      const result = packageValidate.discoverSeleniumTests(dir, 'selenium-java');

      expect(result.findings).toEqual([]);
      expect(result.discovered.some((d) => d.kind === 'testng')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags missing Selenium BDD discovery entrypoints', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-selenium-bdd-discovery-'));
    try {
      fs.mkdirSync(path.join(dir, 'src', 'test', 'java'), { recursive: true });

      const result = packageValidate.discoverSeleniumTests(dir, 'selenium-bdd');
      const rules = result.findings.map((f) => f.rule);

      expect(rules).toContain('package_selenium_no_features');
      expect(rules).toContain('package_selenium_no_cucumber_runner');
      expect(rules).toContain('package_selenium_no_step_definitions');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
