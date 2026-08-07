import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  ODYSSEY_REGRESSION_URLS,
  odysseyRegressionCase,
} from '../fixtures/playwrightPomJsOdysseyRegression.fixture.js';
import { verifiedActionLocator } from '../fixtures/playwrightPomJsPrecisionAcceptance.fixture.js';

const require = createRequire(import.meta.url);
const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom.js');
const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs.js');

function emitOdysseyRegression() {
  return playwrightPomJs.emitJourneySpec([odysseyRegressionCase()], {
    scenarioName: 'Email classifier Microsoft sign-in to dashboard',
    scenarioId: 'email-classifier-microsoft-sign-in',
    moduleFormat: 'esm',
  });
}

function occurrences(source, needle) {
  return String(source).split(needle).length - 1;
}

function generatedSources(emitted, pattern) {
  return Object.entries(emitted.extraFiles)
    .filter(([name]) => pattern.test(name))
    .map(([, source]) => source)
    .join('\n');
}

function executableJavascriptFiles(emitted) {
  return Object.entries({
    'tests/authentication/odyssey-regression.spec.js': emitted.content,
    ...emitted.extraFiles,
  }).filter(
    ([name, source]) =>
      /\.js$/.test(name) && !name.startsWith('evidence/') && typeof source === 'string',
  );
}

function invocationFor(emitted, target, action) {
  const manifest = JSON.parse(emitted.extraFiles['evidence/locator-manifest.json']);
  const locator = manifest.find((entry) => entry.as === target);
  expect(locator, `missing locator-manifest entry for ${target}`).toBeTruthy();
  return `.${playwrightPom._methodNameFor(action, locator.name)}(`;
}

