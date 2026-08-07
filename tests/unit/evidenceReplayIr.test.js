import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const evidenceReplayIr = require('../../server/services/evidenceReplayIr.js');

function locator(expression) {
  return {
    strategy: 'role',
    expression,
    frameworkExpressions: { playwright: expression },
    verificationSource: 'verified_dom_inspection',
    verified: true,
    proof: {
      verified: true,
      sameElement: true,
      count: 1,
      visible: true,
      enabled: true,
      source: 'verified_dom_inspection',
    },
    domAtlas: {
      verifiedActions: [{ expression }],
    },
  };
}

function occurrenceIdentity(caseId, occurrenceOrdinal, overrides = {}) {
  const contractStepId = overrides.contractStepId || `${caseId}:step:1`;
  const operation = overrides.operation || 'click';
  return {
    schemaVersion: 'qaai-action-occurrence-v1',
    caseId,
    contractStepId,
    sourceContractStepId: overrides.sourceContractStepId || `${caseId}:source-step:1`,
    actionOccurrenceId: overrides.actionOccurrenceId || `${contractStepId}:${operation}:${occurrenceOrdinal}`,
    sourceActionOccurrenceId: overrides.sourceActionOccurrenceId || `${contractStepId}:${operation}:source:${occurrenceOrdinal}`,
    authoredActionId: overrides.authoredActionId || `${contractStepId}:action:${occurrenceOrdinal}`,
    sequenceIndex: overrides.sequenceIndex ?? occurrenceOrdinal + 4,
    occurrenceOrdinal,
    occurrenceKey: overrides.occurrenceKey || `${caseId}:${contractStepId}:${occurrenceOrdinal}:${operation}`,
    toolName: overrides.toolName || 'browser_click',
    operation,
  };
}

function occurrenceLocator(expression, identity, backendNodeId) {
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: `document:${identity.caseId}`,
    nodeId: `node:${backendNodeId}`,
    connected: true,
  };
  const captureBinding = {
    kind: 'mcp_bound_ref',
    ref: `ref-${backendNodeId}`,
    ...identity,
  };
  return {
    strategy: 'role',
    expression,
    frameworkExpressions: { playwright: expression },
    verificationSource: 'verified_dom_inspection',
    verified: true,
    targetIdentity,
    actionIdentity: identity,
    contractStepId: identity.contractStepId,
    context: {
      framePath: ["iframe[name='auth-frame']"],
      shadowPath: ['qa-auth-shell'],
      popupIdentity: { pageId: `popup:${identity.caseId}`, openerPageId: 'page:root' },
      captureBinding,
      authoritativeCdp: {
        pre: {
          schema: 'qaai-authoritative-cdp-capture-v1',
          captured: true,
          authoritative: true,
          identity: { backendNodeId, connected: true },
          framePathSelectors: ["iframe[name='auth-frame']"],
          shadowPath: ['qa-auth-shell'],
          captureBinding,
        },
        post: {
          schema: 'qaai-authoritative-cdp-capture-v1',
          captured: true,
          authoritative: true,
          identity: { backendNodeId, connected: true },
        },
      },
    },
    proof: {
      verified: true,
      sameElement: true,
      count: 1,
      actionTimeResolved: true,
      identityVerified: true,
      resolutionMode: 'bound_mcp_ref',
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
      visible: true,
      enabled: true,
      source: 'verified_dom_inspection',
    },
  };
}

function authoredClick({
  caseId,
  occurrenceOrdinal,
  toolUseId,
  actionOccurrenceId,
  retryOfActionEvidenceId = null,
  ok = true,
  backendNodeId = 700 + occurrenceOrdinal,
} = {}) {
  const identity = occurrenceIdentity(caseId, occurrenceOrdinal, { actionOccurrenceId });
  return {
    tool: 'browser_click',
    toolUseId,
    retryOfActionEvidenceId,
    ok,
    ...identity,
    actionIdentity: identity,
    args: { ref: `ref-${backendNodeId}`, element: 'Continue' },
    actionLocator: occurrenceLocator("getByRole('button', { name: 'Continue' })", identity, backendNodeId),
    pageUrl: 'https://example.test/form',
    pageUrlAfter: 'https://example.test/form',
  };
}

