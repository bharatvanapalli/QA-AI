import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const consistency = require('../../server/services/codegen/evidenceConsistency.js');

function verifiedEntry(overrides = {}) {
  const targetIdentity = {
    scheme: 'qaai-cdp-backend-node-v1',
    backendNodeId: 65,
    frameId: 'frame-login',
    documentUrl: 'https://app.test/login',
    connected: true,
  };
  return {
    file: 'loginPage',
    name: 'continueButton',
    as: 'continueButton',
    expr: 'page.getByRole("button", { name: "Continue", exact: true })',
    pageKey: 'login',
    contractStepId: 'TC-1:step:2',
    verificationSource: 'authoritative_chromium_cdp',
    evidenceSource: 'authoritative_chromium_cdp',
    verified: true,
    verificationStatus: 'verified',
    proof: {
      count: 1,
      sameElement: true,
      verified: true,
      actionTimeResolved: true,
      resolutionMode: 'authoritative_cdp_backend_node',
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
      source: 'authoritative_chromium_cdp',
    },
    ...overrides,
  };
}

function filesWithManifest(entries) {
  return {
    'pages/LoginPage.js': `export class LoginPage {
  async open() { await this.page.goto('/login'); }
  async clickContinue() { await this.continueButton().click(); }
  async assertWelcome(expected) { await this.page.getByText(expected).waitFor(); }
}
`,
    'tests/login.spec.js': `test('login', async () => {});\n`,
    'evidence/locator-manifest.json': JSON.stringify(entries),
    'evidence/dom-atlas.json': JSON.stringify({
      schemaVersion: 'qaai-dom-atlas-v1',
      pages: {
        '/': {
          schemaVersion: 'qaai-dom-atlas-v1',
          pageKey: '/',
          controls: [{ source: 'action_locator_minimal' }],
          verifiedActions: [],
        },
      },
    }),
    'evidence/pom-architect-report.json': JSON.stringify({
      schemaVersion: 'qaai-pom-architect-v1',
      pages: {},
      specPlan: [],
    }),
    'evidence/certification-report.json': JSON.stringify({
      spec: { status: 'runnable' },
      evidence: {
        'locator-certification-report.json': { status: 'absent', stepCount: 0 },
        'pom-architect-report.json': { status: 'present', methodCount: 0 },
      },
    }),
  };
}

