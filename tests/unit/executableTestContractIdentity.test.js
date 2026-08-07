import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const executableTestContract = require('../../server/services/executableTestContract.js');
const replayEmitter = require('../../server/services/codegen/replayEmitter.js');
const { normaliseSteps } = require('../../server/lib/stepShape.js');

function node(contractStepId, actionType, extras = {}) {
  return {
    contractStepId,
    kind: 'action',
    actionType,
    proofRequired: true,
    certificationStatus: 'planned',
    plannedText: `${actionType} ${contractStepId}`,
    ...extras,
  };
}

function resolve(as, contractStepId, label, expression, extras = {}) {
  return {
    op: 'resolve',
    as,
    contractStepId,
    targetRef: contractStepId,
    elementLabel: label,
    candidates: [{ expression, verified: true, count: 1, visible: true, enabled: true }],
    ...extras,
  };
}

describe('CertifiedActionGraph replay identity invariants', () => {
  it('binds actions by their own contract identity and never certifies a synthesized missing click', () => {
    const contract = {
      contractId: 'contract-auth',
      nodes: [
        node('step-6', 'fill'),
        node('step-7', 'click', {
          toolName: 'browser_click',
          locatorRecipe: { primary: "getByLabel('Email Address')" },
          proof: { actionExecuted: true, source: 'stale_prior_step' },
          contractFulfillment: { status: 'fulfilled' },
        }),
        node('step-8', 'fill'),
      ],
    };
    const replayEnvelope = {
      ir: {
        steps: [
          // Browser bootstrap navigation has no approved-step identity.
          { op: 'act', action: 'navigate', url: 'https://example.test/login' },
          resolve('email', 'step-6', 'Email, phone, or Skype', "getByLabel('Email, phone, or Skype')"),
          { op: 'act', action: 'fill', target: 'email', contractStepId: 'step-6', targetRef: 'step-6' },
          resolve('next', 'step-7', 'Next', "getByRole('button', { name: 'Next' })", { synthesizedFromContract: true }),
          { op: 'act', action: 'click', target: 'next', contractStepId: 'step-7', targetRef: 'step-7', synthesizedFromContract: true },
          resolve('password', 'step-8', 'Password', "getByLabel('Password')"),
          { op: 'act', action: 'fill', target: 'password', contractStepId: 'step-8', targetRef: 'step-8' },
        ],
      },
    };

    const graph = executableTestContract.buildActionGraph({ contract, replayEnvelope, status: 'blocked' });
    const [email, next, password] = graph.nodes;

    expect(email.replayStep).toMatchObject({ action: 'fill', contractStepId: 'step-6', synthesizedFromContract: false });
    expect(email.locatorRecipe.primary).toContain('Email, phone, or Skype');
    expect(email.certificationStatus).toBe('certified');

    expect(next.replayStep).toMatchObject({ action: 'click', contractStepId: 'step-7', synthesizedFromContract: true });
    expect(next.toolName).toBeNull();
    expect(next.locatorRecipe).toBeNull();
    expect(next.proof).toBeNull();
    expect(next.contractFulfillment).toBeNull();
    expect(next.certificationStatus).toBe('requires_repair');

    expect(password.replayStep).toMatchObject({ action: 'fill', contractStepId: 'step-8', synthesizedFromContract: false });
    expect(password.locatorRecipe.primary).toContain('Password');
    expect(password.locatorRecipe.primary).not.toContain('Email Address');
    expect(password.certificationStatus).toBe('certified');

    expect(graph.complete).toBe(false);
    expect(graph.repairTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ contractStepId: 'step-7' }),
    ]));
  });

  it('retains ordered positional mapping only for wholly identity-free legacy replay', () => {
    const graph = executableTestContract.buildActionGraph({
      contract: {
        contractId: 'legacy-contract',
        nodes: [node('legacy-1', 'navigate'), node('legacy-2', 'navigate')],
      },
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'act', action: 'navigate', url: 'https://example.test/one' },
            { op: 'act', action: 'navigate', url: 'https://example.test/two' },
          ],
        },
      },
      status: 'pass',
    });

    expect(graph.nodes.map((item) => item.replayStep.action)).toEqual(['navigate', 'navigate']);
    expect(graph.nodes.every((item) => item.certificationStatus === 'certified')).toBe(true);
  });

  it('preserves deterministic_dom_fill as the same identified fill through ReplayIR and the graph', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'tc-dom-fill',
      title: 'Password entry',
      verdictStatus: 'pass',
      trail: [{
        tool: 'deterministic_dom_fill',
        contractStepId: 'step-8',
        stepIndex: 7,
        args: { element: 'Password', target: 'dom-label', value: 'secret-value' },
        pageUrl: 'https://example.test/signin',
        ok: true,
      }],
    });

    const fill = emitted.ir.steps.find((step) => step && step.op === 'act' && step.action === 'fill');
    const target = emitted.ir.steps.find((step) => step && step.op === 'resolve' && step.as === fill?.target);
    expect(fill).toMatchObject({ action: 'fill', contractStepId: 'step-8', targetRef: 'step-8' });
    expect(target).toMatchObject({ contractStepId: 'step-8', targetRef: 'step-8', elementLabel: 'Password' });

    const graph = executableTestContract.buildActionGraph({
      contract: { contractId: 'dom-contract', nodes: [node('step-8', 'fill')] },
      replayEnvelope: { ir: emitted.ir },
      status: 'pass',
    });
    expect(graph.nodes[0].replayStep).toMatchObject({ action: 'fill', contractStepId: 'step-8' });
    expect(graph.nodes[0].proof).toMatchObject({ actionExecuted: true, synthetic: false });
    expect(graph.nodes[0].locatorRecipe).toBeNull();
    expect(graph.nodes[0].certificationStatus).toBe('requires_repair');
  });

  it('matches persisted occurrences by immutable occurrence IDs even when positional case_step IDs disagree', () => {
    const graph = executableTestContract.buildActionGraph({
      contract: {
        contractId: 'immutable-occurrences',
        nodes: [
          node('case_step_1', 'click', {
            actionOccurrenceId: 'occ-runtime-2',
            occurrenceKey: 'tc:authored:2:click',
            actionIdentity: { actionOccurrenceId: 'occ-runtime-2', occurrenceKey: 'tc:authored:2:click' },
          }),
          node('case_step_2', 'click', {
            actionOccurrenceId: 'occ-runtime-1',
            occurrenceKey: 'tc:authored:1:click',
            actionIdentity: { actionOccurrenceId: 'occ-runtime-1', occurrenceKey: 'tc:authored:1:click' },
          }),
        ],
      },
      replayEnvelope: { ir: { steps: [
        { op: 'act', action: 'click', contractStepId: 'case_step_1', actionOccurrenceId: 'occ-runtime-1', occurrenceKey: 'tc:authored:1:click', actionIdentity: { actionOccurrenceId: 'occ-runtime-1', occurrenceKey: 'tc:authored:1:click' } },
        { op: 'act', action: 'click', contractStepId: 'case_step_2', actionOccurrenceId: 'occ-runtime-2', occurrenceKey: 'tc:authored:2:click', actionIdentity: { actionOccurrenceId: 'occ-runtime-2', occurrenceKey: 'tc:authored:2:click' } },
      ] } },
      status: 'pass',
    });

    expect(graph.nodes.map((entry) => entry.replayStep && entry.replayStep.actionIdentity.actionOccurrenceId)).toEqual([
      'occ-runtime-2',
      'occ-runtime-1',
    ]);
  });
});

