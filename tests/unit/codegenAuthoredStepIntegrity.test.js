import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const stepShape = require('../../server/lib/stepShape.js');
const generationCompiler = require('../../server/services/generationCompiler.js');
const replayEmitter = require('../../server/services/codegen/replayEmitter.js');
const { buildExecutedCaseAstV1 } = require('../../server/services/codegen/executedCaseAst.js');

describe('website-neutral authored step integrity', () => {
  it('preserves immutable contract identity through step normalization and prompt projection', () => {
    const input = {
      action: 'Click',
      element: 'Primary action',
      contractStepId: 'contract-step-2',
      sourceContractStepId: 'draft-step-b',
      origin: 'authored',
      authored: true,
    };

    expect(stepShape.normaliseStepShape(input)).toMatchObject({
      contractStepId: 'contract-step-2',
      sourceContractStepId: 'draft-step-b',
      origin: 'authored',
      authored: true,
    });
    expect(stepShape.serialiseStepForPrompt(input)).toMatchObject({
      contractStepId: 'contract-step-2',
      sourceContractStepId: 'draft-step-b',
    });
  });

  it('projects aligned authored contract ids without changing step order or count', () => {
    const projected = generationCompiler._private.preserveAuthoredStepIdentities(
      [{ action: 'Fill', id: 'draft-a' }, { action: 'Click', id: 'draft-b' }],
      [{ id: 'contract-a' }, { id: 'contract-b' }],
    );

    expect(projected).toHaveLength(2);
    expect(projected.map((step) => step.contractStepId)).toEqual(['contract-a', 'contract-b']);
    expect(projected.map((step) => step.sourceContractStepId)).toEqual(['draft-a', 'draft-b']);
    expect(projected.map((step) => step.action)).toEqual(['Fill', 'Click']);
  });

  it('never assigns foreign runtime evidence to an authored step by similar action or label', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'identity-case',
      trail: [{
        tool: 'browser_click',
        ok: true,
        contractStepId: 'foreign-runtime-step',
        args: { element: 'Continue button', role: 'button' },
        pageUrl: 'https://example.test/start',
      }],
      caseContractV1: {
        steps: [
          { id: 'authored-step-1', type: 'Click', text: 'Click Continue button' },
          { id: 'authored-step-2', type: 'Click', text: 'Click Continue button again' },
        ],
      },
    });

    const authoredActs = emitted.ir.steps.filter((step) =>
      step.op === 'act' && ['authored-step-1', 'authored-step-2'].includes(step.contractStepId));
    expect(authoredActs).toHaveLength(2);
    expect(authoredActs.every((step) => step.synthesizedFromContract === true)).toBe(true);
    expect(authoredActs.every((step) => step.sourceContractStepId == null)).toBe(true);
  });

  it('records observed redirects as helper context transitions, not authored navigation acts', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'transition-case',
      trail: [
        { tool: 'browser_click', ok: true, args: { element: 'First action' }, pageUrl: 'https://example.test/one' },
        { tool: 'browser_click', ok: true, args: { element: 'Second action' }, pageUrl: 'https://example.test/two' },
      ],
    });

    expect(emitted.ir.contextTransitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'observed_start_state', helperOperation: true, authored: false }),
      expect.objectContaining({ kind: 'observed_context_transition', helperOperation: true, authored: false }),
    ]));
    expect(emitted.ir.steps.some((step) => step.contextSwitchInferred === true)).toBe(false);
  });

  it('keeps the authored AST authoritative and does not append unmatched runtime operations', () => {
    const ast = buildExecutedCaseAstV1({
      executionContract: {
        nodes: [
          { contractStepId: 'step-1', stepOrdinal: 1, kind: 'action', actionType: 'click', raw: { target: 'Continue' } },
          { contractStepId: 'step-2', stepOrdinal: 2, kind: 'action', actionType: 'fill', raw: { target: 'Password' } },
        ],
      },
      replayEnvelope: {
        ir: {
          steps: [
            { op: 'act', action: 'click', contractStepId: 'foreign-step', origin: 'unbound_runtime_evidence' },
            { op: 'act', action: 'navigate', origin: 'inferred_helper', helperOperation: true },
          ],
        },
      },
    });

    expect(ast.nodes.map((node) => node.stepId)).toEqual(['step-1', 'step-2']);
    expect(ast.nodes.every((node) => node.authored === true)).toBe(true);
    expect(ast.source.unmatchedReplayOperations).toHaveLength(2);
  });

  it('preserves an expected-null assertion as an explicit authored contract', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'null-assertion-case',
      declaredAssertions: [{ id: 'assert-page', type: 'PAGE', payload: {} }],
      assertionOutcomes: [],
    });

    expect(emitted.ir.steps).toContainEqual(expect.objectContaining({
      op: 'assert',
      contractRef: 'assert-page',
      missingAuthoredExpected: true,
      authoredContractText: 'PAGE assertion',
    }));
    expect(emitted.gaps).not.toContainEqual(expect.objectContaining({ code: 'missing_assertion_expected' }));
    expect(emitted.findings).toContainEqual(expect.objectContaining({ code: 'missing_assertion_expected_preserved' }));
  });
});
