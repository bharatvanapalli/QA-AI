import { describe, expect, it, vi } from 'vitest';
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
const playwrightReferenceAdapter = require('../../server/services/codegen/adapters/playwrightReference').playwrightReferenceJs;
const seleniumReferenceAdapter = require('../../server/services/codegen/adapters/seleniumReference');
const playwrightJs = require('../../server/services/codegen/playwrightJs');
const journeys = require('../../server/services/codegen/_journeys');
const replayExport = require('../../server/services/codegen/replayExport');
const frameworkAdapter = require('../../server/services/codegen/adapters/frameworkAdapter');
const liveScriptRecorder = require('../../server/services/liveScriptRecorder');
const prisma = require('../../server/prisma');

describe('historical capture evidence normalization', () => {
  it('preserves valid trace paths and removes object-shaped path corruption recursively', () => {
    const [row] = replayExport._normalizeEvidenceRows([{
      path: '[object Object]',
      traceArtifacts: [
        { path: 'evidence/traces/login.zip', kind: 'trace' },
        { path: { unexpected: true }, kind: 'trace' },
        { path: '{"unexpected":true}', kind: 'trace' },
      ],
    }]);

    expect(row).not.toHaveProperty('path');
    expect(row.traceArtifacts[0].path).toBe('evidence/traces/login.zip');
    expect(row.traceArtifacts[1]).not.toHaveProperty('path');
    expect(row.traceArtifacts[2]).not.toHaveProperty('path');
    expect(JSON.stringify(row)).not.toContain('[object Object]');
  });
});

/**
 * Match the action-time locator contract persisted by the live conductor:
 * the Playwright expression must resolve back to the exact DOM node that was
 * addressed by the MCP reference.  Keep success-path export fixtures on this
 * shape so they do not accidentally exercise a legacy snapshot fallback.
 */
function exactActionLocator({
  expression,
  strategy = 'role',
  targetFacts = {},
  ref = 'e42',
  documentId = 'document:auth',
  nodeId = 'node:auth-target',
} = {}) {
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId,
    nodeId,
    connected: true,
  };
  return {
    kind: 'playwright',
    verified: true,
    expression,
    frameworkExpressions: { playwright: expression },
    strategy,
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    captureBinding: { kind: 'mcp_bound_ref', ref },
    proof: {
      source: 'verified_dom_inspection',
      count: 1,
      sameElement: true,
      verified: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      targetIdentity: identity,
      matchedIdentity: { ...identity },
    },
    targetFacts,
    domAtlas: {
      verifiedActions: [{
        expression,
        targetIdentity: identity,
        matchedIdentity: { ...identity },
      }],
    },
  };
}

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
      contractStepId: options.contractStepId || 'fixture-structural-step',
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

async function captureStructuralLocatorFromFrameDom(parentHtml, frameSelector, frameHtml, targetSelector, options = {}) {
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
      contractStepId: options.contractStepId || 'fixture-frame-step',
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    frameDom.window.close();
    parentDom.window.close();
  }
}

async function captureStructuralLocatorFromNestedFrameDom({
  topHtml,
  outerFrameSelector,
  middleHtml,
  innerFrameSelector,
  innerHtml,
  targetSelector,
  contractStepId = 'fixture-nested-frame-step',
}) {
  const topDom = new JSDOM(topHtml, { url: 'https://example.test/top' });
  const middleDom = new JSDOM(middleHtml, { url: 'https://example.test/middle' });
  const innerDom = new JSDOM(innerHtml, { url: 'https://example.test/inner' });
  const outerFrame = topDom.window.document.querySelector(outerFrameSelector);
  const innerFrame = middleDom.window.document.querySelector(innerFrameSelector);
  expect(outerFrame).toBeTruthy();
  expect(innerFrame).toBeTruthy();
  Object.defineProperty(middleDom.window, 'parent', { configurable: true, value: topDom.window });
  Object.defineProperty(middleDom.window, 'frameElement', { configurable: true, value: outerFrame });
  Object.defineProperty(innerDom.window, 'parent', { configurable: true, value: middleDom.window });
  Object.defineProperty(innerDom.window, 'frameElement', { configurable: true, value: innerFrame });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = innerDom.window;
  globalThis.document = innerDom.window.document;
  const target = innerDom.window.document.querySelector(targetSelector);
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
      ref: 'nested-frame-e42',
      element: targetSelector,
      pageUrl: 'https://example.test/top',
      contractStepId,
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    innerDom.window.close();
    middleDom.window.close();
    topDom.window.close();
  }
}

