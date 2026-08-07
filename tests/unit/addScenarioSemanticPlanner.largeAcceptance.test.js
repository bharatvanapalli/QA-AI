import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  SEMANTIC_PLANNER_PRIOR_CASE_ID,
  SEMANTIC_PLANNER_SENSITIVE_REF,
  SEMANTIC_PLANNER_SENSITIVE_SENTINEL,
  SEMANTIC_PLANNER_UNRESOLVED_QUESTION,
  buildLargeSemanticPlannerFixture,
} from '../fixtures/addScenarioSemanticPlanner80.fixture.js';

const require = createRequire(import.meta.url);
const planner = require('../../server/services/addScenarioSemanticPlanner');
const { buildSourceLedger } = require('../../server/services/addScenarioSourceLedger');

function attachLargeFixtureSourceClaims(fixture) {
  const ledger = buildSourceLedger(fixture.rawSource);
  const claimedUnits = new Set();
  const claims = [];
  const takeUnit = (quote) => {
    const unit = ledger.units.find((candidate) => (
      !claimedUnits.has(candidate.id)
      && fixture.rawSource.slice(candidate.sourceSpan.start, candidate.sourceSpan.end) === quote
    ));
    if (!unit) throw new Error(`Large planner fixture sourceQuote did not resolve uniquely: ${quote}`);
    claimedUnits.add(unit.id);
    return unit;
  };
  fixture.compactPlan.cases.forEach((caseIntent, caseIndex) => {
    caseIntent.actions.forEach((record, recordIndex) => {
      const unit = takeUnit(record.sourceQuote);
      if (record.condition) {
        claims.push({
          unitRef: unit.id,
          disposition: 'condition',
          sourceQuote: record.condition,
          caseIndex,
          recordKind: 'action',
          recordIndex,
        });
        claims.push({
          unitRef: unit.id,
          disposition: 'action',
          sourceQuote: record.sourceQuote.slice(record.condition.length),
          caseIndex,
          recordKind: 'action',
          recordIndex,
        });
      } else {
        claims.push({
          unitRef: unit.id,
          disposition: 'action',
          sourceQuote: record.sourceQuote,
          caseIndex,
          recordKind: 'action',
          recordIndex,
        });
      }
    });
    caseIntent.assertions.forEach((record, recordIndex) => {
      const unit = takeUnit(record.sourceQuote);
      claims.push({
        unitRef: unit.id,
        disposition: 'assertion',
        sourceQuote: record.sourceQuote,
        caseIndex,
        recordKind: 'assertion',
        recordIndex,
      });
    });
  });
  fixture.compactPlan.unresolvedQuestions.forEach((question, unresolvedIndex) => {
    const unit = takeUnit(question.sourceQuote);
    claims.push({
      unitRef: unit.id,
      disposition: 'unresolved',
      sourceQuote: question.sourceQuote,
      unresolvedIndex,
    });
  });
  ledger.units.forEach((unit) => {
    if (claimedUnits.has(unit.id)) return;
    claims.push({
      unitRef: unit.id,
      disposition: 'metadata',
      sourceQuote: fixture.rawSource.slice(unit.sourceSpan.start, unit.sourceSpan.end),
    });
  });
  fixture.compactPlan.sourceClaims = claims;
  return ledger;
}

function objectKeysDeep(value, output = new Set()) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach((entry) => objectKeysDeep(entry, output));
    return output;
  }
  Object.entries(value).forEach(([key, entry]) => {
    output.add(key);
    objectKeysDeep(entry, output);
  });
  return output;
}

function claudeStreamingProvider(compactPlan) {
  const serialized = JSON.stringify(compactPlan);
  return {
    name: 'claude',
    completeStream: vi.fn(async (request) => {
      const chunkSize = Math.max(1, Math.ceil(serialized.length / 7));
      let snapshot = '';
      for (let offset = 0; offset < serialized.length; offset += chunkSize) {
        const delta = serialized.slice(offset, offset + chunkSize);
        snapshot += delta;
        request.onText(delta, snapshot);
      }
      return {
        content: [{ type: 'text', text: serialized }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 6_400, output_tokens: 4_900 },
      };
    }),
  };
}

