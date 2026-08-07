import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const replayEmitter = require('../../server/services/codegen/replayEmitter.js');

function authoredIdentity({ caseId, contractStepId, authoredActionId, sequenceIndex, occurrenceOrdinal = 1 }) {
  return {
    caseId,
    contractStepId,
    authoredActionId,
    sequenceIndex,
    operation: 'click',
    actionOccurrenceId: `${contractStepId}:click:${occurrenceOrdinal}`,
    occurrenceOrdinal,
    occurrenceKey: `${caseId}:${contractStepId}:${occurrenceOrdinal}:click`,
  };
}

function verifiedClickLocator(element) {
  const backendNodeId = `controlled:${String(element).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'controlled-document:start',
    nodeId: backendNodeId,
    connected: true,
  };
  const expression = `page.getByRole("button", { name: ${JSON.stringify(element)}, exact: true })`;
  return {
    kind: 'playwright',
    expression,
    frameworkExpressions: { playwright: expression },
    verified: true,
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    pageUrl: 'https://example.test/start',
    captureBinding: { kind: 'mcp_bound_ref', ref: backendNodeId },
    context: { captureBinding: { kind: 'mcp_bound_ref', ref: backendNodeId } },
    targetFacts: { role: 'button', accessibleName: element, backendNodeId },
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
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      url: 'https://example.test/start',
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

function clickTrail(identity, element = 'Continue button') {
  return {
    tool: 'browser_click',
    ok: true,
    contractStepId: identity.contractStepId,
    actionIdentity: identity,
    args: { element, role: 'button' },
    pageUrl: 'https://example.test/start',
    actionLocator: verifiedClickLocator(element),
  };
}

describe('ReplayIR immutable authored occurrence identity', () => {
  it('keeps every executed occurrence and does not infer retry semantics from a repeated identity alone', () => {
    const caseId = 'repeated-actions-case';
    const first = authoredIdentity({
      caseId,
      contractStepId: 'continue-first',
      authoredActionId: 'authored-continue-first',
      sequenceIndex: 1,
    });
    const second = authoredIdentity({
      caseId,
      contractStepId: 'continue-second',
      authoredActionId: 'authored-continue-second',
      sequenceIndex: 2,
    });

    const emitted = replayEmitter.buildReplayIR({
      caseId,
      trail: [clickTrail(first), clickTrail(first), clickTrail(second)],
      caseContractV1: {
        steps: [
          { id: first.contractStepId, type: 'Click', text: 'Click Continue', ...first },
          { id: second.contractStepId, type: 'Click', text: 'Click Continue again', ...second },
        ],
      },
    });

    const authoredClicks = emitted.ir.steps.filter((step) => step.op === 'act' && step.action === 'click');
    expect(authoredClicks).toHaveLength(3);
    expect(authoredClicks.map((step) => step.actionOccurrenceId)).toEqual([
      first.actionOccurrenceId,
      first.actionOccurrenceId,
      second.actionOccurrenceId,
    ]);
    expect(new Set(authoredClicks.map((step) => step.authoredActionId)).size).toBe(2);

    const retryClicks = (emitted.ir.runtimeEvidence || [])
      .filter((step) => step.op === 'act' && step.action === 'click');
    expect(retryClicks).toHaveLength(0);
  });

  it('does not let a foreign stable occurrence satisfy an authored step', () => {
    const caseId = 'foreign-occurrence-case';
    const authored = authoredIdentity({
      caseId,
      contractStepId: 'submit-step',
      authoredActionId: 'authored-submit',
      sequenceIndex: 1,
    });
    const foreign = {
      ...authored,
      actionOccurrenceId: 'submit-step:click:9',
      authoredActionId: 'foreign-authored-submit',
      occurrenceOrdinal: 9,
      occurrenceKey: `${caseId}:submit-step:9:click`,
    };

    const emitted = replayEmitter.buildReplayIR({
      caseId,
      trail: [clickTrail(foreign, 'Submit button')],
      caseContractV1: {
        steps: [{ id: authored.contractStepId, type: 'Click', text: 'Click Submit button', ...authored }],
      },
    });

    const executable = emitted.ir.steps.find((step) => step.op === 'act' && step.action === 'click');
    expect(executable).toMatchObject({
      contractStepId: authored.contractStepId,
      actionOccurrenceId: foreign.actionOccurrenceId,
      authoredActionId: foreign.authoredActionId,
      origin: 'runtime_evidence',
    });
    expect(executable.synthesizedFromContract).not.toBe(true);
    expect(emitted.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'planned_step_not_executed', where: authored.contractStepId }),
    ]));
  });

  it('keeps contract-only actions and waits diagnostic instead of assigning executable occurrence identities', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'contract-only-case',
      trail: [],
      caseContractV1: {
        steps: [
          { id: 'open-menu', type: 'Click', text: 'Click Account menu' },
          { id: 'wait-for-panel', type: 'Wait', text: 'Wait for Account panel' },
        ],
      },
    });

    expect(emitted.ir.steps.filter((step) => ['resolve', 'act', 'waitFor'].includes(step.op)))
      .toHaveLength(0);
    expect(emitted.findings.filter((finding) => finding.code === 'planned_step_not_executed'))
      .toEqual([
        expect.objectContaining({ where: 'open-menu' }),
        expect.objectContaining({ where: 'wait-for-panel' }),
      ]);
  });

  it('keeps an unrecognized unexecuted authored operation diagnostic', () => {
    const authoredStep = {
      id: 'activate-widget',
      type: 'Activate widget with domain gesture',
      text: 'Activate the Account widget with its domain gesture',
      target: 'Account widget',
    };
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'custom-authored-operation-case',
      trail: [],
      caseContractV1: { steps: [authoredStep] },
    });

    const customAction = emitted.ir.steps.find((step) =>
      step.op === 'act' && step.contractStepId === authoredStep.id);
    expect(customAction).toBeUndefined();
    expect(emitted.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'planned_step_not_executed', where: authoredStep.id }),
    ]));
  });

  it('does not invent an authored navigation before a later action captured first in the live trail', () => {
    const caseId = 'navigation-order-case';
    const clickIdentity = authoredIdentity({
      caseId,
      contractStepId: 'continue-step',
      authoredActionId: 'authored-continue',
      sequenceIndex: 2,
    });
    const emitted = replayEmitter.buildReplayIR({
      caseId,
      trail: [clickTrail(clickIdentity)],
      caseContractV1: {
        steps: [
          {
            id: 'open-start-page',
            type: 'Navigate',
            text: 'Navigate to the start page',
            url: 'https://example.test/start',
          },
          {
            id: clickIdentity.contractStepId,
            type: 'Click',
            text: 'Click Continue',
            ...clickIdentity,
          },
        ],
      },
    });

    const actions = emitted.ir.steps.filter((step) => step.op === 'act');
    expect(actions.map((step) => step.action)).toEqual(['click']);
    expect(emitted.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'planned_step_not_executed', where: 'open-start-page' }),
    ]));
    expect(actions.some((step) => step.action === 'navigate' && (!step.url || step.url === '/'))).toBe(false);
  });
});
