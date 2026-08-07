import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  NORMAL_LITERAL_EXPECTATIONS,
  SENSITIVE_REFERENCE,
  SENSITIVE_SENTINEL,
  buildOrderedDraftFixture,
} from '../fixtures/addScenarioOrderedDraft96.fixture.js';

const require = createRequire(import.meta.url);
const {
  AddScenarioOrderedDraftError,
  AddScenarioOperationLimitError,
  CODES,
  REDACTED_SOURCE,
  computeAddScenarioContractDigest,
  createAddScenarioOrderedDraft,
  sourceDigest,
  validateAddScenarioOrderedDraft,
} = require('../../server/services/addScenarioOrderedDraft');

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]),
  );
}

function operationsOf(draft) {
  return draft.cases.flatMap((testCase) => testCase.operations);
}

function operationByTarget(draft, name, kind = null, type = null) {
  return operationsOf(draft).find((operation) => (
    operation.target && operation.target.name === name
    && (!kind || operation.kind === kind)
    && (!type || operation.type === type)
  ));
}

function buildDraft(operationCount = 96) {
  const fixture = buildOrderedDraftFixture(operationCount);
  const draft = createAddScenarioOrderedDraft(fixture.input, fixture.options);
  return { fixture, draft };
}

describe('Add Scenario ordered draft large website-neutral acceptance', () => {
  it('preserves one strict case with exactly 96 globally interleaved operations and dependencies', () => {
    const { fixture, draft } = buildDraft();
    const operations = operationsOf(draft);

    expect(Object.keys(draft).sort()).toEqual([
      'cases', 'contractDigest', 'sourceClauses', 'sourceDigest', 'version',
    ]);
    expect(draft.cases).toHaveLength(1);
    expect(draft.cases[0]).toMatchObject({
      ordinal: 1,
      name: 'Website-neutral service request with ordered validations',
      sessionIntent: { mode: 'fresh' },
      parentCaseRef: null,
    });
    expect(operations).toHaveLength(96);
    expect(operations.filter((operation) => operation.kind === 'action')).toHaveLength(57);
    expect(operations.filter((operation) => operation.kind === 'assertion')).toHaveLength(39);
    expect(operations.map((operation) => `${operation.kind}:${operation.type}`)).toEqual(fixture.signatures);
    expect(operations.map((operation) => operation.ordinal)).toEqual(
      Array.from({ length: 96 }, (_, index) => index + 1),
    );
    expect(operations.every((operation) => typeof operation.text === 'string' && operation.text.length > 0)).toBe(true);

    expect(operations.slice(0, 10).map(({ ordinal, kind, type }) => ({ ordinal, kind, type }))).toEqual([
      { ordinal: 1, kind: 'action', type: 'Navigate' },
      { ordinal: 2, kind: 'assertion', type: 'AssertPage' },
      { ordinal: 3, kind: 'action', type: 'WaitForState' },
      { ordinal: 4, kind: 'assertion', type: 'AssertVisible' },
      { ordinal: 5, kind: 'action', type: 'Click' },
      { ordinal: 6, kind: 'action', type: 'WaitForState' },
      { ordinal: 7, kind: 'assertion', type: 'AssertVisible' },
      { ordinal: 8, kind: 'action', type: 'Clear' },
      { ordinal: 9, kind: 'action', type: 'Fill' },
      { ordinal: 10, kind: 'assertion', type: 'AssertValue' },
    ]);
    expect(operations.at(-1)).toMatchObject({ ordinal: 96, kind: 'assertion', type: 'AssertText' });
    expect(operations[0].dependencies).toEqual([]);
    operations.slice(1).forEach((operation, index) => {
      expect(operation.dependencies).toEqual([operations[index].id]);
    });
    expect(validateAddScenarioOrderedDraft(draft)).toEqual({ valid: true, findings: [] });
  });

  it('accepts exactly 100 combined case operations and rejects the 101st with the production limit error', () => {
    const { draft: accepted } = buildDraft(100);
    const acceptedOperations = operationsOf(accepted);

    expect(acceptedOperations).toHaveLength(100);
    expect(acceptedOperations.at(-1)).toMatchObject({ ordinal: 100, kind: 'assertion', type: 'AssertText' });

    const overflow = buildOrderedDraftFixture(101);
    expect(() => createAddScenarioOrderedDraft(overflow.input, overflow.options))
      .toThrowError(AddScenarioOperationLimitError);
    try {
      createAddScenarioOrderedDraft(overflow.input, overflow.options);
      throw new Error('Expected the 101-operation fixture to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(AddScenarioOrderedDraftError);
      expect(error).toBeInstanceOf(AddScenarioOperationLimitError);
      expect(error).toMatchObject({
        code: 'SEMANTIC_CONTRACT_OPERATION_LIMIT_EXCEEDED',
        status: 422,
      });
      expect(error.findings).toEqual([
        expect.objectContaining({ path: 'cases', code: CODES.OPERATION_LIMIT_EXCEEDED }),
      ]);
    }
  });

  it('uses production source and contract digests while preserving exact source evidence links', () => {
    const { fixture, draft } = buildDraft();
    const operations = operationsOf(draft);

    expect(fixture.sourceClauses).toHaveLength(96);
    expect(draft.sourceDigest).toBe(sourceDigest(fixture.input.sourceText));
    expect(draft.sourceDigest).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(draft.contractDigest).toBe(computeAddScenarioContractDigest(draft));
    expect(draft.contractDigest).toMatch(/^sha256-[a-f0-9]{64}$/);

    fixture.input.sourceClauses.forEach((inputClause, index) => {
      const canonicalClause = draft.sourceClauses[index];
      expect(fixture.input.sourceText.slice(inputClause.sourceSpan.start, inputClause.sourceSpan.end))
        .toBe(inputClause.sourceQuote);
      expect(canonicalClause.ordinal).toBe(index + 1);
      expect(canonicalClause.sourceSpan).toEqual(inputClause.sourceSpan);
      expect(canonicalClause.quoteDigest).toBe(sourceDigest(inputClause.sourceQuote));
      expect(operations[index].sourceRefs).toEqual([canonicalClause.id]);
      expect(operations[index].sourceSpan).toEqual(canonicalClause.sourceSpan);
      expect(operations[index].quoteDigest).toBe(canonicalClause.quoteDigest);
      expect(operations[index].id).toMatch(/^case-[a-f0-9]{20}-\d{2}\.step-[a-f0-9]{20}-\d{2}$/);
    });

    const changedInput = structuredClone(fixture.input);
    const changedClause = changedInput.sourceClauses[49];
    const originalQuote = changedClause.sourceQuote;
    const revisedQuote = originalQuote.replace('Select', 'Choose');
    expect(revisedQuote).toHaveLength(originalQuote.length);
    changedClause.sourceQuote = revisedQuote;
    changedInput.cases[0].operations[49].text = revisedQuote;
    changedInput.sourceText = `${changedInput.sourceText.slice(0, changedClause.sourceSpan.start)}${revisedQuote}${changedInput.sourceText.slice(changedClause.sourceSpan.end)}`;

    const changedDraft = createAddScenarioOrderedDraft(changedInput, fixture.options);
    expect(changedDraft.sourceDigest).toBe(sourceDigest(changedInput.sourceText));
    expect(changedDraft.sourceDigest).not.toBe(draft.sourceDigest);
    expect(changedDraft.sourceClauses[49].quoteDigest).toBe(sourceDigest(revisedQuote));
    expect(changedDraft.sourceClauses[49].quoteDigest).not.toBe(draft.sourceClauses[49].quoteDigest);
    expect(operationsOf(changedDraft)[49].id).not.toBe(operations[49].id);
    expect(changedDraft.contractDigest).toBe(computeAddScenarioContractDigest(changedDraft));
    expect(changedDraft.contractDigest).not.toBe(draft.contractDigest);
  });

  it('retains normal literals but sends a real sensitive sentinel transiently and preserves only its references', () => {
    const { fixture, draft } = buildDraft();
    const serializedInput = JSON.stringify(fixture.input);
    const serializedDraft = JSON.stringify(draft);

    expect(fixture.rawSource).toContain(SENSITIVE_SENTINEL);
    expect(serializedInput).toContain(SENSITIVE_SENTINEL);
    expect(serializedDraft).not.toContain(SENSITIVE_SENTINEL);

    expect(operationByTarget(draft, 'Request Title', 'action', 'Fill')).toMatchObject({ value: NORMAL_LITERAL_EXPECTATIONS.title });
    expect(operationByTarget(draft, 'Requester Email', 'action')).toMatchObject({ value: NORMAL_LITERAL_EXPECTATIONS.requesterEmail });
    expect(operationByTarget(draft, 'Account Code', 'action')).toMatchObject({ value: NORMAL_LITERAL_EXPECTATIONS.accountCode });
    expect(operationByTarget(draft, 'Comments', 'action')).toMatchObject({ value: NORMAL_LITERAL_EXPECTATIONS.comments });
    expect(operationByTarget(draft, 'Contact Phone', 'action')).toMatchObject({ value: NORMAL_LITERAL_EXPECTATIONS.phone });
    expect(operationByTarget(draft, 'Quantity', 'action')).toMatchObject({ value: 1 });

    const protectedAction = operationByTarget(draft, 'Access Token', 'action', 'Fill');
    const protectedAssertion = operationByTarget(draft, 'Access Token', 'assertion', 'AssertValue');
    expect(protectedAction).toMatchObject({
      valueRef: SENSITIVE_REFERENCE,
      redacted: true,
      text: REDACTED_SOURCE,
      sourceQuote: REDACTED_SOURCE,
    });
    expect(protectedAssertion).toMatchObject({
      expectedRef: SENSITIVE_REFERENCE,
      comparator: 'equals',
      redacted: true,
      text: REDACTED_SOURCE,
      sourceQuote: REDACTED_SOURCE,
    });
    expect(protectedAction).not.toHaveProperty('value');
    expect(protectedAssertion).not.toHaveProperty('expected');
    expect(validateAddScenarioOrderedDraft(draft)).toEqual({ valid: true, findings: [] });

    const literalInput = structuredClone(fixture.input);
    const literalAction = literalInput.cases[0].operations.find((operation) => (
      operation.kind === 'action' && operation.type === 'Fill' && operation.target.name === 'Access Token'
    ));
    delete literalAction.valueRef;
    literalAction.value = SENSITIVE_SENTINEL;

    let capturedError;
    try {
      createAddScenarioOrderedDraft(literalInput, fixture.options);
    } catch (error) {
      capturedError = error;
    }
    expect(capturedError).toBeInstanceOf(AddScenarioOrderedDraftError);
    expect(capturedError.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: CODES.SENSITIVE_LITERAL }),
    ]));
    const serializedError = [capturedError.message, capturedError.stack, JSON.stringify(capturedError)].join('\n');
    expect(serializedError).not.toContain(SENSITIVE_SENTINEL);
  });

  it('preserves typed selections, valid comparator/type pairs, dates, scrolling, and conditions', () => {
    const { draft } = buildDraft();
    const operations = operationsOf(draft);
    const selects = operations.filter((operation) => operation.kind === 'action' && operation.type === 'Select');

    expect(selects.some((operation) => operation.selection?.kind === 'exact_text')).toBe(true);
    expect(selects.some((operation) => operation.selection?.kind === 'ordinal' && operation.selection.ordinal === 2)).toBe(true);
    expect(selects.some((operation) => operation.selection?.kind === 'predicate')).toBe(true);
    selects.forEach((operation) => {
      expect(operation).toHaveProperty('selection.kind');
      expect(operation).not.toHaveProperty('value');
    });

    const comparatorPairs = [...new Set(operations
      .filter((operation) => operation.kind === 'assertion')
      .map((operation) => `${operation.type}:${operation.comparator}`))].sort();
    expect(comparatorPairs).toEqual([
      'AssertChecked:checked',
      'AssertCollection:collection_exact_order',
      'AssertDate:equals',
      'AssertHidden:hidden',
      'AssertNumber:equals',
      'AssertPage:equals',
      'AssertSelected:equals',
      'AssertText:contains',
      'AssertTime:equals',
      'AssertValue:equals',
      'AssertVisible:visible',
    ]);

    expect(operations.filter((operation) => operation.type === 'Date').map((operation) => operation.value))
      .toEqual(['2026-08-20', '2026-08-21']);
    const scrolls = operations.filter((operation) => operation.type === 'Scroll');
    expect(scrolls).toHaveLength(5);
    scrolls.forEach((operation) => expect(operation).not.toHaveProperty('value'));

    const expand = operations.find((operation) => operation.type === 'Expand');
    const collapse = operations.find((operation) => operation.type === 'Collapse');
    expect(expand).toMatchObject({
      ordinal: 47,
      condition: {
        kind: 'target_state', comparator: 'equals', operands: [{ property: 'expanded' }, { value: false }],
      },
    });
    expect(collapse).toMatchObject({
      ordinal: 61,
      condition: {
        kind: 'target_state', comparator: 'equals', operands: [{ property: 'expanded' }, { value: true }],
      },
    });
    expect(operations[48]).toMatchObject({ ordinal: 49, type: 'Click', target: { name: 'Start Date' } });
    expect(operations[49]).toMatchObject({ ordinal: 50, type: 'Date', value: '2026-08-20' });
    expect(operations[50]).toMatchObject({ ordinal: 51, type: 'AssertDate', expected: '2026-08-20', comparator: 'equals' });
  });

  it('is byte-deterministic across 100 builds and object-key representation changes', () => {
    const { fixture, draft: baseline } = buildDraft();
    const baselineBytes = JSON.stringify(baseline);
    const baselineIds = operationsOf(baseline).map((operation) => operation.id);

    expect(baseline.contractDigest).toBe(computeAddScenarioContractDigest(baseline));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const repeated = createAddScenarioOrderedDraft(structuredClone(fixture.input), fixture.options);
      expect(JSON.stringify(repeated)).toBe(baselineBytes);
      expect(repeated.contractDigest).toBe(baseline.contractDigest);
      expect(operationsOf(repeated).map((operation) => operation.id)).toEqual(baselineIds);
    }

    const reorderedRepresentation = reverseObjectKeys(fixture.input);
    const reorderedDraft = createAddScenarioOrderedDraft(reorderedRepresentation, fixture.options);
    expect(JSON.stringify(reorderedDraft)).toBe(baselineBytes);
    expect(reorderedDraft.contractDigest).toBe(computeAddScenarioContractDigest(reorderedDraft));
    expect(reorderedDraft.contractDigest).toBe(baseline.contractDigest);
    expect(operationsOf(reorderedDraft).map((operation) => operation.id)).toEqual(baselineIds);
  });

  it('changes stable operation identity and the production contract digest for a semantic change', () => {
    const { fixture, draft: baseline } = buildDraft();
    const baselineOperations = operationsOf(baseline);
    const changedInput = structuredClone(fixture.input);
    const titleActionIndex = changedInput.cases[0].operations.findIndex((operation) => (
      operation.kind === 'action' && operation.target?.name === 'Request Title' && operation.type === 'Fill'
    ));
    changedInput.cases[0].operations[titleActionIndex].required = false;
    const changed = createAddScenarioOrderedDraft(changedInput, fixture.options);
    const changedOperations = operationsOf(changed);

    expect(changed.sourceDigest).toBe(baseline.sourceDigest);
    expect(changed.contractDigest).toBe(computeAddScenarioContractDigest(changed));
    expect(changed.contractDigest).not.toBe(baseline.contractDigest);
    expect(changedOperations[titleActionIndex].id).not.toBe(baselineOperations[titleActionIndex].id);
    expect(changedOperations[titleActionIndex + 1].dependencies).toEqual([changedOperations[titleActionIndex].id]);
    expect(validateAddScenarioOrderedDraft(changed)).toEqual({ valid: true, findings: [] });
  });
});
