import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const executionAuthoringCompiler = require('../../server/services/executionAuthoringCompiler.js');
const { buildExecutedCaseAstV1, validateExecutedCaseAstV1 } = require('../../server/services/codegen/executedCaseAst.js');
const stepCompilationLedger = require('../../server/services/codegen/stepCompilationLedger.js');
const executableTestContract = require('../../server/services/executableTestContract.js');

function actionIdentity(authoredActionId, sequenceIndex, overrides = {}) {
  const occurrenceOrdinal = overrides.occurrenceOrdinal ?? sequenceIndex;
  return {
    schemaVersion: 'qaai-action-identity-v1',
    caseId: 'tc-repeat',
    contractStepId: 'continue-step',
    sourceContractStepId: 'source-continue-step',
    authoredActionId,
    actionOccurrenceId: `continue-step:click:${occurrenceOrdinal}`,
    sourceActionOccurrenceId: `source-continue-step:click:${occurrenceOrdinal}`,
    sequenceIndex,
    authoredSequenceIndex: sequenceIndex,
    occurrenceOrdinal,
    toolUseId: `tool-${sequenceIndex}`,
    toolName: 'browser_click',
    operation: 'click',
    occurrenceKey: `tc-repeat:continue-step:${occurrenceOrdinal}:click`,
    ...overrides,
  };
}

function verifiedContinueLocator() {
  const backendNodeId = 'controlled:continue-button';
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'controlled-document:repeat',
    nodeId: backendNodeId,
    connected: true,
  };
  const expression = 'getByRole("button", { name: "Continue" })';
  return {
    kind: 'playwright',
    expression,
    frameworkExpressions: { playwright: expression },
    verified: true,
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    pageUrl: 'https://example.test/repeat',
    captureBinding: { kind: 'mcp_bound_ref', ref: backendNodeId },
    context: { captureBinding: { kind: 'mcp_bound_ref', ref: backendNodeId } },
    proof: {
      verified: true,
      count: 1,
      sameElement: true,
      visible: true,
      enabled: true,
      actionTimeResolved: true,
      actedNodeBound: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      expectedBackendNodeId: backendNodeId,
      resolvedBackendNodeId: backendNodeId,
      targetIdentity: identity,
      matchedIdentity: { ...identity },
    },
    targetFacts: { role: 'button', accessibleName: 'Continue', backendNodeId },
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      url: 'https://example.test/repeat',
      verifiedActions: [{
        expression,
        count: 1,
        sameElement: true,
        backendNodeId,
        targetIdentity: identity,
        matchedIdentity: { ...identity },
      }],
    },
  };
}

