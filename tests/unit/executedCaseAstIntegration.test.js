import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const executableTestContract = require('../../server/services/executableTestContract');
const replayExport = require('../../server/services/codegen/replayExport');

function locator(expression, name) {
  const nodeId = String(name || 'target').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'target';
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'document-integration-test',
    nodeId,
    connected: true,
  };
  return {
    primary: expression,
    expression,
    frameworkExpressions: { playwright: expression },
    accessibleName: name,
    verified: true,
    source: 'verified_dom_inspection',
    verificationSource: 'verified_dom_inspection',
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

describe('CaseInstanceV1 and immutable ExecutedCaseAST evidence', () => {
  it('derives a bounded Playwright timeout from the longest emitted flow', () => {
    expect(replayExport.playwrightTestTimeoutMs([])).toBe(60_000);
    expect(replayExport.playwrightTestTimeoutMs([
      { content: 'await step();\n'.repeat(50) },
    ])).toBe(190_000);
    expect(replayExport.playwrightTestTimeoutMs([
      { content: 'await step();\n'.repeat(1_000) },
    ])).toBe(600_000);
  });

  it('materializes a redacted row-specific case instance and links typed dependencies', () => {
    const caseContractV1 = {
      version: 'CaseContractV1',
      id: 'case-login',
      initialState: { description: 'Public sign-in page' },
      expectedFinalState: { description: 'Authenticated administration page' },
      sessionRequirement: { mode: 'fresh', dependsOnCaseRefs: [], producesAuthenticatedState: true },
      dataBindings: [
        { id: 'data.email', name: 'email', classification: 'normal', source: { kind: 'inline', value: 'author@example.test' } },
        { id: 'data.password', name: 'password', classification: 'sensitive', source: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD' } },
      ],
      steps: [
        { id: 'case-login.step.001', type: 'Fill', text: 'Enter email', dataRefs: ['data.email'], dependsOn: [], flowImpact: 'state_change', failureBehavior: 'stop_descendants' },
        { id: 'case-login.step.002', type: 'Fill', text: 'Enter password', dataRefs: ['data.password'], dependsOn: ['case-login.step.001'], flowImpact: 'state_change', failureBehavior: 'stop_descendants' },
      ],
      assertions: [],
    };
    const contract = executableTestContract.buildExecutionContract({
      testCase: {
        id: 'tc-login',
        name: 'Login',
        generationId: 'generation-7',
        steps: JSON.stringify([{ action: 'fill', target: 'Email', text: 'Enter email' }, { action: 'fill', target: 'Password', text: 'Enter password' }]),
        declaredAssertions: '[]',
        qualityContractJson: JSON.stringify({ caseContractV1 }),
      },
      dataRow: {
        index: 0,
        label: 'primary',
        setName: 'inline',
        fields: { email: 'row@example.test', password: 'must-never-persist' },
      },
      runId: 'run-7',
      runResultId: 'result-7',
    });

    expect(contract.caseInstanceV1).toMatchObject({
      version: 'CaseInstanceV1',
      generationId: 'generation-7',
      caseContractId: 'case-login',
      sessionPlan: { mode: 'fresh', producesAuthenticatedState: true },
    });
    expect(contract.caseInstanceV1.caseRevision).toMatch(/^case_revision_[a-f0-9]{16}$/);
    expect(contract.nodes[1]).toMatchObject({
      caseContractStepId: 'case-login.step.002',
      dependencies: ['case-login.step.001'],
      failureBehavior: 'stop_descendants',
      dataRefs: ['data.password'],
    });
    expect(contract.caseInstanceV1.inlineData['data.password']).toEqual({ kind: 'environment', name: 'QAAI_INLINE_PASSWORD', sensitive: true });
    expect(contract.dataRow.fields.password).toEqual({ kind: 'environment', name: 'QAAI_INLINE_PASSWORD', sensitive: true });
    expect(JSON.stringify(contract)).not.toContain('must-never-persist');
  });

  it('writes one validated AST per contract result and content-addresses the exact returned file map', () => {
    const executionContract = {
      schema: 'qaai-executable-test-contract/1',
      contractId: 'etc-product-gap',
      testCaseId: 'tc-product-gap',
      testCaseName: 'Product gap remains reproducible',
      generationId: 'generation-9',
      caseInstanceV1: { version: 'CaseInstanceV1', id: 'ci-9', testCaseId: 'tc-product-gap', generationId: 'generation-9' },
      nodes: [{
        contractStepId: 'assert-product', stepOrdinal: 1, kind: 'assertion', actionType: 'assert',
        plannedText: 'Verify approval message', raw: { target: 'Approval status', expected: 'Approved', channel: 'UI_TEXT' },
      }],
    };
    const result = {
      runResultId: 'rr-product-gap', testCaseId: 'tc-product-gap', caseName: 'Product gap', status: 'failed', executionContract,
      actionGraph: { schema: 'qaai-certified-action-graph/1', nodes: [{ ...executionContract.nodes[0], locatorRecipe: locator('getByRole("status", { name: "Approval status" })', 'Approval status') }] },
      envelope: { complete: true, ir: { steps: [
        { op: 'resolve', as: 'approval', actionLocator: locator('getByRole("status", { name: "Approval status" })', 'Approval status') },
        { op: 'assert', channel: 'UI_TEXT', target: 'approval', expected: 'Approved', contractRef: 'assert-product', liveOutcome: 'not_matched' },
      ] } },
      stepResults: [{ stepId: 'assert-product', assertionOutcome: 'not_matched', continuationOutcome: 'continue', failureClassification: 'product_failure', observedState: 'Pending' }],
    };
    const evidence = replayExport.buildExecutedCaseAstEvidence({ results: [result], generationId: 'generation-9' });

    expect(evidence.astsValid).toBe(true);
    expect(evidence.inventory).toMatchObject({ astCount: 1, validatedCount: 1, enabledTestCount: 1, enabledProductFailureCount: 1 });
    const astPath = evidence.inventory.entries[0].file;
    const ast = JSON.parse(evidence.files[astPath]);
    expect(ast.case).toMatchObject({ enabled: true, expectedVerdict: 'fail' });
    expect(ast.nodes[0].assertion).toMatchObject({ channel: 'UI_TEXT', enabled: true, hard: true, productFailure: true });

    const files = { 'tests/product-gap.spec.js': 'test("gap", async () => {});\n', ...evidence.files };
    const first = replayExport.buildImmutableBundleEvidence(files, { adapterId: 'playwright-pom-js', astInventory: evidence.inventory });
    const second = replayExport.buildImmutableBundleEvidence(files, { adapterId: 'playwright-pom-js', astInventory: evidence.inventory });
    expect(first.bundleId).toBe(second.bundleId);
    expect(first.fileHashes['tests/product-gap.spec.js']).toMatch(/^[a-f0-9]{64}$/);
    expect(first.executedCaseAstIds).toEqual([ast.astId]);
  });

  it('projects the successful AST prefix into runtime order without guessing missing or failed actions', () => {
    const actionSteps = (id, ref, action = 'click') => [
      { op: 'resolve', as: ref, contractStepId: id, actionLocator: { expression: `getByRole("button", { name: "${ref}" })`, verified: true } },
      { op: 'act', action, target: ref, contractStepId: id },
    ];
    const result = {
      envelope: {
        complete: true,
        gaps: [],
        ir: {
          complete: true,
          gaps: [],
          steps: [
            ...actionSteps('step-2', 'Second'),
            ...actionSteps('step-1', 'First'),
            ...actionSteps('step-3', 'Failed'),
            ...actionSteps('step-4', 'NeverExecuted'),
            { op: 'assert', channel: 'UI_TEXT', expected: 'Completed' },
          ],
        },
      },
      executedCaseAst: {
        astId: 'ast-runtime-prefix',
        validation: { valid: false, findings: [{ code: 'unrelated_unsupported_assertion' }] },
        nodes: [
          { ordinal: 1, type: 'Click', operation: 'click', stepId: 'step-1', journal: { actionOutcome: 'succeeded' } },
          { ordinal: 2, type: 'WaitForState', operation: 'wait', stepId: 'wait-2', waitContract: { kind: 'pageState', timeoutMs: 5000, expected: { effect: 'fingerprint_stable' } }, journal: { actionOutcome: 'succeeded' } },
          { ordinal: 3, type: 'Click', operation: 'click', stepId: 'step-2', journal: { actionOutcome: 'succeeded' } },
          { ordinal: 4, type: 'Click', operation: 'click', stepId: 'step-missing', plannedText: 'Click optional continuation', journal: { actionOutcome: 'succeeded' } },
          { ordinal: 5, type: 'Click', operation: 'click', stepId: 'step-3', plannedText: 'Click failing control', journal: { actionOutcome: 'failed' } },
          { ordinal: 6, type: 'Click', operation: 'click', stepId: 'step-4', journal: { actionOutcome: 'not_executed' } },
        ],
      },
    };

    replayExport.projectPlaywrightPomJsResultThroughExecutedAst(result);

    const steps = result.envelope.ir.steps;
    expect(steps.filter((step) => step.op === 'act').map((step) => step.contractStepId)).toEqual([
      'step-1',
      'step-2',
    ]);
    expect(steps.findIndex((step) => step.contractStepId === 'wait-2')).toBeGreaterThan(
      steps.findIndex((step) => step.contractStepId === 'step-1' && step.op === 'act'),
    );
    expect(steps.findIndex((step) => step.contractStepId === 'wait-2')).toBeLessThan(
      steps.findIndex((step) => step.contractStepId === 'step-2' && step.op === 'resolve'),
    );
    expect(steps.find((step) => step.op === 'waitFor')).toMatchObject({
      condition: { kind: 'pageState', timeoutMs: 5000 },
      executionOutcome: 'succeeded',
    });
    expect(steps.filter((step) => step.op === 'assert')).toHaveLength(1);
    expect(result.envelope.complete).toBe(false);
    expect(result.envelope.gaps.map((gap) => gap.code)).toEqual([
      'executed_action_missing_replayir_evidence',
      'executed_action_failure_boundary',
    ]);
    expect(result.envelope.ir.executedCaseAstProjection).toMatchObject({
      astValidationValid: false,
      executableActionCount: 2,
      successfulWaitCount: 1,
      firstFailureOrdinal: 5,
      diagnosticsOnlyMissingActionCount: 1,
    });
  });

  it('keeps only environment keys referenced by generated source', () => {
    const files = replayExport.filterEnvFilesToGeneratedReferences({
      '.env': 'QAAI_PASSWORD=secret-value\nQAAI_TARGET_URL=https://app.example.test\nQAAI_UNUSED=remove-me\nQAAI_USERNAME=user@example.test\n',
      '.env.example': 'QAAI_PASSWORD=\nQAAI_TARGET_URL=\nQAAI_UNUSED=\nQAAI_USERNAME=\n',
      'playwright.config.ts': "export default { use: { baseURL: process.env.QAAI_TARGET_URL } };\n",
      'tests/login.spec.js': "await loginPage.fillEmail(readEnv('QAAI_USERNAME'));\nawait loginPage.fillPassword(readEnv(\"QAAI_PASSWORD\"));\n",
      'evidence/diagnostic.js': "readEnv('QAAI_UNUSED');\n",
    });

    expect(files['.env']).toBe(
      'QAAI_PASSWORD=secret-value\nQAAI_TARGET_URL=https://app.example.test\nQAAI_USERNAME=user@example.test\n',
    );
    expect(files['.env.example']).toBe(
      'QAAI_PASSWORD=\nQAAI_TARGET_URL=\nQAAI_USERNAME=\n',
    );
  });

  it('projects evaluated value and visibility assertions without inventing locator actions', () => {
    const valueLocator = { expression: 'getByRole("textbox", { name: "Email" })', verified: true };
    const result = {
      envelope: {
        complete: true,
        ir: {
          complete: true,
          steps: [
            { op: 'resolve', as: 'emailField', contractStepId: 'fill-email', elementLabel: 'Email field', actionLocator: valueLocator },
            { op: 'act', action: 'fill', target: 'emailField', contractStepId: 'fill-email', valueRef: 'env:QAAI_USERNAME' },
            { op: 'resolve', as: 'submitButton', contractStepId: 'click-submit', elementLabel: 'Submit button', actionLocator: { expression: 'getByRole("button", { name: "Submit" })', verified: true } },
            { op: 'act', action: 'click', target: 'submitButton', contractStepId: 'click-submit' },
          ],
        },
      },
      executedCaseAst: {
        astId: 'ast-assertions',
        validation: { valid: false },
        nodes: [
          { ordinal: 1, type: 'Fill', operation: 'fill', stepId: 'fill-email', journal: { actionOutcome: 'succeeded' } },
          {
            ordinal: 2,
            type: 'UnsupportedAssertion',
            stepId: 'assert-email',
            plannedText: 'the Email field contains exactly the supplied username.',
            assertion: { comparator: 'equals', outcome: 'matched', continuationPolicy: 'continue' },
            journal: {
              actionOutcome: 'succeeded',
              assertionOutcome: 'matched',
              expectedState: 'user@example.test',
              observedState: 'user@example.test',
              attempts: [{ target: 'Email field', waitContract: { action: 'asserttext', sensitive: true } }],
            },
          },
          {
            ordinal: 3,
            type: 'UnsupportedAssertion',
            stepId: 'assert-dashboard',
            plannedText: 'the visible text "Welcome" is present.',
            assertion: { outcome: 'matched', continuationPolicy: 'continue' },
            journal: {
              actionOutcome: 'succeeded',
              assertionOutcome: 'matched',
              expectedState: true,
              observedState: true,
              attempts: [{ target: 'visible text "Welcome"', waitContract: { action: 'assertvisible' } }],
            },
          },
          {
            ordinal: 4,
            type: 'UnsupportedAssertion',
            stepId: 'assert-submit-state',
            plannedText: 'the Submit button contains exactly true.',
            assertion: { outcome: 'matched', continuationPolicy: 'continue' },
            journal: {
              actionOutcome: 'succeeded',
              assertionOutcome: 'matched',
              expectedState: true,
              observedState: true,
              attempts: [{ target: 'Submit button', waitContract: { action: 'asserttext' } }],
            },
          },
          {
            ordinal: 5,
            type: 'UnsupportedAssertion',
            stepId: 'assert-page-name',
            plannedText: 'the OdysseyOne Home page is displayed.',
            assertion: { outcome: 'matched', continuationPolicy: 'continue' },
            journal: {
              actionOutcome: 'succeeded',
              assertionOutcome: 'matched',
              expectedState: true,
              observedState: true,
              attempts: [{ target: 'OdysseyOne Home page', waitContract: { action: 'assertvisible' } }],
            },
          },
        ],
      },
    };

    replayExport.projectPlaywrightPomJsResultThroughExecutedAst(result);

    const assertions = result.envelope.ir.steps.filter((step) => step.op === 'assert');
    expect(assertions).toEqual([
      expect.objectContaining({
        channel: 'VALUE',
        target: 'emailField',
        expectedRef: 'env:QAAI_USERNAME',
        liveOutcome: 'matched',
      }),
      expect.objectContaining({
        channel: 'UI_TEXT',
        target: null,
        expected: 'Welcome',
        liveOutcome: 'matched',
      }),
    ]);
    expect(result.envelope.ir.executedCaseAstProjection.executableAssertionCount).toBe(2);
    expect(result.envelope.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'evaluated_assertion_not_projectable' }),
    ]));
  });

  it('preserves an exact same-row workbook binding on a projected VALUE assertion', () => {
    const result = {
      envelope: {
        complete: true,
        gaps: [],
        ir: {
          complete: true,
          gaps: [],
          dataRows: [
            {
              id: 'row-1',
              fields: {
                owning_organization_selection: '*BOUND ORGANIZATION 01',
                unrelated_column: '*OTHER ORGANIZATION 02',
              },
            },
          ],
          steps: [
            {
              op: 'resolve',
              as: 'owningOrganization',
              contractStepId: 'select-organization',
              elementLabel: 'Owning Organization field',
            },
            {
              op: 'act',
              action: 'selectOption',
              target: 'owningOrganization',
              contractStepId: 'select-organization',
              valueRef: 'env:QAAI_SELECT_OPTION',
              dataBinding: {
                isDataBound: true,
                sourceColumn: 'owning_organization_selection',
              },
            },
          ],
        },
      },
      executedCaseAst: {
        nodes: [
          {
            ordinal: 1,
            type: 'UnsupportedAssertion',
            stepId: 'assert-organization',
            plannedText: 'the Owning Organization field contains the selected value.',
            assertion: { outcome: 'matched', continuationPolicy: 'continue' },
            journal: {
              actionOutcome: 'succeeded',
              assertionOutcome: 'matched',
              expectedState: '*BOUND ORGANIZATION 01',
              observedState: '*BOUND ORGANIZATION 01',
              attempts: [
                {
                  target: 'Owning Organization field',
                  waitContract: { action: 'asserttext' },
                },
              ],
            },
          },
        ],
      },
    };

    replayExport.projectPlaywrightPomJsResultThroughExecutedAst(result);

    expect(result.envelope.ir.steps).toContainEqual(
      expect.objectContaining({
        op: 'assert',
        channel: 'VALUE',
        expected: '*BOUND ORGANIZATION 01',
        dataBinding: {
          isDataBound: true,
          sourceColumn: 'owning_organization_selection',
        },
        dataRole: 'owning_organization_selection',
      }),
    );
  });
});
