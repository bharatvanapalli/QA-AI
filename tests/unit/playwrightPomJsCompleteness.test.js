import { verifiedActionLocator } from '../fixtures/playwrightPomJsPrecisionAcceptance.fixture.js';

const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs');
const standardProfile = require('../../server/services/codegen/adapters/playwrightPomJsStandardProfile');

function occurrences(source, token) {
  return String(source || '').split(token).length - 1;
}

function emittedSources(output) {
  return [output.content, ...Object.values(output.extraFiles || {})].join('\n');
}

function standardCase(overrides = {}) {
  return {
    runResultId: 'completeness-run',
    testCaseId: 'completeness-case',
    caseName: 'Account administration journey',
    declaredSteps: [],
    ir: {
      version: 1,
      caseId: 'completeness-case',
      title: 'Account administration journey',
      authProfile: { id: 'default', strategy: 'none', disposition: 'bypass_fixture' },
      steps: [],
      verdict: { status: 'pass', perAssertionOutcomes: [] },
    },
    ...overrides,
  };
}

describe('Playwright POM JavaScript completeness invariants', () => {
  it('preserves repeated authored actions by occurrence and centralizes every browser operation', () => {
    const saveAccountLocator = verifiedActionLocator(
      'page.getByRole("button", { name: "Save account", exact: true })',
      {
        role: 'button',
        accessibleName: 'Save account',
        pageUrl: 'https://identity.example.test/auth/authorize',
      },
    );
    const declaredSteps = [
      {
        id: 'open-auth',
        action: 'navigate',
        url: 'https://identity.example.test/auth/authorize',
        expectedPageTitle: 'Microsoft Sign-In',
      },
      {
        id: 'save-account',
        action: 'click',
        target: 'Save account',
        pageUrl: 'https://identity.example.test/auth/authorize',
      },
      {
        id: 'save-account',
        action: 'click',
        target: 'Save account',
        pageUrl: 'https://identity.example.test/auth/authorize',
      },
      {
        id: 'dialog',
        action: 'handleDialog',
        accept: true,
        promptText: 'approved',
        expectedPageTitle: 'Microsoft Sign-In',
      },
      {
        id: 'resize',
        action: 'resize',
        width: 1440,
        height: 900,
        expectedPageTitle: 'Microsoft Sign-In',
      },
      { id: 'back', action: 'navigateBack', expectedPageTitle: 'Microsoft Sign-In' },
      { id: 'forward', action: 'navigateForward', expectedPageTitle: 'Microsoft Sign-In' },
      { id: 'close', action: 'close', expectedPageTitle: 'Microsoft Sign-In' },
    ];
    const output = playwrightPomJs.emitJourneySpec(
      [
        standardCase({
          declaredSteps,
          ir: {
            ...standardCase().ir,
            steps: [
              {
                op: 'act',
                action: 'navigate',
                url: 'https://identity.example.test/auth/authorize',
                contractStepId: 'open-auth',
                authored: true,
                expectedPageTitle: 'Microsoft Sign-In',
              },
              {
                op: 'act',
                action: 'click',
                target: 'Save account',
                targetLabel: 'Save account',
                contractStepId: 'save-account',
                actionOccurrenceId: 'save-account:occurrence:1',
                occurrenceKey: 'save-account:occurrence:1',
                authored: true,
                pageUrl: 'https://identity.example.test/auth/authorize',
                actionLocator: saveAccountLocator,
              },
              {
                op: 'act',
                action: 'click',
                target: 'Save account',
                targetLabel: 'Save account',
                contractStepId: 'save-account',
                actionOccurrenceId: 'save-account:occurrence:2',
                occurrenceKey: 'save-account:occurrence:2',
                authored: true,
                pageUrl: 'https://identity.example.test/auth/authorize',
                actionLocator: saveAccountLocator,
              },
              {
                op: 'act',
                action: 'handleDialog',
                accept: true,
                promptText: 'approved',
                contractStepId: 'dialog',
                authored: true,
                expectedPageTitle: 'Microsoft Sign-In',
              },
              {
                op: 'act',
                action: 'resize',
                width: 1440,
                height: 900,
                contractStepId: 'resize',
                authored: true,
                expectedPageTitle: 'Microsoft Sign-In',
              },
              {
                op: 'act',
                action: 'navigateBack',
                contractStepId: 'back',
                authored: true,
                expectedPageTitle: 'Microsoft Sign-In',
              },
              {
                op: 'act',
                action: 'navigateForward',
                contractStepId: 'forward',
                authored: true,
                expectedPageTitle: 'Microsoft Sign-In',
              },
              {
                op: 'act',
                action: 'close',
                contractStepId: 'close',
                authored: true,
                expectedPageTitle: 'Microsoft Sign-In',
              },
            ],
          },
        }),
      ],
      { scenarioName: 'Complete browser operation ownership', moduleFormat: 'esm' },
    );

    const pageSources = Object.entries(output.extraFiles)
      .filter(([name]) => /^pages\/.*Page\.js$/.test(name))
      .map(([, source]) => source)
      .join('\n');
    const saveCalls = output.content.match(/await\s+\w+\.click\w*SaveAccount\w*\(/g) || [];
    const saveMethods = pageSources.match(/async\s+click\w*SaveAccount\w*\(/g) || [];
    expect(saveCalls).toHaveLength(2);
    expect(saveMethods.length).toBeGreaterThanOrEqual(1);
    expect(output.content).toMatch(/await microsoftSignInPage\.openMicrosoftSignIn\(\);/);
    expect(output.content).toMatch(/await microsoftSignInPage\.acceptNextDialog\(\);/);
    expect(output.content).toMatch(/await microsoftSignInPage\.resizeViewport\(\);/);
    expect(output.content).toMatch(/await microsoftSignInPage\.goBack\(\);/);
    expect(output.content).toMatch(/await microsoftSignInPage\.goForward\(\);/);
    expect(output.content).toMatch(/await microsoftSignInPage\.closePage\(\);/);
    expect(output.content).not.toMatch(
      /await page\.(?:goto|goBack|goForward|setViewportSize|close)\(/,
    );
    expect(pageSources).toContain('await this.page.goto("https://identity.example.test/auth/authorize", { waitUntil: "domcontentloaded" });');
    expect(pageSources).toContain('await dialog.accept("approved");');
    expect(pageSources).toContain('await this.page.setViewportSize({ width: 1440, height: 900 });');
    expect(Object.keys(output.extraFiles)).not.toContain('pages/ApplicationPage.js');
    expect(Object.keys(output.extraFiles)).not.toContain('pages/RootPage.js');
    expect(Object.keys(output.extraFiles)).not.toContain('pages/AuthorizePage.js');
    expect(pageSources).not.toMatch(/async\s+\w+_\d+\s*\(/);
  });

  it('does not materialize a declaration-only assertion as executable code', () => {
    const output = playwrightPomJs.emitJourneySpec(
      [
        standardCase({
          declaredAssertionsRaw: [
            {
              id: 'profile-summary-contract',
              type: 'UI_TEXT',
              payload: { description: 'Confirm the account profile summary is visible.' },
            },
          ],
        }),
      ],
      { scenarioName: 'Missing assertion evidence', moduleFormat: 'esm' },
    );

    expect(occurrences(output.content, 'expect.soft(false')).toBe(0);
    const userSources = [output.content, ...Object.values(output.extraFiles)].join('\n');
    expect(userSources).not.toContain(
      'QAAI_ASSERTION_CONTRACT_UNRESOLVED: the authored expected value was unavailable.',
    );
    expect(userSources).not.toContain('expect.soft(expected');
    expect(userSources).not.toContain('throw new Error(');
    expect(output.content).not.toMatch(/clickDeclaredAssertion|Declared assertion.*\.click/i);
  });

  it('recovers a misclassified assertion act only when evaluated assertion evidence exists', () => {
    const assertionContract = {
      id: 'profile-ready',
      action: 'verify',
      assertionType: 'UI_TEXT',
      expected: 'Profile ready',
    };
    const caseWith = (step) =>
      standardCase({
        declaredSteps: [assertionContract],
        declaredAssertionsRaw: [assertionContract],
        ir: {
          ...standardCase().ir,
          steps: [
            {
              op: 'act',
              action: 'click',
              contractStepId: 'profile-ready',
              authored: true,
              ...step,
            },
          ],
        },
      });

    const withoutEvidence = standardProfile.prepareCasesForStandardOutput([
      caseWith({ expected: 'Profile ready' }),
    ])[0];
    expect(withoutEvidence.ir.steps.filter((step) => step.op === 'act')).toHaveLength(0);
    expect(withoutEvidence.ir.steps.filter((step) => step.op === 'assert')).toHaveLength(0);

    const withActionStatusOnly = standardProfile.prepareCasesForStandardOutput([
      caseWith({
        expected: 'Profile ready',
        status: 'passed',
        outcome: 'matched',
        canonicalExecution: true,
        origin: 'runtime_evidence',
      }),
    ])[0];
    expect(withActionStatusOnly.ir.steps.filter((step) => step.op === 'act')).toHaveLength(0);
    expect(withActionStatusOnly.ir.steps.filter((step) => step.op === 'assert')).toHaveLength(0);

    const withEvidence = standardProfile.prepareCasesForStandardOutput([
      caseWith({
        expected: 'Profile ready',
        checked: true,
        matched: true,
        outcome: 'matched',
        assertionEvidenceId: 'assertion-evidence-profile-ready',
      }),
    ])[0];
    const assertions = withEvidence.ir.steps.filter((step) => step.op === 'assert');
    expect(assertions).toHaveLength(1);
    expect(assertions[0]).toMatchObject({
      contractStepId: 'profile-ready',
      expected: 'Profile ready',
      checked: true,
      matched: true,
      assertionEvidenceId: 'assertion-evidence-profile-ready',
    });

    const withFailedEvidence = standardProfile.prepareCasesForStandardOutput([
      caseWith({
        expected: 'Profile ready',
        checked: true,
        matched: false,
        outcome: 'not_matched',
        assertionEvidenceId: 'assertion-evidence-profile-not-ready',
      }),
    ])[0];
    expect(withFailedEvidence.ir.steps.filter((step) => step.op === 'assert')).toEqual([
      expect.objectContaining({
        contractStepId: 'profile-ready',
        checked: true,
        matched: false,
        assertionEvidenceId: 'assertion-evidence-profile-not-ready',
      }),
    ]);
  });

  it('enriches assertions only through exact immutable contract identity', () => {
    const contract = {
      id: 'declared-ready',
      type: 'UI_TEXT',
      payload: {
        target: 'declaredReadyStatus',
        expectedText: 'Declared ready',
        timeoutMs: 7654,
      },
    };
    const prepare = (declaredAssertionsRaw, step) =>
      standardProfile.prepareCasesForStandardOutput([
        standardCase({
          declaredAssertionsRaw,
          ir: { ...standardCase().ir, steps: [{ op: 'assert', authored: true, ...step }] },
        }),
      ])[0].ir.steps.find((candidate) => candidate.op === 'assert');

    const soleUnused = prepare([contract], {
      channel: 'UI_TEXT',
      target: 'runtimeStatus',
      expected: 'Runtime ready',
    });
    expect(soleUnused).toMatchObject({ target: 'runtimeStatus', expected: 'Runtime ready' });
    expect(soleUnused.contractStepId).toBeUndefined();
    expect(soleUnused.timeoutMs).toBeUndefined();

    const sameExpected = prepare(
      [
        contract,
        {
          id: 'other-contract',
          type: 'UI_TEXT',
          payload: { target: 'otherStatus', expectedText: 'Other ready' },
        },
      ],
      { channel: 'UI_TEXT', target: 'runtimeStatus', expected: 'Declared ready' },
    );
    expect(sameExpected).toMatchObject({ target: 'runtimeStatus', expected: 'Declared ready' });
    expect(sameExpected.contractStepId).toBeUndefined();
    expect(sameExpected.timeoutMs).toBeUndefined();

    const exact = prepare([contract], {
      contractStepId: 'declared-ready',
      channel: 'UI_TEXT',
      target: 'runtimeStatus',
      expected: 'Runtime ready',
    });
    expect(exact).toMatchObject({
      contractStepId: 'declared-ready',
      target: 'declaredReadyStatus',
      expected: 'Declared ready',
      timeoutMs: 7654,
    });
  });

  it('merges wait and assertion evidence only by immutable occurrence identity', () => {
    const waitCase = (runtimeIdentity = {}, authoredIdentity = {}) =>
      standardProfile.prepareCasesForStandardOutput([
        standardCase({
          declaredSteps: [
            {
              id: 'wait-ready',
              op: 'waitFor',
              waitContract: { kind: 'visible', target: 'readyStatus', timeoutMs: 4500 },
            },
          ],
          ir: {
            ...standardCase().ir,
            steps: [
              {
                op: 'waitFor',
                contractStepId: 'wait-ready',
                authored: true,
                occurrenceOrdinal: 1,
                condition: { kind: 'visible', target: 'readyStatus', timeoutMs: 4500 },
                ...authoredIdentity,
              },
              {
                op: 'waitFor',
                contractStepId: 'wait-ready',
                authored: false,
                evidenceOnly: true,
                origin: 'unmatched_runtime_evidence',
                occurrenceOrdinal: 1,
                actual: 'observed-ready',
                liveOutcome: 'matched',
                condition: { kind: 'visible', target: 'readyStatus', timeoutMs: 4500 },
                ...runtimeIdentity,
              },
            ],
          },
        }),
      ])[0].ir.steps.find((step) => step.op === 'waitFor');

    const ordinalOnlyWait = waitCase();
    expect(ordinalOnlyWait.actual).toBeUndefined();
    expect(ordinalOnlyWait.liveOutcome).toBeUndefined();

    const exactWait = waitCase(
      { actionOccurrenceId: 'wait-occurrence-1' },
      { actionOccurrenceId: 'wait-occurrence-1' },
    );
    expect(exactWait).toMatchObject({ actual: 'observed-ready', liveOutcome: 'matched' });

    const assertionCase = (runtimeIdentity = {}, authoredIdentity = {}) =>
      standardProfile.prepareCasesForStandardOutput([
        standardCase({
          declaredAssertionsRaw: [
            {
              id: 'assert-ready',
              type: 'UI_TEXT',
              payload: { target: 'readyStatus', expectedText: 'Ready' },
            },
          ],
          ir: {
            ...standardCase().ir,
            steps: [
              {
                op: 'assert',
                contractStepId: 'assert-ready',
                authored: true,
                occurrenceOrdinal: 2,
                target: 'readyStatus',
                expected: 'Ready',
                ...authoredIdentity,
              },
              {
                op: 'assert',
                contractStepId: 'assert-ready',
                authored: false,
                evidenceOnly: true,
                origin: 'unmatched_runtime_evidence',
                occurrenceOrdinal: 2,
                actual: 'Ready',
                liveOutcome: 'matched',
                ...runtimeIdentity,
              },
            ],
          },
        }),
      ])[0].ir.steps.find((step) => step.op === 'assert');

    const ordinalOnlyAssertion = assertionCase();
    expect(ordinalOnlyAssertion.actual).toBeUndefined();
    expect(ordinalOnlyAssertion.liveOutcome).toBeUndefined();

    const exactAssertion = assertionCase(
      { occurrenceKey: 'assert-occurrence-2' },
      { occurrenceKey: 'assert-occurrence-2' },
    );
    expect(exactAssertion).toMatchObject({ actual: 'Ready', liveOutcome: 'matched' });
  });

  it('tree-shakes support helpers and operation-only locator files', () => {
    const operationOnly = playwrightPomJs.emitJourneySpec(
      [
        standardCase({
          declaredSteps: [
            {
              id: 'open-profile',
              action: 'navigate',
              url: 'https://portal.example.test/profile',
              expectedPageTitle: 'Account Profile',
            },
          ],
          ir: {
            ...standardCase().ir,
            steps: [
              {
                op: 'act',
                action: 'navigate',
                url: 'https://portal.example.test/profile',
                contractStepId: 'open-profile',
                authored: true,
                expectedPageTitle: 'Account Profile',
              },
            ],
          },
        }),
      ],
      { scenarioName: 'Operation-only output', moduleFormat: 'esm' },
    );
    expect(operationOnly.extraFiles['tests/support/replayir.js']).toBeUndefined();
    expect(
      Object.keys(operationOnly.extraFiles).filter((name) => name.startsWith('locators/')),
    ).toEqual([]);

    const environmentValue = playwrightPomJs.emitJourneySpec(
      [
        standardCase({
          ir: {
            ...standardCase().ir,
            steps: [
              {
                op: 'act',
                action: 'fill',
                target: 'Account email',
                targetLabel: 'Account email',
                contractStepId: 'fill-account-email',
                authored: true,
                valueRef: 'env:QAAI_ACCOUNT_EMAIL',
                pageUrl: 'https://portal.example.test/profile',
                expectedPageTitle: 'Account Profile',
                actionLocator: verifiedActionLocator(
                  'page.getByRole("textbox", { name: "Account email", exact: true })',
                  {
                    role: 'textbox',
                    accessibleName: 'Account email',
                    pageUrl: 'https://portal.example.test/profile',
                    editable: true,
                  },
                ),
              },
            ],
          },
        }),
      ],
      { scenarioName: 'Minimal support output', moduleFormat: 'esm' },
    );
    const support = environmentValue.extraFiles['tests/support/replayir.js'];
    expect(support).toContain('function readEnv(name)');
    expect(support).toContain('Missing or blank required environment variable');
    expect(support).not.toMatch(
      /function (?:resolveLocator|safeClick|safeFill|checkAccessibility|evaluateSettled)\b/,
    );
    expect(support).not.toContain('dismissKnownPopups');

    const textAssertion = playwrightPomJs.emitJourneySpec(
      [
        standardCase({
          ir: {
            ...standardCase().ir,
            steps: [
              {
                op: 'assert',
                channel: 'UI_TEXT',
                expected: 'Account profile',
                contractRef: 'account-profile-visible',
                authored: true,
              },
            ],
          },
        }),
      ],
      { scenarioName: 'Text assertion support', moduleFormat: 'esm' },
    );
    expect(textAssertion.extraFiles['tests/support/replayir.js']).toBeUndefined();
    expect(textAssertion.extraFiles['locators/generated/workspacePage.generated.locators.js']).toContain(
      'page.getByText(expected, { exact: true }).first()',
    );
  });

  it('emits no dead page imports, telemetry, or internal identifiers', () => {
    const output = playwrightPomJs.emitJourneySpec(
      [
        standardCase({
          declaredSteps: [
            {
              id: 'open-dashboard',
              action: 'navigate',
              url: 'https://operations.example.test/dashboard',
              expectedPageTitle: 'Operations Dashboard',
            },
          ],
          ir: {
            ...standardCase().ir,
            steps: [
              {
                op: 'act',
                action: 'navigate',
                url: 'https://operations.example.test/dashboard',
                contractStepId: 'open-dashboard',
                authored: true,
                expectedPageTitle: 'Operations Dashboard',
              },
            ],
          },
        }),
      ],
      { scenarioName: 'Clean output', moduleFormat: 'esm' },
    );
    const imports = [
      ...output.content.matchAll(/import \{ (\w+) \} from '[^']*\/pages\/(\w+)\.js';/g),
    ];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, className] of imports) {
      const variableName = className.charAt(0).toLowerCase() + className.slice(1);
      expect(output.content).toContain(`const ${variableName} = new ${className}(page);`);
      expect(occurrences(output.content, `${variableName}.`)).toBeGreaterThan(0);
    }
    expect(emittedSources(output)).not.toMatch(
      /test\.info\(\)\.annotations|qaai-runtime-evidence|qaai-observed-/i,
    );
    expect(output.content).not.toMatch(/\b(?:case_step|runtime-attempt|kernel-|el\d+)\b/i);
    expect(output.content).not.toMatch(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    );
  });

  it('removes standard-output telemetry and private deterministic identities without removing executable checks', () => {
    const privateId = 'cc9fdfde-5d03-4b7d-94e6-07f16557c460';
    const source = `// STATUS: DRAFT — internal package state
test("Create customer account", async ({ page }) => {
  const email = generateDeterministicValue({"name":"customer email","prefix":"qa-","length":8,"caseId":"${privateId}","stepId":"runtime-attempt-${privateId}"});
  test.info().annotations.push({ type: 'qaai-runtime-evidence', description: "${privateId}:step:2" });
  expect.soft(false, "Captured visual check could not be reproduced; continuing independent steps.").toBe(true);
  await customerPage.saveCustomer();
});`;

    const cleaned = standardProfile._sanitizeStandardUserSource(source);
    expect(cleaned).not.toMatch(/STATUS: DRAFT|test\.info\(\)\.annotations|qaai-runtime-evidence/i);
    expect(cleaned).not.toContain(privateId);
    expect(cleaned).not.toMatch(/"(?:caseId|stepId|runtimeActionId|actionEvidenceId)"\s*:/);
    expect(cleaned).toContain('"scope":"Create customer account / customer email"');
    expect(cleaned).toContain(
      'expect.soft(false, "Captured visual check could not be reproduced; continuing independent steps.").toBe(true);',
    );
    expect(cleaned).toContain('await customerPage.saveCustomer();');
  });
});
