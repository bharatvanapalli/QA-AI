import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const conductor = require('../../server/services/agents/conductor.js');
const evidenceReplayIr = require('../../server/services/evidenceReplayIr.js');
const executionAuthoringCompiler = require('../../server/services/executionAuthoringCompiler.js');

function verifiedLocator(expression, identity, backendNodeId) {
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: `document:${identity.caseId}`,
    nodeId: `node:${backendNodeId}`,
    connected: true,
  };
  return {
    strategy: 'role',
    expression,
    frameworkExpressions: { playwright: expression },
    verificationSource: 'authoritative_chromium_cdp',
    source: 'authoritative_chromium_cdp',
    verified: true,
    persistable: true,
    contractStepId: identity.contractStepId,
    actionIdentity: identity,
    proof: {
      verified: true,
      sameElement: true,
      count: 1,
      countBefore: 1,
      countAfter: 1,
      actionTimeResolved: true,
      identityVerified: true,
      resolutionMode: 'bound_mcp_ref',
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
      visible: true,
      enabled: true,
      source: 'authoritative_chromium_cdp',
    },
  };
}

describe('conductor ReplayIR execution-contract identity ownership', () => {
  it('binds a generic authored step to its stable runtime occurrence and verified locator exactly once', () => {
    const caseId = 'identity-owner-case';
    const genericStepId = 'case_step_1';
    const stableStepId = `${caseId}:step:1:stable-hash`;
    const executionContract = {
      schema: 'qaai-executable-test-contract-v1',
      contractId: 'etc_identity_owner_case',
      testCaseId: caseId,
      nodes: [{
        contractStepId: stableStepId,
        persistedStepId: genericStepId,
        testCaseId: caseId,
        stepOrdinal: 1,
        kind: 'action',
        actionType: 'click',
        plannedText: 'Click Continue from the authored flow',
        raw: { id: genericStepId, action: 'Click', element: 'Continue button' },
      }],
    };
    const authoredSteps = [{
      id: genericStepId,
      action: 'Click',
      element: 'Continue button',
      description: 'Human-readable Continue action',
    }];
    const caseContractV1 = conductor._replayCaseContractFromExecutionContract(
      executionContract,
      authoredSteps,
    );
    const projected = caseContractV1.steps[0];
    const baseIdentity = executionAuthoringCompiler.buildActionIdentity({
      testCaseId: caseId,
      contractStepId: stableStepId,
      sequenceIndex: 1,
      operation: 'click',
    });
    const identity = {
      ...baseIdentity,
      actionOccurrenceId: `${stableStepId}:click:1`,
      occurrenceOrdinal: 1,
      occurrenceKey: `${caseId}:${stableStepId}:1:click`,
    };
    const expression = "getByRole('button', { name: 'Continue' })";
    const trail = [{
      tool: 'browser_click',
      toolUseId: 'runtime-attempt-1',
      ok: true,
      contractStepId: stableStepId,
      actionIdentity: identity,
      ...identity,
      args: { element: 'Continue button', role: 'button' },
      actionLocator: verifiedLocator(expression, identity, 911),
      pageUrl: 'https://example.test/start',
      pageUrlAfter: 'https://example.test/next',
    }];

    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId,
        title: 'Stable identity owner',
        trail,
        plannedSteps: caseContractV1.steps,
        declaredSteps: caseContractV1.steps,
        caseContractV1,
        declaredAssertions: [],
        assertionOutcomes: [],
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId: 'rr-identity-owner-case',
        testCase: { id: caseId, name: 'Stable identity owner' },
        status: 'pass',
        trail,
        executionContract,
        assertionOutcomes: [],
      },
    });

    expect(projected).toMatchObject({
      id: stableStepId,
      contractStepId: stableStepId,
      persistedStepId: genericStepId,
      sourceStepId: genericStepId,
      actionOccurrenceId: identity.actionOccurrenceId,
      authoredActionId: identity.authoredActionId,
      text: 'Click Continue from the authored flow',
    });
    expect(projected.id).not.toBe(genericStepId);

    const authoredClicks = built.emit.ir.steps.filter((step) => (
      step.op === 'act'
      && step.action === 'click'
      && step.authored !== false
      && step.evidenceOnly !== true
    ));
    expect(authoredClicks).toHaveLength(1);
    expect(authoredClicks[0].contractStepId).toBe(stableStepId);
    expect(authoredClicks[0].actionOccurrenceId).toBe(identity.actionOccurrenceId);
    expect(authoredClicks[0].authoredActionId).toBe(identity.authoredActionId);
    expect(authoredClicks[0].synthesizedFromContract).not.toBe(true);
    expect(authoredClicks[0].contractStepId).not.toBe(genericStepId);
    expect(authoredClicks[0].actionLocator.frameworkExpressions.playwright).toBe(expression);

    const resolves = built.emit.ir.steps.filter((step) => step.op === 'resolve');
    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toMatchObject({
      contractStepId: stableStepId,
      actionOccurrenceId: identity.actionOccurrenceId,
      locatorRecipeId: built.evidence.locatorRecipes[0].id,
    });
    expect(resolves[0].actionLocator.frameworkExpressions.playwright).toBe(expression);
    expect(built.emit.authoredOccurrenceParity).toMatchObject({
      satisfied: true,
      expectedAuthoredOccurrenceCount: 1,
      matchedAuthoredOccurrenceCount: 1,
      missingAuthoredOccurrenceCount: 0,
      duplicateReplayOccurrenceCount: 0,
    });
    expect(built.emit.ir.steps.some((step) => (
      step.contractStepId === genericStepId
      || step.actionIdentity?.contractStepId === genericStepId
      || String(step.actionOccurrenceId || '').startsWith(`${genericStepId}:`)
    ))).toBe(false);
    expect((built.emit.ir.runtimeEvidence || []).some((entry) => (
      entry.code === 'locator_recipe_occurrence_mismatch_isolated'
      || entry.code === 'duplicate_replay_occurrence_isolated'
      || entry.code === 'authored_occurrence_missing_from_replayir'
    ))).toBe(false);
  });
});
