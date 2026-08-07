import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { verifiedActionLocator } from '../fixtures/playwrightPomJsPrecisionAcceptance.fixture.js';

const require = createRequire(import.meta.url);
const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs.js');
const generatedOutputQuality = require('../../server/services/generatedOutputQuality.js');

function emittedPomSources(output) {
  return [
    output.content,
    ...Object.entries(output.extraFiles || {})
      .filter(([file]) => /^(?:pages|locators)\//.test(file))
      .map(([, source]) => source),
  ].join('\n');
}

function persistedCdpLocatorRecipe(expression, { role, accessibleName, pageUrl, backendNodeId }) {
  const identity = {
    scheme: 'qaai-cdp-backend-node-v1',
    backendNodeId,
    documentUrl: pageUrl,
    connected: true,
  };
  const captureBinding = {
    kind: 'mcp_bound_ref',
    ref: `e${backendNodeId}`,
    backendNodeId,
    pageUrl,
  };
  const proof = {
    count: 1,
    sameElement: true,
    verified: true,
    source: 'authoritative_chromium_cdp',
    actionTimeResolved: true,
    resolutionMode: 'authoritative_cdp_backend_node',
    identityVerified: true,
    targetIdentity: identity,
    matchedIdentity: identity,
    stableAcrossSnapshots: true,
    countBefore: 1,
    countAfter: 1,
  };
  return {
    schemaVersion: 'qaai-locator-recipe-v1',
    kind: 'playwright',
    primaryExpression: expression,
    frameworkExpressions: { playwright: expression },
    targetFacts: { role, accessibleName },
    context: { captureBinding },
    proof,
    source: 'authoritative_chromium_cdp',
    verified: true,
    verificationStatus: 'verified',
    captureEvidence: {
      pre: {
        captured: true,
        authoritative: true,
        source: 'chromium_cdp',
        backendNodeId,
        identity,
        captureBinding,
      },
      post: null,
    },
    candidates: [
      {
        strategy: 'role',
        expression,
        proof: {
          ...proof,
          authoritativeCdpVerified: true,
          backendNodeVerified: true,
          sameElementAcrossSnapshots: true,
          expectedBackendNodeId: backendNodeId,
          matchedBackendNodeId: backendNodeId,
          backendNodeIdBefore: backendNodeId,
          backendNodeIdAfter: backendNodeId,
        },
      },
    ],
  };
}

function atlasCandidate(expression, backendNodeId, matchedCapture = null) {
  const identity = {
    scheme: 'qaai-cdp-backend-node-v1',
    backendNodeId,
    connected: true,
  };
  return {
    strategy: 'scoped_semantic',
    expression,
    count: 1,
    verified: true,
    ...(matchedCapture ? { matchedCapture } : {}),
    proof: {
      count: 1,
      verified: true,
      backendNodeVerified: true,
      sameElement: true,
      targetIdentity: identity,
      matchedIdentity: identity,
      expectedBackendNodeId: backendNodeId,
      matchedBackendNodeId: backendNodeId,
    },
  };
}

function domAtlasWithCandidates(pageUrl, candidates) {
  return {
    pages: {
      [pageUrl]: {
        verifiedActions: [
          {
            context: {
              authoritativeCdp: {
                pre: { verifiedCandidates: candidates, selectedCandidate: candidates[0] },
              },
            },
          },
        ],
      },
    },
  };
}

describe('Playwright POM JavaScript emitter closure seal', () => {
  it('normalizes a production-shaped persisted CDP recipe without dropping its executed action', () => {
    const pageUrl = 'https://qa.odysseylogistics.com/auth/email-classifier';
    const locator = persistedCdpLocatorRecipe(
      'getByRole("textbox", { name: "Email Address", exact: true })',
      {
        role: 'textbox',
        accessibleName: 'Email Address',
        pageUrl,
        backendNodeId: 6,
      },
    );
    const sourceCase = {
      caseName: 'Email classifier login',
      testCaseId: 'login-case',
      declaredSteps: [
        { id: 'enter-email', action: 'fill', target: 'Email Address' },
      ],
      ir: {
        caseId: 'login-case',
        steps: [
          { op: 'act', action: 'navigate', url: pageUrl, contractStepId: 'open-login', authored: true },
          {
            op: 'resolve',
            as: 'emailAddressInput',
            pageUrl,
            contractStepId: 'enter-email',
            actionOccurrenceId: 'login-case:enter-email:fill:1',
            actionLocator: locator,
            authored: true,
          },
          {
            op: 'act',
            action: 'fill',
            target: 'emailAddressInput',
            targetLabel: 'Email Address',
            contractStepId: 'enter-email',
            actionOccurrenceId: 'login-case:enter-email:fill:1',
            valueRef: 'env:QAAI_USERNAME',
            actionLocator: locator,
            authored: true,
          },
        ],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Email classifier login',
      moduleFormat: 'esm',
    });
    const locatorPath = Object.keys(output.extraFiles).find((file) =>
      /^locators\/generated\/.+\.generated\.locators\.js$/.test(file),
    );

    expect(prepared.ir.steps.filter((step) => step.op === 'act').map((step) => step.action)).toEqual([
      'navigate',
      'fill',
    ]);
    expect(prepared.ir.runtimeEvidence || []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          failureBoundary: expect.objectContaining({ code: 'missing_authoritative_action_locator' }),
        }),
      ]),
    );
    expect(output.extraFiles[locatorPath]).toContain(
      'page.getByRole("textbox", { name: "Email Address", exact: true })',
    );
    expect(output.extraFiles[locatorPath]).not.toMatch(/QAAI_(?:GUESSED|UNVERIFIED)_LOCATOR/);
    expect(output.content).toContain(
      'await emailClassifierPage.fillEmailAddress(readEnv("QAAI_USERNAME"));',
    );
    expect(output.extraFiles['pages/EmailClassifierPage.js']).toContain(
      'async fillEmailAddress(value)',
    );
  });

  it('keeps the verified executable prefix and records an unverified locator boundary as diagnostics', async () => {
    const pageUrl = 'https://qa.odysseylogistics.com/';
    const emailLocator = verifiedActionLocator(
      'page.getByRole("textbox", { name: "Email Address", exact: true })',
      {
        role: 'textbox',
        accessibleName: 'Email Address',
        pageUrl,
        editable: true,
      },
    );
    const explicitSemanticGuess = verifiedActionLocator(
      'page.getByRole("button", { name: "Launch report button on Odyssey dashboard", exact: true })',
      {
        role: 'button',
        accessibleName: 'Launch report button on Odyssey dashboard',
        pageUrl,
      },
    );
    explicitSemanticGuess.verified = false;
    explicitSemanticGuess.guess = { isGuess: true };
    explicitSemanticGuess.proof = { ...explicitSemanticGuess.proof, sameElement: false };
    explicitSemanticGuess.domAtlas = { ...explicitSemanticGuess.domAtlas, verifiedActions: [] };

    const sourceCase = {
      caseName: 'Odyssey root journey',
      ir: {
        caseId: 'odyssey-root-journey',
        steps: [
          {
            op: 'act',
            action: 'navigate',
            url: pageUrl,
            contractStepId: 'open-odyssey',
            authored: true,
          },
          {
            op: 'resolve',
            as: 'emailAddressInput',
            pageUrl,
            contractStepId: 'enter-email',
            elementLabel: 'Narrated credential control',
            actionLocator: emailLocator,
            authored: true,
          },
          {
            op: 'act',
            action: 'fill',
            target: 'emailAddressInput',
            targetLabel: 'Email Address',
            contractStepId: 'enter-email',
            valueRef: 'env:QAAI_USERNAME',
            authored: true,
          },
          {
            op: 'resolve',
            as: 'launchReportButton',
            pageUrl,
            contractStepId: 'launch-report',
            elementLabel: 'Launch report',
            actionLocator: explicitSemanticGuess,
            guessedLocator: true,
            locatorProvenance: {
              kind: 'qaai_guessed_locator',
              deterministicEvidenceExhausted: false,
            },
            actionLocatorGap: {
              code: 'diagnostic_guess_without_exhaustion_proof',
              strategiesTried: [],
              deterministicEvidenceExhausted: false,
            },
            candidates: [{ strategy: 'role', role: 'button', name: 'Launch report' }],
            authored: true,
          },
          {
            op: 'act',
            action: 'click',
            target: 'launchReportButton',
            targetLabel: 'Launch report',
            contractStepId: 'launch-report',
            authored: true,
          },
          {
            op: 'assert',
            channel: 'UI_TEXT',
            expected: 'Report center',
            contractRef: 'report-center-visible',
            authored: true,
          },
        ],
      },
    };

    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Odyssey root journey',
      moduleFormat: 'esm',
    });
    const preparedCase = playwrightPomJs._prepareCasesForStandardOutput([
      structuredClone(sourceCase),
    ])[0];
    const missingLocatorBoundary = (preparedCase.ir.runtimeEvidence || []).find(
      (step) => step?.failureBoundary?.code === 'missing_authoritative_action_locator',
    );
    const sources = emittedPomSources(output);
    const pageFiles = Object.keys(output.extraFiles).filter((file) =>
      /^pages\/.+Page\.js$/.test(file),
    );
    const locatorPath = Object.keys(output.extraFiles).find((file) =>
      /^locators\/generated\/.+\.generated\.locators\.js$/.test(file),
    );
    const locatorSource = output.extraFiles[locatorPath];
    const locatorManifest = JSON.parse(output.extraFiles['evidence/locator-manifest.json']);
    const guessedManifestEntry = locatorManifest.find(
      (entry) => entry.name === 'launchReportButton',
    );

    expect(pageFiles).toContain('pages/OdysseylogisticsPage.js');
    expect(pageFiles.join('\n')).not.toMatch(/(?:Root|Application|Workspace)Page\.js/);
    expect(locatorPath).toBe('locators/generated/odysseylogisticsPage.generated.locators.js');

    expect(locatorSource).toContain(
      'page.getByRole("textbox", { name: "Email Address", exact: true })',
    );
    expect(locatorSource).not.toContain('Narrated credential control');
    expect(locatorSource).not.toContain('page.getByRole("button", { name: "Launch report" })');
    expect(locatorSource).not.toContain('Launch report button on Odyssey dashboard');
    expect(locatorSource).not.toContain('QAAI_GUESSED_LOCATOR');
    expect(guessedManifestEntry).toBeUndefined();
    expect(missingLocatorBoundary).toMatchObject({
      executable: false,
      diagnosticOnly: true,
      failureBoundary: {
        code: 'missing_authoritative_action_locator',
        operation: 'click',
      },
      upstreamConductorRequirement: {
        code: 'UPSTREAM_CONDUCTOR_REQUIREMENT',
        consumer: 'playwrightPomJsStandardProfile.enforceVerifiedRunnableLocators',
      },
    });
    expect(missingLocatorBoundary.upstreamConductorRequirement.requiredFields).toEqual(
      expect.arrayContaining([
        'actionLocator.frameworkExpressions.playwright',
        'actionLocator.proof.actionTimeResolved',
        'actionLocator.proof.sameElement',
        'actionLocator.proof.count',
        'actionOccurrenceId',
      ]),
    );

    expect(output.content).toContain('await odysseylogisticsPage.openOdysseylogistics();');
    expect(output.content).toContain(
      'await odysseylogisticsPage.fillEmailAddress(readEnv("QAAI_USERNAME"));',
    );
    expect(output.content).not.toContain('clickLaunchReport');
    expect(output.extraFiles['pages/OdysseylogisticsPage.js']).toContain(
      'async fillEmailAddress(value)',
    );
    expect(output.extraFiles['pages/OdysseylogisticsPage.js']).not.toContain('clickLaunchReport');

    expect(output.extraFiles['tests/support/replayir.js']).toContain("String(value).trim() === ''");
    expect(output.extraFiles['pages/OdysseylogisticsPage.js']).toContain(
      'expect.soft(',
    );
    expect(output.extraFiles['pages/OdysseylogisticsPage.js']).toContain(
      'toBeVisible({ timeout: 10000 })',
    );
    expect(output.content).not.toContain('expect.soft(false');
    expect(sources).not.toMatch(
      /test\.info\(\)\.annotations|qaai-runtime-evidence|\.catch\(\(\) => \{\}\)|STATUS: DRAFT|case_step|runtime-attempt|manual_gate|\bTODO\b/i,
    );
    expect(output.content).not.toMatch(/test\.(?:skip|fixme)|describe\.skip/);

    const formattedFiles = await generatedOutputQuality.formatGeneratedFileMap({
      'tests/odyssey-root-journey.spec.js': output.content,
      ...output.extraFiles,
    });
    expect(formattedFiles[locatorPath]).toContain(
      'page.getByRole("textbox", { name: "Email Address", exact: true })',
    );
    const quality = await generatedOutputQuality.verifyGeneratedFileMap(formattedFiles);
    expect(quality).toMatchObject({
      ok: true,
      lintErrors: 0,
      unformatted: [],
    });
  }, 20_000);

  it('replaces a verified dynamic runtime id with the durable same-node DOM-atlas candidate', () => {
    const pageUrl = 'https://qa.odysseylogistics.com/order/create';
    const backendNodeId = 4343;
    const dynamicExpression =
      'locator("#pn_id_7").getByRole("button", { name: "dropdown trigger", exact: true })';
    const durableExpression =
      'locator("[formcontrolname=\'shipDirection\']").getByRole("button", { name: "dropdown trigger", exact: true })';
    const locator = persistedCdpLocatorRecipe(dynamicExpression, {
      role: 'button',
      accessibleName: 'dropdown trigger',
      pageUrl,
      backendNodeId,
    });
    const sourceCase = {
      caseName: 'Create order',
      ir: {
        caseId: 'create-order',
        domAtlas: domAtlasWithCandidates(pageUrl, [
          atlasCandidate(dynamicExpression, backendNodeId),
          atlasCandidate(durableExpression, backendNodeId),
        ]),
        steps: [
          { op: 'act', action: 'navigate', url: pageUrl, contractStepId: 'open-order' },
          {
            op: 'resolve',
            as: 'shipDirectionButton',
            pageUrl,
            contractStepId: 'choose-direction',
            actionOccurrenceId: 'create-order:choose-direction:click:1',
            actionLocator: locator,
          },
          {
            op: 'act',
            action: 'click',
            target: 'shipDirectionButton',
            contractStepId: 'choose-direction',
            actionOccurrenceId: 'create-order:choose-direction:click:1',
            actionLocator: locator,
          },
        ],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const resolve = prepared.ir.steps.find((step) => step.op === 'resolve');
    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Create order',
      moduleFormat: 'esm',
    });
    const sources = emittedPomSources(output);

    expect(resolve.actionLocator.frameworkExpressions.playwright).toBe(durableExpression);
    expect(resolve.actionLocator.locatorProvenance).toMatchObject({
      backendNodeId,
      durableExpressionSelectedFromDomAtlas: true,
    });
    expect(sources).toContain("[formcontrolname='shipDirection']");
    expect(sources).not.toContain('#pn_id_7');
    expect(output.content).toContain('await createOrderPage.clickShipDirection();');
  });

  it('derives a stable ancestor-scoped locator from authoritative capture instead of exporting a QAAI marker', () => {
    const pageUrl = 'https://qa.odysseylogistics.com/order/create';
    const backendNodeId = 4308;
    const markerExpression = 'locator("[data-qaai-cdp-action-target]")';
    const identity = { backendNodeId, connected: true };
    const capture = {
      identity,
      node: {
        localName: 'button',
        nodeName: 'BUTTON',
        attributes: {
          type: 'button',
          class:
            'p-element p-ripple p-autocomplete-dropdown p-button-icon-only p-button p-component ng-star-inserted',
          'data-qaai-cdp-action-target': 'temporary-marker',
        },
      },
      ancestry: [
        {
          localName: 'p-autocomplete',
          nodeName: 'P-AUTOCOMPLETE',
          attributes: { formcontrolname: 'equipment', placeholder: 'Search an equipment' },
        },
      ],
    };
    const markerCandidate = atlasCandidate(markerExpression, backendNodeId, capture);
    const locator = persistedCdpLocatorRecipe(markerExpression, {
      role: 'button',
      accessibleName: '',
      pageUrl,
      backendNodeId,
    });
    locator.candidates[0] = {
      ...locator.candidates[0],
      strategy: markerCandidate.strategy,
      matchedCapture: capture,
    };
    const sourceCase = {
      caseName: 'Create order',
      ir: {
        caseId: 'create-order-equipment',
        domAtlas: domAtlasWithCandidates(pageUrl, [markerCandidate]),
        steps: [
          { op: 'act', action: 'navigate', url: pageUrl, contractStepId: 'open-order' },
          {
            op: 'resolve',
            as: 'equipmentDropdownButton',
            pageUrl,
            contractStepId: 'open-equipment',
            actionOccurrenceId: 'create-order:open-equipment:click:1',
            actionLocator: locator,
          },
          {
            op: 'act',
            action: 'click',
            target: 'equipmentDropdownButton',
            contractStepId: 'open-equipment',
            actionOccurrenceId: 'create-order:open-equipment:click:1',
            actionLocator: locator,
          },
        ],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const resolve = prepared.ir.steps.find((step) => step.op === 'resolve');
    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Create order',
      moduleFormat: 'esm',
    });
    const sources = emittedPomSources(output);

    expect(resolve.actionLocator.frameworkExpressions.playwright).toBe(
      'locator("p-autocomplete[formcontrolname=\'equipment\']").locator("button.p-autocomplete-dropdown")',
    );
    expect(resolve.actionLocator.proof).toMatchObject({
      derivedFromAuthoritativeCapture: true,
      capturedBackendNodeId: backendNodeId,
    });
    expect(sources).toContain("p-autocomplete[formcontrolname='equipment']");
    expect(sources).not.toContain('data-qaai-cdp-action-target');
    expect(output.content).toContain('await createOrderPage.clickEquipmentDropdown();');
  });

  it('preserves a partial executable prefix and records the exact next authored boundary without synthesizing it', () => {
    const pageUrl = 'https://qa.odysseylogistics.com/order/create';
    const sourceCase = {
      caseName: 'Interrupted order flow',
      complete: false,
      gaps: [
        {
          code: 'missing_action_evidence',
          detail: 'One later authored action has no positive browser evidence.',
        },
      ],
      evidenceBuiltReplayIr: {
        evidenceStatus: 'capture_failed',
        missingEvidenceCount: 1,
      },
      declaredSteps: [
        {
          id: 'order-case:step:1:open-order',
          text: 'Open the order page.',
          action: 'navigate',
        },
        {
          id: 'order-case:step:2:submit-order',
          text: 'Submit the order.',
          action: 'click',
          target: 'Submit order',
        },
      ],
      ir: {
        caseId: 'order-case',
        steps: [
          {
            op: 'act',
            action: 'navigate',
            url: pageUrl,
            contractStepId: 'order-case:step:1:open-order',
            authored: true,
            executed: true,
          },
        ],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const boundary = prepared.ir.runtimeEvidence.find(
      (step) => step?.failureBoundary?.code === 'partial_run_evidence_boundary',
    );
    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Interrupted order flow',
      moduleFormat: 'esm',
    });

    expect(prepared.ir.steps.filter((step) => step.op === 'act')).toHaveLength(1);
    expect(boundary).toMatchObject({
      executable: false,
      diagnosticOnly: true,
      failureBoundary: {
        afterAuthoredStepNumber: 1,
        afterContractStepId: 'order-case:step:1:open-order',
        nextAuthoredStepNumber: 2,
        nextContractStepId: 'order-case:step:2:submit-order',
        nextPlannedText: 'Submit the order.',
        gapCodes: ['missing_action_evidence'],
        missingEvidenceCount: 1,
      },
    });
    expect(output.content).toContain('await createOrderPage.openCreateOrder();');
    expect(output.content).not.toMatch(/submitOrder|Submit the order/i);
    expect(output.content).not.toMatch(/test\.(?:skip|fixme)|describe\.skip/);
    expect(output.content).toContain(
      '// Execution evidence ended after authored step 1 (order-case:step:1:open-order). Authored step 2 (order-case:step:2:submit-order) was not executed; no executable code was generated beyond this boundary.',
    );
    expect(output.content.match(/Execution evidence ended after authored step/g)).toHaveLength(1);
  });

  it('uses a confirmed row binding before a generic environment placeholder', () => {
    const pageUrl = 'https://qa.odysseylogistics.com/order/create';
    const locator = verifiedActionLocator(
      'page.getByRole("textbox", { name: "Enter an ID", exact: true })',
      {
        role: 'textbox',
        accessibleName: 'Enter an ID',
        pageUrl,
        editable: true,
      },
    );
    const sourceCase = {
      caseName: 'Create order with captured data',
      ir: {
        caseId: 'create-order-data',
        dataRow: {
          index: 0,
          label: 'Row 1',
          fields: { order_number: '007995145' },
          sensitivity: { order_number: 'synthetic' },
        },
        steps: [
          { op: 'act', action: 'navigate', url: pageUrl, contractStepId: 'open-order' },
          {
            op: 'resolve',
            as: 'orderNumberField',
            pageUrl,
            contractStepId: 'enter-order-number',
            actionOccurrenceId: 'create-order:enter-order-number:fill:1',
            actionLocator: locator,
          },
          {
            op: 'act',
            action: 'fill',
            target: 'orderNumberField',
            contractStepId: 'enter-order-number',
            actionOccurrenceId: 'create-order:enter-order-number:fill:1',
            valueRef: 'env:QAAI_TEXTBOX',
            dataBinding: { isDataBound: true, refs: ['data.order_number'] },
            actionLocator: locator,
          },
        ],
      },
    };

    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Create order with captured data',
      moduleFormat: 'esm',
    });
    const dataFile = Object.entries(output.extraFiles).find(([file]) =>
      /^tests\/data\/.+\.json$/.test(file),
    );

    expect(output.content).toContain(
      'await createOrderPage.fillOrderNumber(readData(row, "order_number"));',
    );
    expect(output.content).not.toContain('QAAI_TEXTBOX');
    expect(output.content).not.toContain('undefined');
    expect(dataFile).toBeTruthy();
    expect(JSON.parse(dataFile[1])[0].fields.order_number).toBe('007995145');
  });
});