describe('authored action occurrence and assertion contract fidelity', () => {
  it('gives repeated identical actions distinct immutable identities', () => {
    const first = executionAuthoringCompiler.createDraft({
      testCaseId: 'tc-repeat',
      contractStepId: 'continue-step',
      sequenceIndex: 1,
      stepOrdinal: 1,
      toolName: 'browser_click',
      declaredStep: { action: 'Click', element: 'Continue' },
    });
    const second = executionAuthoringCompiler.createDraft({
      testCaseId: 'tc-repeat',
      contractStepId: 'continue-step',
      sequenceIndex: 2,
      stepOrdinal: 2,
      toolName: 'browser_click',
      declaredStep: { action: 'Click', element: 'Continue' },
    });

    expect(first.actionIdentity).toMatchObject({
      caseId: 'tc-repeat',
      contractStepId: 'continue-step',
      sequenceIndex: 1,
      toolName: 'browser_click',
      operation: 'click',
    });
    expect(second.actionIdentity.sequenceIndex).toBe(2);
    expect(first.authoredActionId).not.toBe(second.authoredActionId);
    expect(first.id).not.toBe(second.id);
  });

  it('preserves two identical clicks once, in order, and keeps assertion values and continuation policy', () => {
    const locator = verifiedContinueLocator();
    const firstIdentity = actionIdentity('continue-action-1', 1);
    const secondIdentity = actionIdentity('continue-action-2', 2);
    const ast = buildExecutedCaseAstV1({
      executionContract: {
        testCaseId: 'tc-repeat',
        failurePolicy: { onAssertionFailure: 'continue_independent' },
        nodes: [
          {
            contractStepId: 'continue-step', authoredActionId: 'continue-action-1', sequenceIndex: 1,
            actionIdentity: firstIdentity, stepOrdinal: 1, kind: 'action', actionType: 'click',
            plannedText: 'Click Continue', raw: { target: 'Continue' },
            waitContract: { kind: 'visible', expected: 'Continue', timeoutMs: 5000 },
          },
          {
            contractStepId: 'continue-step', authoredActionId: 'continue-action-2', sequenceIndex: 2,
            actionIdentity: secondIdentity, stepOrdinal: 2, kind: 'action', actionType: 'click',
            plannedText: 'Click Continue again', raw: { target: 'Continue' },
            waitContract: { kind: 'visible', expected: 'Continue', timeoutMs: 5000 },
          },
          {
            contractStepId: 'assert-status', assertionId: 'assert-status', stepOrdinal: 3,
            kind: 'assertion', expectedKind: 'UI_TEXT', plannedText: 'Status is ready',
            dataBinding: { expectedColumn: 'expected_status' },
            raw: { target: 'Status', continueOnFailure: true },
          },
          {
            contractStepId: 'assert-home', assertionId: 'assert-home', stepOrdinal: 4,
            kind: 'assertion', expectedKind: 'UI_TEXT', plannedText: 'Welcome is visible',
            expectedOutcome: { expected: 'Welcome' },
            raw: { target: 'Welcome', flowCritical: true },
          },
          {
            contractStepId: 'assert-authored-contract', assertionId: 'assert-authored-contract', stepOrdinal: 5,
            kind: 'assertion', expectedKind: 'URL', plannedText: 'Remain on the authored destination',
            raw: { instruction: 'Confirm the authored destination remains active.' },
          },
        ],
      },
      caseInstance: { testCaseId: 'tc-repeat', inlineData: { expected_status: 'Ready' } },
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'resolve', as: 'continueOne', actionLocator: locator },
            { op: 'act', action: 'click', target: 'continueOne', contractStepId: 'continue-step', authoredActionId: 'continue-action-1', sequenceIndex: 1, actionIdentity: firstIdentity },
            { op: 'resolve', as: 'continueTwo', actionLocator: locator },
            { op: 'act', action: 'click', target: 'continueTwo', contractStepId: 'continue-step', authoredActionId: 'continue-action-2', sequenceIndex: 2, actionIdentity: secondIdentity },
            { op: 'resolve', as: 'status', actionLocator: { ...locator, expression: 'getByText("Ready")', frameworkExpressions: { playwright: 'getByText("Ready")' } } },
            { op: 'assert', channel: 'UI_TEXT', target: 'status', contractRef: 'assert-status' },
            { op: 'resolve', as: 'welcome', actionLocator: { ...locator, expression: 'getByText("Welcome")', frameworkExpressions: { playwright: 'getByText("Welcome")' } } },
            { op: 'assert', channel: 'UI_TEXT', target: 'welcome', contractRef: 'assert-home' },
            { op: 'assert', channel: 'URL', contractRef: 'assert-authored-contract', missingAuthoredExpected: true, authoredContractText: 'Confirm the authored destination remains active.' },
          ],
        },
      },
    });

    expect(ast.nodes.filter((node) => node.kind === 'action')).toHaveLength(2);
    expect(ast.nodes.slice(0, 2).map((node) => node.authoredActionId)).toEqual(['continue-action-1', 'continue-action-2']);
    expect(ast.nodes.slice(0, 2).map((node) => node.stepId)).toEqual([
      'continue-step',
      'continue-step__occurrence_2',
    ]);
    expect(ast.source.unmatchedReplayOperations).toEqual([]);

    const status = ast.nodes.find((node) => node.stepId === 'assert-status').assertion;
    expect(status).toMatchObject({
      expected: 'Ready',
      hard: false,
      continuationPolicy: 'continue_independent',
      expectedResolution: { resolved: true, source: 'case_instance_inline_data:expected_status' },
    });
    const home = ast.nodes.find((node) => node.stepId === 'assert-home').assertion;
    expect(home).toMatchObject({ expected: 'Welcome', hard: true, continuationPolicy: 'stop_descendants' });
    const unresolved = ast.nodes.find((node) => node.stepId === 'assert-authored-contract').assertion;
    expect(unresolved).toMatchObject({
      expected: null,
      unresolvedExpected: true,
      authoredContractText: 'Confirm the authored destination remains active.',
      expectedResolution: { resolved: false },
    });
    expect(ast.validation.valid).toBe(true);
  });

  it('retains complete occurrence identity, binds reversed evidence exactly, and isolates retry evidence', () => {
    const firstIdentity = actionIdentity('continue-action-1', 1);
    const secondIdentity = actionIdentity('continue-action-2', 2);
    const firstLocator = {
      ...verifiedContinueLocator(),
      expression: 'getByTestId("continue-first")',
      frameworkExpressions: { playwright: 'getByTestId("continue-first")' },
    };
    const secondLocator = {
      ...verifiedContinueLocator(),
      expression: 'getByTestId("continue-second")',
      frameworkExpressions: { playwright: 'getByTestId("continue-second")' },
    };
    const retryLocator = {
      ...verifiedContinueLocator(),
      expression: 'getByTestId("continue-first-retry")',
      frameworkExpressions: { playwright: 'getByTestId("continue-first-retry")' },
    };
    const ast = buildExecutedCaseAstV1({
      executionContract: {
        testCaseId: 'tc-repeat',
        nodes: [
          {
            contractStepId: 'continue-step', stepOrdinal: 1, kind: 'action', actionType: 'click',
            plannedText: 'Click Continue', raw: { target: 'Continue' }, actionIdentity: firstIdentity,
            waitContract: { kind: 'visible', expected: 'Continue', timeoutMs: 5000 },
          },
          {
            contractStepId: 'continue-step', stepOrdinal: 2, kind: 'action', actionType: 'click',
            plannedText: 'Click Continue again', raw: { target: 'Continue' }, actionIdentity: secondIdentity,
            waitContract: { kind: 'visible', expected: 'Continue', timeoutMs: 5000 },
          },
        ],
      },
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'resolve', as: 'second', actionLocator: secondLocator },
            { op: 'act', action: 'click', target: 'second', contractStepId: 'continue-step', actionIdentity: secondIdentity },
            { op: 'resolve', as: 'first', actionLocator: firstLocator },
            { op: 'act', action: 'click', target: 'first', contractStepId: 'continue-step', actionIdentity: firstIdentity },
            { op: 'resolve', as: 'firstRetry', actionLocator: retryLocator },
            { op: 'act', action: 'click', target: 'firstRetry', contractStepId: 'continue-step', actionIdentity: firstIdentity, retryAttempt: 2 },
          ],
        },
      },
    });

    expect(ast.nodes).toHaveLength(2);
    expect(ast.nodes.map((node) => ast.symbolTable.targets[node.targetId].expression)).toEqual([
      'getByTestId("continue-first")',
      'getByTestId("continue-second")',
    ]);
    expect(ast.nodes[0]).toMatchObject({
      contractStepId: 'continue-step',
      sourceContractStepId: 'source-continue-step',
      authoredActionId: 'continue-action-1',
      actionOccurrenceId: 'continue-step:click:1',
      sourceActionOccurrenceId: 'source-continue-step:click:1',
      sequenceIndex: 1,
      authoredSequenceIndex: 1,
      occurrenceOrdinal: 1,
      occurrenceKey: 'tc-repeat:continue-step:1:click',
      actionIdentity: firstIdentity,
    });
    expect(ast.symbolTable.steps[ast.nodes[0].stepId]).toMatchObject({
      authoredActionId: 'continue-action-1',
      actionOccurrenceId: 'continue-step:click:1',
      sourceActionOccurrenceId: 'source-continue-step:click:1',
      authoredSequenceIndex: 1,
      occurrenceOrdinal: 1,
      occurrenceKey: 'tc-repeat:continue-step:1:click',
    });
    expect(ast.source.unmatchedReplayOperations).toEqual([
      expect.objectContaining({
        op: 'act',
        actionOccurrenceId: 'continue-step:click:1',
        sourceActionOccurrenceId: 'source-continue-step:click:1',
        authoredActionId: 'continue-action-1',
        occurrenceOrdinal: 1,
      }),
    ]);
    expect(ast.validation.valid).toBe(true);

    const corrupted = structuredClone(ast);
    corrupted.nodes[1].actionIdentity.actionOccurrenceId = firstIdentity.actionOccurrenceId;
    corrupted.nodes[1].actionOccurrenceId = firstIdentity.actionOccurrenceId;
    corrupted.symbolTable.steps[corrupted.nodes[1].stepId].actionIdentity = {
      ...corrupted.nodes[1].actionIdentity,
      actionOccurrenceId: 'symbol-only-occurrence',
    };
    const validation = validateExecutedCaseAstV1(corrupted);
    expect(validation.findings.map((finding) => finding.rule)).toEqual(expect.arrayContaining([
      'ast_step_identity_mismatch',
      'ast_action_occurrence_duplicate',
    ]));
  });

  it('never binds a replay action carrying a stable foreign occurrence identity', () => {
    const authoredIdentity = actionIdentity('continue-action-1', 1);
    const foreignIdentity = actionIdentity('foreign-action', 9, {
      caseId: 'tc-repeat',
      actionOccurrenceId: 'foreign-occurrence',
      sourceActionOccurrenceId: 'foreign-source-occurrence',
      occurrenceKey: 'tc-repeat:foreign:9:click',
    });
    const authoredLocator = {
      ...verifiedContinueLocator(),
      expression: 'getByTestId("authored-continue")',
      frameworkExpressions: { playwright: 'getByTestId("authored-continue")' },
    };
    const foreignLocator = {
      ...verifiedContinueLocator(),
      expression: 'getByTestId("foreign-continue")',
      frameworkExpressions: { playwright: 'getByTestId("foreign-continue")' },
    };
    const ast = buildExecutedCaseAstV1({
      executionContract: {
        testCaseId: 'tc-repeat',
        nodes: [{
          contractStepId: 'continue-step', stepOrdinal: 1, kind: 'action', actionType: 'click',
          plannedText: 'Click Continue', raw: { target: 'Continue' }, actionIdentity: authoredIdentity,
          actionLocator: authoredLocator,
          waitContract: { kind: 'visible', expected: 'Continue', timeoutMs: 5000 },
        }],
      },
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'resolve', as: 'foreign', actionLocator: foreignLocator },
            { op: 'act', action: 'click', target: 'foreign', contractStepId: 'continue-step', actionIdentity: foreignIdentity },
          ],
        },
      },
    });

    expect(ast.nodes).toHaveLength(1);
    expect(ast.nodes[0].actionOccurrenceId).toBe(authoredIdentity.actionOccurrenceId);
    expect(ast.symbolTable.targets[ast.nodes[0].targetId].expression).toBe('getByTestId("authored-continue")');
    expect(ast.source.unmatchedReplayOperations).toEqual([
      expect.objectContaining({ actionOccurrenceId: 'foreign-occurrence', authoredActionId: 'foreign-action' }),
    ]);
    expect(ast.validation.valid, JSON.stringify(ast.validation.findings)).toBe(true);
  });

  it('maps legacy identity-free repeated actions one-to-one in authored order', () => {
    const firstLocator = {
      ...verifiedContinueLocator(),
      expression: 'getByTestId("legacy-first")',
      frameworkExpressions: { playwright: 'getByTestId("legacy-first")' },
    };
    const secondLocator = {
      ...verifiedContinueLocator(),
      expression: 'getByTestId("legacy-second")',
      frameworkExpressions: { playwright: 'getByTestId("legacy-second")' },
    };
    const ast = buildExecutedCaseAstV1({
      executionContract: {
        testCaseId: 'tc-legacy-repeat',
        nodes: [
          {
            contractStepId: 'continue-step', stepOrdinal: 1, kind: 'action', actionType: 'click',
            plannedText: 'Click Continue', raw: { target: 'Continue' },
            waitContract: { kind: 'visible', expected: 'Continue', timeoutMs: 5000 },
          },
          {
            contractStepId: 'continue-step', stepOrdinal: 2, kind: 'action', actionType: 'click',
            plannedText: 'Click Continue again', raw: { target: 'Continue' },
            waitContract: { kind: 'visible', expected: 'Continue', timeoutMs: 5000 },
          },
        ],
      },
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'resolve', as: 'legacyFirst', actionLocator: firstLocator },
            { op: 'act', action: 'click', target: 'legacyFirst', contractRef: 'runtime-first' },
            { op: 'resolve', as: 'legacySecond', actionLocator: secondLocator },
            { op: 'act', action: 'click', target: 'legacySecond', contractRef: 'runtime-second' },
          ],
        },
      },
    });

    expect(ast.nodes).toHaveLength(2);
    expect(ast.nodes.map((node) => ast.symbolTable.targets[node.targetId].expression)).toEqual([
      'getByTestId("legacy-first")',
      'getByTestId("legacy-second")',
    ]);
    expect(new Set(ast.nodes.map((node) => node.actionOccurrenceId)).size).toBe(2);
    expect(ast.source.unmatchedReplayOperations).toEqual([]);
    expect(ast.validation.valid, JSON.stringify(ast.validation.findings)).toBe(true);
  });

  it('coalesces replay-only retries with the same occurrence into diagnostic evidence', () => {
    const locator = verifiedContinueLocator();
    const identity = actionIdentity('continue-action-1', 1);
    const ast = buildExecutedCaseAstV1({
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'resolve', as: 'continue', actionLocator: locator },
            { op: 'act', action: 'click', target: 'continue', actionIdentity: identity, postcondition: { kind: 'visible', expected: 'Ready' } },
            { op: 'act', action: 'click', target: 'continue', actionIdentity: identity, retryAttempt: 2, postcondition: { kind: 'visible', expected: 'Ready' } },
          ],
        },
      },
    });

    expect(ast.nodes).toHaveLength(1);
    expect(ast.nodes[0].actionOccurrenceId).toBe(identity.actionOccurrenceId);
    expect(ast.source.unmatchedReplayOperations).toEqual([
      expect.objectContaining({ actionOccurrenceId: identity.actionOccurrenceId, authoredActionId: identity.authoredActionId }),
    ]);
    expect(ast.validation.valid).toBe(true);
  });

  it('retains the exact verified locator and complete popup frame shadow and CDP context on nodes and targets', () => {
    const cdpNodeIdentity = {
      scheme: 'qaai-cdp-backend-node-v1',
      backendNodeId: 771,
      nodeId: 91,
      frameId: 'frame-payment',
      documentId: 'document-payment',
      documentUrl: 'https://payments.example.test/confirm',
      connected: true,
    };
    const pageIdentity = {
      pageId: 'page-checkout-popup',
      openerPageId: 'page-checkout',
      url: 'https://payments.example.test/confirm',
    };
    const popupIdentity = {
      popupId: 'popup-payment',
      openerPageId: 'page-checkout',
      url: 'https://payments.example.test/confirm',
    };
    const frameIdentity = {
      frameId: 'frame-payment',
      parentFrameId: 'frame-shell',
      name: 'payment-frame',
      url: 'https://payments.example.test/embedded',
    };
    const cdpFramePath = [
      { frameId: 'frame-shell', backendNodeId: 401, selector: 'iframe#shell' },
      { frameId: 'frame-payment', backendNodeId: 402, selector: 'iframe#payment' },
    ];
    const cdpShadowPath = [
      { backendNodeId: 501, selector: 'account-shell', mode: 'open' },
      { backendNodeId: 502, selector: 'payment-widget', mode: 'open' },
    ];
    const shadowRootChain = [
      { hostBackendNodeId: 501, rootBackendNodeId: 601, mode: 'open' },
      { hostBackendNodeId: 502, rootBackendNodeId: 602, mode: 'open' },
    ];
    const capture = {
      schema: 'qaai-authoritative-cdp-capture/1',
      captured: true,
      authoritative: true,
      source: 'chromium_cdp_dom_snapshot_accessibility',
      phase: 'pre_action',
      identity: cdpNodeIdentity,
      backendNodeId: 771,
      pageIdentity,
      popupIdentity,
      frameIdentity,
      framePath: cdpFramePath,
      framePathSelectors: ['iframe#shell', 'iframe#payment'],
      shadowPath: cdpShadowPath,
      accessibility: { role: 'button', name: 'Confirm payment', backendDOMNodeId: 771 },
      node: { localName: 'button', attributes: { 'data-testid': 'confirm-payment' } },
    };
    const browserContext = {
      pageAlias: 'checkoutPopup',
      tabAlias: 'paymentTab',
      pageIdentity,
      popupIdentity,
      frameIdentity,
      framePath: ['iframe#shell', 'iframe#payment'],
      cdpFramePath,
      shadowPath: ['account-shell', 'payment-widget'],
      cdpShadowPath,
      shadowHostChain: cdpShadowPath,
      shadowRootChain,
      captureBinding: { kind: 'mcp_bound_ref', ref: 'confirm-payment-ref' },
      authoritativeCdp: {
        pre: capture,
        post: { ...capture, phase: 'post_action' },
        reverification: {
          source: 'chromium_cdp_dom_snapshot_accessibility',
          expression: 'frameLocator("iframe#shell").frameLocator("iframe#payment").locator("account-shell").locator("payment-widget").getByRole("button", { name: "Confirm payment" })',
          expectedBackendNodeId: 771,
          backendNodeIdBefore: 771,
          backendNodeIdAfter: 771,
          countBefore: 1,
          countAfter: 1,
          exactPageId: 'page-checkout-popup',
          framePath: ['iframe#shell', 'iframe#payment'],
          shadowPath: cdpShadowPath,
          stableAcrossSnapshots: true,
        },
      },
    };
    const expression = 'frameLocator("iframe#shell").frameLocator("iframe#payment").locator("account-shell").locator("payment-widget").getByRole("button", { name: "Confirm payment" })';
    const verifiedLocator = {
      strategy: 'role',
      expression,
      frameworkExpressions: { playwright: expression },
      verificationSource: 'chromium_cdp_dom_snapshot_accessibility',
      verified: true,
      targetIdentity: cdpNodeIdentity,
      targetFacts: {
        role: 'button',
        accessibleName: 'Confirm payment',
        cdpBackendNodeId: 771,
        cdpFrameId: 'frame-payment',
        cdpDocumentUrl: 'https://payments.example.test/confirm',
        testIds: { 'data-testid': 'confirm-payment' },
      },
      context: browserContext,
      proof: {
        source: 'chromium_cdp_dom_snapshot_accessibility',
        verified: true,
        sameElement: true,
        count: 1,
        countBefore: 1,
        countAfter: 1,
        actionTimeResolved: true,
        actedNodeBound: true,
        identityVerified: true,
        authoritativeCdpVerified: true,
        backendNodeVerified: true,
        stableAcrossSnapshots: true,
        targetIdentity: cdpNodeIdentity,
        matchedIdentity: { ...cdpNodeIdentity },
      },
      uniquenessProof: { verified: true, count: 1, sameElement: true, stableAcrossSnapshots: true },
      locatorProvenance: {
        kind: 'action_time_authoritative_cdp',
        source: 'chromium_cdp_dom_snapshot_accessibility',
        confidence: 'verified',
      },
      contextEvidence: {
        backendNodeId: 771,
        pageIdentity,
        popupIdentity,
        frameIdentity,
        framePath: ['iframe#shell', 'iframe#payment'],
        shadowPath: ['account-shell', 'payment-widget'],
      },
      domAtlas: {
        url: 'https://payments.example.test/confirm',
        frames: cdpFramePath,
        shadowHosts: cdpShadowPath,
      },
    };
    const identity = actionIdentity('confirm-payment-action', 1, {
      contractStepId: 'confirm-payment-step',
      sourceContractStepId: 'source-confirm-payment-step',
      actionOccurrenceId: 'confirm-payment-step:click:1',
      sourceActionOccurrenceId: 'source-confirm-payment-step:click:1',
      occurrenceKey: 'tc-repeat:confirm-payment-step:1:click',
    });
    const ast = buildExecutedCaseAstV1({
      executionContract: {
        testCaseId: 'tc-repeat',
        nodes: [{
          contractStepId: 'confirm-payment-step', stepOrdinal: 1, kind: 'action', actionType: 'click',
          plannedText: 'Confirm payment', raw: { target: 'Confirm payment' }, actionIdentity: identity,
          waitContract: { kind: 'visible', expected: 'Payment confirmation', timeoutMs: 10_000 },
        }],
      },
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'resolve', as: 'confirmPayment', actionLocator: verifiedLocator },
            { op: 'act', action: 'click', target: 'confirmPayment', contractStepId: 'confirm-payment-step', actionIdentity: identity },
          ],
        },
      },
    });

    const node = ast.nodes[0];
    const target = ast.symbolTable.targets[node.targetId];
    for (const projection of [node, target]) {
      expect(projection.locatorExpression).toBe(expression);
      expect(projection.locatorEvidenceKind).toBe('actionLocator');
      expect(projection.actionLocator).toEqual(verifiedLocator);
      expect(projection.locatorEvidence).toEqual(verifiedLocator);
      expect(JSON.stringify(projection.actionLocator)).toBe(JSON.stringify(verifiedLocator));
      expect(JSON.stringify(projection.locatorEvidence)).toBe(JSON.stringify(verifiedLocator));
      expect(projection.browserContext).toEqual(browserContext);
      expect(JSON.stringify(projection.browserContext)).toBe(JSON.stringify(browserContext));
      expect(projection.pageIdentity).toEqual(pageIdentity);
      expect(projection.popupIdentity).toEqual(popupIdentity);
      expect(projection.pageAlias).toBe('checkoutPopup');
      expect(projection.tabAlias).toBe('paymentTab');
      expect(projection.frameIdentity).toEqual(frameIdentity);
      expect(projection.frameId).toBe('frame-payment');
      expect(projection.frameChain).toEqual(['iframe#shell', 'iframe#payment']);
      expect(projection.shadowHostChain).toEqual(cdpShadowPath);
      expect(projection.shadowRootChain).toEqual(shadowRootChain);
      expect(projection.backendNodeId).toBe(771);
      expect(projection.cdpNodeIdentity).toEqual(cdpNodeIdentity);
      expect(projection.authoritativeCdp).toEqual(browserContext.authoritativeCdp);
      expect(projection.proof).toEqual(verifiedLocator.proof);
      expect(projection.uniquenessProof).toEqual(verifiedLocator.uniquenessProof);
      expect(projection.locatorProvenance).toEqual(verifiedLocator.locatorProvenance);
      expect(projection.contextEvidence).toEqual(verifiedLocator.contextEvidence);
      expect(projection.domAtlas).toEqual(verifiedLocator.domAtlas);
    }
    expect(ast.validation.valid, JSON.stringify(ast.validation.findings)).toBe(true);
  });

  it('pairs and proves the second identical call against the second source occurrence', () => {
    const steps = [
      { op: 'resolve', as: 'continueOne', candidates: [{ strategy: 'role', role: 'button', name: 'Continue' }] },
      { op: 'act', action: 'click', target: 'continueOne', contractStepId: 'continue-step', authoredActionId: 'continue-action-1', sequenceIndex: 1, actionIdentity: actionIdentity('continue-action-1', 1) },
      { op: 'resolve', as: 'continueTwo', candidates: [{ strategy: 'role', role: 'button', name: 'Continue' }] },
      { op: 'act', action: 'click', target: 'continueTwo', contractStepId: 'continue-step', authoredActionId: 'continue-action-2', sequenceIndex: 2, actionIdentity: actionIdentity('continue-action-2', 2) },
    ];
    const result = {
      testCaseId: 'tc-repeat',
      runResultId: 'rr-repeat',
      declaredSteps: [
        { id: 'continue-step', contractStepId: 'continue-step', authoredActionId: 'continue-action-1', sequenceIndex: 1, action: 'click', target: 'Continue', text: 'Click Continue' },
        { id: 'continue-step', contractStepId: 'continue-step', authoredActionId: 'continue-action-2', sequenceIndex: 2, action: 'click', target: 'Continue', text: 'Click Continue again' },
      ],
      envelope: { findings: [], ir: { steps } },
    };
    const report = stepCompilationLedger.buildStepCompilationLedger({
      results: [result],
      admitted: [{ testCaseId: 'tc-repeat', filePath: 'repeat.spec.js' }],
      blocked: [],
      files: { 'repeat.spec.js': 'await page.clickContinue();\nawait page.clickContinue();\n' },
      adapterId: 'playwright-pom',
    });

    expect(report.cases[0].ledger.map((row) => ({
      authoredActionId: row.authoredActionId,
      sequenceIndex: row.sequenceIndex,
      sourceLine: row.exportedSpecLine,
      status: row.exportStatus,
    }))).toEqual([
      { authoredActionId: 'continue-action-1', sequenceIndex: 1, sourceLine: 1, status: 'exported' },
      { authoredActionId: 'continue-action-2', sequenceIndex: 2, sourceLine: 2, status: 'exported' },
    ]);
    expect(report.summary.replayOnly).toBe(0);
    expect(report.summary.blockedInternal).toBe(0);
  });

  it('consumes repeated contract nodes once and prefers runtime evidence over a synthesized duplicate', () => {
    const graph = executableTestContract.buildActionGraph({
      contract: {
        contractId: 'repeat-contract',
        nodes: [
          { contractStepId: 'continue-step', testCaseId: 'tc-repeat', stepOrdinal: 1, kind: 'action', actionType: 'click', plannedText: 'Click Continue' },
          { contractStepId: 'continue-step', testCaseId: 'tc-repeat', stepOrdinal: 2, kind: 'action', actionType: 'click', plannedText: 'Click Continue again' },
        ],
      },
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'act', action: 'click', contractStepId: 'continue-step', authoredActionId: 'continue-action-1', sequenceIndex: 1, actionIdentity: actionIdentity('continue-action-1', 1) },
            { op: 'act', action: 'click', contractStepId: 'continue-step', authoredActionId: 'continue-action-2', sequenceIndex: 2, actionIdentity: actionIdentity('continue-action-2', 2) },
            { op: 'act', action: 'click', contractStepId: 'continue-step', synthesizedFromContract: true },
          ],
        },
      },
      status: 'pass',
    });

    expect(graph.nodes.map((node) => node.replayStep && node.replayStep.authoredActionId)).toEqual([
      'continue-action-1',
      'continue-action-2',
    ]);
    expect(graph.nodes.every((node) => node.replayStep?.synthesizedFromContract === false)).toBe(true);
  });
});
