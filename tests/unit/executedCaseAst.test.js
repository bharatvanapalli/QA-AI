import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const executableTestContract = require('../../server/services/executableTestContract');
const replayExport = require('../../server/services/codegen/replayExport');
const {
  AST_SCHEMA,
  WAIT_SCHEMA,
  buildExecutedCaseAstV1,
  validateExecutedCaseAstV1,
} = require('../../server/services/codegen/executedCaseAst');

function verifiedLocator(expression, accessibleName) {
  const nodeId = String(accessibleName || 'target').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'target';
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'document-test',
    nodeId,
    connected: true,
  };
  return {
    expression,
    frameworkExpressions: { playwright: expression },
    verificationSource: 'verified_dom_inspection',
    verified: true,
    targetFacts: { accessibleName },
    captureBinding: { kind: 'mcp_bound_ref', ref: nodeId },
    proof: {
      source: 'verified_dom_inspection',
      verified: true,
      count: 1,
      sameElement: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
    },
    domAtlas: { verifiedActions: [{ nodeId }] },
  };
}

describe('ExecutedCaseASTV1', () => {
  it('uses committed ActionGraph nodes as the authoritative executable source when present', () => {
    const continueLocator = verifiedLocator(
      'getByRole("button", { name: "Continue", exact: true })',
      'Continue',
    );
    const microsoftLocator = verifiedLocator(
      'getByRole("button", { name: "Sign in with Microsoft", exact: true })',
      'Sign in with Microsoft',
    );
    const ast = buildExecutedCaseAstV1({
      status: 'pass',
      executionContract: {
        testCaseId: 'tc-graph-authority',
        nodes: [
          {
            contractStepId: 'authored-only-never-executed',
            stepOrdinal: 1,
            kind: 'action',
            actionType: 'click',
            plannedText: 'Click a button that was never committed by the browser',
            raw: { target: 'Never executed' },
          },
          {
            contractStepId: 'continue-click',
            stepOrdinal: 2,
            kind: 'action',
            actionType: 'click',
            plannedText: 'Authored continue text',
            raw: { target: 'Continue' },
          },
        ],
      },
      actionGraph: {
        schema: 'qaai-certified-action-graph/1',
        nodes: [
          {
            contractStepId: 'continue-click',
            stepOrdinal: 2,
            kind: 'action',
            actionType: 'click',
            plannedText: 'Committed continue click',
            actionLocator: continueLocator,
            postcondition: { kind: 'visible', expected: 'Sign in with Microsoft' },
            raw: { target: 'Continue' },
          },
          {
            contractStepId: 'microsoft-click',
            stepOrdinal: 3,
            kind: 'action',
            actionType: 'click',
            plannedText: 'Committed Microsoft sign-in click',
            actionLocator: microsoftLocator,
            postcondition: { kind: 'visible', expected: 'Microsoft sign-in page' },
            raw: { target: 'Sign in with Microsoft' },
          },
        ],
      },
      replayEnvelope: {
        ir: {
          steps: [
            {
              op: 'act',
              action: 'click',
              contractStepId: 'continue-click',
              actionLocator: continueLocator,
              targetLabel: 'Continue',
              postcondition: { kind: 'visible', expected: 'Sign in with Microsoft' },
            },
            {
              op: 'act',
              action: 'click',
              contractStepId: 'microsoft-click',
              actionLocator: microsoftLocator,
              targetLabel: 'Sign in with Microsoft',
              postcondition: { kind: 'visible', expected: 'Microsoft sign-in page' },
            },
          ],
        },
      },
    });
    expect(ast.nodes.map((node) => node.contractStepId)).toEqual([
      'continue-click',
      'microsoft-click',
    ]);
    expect(ast.nodes.map((node) => node.plannedText)).toEqual([
      'Committed continue click',
      'Committed Microsoft sign-in click',
    ]);
    expect(JSON.stringify(ast)).not.toContain('authored-only-never-executed');
    expect(ast.validation.valid, JSON.stringify(ast.validation.findings)).toBe(true);
  });

  it('records the executed prefix and exact failure boundary without emitting later authored-only steps', () => {
    const continueLocator = verifiedLocator(
      'getByRole("button", { name: "Continue", exact: true })',
      'Continue',
    );
    const alertLocator = verifiedLocator(
      'getByRole("status", { name: "Approval status" })',
      'Approval status',
    );
    const ast = buildExecutedCaseAstV1({
      status: 'failed',
      executionContract: {
        testCaseId: 'tc-prefix-boundary',
        nodes: [
          {
            contractStepId: 'click-continue',
            stepOrdinal: 1,
            kind: 'action',
            actionType: 'click',
            plannedText: 'Click Continue',
            raw: { target: 'Continue' },
          },
          {
            contractStepId: 'assert-approved',
            stepOrdinal: 2,
            kind: 'assertion',
            actionType: 'assert',
            expectedOutcome: { kind: 'UI_TEXT', expected: 'Approved' },
            raw: { target: 'Approval status', expectedText: 'Approved' },
          },
          {
            contractStepId: 'authored-after-failure',
            stepOrdinal: 3,
            kind: 'action',
            actionType: 'click',
            plannedText: 'Click a later authored-only button',
            raw: { target: 'Later button' },
          },
        ],
      },
      actionGraph: {
        schema: 'qaai-certified-action-graph/1',
        nodes: [
          {
            contractStepId: 'click-continue',
            stepOrdinal: 1,
            kind: 'action',
            actionType: 'click',
            plannedText: 'Committed Continue click',
            actionLocator: continueLocator,
            postcondition: { kind: 'visible', expected: 'Approval status' },
            raw: { target: 'Continue' },
          },
          {
            contractStepId: 'assert-approved',
            stepOrdinal: 2,
            kind: 'assertion',
            actionType: 'assert',
            expectedOutcome: { kind: 'UI_TEXT', expected: 'Approved' },
            locatorRecipe: alertLocator,
            raw: { target: 'Approval status', expectedText: 'Approved' },
          },
        ],
      },
      replayEnvelope: {
        ir: {
          steps: [
            {
              op: 'act',
              action: 'click',
              contractStepId: 'click-continue',
              actionLocator: continueLocator,
              postcondition: { kind: 'visible', expected: 'Approval status' },
            },
            {
              op: 'assert',
              contractRef: 'assert-approved',
              channel: 'UI_TEXT',
              target: 'approval-status',
              expected: 'Approved',
              liveOutcome: 'not_matched',
              actionLocator: alertLocator,
            },
          ],
        },
      },
      stepJournal: [
        { stepId: 'click-continue', actionOutcome: 'succeeded', continuationOutcome: 'continue' },
        {
          stepId: 'assert-approved',
          assertionOutcome: 'not_matched',
          continuationOutcome: 'stop_case',
          failureClassification: 'product_failure',
          expectedState: 'Approved',
          observedState: 'Rejected',
        },
      ],
    });

    expect(ast.nodes.map((node) => node.contractStepId)).toEqual([
      'click-continue',
      'assert-approved',
    ]);
    expect(JSON.stringify(ast)).not.toContain('authored-after-failure');
    expect(ast.source.executedPrefix).toMatchObject({
      schema: 'qaai-executed-prefix-projection/1',
      generatedFromExecutedBrowserEvidenceOnly: true,
      executableNodeCount: 2,
      totalProjectedNodeCount: 2,
      unmatchedAuthoredCount: 0,
      stepIds: ['click-continue', 'assert-approved'],
    });
    expect(ast.source.failureBoundary).toMatchObject({
      stepId: 'assert-approved',
      contractStepId: 'assert-approved',
      kind: 'assertion',
      assertionOutcome: 'not_matched',
      continuationOutcome: 'stop_case',
      failureClassification: 'product_failure',
      includedInExecutablePrefix: true,
    });
    expect(ast.case.executedPrefix.failureBoundary.stepId).toBe('assert-approved');
    expect(ast.case.expectedVerdict).toBe('fail');
    expect(ast.validation.valid, JSON.stringify(ast.validation.findings)).toBe(true);
  });

  it('joins contract, ReplayIR, case data, and the enriched journal into compiler-owned symbols', () => {
    const emailLocator = verifiedLocator('getByLabel("Email address")', 'Email address');
    const passwordLocator = verifiedLocator('getByLabel("Password")', 'Password');
    const submitLocator = verifiedLocator('getByRole("button", { name: "Sign in" })', 'Sign in');
    const ast = buildExecutedCaseAstV1({
      status: 'pass',
      executionContract: {
        schema: 'qaai-executable-test-contract/1',
        contractId: 'etc-login',
        testCaseId: 'tc-login',
        testCaseName: 'Repeated identity prompt',
        nodes: [
          { contractStepId: 's1', stepOrdinal: 1, kind: 'action', actionType: 'navigate', plannedText: 'Open identity page', raw: { url: 'https://example.test/login' } },
          { contractStepId: 's2', stepOrdinal: 2, kind: 'action', actionType: 'fill', plannedText: 'Enter email', dataBinding: { isDataBound: true, sourceColumn: 'email' }, raw: { target: 'Email address' } },
          { contractStepId: 's3', stepOrdinal: 3, kind: 'action', actionType: 'fill', plannedText: 'Enter email again', dataBinding: { isDataBound: true, sourceColumn: 'email' }, raw: { target: 'Email address' } },
          { contractStepId: 's4', stepOrdinal: 4, kind: 'action', actionType: 'fill', plannedText: 'Enter password', dataBinding: { isDataBound: true, sourceColumn: 'password' }, raw: { target: 'Password' } },
          { contractStepId: 's5', stepOrdinal: 5, kind: 'action', actionType: 'click', plannedText: 'Submit', raw: { target: 'Sign in' }, postcondition: { kind: 'url', expected: '/dashboard' } },
        ],
      },
      caseInstance: {
        id: 'ci-login-row-1',
        revision: 7,
        generationId: 'gen-7',
        inlineData: {
          email: 'tester@example.test',
          password: { value: 'SuperSecret123!', sensitive: true },
        },
      },
      actionGraph: {
        schema: 'qaai-certified-action-graph/1',
        nodes: [
          { contractStepId: 's1', stepOrdinal: 1, kind: 'action', actionType: 'navigate', plannedText: 'Open identity page', raw: { url: 'https://example.test/login' } },
          { contractStepId: 's2', stepOrdinal: 2, kind: 'action', actionType: 'fill', plannedText: 'Enter email', dataBinding: { isDataBound: true, sourceColumn: 'email' }, actionLocator: emailLocator, raw: { target: 'Email address' } },
          { contractStepId: 's3', stepOrdinal: 3, kind: 'action', actionType: 'fill', plannedText: 'Enter email again', dataBinding: { isDataBound: true, sourceColumn: 'email' }, actionLocator: emailLocator, raw: { target: 'Email address' } },
          { contractStepId: 's4', stepOrdinal: 4, kind: 'action', actionType: 'fill', plannedText: 'Enter password', dataBinding: { isDataBound: true, sourceColumn: 'password' }, actionLocator: passwordLocator, raw: { target: 'Password' } },
          { contractStepId: 's5', stepOrdinal: 5, kind: 'action', actionType: 'click', plannedText: 'Submit', actionLocator: submitLocator, raw: { target: 'Sign in' }, postcondition: { kind: 'url', expected: '/dashboard' } },
        ],
      },
      replayEnvelope: {
        complete: true,
        ir: {
          steps: [
            { op: 'act', action: 'navigate', url: 'https://example.test/login', contractRef: 's1' },
            { op: 'resolve', as: 'emailOne', actionLocator: emailLocator },
            { op: 'act', action: 'fill', target: 'emailOne', valueRef: 'data:email', contractRef: 's2' },
            { op: 'resolve', as: 'emailTwo', actionLocator: emailLocator },
            { op: 'act', action: 'fill', target: 'emailTwo', valueRef: 'data:email', contractRef: 's3' },
            { op: 'resolve', as: 'password', actionLocator: passwordLocator },
            { op: 'act', action: 'fill', target: 'password', valueRef: 'env:LOGIN_PASSWORD', contractRef: 's4' },
            { op: 'resolve', as: 'submit', actionLocator: submitLocator },
            { op: 'act', action: 'click', target: 'submit', contractRef: 's5', postcondition: { kind: 'url', expected: '/dashboard' } },
          ],
        },
      },
      stepJournal: [
        { stepId: 's1', actionOutcome: 'succeeded', continuationOutcome: 'continue' },
        { stepId: 's2', actionOutcome: 'succeeded', continuationOutcome: 'continue' },
        { stepId: 's3', actionOutcome: 'succeeded', continuationOutcome: 'continue' },
        { stepId: 's4', actionOutcome: 'succeeded', continuationOutcome: 'continue', attempts: [{ target: 'Password', value: 'must-not-leak' }] },
        { stepId: 's5', actionOutcome: 'succeeded', continuationOutcome: 'continue' },
      ],
    });

    expect(ast.schema).toBe(AST_SCHEMA);
    expect(ast.nodes.map((node) => node.type)).toEqual(['Navigate', 'Fill', 'Fill', 'Fill', 'Click']);
    expect(ast.nodes[1].dataRef).toBe(ast.nodes[2].dataRef);
    expect(ast.symbolTable.data[ast.nodes[1].dataRef]).toMatchObject({ kind: 'fixture', value: 'tester@example.test' });
    expect(ast.symbolTable.data[ast.nodes[3].dataRef]).toMatchObject({ kind: 'env', envName: 'LOGIN_PASSWORD', sensitive: true });
    expect(ast.symbolTable.data[ast.nodes[3].dataRef]).not.toHaveProperty('value');
    expect(ast.nodes.every((node) => node.methodId && ast.symbolTable.methods[node.methodId])).toBe(true);
    expect(ast.nodes.every((node) => node.waitContract?.schema === WAIT_SCHEMA)).toBe(true);
    expect(JSON.stringify(ast)).not.toContain('SuperSecret123!');
    expect(JSON.stringify(ast)).not.toContain('must-not-leak');
    expect(ast.validation.valid).toBe(true);
    expect(executableTestContract.buildExecutedCaseAstV1).toBe(buildExecutedCaseAstV1);
  });

  it('preserves every supported action and assertion semantic channel', () => {
    const control = verifiedLocator('getByTestId("control")', 'Control');
    const destination = verifiedLocator('getByTestId("destination")', 'Destination');
    const resolve = (as) => ({ op: 'resolve', as, actionLocator: control });
    const ast = buildExecutedCaseAstV1({
      status: 'pass',
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'act', action: 'navigate', url: 'https://example.test' },
            resolve('fill'), { op: 'act', action: 'fill', target: 'fill', valueRef: 'data:name' },
            resolve('type'), { op: 'act', action: 'type', target: 'type', valueRef: 'data:query' },
            resolve('select'), { op: 'act', action: 'selectOption', target: 'select', valueRef: 'data:role' },
            resolve('check'), { op: 'act', action: 'check', target: 'check' },
            resolve('uncheck'), { op: 'act', action: 'uncheck', target: 'uncheck' },
            resolve('click'), { op: 'act', action: 'click', target: 'click', postcondition: { kind: 'visible', expected: 'Saved' } },
            resolve('doubleClick'), { op: 'act', action: 'doubleClick', target: 'doubleClick', postcondition: { kind: 'visible', expected: 'Opened' } },
            resolve('tripleClick'), { op: 'act', action: 'tripleClick', target: 'tripleClick', postcondition: { kind: 'visible', expected: 'Selected' } },
            resolve('press'), { op: 'act', action: 'press', target: 'press', value: 'Enter' },
            resolve('hover'), { op: 'act', action: 'hover', target: 'hover' },
            resolve('drag'), { op: 'resolve', as: 'destination', actionLocator: destination },
            { op: 'act', action: 'drag', target: 'drag', destinationTarget: 'destination' },
            resolve('upload'), { op: 'act', action: 'upload', target: 'upload', value: 'tests/fixtures/document.pdf' },
            { op: 'act', action: 'waitForState', waitContract: { kind: 'visible', expected: 'Ready' } },
            { op: 'act', action: 'screenshot' },
            resolve('popup'), { op: 'act', action: 'popup', target: 'popup' },
            resolve('download'), { op: 'act', action: 'download', target: 'download' },
            { op: 'act', action: 'handleDialog', accept: true },
            { op: 'act', action: 'resize', width: 1440, height: 900 },
            { op: 'act', action: 'close' },
            { op: 'assert', channel: 'URL', expected: '/done', liveOutcome: 'matched' },
            resolve('text'), { op: 'assert', channel: 'UI_TEXT', target: 'text', expected: 'Done', liveOutcome: 'matched' },
            resolve('number'), { op: 'assert', channel: 'NUMBER', target: 'number', expected: 42, liveOutcome: 'matched' },
            resolve('visible'), { op: 'assert', channel: 'VISIBLE', target: 'visible', expected: true, liveOutcome: 'matched' },
            resolve('hidden'), { op: 'assert', channel: 'HIDDEN', target: 'hidden', expected: true, liveOutcome: 'matched' },
          ],
        },
      },
    });

    expect(ast.nodes.map((node) => node.type)).toEqual([
      'Navigate', 'Fill', 'Type', 'Select', 'Check', 'Uncheck', 'Click', 'DoubleClick', 'TripleClick', 'Press',
      'Hover', 'Drag', 'Upload', 'WaitForState', 'Screenshot', 'Popup', 'Download', 'HandleDialog', 'Resize', 'Close',
      'AssertUrl', 'AssertText', 'AssertNumber', 'AssertVisible', 'AssertHidden',
    ]);
    const dragNode = ast.nodes.find((node) => node.type === 'Drag');
    expect(dragNode).toMatchObject({
      destinationTargetRef: 'destination',
    });
    expect(ast.symbolTable.targets[dragNode.destinationTargetId]).toMatchObject({
      expression: 'getByTestId("destination")',
      verified: true,
      guessed: false,
    });
    expect(ast.nodes.filter((node) => node.kind === 'assertion').map((node) => node.assertion.channel))
      .toEqual(['URL', 'UI_TEXT', 'NUMBER', 'VISIBLE', 'HIDDEN']);
    expect(ast.validation.valid).toBe(true);
  });

  it('preserves ReplayIR action and assertion order when compatibility contracts are absent', () => {
    const ast = buildExecutedCaseAstV1({
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'act', action: 'navigate', url: 'https://example.test/start' },
            { op: 'assert', channel: 'URL', expected: '/start', liveOutcome: 'matched' },
            { op: 'act', action: 'screenshot' },
          ],
        },
      },
    });

    expect(ast.nodes.map((node) => node.type)).toEqual(['Navigate', 'AssertUrl', 'Screenshot']);
    expect(ast.nodes.map((node) => node.ordinal)).toEqual([1, 2, 3]);
  });

  it('projects both verified drag locators into the executable ReplayIR prefix', () => {
    const source = verifiedLocator('getByTestId("drag-source")', 'Drag source');
    const destination = verifiedLocator('getByTestId("drop-destination")', 'Drop destination');
    const steps = [
      {
        op: 'resolve',
        as: 'source',
        contractStepId: 'drag-step',
        elementLabel: 'Drag source',
        actionLocator: source,
      },
      {
        op: 'resolve',
        as: 'destination',
        contractStepId: 'destination-step',
        elementLabel: 'Drop destination',
        actionLocator: destination,
      },
      {
        op: 'act',
        action: 'drag',
        target: 'source',
        destinationTarget: 'destination',
        contractStepId: 'drag-step',
      },
    ];
    const executedCaseAst = buildExecutedCaseAstV1({
      status: 'pass',
      replayEnvelope: { ir: { steps } },
    });

    expect(executedCaseAst.validation.findings).toEqual([]);
    const projected = replayExport.projectPlaywrightPomResultThroughExecutedAst({
      executedCaseAst,
      envelope: { complete: true, ir: { complete: true, steps } },
    });
    expect(projected.envelope.ir.steps.map((step) => (
      step.op === 'resolve' ? `resolve:${step.as}` : `${step.op}:${step.action}`
    ))).toEqual([
      'resolve:source',
      'resolve:destination',
      'act:drag',
    ]);
    expect(projected.envelope.ir.executedCaseAstProjection).toMatchObject({
      executableActionCount: 1,
      diagnosticsOnlyMissingActionCount: 0,
    });
  });

  it('normalizes an authored optional dismiss operation without losing its exact occurrence identity', () => {
    const prompt = verifiedLocator('getByRole("button", { name: "Yes" })', 'Yes');
    const actionIdentity = {
      schemaVersion: 'qaai-action-identity-v1',
      caseId: 'tc-auth',
      contractStepId: 'tc-auth:step:10',
      authoredActionId: 'action-dismiss-prompt',
      actionOccurrenceId: 'tc-auth:step:10:dismiss_if_visible:1',
      sequenceIndex: 10,
      occurrenceOrdinal: 1,
      occurrenceKey: 'tc-auth:tc-auth:step:10:1:dismiss_if_visible',
      operation: 'dismiss_if_visible',
    };
    const ast = buildExecutedCaseAstV1({
      testCaseId: 'tc-auth',
      executionContract: {
        nodes: [{
          contractStepId: 'tc-auth:step:10',
          stepOrdinal: 10,
          kind: 'action',
          actionType: 'dismiss_if_visible',
          plannedText: 'Dismiss the prompt if it is visible',
          actionIdentity,
          waitContract: { kind: 'none', timeoutMs: 0 },
          raw: { action: 'dismiss_if_visible', target: 'Stay signed in prompt', optional: true },
        }],
      },
      replayEnvelope: {
        ir: {
          steps: [{
            op: 'act',
            action: 'customAction',
            authoredOperation: 'dismiss_if_visible',
            contractStepId: 'tc-auth:step:10',
            actionIdentity,
            actionLocator: prompt,
            authoredContract: { action: 'dismiss_if_visible', optional: true },
          }],
        },
      },
    });

    expect(ast.nodes).toHaveLength(1);
    expect(ast.nodes[0]).toMatchObject({
      kind: 'action',
      type: 'Click',
      authoredOperation: 'dismiss_if_visible',
      optional: true,
      actionGuard: { optional: true, kind: 'if_visible', authoredOperation: 'dismiss_if_visible' },
      actionOccurrenceId: actionIdentity.actionOccurrenceId,
      occurrenceKey: actionIdentity.occurrenceKey,
      actionIdentity,
    });
    expect(ast.validation.findings, JSON.stringify(ast.validation.findings, null, 2)).toEqual([]);
  });

  it('matches one exact contract action when authored-step and action-sequence ordinals differ', () => {
    const locator = verifiedLocator('getByRole("button", { name: "Sign in with Microsoft" })', 'Sign in with Microsoft');
    const actionIdentity = {
      schemaVersion: 'qaai-action-identity-v1',
      caseId: 'tc-sequence-domains',
      contractStepId: 'tc-sequence-domains:step:5',
      authoredActionId: 'choose-microsoft-provider',
      actionOccurrenceId: 'tc-sequence-domains:step:5:click:1',
      sequenceIndex: 4,
      occurrenceOrdinal: 1,
      occurrenceKey: 'tc-sequence-domains:tc-sequence-domains:step:5:1:click',
      operation: 'click',
    };
    const ast = buildExecutedCaseAstV1({
      testCaseId: 'tc-sequence-domains',
      executionContract: {
        nodes: [{
          contractStepId: 'tc-sequence-domains:step:5',
          stepOrdinal: 5,
          kind: 'action',
          actionType: 'click',
          plannedText: 'Click Sign in with Microsoft',
          waitContract: { kind: 'visible', target: 'Microsoft email field', timeoutMs: 10000 },
          raw: { target: 'Sign in with Microsoft' },
        }],
      },
      replayEnvelope: {
        ir: {
          steps: [{
            op: 'act',
            action: 'click',
            contractStepId: 'tc-sequence-domains:step:5',
            actionIdentity,
            actionLocator: locator,
          }],
        },
      },
    });

    expect(ast.nodes).toHaveLength(1);
    expect(ast.nodes[0]).toMatchObject({
      contractStepId: actionIdentity.contractStepId,
      actionOccurrenceId: actionIdentity.actionOccurrenceId,
      occurrenceKey: actionIdentity.occurrenceKey,
    });
    expect(ast.symbolTable.targets[ast.nodes[0].targetId]).toMatchObject({
      expression: locator.expression,
      verified: true,
    });
    expect(ast.validation.findings, JSON.stringify(ast.validation.findings, null, 2)).toEqual([]);
  });

  it('maps authored assertions by exact contract identity and preserves expected values when replay order differs', () => {
    const contract = {
      testCaseId: 'tc-assertions',
      nodes: [
        {
          contractStepId: 'runtime-step-4',
          caseContractStepId: 'case_step_4',
          stepOrdinal: 4,
          kind: 'assertion',
          actionType: 'assert',
          pageIntent: 'Authentication',
          plannedText: 'Sign in with Microsoft option is displayed',
          expectedOutcome: { kind: 'PAGE', expected: 'Sign in with Microsoft option', expectedSignals: ['Sign in with Microsoft option'] },
          raw: { expectedText: 'Sign in with Microsoft option' },
          proofRequired: true,
          certificationStatus: 'planned',
        },
        {
          contractStepId: 'runtime-step-11',
          caseContractStepId: 'case_step_11',
          stepOrdinal: 11,
          kind: 'assertion',
          actionType: 'assert',
          pageIntent: 'Home dashboard',
          plannedText: 'Welcome OdysseyOne is visible',
          expectedOutcome: { kind: 'PAGE', expected: 'Welcome OdysseyOne!', expectedSignals: ['Welcome OdysseyOne!'] },
          raw: { expectedText: 'Welcome OdysseyOne!' },
          proofRequired: true,
          certificationStatus: 'planned',
        },
      ],
    };
    const replayEnvelope = {
      ir: {
        steps: [
          { op: 'assert', contractRef: 'case_step_11', channel: 'PAGE', expected: 'Welcome OdysseyOne! page', expectedSignals: { text: ['Welcome OdysseyOne!'] } },
          { op: 'assert', contractRef: 'case_step_4', channel: 'PAGE', expected: 'Sign in with Microsoft option', expectedSignals: { text: ['Sign in with Microsoft option'] } },
        ],
      },
    };
    const graph = executableTestContract.buildActionGraph({ contract, replayEnvelope, status: 'pass' });

    expect(graph.nodes.map((node) => ({ id: node.caseContractStepId, expected: node.expectedOutcome.expected }))).toEqual([
      { id: 'case_step_4', expected: 'Sign in with Microsoft option' },
      { id: 'case_step_11', expected: 'Welcome OdysseyOne!' },
    ]);
    expect(graph.nodes.every((node) => node.kind === 'assertion' && node.certificationStatus === 'certified')).toBe(true);
    expect(graph.repairTasks.filter((task) => task.category === 'assertion_translation_gap')).toHaveLength(0);

    const ast = buildExecutedCaseAstV1({ executionContract: graph, replayEnvelope, status: 'pass' });
    expect(ast.nodes.map((node) => node.kind)).toEqual(['assertion', 'assertion']);
    expect(ast.nodes.map((node) => node.assertion.expected)).toEqual([
      'Sign in with Microsoft option',
      'Welcome OdysseyOne!',
    ]);
    expect(ast.nodes.map((node) => node.type)).toEqual(['AssertVisible', 'AssertVisible']);
    expect(ast.validation.valid).toBe(true);
  });

  it('preserves the immutable structured assertion contract and target identity through graph and AST projection', () => {
    const targetIdentity = { backendNodeId: 321, frameId: 'frame-main' };
    const expectedSignals = {
      text: ['Dashboard ready'],
      role: [{ role: 'heading', name: 'Dashboard' }],
    };
    const contract = executableTestContract.buildExecutionContract({
      testCase: { id: 'tc-structured-assertion', module: 'Dashboard' },
      declaredAssertions: [{
        id: 'dashboard-ready',
        channel: 'PAGE',
        expected: 'Dashboard ready',
        expectedSignals,
        targetIdentity,
      }],
    });
    const contractStepId = contract.nodes[0].contractStepId;
    const replayEnvelope = { ir: { steps: [{
      op: 'assert',
      assertionId: 'dashboard-ready',
      contractRef: contractStepId,
      channel: 'PAGE',
      expected: 'Dashboard ready',
      expectedSignals,
      targetIdentity,
    }] } };
    const graph = executableTestContract.buildActionGraph({ contract, replayEnvelope, status: 'pass' });
    expect(graph.repairTasks).toEqual([]);
    expect(graph.nodes[0].assertionContract).toMatchObject({
      schemaVersion: 'qaai-assertion-contract-v1',
      contractStepId,
      assertionId: 'dashboard-ready',
      expected: 'Dashboard ready',
      expectedSignals,
      targetIdentity,
    });

    const ast = buildExecutedCaseAstV1({ executionContract: graph, replayEnvelope, status: 'pass' });
    expect(ast.nodes[0].assertion).toMatchObject({
      schemaVersion: 'qaai-assertion-contract-v1',
      contractStepId,
      assertionId: 'dashboard-ready',
      expected: 'Dashboard ready',
      expectedSignals,
      targetIdentity,
    });
    expect(ast.validation.valid, JSON.stringify(ast.validation.findings)).toBe(true);
  });

  it('does not turn synthetic or explicitly not-applicable assertion projections into translation failures', () => {
    const contract = {
      testCaseId: 'tc-non-applicable',
      nodes: [
        { contractStepId: 'synthetic-a', kind: 'assertion', actionType: 'assert', synthetic: true, proofRequired: true, raw: {} },
        { contractStepId: 'not-applicable-a', kind: 'assertion', actionType: 'assert', status: 'not_applicable', proofRequired: true, raw: {} },
      ],
    };
    const graph = executableTestContract.buildActionGraph({ contract, replayEnvelope: { ir: { steps: [] } }, status: 'pass' });
    expect(graph.repairTasks.filter((task) => task.category === 'assertion_translation_gap')).toEqual([]);
    const ast = buildExecutedCaseAstV1({ executionContract: graph, replayEnvelope: { ir: { steps: [] } }, status: 'pass' });
    expect(ast.nodes).toEqual([]);
    expect(ast.validation.valid).toBe(true);
  });

  it('classifies browser_wait_for_selector as a supported readiness action', () => {
    const ast = buildExecutedCaseAstV1({
      executionContract: {
        testCaseId: 'tc-readiness',
        nodes: [{
          contractStepId: 'wait-ready',
          stepOrdinal: 1,
          kind: 'action',
          actionType: 'browser_wait_for_selector',
          plannedText: 'Wait for dashboard selector',
          raw: { action: 'browser_wait_for_selector', target: 'Dashboard' },
        }],
      },
      replayEnvelope: { ir: { steps: [{
        op: 'act',
        action: 'browser_wait_for_selector',
        contractStepId: 'wait-ready',
        waitContract: { schema: 'qaai-wait-contract/1', kind: 'selector', timeoutMs: 10000 },
      }] } },
      status: 'pass',
    });
    expect(ast.nodes).toHaveLength(1);
    expect(ast.nodes[0].type).toBe('WaitForState');
    expect(ast.validation.findings.find((finding) => finding.rule === 'ast_node_type_unsupported')).toBeUndefined();
  });

  it('matches foreign-id replay actions by authored semantics instead of shifting action types by position', () => {
    const email = verifiedLocator('getByLabel("Email address")', 'Email address');
    const continueButton = verifiedLocator('getByRole("button", { name: "Continue" })', 'Continue');
    const ast = buildExecutedCaseAstV1({
      executionContract: {
        schema: 'qaai-executable-test-contract/1',
        nodes: [
          { contractStepId: 'case_step_1', stepOrdinal: 1, kind: 'action', actionType: 'click', plannedText: 'Click Continue button', postcondition: { kind: 'visible', expected: 'Email address' }, raw: { target: 'Continue button' } },
          { contractStepId: 'case_step_2', stepOrdinal: 2, kind: 'action', actionType: 'fill', plannedText: 'Fill Email address', dataBinding: { isDataBound: true, sourceColumn: 'email' }, raw: { target: 'Email address' } },
        ],
      },
      caseInstance: { inlineData: { email: 'tester@example.test' } },
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'resolve', as: 'emailRef', actionLocator: email },
            { op: 'act', action: 'fill', target: 'emailRef', valueRef: 'data:email', contractRef: 'runtime-fill' },
            { op: 'resolve', as: 'continueRef', actionLocator: continueButton },
            { op: 'act', action: 'click', target: 'continueRef', contractRef: 'runtime-click' },
          ],
        },
      },
    });

    expect(ast.nodes.map((node) => node.type)).toEqual(['Click', 'Fill']);
    expect(ast.nodes.map((node) => node.stepId)).toEqual(['case_step_1', 'case_step_2']);
    expect(ast.validation.valid).toBe(true);
  });

  it('keeps an explicit guessed locator out of the executable target symbol', () => {
    const warning = 'QAAI_GUESSED_LOCATOR: replace with a reliable DOM locator.';
    const ast = buildExecutedCaseAstV1({
      status: 'pass',
      replayEnvelope: {
        ir: {
          steps: [
            {
              op: 'resolve',
              as: 'submit',
              guessedLocator: true,
              locatorConfidence: 'guessed',
              locatorProvenance: {
                kind: 'qaai_guessed_locator',
                source: 'llm',
                confidence: 'unverified',
                semanticLabel: 'Submit',
                chosenExpression: 'getByRole("button", { name: "Submit" })',
                warning,
              },
              candidates: [{ strategy: 'role', role: 'button', name: 'Submit' }],
            },
            { op: 'act', action: 'click', target: 'submit', postcondition: { kind: 'visible', expected: 'Saved' } },
          ],
        },
      },
    });

    const target = ast.symbolTable.targets[ast.nodes[0].targetId];
    expect(target).toMatchObject({
      expression: null,
      verified: false,
      guessed: false,
    });
    expect(ast.validation.findings.some((finding) => finding.rule === 'ast_locator_missing')).toBe(true);
    expect(ast.validation.valid).toBe(false);
  });

  it('does not materialize a Playwright expression from guessed resolve candidates', () => {
    const ast = buildExecutedCaseAstV1({
      status: 'pass',
      caseInstance: { inlineData: { email: 'tester@example.test' } },
      replayEnvelope: {
        ir: {
          steps: [
            {
              op: 'resolve',
              as: 'email',
              guessedLocator: true,
              locatorConfidence: 'guessed',
              locatorProvenance: {
                kind: 'qaai_guessed_locator',
                source: 'semantic_heuristic',
                confidence: 'unverified',
                semanticLabel: 'Email address',
              },
              candidates: [{ strategy: 'label', text: 'Email address', provenance: 'qaai_guessed_locator' }],
            },
            { op: 'act', action: 'fill', target: 'email', valueRef: 'data:email' },
          ],
        },
      },
    });

    const target = ast.symbolTable.targets[ast.nodes[0].targetId];
    expect(target).toMatchObject({
      expression: null,
      verified: false,
      guessed: false,
    });
    expect(ast.validation.findings.some((finding) => finding.rule === 'ast_locator_missing')).toBe(true);
    expect(ast.validation.valid).toBe(false);
  });

  it('keeps product mismatches enabled and reports missing compiler proof or unresolved secrets', () => {
    const message = verifiedLocator('getByRole("alert", { name: "Status message" })', 'Status message');
    const ast = buildExecutedCaseAstV1({
      status: 'failed',
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'resolve', as: 'alert', actionLocator: message },
            { op: 'assert', channel: 'UI_TEXT', target: 'alert', expected: 'Approved', liveOutcome: 'not_matched', contractRef: 'assert-product' },
          ],
        },
      },
      stepJournal: [{
        stepId: 'assert-product',
        assertionOutcome: 'not_matched',
        continuationOutcome: 'continue',
        failureClassification: 'product_failure',
        observedState: 'Rejected',
      }],
    });

    expect(ast.case).toMatchObject({ enabled: true, expectedVerdict: 'fail' });
    expect(ast.nodes[0].assertion).toMatchObject({ enabled: true, hard: true, productFailure: true, outcome: 'not_matched' });
    expect(ast.validation.valid, JSON.stringify(ast.validation.findings)).toBe(true);

    const broken = structuredClone(ast);
    broken.nodes[0].methodId = 'missing-method';
    broken.nodes[0].kind = 'action';
    broken.nodes[0].type = 'Click';
    broken.nodes[0].targetId = null;
    broken.nodes[0].waitContract = null;
    broken.nodes[0].assertion = null;
    broken.symbolTable.data.rawPassword = { id: 'rawPassword', name: 'password', kind: 'fixture', sensitive: true, value: 'password=leaked' };
    const validation = validateExecutedCaseAstV1(broken);
    const rules = validation.findings.map((finding) => finding.rule);

    expect(validation.valid).toBe(false);
    expect(rules).toEqual(expect.arrayContaining([
      'ast_method_missing',
      'ast_locator_missing',
      'ast_wait_postcondition_missing',
      'ast_sensitive_data_not_env',
      'ast_unresolved_secret',
    ]));
  });
});