async function captureCoordinateLocatorFromDom(html, targetSelector, args = { x: 12, y: 34 }, options = {}) {
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
      contractStepId: options.contractStepId || 'fixture-coordinate-step',
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

function dependencyCompileResult({
  testCaseId,
  caseName,
  scenarioId = null,
  scenarioName = null,
  dependsOnIds = [],
  dependsOnNames = [],
  sessionMode = 'fresh',
  url = 'https://app.example.test/',
}) {
  return {
    runId: 'run-dependency-session',
    runResultId: `result-${testCaseId}`,
    testCaseId,
    caseName,
    moduleName: 'Authenticated user workflow',
    scenarioId,
    scenarioName,
    dependsOnIds,
    dependsOnNames,
    sessionMode,
    status: 'pass',
    envelope: {
      complete: true,
      gaps: [],
      ir: {
        caseId: testCaseId,
        title: caseName,
        authProfile: { mode: 'none' },
        steps: [{
          op: 'act',
          action: 'navigate',
          url,
          origin: 'runtime_evidence',
          executionStatus: 'passed',
        }],
        verdict: { status: 'pass' },
      },
    },
  };
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

  it('keeps authored-only cases visible as diagnostic preview files', () => {
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

    const diagnosticPath = Object.keys(files).find((rel) => rel.endsWith('.diagnostic.ts'));
    expect(diagnosticPath).toBeTruthy();
    expect(Object.keys(files).some((rel) => /\.spec\.[cm]?[jt]sx?$/i.test(rel))).toBe(false);
    expect(files[diagnosticPath]).not.toMatch(/test\.describe|test\s*\(|test\.skip|test\.fixme/);
    expect(files[diagnosticPath]).not.toContain('Username search field');
    expect(files[diagnosticPath]).toContain('No Playwright test was emitted');
    expect(files[diagnosticPath]).not.toContain('QAAI_GUESSED_LOCATOR');
    expect(files[diagnosticPath]).not.toMatch(/\.fill\(|\.click\(|\.waitFor\(|expect\.(?:soft\()?\s*\(/);
    expect(files['README.md']).toContain('generated script output bundle');
    expect(files['evidence/live-output-status.json']).toContain('"allBlocked": false');
    const manifest = JSON.parse(files['EXPORT_MANIFEST.json']);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]).toMatchObject({
      testCaseId: 'tc-1',
      source: 'authored_contract_diagnostic',
      scriptGenerationStatus: 'generated_with_diagnostics',
      certificationStatus: 'diagnostic_only',
    });
  });

  it('does not trust legacy authored start navigation as positive execution provenance', () => {
    const legacyResult = dependencyCompileResult({
      testCaseId: 'legacy-authored-start-navigation',
      caseName: 'Legacy authored start navigation',
      url: 'https://app.example.test/legacy-start',
    });
    legacyResult.envelope.ir.steps = [
      {
        op: 'act',
        action: 'navigate',
        url: 'https://app.example.test/legacy-start',
        setupOperation: true,
        origin: 'authored_start_navigation',
        executionStatus: 'passed',
        status: 'passed',
      },
    ];

    const compiled = replayExport.compileResults({
      adapter: playwrightReferenceAdapter,
      results: [legacyResult],
    });
    expect(compiled.admitted).toEqual([]);
    expect(compiled.blocked).toContainEqual(
      expect.objectContaining({
        testCaseId: 'legacy-authored-start-navigation',
        code: 'replayir_zero_execution_provenance',
      }),
    );
    expect(compiled.manifestEntries).toContainEqual(
      expect.objectContaining({
        testCaseId: 'legacy-authored-start-navigation',
        status: 'diagnostic_only',
        blockReason: 'replayir_zero_execution_provenance',
      }),
    );

    const files = replayExport.buildBlockedPreviewPackage({
      adapterId: 'playwright-reference-js',
      adapterVersion: 'playwright-reference-js-1',
      targetUrl: 'https://app.example.test',
      results: [legacyResult],
      blocked: compiled.blocked,
      findings: compiled.findings,
    });
    const manifest = JSON.parse(files['EXPORT_MANIFEST.json']);
    expect(manifest.scriptArtifacts).toHaveLength(1);
    expect(manifest.scriptArtifacts[0]).toMatchObject({
      testCaseId: 'legacy-authored-start-navigation',
      source: 'authored_contract_diagnostic',
      scriptGenerationStatus: 'generated_with_diagnostics',
      certificationStatus: 'diagnostic_only',
    });
    expect(manifest.scriptArtifacts[0].file).toMatch(/\.diagnostic\.js$/);
    expect(Object.keys(files).some((rel) => /\.spec\.[cm]?[jt]sx?$/i.test(rel))).toBe(false);
    expect(files[manifest.scriptArtifacts[0].file]).not.toMatch(
      /test\s*\(|page\.goto|QAAI_GUESSED_LOCATOR/,
    );
  });

  it('preserves executed and authored-only cases together with truthful artifact metadata', () => {
    const files = replayExport.buildBlockedPreviewPackage({
      adapterId: 'playwright-reference',
      adapterVersion: 'playwright-reference-1',
      targetUrl: 'https://app.example.test',
      results: [
        {
          runResultId: 'rr-mixed-executed',
          testCaseId: 'tc-mixed-executed',
          caseName: 'Open executed dashboard',
          moduleName: 'Mixed provenance',
          status: 'blocked',
          envelope: {
            complete: false,
            gaps: [],
            ir: {
              title: 'Open executed dashboard',
              steps: [{
                op: 'act',
                action: 'navigate',
                url: 'https://app.example.test/dashboard',
                origin: 'runtime_evidence',
                executionStatus: 'passed',
              }],
            },
          },
        },
        {
          runResultId: 'rr-mixed-authored-only',
          testCaseId: 'tc-mixed-authored-only',
          caseName: 'Unexecuted authored profile check',
          moduleName: 'Mixed provenance',
          status: 'blocked',
          declaredSteps: [{ action: 'click', target: 'Profile' }],
          declaredAssertionsRaw: JSON.stringify([
            { id: 'assert-profile', type: 'UI_TEXT', payload: { expectedText: 'Profile' } },
          ]),
        },
      ],
      blocked: [],
      findings: [],
    });

    const manifest = JSON.parse(files['EXPORT_MANIFEST.json']);
    const live = JSON.parse(files['evidence/live-output-status.json']);
    const byCase = Object.fromEntries(
      manifest.scriptArtifacts.map((artifact) => [artifact.testCaseId, artifact]),
    );
    const liveByCase = Object.fromEntries(
      live.scriptArtifacts.map((artifact) => [artifact.testCaseId, artifact]),
    );

    expect(manifest.scriptArtifacts).toHaveLength(2);
    expect(live.scriptArtifacts).toHaveLength(2);
    expect(byCase['tc-mixed-executed']).toMatchObject({
      source: 'replayir',
      scriptGenerationStatus: 'generated',
      certificationStatus: 'uncertified',
    });
    expect(byCase['tc-mixed-authored-only']).toMatchObject({
      source: 'authored_contract_diagnostic',
      scriptGenerationStatus: 'generated_with_diagnostics',
      certificationStatus: 'diagnostic_only',
    });
    expect(liveByCase).toMatchObject(byCase);
    expect(byCase['tc-mixed-executed'].file).not.toBe(
      byCase['tc-mixed-authored-only'].file,
    );
    expect(files[byCase['tc-mixed-executed'].file]).toMatch(/await (?:safeGoto\(|page\.goto\()/);
    expect(files[byCase['tc-mixed-authored-only'].file]).toContain(
      'No Playwright test was emitted',
    );
    expect(byCase['tc-mixed-authored-only'].file).toMatch(/\.diagnostic\.ts$/);
    expect(byCase['tc-mixed-authored-only'].file).not.toMatch(/\.spec\.[cm]?[jt]sx?$/i);
    expect(files[byCase['tc-mixed-authored-only'].file]).not.toContain(
      'QAAI_GUESSED_LOCATOR',
    );
    expect(files[byCase['tc-mixed-authored-only'].file]).not.toMatch(
      /\.fill\(|\.click\(|\.waitFor\(/,
    );
  });

  it('emits a downloadable non-test diagnostic when the selected non-POM adapter throws', () => {
    const compileSpy = vi
      .spyOn(frameworkAdapter, 'compileReplayIR')
      .mockImplementation(() => {
        throw new Error('synthetic standard adapter failure');
      });

    try {
      const compiled = replayExport.compileResults({
        adapter: playwrightReferenceAdapter,
        results: [
          dependencyCompileResult({
            testCaseId: 'adapter-failure-case',
            caseName: 'Executed case with adapter failure',
          }),
        ],
      });

      expect(compiled.admitted).toHaveLength(1);
      const [diagnostic] = compiled.admitted;
      expect(diagnostic).toMatchObject({
        testCaseId: 'adapter-failure-case',
        diagnosticOnly: true,
        diagnosticReason: 'replayir_invalid',
      });
      expect(diagnostic.filePath).toMatch(/\.diagnostic\.js$/);
      expect(diagnostic.filePath).not.toMatch(/\.spec\.[cm]?[jt]sx?$/i);
      expect(diagnostic.content).toContain('No Playwright test was emitted');
      expect(diagnostic.content).not.toMatch(/test\s*\(|QAAI_GUESSED_LOCATOR|getByRole|getByText/);
      expect(compiled.findings).toContainEqual(
        expect.objectContaining({
          rule: 'selected_adapter_compile_diagnostic',
          nonBlocking: true,
        }),
      );

      const files = replayExport.buildBlockedPreviewPackage({
        adapterId: 'playwright-reference-js',
        adapterVersion: 'playwright-reference-js-1',
        targetUrl: 'https://app.example.test',
        results: [
          dependencyCompileResult({
            testCaseId: 'packaged-adapter-failure-case',
            caseName: 'Packaged executed case with adapter failure',
          }),
        ],
      });
      const manifest = JSON.parse(files['EXPORT_MANIFEST.json']);
      const [artifact] = manifest.scriptArtifacts;
      expect(artifact).toMatchObject({
        testCaseId: 'packaged-adapter-failure-case',
        source: 'adapter_diagnostic',
        scriptGenerationStatus: 'generated_with_diagnostics',
        certificationStatus: 'diagnostic_only',
      });
      expect(artifact.file).toMatch(/\.diagnostic\.js$/);
      expect(Object.keys(files).some((rel) => /\.spec\.[cm]?[jt]sx?$/i.test(rel))).toBe(false);
      expect(files[artifact.file]).not.toMatch(/test\s*\(|QAAI_GUESSED_LOCATOR/);
    } finally {
      compileSpy.mockRestore();
    }
  });

  it('prefers semantic ReplayIR over a lossy live ledger and keeps the POM script enabled', () => {
    const staleLedger = liveScriptRecorder.newLedger({
      runResultId: 'rr-partial',
      testCaseId: 'tc-partial',
      scriptMode: 'blocked_run_script',
    });
    liveScriptRecorder.appendScriptLine(staleLedger, {
      trailEntry: { tool: 'browser_click', args: { element: 'el2' }, ok: true },
    });
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
        liveScriptLedger: staleLedger,
        envelope: {
          complete: false,
          ir: {
            title: 'Login through email classifier and Microsoft sign-in',
            steps: [
              { op: 'act', action: 'navigate', url: 'https://qa.example.test/auth/email-classifier', target: 'https://qa.example.test/auth/email-classifier', origin: 'runtime_evidence', executionStatus: 'passed' },
              {
                op: 'resolve',
                as: 'emailField',
                pageUrl: 'https://qa.example.test/auth/email-classifier',
                candidates: [{ strategy: 'label', text: 'Email Address', expression: 'getByLabel("Email Address")' }],
                actionLocator: exactActionLocator({
                  expression: 'getByLabel("Email Address")',
                  strategy: 'label',
                  targetFacts: { role: 'textbox', accessibleName: 'Email Address' },
                  ref: 'semantic-email-field',
                  documentId: 'document:semantic-auth',
                  nodeId: 'node:semantic-email',
                }),
              },
              { op: 'act', action: 'fill', target: 'emailField', valueRef: 'env:LOGIN_EMAIL', origin: 'runtime_evidence', executionStatus: 'passed' },
              {
                op: 'resolve',
                as: 'continueButton',
                pageUrl: 'https://qa.example.test/auth/email-classifier',
                candidates: [{ strategy: 'role', role: 'button', name: 'Continue', expression: 'getByRole("button", { name: "Continue" })' }],
                actionLocator: exactActionLocator({
                  expression: 'getByRole("button", { name: "Continue" })',
                  strategy: 'role',
                  targetFacts: { role: 'button', accessibleName: 'Continue' },
                  ref: 'semantic-continue-button',
                  documentId: 'document:semantic-auth',
                  nodeId: 'node:semantic-continue',
                }),
              },
              { op: 'act', action: 'click', target: 'continueButton', origin: 'runtime_evidence', executionStatus: 'passed' },
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

    const specPath = Object.keys(files).find((rel) => rel.startsWith('tests/') && rel.endsWith('.spec.js'));
    expect(specPath).toBeTruthy();
    expect(files[specPath]).not.toContain('test.describe.skip');
    expect(files[specPath]).not.toContain('test.fixme');
    expect(files[specPath]).toMatch(/await .*\.fill.*Email|await .*\.fill/i);
    expect(Object.keys(files).some((rel) => rel.startsWith('locators/generated/') && rel.endsWith('.js'))).toBe(true);
    expect(Object.keys(files).some((rel) => rel.startsWith('pages/') && rel.endsWith('.js'))).toBe(true);
    const locatorFile = Object.entries(files).find(([rel]) => rel.startsWith('locators/generated/') && rel.endsWith('.js'))?.[1] || '';
    expect(locatorFile).toContain('getByLabel("Email Address")');
    expect(locatorFile).not.toContain('getByText("el2")');
    const manifest = JSON.parse(files['EXPORT_MANIFEST.json']);
    expect(manifest.artifacts[0]).toMatchObject({
      testCaseId: 'tc-partial',
      source: 'replayir',
      scriptGenerationStatus: 'generated',
    });
  });

  it('treats readiness, incomplete evidence, and blocked source status as diagnostics while keeping selected-framework output enabled', () => {
    const result = {
      runResultId: 'rr-diagnostic-only',
      testCaseId: 'tc-diagnostic-only',
      caseName: 'Continue to user administration',
      moduleName: 'Administration',
      status: 'blocked',
      runEligibility: 'blocked',
      readinessStatus: 'needs_auth_setup',
      readinessReasons: [{ code: 'auth_setup_missing' }],
      envelope: {
        complete: false,
        gaps: [{ code: 'missing_action_evidence' }],
        ir: {
          title: 'Continue to user administration',
          steps: [
            {
              op: 'resolve',
              as: 'el2',
              candidates: [{ strategy: 'text', text: 'el2', expression: 'getByText("el2")' }],
            },
            {
              op: 'act',
              action: 'click',
              target: 'el2',
              targetLabel: 'User Administration button',
              contractStepId: 'step-open-administration',
            },
            { op: 'assert', channel: 'URL', expected: '/administration', contractStepId: 'step-url' },
          ],
          verdict: { status: 'blocked' },
        },
      },
    };

    replayExport.prepareResultForExport(result);
    const compiled = replayExport.compileResults({
      adapter: playwrightPomAdapter,
      results: [result],
      allowIncompletePreview: false,
    });

    expect(compiled.admitted).toHaveLength(0);
    expect(compiled.blocked).toEqual([
      expect.objectContaining({
        testCaseId: 'tc-diagnostic-only',
        code: 'replayir_zero_execution_provenance',
      }),
    ]);
    expect(result.envelope.ir.steps).toEqual([]);
    expect(JSON.stringify(result.envelope.ir)).not.toContain('QAAI could not fetch a verified locator');
    expect(compiled.findings.map((finding) => finding.rule)).toEqual(expect.arrayContaining([
      'export_readiness_diagnostic',
      'replayir_source_evidence_incomplete',
    ]));
  });

  it('preserves a non-empty executed ReplayIR prefix without materializing unexecuted authoring', () => {
    const continueLocator = exactActionLocator({
      expression: 'getByRole("button", { name: "Continue", exact: true })',
      strategy: 'role',
      targetFacts: { role: 'button', accessibleName: 'Continue' },
      ref: 'continue-prefix-ref',
      nodeId: 'node:continue-prefix',
    });
    const result = {
      runResultId: 'rr-partial-contract',
      testCaseId: 'tc-partial-contract',
      caseName: 'Continue and search users',
      executionContract: {
        nodes: [
          { contractStepId: 'step-continue', stepOrdinal: 1, kind: 'action', actionType: 'click', plannedText: 'Click Continue', raw: { target: 'Continue' } },
          {
            contractStepId: 'step-wait-users',
            stepOrdinal: 2,
            kind: 'action',
            actionType: 'wait',
            plannedText: 'Wait for User Management heading',
            raw: { target: 'User Management heading' },
            waitContract: { timeoutMs: 5_000, pollIntervalMs: 250 },
          },
          { contractStepId: 'step-search', stepOrdinal: 3, kind: 'action', actionType: 'fill', plannedText: 'Fill User search', raw: { target: 'User search' } },
        ],
      },
      declaredSteps: [
        { id: 'step-continue', action: 'Click', target: 'Continue' },
        { id: 'step-wait-users', action: 'Wait', target: 'User Management heading', waitContract: { timeoutMs: 5_000, pollIntervalMs: 250 } },
        { id: 'step-search', action: 'Fill', target: 'User search', value: 'Pranavijay Ikhar' },
      ],
      declaredAssertionsRaw: JSON.stringify([{
        id: 'assert-user-profile',
        type: 'UI_TEXT',
        payload: { expectedText: 'User Profile' },
      }]),
      envelope: {
        complete: false,
        gaps: [{ code: 'missing_action_evidence', where: 'step-wait-users' }],
        ir: {
          title: 'Continue and search users',
          steps: [
            {
              op: 'resolve',
              as: 'continueButton',
              contractStepId: 'step-continue',
              elementLabel: 'Continue',
              candidates: [{ strategy: 'role', role: 'button', name: 'Continue', expression: continueLocator.expression }],
              actionLocator: continueLocator,
            },
            { op: 'act', action: 'click', target: 'continueButton', contractStepId: 'step-continue', actionLocator: continueLocator, origin: 'runtime_evidence', executionStatus: 'passed' },
          ],
        },
      },
    };

    replayExport.prepareResultForExport(result);

    const executable = result.envelope.ir.steps.filter((step) => step && ['act', 'waitFor', 'assert'].includes(step.op));
    expect(executable.map((step) => step.op === 'act' ? step.action : step.op)).toEqual([
      'click',
    ]);
    expect(executable.filter((step) => step.op === 'act' && step.action === 'click')).toHaveLength(1);
    expect(executable[0]).toMatchObject({ contractStepId: 'step-continue', target: 'continueButton' });
    expect(result.envelope.ir.steps.find((step) => step.as === 'continueButton')?.actionLocator).toEqual(continueLocator);
    expect(JSON.stringify(result.envelope.ir.steps)).not.toContain('step-wait-users');
    expect(JSON.stringify(result.envelope.ir.steps)).not.toContain('step-search');
    expect(JSON.stringify(result.envelope.ir.steps)).not.toContain('assert-user-profile');
    expect(result.envelope.completedPartialReplayIr).toBe(false);
    expect(result.envelope.complete).toBe(false);
    expect(result.envelope.authoredParity).toMatchObject({
      executionAuthority: 'executed_occurrences_only',
      plannedActionMissingFromExecution: true,
      plannedAssertionMissingFromExecution: true,
    });

    const compiled = replayExport.compileResults({
      adapter: playwrightPomAdapter,
      results: [result],
      allowIncompletePreview: true,
    });
    expect(compiled.admitted).toHaveLength(1);
    const compiledSources = [
      compiled.admitted[0].content,
      ...Object.values(compiled.admitted[0].extraFiles || {}),
    ].join('\n');
    expect(compiledSources).toMatch(/clickContinue/i);
    expect(compiledSources).not.toContain('User search');
    expect(compiledSources).not.toContain('User Profile');
    expect(compiledSources).not.toContain('step-wait-users');
  });

  it('reconstructs a resolve-only IR from the executed live ledger', () => {
    const locator = exactActionLocator({
      expression: 'getByRole("button", { name: "Save", exact: true })',
      targetFacts: { role: 'button', accessibleName: 'Save' },
    });
    const result = {
      runResultId: 'rr-resolve-only',
      testCaseId: 'tc-resolve-only',
      caseName: 'Save settings',
      declaredSteps: [{ id: 'step-save', action: 'click', target: 'Save' }],
      envelope: {
        complete: false,
        ir: {
          caseId: 'tc-resolve-only',
          steps: [{ op: 'resolve', as: 'staleSave', contractStepId: 'step-save' }],
        },
      },
      liveScriptLedger: liveScriptRecorder.buildLedgerFromTrail({
        runResultId: 'rr-resolve-only',
        testCaseId: 'tc-resolve-only',
        status: 'pass',
        trail: [{
          tool: 'browser_click',
          contractStepId: 'step-save',
          actionOccurrenceId: 'rr-resolve-only:tc-resolve-only:1:click',
          occurrenceKey: 'rr-resolve-only:tc-resolve-only:1:click:1',
          sequenceIndex: 1,
          occurrenceOrdinal: 1,
          args: { element: 'Save' },
          actionLocator: locator,
          ok: true,
        }],
      }),
    };

    replayExport.prepareResultForExport(result);

    const acts = result.envelope.ir.steps.filter((step) => step.op === 'act');
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({
      action: 'click',
      contractStepId: 'step-save',
      actionOccurrenceId: 'rr-resolve-only:tc-resolve-only:1:click',
    });
    expect(result.envelope.reconstructedFromExecutedEvidence).toBe(true);
    expect(result.envelope.reconstructedMissingAuthoredActions).toBe(false);
  });

  it('reconstructs ActionEvidence-only input with occurrence identity and verified locator', () => {
    const runResultId = 'rr-action-evidence-only';
    const testCaseId = 'tc-action-evidence-only';
    const contractStepId = 'step-continue';
    const actionOccurrenceId = `${runResultId}:${testCaseId}:1:click`;
    const occurrenceKey = `${actionOccurrenceId}:1`;
    const locatorRecipeId = 'recipe-continue';
    const locator = exactActionLocator({
      expression: 'getByRole("button", { name: "Continue", exact: true })',
      targetFacts: { role: 'button', accessibleName: 'Continue' },
    });
    const result = {
      runResultId,
      testCaseId,
      caseName: 'Continue',
      status: 'pass',
      declaredSteps: [{ id: contractStepId, action: 'click', target: 'Continue' }],
      envelope: { complete: false, ir: { caseId: testCaseId, steps: [] } },
      captureFirstEvidence: {
        actionEvidences: [{
          id: 'evidence-continue',
          runResultId,
          testCaseId,
          locatorRecipeId,
          contractStepId,
          actionOccurrenceId,
          occurrenceKey,
          occurrenceOrdinal: 1,
          authoredSequenceIndex: 1,
          toolName: 'browser_click',
          actionKind: 'click',
          status: 'passed',
          evidenceJson: JSON.stringify({ elementLabel: 'Continue' }),
        }],
        locatorRecipes: [{
          id: locatorRecipeId,
          runResultId,
          testCaseId,
          contractStepId,
          actionOccurrenceId,
          occurrenceKey,
          primaryExpression: locator.expression,
          sameElementProof: true,
          countBefore: 1,
          countAfter: 1,
          locatorRecipeJson: JSON.stringify(locator),
        }],
        assertionEvidences: [],
        navigationEvidences: [],
      },
    };

    replayExport.prepareResultForExport(result);

    const act = result.envelope.ir.steps.find((step) => step.op === 'act');
    const resolve = result.envelope.ir.steps.find((step) => step.op === 'resolve');
    expect(act).toMatchObject({
      action: 'click',
      contractStepId,
      actionOccurrenceId,
      occurrenceKey,
    });
    expect(resolve.actionLocator).toMatchObject({
      expression: locator.expression,
      verified: true,
    });
    expect(result.envelope.reconstructedMissingAuthoredActions).toBe(false);
    expect(result.envelope.authoredParity).toMatchObject({
      plannedActionMissingFromExecution: false,
      executionAuthority: 'executed_occurrences_only',
    });
  });

  it('routes the buildReplayExport all-blocked branch through an enabled selected-framework artifact', async () => {
    const projectSpy = vi.spyOn(prisma.project, 'findUnique').mockResolvedValue({ targetUrl: 'https://app.example.test' });
    const resultSpy = vi.spyOn(prisma.runResult, 'findMany').mockResolvedValue([{
      id: 'rr-no-replay-steps',
      runId: 'run-selected-fallback',
      testCaseId: 'tc-no-replay-steps',
      status: 'blocked',
      blockedReason: 'source evidence unavailable',
      replayIrJson: JSON.stringify({ complete: false, gaps: [{ code: 'legacy_inert' }], ir: { title: 'Saved diagnostic case', steps: [] } }),
      executionContractJson: null,
      actionGraphJson: null,
      stepResults: '[]',
      assertionCheckResults: '[]',
      dataRowIndex: null,
      dataRowLabel: null,
      actionEvidences: [],
      locatorRecipes: [],
      assertionEvidences: [],
      authSetupEvidences: [],
      navigationEvidences: [],
      traceArtifacts: [],
      replayIrCertifications: [],
      evidenceCompletenessLedgers: [],
      testCase: {
        id: 'tc-no-replay-steps',
        name: 'Saved diagnostic case',
        module: 'Administration',
        steps: '[]',
        declaredAssertions: '[]',
        requirementRefs: '[]',
        dependsOnIds: '[]',
        operationsJson: null,
        dataBindingJson: null,
        scenarioId: null,
        readinessStatus: 'blocked',
        readinessReasonsJson: '[]',
        runEligibility: 'blocked',
      },
    }]);

    try {
      const exported = await replayExport.buildReplayExport({
        projectId: 'project-selected-fallback',
        runId: 'run-selected-fallback',
        framework: 'selenium-reference',
        validate: false,
      });
      const javaPath = Object.keys(exported.files).find((rel) => /Test\.java$/.test(rel) && !/BaseTest\.java$/.test(rel));
      expect(javaPath).toBeTruthy();
      expect(exported.files[javaPath]).not.toMatch(/@Disabled|enabled\s*=\s*false|@skip/i);
      expect(Object.values(exported.files).join('\n')).not.toMatch(/test\.describe\.skip|test\.skip\(|test\.fixme\(|@Disabled|@skip/i);
      expect(exported.allBlocked).toBe(false);
      expect(exported.manifest).toMatchObject({ allBlocked: false, outputAvailable: true });
      const live = JSON.parse(exported.files['evidence/live-output-status.json']);
      expect(live).toMatchObject({
        allBlocked: false,
        status: 'generated_draft',
        outputAvailable: true,
        exportValid: false,
        runnable: false,
        certified: false,
      });
      expect(live.scriptArtifacts[0]).toMatchObject({
        file: javaPath,
        scriptGenerationStatus: 'generated_with_diagnostics',
      });
    } finally {
      projectSpy.mockRestore();
      resultSpy.mockRestore();
    }
  });

  it('defaults ReplayIR export to the newest actual run even when evidence materialization is missing', async () => {
    const projectSpy = vi.spyOn(prisma.project, 'findUnique').mockResolvedValue({ targetUrl: 'https://app.example.test' });
    const runSpy = vi.spyOn(prisma.run, 'findFirst').mockResolvedValue({ id: 'newest-run-without-replayir' });
    const resultSpy = vi.spyOn(prisma.runResult, 'findMany').mockImplementation(async (args) => {
      expect(args.where).toEqual({ runId: 'newest-run-without-replayir' });
      return [{
        id: 'rr-newest-no-replayir',
        runId: 'newest-run-without-replayir',
        testCaseId: 'tc-newest-no-replayir',
        status: 'pass',
        blockedReason: null,
        replayIrJson: null,
        executionContractJson: null,
        actionGraphJson: null,
        stepResults: JSON.stringify([{ index: 1, action: 'click', target: 'Continue button', status: 'passed' }]),
        assertionCheckResults: JSON.stringify([{ assertion: 'Welcome page is visible', matched: true }]),
        dataRowIndex: null,
        dataRowLabel: null,
        overallRunStatus: 'pass',
        executionStatus: 'passed',
        evidenceStatus: null,
        scriptStatus: null,
        evidenceCompletenessJson: null,
        actionEvidences: [],
        locatorRecipes: [],
        assertionEvidences: [],
        authSetupEvidences: [],
        navigationEvidences: [],
        traceArtifacts: [{
          id: 'trace-newest-no-replayir',
          type: 'trace',
          path: 'evidence/traces/newest-no-replayir.zip',
          captureStatus: 'ready',
          createdAt: '2026-07-30T08:30:00.000Z',
        }],
        replayIrCertifications: [],
        evidenceCompletenessLedgers: [],
        testCase: {
          id: 'tc-newest-no-replayir',
          name: 'Newest executed case without materialized ReplayIR',
          module: 'Administration',
          authProfile: null,
          operationsJson: null,
          requirementRefs: '[]',
          dataBindingJson: null,
          scenarioId: null,
          dependsOnIds: '[]',
          producesData: null,
          requiresData: null,
          steps: JSON.stringify([{ action: 'click', target: 'Continue button' }]),
          declaredAssertions: JSON.stringify(['Welcome page is visible']),
          qualityContractJson: null,
          readinessStatus: 'ready',
          readinessReasonsJson: '[]',
          readinessContractVersion: null,
          readinessComputedAt: null,
          runEligibility: 'allowed',
          sessionMode: 'fresh',
          failurePolicy: null,
          rowExecutionPlanJson: null,
          rowCoverageStatus: null,
          skippedRowsJson: null,
        },
      }];
    });

    try {
      const exported = await replayExport.buildReplayExport({
        projectId: 'project-latest-run-visibility',
        framework: 'playwright-pom-js',
        validate: false,
      });
      expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({
        where: { projectId: 'project-latest-run-visibility' },
        orderBy: { startedAt: 'desc' },
      }));
      expect(exported.runId).toBe('newest-run-without-replayir');
      expect(exported.manifest).toMatchObject({
        outputAvailable: true,
        exportValid: false,
        allBlocked: false,
      });
      expect(exported.blocked).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runResultId: 'rr-newest-no-replayir',
          code: 'replayir_missing',
        }),
      ]));
      expect(Object.keys(exported.files)).toEqual(expect.arrayContaining([
        'EXPORT_MANIFEST.json',
        'evidence/live-output-status.json',
        'evidence/run-artifact-plane.json',
        'evidence/immutable-execution-evidence-contract.json',
        'evidence/upstream-conductor-requirements.json',
        'evidence/post-run-materialization-status.json',
      ]));
      const artifactPlane = JSON.parse(exported.files['evidence/run-artifact-plane.json']);
      expect(artifactPlane).toMatchObject({
        schema: 'qaai-run-artifact-plane/1',
        authority: 'passive_observer',
        executionAuthority: false,
        verdictAuthority: false,
        outputVisibilityAuthority: false,
        summary: {
          total: 1,
          ready: 1,
        },
      });
      expect(artifactPlane.artifacts[0]).toMatchObject({
        runResultId: 'rr-newest-no-replayir',
        testCaseId: 'tc-newest-no-replayir',
        artifactKind: 'TRACE',
        captureStatus: 'READY',
        affectsVerdict: false,
        affectsOutputVisibility: false,
      });
      const immutable = JSON.parse(
        exported.files['evidence/immutable-execution-evidence-contract.json'],
      );
      expect(immutable.summary.upstreamRequirementCount).toBeGreaterThan(0);
      expect(immutable.upstreamRequirements).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'UPSTREAM_CONDUCTOR_REQUIREMENT',
          field: 'actionEvidences[] or stepResults[].actionTransaction',
          nonBlocking: true,
        }),
      ]));
      const upstream = JSON.parse(exported.files['evidence/upstream-conductor-requirements.json']);
      expect(upstream.requirements).toEqual(immutable.upstreamRequirements);
      const materialization = JSON.parse(
        exported.files['evidence/post-run-materialization-status.json'],
      );
      expect(materialization).toMatchObject({
        schema: 'qaai-post-run-materialization-status/1',
        synchronousBrowserGate: false,
        idempotent: true,
        restartable: true,
        summary: {
          resultCount: 1,
          upstreamRequirementCount: 1,
        },
      });
      expect(materialization.entries[0]).toMatchObject({
        runResultId: 'rr-newest-no-replayir',
        testCaseId: 'tc-newest-no-replayir',
        status: 'upstream_evidence_required',
        inlineExecutionGate: false,
        missing: ['executionContractJson', 'actionGraphJson', 'replayIrJson'],
        fields: {
          executionContractJson: { present: false, source: 'missing' },
          actionGraphJson: { present: false, source: 'missing' },
          replayIrJson: {
            present: false,
            source: 'missing',
            recoverableFromCommittedFacts: false,
          },
        },
      });
      expect(materialization.upstreamRequirements).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'UPSTREAM_CONDUCTOR_REQUIREMENT',
          field: 'executionContractJson,actionGraphJson,replayIrJson',
          consumer: 'post-run ActionGraph/ReplayIR materializer',
          nonBlocking: true,
        }),
      ]));
    } finally {
      projectSpy.mockRestore();
      runSpy.mockRestore();
      resultSpy.mockRestore();
    }
  });

  it('emits downloadable live-ledger diagnostics for failed runs with centralized executable actions', () => {
    const ledger = liveScriptRecorder.newLedger({
      runResultId: 'rr-ledger',
      testCaseId: 'tc-ledger',
      scriptMode: 'failed_run_script',
    });
    const userManagementActionLocator = exactActionLocator({
      expression: 'page.getByRole("button", { name: "User Management", exact: true })',
      targetFacts: { role: 'button', accessibleName: 'User Management' },
      ref: 'user-management-button',
      documentId: 'document:dashboard',
      nodeId: 'node:user-management-button',
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
      locatorExpression: userManagementActionLocator.expression,
      locatorRecipe: userManagementActionLocator,
      locatorProvenance: userManagementActionLocator,
      actionOccurrenceId: 'tc-ledger:user-management:click:1',
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

    const specPath = Object.keys(files).find((rel) => rel.startsWith('tests/') && rel.endsWith('.spec.js'));
    expect(specPath).toBeTruthy();
    expect(files[specPath]).not.toContain('test.describe.skip');
    expect(files[specPath]).toContain('await dashboardPage.openDashboard();');
    expect(files[specPath]).toMatch(/await .*\.clickUserManagement/);
    expect(files[specPath]).toContain('Active 61');
    const pagePath = Object.keys(files).find((rel) => /^pages\/.*Page\.js$/.test(rel) && files[rel].includes('openDashboard'));
    const locatorPath = Object.keys(files).find((rel) => rel.startsWith('locators/generated/') && rel.endsWith('.js'));
    expect(pagePath).toBeTruthy();
    expect(locatorPath).toBeTruthy();
    expect(files[pagePath]).toContain('async openDashboard()');
    expect(files[pagePath]).toContain('this.page.goto(');
    expect(files[pagePath]).toContain('.click(');
    expect(files[locatorPath]).toMatch(/user.*management/i);

    const status = JSON.parse(files['evidence/live-output-status.json']);
    expect(status).toMatchObject({
      status: 'generated_draft',
      outputAvailable: true,
      exportValid: false,
      runnable: false,
      certified: false,
    });
    expect(status.scriptArtifacts[0]).toMatchObject({
      source: 'replayir',
      scriptGenerationStatus: 'generated',
    });
    const manifest = JSON.parse(files['EXPORT_MANIFEST.json']);
    expect(manifest.artifacts[0]).toMatchObject({
      testCaseId: 'tc-ledger',
      source: 'replayir',
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
      source: 'authored_contract_diagnostic',
      scriptGenerationStatus: 'generated_with_diagnostics',
      certificationStatus: 'diagnostic_only',
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

  it('keeps locator-only uncertainty non-blocking while preserving non-locator strict gaps', () => {
    const findings = replayExport.assessStrictReplayExport({
      results: [{
        runResultId: 'rr-incomplete',
        testCaseId: 'tc-incomplete',
        envelope: {
          complete: false,
          gaps: [
            { code: 'locator_missing', stepIndex: 1 },
            { code: 'missing_action_evidence', stepIndex: 2 },
          ],
          ir: {
            steps: [
              { op: 'act', action: 'navigate', url: 'https://app.example.test' },
              {
                op: 'resolve',
                as: 'saveButton',
                guessedLocator: true,
                locatorConfidence: 'guessed',
                locatorProvenance: { kind: 'qaai_guessed_locator' },
                candidates: [{ strategy: 'role', role: 'button', name: 'Save', provenance: 'qaai_guessed_locator' }],
              },
              { op: 'act', action: 'click', target: 'saveButton', locatorConfidence: 'guessed' },
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
      'strict_export_locator_gaps_guessed',
      'strict_export_assertion_evidence_missing',
    ]));
    expect(findings.find((finding) => finding.rule === 'strict_export_locator_gaps_guessed')).toMatchObject({
      severity: 'warning',
      nonBlocking: true,
    });
    expect(findings.find((finding) => finding.rule === 'strict_export_replayir_gaps')).toMatchObject({ severity: 'error' });
  });

  it('strict export accepts complete ReplayIR with locator and assertion evidence', () => {
    const actionLocator = exactActionLocator({
      expression: 'getByRole("button", { name: "Continue" })',
      strategy: 'role',
      targetFacts: { role: 'button', accessibleName: 'Continue' },
      ref: 'continue-ref',
      nodeId: 'node:continue',
    });
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
      stepResults: [{
        stepId: 'step-1',
        actionTransaction: {
          transactionId: 'tx-1',
          actionOccurrenceId: 'occurrence-1',
          stepId: 'step-1',
          sequenceIndex: 0,
          action: { kind: 'fill', target: 'Password' },
          status: 'committed',
          dispatchStatus: 'delivered',
          dispatchTimestamp: '2026-07-20T10:00:00.000Z',
          dispatchAttemptCount: 1,
          preState: { value: 'must-not-export' },
          observations: [{ value: 'must-not-export' }],
          canonicalOutcome: {
            status: 'passed', outcomeKind: 'success', matched: true, checked: true,
            reason: 'exact_value_confirmed', completedAt: '2026-07-20T10:00:01.000Z',
            evidence: { value: 'must-not-export' },
          },
        },
      }],
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
    const transactions = JSON.parse(files['evidence/action-transactions.json']);
    expect(transactions.summary).toMatchObject({ transactionCount: 1, dispatchAttemptCount: 1 });
    expect(transactions.entries[0].transactions[0]).toMatchObject({
      transactionId: 'tx-1',
      actionOccurrenceId: 'occurrence-1',
      dispatchAttemptCount: 1,
      canonicalOutcome: { status: 'passed', matched: true },
    });
    expect(files['evidence/action-transactions.json']).not.toContain('must-not-export');
  });

  it('refreshes serialized locator metrics from the final per-case locator manifest', () => {
    const files = {
      'evidence/locator-manifest.json': JSON.stringify([
        {
          caseKey: 'rr-final-metrics',
          name: 'verifiedButton',
          expr: 'page.getByRole("button", { name: "Continue" })',
          source: 'actionLocator',
          verified: true,
          verificationStatus: 'verified',
        },
        {
          caseKey: 'rr-final-metrics',
          name: 'optionalPrompt',
          expr: 'page.getByRole("button", { name: "Yes" })',
          source: 'qaaiGuessedLocator',
          verified: false,
        },
        {
          caseKey: 'rr-final-metrics',
          name: 'welcomeAssertion',
          expr: 'page.getByText("Welcome")',
          source: 'authoredAssertionContract',
          verified: false,
        },
        {
          caseKey: 'rr-other-case',
          name: 'foreignGuess',
          expr: 'page.getByText("Foreign")',
          source: 'qaaiGuessedLocator',
        },
      ]),
    };
    const result = {
      runResultId: 'rr-final-metrics',
      testCaseId: 'tc-final-metrics',
      envelope: {
        complete: true,
        gaps: [],
        evidenceCompletenessLedger: {
          actionEvidenceCount: 2,
          emittedLocatorCount: 99,
          verifiedLocatorCount: 99,
          contractBackedLocatorCount: 99,
          guessedLocatorCount: 99,
          missingLocatorCount: 99,
        },
        evidenceBuiltReplayIr: {
          actionEvidenceCount: 2,
          guessedLocatorCount: 99,
        },
        ir: { steps: [] },
      },
    };

    replayExport.addCaptureFirstEvidenceFiles(files, [result]);
    const replayEvidence = JSON.parse(files['evidence/replayir.json']);
    expect(replayEvidence.replayIr[0].evidenceBuiltReplayIr).toMatchObject({
      actionEvidenceCount: 2,
      emittedLocatorCount: 3,
      verifiedLocatorCount: 1,
      contractBackedLocatorCount: 1,
      guessedLocatorCount: 1,
      missingLocatorCount: 0,
    });
    const completeness = JSON.parse(files['evidence/completeness-ledger.json']);
    expect(completeness.ledgers[0].ledger).toMatchObject({
      capturedEmittedLocatorCount: 99,
      capturedVerifiedLocatorCount: 99,
      capturedContractBackedLocatorCount: 99,
      capturedGuessedLocatorCount: 99,
      capturedMissingLocatorCount: 99,
      emittedLocatorCount: 3,
      verifiedLocatorCount: 1,
      contractBackedLocatorCount: 1,
      guessedLocatorCount: 1,
      missingLocatorCount: 0,
    });
  });

  it('refreshes stale occurrence parity from exact persisted action evidence before export', () => {
    const runResultId = 'rr-occurrence-refresh';
    const testCaseId = 'tc-occurrence-refresh';
    const contractStepId = `${testCaseId}:step:1:click`;
    const actionOccurrenceId = `${contractStepId}:click:1`;
    const occurrenceKey = `${testCaseId}:${contractStepId}:1:click`;
    const actionIdentity = {
      schemaVersion: 'qaai-action-identity-v1',
      caseId: testCaseId,
      contractStepId,
      authoredActionId: `${contractStepId}:action:1`,
      sequenceIndex: 1,
      operation: 'click',
      occurrenceKey,
      actionOccurrenceId,
      occurrenceOrdinal: 1,
    };
    const result = {
      runResultId,
      testCaseId,
      declaredSteps: [{ id: contractStepId, action: 'click', target: 'Continue button' }],
      envelope: {
        complete: true,
        gaps: [],
        evidenceBuiltReplayIr: {
          authoredOccurrenceParity: {
            satisfied: false,
            expectedAuthoredOccurrenceCount: 1,
            matchedAuthoredOccurrenceCount: 0,
            missingAuthoredOccurrenceCount: 1,
          },
        },
        ir: {
          caseId: testCaseId,
          steps: [
            {
              op: 'resolve',
              as: 'continueButton',
              contractStepId,
              actionIdentity,
              actionOccurrenceId,
              authored: false,
              evidenceOnly: true,
              origin: 'unmatched_runtime_evidence',
              candidates: [{ strategy: 'role', role: 'button', name: 'Continue' }],
            },
            {
              op: 'act',
              action: 'click',
              target: 'continueButton',
              contractStepId,
              actionIdentity,
              actionOccurrenceId,
              authored: false,
              evidenceOnly: true,
              origin: 'unmatched_runtime_evidence',
            },
          ],
        },
      },
      captureFirstEvidence: {
        actionEvidences: [
          {
            id: 'action-evidence-1',
            runResultId,
            testCaseId,
            contractStepId,
            actionIdentity,
            actionOccurrenceId,
            occurrenceOrdinal: 1,
            occurrenceKey,
            operation: 'click',
            status: 'passed',
          },
        ],
        locatorRecipes: [],
      },
    };

    const prepared = replayExport.prepareResultForExport(result);
    expect(prepared.envelope.ir.authoredOccurrenceParity).toMatchObject({
      satisfied: true,
      expectedAuthoredOccurrenceCount: 1,
      matchedAuthoredOccurrenceCount: 1,
      missingAuthoredOccurrenceCount: 0,
    });
    expect(prepared.envelope.evidenceBuiltReplayIr.authoredOccurrenceParity).toMatchObject({
      satisfied: true,
      expectedAuthoredOccurrenceCount: 1,
      matchedAuthoredOccurrenceCount: 1,
      missingAuthoredOccurrenceCount: 0,
    });
    expect(prepared.envelope.ir.steps.find((step) => step.op === 'act')).toMatchObject({
      authored: true,
      evidenceOnly: false,
      actionEvidenceId: 'action-evidence-1',
    });
  });

  it('hydrates seven authoritative locator recipes and eleven matched assertions before semantic fallback', () => {
    const runResultId = 'rr-authoritative-hydration';
    const testCaseId = 'tc-authoritative-hydration';
    const actionSteps = [];
    const actionEvidences = [];
    const locatorRecipes = [];

    for (let index = 1; index <= 7; index += 1) {
      const contractStepId = `action-${index}`;
      const actionOccurrenceId = `${contractStepId}:click:1`;
      const occurrenceKey = `${testCaseId}:${contractStepId}:1:click`;
      const locatorRecipeId = `recipe-${index}`;
      const actionEvidenceId = `evidence-${index}`;
      const ref = `target-${index}`;
      const recipe = exactActionLocator({
        expression: `getByTestId("authoritative-${index}")`,
        strategy: 'testid',
        documentId: `document-${index}`,
        nodeId: `node-${index}`,
      });
      actionSteps.push(
        {
          op: 'resolve',
          as: ref,
          contractStepId,
          actionOccurrenceId,
          occurrenceKey,
        },
        {
          op: 'act',
          action: 'click',
          target: ref,
          contractStepId,
          actionOccurrenceId,
          occurrenceKey,
        },
      );
      actionEvidences.push({
        id: actionEvidenceId,
        runResultId,
        testCaseId,
        locatorRecipeId,
        contractStepId,
        actionOccurrenceId,
        occurrenceKey,
        actionKind: 'click',
        status: 'passed',
      });
      locatorRecipes.push({
        id: locatorRecipeId,
        runResultId,
        testCaseId,
        contractStepId,
        actionOccurrenceId,
        occurrenceKey,
        primaryExpression: recipe.expression,
        sameElementProof: true,
        countBefore: 1,
        countAfter: 1,
        locatorRecipeJson: JSON.stringify(recipe),
      });
    }

    // These rows deliberately resemble valid evidence but must never be promoted.
    actionEvidences.push(
      {
        ...actionEvidences[0],
        id: 'foreign-run-evidence',
        runResultId: 'rr-foreign',
        locatorRecipeId: 'foreign-run-recipe',
      },
      {
        ...actionEvidences[1],
        id: 'wrong-occurrence-evidence',
        actionOccurrenceId: 'action-2:click:99',
        occurrenceKey: `${testCaseId}:action-2:99:click`,
        locatorRecipeId: 'wrong-occurrence-recipe',
      },
    );
    locatorRecipes.push(
      {
        ...locatorRecipes[0],
        id: 'foreign-run-recipe',
        runResultId: 'rr-foreign',
      },
      {
        ...locatorRecipes[1],
        id: 'wrong-occurrence-recipe',
        actionOccurrenceId: 'action-2:click:99',
        occurrenceKey: `${testCaseId}:action-2:99:click`,
      },
    );

    const assertions = Array.from({ length: 11 }, (_, index) => {
      const assertionId = `assertion-${index + 1}`;
      return {
        step: {
          op: 'assert',
          id: assertionId,
          assertionId,
          contractRef: assertionId,
          kind: 'text',
        },
        declared: {
          id: assertionId,
          type: 'UI_TEXT',
          payload: { expectedText: `Expected ${index + 1}` },
        },
        evidence: {
          id: `assertion-evidence-${index + 1}`,
          runResultId,
          testCaseId,
          assertionId,
          expectedJson: JSON.stringify(`Expected ${index + 1}`),
          actualJson: JSON.stringify(`Expected ${index + 1}`),
          matched: true,
          evidenceJson: JSON.stringify({ parseFailed: false, concrete: true }),
        },
      };
    });
    const result = {
      runResultId,
      testCaseId,
      caseName: 'Authoritative evidence hydration',
      declaredSteps: [],
      declaredAssertionsRaw: JSON.stringify(assertions.map((entry) => entry.declared)),
      liveOutcomes: {},
      envelope: {
        complete: true,
        gaps: assertions.map((entry) => ({
          code: 'assertion_translation_gap',
          where: entry.declared.id,
          detail: 'persisted evidence had not yet been hydrated',
        })),
        ir: { steps: [...actionSteps, ...assertions.map((entry) => entry.step)] },
      },
      captureFirstEvidence: {
        actionEvidences,
        locatorRecipes,
        assertionEvidences: assertions.map((entry) => entry.evidence),
      },
    };

    const prepared = replayExport.prepareResultForExport(result);
    const resolves = prepared.envelope.ir.steps.filter((step) => step.op === 'resolve');
    const acts = prepared.envelope.ir.steps.filter((step) => step.op === 'act');
    const assertSteps = prepared.envelope.ir.steps.filter((step) => step.op === 'assert');

    expect(resolves).toHaveLength(7);
    expect(acts).toHaveLength(7);
    expect(resolves.every((step) => step.captureEvidenceHydrated === true)).toBe(true);
    expect(acts.every((step) => step.captureEvidenceHydrated === true)).toBe(true);
    expect(resolves.filter((step) => step.guessedLocator === true)).toHaveLength(0);
    expect(resolves.map((step) => step.locatorProvenance.chosenExpression)).toEqual(
      Array.from({ length: 7 }, (_, index) => `getByTestId("authoritative-${index + 1}")`),
    );
    expect(acts.map((step) => step.actionEvidenceId)).toEqual(
      Array.from({ length: 7 }, (_, index) => `evidence-${index + 1}`),
    );
    expect(assertSteps).toHaveLength(11);
    expect(assertSteps.every((step) => step.liveOutcome === 'matched')).toBe(true);
    expect(Object.keys(prepared.liveOutcomes)).toHaveLength(11);
    expect(prepared.envelope.gaps.filter((gap) => gap.code === 'assertion_translation_gap')).toHaveLength(0);
    expect(prepared.captureEvidenceHydration).toMatchObject({ locatorCount: 7, assertionCount: 11 });
  });

  it('admits only explicitly successful runtime actions into prepared ReplayIR', () => {
    const result = {
      runResultId: 'rr-positive-runtime-only',
      testCaseId: 'tc-positive-runtime-only',
      declaredSteps: [],
      envelope: {
        complete: true,
        gaps: [],
        ir: {
          steps: [
            {
              op: 'act',
              action: 'navigate',
              url: 'https://app.example.test/passed',
              canonicalExecution: true,
              origin: 'runtime_evidence',
              executionStatus: 'passed',
            },
            {
              op: 'act',
              action: 'navigate',
              url: 'https://app.example.test/failed',
              canonicalExecution: true,
              origin: 'runtime_evidence',
              executionStatus: 'failed',
            },
            {
              op: 'act',
              action: 'navigate',
              url: 'https://app.example.test/marker-only',
              canonicalExecution: true,
              origin: 'runtime_evidence',
            },
          ],
        },
      },
    };

    const prepared = replayExport.prepareResultForExport(result);
    expect(
      prepared.envelope.ir.steps
        .filter((step) => step.op === 'act')
        .map((step) => step.url),
    ).toEqual(['https://app.example.test/passed']);
  });

  it('preserves an evaluated failed assertion and its expected and actual values', () => {
    const runResultId = 'rr-failed-assertion-hydration';
    const testCaseId = 'tc-failed-assertion-hydration';
    const assertionId = 'assertion-dashboard-title';
    const result = {
      runResultId,
      testCaseId,
      declaredAssertionsRaw: JSON.stringify([
        { id: assertionId, type: 'UI_TEXT', payload: { expectedText: 'Expected dashboard' } },
      ]),
      envelope: {
        complete: true,
        gaps: [],
        ir: {
          steps: [{ op: 'assert', id: assertionId, assertionId, contractRef: assertionId }],
        },
      },
      captureFirstEvidence: {
        assertionEvidences: [
          {
            id: 'assertion-evidence-failed',
            runResultId,
            testCaseId,
            assertionId,
            expectedJson: JSON.stringify('Expected dashboard'),
            actualJson: JSON.stringify('Unexpected login page'),
            matched: false,
            evidenceJson: JSON.stringify({ parseFailed: false, concrete: true }),
          },
        ],
      },
    };

    const prepared = replayExport.prepareResultForExport(result);
    const assertion = prepared.envelope.ir.steps.find((step) => step.op === 'assert');
    expect(assertion).toMatchObject({
      assertionId,
      assertionEvidenceId: 'assertion-evidence-failed',
      expected: 'Expected dashboard',
      actual: 'Unexpected login page',
      matched: false,
      liveOutcome: 'not_matched',
      checked: true,
      canonicalExecution: true,
    });
    expect(prepared.liveOutcomes[assertionId]).toMatchObject({
      matched: false,
      outcome: 'not_matched',
      expected: 'Expected dashboard',
      actual: 'Unexpected login page',
    });
  });

  it('hydrates an exact authored start navigation from scoped persisted navigation evidence only', () => {
    const runResultId = 'rr-navigation-hydration';
    const testCaseId = 'tc-navigation-hydration';
    const requestedUrl = 'https://app.example.test/auth/email-classifier?returnUrl=%2Fdashboard';
    const result = {
      runResultId,
      testCaseId,
      declaredSteps: [{ id: 'case_step_1', order: 1, action: 'Navigate' }],
      envelope: { complete: true, gaps: [], ir: { steps: [] } },
      captureFirstEvidence: {
        navigationEvidences: [
          {
            id: 'navigation-exact',
            runResultId,
            testCaseId,
            contractStepId: `${testCaseId}:step:1:runtime-hash`,
            actionOccurrenceId: `${testCaseId}:step:1:navigate:1`,
            occurrenceKey: `${testCaseId}:step:1:1:navigate`,
            sequenceIndex: 0,
            requestedUrl,
            resolvedUrl: requestedUrl,
            loadStateProof: 'landing_visible_confirmed',
          },
          {
            id: 'navigation-foreign',
            runResultId: 'rr-foreign',
            testCaseId,
            contractStepId: `${testCaseId}:step:1:foreign`,
            requestedUrl: 'https://foreign.example.test/',
            resolvedUrl: 'https://foreign.example.test/',
            loadStateProof: 'landing_visible_confirmed',
          },
        ],
      },
    };

    const prepared = replayExport.prepareResultForExport(result);
    const navigations = prepared.envelope.ir.steps.filter(
      (step) => step.op === 'act' && step.action === 'navigate',
    );
    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toMatchObject({
      contractStepId: 'case_step_1',
      sourceContractStepId: `${testCaseId}:step:1:runtime-hash`,
      actionOccurrenceId: `${testCaseId}:step:1:navigate:1`,
      url: requestedUrl,
      captureEvidenceHydrated: true,
      navigationEvidenceId: 'navigation-exact',
    });
    expect(prepared.captureEvidenceHydration.navigationCount).toBe(1);

    const mismatched = {
      ...result,
      envelope: { complete: true, gaps: [], ir: { steps: [] } },
      captureFirstEvidence: {
        navigationEvidences: [{
          id: 'navigation-wrong-step',
          runResultId,
          testCaseId,
          contractStepId: `${testCaseId}:step:2:runtime-hash`,
          requestedUrl,
          resolvedUrl: requestedUrl,
          loadStateProof: 'landing_visible_confirmed',
        }],
      },
    };
    const mismatchPrepared = replayExport.prepareResultForExport(mismatched);
    expect(mismatchPrepared.envelope.ir.steps.filter((step) => step.action === 'navigate')).toHaveLength(0);
    expect(mismatchPrepared.captureEvidenceHydration.navigationCount).toBe(0);
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

  it('ends long semantic Playwright spec filenames on a complete token', () => {
    const longScenarioName =
      'Login through email classifier and Microsoft sign-in -> Create an order and validate complex form controls';
    const result = dependencyCompileResult({
      testCaseId: 'case-long-semantic-filename',
      caseName: 'Login through email classifier and Microsoft sign-in',
      scenarioId: 'opaque-long-scenario-id',
      scenarioName: longScenarioName,
      url: 'https://app.example.test/home',
    });

    const compiled = replayExport.compileResults({
      adapter: playwrightReferenceAdapter,
      results: [result],
    });

    expect(compiled.blocked).toEqual([]);
    expect(compiled.admitted).toHaveLength(1);
    const filePath = compiled.admitted[0].filePath;
    const stem = path.posix.basename(filePath, '.spec.js');
    expect(stem).toBe('login-through-email-classifier-and-microsoft-sign-in-create-an-order');
    expect(stem.length).toBeLessThanOrEqual(80);
    expect(filePath).not.toMatch(/opaque-long-scenario-id|validat\.spec\.js$/);
  });

  it.each(['Research and', 'Choose or', 'Navigate to'])(
    'preserves the legitimate nontruncated semantic filename %s',
    (scenarioName) => {
      const result = dependencyCompileResult({
        testCaseId: `case-short-${scenarioName.replace(/\s+/g, '-').toLowerCase()}`,
        caseName: scenarioName,
        scenarioId: `scenario-short-${scenarioName.replace(/\s+/g, '-').toLowerCase()}`,
        scenarioName,
        url: 'https://app.example.test/home',
      });

      const compiled = replayExport.compileResults({
        adapter: playwrightReferenceAdapter,
        results: [result],
      });

      expect(compiled.blocked).toEqual([]);
      expect(compiled.admitted).toHaveLength(1);
      expect(path.posix.basename(compiled.admitted[0].filePath, '.spec.js')).toBe(
        scenarioName.toLowerCase().replace(/\s+/g, '-'),
      );
    },
  );

  it('preserves semantic spec filename collision suffixing after slug cleanup', () => {
    const results = ['first', 'second'].map((suffix) =>
      dependencyCompileResult({
        testCaseId: `case-semantic-collision-${suffix}`,
        caseName: `Semantic collision ${suffix}`,
        scenarioId: `scenario-semantic-collision-${suffix}`,
        scenarioName: 'Duplicate semantic scenario',
        url: 'https://app.example.test/home',
      }),
    );

    const compiled = replayExport.compileResults({
      adapter: playwrightReferenceAdapter,
      results,
    });

    expect(compiled.blocked).toEqual([]);
    expect(compiled.admitted).toHaveLength(2);
    expect(
      compiled.admitted.map((entry) => path.posix.basename(entry.filePath)).sort(),
    ).toEqual(['duplicate-semantic-scenario-2.spec.js', 'duplicate-semantic-scenario.spec.js']);
  });

  it('compiles a cross-scenario Playwright dependency chain into one semantic, topologically ordered browser journey', () => {
    const loginCase = dependencyCompileResult({
      testCaseId: 'case-login',
      caseName: 'Login through email classifier and Microsoft sign-in',
      scenarioId: 'opaque-auth-scenario-id',
      scenarioName: 'Authentication',
      url: 'https://app.example.test/home',
    });
    const userManagementCase = dependencyCompileResult({
      testCaseId: 'case-user-management',
      caseName: 'Validate User Management tabs and profile fields',
      scenarioId: 'opaque-users-scenario-id',
      scenarioName: 'User Management',
      dependsOnNames: ['Login through email classifier and Microsoft sign-in'],
      sessionMode: 'continue_from_dependency',
      url: 'https://app.example.test/user/administration',
    });

    // Deliberately reversed input proves dependency order, not database return order, wins.
    const compiled = replayExport.compileResults({
      adapter: playwrightReferenceAdapter,
      results: [userManagementCase, loginCase],
    });

    expect(compiled.blocked).toEqual([]);
    expect(compiled.admitted).toHaveLength(1);
    const journey = compiled.admitted[0];
    expect(journey.testCaseIds).toEqual(['case-login', 'case-user-management']);
    expect(journey.scenarioName).toBe('Authentication -> User Management');
    expect(journey.filePath).toContain('authentication-user-management.spec.js');
    expect(journey.filePath).not.toMatch(/opaque-auth|opaque-users/);
    expect(journey.content).toContain('test.describe("Authentication -> User Management"');
    expect(journey.content.indexOf('Login through email classifier and Microsoft sign-in'))
      .toBeLessThan(journey.content.indexOf('Validate User Management tabs and profile fields'));
    expect(journey.content.match(/async \(\{ page \}\)/g)).toHaveLength(1);
  });

  it('preserves every journey case as a distinct non-test diagnostic when the journey emitter throws', () => {
    const first = dependencyCompileResult({
      testCaseId: 'throwing-journey-first',
      caseName: 'First executed journey case',
      scenarioId: 'throwing-journey',
      scenarioName: 'Throwing journey',
    });
    const second = dependencyCompileResult({
      testCaseId: 'throwing-journey-second',
      caseName: 'Second executed journey case',
      scenarioId: 'throwing-journey',
      scenarioName: 'Throwing journey',
      dependsOnIds: ['throwing-journey-first'],
    });
    const throwingAdapter = {
      ...playwrightReferenceAdapter,
      emitJourneySpec() {
        throw new Error('synthetic journey emitter failure');
      },
    };

    const compiled = replayExport.compileResults({
      adapter: throwingAdapter,
      results: [first, second],
    });

    expect(compiled.admitted).toHaveLength(2);
    expect(compiled.admitted.every((entry) => entry.diagnosticOnly === true)).toBe(true);
    expect(compiled.admitted.map((entry) => entry.testCaseId)).toEqual([
      'throwing-journey-first',
      'throwing-journey-second',
    ]);
    expect(new Set(compiled.admitted.map((entry) => entry.filePath)).size).toBe(2);
    for (const entry of compiled.admitted) {
      expect(entry).toMatchObject({
        status: 'diagnostic_only',
        diagnosticReason: 'journey_emit_failed_diagnostic',
      });
      expect(entry.filePath).toMatch(/\.diagnostic\.js$/);
      expect(entry.filePath).not.toMatch(/\.spec\.[cm]?[jt]sx?$/i);
      expect(entry.content).not.toMatch(/test\s*\(|QAAI_GUESSED_LOCATOR|getByRole|getByText/);
    }
    expect(compiled.findings).toContainEqual(
      expect.objectContaining({
        rule: 'journey_emit_failed_diagnostic',
        nonBlocking: true,
      }),
    );
  });

  it('wires Selenium continuation and dependent-session preservation without changing fresh independent cases', () => {
    const loginCase = dependencyCompileResult({
      testCaseId: 'selenium-login',
      caseName: 'Establish authenticated browser session',
      url: 'https://app.example.test/home',
    });
    const continuationCase = dependencyCompileResult({
      testCaseId: 'selenium-users',
      caseName: 'Continue to User Management',
      dependsOnIds: ['selenium-login'],
      sessionMode: 'continue_from_dependency',
      url: 'https://app.example.test/user/administration',
    });
    const independentCase = dependencyCompileResult({
      testCaseId: 'selenium-independent',
      caseName: 'Open public status page',
      url: 'https://status.example.test/',
    });

    const compiled = replayExport.compileResults({
      adapter: seleniumReferenceAdapter,
      results: [continuationCase, independentCase, loginCase],
    });

    expect(compiled.blocked).toEqual([]);
    expect(compiled.admitted).toHaveLength(3);
    const parent = compiled.admitted.find((entry) => entry.testCaseId === 'selenium-login');
    const child = compiled.admitted.find((entry) => entry.testCaseId === 'selenium-users');
    const independent = compiled.admitted.find((entry) => entry.testCaseId === 'selenium-independent');

    expect(parent).toMatchObject({ continueSession: false, preserveSessionForDependents: true });
    expect(parent.content).toContain('protected boolean continueSession() { return false; }');
    expect(parent.content).toContain('protected boolean preserveSessionForDependents() { return true; }');
    expect(child).toMatchObject({ continueSession: true, preserveSessionForDependents: false });
    expect(child.dependsOnIds).toEqual(['selenium-login']);
    expect(child.content).toContain('protected boolean continueSession() { return true; }');
    expect(child.content).toContain('protected boolean preserveSessionForDependents() { return false; }');
    expect(child.content).toContain('dependsOnGroups = {"qaai_establish_authenticated_browser_session"}');
    expect(independent).toMatchObject({ continueSession: false, preserveSessionForDependents: false });
    expect(independent.content).toContain('protected boolean continueSession() { return false; }');
    expect(independent.content).toContain('protected boolean preserveSessionForDependents() { return false; }');
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

  it('keeps stranded logout flows enabled without composing hidden logout steps', () => {
    const emitted = [];
    const admitted = [];
    const blocked = [];
    const manifestEntries = [];
    const findings = [];
    const adapter = {
      emitJourneySpec: (cases) => {
        emitted.push(cases);
        return { content: 'test.describe("logout", () => {});', extraFiles: {} };
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
            sessionMode: 'continue_from_dependency',
            dependsOnIds: ['tc-login'],
            dependsOnNames: ['Login through identity provider'],
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

    expect(admitted).toHaveLength(1);
    expect(blocked).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toMatchObject({
      sessionMode: 'continue_from_dependency',
      dependsOnIds: ['tc-login'],
      dependsOnNames: ['Login through identity provider'],
    });
    expect(findings.some((f) => f.rule === 'replayir_logout_precondition_diagnostic')).toBe(true);
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
    const actionLocator = exactActionLocator({
      expression: 'locator("input[type=\\"password\\"]")',
      strategy: 'password_type',
      targetFacts: { role: 'textbox', accessibleName: 'Password', type: 'password' },
      ref: 'password-ref',
      nodeId: 'node:password',
    });

    expect(actionLocatorResolver.isExportSafeActionLocator(actionLocator)).toBe(true);
    expect(actionLocatorResolver.isVerifiedActionLocator(actionLocator)).toBe(true);

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

  it('lets verified action evidence win even when stale step-level guessed flags remain', () => {
    const actionLocator = exactActionLocator({
      expression: 'getByRole("button", { name: "Continue", exact: true })',
      strategy: 'role',
      targetFacts: { role: 'button', accessibleName: 'Continue' },
      ref: 'continue-ref',
      nodeId: 'node:continue',
    });
    const repo = pageObjectRepository.buildLocatorRepository({
      cases: [{
        ir: {
          steps: [
            { op: 'act', action: 'navigate', url: 'https://app.test/auth/login' },
            {
              op: 'resolve',
              as: 'continueButton',
              pageUrl: 'https://app.test/auth/login',
              actionLocator,
              guessedLocator: true,
              locatorConfidence: 'guessed',
              locatorProvenance: { kind: 'qaai_guessed_locator' },
            },
          ],
        },
      }],
    });

    expect(repo.files.loginPage.continueButton).toMatchObject({
      source: 'actionLocator',
      expr: 'page.getByRole("button", { name: "Continue", exact: true })',
    });
    expect(repo.files.loginPage.continueButton.guessedLocator).toBeUndefined();
    expect(repo.manifest[0]).toMatchObject({ source: 'actionLocator', verified: true });
    expect(repo.diagnostics).toEqual([]);
  });

  it('keeps password-only candidates as diagnostics instead of executable POM locators', () => {
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

    expect(repo.files).toEqual({});
    expect(repo.manifest).toEqual([]);
    expect(repo.diagnostics).toEqual([
      expect.objectContaining({
        as: 'el2',
        executable: false,
        diagnosticOnly: true,
        reason: 'candidate_only_locator',
      }),
    ]);
  });

  it('reconstructs codegenLocator from rich trace so ReplayIR keeps password action evidence', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-replay-trace-'));
    const traceFile = path.join(tmpDir, 'trace.json.gz');
    const codegenLocator = exactActionLocator({
      expression: 'locator("input[type=\\"password\\"]")',
      strategy: 'password_type',
      targetFacts: { role: 'textbox', accessibleName: 'Password', type: 'password' },
      ref: 'password-trace-ref',
      nodeId: 'node:password-trace',
    });
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
    expect(resolve).toBeTruthy();
    expect(resolve.actionLocator.expression).toBe('locator("input[type=\\"password\\"]")');
    expect(resolve.actionLocator.captureBinding).toEqual({
      kind: 'mcp_bound_ref',
      ref: 'password-trace-ref',
    });
    expect(replay.ir.steps).toContainEqual(
      expect.objectContaining({ op: 'act', action: 'type', target: resolve.as }),
    );
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

  it('captures nested frame controls with an outer-to-inner frameLocator chain', async () => {
    const locator = await captureStructuralLocatorFromNestedFrameDom({
      topHtml: '<main><iframe id="account-shell"></iframe></main>',
      outerFrameSelector: 'iframe',
      middleHtml: '<section><iframe title="Payment details"></iframe></section>',
      innerFrameSelector: 'iframe',
      innerHtml: '<button aria-label="Pay now">Pay now</button>',
      targetSelector: 'button',
    });
    const expr = locator?.frameworkExpressions?.playwright || '';

    expect(expr).toBe('frameLocator("iframe#account-shell").frameLocator("iframe[title=\\"Payment details\\"]").locator("button[aria-label=\\"Pay now\\"]")');
    expect(locator?.context?.framePath).toEqual([
      'iframe#account-shell',
      'iframe[title="Payment details"]',
    ]);
    expect(locator?.domAtlas?.frames).toEqual([
      expect.objectContaining({ selector: 'iframe#account-shell', depth: 0 }),
      expect.objectContaining({ selector: 'iframe[title="Payment details"]', depth: 1 }),
    ]);
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

  it('captures nested open-shadow controls with an outer-to-inner host chain', async () => {
    const locator = await captureStructuralLocatorFromDom(`
      <div data-testid="account-widget"></div>
      <button aria-label="Confirm payment">Confirm payment</button>
    `, (dom) => {
      const outerHost = dom.window.document.querySelector('[data-testid="account-widget"]');
      const outerRoot = outerHost.attachShadow({ mode: 'open' });
      const innerHost = dom.window.document.createElement('section');
      innerHost.setAttribute('data-testid', 'payment-widget');
      outerRoot.appendChild(innerHost);
      const innerRoot = innerHost.attachShadow({ mode: 'open' });
      const button = dom.window.document.createElement('button');
      button.setAttribute('aria-label', 'Confirm payment');
      button.textContent = 'Confirm payment';
      innerRoot.appendChild(button);
      return button;
    });
    const expr = locator?.frameworkExpressions?.playwright || '';

    expect(expr).toBe('locator("div[data-testid=\\"account-widget\\"]").locator("section[data-testid=\\"payment-widget\\"]").getByRole("button", { name: "Confirm payment" })');
    expect(locator?.context?.shadowPath).toEqual([
      'div[data-testid="account-widget"]',
      'section[data-testid="payment-widget"]',
    ]);
    expect(locator?.domAtlas?.shadowHosts).toEqual([
      expect.objectContaining({ selector: 'div[data-testid="account-widget"]', depth: 0 }),
      expect.objectContaining({ selector: 'section[data-testid="payment-widget"]', depth: 1 }),
    ]);
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

  it('keeps failed coordinate conversion diagnostic-only without inventing a locator', () => {
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
    expect(emit.ir.steps.some((step) => step.op === 'resolve' || step.op === 'act')).toBe(false);
    expect(JSON.stringify(emit)).not.toContain('qaai_guessed_locator');
    expect(emit.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'locator_unverified',
        coordinate: { x: 44, y: 88 },
      }),
    ]));
    expect(emit.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'locator_unverified' }),
    ]));
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

  it('retains BDD package output with diagnostics when operationsJson reports dropped operations', () => {
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

    expect(result.exportable).toBe(true);
    expect(result.findings.some((f) => f.rule === 'bdd_export_operations_incomplete')).toBe(true);
    expect(result.findings.some((f) => f.rule === 'bdd_export_operation_dropped' && /Place Order/.test(f.message))).toBe(true);
    expect(bddExportGate.blockedSpecMessage({ framework: 'playwright-bdd', testCase: { name: 'Place order' }, gate: result }))
      .toContain('QAAI BDD OUTPUT DIAGNOSTIC');
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