describe('generated evidence projection consistency', () => {
  it('projects strict action-time locator proof and emitted POM methods into every report', () => {
    const files = consistency.reconcileGeneratedEvidence({
      adapterId: 'playwright-pom-js',
      files: filesWithManifest([verifiedEntry()]),
    });
    const locator = JSON.parse(files['evidence/locator-certification-report.json']);
    const atlas = JSON.parse(files['evidence/dom-atlas.json']);
    const pom = JSON.parse(files['evidence/pom-architect-report.json']);
    const certification = JSON.parse(files['evidence/certification-report.json']);

    expect(locator.summary).toMatchObject({
      total: 1,
      certified: 1,
      draft: 0,
      blocked: 0,
      status: 'certified',
    });
    expect(locator.steps[0]).toMatchObject({
      locatorIdentity: { file: 'loginPage', name: 'continueButton' },
      exportGate: { status: 'certified' },
      selected: {
        expression: 'page.getByRole("button", { name: "Continue", exact: true })',
        certificationMode: 'action_time_same_node',
        proof: { count: 1, sameElement: true, identityVerified: true },
      },
    });
    expect(atlas.pages.login.verifiedActions).toHaveLength(1);
    expect(atlas.pages.login.verifiedActions[0]).toMatchObject({
      file: 'loginPage',
      name: 'continueButton',
      verified: true,
      proof: { count: 1, sameElement: true, identityVerified: true },
    });
    expect(pom.pages.LoginPage.architectMethods.map((method) => method.name)).toEqual([
      'open', 'clickContinue', 'assertWelcome',
    ]);
    expect(pom.generatedMethodCount).toBe(3);
    expect(certification.evidence['locator-certification-report.json']).toMatchObject({
      status: 'certified', stepCount: 1, certified: 1,
    });
    expect(certification.evidence['pom-architect-report.json']).toMatchObject({
      status: 'present', methodCount: 3, pageCount: 1,
    });
  });

  it('preserves identity-rich spec rows only when their emitted source exists', () => {
    const input = filesWithManifest([verifiedEntry()]);
    input['tests/login.spec.js'] = `await loginPage.clickContinue();\n`;
    input['evidence/pom-architect-report.json'] = JSON.stringify({
      schemaVersion: 'qaai-pom-architect-v1',
      pages: {},
      specPlan: [
        {
          testCaseId: 'TC-1',
          contractStepId: 'TC-1:step:2',
          op: 'act',
          action: 'click',
          exportedPageMethod: 'clickContinue',
          emittedSource: 'await loginPage.clickContinue();',
        },
        {
          testCaseId: 'TC-stale',
          contractStepId: 'stale-step',
          emittedSource: 'await stalePage.clickMissing();',
        },
      ],
    });

    const files = consistency.reconcileGeneratedEvidence({
      adapterId: 'playwright-pom-js',
      files: input,
    });
    const pom = JSON.parse(files['evidence/pom-architect-report.json']);
    expect(pom.specPlan).toEqual([
      expect.objectContaining({
        testCaseId: 'TC-1',
        contractStepId: 'TC-1:step:2',
        exportedPageMethod: 'clickContinue',
        source: 'emitted_spec_source',
      }),
    ]);
  });

  it('keeps guessed locators visible and non-blocking without promoting them to verified', () => {
    const guess = verifiedEntry({
      name: 'optionalPromptButton',
      as: 'optionalPromptButton',
      expr: 'page.getByRole("button", { name: "Optional prompt" })',
      verified: false,
      verificationStatus: 'unverified',
      verificationSource: 'qaai_guessed_locator',
      guessedLocator: true,
      proof: undefined,
      warning: 'Optional target was absent during this run; locator remains an unverified fallback.',
    });
    const files = consistency.reconcileGeneratedEvidence({
      adapterId: 'playwright-pom-js',
      files: filesWithManifest([verifiedEntry(), guess]),
    });
    const locator = JSON.parse(files['evidence/locator-certification-report.json']);
    const atlas = JSON.parse(files['evidence/dom-atlas.json']);

    expect(locator.summary).toMatchObject({ total: 2, certified: 1, draft: 1, blocked: 0, status: 'draft' });
    expect(locator.steps[1]).toMatchObject({
      exportGate: { status: 'draft', nonBlocking: true },
      selected: { confidence: 'draft', certificationMode: 'unverified_fallback' },
    });
    expect(Object.values(atlas.pages).flatMap((page) => page.verifiedActions || [])).toHaveLength(1);
  });

  it('classifies authored assertion locators separately from action-time verification and fallbacks', () => {
    const assertionContract = verifiedEntry({
      file: 'dashboardPage',
      name: 'welcomeMessage',
      as: 'welcomeMessage',
      expr: 'page.getByText("Welcome OdysseyOne", { exact: false })',
      contractStepId: 'TC-1:step:11',
      source: 'authoredAssertionContract',
      verificationSource: 'authored_contract',
      verified: false,
      verificationStatus: 'authored_contract',
      proof: undefined,
      provenance: { kind: 'authored_assertion_contract' },
    });
    const files = consistency.reconcileGeneratedEvidence({
      adapterId: 'playwright-pom-js',
      files: filesWithManifest([verifiedEntry(), assertionContract]),
    });
    const locator = JSON.parse(files['evidence/locator-certification-report.json']);
    const atlas = JSON.parse(files['evidence/dom-atlas.json']);
    const certification = JSON.parse(files['evidence/certification-report.json']);

    expect(locator.summary).toMatchObject({
      total: 2,
      certified: 1,
      authoredAssertionContract: 1,
      draft: 0,
      blocked: 0,
      status: 'certified',
    });
    expect(locator.steps[1]).toMatchObject({
      selected: {
        confidence: 'authored',
        certificationMode: 'authored_assertion_contract',
      },
      weaknesses: [],
      repairRecommendation: null,
      exportGate: {
        status: 'authored_assertion_contract',
        nonBlocking: true,
      },
    });
    expect(locator.steps[1].exportGate.reason).toContain('not action-time verified browser evidence');
    expect(Object.values(atlas.pages).flatMap((page) => page.verifiedActions || [])).toHaveLength(1);
    expect(certification.evidence['locator-certification-report.json']).toMatchObject({
      status: 'certified',
      stepCount: 2,
      certified: 1,
      authoredAssertionContract: 1,
      draft: 0,
    });
  });

  it('rejects mismatched backend-node identity even when verified flags are forged', () => {
    const entry = verifiedEntry();
    entry.proof.matchedIdentity.backendNodeId = 999;
    expect(consistency.isAuthoritativeVerifiedLocator(entry)).toBe(false);
  });

  it('does not alter non-POM framework files', () => {
    const files = filesWithManifest([verifiedEntry()]);
    expect(consistency.reconcileGeneratedEvidence({ adapterId: 'selenium-pom', files })).toBe(files);
  });
});
