import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  capturedPageIdentityCases,
  continuationAcceptanceCases,
  normalizationParityResult,
  precisionAcceptanceCases,
  precisionDataCase,
  runtimeActionReconciliationFixtures,
  verifiedActionLocator,
} from '../fixtures/playwrightPomJsPrecisionAcceptance.fixture.js';

const require = createRequire(import.meta.url);
const locatorResolver = require('../../server/services/actionLocatorResolver.js');
const executionAuthoringCompiler = require('../../server/services/executionAuthoringCompiler.js');
const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom.js');
const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs.js');
const replayExport = require('../../server/services/codegen/replayExport.js');

function emittedUserSources(emitted) {
  return [
    emitted.content,
    ...Object.entries(emitted.extraFiles)
      .filter(([name]) => /^(?:pages|locators)\//.test(name))
      .map(([, source]) => source),
  ].join('\n');
}

function sourcesMatching(emitted, pattern) {
  return Object.entries(emitted.extraFiles)
    .filter(([name]) => pattern.test(name))
    .map(([, source]) => source)
    .join('\n');
}

function occurrences(source, needle) {
  return String(source).split(needle).length - 1;
}

function withoutVolatileDomAtlasTimes(emitted) {
  const normalized = structuredClone(emitted);
  delete normalized.extraFiles['evidence/dom-atlas.json'];
  for (const page of Object.values(normalized.pomGraph?.domAtlas?.pages || {})) {
    delete page.firstSeenAt;
    delete page.lastSeenAt;
  }
  return normalized;
}

function emittedCore(lang = 'js') {
  if (lang === 'js') {
    return playwrightPomJs.emitJourneySpec(precisionAcceptanceCases(), {
      scenarioName: 'Playwright POM JavaScript precision acceptance',
      scenarioId: 'precision-acceptance',
      moduleFormat: 'esm',
    });
  }
  return playwrightPom.emitJourneySpec(precisionAcceptanceCases(), {
    scenarioName: 'Playwright POM JavaScript precision acceptance',
    scenarioId: 'precision-acceptance',
    lang,
    moduleFormat: 'esm',
  });
}

describe('Playwright POM JavaScript precision acceptance', () => {
  it('calls a locator verified only with unique same-element DOM proof', () => {
    const exact = verifiedActionLocator('page.getByRole("button", { name: "Save", exact: true })', {
      role: 'button',
      accessibleName: 'Save',
    });
    expect(locatorResolver.isVerifiedActionLocator(exact)).toBe(true);

    const ambiguous = structuredClone(exact);
    ambiguous.proof.count = 2;
    expect(locatorResolver.isVerifiedActionLocator(ambiguous)).toBe(false);

    const wrongNode = structuredClone(exact);
    wrongNode.proof.sameElement = false;
    expect(locatorResolver.isVerifiedActionLocator(wrongNode)).toBe(false);

    const noDomProof = structuredClone(exact);
    noDomProof.domAtlas.verifiedActions = [];
    expect(locatorResolver.isVerifiedActionLocator(noDomProof)).toBe(false);

    expect(
      locatorResolver.locatorExpressionIsExportSafe('page.locator("#react-control-781346923")'),
    ).toBe(false);
    expect(
      locatorResolver.locatorExpressionIsExportSafe(
        'page.locator("#8f14e45f-ea2f-4c21-9f13-7dbe22391abc")',
      ),
    ).toBe(false);
  });

  it('emits exact verified semantic, repeated, frame, shadow, and deterministic CSS locators', () => {
    const emitted = emittedCore();
    const locators = sourcesMatching(emitted, /^locators\/generated\/.*\.locators\.js$/);
    const manifest = JSON.parse(emitted.extraFiles['evidence/locator-manifest.json']);

    for (const exact of [
      'page.getByTestId("save-work-item")',
      'page.locator("form[data-contact=\\"primary\\"]").getByLabel("Contact number", { exact: true })',
      'page.locator("form[data-contact=\\"secondary\\"]").getByLabel("Contact number", { exact: true })',
      'page.frameLocator("iframe[data-zone=\\"workspace\\"]").locator("record-shell").locator("reference-panel").getByRole("textbox", { name: "Reference", exact: true })',
      'page.locator("form[data-panel=\\"preferences\\"] input[name=\\"alias\\"]")',
    ]) {
      expect(locators).toContain(exact);
    }

    expect(locators).not.toContain('react-control-781346923');
    expect(locators).not.toMatch(/\.(?:first|last|nth)\s*\(/);
    expect(locators).not.toMatch(/:nth-(?:child|of-type)\s*\(/);

    const verified = manifest.filter((entry) => entry.source === 'actionLocator');
    expect(verified).toHaveLength(7);
    expect(verified.every((entry) => entry.verified === true)).toBe(true);
    expect(verified.every((entry) => entry.verificationSource === 'verified_dom_inspection')).toBe(
      true,
    );

    const cssEntry = manifest.find((entry) => entry.as === 'preferenceAliasInput');
    expect(cssEntry).toMatchObject({ source: 'actionLocator', verified: true });
    const cssLine = locators.split('\n').findIndex((line) => line.includes('form[data-panel'));
    expect(cssLine).toBeGreaterThanOrEqual(0);
    expect(
      locators
        .split('\n')
        .slice(Math.max(0, cssLine - 2), cssLine)
        .join('\n'),
    ).not.toMatch(/QAAI_(?:UNVERIFIED|GUESSED)_LOCATOR/);
  });

  it('pre-arms new pages, adopts popup ownership, bounds optional actions, and never swallows navigation failures', () => {
    const emitted = emittedCore();
    const spec = emitted.content;
    const observedAsMap = new Map();
    observedAsMap.__standardJsOutput = true;
    const observed = playwrightPom._pomEmitAct(
      {
        op: 'act',
        action: 'navigate',
        authored: false,
        observedOnly: true,
        url: 'https://portal.example.test/observed-destination?volatile=1',
        transitionKind: 'popup_context',
      },
      observedAsMap,
      false,
      'click',
      new Map(),
      null,
      null,
    );

    expect(spec).toContain('await workItemsPage.openWorkItems();');
    expect(sourcesMatching(emitted, /^pages\/.*Page\.js$/)).toContain(
      'await this.page.goto("https://portal.example.test/work-items?view=active&returnUrl=%2Fhome", { waitUntil: "domcontentloaded" });',
    );
    expect(spec).toContain('timeout: 17321');
    expect(spec).not.toContain('waitForTimeout');

    const popupArm = spec.search(/waitForEvent\(\s*['"]popup['"]/);
    const popupClick = spec.indexOf('.clickOpenDetails(');
    expect(popupArm).toBeGreaterThanOrEqual(0);
    expect(popupClick).toBeGreaterThanOrEqual(0);
    expect(popupArm).toBeLessThan(popupClick);
    expect(spec).toMatch(/const\s+\[?detailsTab\]?\s*=|const\s+detailsTabPromise\s*=/);
    expect(spec).toMatch(/detailsPage\.usePage\(detailsTab\)/);

    const detailsPage = emitted.extraFiles['pages/DetailsPage.js'];
    expect(detailsPage).toContain("waitFor({ state: 'visible', timeout: 2000 })");
    expect(detailsPage).toContain('if (appeared) { await optionalTarget.click(options); }');
    expect(detailsPage).not.toContain('.isVisible({ timeout: 2000 })');
    expect(occurrences(spec, '.clickDismissTour(')).toBe(1);

    expect(observed).toContain('waitForURL');
    expect(observed).not.toContain('test.info().annotations');
    expect(observed).not.toContain('.catch(');
    expect(spec).not.toContain('test.info().annotations');
    expect(spec).not.toMatch(/(?:goto|waitForURL|goBack|goForward|reload)\([^;]*?\.catch\(/s);
    expect(spec).toContain(".then(() => true).catch(() => false)");
  });

  it('keeps every authored action as one complete POM method and call with no internal identifiers', () => {
    const cases = precisionAcceptanceCases();
    const emitted = playwrightPomJs.emitJourneySpec(cases, {
      scenarioName: 'Complete POM graph',
      moduleFormat: 'esm',
    });
    const pages = sourcesMatching(emitted, /^pages\/.*Page\.js$/);
    const userSources = emittedUserSources(emitted);
    const authoredInteractions = playwrightPomJs
      ._prepareCasesForStandardOutput(cases)
      .flatMap((item) => item.ir.steps)
      .filter((step) => step.op === 'act' && step.authored !== false);
    const methods = Object.values(emitted.pomGraph.pages).flatMap((page) => page.methods || []);
    const actionMethods = methods.filter((method) => method.action !== 'assert');
    const assertionMethods = methods.filter((method) => method.action === 'assert');
    const authoredAssertions = playwrightPomJs
      ._prepareCasesForStandardOutput(cases)
      .flatMap((item) => item.ir.steps)
      .filter((step) => step.op === 'assert' && step.authored !== false && step.channel !== 'EVALUATE');

    expect(actionMethods).toHaveLength(authoredInteractions.length);
    expect(assertionMethods).toHaveLength(authoredAssertions.length);
    for (const method of methods) {
      const methodName = playwrightPom._methodNameFor(method.action, method.name);
      expect(
        occurrences(pages, `async ${methodName}(`),
        `${methodName} must be declared once`,
      ).toBe(1);
      expect(
        occurrences(emitted.content, `.${methodName}(`),
        `${methodName} must be called once`,
      ).toBe(1);
    }

    expect(userSources).not.toMatch(
      /test\.info\(\)\.annotations|qaai-runtime-evidence|qaai-observed-/i,
    );
    expect(userSources).not.toMatch(/\b(?:case_step|runtime-attempt|kernel-|el\d+)\b/i);
    expect(userSources).not.toMatch(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    );
    expect(userSources).not.toMatch(/\b[0-9a-f]{32,}\b/i);
  });

  it('never emits a narrative locator and preserves the missing-locator boundary as diagnostics', () => {
    const emitted = emittedCore();
    const locators = sourcesMatching(emitted, /^locators\/generated\/.*\.locators\.js$/);
    const manifest = JSON.parse(emitted.extraFiles['evidence/locator-manifest.json']);
    const guess = manifest.filter((entry) => entry.source === 'qaaiGuessedLocator');
    const prepared = playwrightPomJs._prepareCasesForStandardOutput(
      structuredClone(precisionAcceptanceCases()),
    );
    const missingLocatorBoundary = prepared
      .flatMap((caseItem) => caseItem.ir.runtimeEvidence || [])
      .find((step) => step?.failureBoundary?.code === 'missing_authoritative_action_locator');

    expect(guess).toHaveLength(0);
    expect(occurrences(locators, 'QAAI_GUESSED_LOCATOR')).toBe(0);
    expect(occurrences(locators, 'QAAI_UNVERIFIED_LOCATOR')).toBe(0);
    expect(locators).not.toContain('Launch report');
    expect(missingLocatorBoundary).toMatchObject({
      executable: false,
      diagnosticOnly: true,
      failureBoundary: { code: 'missing_authoritative_action_locator' },
      upstreamConductorRequirement: {
        code: 'UPSTREAM_CONDUCTOR_REQUIREMENT',
        consumer: 'playwrightPomJsStandardProfile.enforceVerifiedRunnableLocators',
      },
    });
  });

  it('keeps unresolved locator actions diagnostic and out of runnable POM code', () => {
    const authProfile = { id: 'default', strategy: 'none', disposition: 'bypass_fixture' };
    const fallbackCase = (caseId, step) => ({
      runResultId: `run-${caseId}`,
      testCaseId: caseId,
      caseName: caseId,
      ir: {
        version: 1,
        caseId,
        title: caseId,
        authProfile,
        steps: [step],
        verdict: { status: 'pass', perAssertionOutcomes: [] },
      },
    });
    const emit = (caseItem) =>
      playwrightPomJs.emitJourneySpec([caseItem], {
        scenarioName: caseItem.caseName,
        moduleFormat: 'esm',
      });

    const targetBearingCase = fallbackCase('unresolved-target-bearing', {
        op: 'act',
        action: 'click',
        target: 'Submit order',
        authored: true,
        contractStepId: 'submit-order',
        pageUrl: 'https://portal.example.test/orders',
      });
    const targetBearing = emit(targetBearingCase);
    const preparedTargetBearing = playwrightPomJs._prepareCasesForStandardOutput([
      structuredClone(targetBearingCase),
    ])[0];
    const targetBearingLocators = sourcesMatching(
      targetBearing,
      /^locators\/generated\/.*\.locators\.js$/,
    );
    const targetBearingPages = sourcesMatching(targetBearing, /^pages\/.*Page\.js$/);

    // Missing action-time proof is retained as diagnostics, never runnable narration.
    expect(targetBearing.content).not.toMatch(/await\s+ordersPage\.click[A-Z]\w*\(\);/);
    expect(targetBearing.content).not.toMatch(/await\s+page\.(?:getBy|locator)\([^\n]*\)\.click\(/);
    expect(targetBearingLocators).not.toContain('QAAI_GUESSED_LOCATOR');
    expect(targetBearingPages).not.toMatch(/async\s+click[A-Z]\w*\(/);
    expect(preparedTargetBearing.ir.runtimeEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executable: false,
          diagnosticOnly: true,
          failureBoundary: expect.objectContaining({
            code: 'missing_authoritative_action_locator',
            operation: 'click',
          }),
          upstreamConductorRequirement: expect.objectContaining({
            code: 'UPSTREAM_CONDUCTOR_REQUIREMENT',
          }),
        }),
      ]),
    );

    const unexecutedTargetless = emit(
      fallbackCase('targetless-authored-action', {
        op: 'act',
        action: 'click',
        authored: true,
        contractStepId: 'targetless-click',
        pageUrl: 'https://portal.example.test/orders',
      }),
    );
    expect(unexecutedTargetless.content).not.toMatch(/\.click[A-Z]\w*\(\);/);
    expect(emittedUserSources(unexecutedTargetless)).not.toContain('QAAI_GUESSED_LOCATOR');

    const targetlessCase = fallbackCase('executed-targetless-action', {
        op: 'act',
        action: 'click',
        authored: true,
        contractStepId: 'targetless-click',
        pageUrl: 'https://portal.example.test/orders',
        canonicalExecution: true,
        success: true,
        executionStatus: 'passed',
        origin: 'runtime_evidence',
      });
    const targetless = emit(targetlessCase);
    const preparedTargetless = playwrightPomJs._prepareCasesForStandardOutput([
      structuredClone(targetlessCase),
    ])[0];
    const targetlessSources = emittedUserSources(targetless);
    const targetlessPages = sourcesMatching(targetless, /^pages\/.*Page\.js$/);

    expect(targetless.content).not.toMatch(/await\s+ordersPage\.click[A-Z]\w*\(\);/);
    expect(targetlessSources).not.toContain('QAAI_GUESSED_LOCATOR');
    expect(targetlessPages).not.toMatch(/async\s+click[A-Z]\w*\(/);
    expect(preparedTargetless.ir.runtimeEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          failureBoundary: expect.objectContaining({
            code: 'missing_authoritative_action_locator',
          }),
        }),
      ]),
    );
    expect(targetlessSources).not.toMatch(
      /\b(?:el\d+|actElement\d+)\b|STATUS:\s*DRAFT|qaai-(?:runtime-evidence|observed-)|certification/i,
    );

    const collidingTargetless = emit({
      ...fallbackCase('colliding-targetless-actions', {
        op: 'act',
        action: 'click',
        authored: true,
        contractStepId: 'first-save',
        targetLabel: 'Save',
        pageUrl: 'https://portal.example.test/orders',
      }),
      ir: {
        ...fallbackCase('colliding-targetless-actions', {}).ir,
        steps: [
          {
            op: 'act',
            action: 'click',
            authored: true,
            contractStepId: 'first-save',
            targetLabel: 'Save',
            pageUrl: 'https://portal.example.test/orders',
            canonicalExecution: true,
            success: true,
            executionStatus: 'passed',
            origin: 'runtime_evidence',
          },
          {
            op: 'act',
            action: 'click',
            authored: true,
            contractStepId: 'second-save',
            targetLabel: 'Save',
            pageUrl: 'https://portal.example.test/orders',
            canonicalExecution: true,
            success: true,
            executionStatus: 'passed',
            origin: 'runtime_evidence',
          },
        ],
      },
    });
    const collidingSources = emittedUserSources(collidingTargetless);
    const collidingCalls = Array.from(
      collidingTargetless.content.matchAll(/await\s+ordersPage\.(click[A-Z]\w*)\(\);/g),
    );
    expect(collidingCalls).toHaveLength(0);
    expect(collidingCalls.every((match) => !/\d/.test(match[1]))).toBe(true);
    expect(collidingSources).not.toMatch(
      /await\s+page\.(?:getBy|locator)\([^\n]*\)\.(?:click|fill|press)/,
    );
    expect(collidingSources).not.toMatch(/\b(?:el\d+|actElement\d+|saveButton\d+)\b/);

    const promotedVerifiedTargetless = emit(
      fallbackCase('promoted-verified-targetless', {
        op: 'act',
        action: 'click',
        authored: false,
        evidenceOnly: true,
        origin: 'unmatched_runtime_evidence',
        required: true,
        ok: true,
        runtimeEvidence: true,
        contractStepId: 'captured-confirm',
        pageUrl: 'https://portal.example.test/orders',
        actionLocator: verifiedActionLocator(
          'page.getByRole("button", { name: "Confirm", exact: true })',
          { role: 'button', accessibleName: 'Confirm' },
        ),
      }),
    );
    const promotedLocators = sourcesMatching(
      promotedVerifiedTargetless,
      /^locators\/generated\/.*\.locators\.js$/,
    );
    expect(promotedVerifiedTargetless.content).toMatch(/await\s+ordersPage\.clickConfirm\(\);/);
    expect(promotedVerifiedTargetless.content).not.toMatch(
      /await\s+page\.(?:getBy|locator)\([^\n]*\)\.click\(/,
    );
    expect(promotedLocators).toContain(
      'confirmButton: (page) => page.getByRole("button", { name: "Confirm", exact: true })',
    );
    expect(promotedLocators).not.toContain('QAAI_GUESSED_LOCATOR');

    const diagnosticGuess = emit(
      fallbackCase('diagnostic-action-locator-guess', {
        op: 'act',
        action: 'click',
        target: 'Archive order',
        authored: true,
        contractStepId: 'archive-order',
        pageUrl: 'https://portal.example.test/orders',
        actionLocator: {
          kind: 'playwright',
          expression: 'page.getByRole("button", { name: "Archive order", exact: true })',
          frameworkExpressions: {
            playwright: 'page.getByRole("button", { name: "Archive order", exact: true })',
          },
          verificationSource: 'semantic_guess',
          verified: false,
          proof: { verified: false },
        },
      }),
    );
    const diagnosticLocators = sourcesMatching(
      diagnosticGuess,
      /^locators\/generated\/.*\.locators\.js$/,
    );

    expect(diagnosticLocators).not.toContain('QAAI_GUESSED_LOCATOR');
    expect(diagnosticLocators).not.toContain('QAAI_UNVERIFIED_LOCATOR');
    expect(diagnosticGuess.content).not.toMatch(/await\s+ordersPage\.click[A-Z]\w*\(\);/);

    const dragWithUnresolvedDestination = emit(
      fallbackCase('drag-with-unresolved-destination', {
        op: 'act',
        action: 'drag',
        target: 'Pending card',
        destinationTarget: 'Completed column',
        destinationLabel: 'Completed',
        authored: true,
        contractStepId: 'move-card',
        pageUrl: 'https://portal.example.test/orders',
        actionLocator: verifiedActionLocator('page.getByTestId("pending-card")', {
          testId: 'pending-card',
          accessibleName: 'Pending card',
        }),
        destinationActionLocator: verifiedActionLocator('page.getByTestId("completed-column")', {
          testId: 'completed-column',
          accessibleName: 'Completed',
        }),
      }),
    );
    const dragLocators = sourcesMatching(
      dragWithUnresolvedDestination,
      /^locators\/generated\/.*\.locators\.js$/,
    );
    const dragPages = sourcesMatching(dragWithUnresolvedDestination, /^pages\/.*Page\.js$/);
    expect(dragWithUnresolvedDestination.content).toMatch(
      /await\s+ordersPage\.drag[A-Z]\w*\(ordersPage\.[a-zA-Z]\w*\(\)\);/,
    );
    expect(dragWithUnresolvedDestination.content).not.toMatch(
      /\.drag[A-Z]\w*\((?:completedColumn|destination)\)/,
    );
    expect(dragLocators).toContain('page.getByTestId("pending-card")');
    expect(dragLocators).toContain('page.getByTestId("completed-column")');
    expect(dragPages).toMatch(/async\s+drag[A-Z]\w*\(target\)/);
    expect(dragLocators).not.toContain('QAAI_GUESSED_LOCATOR');
  });

  it('preserves inline, required environment, and case-scoped workbook bindings without leaking values', () => {
    const emitted = playwrightPom.emitJourneySpec([precisionDataCase()], {
      scenarioName: 'Typed test data',
      lang: 'js',
      moduleFormat: 'esm',
    });
    const dataFiles = Object.entries(emitted.extraFiles).filter(([name]) =>
      name.startsWith('tests/data/'),
    );

    expect(emitted.content).toContain('"INLINE-42"');
    expect(emitted.content).toContain('readEnv("QAAI_ACCESS_TOKEN")');
    expect(emitted.content).toContain('readData(row, "Region")');
    expect(emitted.content).not.toContain('must-never-be-emitted');
    expect(dataFiles).toHaveLength(1);
    expect(JSON.parse(dataFiles[0][1])).toEqual([
      { index: 0, label: 'Region row', fields: { Region: 'West' } },
    ]);
  });

  it('keeps JavaScript output JavaScript-only and does not mutate TypeScript emission', () => {
    const before = emittedCore('ts');
    const javascript = emittedCore('js');
    const after = emittedCore('ts');

    expect(withoutVolatileDomAtlasTimes(after)).toEqual(withoutVolatileDomAtlasTimes(before));
    expect(Object.keys(javascript.extraFiles).filter((name) => /\.(?:ts|tsx)$/.test(name))).toEqual(
      [],
    );
    expect(javascript.content).not.toMatch(/:\s*(?:Page|Locator|string|number|boolean)\b/);
    expect(Object.keys(javascript.extraFiles).some((name) => /tsconfig\.json$/i.test(name))).toBe(
      false,
    );
  });

  it('preserves continuation and same-session cases without synthesizing navigation or login', () => {
    const emitted = playwrightPomJs.emitJourneySpec(continuationAcceptanceCases(), {
      scenarioName: 'Session continuation acceptance',
      moduleFormat: 'esm',
    });
    const userSources = emittedUserSources(emitted);

    expect(emitted.content).not.toMatch(/\bpage\.goto\s*\(/);
    expect(emitted.content).not.toMatch(/\b(?:login|signIn|authenticate)[A-Z\w]*\s*\(/i);
    expect(userSources).not.toMatch(/QAAI_(?:USERNAME|PASSWORD)|storageState/i);
    expect(emitted.content).toContain('.clickUseCurrentSession(');
    expect(emitted.content).toMatch(/\.assertDependencyResult[A-Za-z0-9_$]*\(/i);
    expect(sourcesMatching(emitted, /^pages\/.*Page\.js$/)).toMatch(
      /expect\([^\n]*dependencyResult/i,
    );
  });

  it('uses captured title, route, and origin before hostname or dynamic-route heuristics', () => {
    const emitted = playwrightPomJs.emitJourneySpec(capturedPageIdentityCases(), {
      scenarioName: 'Captured browser page identity',
      moduleFormat: 'esm',
    });
    const pageFiles = Object.keys(emitted.extraFiles).filter((name) =>
      /^pages\/.*Page\.js$/.test(name),
    );
    const joined = pageFiles.join('\n');

    expect(pageFiles).toHaveLength(2);
    expect(joined).toMatch(/BillingWorkspacePage\.js$/m);
    expect(joined).toMatch(/SupportWorkspacePage\.js$/m);
    expect(joined).not.toMatch(/(?:Hosting|Tenant481|Tenant927|981346|742905).*Page\.js/i);
  });

  it('retains an unmatched successful required runtime action exactly once as executable code', () => {
    const { unmatched } = runtimeActionReconciliationFixtures();
    const prepared = replayExport.prepareResultForExport(structuredClone(unmatched));
    const acts = prepared.envelope.ir.steps.filter(
      (step) => step.op === 'act' && step.action === 'click',
    );
    const emitted = playwrightPomJs.emitJourneySpec(
      [
        {
          runResultId: prepared.runResultId,
          testCaseId: prepared.testCaseId,
          caseName: prepared.caseName,
          declaredSteps: prepared.declaredSteps,
          ir: prepared.envelope.ir,
        },
      ],
      { scenarioName: 'Required runtime reconciliation', moduleFormat: 'esm' },
    );
    const methods = Object.values(emitted.pomGraph.pages).flatMap((page) => page.methods || []);

    expect(acts.map((step) => step.contractStepId)).toEqual(['runtime-refresh-records']);
    expect(acts.filter((step) => step.contractStepId === 'runtime-refresh-records')).toHaveLength(
      1,
    );
    expect(methods.filter((method) => method.action === 'click')).toHaveLength(1);
    expect(emittedUserSources(emitted)).toContain(
      'page.getByRole("button", { name: "Refresh records", exact: true })',
    );
    expect(emittedUserSources(emitted)).not.toMatch(
      /test\.info\(\)\.annotations|qaai-runtime-evidence/i,
    );
  });

  it('prunes a matched runtime-evidence duplicate exactly once', () => {
    const { matched } = runtimeActionReconciliationFixtures();
    const prepared = replayExport.prepareResultForExport(structuredClone(matched));
    const acts = prepared.envelope.ir.steps.filter(
      (step) => step.op === 'act' && step.action === 'click',
    );
    const emitted = playwrightPomJs.emitJourneySpec(
      [
        {
          runResultId: prepared.runResultId,
          testCaseId: prepared.testCaseId,
          caseName: prepared.caseName,
          declaredSteps: prepared.declaredSteps,
          ir: prepared.envelope.ir,
        },
      ],
      { scenarioName: 'Matched runtime reconciliation', moduleFormat: 'esm' },
    );
    const methods = Object.values(emitted.pomGraph.pages).flatMap((page) => page.methods || []);

    expect(acts.filter((step) => step.contractStepId === 'authored-refresh-records')).toHaveLength(
      1,
    );
    expect(acts).toHaveLength(1);
    expect(methods.filter((method) => method.action === 'click')).toHaveLength(1);
    expect(
      occurrences(
        emittedUserSources(emitted),
        'page.getByRole("button", { name: "Refresh records", exact: true })',
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(emittedUserSources(emitted)).not.toMatch(
      /test\.info\(\)\.annotations|qaai-runtime-evidence/i,
    );
  });

  it('never cross-attaches one runtime locator to ambiguous semantic authored matches', () => {
    const { ambiguous } = runtimeActionReconciliationFixtures();
    const prepared = replayExport.prepareResultForExport(structuredClone(ambiguous));
    const normalized = playwrightPomJs._prepareCasesForStandardOutput([
      {
        runResultId: prepared.runResultId,
        testCaseId: prepared.testCaseId,
        caseName: prepared.caseName,
        declaredSteps: prepared.declaredSteps,
        ir: prepared.envelope.ir,
      },
    ])[0];
    const steps = normalized.ir.steps;
    const acts = steps.filter((step) => step.op === 'act' && step.action === 'click');
    const runtimeResolves = steps.filter(
      (step) =>
        step.op === 'resolve' &&
        step.actionLocator?.expression ===
          'page.getByRole("button", { name: "Approve request", exact: true })',
    );
    const emitted = playwrightPomJs.emitJourneySpec(
      [
        {
          runResultId: prepared.runResultId,
          testCaseId: prepared.testCaseId,
          caseName: prepared.caseName,
          declaredSteps: prepared.declaredSteps,
          declaredAssertionsRaw: prepared.declaredAssertionsRaw,
          ir: prepared.envelope.ir,
        },
      ],
      { scenarioName: 'Ambiguous runtime reconciliation', moduleFormat: 'esm' },
    );
    const methods = Object.values(emitted.pomGraph.pages).flatMap((page) => page.methods || []);
    const approveMethods = methods.filter(
      (method) =>
        method.action === 'click' &&
        /approve.*request/i.test(`${method.name || ''} ${method.target || ''}`),
    );
    const emittedApproveCalls =
      String(emitted.content).match(
        /await\s+([A-Za-z_$][\w$]*)\.(click[A-Za-z_$]*Approve[A-Za-z_$]*Request[A-Za-z_$]*)\(\s*(?:\{\})?\s*\);/g,
      ) || [];
    const approveCallReceivers = emittedApproveCalls.map(
      (call) => call.match(/await\s+([A-Za-z_$][\w$]*)\./)?.[1],
    );

    expect(acts).toHaveLength(1);
    expect(acts.filter((step) => step.contractStepId === 'runtime-approve-request')).toHaveLength(
      1,
    );
    expect(runtimeResolves).toHaveLength(1);
    expect(runtimeResolves[0].contractStepId).toBe('runtime-approve-request');
    expect(approveMethods).toHaveLength(1);
    expect(emittedApproveCalls).toHaveLength(1);
    expect([...new Set(approveCallReceivers)].sort()).toHaveLength(1);
  });

  it('retains authored wait and assertion parity through partial-ReplayIR normalization', () => {
    const prepared = replayExport.prepareResultForExport(
      structuredClone(normalizationParityResult()),
    );
    const waits = prepared.envelope.ir.steps.filter((step) => step.op === 'waitFor');
    const assertions = prepared.envelope.ir.steps.filter((step) => step.op === 'assert');

    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ contractStepId: 'wait-ready', authored: true });
    expect(assertions).toHaveLength(1);
    expect(assertions[0]).toMatchObject({ authored: true, expected: 'Ready' });

    const profilePrepared = playwrightPomJs._prepareCasesForStandardOutput([
      {
        runResultId: prepared.runResultId,
        testCaseId: prepared.testCaseId,
        caseName: prepared.caseName,
        declaredSteps: prepared.declaredSteps,
        declaredAssertionsRaw: prepared.declaredAssertionsRaw,
        ir: prepared.envelope.ir,
      },
    ])[0];
    const profileWaits = profilePrepared.ir.steps.filter((step) => step.op === 'waitFor');
    const profileAssertions = profilePrepared.ir.steps.filter((step) => step.op === 'assert');
    expect(profileWaits).toHaveLength(1);
    expect(profileWaits[0]).toMatchObject({
      contractStepId: 'wait-ready',
      authored: true,
      condition: { kind: 'visible', target: 'readyStatus', timeoutMs: 23_456 },
    });
    expect(profileAssertions).toHaveLength(1);
    expect(profileAssertions[0]).toMatchObject({
      contractStepId: 'assert-ready',
      authored: true,
      expected: 'Ready',
      flowCritical: true,
    });
    const emitted = playwrightPomJs.emitJourneySpec(
      [
        {
          runResultId: prepared.runResultId,
          testCaseId: prepared.testCaseId,
          caseName: prepared.caseName,
          declaredSteps: prepared.declaredSteps,
          declaredAssertionsRaw: prepared.declaredAssertionsRaw,
          ir: prepared.envelope.ir,
        },
      ],
      { scenarioName: 'Normalization parity', moduleFormat: 'esm' },
    );
    expect(emitted.content).toContain('timeout: 23456');
    expect(emitted.content).toMatch(/\.assertReadyStatus[A-Za-z0-9_$]*\(/i);
    expect(sourcesMatching(emitted, /^pages\/.*Page\.js$/)).toMatch(
      /expect\([^\n]*readyStatus/i,
    );
  });

  it('preserves authoritative frame, open-shadow, and popup ownership through hydration and POM emission', () => {
    const runResultId = 'run-context-pipeline';
    const testCaseId = 'case-context-pipeline';
    const contractStepId = 'open-payment-popup';
    const actionOccurrenceId = `${runResultId}:${testCaseId}:1:click`;
    const mainUrl = 'https://checkout.example.test/workspace';
    const popupUrl = 'https://payments.example.test/authorize';
    const framePath = ['iframe#shell', 'iframe[name="payment"]'];
    const shadowPath = ['account-shell', 'payment-widget'];
    const targetIdentity = {
      scheme: 'qaai-cdp-backend-node-v1',
      backendNodeId: 4242,
      frameId: 'frame-payment',
      documentUrl: mainUrl,
      connected: true,
    };
    const innerExpression =
      'locator("account-shell").locator("payment-widget").getByRole("button", { name: "Open payment", exact: true })';
    const expectedExpression =
      'frameLocator("iframe#shell").frameLocator("iframe[name=\\"payment\\"]").locator("account-shell").locator("payment-widget").getByRole("button", { name: "Open payment", exact: true })';
    const capture = {
      captured: true,
      authoritative: true,
      identity: targetIdentity,
      node: { localName: 'button', attributes: { 'data-testid': 'open-payment' } },
      accessibility: { role: 'button', name: 'Open payment' },
      captureBinding: { kind: 'mcp_bound_ref', ref: 'e-open-payment' },
      pageIdentity: {
        pageId: 'page-checkout',
        pageAlias: 'checkout-workspace',
        title: 'Checkout workspace',
      },
      frameIdentity: { frameId: 'frame-payment', documentUrl: mainUrl },
      framePath: [
        { backendNodeId: 101, nodeName: 'IFRAME', attributes: { id: 'shell' } },
        { backendNodeId: 102, nodeName: 'IFRAME', attributes: { name: 'payment' } },
      ],
      framePathSelectors: framePath,
      framePathExportable: true,
      shadowPath: [
        { backendNodeId: 201, nodeName: 'ACCOUNT-SHELL', rootType: 'open' },
        { backendNodeId: 202, nodeName: 'PAYMENT-WIDGET', rootType: 'open' },
      ],
      shadowContext: { available: true, reason: null, gaps: [] },
      candidateAnalysis: { shadowHostSelectors: shadowPath },
      stabilization: { stableAcrossSnapshots: true },
      selectedCandidate: {
        strategy: 'role',
        role: 'button',
        name: 'Open payment',
        expression: innerExpression,
        frameworkExpressions: { playwright: innerExpression },
        framePath,
        priority: 1,
        proof: {
          count: 1,
          sameElement: true,
          visible: true,
          enabled: true,
          identityVerified: true,
          targetIdentity,
          matchedIdentity: { ...targetIdentity },
          authoritativeCdpVerified: true,
          backendNodeVerified: true,
          stableAcrossSnapshots: true,
        },
      },
    };
    const actionLocator = locatorResolver.buildActionLocatorFromAuthoritativeCapture({
      toolName: 'browser_click',
      args: { ref: 'e-open-payment' },
      capture,
      pageUrl: mainUrl,
      elementLabel: 'Open payment',
    });
    expect(actionLocator).toBeTruthy();
    expect(actionLocator.frameworkExpressions.playwright).toBe(expectedExpression);
    const recipe = executionAuthoringCompiler.buildLocatorRecipe(actionLocator);
    expect(recipe.context).toMatchObject({
      framePath,
      shadowPath,
      shadowHostPath: shadowPath,
      pageIdentity: { pageId: 'page-checkout', title: 'Checkout workspace' },
      frameIdentity: { frameId: 'frame-payment' },
    });
    expect(recipe.context.frameChain).toHaveLength(2);
    expect(recipe.context.shadowHostChain).toHaveLength(2);
    const captureSummary = {
      captured: true,
      authoritative: true,
      source: 'chromium_cdp',
      backendNodeId: targetIdentity.backendNodeId,
      identity: targetIdentity,
      captureBinding: capture.captureBinding,
      pageIdentity: capture.pageIdentity,
      frameIdentity: capture.frameIdentity,
      framePath: capture.framePath,
      framePathSelectors: framePath,
      shadowPath: capture.shadowPath,
    };
    const persistedRecipe = {
      ...recipe,
      captureEvidence: {
        backendNodeId: targetIdentity.backendNodeId,
        targetRef: capture.captureBinding.ref,
        pre: { ...captureSummary, phase: 'pre_action' },
        post: { ...captureSummary, phase: 'post_action' },
        framePath,
        shadowPath,
        pageIdentity: capture.pageIdentity,
        frameIdentity: capture.frameIdentity,
        captureBinding: capture.captureBinding,
      },
    };
    expect(locatorResolver.isVerifiedActionLocator(persistedRecipe)).toBe(true);

    const hydrated = {
      runResultId,
      testCaseId,
      caseName: 'Open payment popup from nested component',
      declaredSteps: [
        { id: contractStepId, contractStepId, action: 'click', target: 'Open payment' },
      ],
      envelope: {
        ir: {
          steps: [
            {
              op: 'resolve',
              as: 'openPaymentButton',
              contractStepId,
              actionOccurrenceId,
              pageUrl: mainUrl,
              elementLabel: 'Open payment',
            },
            {
              op: 'act',
              action: 'click',
              target: 'openPaymentButton',
              contractStepId,
              actionOccurrenceId,
              authored: true,
              pageUrl: mainUrl,
            },
            {
              op: 'act',
              action: 'navigate',
              authored: false,
              observedOnly: true,
              transitionKind: 'popup_context',
              popupIdentity: { id: 'popup-payment', alias: 'paymentPopup' },
              pageUrl: mainUrl,
              pageUrlAfter: popupUrl,
            },
          ],
        },
      },
      captureFirstEvidence: {
        locatorRecipes: [
          {
            id: 'locator-recipe-context',
            runResultId,
            testCaseId,
            contractStepId,
            primaryExpression: expectedExpression,
            sameElementProof: true,
            countBefore: 1,
            countAfter: 1,
            locatorRecipeJson: JSON.stringify(persistedRecipe),
          },
        ],
        actionEvidences: [
          {
            id: 'action-evidence-context',
            runResultId,
            testCaseId,
            contractStepId,
            actionOccurrenceId,
            operation: 'click',
            locatorRecipeId: 'locator-recipe-context',
            evidenceJson: JSON.stringify({ ok: true }),
          },
        ],
      },
    };
    replayExport.hydrateReplayIrFromCaptureEvidence(hydrated);
    const hydratedResolve = hydrated.envelope.ir.steps.find((step) => step.op === 'resolve');
    expect(hydratedResolve.actionLocator.frameworkExpressions.playwright).toBe(expectedExpression);
    expect(hydratedResolve.actionLocator.context).toMatchObject({
      framePath,
      shadowPath,
      pageIdentity: { pageId: 'page-checkout' },
    });

    const caseItem = {
      runResultId,
      testCaseId,
      caseName: hydrated.caseName,
      declaredSteps: hydrated.declaredSteps,
      ir: hydrated.envelope.ir,
    };
    const prepared = playwrightPomJs._prepareCasesForStandardOutput([caseItem])[0];
    const preparedResolve = prepared.ir.steps.find((step) => step.op === 'resolve');
    const preparedClick = prepared.ir.steps.find(
      (step) => step.op === 'act' && step.action === 'click',
    );
    expect(preparedResolve).toMatchObject({
      framePath,
      shadowPath,
      pageIdentity: { pageId: 'page-checkout', title: 'Checkout workspace' },
      frameIdentity: { frameId: 'frame-payment' },
    });
    expect(preparedClick).toMatchObject({ opensPopup: true, popupExpectedUrl: popupUrl });

    const emitted = playwrightPomJs.emitJourneySpec([caseItem], {
      scenarioName: 'Context pipeline regression',
      moduleFormat: 'esm',
    });
    const locatorSources = sourcesMatching(emitted, /^locators\/generated\/.*\.locators\.js$/);
    expect(locatorSources).toContain(expectedExpression);
    expect(locatorSources).not.toContain('QAAI_GUESSED_LOCATOR');
    expect(emitted.content).toContain("waitForEvent('popup'");
    expect(emitted.content).toContain('.usePage(');
    expect(occurrences(emitted.content, '.clickOpenPayment(')).toBe(1);
  });
});