describe('Add Scenario semantic planner large streaming acceptance', () => {
  it('parses one compact Claude stream into 80+ ordered intents without guessing, leaking, or persisting', async () => {
    const fixture = buildLargeSemanticPlannerFixture({ includeUnresolved: false });
    const sourceLedgerV1 = attachLargeFixtureSourceClaims(fixture);
    const provider = claudeStreamingProvider(fixture.compactPlan);
    const persistence = {
      $transaction: vi.fn(),
      testScenario: { create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
      testCase: { create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    };

    expect(fixture.expectedOperationCount).toBeGreaterThanOrEqual(80);
    expect(JSON.stringify(fixture.existingScenarioContext)).not.toContain(SEMANTIC_PLANNER_SENSITIVE_SENTINEL);
    expect(JSON.stringify(fixture.existingScenarioContext)).toContain(SEMANTIC_PLANNER_SENSITIVE_REF);

    const startedAt = performance.now();
    const result = await planner.run({
      rawSource: fixture.rawSource,
      provider: 'claude',
      model: 'claude-streaming-acceptance',
      apiKey: 'test-only-key',
      continuationContext: fixture.continuationContext,
      existingScenarioContext: fixture.existingScenarioContext,
      currentCases: fixture.existingScenarioContext.cases,
      guidance: 'Keep this one continuous continuation and retain every atomic authored operation.',
    }, { provider, prisma: persistence, persistence });
    const elapsedMs = performance.now() - startedAt;

    expect(provider.completeStream).toHaveBeenCalledTimes(1);
    const providerCall = provider.completeStream.mock.calls[0][0];
    expect(providerCall.maxTokens).toBe(12_680);
    expect(providerCall.maxRetries).toBe(0);
    expect(providerCall.timeoutMs).toBeGreaterThan(0);
    expect(providerCall.timeoutMs).toBeLessThanOrEqual(120_000);
    expect(providerCall.temperature).toBe(0.1);
    expect(providerCall.system).toContain('Return ONLY one compact JSON object');
    expect(providerCall.system).toContain('MODEL OWNS only authored meaning');
    expect(providerCall.system).toContain('COMPILER OWNS all executable mechanics');
    expect(providerCall.messages).toHaveLength(1);
    expect(providerCall.messages[0].content).toContain(fixture.rawSource);
    expect(providerCall.messages[0].content).toContain('ExistingScenarioContextV1');
    expect(providerCall.messages[0].content).toContain(SEMANTIC_PLANNER_PRIOR_CASE_ID);
    expect(providerCall.messages[0].content).toContain(SEMANTIC_PLANNER_SENSITIVE_REF);
    expect(providerCall.messages[0].content).not.toContain(SEMANTIC_PLANNER_SENSITIVE_SENTINEL);
    expect(elapsedMs).toBeLessThan(5_000);

    const compactKeys = objectKeysDeep(fixture.compactPlan);
    [
      'id', 'ordinal', 'failurePolicy', 'failureBehavior', 'sessionRequirement',
      'dependencies', 'dependsOn', 'flowImpact', 'comparator', 'payload', 'operands',
      'sourceSpan', 'sourceCoverage', 'clarifications',
    ].forEach((compilerOwnedKey) => expect(compactKeys.has(compilerOwnedKey)).toBe(false));
    expect(JSON.stringify(fixture.compactPlan)).not.toContain('{{');

    expect(result.metadata).toMatchObject({
      provider: 'claude',
      model: 'claude-streaming-acceptance',
      attempts: 1,
      providerCallLimit: 1,
      repairCalls: 0,
      repaired: false,
      semanticPlanVersion: 'SemanticIntentPlanV1',
      usage: { input_tokens: 6_400, output_tokens: 4_900 },
      attemptsDetail: [expect.objectContaining({ parseable: true, valid: true })],
    });
    expect(result.envelope).toBe(result.caseContractV1);
    expect(result.sourceLedgerV1).toEqual(sourceLedgerV1);
    expect(result.sourceCompleteness).toMatchObject({ valid: true, complete: true, findings: [] });
    expect(result.envelope.source).toMatchObject({
      kind: 'add_scenario',
      originalLength: fixture.rawSource.length,
      digest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
    });

    const [testCase] = result.envelope.cases;
    expect(result.envelope.cases).toHaveLength(1);
    expect(testCase.steps).toHaveLength(fixture.expectedActionCount);
    expect(testCase.assertions).toHaveLength(fixture.expectedAssertionCount);
    expect(testCase.steps.length + testCase.assertions.length).toBe(fixture.expectedOperationCount);
    expect(testCase.steps.length + testCase.assertions.length).toBeGreaterThanOrEqual(80);
    expect(testCase.steps.map((step) => step.type))
      .toEqual(fixture.compactPlan.cases[0].actions.map((action) => action.type));
    expect(testCase.assertions.map((assertion) => assertion.type))
      .toEqual(fixture.compactPlan.cases[0].assertions.map((assertion) => assertion.type));
    expect(testCase.sessionRequirement).toMatchObject({
      mode: 'continue_from_case',
      predecessorCaseId: SEMANTIC_PLANNER_PRIOR_CASE_ID,
    });

    const reconstructedSemanticOrder = [
      ...testCase.steps.map((record) => ({ kind: 'action', type: record.type, sourceQuote: record.sourceQuote, start: record.sourceSpan.start })),
      ...testCase.assertions.map((record) => ({ kind: 'assertion', type: record.type, sourceQuote: record.sourceQuote, start: record.sourceSpan.start })),
    ].sort((left, right) => left.start - right.start)
      .map(({ kind, type, sourceQuote }) => ({ kind, type, sourceQuote }));
    expect(reconstructedSemanticOrder).toEqual(fixture.semanticOrder);

    const stageOptions = testCase.assertions.find((assertion) => assertion.targetIdentity?.label === 'Workflow Stage options');
    expect(stageOptions).toMatchObject({
      type: 'AssertCollection',
      comparator: 'collection_exact_order',
      payload: {
        channel: 'collection',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'items' },
          { role: 'expected', kind: 'collection', items: ['Draft', 'Review', 'Approved'] },
        ],
      },
    });
    const expand = testCase.steps.find((step) => step.type === 'Expand');
    expect(expand).toMatchObject({
      sourceQuote: 'If the Advanced schedule panel is collapsed, expand the Advanced schedule panel.',
      targetIdentity: { label: 'Advanced schedule panel' },
    });
    expect(JSON.stringify(expand.condition)).toContain('Advanced schedule panel is collapsed');
    expect(testCase.steps.filter((step) => step.type === 'Scroll')).toHaveLength(1);

    const dateSteps = testCase.steps.filter((step) => step.type === 'Date');
    const timeSelections = testCase.steps.filter((step) => /^Schedule \d Time$/.test(step.targetIdentity?.label || ''));
    const zoneSelections = testCase.steps.filter((step) => /Time Zone$/.test(step.targetIdentity?.label || ''));
    expect(dateSteps.map((step) => step.value)).toEqual(fixture.schedules.map((entry) => entry.date));
    expect(timeSelections.map((step) => step.selectionCriteria?.text)).toEqual(fixture.schedules.map((entry) => entry.time));
    expect(zoneSelections.map((step) => step.selectionCriteria?.text)).toEqual(fixture.schedules.map((entry) => entry.zone));

    const normalFills = testCase.steps.filter((step) => /^Detail Field \d{2}$/.test(step.targetIdentity?.label || ''));
    expect(normalFills).toHaveLength(12);
    normalFills.forEach((step, index) => {
      expect(step.value).toBe(`Detail-${String(index + 1).padStart(2, '0')}-Value`);
      expect(step).not.toHaveProperty('valueRef');
    });
    expect(JSON.stringify(result.envelope)).not.toContain('{{');

    const sensitiveStep = testCase.steps.find((step) => step.targetIdentity?.label === 'Authentication Password');
    expect(sensitiveStep).toMatchObject({ valueRef: SEMANTIC_PLANNER_SENSITIVE_REF });
    expect(sensitiveStep).not.toHaveProperty('value');
    expect(JSON.stringify(result)).not.toContain(SEMANTIC_PLANNER_SENSITIVE_SENTINEL);

    const nonblockingValidation = testCase.assertions.find((assertion) => assertion.targetIdentity?.label === 'Completion banner');
    expect(nonblockingValidation).toMatchObject({
      type: 'AssertVisible',
      required: false,
      failureBehavior: 'continue_independent',
    });
    expect(fixture.compactPlan.cases[0]).not.toHaveProperty('failurePolicy');
    expect(testCase.failurePolicy).toMatchObject({ onAssertionFailure: 'continue_independent' });

    expect(testCase.steps.some((step) => step.targetIdentity?.label === 'Owner')).toBe(false);
    expect(result.envelope.clarifications).toEqual([]);

    expect(persistence.$transaction).not.toHaveBeenCalled();
    Object.values(persistence.testScenario).forEach((method) => expect(method).not.toHaveBeenCalled());
    Object.values(persistence.testCase).forEach((method) => expect(method).not.toHaveBeenCalled());
  });
});