function authoredWaitClick({
  caseId,
  occurrenceOrdinal = 1,
  toolUseId,
  waitContract,
  authored = true,
  retryOfActionEvidenceId = null,
  ok = true,
  waitObservation = null,
  backendNodeId = 900 + occurrenceOrdinal,
} = {}) {
  const entry = authoredClick({
    caseId,
    occurrenceOrdinal,
    toolUseId,
    retryOfActionEvidenceId,
    ok,
    backendNodeId,
  });
  entry.operationCheck = {
    kind: 'visible',
    expected: 'Continue is visible',
  };
  entry.waitContract = structuredClone(waitContract);
  if (authored) {
    entry.stepAuthoring = {
      actionIdentity: structuredClone(entry.actionIdentity),
      waitContract: structuredClone(waitContract),
    };
  }
  if (waitObservation) entry.waitObservation = structuredClone(waitObservation);
  return entry;
}

describe('evidence-built ReplayIR', () => {
  it('keeps ReplayIR complete when captured actions, locators, and assertions are complete', () => {
    const identity = occurrenceIdentity('tc-complete', 1);
    const trail = [{
      tool: 'browser_click',
      toolUseId: 'attempt-complete-1',
      ...identity,
      actionIdentity: identity,
      args: { element: 'Save' },
      actionLocator: occurrenceLocator("getByRole('button', { name: 'Save' })", identity, 701),
      pageUrl: 'https://example.test/form',
      pageUrlAfter: 'https://example.test/form',
    }];
    const assertionOutcomes = [
      { assertionId: 'asn-final', kind: 'text', expected: 'Saved', actual: 'Saved', matched: true, source: 'assertion_check' },
    ];

    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId: 'tc-complete',
        title: 'Save form',
        trail,
        declaredAssertions: [{ id: 'asn-final', kind: 'text', required: true }],
        assertionOutcomes,
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId: 'rr-complete',
        testCase: { id: 'tc-complete', name: 'Save form', declaredAssertions: [{ id: 'asn-final', kind: 'text', required: true }] },
        status: 'pass',
        trail,
        assertionOutcomes,
      },
    });

    expect(built.evidence.ledger.evidenceStatus).toBe('complete');
    expect(built.emit.complete, JSON.stringify(built.emit.gaps)).toBe(true);
    expect(built.emit.gaps).toEqual([]);
    expect(built.emit.evidenceBuiltReplayIr.evidenceStatus).toBe('complete');
  });

  it('forces complete:false when required assertion evidence parse fails', () => {
    const trail = [{
      tool: 'assertion_check',
      args: { assertionId: 'asn-broken', expected: '' },
    }];
    const assertionOutcomes = [
      { assertionId: 'asn-broken', kind: 'text', outcome: 'parse_failed', reason: 'parse_failed: expected text missing' },
    ];

    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId: 'tc-parse-failed',
        title: 'Broken oracle',
        trail,
        declaredAssertions: [{ id: 'asn-broken', kind: 'text', required: true }],
        assertionOutcomes,
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId: 'rr-parse-failed',
        testCase: { id: 'tc-parse-failed', name: 'Broken oracle', declaredAssertions: [{ id: 'asn-broken', kind: 'text', required: true }] },
        status: 'pass',
        trail,
        assertionOutcomes,
      },
    });

    expect(built.evidence.ledger.parseFailedAssertionCount).toBe(1);
    expect(built.emit.complete).toBe(false);
    expect(built.emit.gaps.some((gap) => gap.code === 'parse_failed_assertion')).toBe(true);
    expect(built.emit.gaps.some((gap) => gap.code === 'missing_assertion_evidence')).toBe(true);
  });

  it('keeps locator-only evidence gaps non-blocking when every missing locator has a guessed resolve', () => {
    const trail = [{
      tool: 'browser_click',
      args: { element: 'Save button' },
      pageUrl: 'https://example.test/form',
      pageUrlAfter: 'https://example.test/form',
      actionLocatorGap: {
        code: 'missing_verified_action_locator',
        pageUrl: 'https://example.test/form',
        elementLabel: 'Save button',
      },
    }];

    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId: 'tc-guessed-locator',
        title: 'Save form with guessed locator',
        trail,
        declaredAssertions: [],
        assertionOutcomes: [],
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId: 'rr-guessed-locator',
        testCase: { id: 'tc-guessed-locator', name: 'Save form with guessed locator' },
        status: 'pass',
        trail,
        assertionOutcomes: [],
      },
    });

    expect(built.evidence.ledger.missingLocatorCount).toBe(1);
    expect(built.emit.complete).toBe(true);
    expect(built.emit.gaps).toEqual([]);
    expect(built.emit.nonBlockingLocatorGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_locator_evidence', severity: 'warning', nonBlocking: true }),
    ]));
    expect(built.emit.ir.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'resolve', guessedLocator: true, locatorConfidence: 'guessed' }),
      expect.objectContaining({ op: 'act', action: 'click' }),
    ]));
  });

  it.each([
    {
      label: 'maximum 10 seconds and reload threshold 5 seconds',
      suffix: 'ten-five',
      waitContract: {
        schema: 'qaai_wait_contract_v1',
        kind: 'dom_effect',
        timeoutMs: 10_000,
        refreshAfterMs: 5_000,
        pollIntervalMs: 211,
        stableObservations: 3,
        recovery: { action: 'reload', maxAttempts: 1, waitUntil: 'domcontentloaded' },
        sameSession: true,
      },
      expectedCondition: {
        timeoutMs: 10_000,
        refreshAfterMs: 5_000,
        pollIntervalMs: 211,
        stableObservations: 3,
        recovery: { action: 'reload', maxAttempts: 1, waitUntil: 'domcontentloaded' },
        sameSession: true,
      },
    },
    {
      label: 'arbitrary maximum and reload threshold without hardcoding',
      suffix: 'arbitrary',
      waitContract: {
        schema: 'qaai_wait_contract_v1',
        kind: 'dom_effect',
        timeoutMs: 23_741,
        reloadAfterMs: 6_831,
        pollMs: 347,
        stableObservations: 4,
        recoveryAction: 'refresh',
        recoveryLimit: 2,
        sameSession: false,
      },
      expectedCondition: {
        timeoutMs: 23_741,
        reloadAfterMs: 6_831,
        refreshAfterMs: 6_831,
        pollMs: 347,
        pollIntervalMs: 347,
        stableObservations: 4,
        recoveryAction: 'refresh',
        recoveryLimit: 2,
        recovery: { action: 'refresh', maxAttempts: 2 },
        sameSession: false,
      },
    },
  ])('propagates authored wait contract verbatim: $label', ({ suffix, waitContract, expectedCondition }) => {
    const caseId = `tc-authored-wait-${suffix}`;
    const runResultId = `rr-authored-wait-${suffix}`;
    const trail = [authoredWaitClick({
      caseId,
      toolUseId: `attempt-authored-wait-${suffix}`,
      waitContract,
      backendNodeId: suffix === 'ten-five' ? 911 : 912,
    })];
    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId,
        title: `Authored wait ${suffix}`,
        trail,
        declaredAssertions: [],
        assertionOutcomes: [],
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId,
        testCase: { id: caseId, name: `Authored wait ${suffix}` },
        status: 'pass',
        trail,
        assertionOutcomes: [],
      },
    });

    const replayWait = built.emit.ir.steps.find((step) => (
      step.op === 'waitFor'
      && step.authored !== false
      && step.evidenceOnly !== true
    ));
    expect(replayWait.waitContract).toEqual(waitContract);
    expect(replayWait.condition).toMatchObject(expectedCondition);
    expect(built.evidence.actionEvidences[0].authoredWaitContract).toEqual(waitContract);
    expect(JSON.parse(built.evidence.actionEvidences[0].evidenceJson).authoredWaitContract).toEqual(waitContract);
    expect(built.emit.authoredWaitContractPropagation).toMatchObject({
      authoredWaitContractCount: 1,
      propagatedWaitCount: 1,
      missingReplayWaitCount: 0,
    });
  });

  it('keeps retry wait observations diagnostic and restores the original authored timing', () => {
    const caseId = 'tc-authored-wait-retry';
    const runResultId = 'rr-authored-wait-retry';
    const authoredContract = {
      schema: 'qaai_wait_contract_v1',
      kind: 'dom_effect',
      timeoutMs: 13_457,
      refreshAfterMs: 4_231,
      pollIntervalMs: 293,
      stableObservations: 2,
      recovery: { action: 'reload', maxAttempts: 1 },
      sameSession: true,
    };
    const runtimeRetryContract = {
      schema: 'qaai_wait_contract_v1',
      kind: 'dom_effect',
      timeoutMs: 99_999,
      refreshAfterMs: 88_888,
      pollIntervalMs: 7_777,
      stableObservations: 9,
      recovery: { action: 'reload', maxAttempts: 7 },
      sameSession: false,
    };
    const trail = [
      authoredWaitClick({
        caseId,
        toolUseId: 'attempt-authored-wait-original',
        waitContract: authoredContract,
        authored: true,
        ok: false,
        backendNodeId: 921,
      }),
      authoredWaitClick({
        caseId,
        toolUseId: 'attempt-authored-wait-retry',
        retryOfActionEvidenceId: 'attempt-authored-wait-original',
        waitContract: runtimeRetryContract,
        authored: false,
        ok: true,
        waitObservation: { status: 'recovered', outcome: 'visible_after_reload' },
        backendNodeId: 921,
      }),
    ];
    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId,
        title: 'Keep authored timing across retry observations',
        trail,
        declaredAssertions: [],
        assertionOutcomes: [],
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId,
        testCase: { id: caseId, name: 'Keep authored timing across retry observations' },
        status: 'pass',
        trail,
        assertionOutcomes: [],
      },
    });

    const replayWait = built.emit.ir.steps.find((step) => (
      step.op === 'waitFor'
      && step.authored !== false
      && step.evidenceOnly !== true
    ));
    expect(replayWait.waitContract).toEqual(authoredContract);
    expect(replayWait.condition).toMatchObject({
      timeoutMs: 13_457,
      refreshAfterMs: 4_231,
      pollIntervalMs: 293,
      stableObservations: 2,
      recovery: { action: 'reload', maxAttempts: 1 },
      sameSession: true,
    });
    expect(replayWait.condition.timeoutMs).not.toBe(99_999);
    expect(replayWait.condition.refreshAfterMs).not.toBe(88_888);
    expect(built.evidence.actionEvidences.every((row) => (
      JSON.stringify(row.authoredWaitContract) === JSON.stringify(authoredContract)
    ))).toBe(true);
    expect(built.emit.ir.runtimeEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'retry_wait_contract_observation_isolated' }),
      expect.objectContaining({ code: 'runtime_wait_observation_retained', retryObservation: true }),
    ]));
    expect(built.emit.complete).toBe(true);
    expect(built.emit.gaps).toEqual([]);
  });

  it('blocks legacy inert ReplayIR from completed evidence status', () => {
    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId: 'tc-legacy',
        title: 'Legacy empty trail',
        trail: [],
        declaredAssertions: [],
        assertionOutcomes: [],
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId: 'rr-legacy',
        testCase: { id: 'tc-legacy', name: 'Legacy empty trail' },
        status: 'pass',
        trail: [],
        assertionOutcomes: [],
      },
    });

    expect(built.emit.complete).toBe(false);
    expect(built.emit.gaps.some((gap) => gap.code === 'legacy_inert')).toBe(true);
    expect(built.emit.gaps.some((gap) => gap.code === 'legacy_inert_not_exportable')).toBe(true);
  });

  it('keeps repeated identical authored actions distinct by immutable scoped occurrence identity', () => {
    const caseId = 'tc-repeat-occurrence-parity';
    const trail = [
      authoredClick({ caseId, occurrenceOrdinal: 1, toolUseId: 'attempt-repeat-1', backendNodeId: 801 }),
      authoredClick({ caseId, occurrenceOrdinal: 2, toolUseId: 'attempt-repeat-2', backendNodeId: 802 }),
    ];

    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId,
        title: 'Click Continue twice',
        trail,
        declaredAssertions: [],
        assertionOutcomes: [],
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId: 'rr-repeat-occurrence-parity',
        testCase: { id: caseId, name: 'Click Continue twice' },
        status: 'pass',
        trail,
        assertionOutcomes: [],
      },
    });

    const authoredClicks = built.emit.ir.steps.filter((step) => (
      step.op === 'act'
      && step.action === 'click'
      && step.authored !== false
      && step.evidenceOnly !== true
    ));
    expect(authoredClicks).toHaveLength(2);
    expect(authoredClicks.map((step) => step.actionOccurrenceId)).toEqual([
      `${caseId}:step:1:click:1`,
      `${caseId}:step:1:click:2`,
    ]);
    expect(authoredClicks.every((step) => step.occurrenceScope.runResultId === 'rr-repeat-occurrence-parity')).toBe(true);
    expect(authoredClicks.every((step) => step.occurrenceScope.testCaseId === caseId)).toBe(true);
    expect(authoredClicks[0].actionLocator.frameworkExpressions.playwright).toBe("getByRole('button', { name: 'Continue' })");
    expect(authoredClicks[0].captureEvidence.framePath).toEqual(["iframe[name='auth-frame']"]);
    expect(authoredClicks[0].captureEvidence.shadowPath).toEqual(['qa-auth-shell']);
    expect(authoredClicks[0].captureEvidence.popupIdentity).toEqual({ pageId: `popup:${caseId}`, openerPageId: 'page:root' });
    expect(built.emit.authoredOccurrenceParity).toMatchObject({
      satisfied: true,
      expectedAuthoredOccurrenceCount: 2,
      matchedAuthoredOccurrenceCount: 2,
      missingAuthoredOccurrenceCount: 0,
      duplicateReplayOccurrenceCount: 0,
    });
  });

  it('reconciles a stable occurrence and locator recipe across different authored-action namespaces', () => {
    const caseId = 'tc-stable-occurrence-authored-namespace';
    const runResultId = 'rr-stable-occurrence-authored-namespace';
    const trail = [authoredClick({
      caseId,
      occurrenceOrdinal: 1,
      toolUseId: 'attempt-stable-namespace',
      backendNodeId: 829,
    })];
    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId,
        title: 'Keep the captured locator across compiler identity namespaces',
        trail,
        declaredAssertions: [],
        assertionOutcomes: [],
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId,
        testCase: { id: caseId, name: 'Keep the captured locator across compiler identity namespaces' },
        status: 'pass',
        trail,
        assertionOutcomes: [],
      },
    });

    const evidence = structuredClone(built.evidence);
    const evidenceRow = evidence.actionEvidences[0];
    evidenceRow.authoredActionId = 'persisted-compiler:action:1';
    const evidenceJson = JSON.parse(evidenceRow.evidenceJson);
    evidenceJson.authoredIdentity.authoredActionId = evidenceRow.authoredActionId;
    evidenceRow.evidenceJson = JSON.stringify(evidenceJson);

    const locatorRecipe = evidence.locatorRecipes[0];
    locatorRecipe.authoredActionId = 'locator-compiler:action:1';
    locatorRecipe._recipe.actionIdentity.authoredActionId = locatorRecipe.authoredActionId;
    const locatorRecipeJson = JSON.parse(locatorRecipe.locatorRecipeJson);
    locatorRecipeJson.actionIdentity.authoredActionId = locatorRecipe.authoredActionId;
    locatorRecipe.locatorRecipeJson = JSON.stringify(locatorRecipeJson);

    const ir = structuredClone(built.emit.ir);
    const act = ir.steps.find((step) => step.op === 'act' && step.action === 'click');
    const resolve = ir.steps.find((step) => step.op === 'resolve' && step.as === act.target);
    for (const step of [act, resolve]) {
      step.authoredActionId = 'runtime-compiler:action:1';
      step.actionIdentity.authoredActionId = step.authoredActionId;
      delete step.actionLocator;
      delete step.locatorRecipeId;
      delete step.locatorContext;
      delete step.captureEvidence;
    }
    const emit = { ir, findings: [], gaps: [], complete: true };
    const canonicalization = evidenceReplayIr.canonicalizeReplayTrailOccurrences({
      trail,
      runResultId,
      testCaseId: caseId,
    });

    const parity = evidenceReplayIr.applyAuthoredOccurrenceParityInvariant({
      emit,
      evidence,
      canonicalization,
    });

    expect(parity.report).toMatchObject({
      satisfied: true,
      expectedAuthoredOccurrenceCount: 1,
      matchedAuthoredOccurrenceCount: 1,
      missingAuthoredOccurrenceCount: 0,
    });
    expect(act.actionLocator.frameworkExpressions.playwright).toBe("getByRole('button', { name: 'Continue' })");
    expect(resolve.actionLocator.frameworkExpressions.playwright).toBe("getByRole('button', { name: 'Continue' })");
    expect(parity.diagnostics.some((item) => item.code === 'locator_recipe_occurrence_mismatch_isolated')).toBe(false);
  });

  it('falls back to contract step, normalized operation, and ordinal when stable occurrence IDs are absent', () => {
    const caseId = 'tc-contract-operation-ordinal-fallback';
    const runResultId = 'rr-contract-operation-ordinal-fallback';
    const contractStepId = `${caseId}:step:3`;
    const evidenceIdentity = {
      caseId,
      contractStepId,
      occurrenceOrdinal: 2,
      authoredActionId: 'persisted-compiler:action:22',
      operation: 'browser_click',
    };
    const replayIdentity = {
      caseId,
      contractStepId,
      occurrenceOrdinal: 2,
      authoredActionId: 'runtime-compiler:action:b8f',
      operation: 'click',
    };
    const emit = {
      complete: true,
      findings: [],
      gaps: [],
      ir: {
        caseId,
        steps: [{
          op: 'act',
          action: 'click',
          ...replayIdentity,
          actionIdentity: replayIdentity,
        }],
      },
    };
    const evidence = {
      runResultId,
      testCaseId: caseId,
      actionEvidences: [{
        id: 'actev-contract-operation-ordinal',
        runResultId,
        testCaseId: caseId,
        exportable: true,
        actionKind: 'click',
        ...evidenceIdentity,
        evidenceJson: JSON.stringify({ authoredIdentity: evidenceIdentity }),
      }],
      locatorRecipes: [],
    };

    const parity = evidenceReplayIr.applyAuthoredOccurrenceParityInvariant({
      emit,
      evidence,
      canonicalization: {
        scope: { runResultId, testCaseId: caseId },
        diagnostics: [],
        selectedAttemptByOccurrenceKey: new Map(),
      },
    });

    expect(parity.report).toMatchObject({
      satisfied: true,
      expectedAuthoredOccurrenceCount: 1,
      matchedAuthoredOccurrenceCount: 1,
      missingAuthoredOccurrenceCount: 0,
    });
    expect(emit.ir.steps[0].actionEvidenceId).toBe('actev-contract-operation-ordinal');
    expect(emit.ir.steps[0].authoredActionId).toBe('persisted-compiler:action:22');
  });

  it('isolates a same-case locatorRecipeId that points at another repeated authored occurrence', () => {
    const caseId = 'tc-stale-recipe-occurrence-parity';
    const runResultId = 'rr-stale-recipe-occurrence-parity';
    const trail = [
      authoredClick({ caseId, occurrenceOrdinal: 1, toolUseId: 'attempt-stale-1', backendNodeId: 831 }),
      authoredClick({ caseId, occurrenceOrdinal: 2, toolUseId: 'attempt-stale-2', backendNodeId: 832 }),
    ];
    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId,
        title: 'Do not cross-attach repeated step locators',
        trail,
        declaredAssertions: [],
        assertionOutcomes: [],
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId,
        testCase: { id: caseId, name: 'Do not cross-attach repeated step locators' },
        status: 'pass',
        trail,
        assertionOutcomes: [],
      },
    });

    const evidence = structuredClone(built.evidence);
    const firstEvidence = evidence.actionEvidences.find((row) => row.occurrenceOrdinal === 1);
    const secondRecipe = evidence.locatorRecipes.find((row) => row.occurrenceOrdinal === 2);
    firstEvidence.locatorRecipeId = secondRecipe.id;

    const ir = structuredClone(built.emit.ir);
    const firstAct = ir.steps.find((step) => step.op === 'act' && step.occurrenceOrdinal === 1);
    const firstResolve = ir.steps.find((step) => step.op === 'resolve' && step.as === firstAct.target);
    for (const step of [firstAct, firstResolve]) {
      delete step.actionLocator;
      delete step.locatorRecipeId;
      delete step.locatorContext;
      delete step.captureEvidence;
    }
    const emit = { ir, findings: [], gaps: [], complete: true };
    const canonicalization = evidenceReplayIr.canonicalizeReplayTrailOccurrences({
      trail,
      runResultId,
      testCaseId: caseId,
    });

    const parity = evidenceReplayIr.applyAuthoredOccurrenceParityInvariant({
      emit,
      evidence,
      canonicalization,
    });

    expect(firstAct.actionLocator).toBeUndefined();
    expect(firstResolve.actionLocator).toBeUndefined();
    expect(firstAct.locatorRecipeId).toBeUndefined();
    expect(firstResolve.locatorRecipeId).toBeUndefined();
    expect(parity.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'locator_recipe_occurrence_mismatch_isolated',
        actionEvidenceId: firstEvidence.id,
        locatorRecipeId: secondRecipe.id,
        mismatchFields: expect.arrayContaining([
          'actionOccurrenceId',
          'occurrenceOrdinal',
        ]),
      }),
    ]));
    expect(emit.complete).toBe(true);
    expect(emit.gaps).toEqual([]);
  });

  it('persists retry evidence but emits only one authored ReplayIR occurrence', () => {
    const caseId = 'tc-retry-occurrence-parity';
    const actionOccurrenceId = `${caseId}:step:1:click:1`;
    const trail = [
      authoredClick({
        caseId,
        occurrenceOrdinal: 1,
        actionOccurrenceId,
        toolUseId: 'attempt-retry-1',
        ok: false,
        backendNodeId: 811,
      }),
      authoredClick({
        caseId,
        occurrenceOrdinal: 1,
        actionOccurrenceId,
        toolUseId: 'attempt-retry-2',
        retryOfActionEvidenceId: 'attempt-retry-1',
        ok: true,
        backendNodeId: 811,
      }),
    ];

    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId,
        title: 'Retry Continue once',
        trail,
        declaredAssertions: [],
        assertionOutcomes: [],
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId: 'rr-retry-occurrence-parity',
        testCase: { id: caseId, name: 'Retry Continue once' },
        status: 'pass',
        trail,
        assertionOutcomes: [],
      },
    });

    expect(built.evidence.actionEvidences).toHaveLength(2);
    const authoredClicks = built.emit.ir.steps.filter((step) => (
      step.op === 'act'
      && step.action === 'click'
      && step.authored !== false
      && step.evidenceOnly !== true
    ));
    expect(authoredClicks).toHaveLength(1);
    expect(authoredClicks[0].actionOccurrenceId).toBe(actionOccurrenceId);
    expect(authoredClicks[0].actionEvidenceId).toBe(
      built.evidence.actionEvidences.find((row) => row.actionAttemptId === 'attempt-retry-2').id,
    );
    expect(authoredClicks[0].actionLocator.frameworkExpressions.playwright).toBe("getByRole('button', { name: 'Continue' })");
    expect(authoredClicks[0].captureEvidence.pre.backendNodeId).toBe(811);
    expect(built.emit.ir.runtimeEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'retry_attempt_isolated',
        actionOccurrenceId,
        retainedActionAttemptId: 'attempt-retry-2',
      }),
    ]));
    expect(built.emit.authoredOccurrenceParity).toMatchObject({
      satisfied: true,
      expectedAuthoredOccurrenceCount: 1,
      matchedAuthoredOccurrenceCount: 1,
      duplicateReplayOccurrenceCount: 0,
    });
    expect(built.emit.ir.runtimeEvidence.some((item) => item.code === 'locator_recipe_occurrence_mismatch_isolated')).toBe(false);
  });

  it('does not let a stable foreign case occurrence satisfy local run-and-case parity', () => {
    const localCaseId = 'tc-local-occurrence-parity';
    const foreignCaseId = 'tc-foreign-occurrence-parity';
    const sharedOccurrenceId = 'shared-step:click:1';
    const foreign = authoredClick({
      caseId: foreignCaseId,
      occurrenceOrdinal: 1,
      actionOccurrenceId: sharedOccurrenceId,
      toolUseId: 'attempt-foreign',
      backendNodeId: 821,
    });
    const local = authoredClick({
      caseId: localCaseId,
      occurrenceOrdinal: 1,
      actionOccurrenceId: sharedOccurrenceId,
      toolUseId: 'attempt-local',
      backendNodeId: 822,
    });
    const trail = [foreign, local];

    const built = evidenceReplayIr.buildEvidenceBuiltReplayIR({
      replayInput: {
        caseId: localCaseId,
        title: 'Keep only local occurrence',
        trail,
        declaredAssertions: [],
        assertionOutcomes: [],
        verdictStatus: 'pass',
      },
      evidenceInput: {
        runResultId: 'rr-cross-case-occurrence-parity',
        testCase: { id: localCaseId, name: 'Keep only local occurrence' },
        status: 'pass',
        trail,
        assertionOutcomes: [],
      },
    });

    expect(built.evidence.actionEvidences).toHaveLength(2);
    const authoredClicks = built.emit.ir.steps.filter((step) => (
      step.op === 'act'
      && step.action === 'click'
      && step.authored !== false
      && step.evidenceOnly !== true
    ));
    expect(authoredClicks).toHaveLength(1);
    expect(authoredClicks[0].actionIdentity.caseId).toBe(localCaseId);
    expect(authoredClicks[0].actionEvidenceId).toBe(
      built.evidence.actionEvidences.find((row) => row.actionAttemptId === 'attempt-local').id,
    );
    expect(built.emit.ir.runtimeEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'foreign_occurrence_isolated',
        foreignTestCaseId: foreignCaseId,
      }),
      expect.objectContaining({
        code: 'foreign_persisted_occurrence_isolated',
        foreignTestCaseId: foreignCaseId,
      }),
    ]));
    expect(built.emit.authoredOccurrenceParity).toMatchObject({
      satisfied: true,
      expectedAuthoredOccurrenceCount: 1,
      matchedAuthoredOccurrenceCount: 1,
      foreignOccurrenceCount: 2,
    });
    expect(built.emit.complete, JSON.stringify(built.emit.gaps)).toBe(true);
    expect(built.emit.gaps).toEqual([]);
  });

  it('throws if a completed run attempts to persist incomplete ReplayIR', () => {
    expect(() => evidenceReplayIr.assertCompletedRunReplayIrInvariant({
      statuses: { overallRunStatus: 'complete' },
      envelope: { complete: false, gaps: [{ code: 'missing_locator_evidence' }] },
    })).toThrow(/Completed run cannot persist incomplete ReplayIR/);
  });
});