function accessorFor(emitted, target) {
  const manifest = JSON.parse(emitted.extraFiles['evidence/locator-manifest.json']);
  const locator = manifest.find((entry) => entry.as === target);
  expect(locator, `missing locator-manifest entry for ${target}`).toBeTruthy();
  return `${locator.file}.${locator.name}()`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectNoEmptyRequiredAssertionCalls(emitted) {
  const pageSources = generatedSources(emitted, /^pages\/.*Page\.js$/);
  const emptyCalls = [
    ...emitted.content.matchAll(/\.([A-Za-z_$][A-Za-z0-9_$]*)\(\)/g),
  ].map((match) => match[1]).filter((name) => /^assert/.test(name));
  for (const methodName of emptyCalls) {
    const declaration = new RegExp(
      `async\\s+${escapeRegex(methodName)}\\(([^)]*)\\)`,
    ).exec(pageSources);
    expect(declaration, `missing page method declaration for ${methodName}`).toBeTruthy();
    expect(declaration[1].trim(), `${methodName} cannot require a missing argument`).toBe('');
  }
}

describe('sanitized Odyssey Playwright POM JavaScript regression', () => {
  it('normalizes every declared action and assertion exactly once', () => {
    const sourceCase = odysseyRegressionCase();
    const declaredActions = sourceCase.declaredSteps.filter((step) => step.action);
    expect(sourceCase.declaredSteps).toHaveLength(11);
    expect(declaredActions).toHaveLength(9);
    expect(sourceCase.declaredAssertionsRaw).toHaveLength(2);

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const actions = prepared.ir.steps.filter(
      (step) => step.op === 'act' && step.authored !== false,
    );
    const assertions = prepared.ir.steps.filter(
      (step) => step.op === 'assert' && step.authored !== false,
    );

    expect(actions).toHaveLength(declaredActions.length);
    expect(actions.map((step) => step.contractStepId)).toEqual(
      declaredActions.map((step) => step.contractStepId),
    );
    expect(assertions).toHaveLength(sourceCase.declaredAssertionsRaw.length);
    expect(assertions.map((step) => step.contractRef || step.contractStepId)).toEqual(
      sourceCase.declaredAssertionsRaw.map((assertion) => assertion.id),
    );
    expect(assertions.every((step) => step.flowCritical === true)).toBe(true);
    expect(
      prepared.ir.steps
        .filter((step) => step.op === 'act' || step.op === 'assert')
        .map((step) => step.contractRef || step.contractStepId),
    ).toEqual([
      'open-email-classifier',
      'enter-email-address',
      'continue-to-sign-in-options',
      'microsoft-option-visible',
      'choose-microsoft-sign-in',
      'enter-microsoft-account',
      'advance-to-password',
      'enter-microsoft-password',
      'submit-microsoft-sign-in',
      'dismiss-stay-signed-in',
      'verify-dashboard',
    ]);
  });

  it('emits the complete authored flow exactly once and in order with no invented direct actions', () => {
    const emitted = emitOdysseyRegression();
    const spec = emitted.content;
    const navigationCall = 'await emailClassifierPage.openEmailClassifier()';
    const expectedCalls = [
      ['emailAddressInput', 'fill'],
      ['continueButton', 'click'],
      ['signInWithMicrosoftButton', 'click'],
      ['microsoftAccountInput', 'fill'],
      ['nextButton', 'click'],
      ['microsoftPasswordInput', 'fill'],
      ['signInButton', 'click'],
      ['declineStaySignedInButton', 'click'],
    ].map(([target, action]) => invocationFor(emitted, target, action));

    expect(occurrences(spec, navigationCall)).toBe(1);
    let previous = spec.indexOf(navigationCall);
    expect(previous).toBeGreaterThanOrEqual(0);
    for (const call of expectedCalls) {
      expect(occurrences(spec, call), `${call} must occur exactly once`).toBe(1);
      const current = spec.indexOf(call);
      expect(current, `${call} must preserve authored order`).toBeGreaterThan(previous);
      previous = current;
    }

    expect(occurrences(spec, invocationFor(emitted, 'continueButton', 'click'))).toBe(1);
    expect(occurrences(spec, invocationFor(emitted, 'signInWithMicrosoftButton', 'click'))).toBe(1);
    const pageSources = generatedSources(emitted, /^pages\/.*Page\.js$/);
    const authoredNavigation = new URL(ODYSSEY_REGRESSION_URLS.emailClassifier);
    const authoredPath = `${authoredNavigation.pathname}${authoredNavigation.search}${authoredNavigation.hash}`;
    expect(occurrences(pageSources, authoredPath)).toBe(1);
    expect(pageSources).not.toMatch(/\.goto\(["']{2}\)/);
    expect(spec).not.toMatch(
      /\bpage\.(?:goto|click|fill|press|check|uncheck|selectOption|hover|dblclick|dragTo)\s*\(/,
    );
    const centralizedStepLines = spec.match(/^\s*await\s+[a-z]\w*Page\.[a-z]\w*\(/gim) || [];
    expect(centralizedStepLines).toHaveLength(11);
    expect(spec).toContain('Welcome OdysseyOne');
    expect(pageSources).toContain("waitFor({ state: 'visible', timeout: 2000 })");
    expect(pageSources).not.toContain('.isVisible({ timeout: 2000 })');
  });

  it('normalizes authored optional-action phrases into one conditional POM action', () => {
    for (const phraseShape of [
      { action: 'Dismiss if visible' },
      { action: 'click', operation: 'Dismiss when present' },
    ]) {
      const sourceCase = odysseyRegressionCase();
      const declared = sourceCase.declaredSteps.find(
        (step) => step.contractStepId === 'dismiss-stay-signed-in',
      );
      const runtime = sourceCase.ir.steps.find(
        (step) => step.op === 'act' && step.contractStepId === 'dismiss-stay-signed-in',
      );
      Object.assign(declared, phraseShape);
      for (const step of [declared, runtime]) {
        delete step.optional;
        delete step.optionalAbsent;
        delete step.ifPresent;
        delete step.ifVisible;
      }

      const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
      const optionalAction = prepared.ir.steps.find(
        (step) => step.op === 'act' && step.contractStepId === 'dismiss-stay-signed-in',
      );
      expect(optionalAction).toMatchObject({ action: 'click', optional: true });
    }

    const sourceCase = odysseyRegressionCase();
    const declared = sourceCase.declaredSteps.find(
      (step) => step.contractStepId === 'dismiss-stay-signed-in',
    );
    const runtime = sourceCase.ir.steps.find(
      (step) => step.op === 'act' && step.contractStepId === 'dismiss-stay-signed-in',
    );
    declared.action = 'Dismiss if visible';
    for (const step of [declared, runtime]) {
      delete step.optional;
      delete step.optionalAbsent;
      delete step.ifPresent;
      delete step.ifVisible;
    }

    const emitted = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Optional action phrase regression',
      scenarioId: 'optional-action-phrase-regression',
      moduleFormat: 'esm',
    });
    const optionalCall = invocationFor(emitted, 'declineStaySignedInButton', 'click');
    const pageSources = generatedSources(emitted, /^pages\/.*Page\.js$/);
    expect(pageSources).toContain("waitFor({ state: 'visible', timeout: 2000 })");
    expect(pageSources).toContain('if (appeared) { await optionalTarget.click(options); }');
    expect(pageSources).not.toContain('.isVisible({ timeout: 2000 })');
    expect(occurrences(emitted.content, optionalCall)).toBe(1);
  });

  it('round-trips assertion and optional-action method contracts through package graph merging', () => {
    const emitted = emitOdysseyRegression();
    const mergedGraph = playwrightPom._mergePomGraphs([emitted.pomGraph], {
      lang: 'js',
      moduleFormat: 'esm',
    });
    const files = playwrightPom._emitPomGraphFiles(mergedGraph);
    const pageSources = Object.entries(files)
      .filter(([filePath]) => /^pages\/.*Page\.js$/.test(filePath))
      .map(([, source]) => source)
      .join('\n');

    expect(mergedGraph).toMatchObject({
      adapterId: 'playwright-pom-js',
      standardOutputProfile: 'playwright-pom-js-v1',
    });
    expect(pageSources).toContain("waitFor({ state: 'visible', timeout: 2000 })");
    expect(pageSources).toContain('if (appeared) { await optionalTarget.click(options); }');
    expect(pageSources).toMatch(
      /async assertSignInWithMicrosoft[A-Za-z0-9_$]*\(\)\s*\{[\s\S]*?expect(?:\.soft)?\(this\.signInWithMicrosoftButton\(\)\)/,
    );
    expect(pageSources).toMatch(/async assertWelcomeOdysseyone[A-Za-z0-9_$]*\(/i);
    expect(`${emitted.content}\n${pageSources}`).toContain('Welcome OdysseyOne!');
    expectNoEmptyRequiredAssertionCalls({ content: emitted.content, extraFiles: files });
    expect(pageSources).not.toMatch(/â|Â|�/);
    expect(pageSources).not.toMatch(/[^\x00-\x7f]/);
    expect(files['evidence/certification-report.json']).toBeUndefined();
  });

  it('uses only exact action-time locators with same-node provenance on domain page objects', () => {
    const emitted = emitOdysseyRegression();
    const locatorSources = generatedSources(emitted, /^locators\/generated\/.*\.locators\.js$/);
    const manifest = JSON.parse(emitted.extraFiles['evidence/locator-manifest.json']);
    const pageKeys = Object.keys(emitted.pomGraph.pages).sort();

    expect(pageKeys).toEqual(['dashboardPage', 'emailClassifierPage', 'microsoftSignInPage']);
    expect(pageKeys).not.toContain('applicationPage');

    for (const exact of [
      'page.getByRole("textbox", { name: "Email Address", exact: true })',
      'page.getByRole("button", { name: "Continue", exact: true })',
      'page.getByRole("button", { name: "Sign in with Microsoft", exact: true })',
      'page.getByRole("textbox", { name: "Enter your email phone or Skype.", exact: true })',
      'page.getByRole("button", { name: "Next", exact: true })',
      'page.locator("input[type=\\"password\\"]")',
      'page.getByRole("button", { name: "Sign in", exact: true })',
      'page.getByRole("button", { name: "No", exact: true })',
      'page.getByRole("heading", { name: "Welcome OdysseyOne!", exact: true })',
    ]) {
      expect(locatorSources).toContain(exact);
    }

    const verified = manifest.filter((entry) => entry.source === 'actionLocator');
    expect(verified).toHaveLength(9);
    expect(verified.every((entry) => entry.verified === true)).toBe(true);
    expect(verified.every((entry) => entry.verificationSource === 'verified_dom_inspection')).toBe(
      true,
    );
    for (const entry of verified) {
      expect(entry.proof).toMatchObject({
        verified: true,
        count: 1,
        sameElement: true,
        actionTimeResolved: true,
        actedNodeBound: true,
        identityVerified: true,
        resolutionMode: 'bound_mcp_ref',
      });
      expect(entry.proof.expectedBackendNodeId).toBe(entry.proof.resolvedBackendNodeId);
      expect(entry.proof.targetIdentity).toEqual(entry.proof.matchedIdentity);
      expect(entry.proof.targetIdentity).toMatchObject({ connected: true });
    }

    const guessed = manifest.filter((entry) => entry.source === 'qaaiGuessedLocator');
    expect(guessed).toHaveLength(0);
    expect(occurrences(locatorSources, 'QAAI_GUESSED_LOCATOR')).toBe(0);
    expect(occurrences(locatorSources, 'QAAI_UNVERIFIED_LOCATOR')).toBe(0);
  });

  it('emits both hard assertions exactly once and in authored order', () => {
    const emitted = emitOdysseyRegression();
    const spec = emitted.content;
    const pageSources = generatedSources(emitted, /^pages\/.*Page\.js$/);
    const assertionCalls = spec.match(/await\s+[a-z]\w*Page\.(assert[A-Za-z0-9_$]+)\(/g) || [];
    expect(assertionCalls).toHaveLength(2);
    expect(new Set(assertionCalls).size).toBe(2);
    expect(pageSources.match(/async\s+assert[A-Za-z0-9_$]+\(/g) || []).toHaveLength(2);
    expect(pageSources).toContain('toBeVisible({ timeout: 10000 })');
    expect(pageSources).toContain('toContainText(String(expected), { timeout: 10000 })');
    expect(spec).not.toContain('await expect(');
    expect(spec).toMatch(
      /await\s+[a-z]\w*Page\.assert[A-Za-z0-9_$]+\("Welcome OdysseyOne!"\)/,
    );
    expectNoEmptyRequiredAssertionCalls(emitted);

    const continueAction = spec.indexOf(invocationFor(emitted, 'continueButton', 'click'));
    const optionAssertion = spec.indexOf(assertionCalls[0]);
    const chooseMicrosoft = spec.indexOf(
      invocationFor(emitted, 'signInWithMicrosoftButton', 'click'),
    );
    const dismissOptional = spec.indexOf(
      invocationFor(emitted, 'declineStaySignedInButton', 'click'),
    );
    const dashboardAssertion = spec.indexOf(assertionCalls[1]);
    expect(continueAction).toBeLessThan(optionAssertion);
    expect(optionAssertion).toBeLessThan(chooseMicrosoft);
    expect(dismissOptional).toBeLessThan(dashboardAssertion);
  });

  it('hydrates assertion arguments from nested expectedSignals before final POM emission', () => {
    const sourceCase = odysseyRegressionCase();
    for (const contract of sourceCase.declaredAssertionsRaw) {
      const expectedText = contract.payload.expectedText;
      delete contract.payload.expectedText;
      contract.payload.expectedSignals = { text: [expectedText] };
      if (contract.id === 'microsoft-option-visible') {
        contract.type = 'UI_TEXT';
        delete contract.payload.target;
      }
    }
    for (const step of sourceCase.ir.steps.filter((candidate) => candidate.op === 'assert')) {
      const expectedText = step.expected;
      delete step.expected;
      step.expectedSignals = { text: [expectedText] };
      if (step.contractStepId === 'microsoft-option-visible') {
        step.channel = 'UI_TEXT';
        step.target = null;
      }
    }

    const emitted = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Nested expected signal regression',
      moduleFormat: 'esm',
    });
    expect(emitted.content).toMatch(
      /await\s+[a-z]\w*Page\.assert[A-Za-z0-9_$]+\("Sign in with Microsoft"\)/,
    );
    expect(emitted.content).toMatch(
      /await\s+[a-z]\w*Page\.assert[A-Za-z0-9_$]+\("Welcome OdysseyOne!"\)/,
    );
    expectNoEmptyRequiredAssertionCalls(emitted);
  });

  it('derives distinct page ownership from nested captured page identities without direct pageUrl fields', () => {
    const sourceCase = odysseyRegressionCase();
    for (const step of sourceCase.ir.steps) {
      if (step.op !== 'resolve' || !step.actionLocator) continue;
      const capturedUrl = step.pageUrl;
      const capturedIdentityUrl = capturedUrl === ODYSSEY_REGRESSION_URLS.identity
        ? 'https://identity.provider-one.com/authorize'
        : capturedUrl;
      delete step.pageUrl;
      delete step.authoredPageName;
      delete step.actionLocator.pageUrl;
      step.actionLocator.context = {
        ...(step.actionLocator.context || {}),
        pageIdentity: { url: capturedIdentityUrl },
      };
    }

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const preparedResolves = prepared.ir.steps.filter((step) => step.op === 'resolve');
    expect(preparedResolves.every((step) => /^https:\/\//.test(String(step.pageUrl || '')))).toBe(
      true,
    );

    const emitted = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Nested page identity regression',
      moduleFormat: 'esm',
    });
    const pageKeys = Object.keys(emitted.pomGraph.pages);
    expect(pageKeys.length).toBeGreaterThanOrEqual(3);
    expect(pageKeys.some((key) => /emailClassifierPage/i.test(key))).toBe(true);
    expect(pageKeys.some((key) => /providerOnePage/i.test(key))).toBe(true);
  });

  it('rebinds narrative assertions to verified controls or concrete quoted page signals', () => {
    const sourceCase = odysseyRegressionCase();
    const optionContract = sourceCase.declaredAssertionsRaw.find(
      (assertion) => assertion.id === 'microsoft-option-visible',
    );
    Object.assign(optionContract, {
      type: 'PAGE',
      payload: {
        target: 'Sign in with Microsoft option',
        expectedText: 'Sign in with Microsoft option is displayed',
        flowCritical: true,
      },
    });
    const optionAssertion = sourceCase.ir.steps.find(
      (step) => step.op === 'assert' && step.contractStepId === 'microsoft-option-visible',
    );
    Object.assign(optionAssertion, {
      channel: 'PAGE',
      target: 'Sign in with Microsoft option',
      expected: 'Sign in with Microsoft option is displayed',
    });

    const dashboardContract = sourceCase.declaredAssertionsRaw.find(
      (assertion) => assertion.id === 'verify-dashboard',
    );
    Object.assign(dashboardContract, {
      type: 'VISIBLE',
      payload: {
        target: 'Home dashboard',
        expectedText: 'Home dashboard displayed with "Welcome OdysseyOne!" visible',
        flowCritical: true,
      },
    });
    const dashboardAssertion = sourceCase.ir.steps.find(
      (step) => step.op === 'assert' && step.contractStepId === 'verify-dashboard',
    );
    Object.assign(dashboardAssertion, {
      channel: 'VISIBLE',
      target: 'Home dashboard',
      expected: 'Home dashboard displayed with "Welcome OdysseyOne!" visible',
    });

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const preparedOption = prepared.ir.steps.find(
      (step) => step.op === 'assert' && step.contractStepId === 'microsoft-option-visible',
    );
    const preparedDashboard = prepared.ir.steps.find(
      (step) => step.op === 'assert' && step.contractStepId === 'verify-dashboard',
    );
    expect(preparedOption).toMatchObject({
      target: 'signInWithMicrosoftButton',
      channel: 'VISIBLE',
    });
    expect(preparedDashboard).toMatchObject({
      target: null,
      channel: 'PAGE',
      expectedSignals: { text: ['Welcome OdysseyOne!'] },
    });

    const emitted = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Narrative assertion recovery',
      moduleFormat: 'esm',
    });
    const locatorSources = generatedSources(emitted, /^locators\/generated\/.*\.locators\.js$/);
    const pageSources = generatedSources(emitted, /^pages\/.*Page\.js$/);
    expect(emitted.content).toMatch(/await\s+[a-z]\w*Page\.assert[A-Za-z0-9_$]+\(\)/);
    expect(locatorSources).toContain('page.getByText("Welcome OdysseyOne!", { exact: false })');
    expect(pageSources).not.toContain('this.page.getByText("Welcome OdysseyOne!", { exact: false })');
    expect(locatorSources).not.toMatch(/Home dashboard|Sign in with Microsoft option/);
    expect(locatorSources).not.toMatch(/QAAI_(?:GUESSED|UNVERIFIED)_LOCATOR/);
  });

  it('rebinds narrative page readiness to the first verified destination control', () => {
    const sourceCase = odysseyRegressionCase();
    sourceCase.ir.steps.push(
      {
        op: 'resolve',
        as: 'emailClassifierPageTarget',
        contractStepId: 'runtime:step:1:readiness',
        elementLabel: 'Email classifier page',
        candidates: [{ strategy: 'label', text: 'Email classifier page' }],
        guessedLocator: true,
        locatorConfidence: 'guessed',
        authored: true,
        origin: 'authored',
      },
      {
        op: 'waitFor',
        contractStepId: 'runtime:step:1:readiness',
        condition: { kind: 'visible', target: 'emailClassifierPageTarget', timeoutMs: 10000 },
        authored: true,
        origin: 'authored',
      },
    );

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const readiness = prepared.ir.steps.find(
      (step) => step.op === 'waitFor' && step.contractStepId === 'runtime:step:1:readiness',
    );
    expect(readiness.condition.target).toBe('emailAddressInput');
    expect(prepared.ir.steps.some((step) => step.as === 'emailClassifierPageTarget')).toBe(false);
    const navigationIndex = prepared.ir.steps.findIndex(
      (step) => step.op === 'act' && step.action === 'navigate',
    );
    const readinessIndex = prepared.ir.steps.indexOf(readiness);
    const firstFillIndex = prepared.ir.steps.findIndex(
      (step) => step.op === 'act' && step.action === 'fill',
    );
    expect(navigationIndex).toBeGreaterThanOrEqual(0);
    expect(readinessIndex).toBeGreaterThan(navigationIndex);
    expect(firstFillIndex).toBeGreaterThan(readinessIndex);

    const emitted = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Narrative readiness recovery',
      moduleFormat: 'esm',
    });
    const locatorSources = generatedSources(emitted, /^locators\/generated\/.*\.locators\.js$/);
    expect(locatorSources).not.toContain('Email classifier page');
    expect(locatorSources).not.toMatch(/QAAI_(?:GUESSED|UNVERIFIED)_LOCATOR/);
    const openIndex = emitted.content.indexOf('await emailClassifierPage.openEmailClassifier()');
    const waitIndex = emitted.content.indexOf(
      `await ${accessorFor(emitted, 'emailAddressInput')}.waitFor(`,
    );
    const fillIndex = emitted.content.indexOf(invocationFor(emitted, 'emailAddressInput', 'fill'));
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(openIndex);
    expect(fillIndex).toBeGreaterThan(waitIndex);
    expect(generatedSources(emitted, /^pages\/.*\.js$/)).toContain(
      'this.page.goto("https://portal.example.test/auth/email-classifier", { waitUntil: "domcontentloaded" })',
    );
  });

  it('orders verified runtime readiness after its authored navigation and before the first action', () => {
    const sourceCase = odysseyRegressionCase();
    sourceCase.ir.steps.unshift({
      op: 'waitFor',
      contractStepId: 'runtime:step:1:readiness-order',
      sequenceIndex: 1,
      occurrenceOrdinal: 1,
      condition: { kind: 'visible', target: 'emailAddressInput', timeoutMs: 20000 },
      authored: true,
      origin: 'authored',
    });

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const navigationIndex = prepared.ir.steps.findIndex(
      (step) => step.op === 'act' && step.action === 'navigate',
    );
    const readinessIndex = prepared.ir.steps.findIndex(
      (step) => step.op === 'waitFor' && step.contractStepId === 'runtime:step:1:readiness-order',
    );
    const firstFillIndex = prepared.ir.steps.findIndex(
      (step) => step.op === 'act' && step.action === 'fill',
    );
    expect(readinessIndex).toBeGreaterThan(navigationIndex);
    expect(firstFillIndex).toBeGreaterThan(readinessIndex);

    const emitted = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Verified readiness order recovery',
      moduleFormat: 'esm',
    });
    const openIndex = emitted.content.indexOf('await emailClassifierPage.openEmailClassifier()');
    const waitIndex = emitted.content.indexOf(
      `await ${accessorFor(emitted, 'emailAddressInput')}.waitFor(`,
    );
    const fillIndex = emitted.content.indexOf(invocationFor(emitted, 'emailAddressInput', 'fill'));
    expect(waitIndex).toBeGreaterThan(openIndex);
    expect(fillIndex).toBeGreaterThan(waitIndex);
  });

  it('keeps only declared Verify occurrences when runtime assertion fragments claim authored status', () => {
    const declaredSteps = [
      {
        id: 'case_step_4',
        contractStepId: 'case_step_4',
        action: 'Verify',
        target: 'Provider option',
        expected: 'Provider option is visible',
      },
      {
        id: 'case_step_11',
        contractStepId: 'case_step_11',
        action: 'Validate',
        target: 'Dashboard',
        expected: 'Dashboard is visible',
      },
    ];
    const runtimeAssertions = [
      { id: 'case_step_4', target: 'runtimeProvider', expected: 'Provider option is visible' },
      { id: 'case_step_11', target: 'runtimeDashboard', expected: 'Dashboard is visible' },
    ].flatMap(({ id, target, expected }) => [
      {
        op: 'resolve',
        as: target,
        contractStepId: id,
        elementLabel: target,
        candidates: [{ strategy: 'label', text: target }],
        guessedLocator: true,
        authored: true,
        origin: 'runtime_evidence',
        canonicalExecution: true,
      },
      {
        op: 'assert',
        contractStepId: id,
        contractRef: id,
        assertionId: id,
        target,
        channel: 'UI_TEXT',
        authored: true,
        origin: 'runtime_evidence',
        canonicalExecution: true,
        status: 'passed',
        checked: true,
        matched: true,
        expected,
        actual: expected,
      },
    ]).concat(Array.from({ length: 6 }, (_, index) => ({
      op: 'assert',
      contractStepId: `case:assertion:${index + 1}`,
      target: `runtimeFragment${index + 1}`,
      channel: 'UI_TEXT',
      authored: false,
      evidenceOnly: true,
      diagnosticOnly: true,
      executable: false,
      origin: 'unbound_runtime_evidence',
    })));
    const prepared = playwrightPomJs._prepareCasesForStandardOutput([{
      testCaseId: 'assertion-provenance-case',
      caseName: 'Assertion provenance',
      declaredSteps,
      ir: {
        caseId: 'assertion-provenance-case',
        steps: runtimeAssertions,
      },
    }])[0];

    const runnableAssertions = prepared.ir.steps.filter((step) => step.op === 'assert');
    expect(runnableAssertions.map((step) => step.contractStepId)).toEqual([
      'case_step_4',
      'case_step_11',
    ]);
    expect(prepared.ir.steps.some((step) => /^runtime(?:Provider|Dashboard|Fragment)/.test(
      String(step.as || step.target || ''),
    ))).toBe(false);
  });

  it('promotes Verify and Validate action-shaped records into assertions before click generation', () => {
    const sourceCase = odysseyRegressionCase();
    for (const declared of sourceCase.declaredSteps) {
      if (declared.kind !== 'assertion') continue;
      delete declared.kind;
      declared.action = 'Verify';
    }
    for (const step of sourceCase.ir.steps) {
      if (step.op !== 'assert') continue;
      step.op = 'act';
      step.action = 'Verify';
      step.checked = true;
      step.matched = true;
      step.outcome = 'matched';
      step.assertionEvidenceId = `assertion-evidence-${step.contractStepId || step.contractRef}`;
    }
    sourceCase.declaredSteps.push({
      id: 'validate-account-ready',
      contractStepId: 'validate-account-ready',
      action: 'Validate',
      target: 'Declared assertion',
      description: 'Validate that the account is ready.',
    });
    sourceCase.declaredAssertionsRaw.push({
      id: 'validate-account-ready',
      type: 'UI_TEXT',
      payload: {
        expectedText: 'Account ready',
        description: 'Validate that the account is ready.',
        flowCritical: true,
      },
    });
    sourceCase.ir.steps.push({
      op: 'act',
      action: 'Validate',
      authoredOperation: 'Validate',
      contractStepId: 'validate-account-ready',
      contractRef: 'validate-account-ready',
      assertionId: 'validate-account-ready',
      target: 'accountReadyStatus',
      elementLabel: 'Account ready',
      authored: true,
      origin: 'runtime_evidence',
      canonicalExecution: true,
      status: 'passed',
      checked: true,
      matched: true,
      expected: 'Account ready',
      actual: 'Account ready',
    });

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const preparedAssertions = prepared.ir.steps.filter(
      (step) => step.op === 'assert' && step.authored !== false,
    );
    expect(preparedAssertions).toHaveLength(3);
    expect(prepared.ir.steps.some((step) => step.op === 'act' && /verify|validate/i.test(
      String(step.action || step.authoredOperation || ''),
    ))).toBe(false);

    const emitted = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Assertion operation regression',
      scenarioId: 'assertion-operation-regression',
      moduleFormat: 'esm',
    });
    const userSources = executableJavascriptFiles(emitted).map(([, source]) => source).join('\n');
    const pageSources = generatedSources(emitted, /^pages\/.*Page\.js$/);
    expect(pageSources).toContain('await expect(');
    expect(emitted.content).toContain('Account ready');
    expect(userSources).not.toMatch(/click(?:Verify|Validate|DeclaredAssertion)/i);
    expect(userSources).not.toContain('Declared assertion');
    expect(userSources).not.toContain('expect.soft(false');
    expect(userSources).not.toContain('QAAI_ASSERTION_CONTRACT_UNRESOLVED');
  });

  it('appends semantic locator role suffixes exactly once', () => {
    const prepared = playwrightPomJs._prepareCasesForStandardOutput([{
      testCaseId: 'semantic-role-suffix-case',
      caseName: 'Semantic role suffix regression',
      declaredSteps: [
        { id: 'click-continue', action: 'click', target: 'Continue button' },
        { id: 'fill-account', action: 'fill', target: 'Account textbox' },
        { id: 'check-alerts', action: 'check', target: 'Receive alerts checkbox' },
        { id: 'select-region', action: 'selectOption', target: 'Region combobox' },
      ],
      ir: {
        caseId: 'semantic-role-suffix-case',
        steps: [
          {
            op: 'act', action: 'click', contractStepId: 'click-continue',
            elementLabel: 'Continue button', authored: true,
            origin: 'runtime_evidence', canonicalExecution: true, status: 'passed',
            actionLocator: verifiedActionLocator(
              'page.getByRole("button", { name: "Continue", exact: true })',
              { role: 'button', accessibleName: 'Continue' },
            ),
          },
          {
            op: 'act', action: 'fill', contractStepId: 'fill-account',
            elementLabel: 'Account textbox', value: 'Account 1',
            authored: true, origin: 'runtime_evidence', canonicalExecution: true, status: 'passed',
            actionLocator: verifiedActionLocator(
              'page.getByRole("textbox", { name: "Account", exact: true })',
              { role: 'textbox', accessibleName: 'Account', editable: true },
            ),
          },
          {
            op: 'act', action: 'check', contractStepId: 'check-alerts',
            elementLabel: 'Receive alerts checkbox',
            authored: true, origin: 'runtime_evidence', canonicalExecution: true, status: 'passed',
            actionLocator: verifiedActionLocator(
              'page.getByRole("checkbox", { name: "Receive alerts", exact: true })',
              { role: 'checkbox', accessibleName: 'Receive alerts' },
            ),
          },
          {
            op: 'act', action: 'selectOption', contractStepId: 'select-region',
            elementLabel: 'Region combobox', value: 'us-east',
            authored: true, origin: 'runtime_evidence', canonicalExecution: true, status: 'passed',
            actionLocator: verifiedActionLocator(
              'page.getByRole("combobox", { name: "Region", exact: true })',
              { role: 'combobox', accessibleName: 'Region' },
            ),
          },
        ],
      },
    }])[0];

    const aliases = prepared.ir.steps
      .filter((step) => step.op === 'resolve')
      .map((step) => step.as);
    expect(aliases).toEqual(expect.arrayContaining([
      'continueButton',
      'accountTextbox',
      'receiveAlertsCheckbox',
      'regionCombobox',
    ]));
    expect(aliases.every((alias) => !/(button|textbox|checkbox|combobox)\1$/i.test(alias))).toBe(true);
  });

  it('uses fail-fast environment credentials and keeps every executable JavaScript file clean', () => {
    const emitted = emitOdysseyRegression();
    const executableFiles = executableJavascriptFiles(emitted);
    const userSources = executableFiles.map(([, source]) => source).join('\n');
    const support = emitted.extraFiles['tests/support/replayir.js'];

    expect(emitted.content).toContain("import { test } from '@playwright/test'");
    expect(emitted.content).not.toContain("import { test, expect } from '@playwright/test'");
    expect(generatedSources(emitted, /^pages\/.*Page\.js$/)).toContain(
      "import { expect } from '@playwright/test'",
    );
    expect(emitted.content).toContain('readEnv("QAAI_USERNAME")');
    expect(emitted.content).toContain('readEnv("QAAI_PASSWORD")');
    expect(occurrences(emitted.content, 'readEnv("QAAI_USERNAME")')).toBe(2);
    expect(occurrences(emitted.content, 'readEnv("QAAI_PASSWORD")')).toBe(1);
    expect(support).toContain("value == null || String(value).trim() === ''");
    const readEnvSource = support.match(/function readEnv\(name\) \{[\s\S]*?\n\}/)?.[0];
    expect(readEnvSource).toBeTruthy();
    const username = 'odyssey.runner@example.test';
    const password = 'Odyssey-Secret-42!';
    const readEnv = new Function('process', `${readEnvSource}; return readEnv;`)({
      env: { QAAI_USERNAME: username, QAAI_PASSWORD: password, EMPTY: '', BLANK: '   \t' },
    });
    expect(readEnv('QAAI_USERNAME')).toBe(username);
    expect(readEnv('QAAI_PASSWORD')).toBe(password);
    expect(() => readEnv('MISSING')).toThrow(
      /Missing or blank required environment variable MISSING/,
    );
    expect(() => readEnv('EMPTY')).toThrow(/Missing or blank required environment variable EMPTY/);
    expect(() => readEnv('BLANK')).toThrow(/Missing or blank required environment variable BLANK/);
    expect(userSources).not.toContain(username);
    expect(userSources).not.toContain(password);

    expect(userSources).not.toContain('test.info().annotations');
    expect(userSources).not.toContain('.catch(() => {})');
    expect(userSources).not.toMatch(
      /qaai-runtime-evidence|qaai-observed-navigation|qaai-observed-popup/i,
    );
    expect(userSources).not.toMatch(/\b(?:case_step|runtime-attempt|kernel-|el\d+)\b/i);
    expect(userSources).not.toMatch(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    );
    expect(userSources).not.toMatch(/\b[0-9a-f]{32,}\b/i);
    expect(userSources).not.toMatch(/QAAI_(?:GUESSED|UNVERIFIED)_LOCATOR/);
    const generatedText = [
      emitted.content,
      ...Object.entries(emitted.extraFiles)
        .filter(([filePath]) => /\.(?:cjs|mjs|js|ts|md)$/i.test(filePath))
        .map(([, source]) => source),
    ].join('\n');
    expect(generatedText).not.toMatch(/[\u2500-\u257f]/);
    expect(generatedText).not.toMatch(/\u00e2[^\x00-\x7f]{2}|\u00c2(?=[^\x00-\x7f])/);
    expect(userSources).not.toMatch(/[âÂ]/);
    const manifest = JSON.parse(emitted.extraFiles['evidence/locator-manifest.json']);
    for (const entry of manifest) {
      expect(entry.canonicalAlias).toBe(entry.name);
      if (entry.sourceRef) expect(entry.sourceRef).toBe(entry.as);
    }
    const passwordLocator = manifest.find((entry) => /password/i.test(entry.name));
    expect(passwordLocator).toMatchObject({
      name: 'microsoftPasswordInput',
      canonicalAlias: 'microsoftPasswordInput',
    });
    expect(executableFiles.length).toBeGreaterThan(1);
    expect(emitted.extraFiles['evidence/certification-report.json']).toBeUndefined();
  });
});