describe('CaseContract execution identity namespaces', () => {
  it('preserves authored identity after the conductor canonicalizes steps into contractStepId', () => {
    const stepId = 'case-auth.step.001';
    const testCase = {
      id: 'tc-normalized-auth',
      name: 'Normalized authentication flow',
      compiledCaseRevision: 'revision-normalized-1',
      steps: JSON.stringify([
        { id: stepId, action: 'Fill', target: 'Email Address', value: 'user@example.test' },
      ]),
      declaredAssertions: '[]',
      qualityContractJson: JSON.stringify({
        caseContractV1: {
          steps: [{ id: stepId, stepId, type: 'Fill', target: 'Email Address' }],
          assertions: [],
        },
      }),
    };
    const canonicalSteps = normaliseSteps(testCase.steps);

    expect(canonicalSteps[0]).toMatchObject({ contractStepId: stepId });
    const contract = executableTestContract.buildExecutionContract({
      testCase,
      declaredSteps: canonicalSteps,
      declaredAssertions: [],
    });

    expect(contract.nodes[0]).toMatchObject({
      persistedStepId: stepId,
      caseContractStepId: stepId,
    });
  });

  it('keeps runtime supplemental assertions out of strict immutable node linking', () => {
    const stepId = 'case-runtime.step.001';
    const testCase = {
      id: 'tc-runtime-supplement',
      name: 'Runtime assertion supplement',
      compiledCaseRevision: 'revision-runtime-1',
      steps: JSON.stringify([{ id: stepId, action: 'Navigate', target: 'Home' }]),
      qualityContractJson: JSON.stringify({
        caseContractV1: {
          steps: [{ id: stepId, stepId, type: 'Navigate', target: 'Home' }],
          assertions: [],
        },
      }),
    };

    const contract = executableTestContract.buildExecutionContract({
      testCase,
      declaredSteps: normaliseSteps(testCase.steps),
      declaredAssertions: [{ source: 'inline_assertion_inference', type: 'PAGE', payload: { expectedText: 'Home' } }],
    });

    expect(contract.nodes).toHaveLength(1);
    expect(contract.nodes[0]).toMatchObject({ caseContractStepId: stepId });
  });

  it('links an assertion step and its assertion metadata without treating stepId as a competing identity', () => {
    const stepId = 'case-auth.step.004';
    const assertionId = 'case-auth.assertion.001';
    const contract = executableTestContract.buildExecutionContract({
      testCase: {
        id: 'tc-auth',
        name: 'Authentication flow',
        compiledCaseRevision: 'revision-1',
        steps: JSON.stringify([
          { id: 'case-auth.step.001', action: 'Navigate', target: 'Login page' },
          { id: stepId, action: 'Verify', target: 'Provider option', expected: 'Provider option is visible', oracleRef: assertionId },
        ]),
        declaredAssertions: JSON.stringify([
          { id: assertionId, stepId, expectedText: 'Provider option is visible' },
        ]),
        qualityContractJson: JSON.stringify({
          caseContractV1: {
            steps: [
              { id: 'case-auth.step.001', stepId: 'case-auth.step.001', type: 'Navigate' },
              { id: stepId, stepId, type: 'AssertVisible', failureBehavior: 'continue' },
            ],
            assertions: [
              { id: assertionId, assertionId, stepId, kind: 'visible' },
            ],
          },
        }),
      },
    });

    expect(contract.nodes).toHaveLength(2);
    expect(contract.nodes[1]).toMatchObject({
      persistedStepId: stepId,
      caseContractStepId: stepId,
      caseContractAssertionId: assertionId,
      failureBehavior: 'continue',
    });
  });
});
