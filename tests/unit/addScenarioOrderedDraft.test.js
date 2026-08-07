import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  ORDERED_DRAFT_VERSION,
  MAX_ORDERED_OPERATIONS,
  REDACTED_SOURCE,
  CODES,
  AddScenarioOrderedDraftError,
  AddScenarioOperationLimitError,
  sourceDigest,
  computeAddScenarioContractDigest,
  createAddScenarioOrderedDraft,
  validateAddScenarioOrderedDraft,
} = require('../../server/services/addScenarioOrderedDraft');

function action(ref, overrides = {}) {
  return {
    ref,
    kind: 'action',
    type: 'Click',
    text: `Click ${ref}.`,
    target: { kind: 'control', role: 'button', name: ref },
    required: true,
    condition: null,
    failureBehavior: 'block_dependents',
    dependencies: [],
    sourceRefs: [`story.${ref}`],
    ...overrides,
  };
}

function assertion(ref, overrides = {}) {
  return {
    ref,
    kind: 'assertion',
    type: 'AssertVisible',
    text: `Verify ${ref} is visible.`,
    target: { kind: 'control', role: 'heading', name: ref },
    expected: true,
    comparator: 'visible',
    required: true,
    condition: null,
    failureBehavior: 'block_dependents',
    dependencies: [],
    sourceRefs: [`story.${ref}`],
    ...overrides,
  };
}

function authoredOperations(input) {
  if (Array.isArray(input.cases)) return input.cases.flatMap((entry) => entry.operations || []);
  return Array.isArray(input.operations) ? input.operations : [];
}

function operationSourceRefs(operation) {
  const refs = operation.sourceRefs ?? operation.sourceClauseRefs;
  return Array.isArray(refs) ? refs.map((ref) => String(ref).trim()) : [];
}

function withSource(input) {
  const categories = new Map();
  authoredOperations(input).forEach((operation) => {
    const kind = String(operation.kind || '').trim().toLowerCase() === 'assertion'
      || /^assert/i.test(String(operation.type || '')) ? 'assertion' : 'action';
    operationSourceRefs(operation).forEach((ref) => {
      if (!categories.has(ref)) categories.set(ref, new Set());
      categories.get(ref).add(kind);
    });
  });
  const quotes = [...categories.keys()].map((ref, index) => `Authority clause ${index + 1} for ${ref}.`);
  const sourceText = quotes.join('\n');
  let offset = 0;
  const sourceClauses = [...categories.entries()].map(([ref, kinds], index) => {
    const quote = quotes[index];
    const clause = {
      id: ref,
      ordinal: index + 1,
      disposition: kinds.size > 1 ? 'mixed' : [...kinds][0],
      sourceQuote: quote,
      sourceSpan: { start: offset, end: offset + quote.length },
    };
    offset += quote.length + 1;
    return clause;
  });
  return { ...input, sourceText, sourceClauses };
}

function errorCodes(error) {
  return error.findings.map((finding) => finding.code);
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('Expected callback to throw.');
}

describe('Add Scenario ordered draft', () => {
  it('emits one canonical case-local action/assertion stream and preserves execution semantics exactly', () => {
    const exactTarget = {
      kind: 'field',
      role: 'textbox',
      accessibleName: 'Email Address',
      context: { frame: 'top', application: 'OdysseyOne' },
    };
    const exactCondition = {
      kind: 'state',
      comparator: 'equals',
      operands: [{ ref: 'classifier_ready' }, true],
    };
    const exactValue = 'OdysseyOneAutomationTester1@odysseylogistics.com';
    const url = 'https://qa.linx.odysseylogistics.com/auth/email-classifier?returnUrl=%2Fuser%2Fadministration';

    const draft = createAddScenarioOrderedDraft(withSource({
      name: 'Classifier sign-in remains one ordered flow',
      intent: 'Reach the authenticated Home dashboard.',
      operations: [
        action('open-classifier', {
          type: 'Navigate',
          text: 'Open the OdysseyOne email classifier.',
          target: { kind: 'url', url },
          value: url,
          sourceRefs: ['requirement.steps[2]'],
        }),
        assertion('email-field-ready', {
          target: exactTarget,
          expected: true,
          comparator: 'visible',
          condition: exactCondition,
          failureBehavior: 'block_dependents',
          dependencies: ['open-classifier'],
          sourceRefs: ['requirement.steps[3]'],
        }),
        action('fill-classifier-email', {
          type: 'Fill',
          text: 'Enter the exact classifier email.',
          targetIdentity: exactTarget,
          target: exactTarget,
          value: exactValue,
          dependsOn: ['email-field-ready'],
          dependencies: ['email-field-ready'],
          sourceClauseRefs: ['requirement.steps[3]'],
          sourceRefs: ['requirement.steps[3]'],
        }),
        assertion('classifier-value', {
          type: 'AssertValue',
          target: exactTarget,
          expected: exactValue,
          comparator: 'equals',
          dependencies: ['fill-classifier-email'],
          sourceRefs: ['requirement.steps[3]', 'requirement.testData.email'],
        }),
        action('continue', {
          dependencies: ['classifier-value'],
          sourceRefs: ['requirement.steps[4]'],
        }),
      ],
    }));

    expect(draft.version).toBe(ORDERED_DRAFT_VERSION);
    expect(draft).not.toHaveProperty('operations');
    expect(draft.cases).toHaveLength(1);
    const operations = draft.cases[0].operations;
    expect(operations.map(({ ordinal, kind, type }) => ({ ordinal, kind, type }))).toEqual([
      { ordinal: 1, kind: 'action', type: 'Navigate' },
      { ordinal: 2, kind: 'assertion', type: 'AssertVisible' },
      { ordinal: 3, kind: 'action', type: 'Fill' },
      { ordinal: 4, kind: 'assertion', type: 'AssertValue' },
      { ordinal: 5, kind: 'action', type: 'Click' },
    ]);
    expect(operations[1]).toMatchObject({
      target: exactTarget,
      expected: true,
      comparator: 'visible',
      condition: exactCondition,
      failureBehavior: 'block_dependents',
    });
    expect(operations[2].value).toBe(exactValue);
    expect(operations[3].expected).toBe(exactValue);
    expect(operations[2].dependencies).toEqual([operations[1].id]);
    expect(operations[4].dependencies).toEqual([operations[3].id]);
    expect(validateAddScenarioOrderedDraft(draft)).toEqual({ valid: true, findings: [] });
  });

  it('derives stable compiler-owned ids while repairing sparse duplicate or missing ordinal noise', () => {
    const first = action('first', { ordinal: 90 });
    const second = assertion('second', { ordinal: null, dependencies: ['first'] });
    const firstBuild = createAddScenarioOrderedDraft(withSource({ operations: [first, second] }));
    const repeatedBuild = createAddScenarioOrderedDraft(withSource({
      operations: [{ ...first, ordinal: 10 }, { ...second, ordinal: 10 }],
    }));

    expect(firstBuild).toEqual(repeatedBuild);
    expect(firstBuild.cases[0].operations.map((operation) => operation.ordinal)).toEqual([1, 2]);
    expect(firstBuild.cases[0].operations.map((operation) => operation.id)).toEqual(
      repeatedBuild.cases[0].operations.map((operation) => operation.id),
    );
  });

  it('keeps identical semantic operations unique through deterministic occurrence suffixes', () => {
    const duplicate = action('same');
    const draft = createAddScenarioOrderedDraft(withSource({
      operations: [duplicate, { ...duplicate, ref: 'same-copy' }],
    }));
    const operations = draft.cases[0].operations;

    expect(operations[0].id).not.toBe(operations[1].id);
    expect(operations[0].id.slice(0, -2)).toBe(operations[1].id.slice(0, -2));
    expect(operations.map((operation) => operation.ordinal)).toEqual([1, 2]);
  });

  it('normalizes intrinsic aliases and rewrites case-local dependencies to canonical ids', () => {
    const sourceStep = action('source-step', {
      id: 'legacy-step-7',
      target: { kind: 'control', role: 'button', name: 'Continue' },
      sourceRefs: ['clause-7'],
      ordinal: 40,
    });
    sourceStep.targetIdentity = sourceStep.target;
    sourceStep.sourceClauseRefs = sourceStep.sourceRefs;
    sourceStep.dependsOn = sourceStep.dependencies;
    delete sourceStep.target;
    delete sourceStep.sourceRefs;
    delete sourceStep.dependencies;
    const sourceAssertion = assertion('source-assertion', {
      dependencies: ['legacy-step-7'],
      sourceRefs: ['clause-8'],
      ordinal: 99,
    });
    sourceAssertion.sourceClauseRefs = sourceAssertion.sourceRefs;
    sourceAssertion.dependsOn = sourceAssertion.dependencies;
    delete sourceAssertion.sourceRefs;
    delete sourceAssertion.dependencies;

    const draft = createAddScenarioOrderedDraft(withSource({ operations: [sourceStep, sourceAssertion] }));
    const operations = draft.cases[0].operations;
    expect(operations.map((operation) => operation.ordinal)).toEqual([1, 2]);
    expect(operations[1].dependencies).toEqual([operations[0].id]);
    expect(operations[0]).not.toHaveProperty('targetIdentity');
    expect(operations[0]).not.toHaveProperty('sourceClauseRefs');
    expect(operations[1]).not.toHaveProperty('dependsOn');
  });

  it('uses cases as canonical authority and enforces a typed 100-operation combined budget', () => {
    const firstOperations = Array.from({ length: 60 }, (_, index) => action(`first-${index + 1}`));
    const secondOperations = Array.from({ length: 40 }, (_, index) => action(`second-${index + 1}`));
    const input = withSource({
      cases: [
        {
          id: 'authored-case-a',
          name: 'First behavior',
          intent: 'Complete the first behavior.',
          initialState: { page: 'start' },
          expectedFinalState: { page: 'middle' },
          sessionIntent: { mode: 'fresh' },
          parentCaseRef: null,
          operations: firstOperations,
        },
        {
          id: 'authored-case-b',
          name: 'Second behavior',
          intent: 'Continue the second behavior.',
          initialState: { page: 'middle' },
          expectedFinalState: { page: 'done' },
          sessionIntent: { mode: 'continue_from_case' },
          parentCaseRef: 'authored-case-a',
          operations: secondOperations,
        },
      ],
    });
    const draft = createAddScenarioOrderedDraft(input);

    expect(draft.cases.flatMap((entry) => entry.operations)).toHaveLength(MAX_ORDERED_OPERATIONS);
    expect(draft.cases[1].parentCaseRef).toBe(draft.cases[0].id);
    expect(draft.cases[1]).toMatchObject({
      name: 'Second behavior',
      intent: 'Continue the second behavior.',
      initialState: { page: 'middle' },
      expectedFinalState: { page: 'done' },
      sessionIntent: { mode: 'continue_from_case' },
    });

    const overLimit = withSource({
      cases: [
        input.cases[0],
        { ...input.cases[1], operations: [...secondOperations, action('second-41')] },
      ],
    });
    const error = captureError(() => createAddScenarioOrderedDraft(overLimit));
    expect(error).toBeInstanceOf(AddScenarioOperationLimitError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('SEMANTIC_CONTRACT_OPERATION_LIMIT_EXCEEDED');
    expect(errorCodes(error)).toContain(CODES.OPERATION_LIMIT_EXCEEDED);
  });

  it('rejects split action/assertion input, incomplete assertions, and forward dependencies', () => {
    const incompleteAssertion = assertion('missing-expected');
    delete incompleteAssertion.expected;
    const splitError = captureError(() => createAddScenarioOrderedDraft(withSource({
      actions: [action('click')],
      assertions: [assertion('visible')],
      operations: [incompleteAssertion],
    })));
    expect(splitError).toBeInstanceOf(AddScenarioOrderedDraftError);
    expect(errorCodes(splitError)).toEqual(expect.arrayContaining(['UNKNOWN_FIELD', CODES.VALUE_AUTHORITY_AMBIGUOUS]));

    const dependencyError = captureError(() => createAddScenarioOrderedDraft(withSource({
      operations: [action('first', { dependencies: ['second'] }), action('second')],
    })));
    expect(errorCodes(dependencyError)).toContain('semantic_contract_dependency_not_backward');
  });

  it('canonicalizes equivalent provider representations into byte-identical ids and digests', () => {
    const sourceText = 'Click Continue. Verify Home is visible.';
    const clean = {
      sourceText,
      sourceClauses: [
        { id: 'clause-a', disposition: 'action', sourceQuote: 'Click Continue.', sourceSpan: { start: 0, end: 15 } },
        { id: 'clause-b', disposition: 'assertion', sourceQuote: 'Verify Home is visible.', sourceSpan: { start: 16, end: sourceText.length } },
      ],
      cases: [{
        id: 'provider-case-clean',
        name: 'Continue to Home',
        intent: 'Continue and verify Home.',
        initialState: null,
        expectedFinalState: { page: 'Home' },
        sessionIntent: { mode: 'fresh' },
        parentCaseRef: null,
        operations: [
          action('clean-action', {
            text: 'Click Continue.',
            target: { kind: 'control', role: 'button', name: 'Continue' },
            sourceRefs: ['clause-a'],
          }),
          assertion('clean-assertion', {
            text: 'Verify Home is visible.',
            target: { kind: 'page', name: 'Home' },
            dependencies: ['clean-action'],
            sourceRefs: ['clause-b'],
          }),
        ],
      }],
    };
    const messy = {
      sourceText,
      sourceClauses: [
        { ref: 'provider-a', ordinal: 90, kind: ' ACTION ', text: 'Click Continue.' },
        { ref: 'provider-b', ordinal: null, kind: ' ASSERTION ', text: 'Verify Home is visible.' },
      ],
      cases: [{
        ref: 'provider-case-messy',
        ordinal: 400,
        name: 'Continue to Home',
        intent: 'Continue and verify Home.',
        initialState: null,
        expectedFinalState: { page: 'Home' },
        sessionIntent: ' FRESH ',
        operations: [
          {
            id: 'provider-operation-a',
            ordinal: null,
            kind: ' ACTION ',
            type: ' cLiCk ',
            text: 'Click Continue.',
            targetIdentity: { name: 'Continue', role: 'button', kind: ' CONTROL ' },
            required: true,
            condition: null,
            failureBehavior: ' BLOCK DEPENDENTS ',
            dependsOn: [],
            sourceClauseRefs: [' provider-a '],
          },
          {
            id: 'provider-operation-b',
            ordinal: 10,
            kind: ' ASSERTION ',
            type: ' ASSERT_VISIBLE ',
            text: 'Verify Home is visible.',
            targetIdentity: { name: 'Home', kind: ' PAGE ' },
            expected: true,
            comparator: ' VISIBLE ',
            required: true,
            condition: null,
            failureBehavior: ' BLOCK DEPENDENTS ',
            dependsOn: ['provider-operation-a'],
            sourceClauseRefs: ['provider-b'],
          },
        ],
      }],
    };

    const cleanDraft = createAddScenarioOrderedDraft(clean);
    const messyDraft = createAddScenarioOrderedDraft(messy);
    expect(messyDraft).toEqual(cleanDraft);
    expect(JSON.stringify(messyDraft)).toBe(JSON.stringify(cleanDraft));
    expect(cleanDraft.sourceDigest).toBe(sourceDigest(sourceText));
    expect(cleanDraft.contractDigest).toBe(computeAddScenarioContractDigest(cleanDraft));
    for (let iteration = 0; iteration < 100; iteration += 1) {
      expect(JSON.stringify(createAddScenarioOrderedDraft(messy))).toBe(JSON.stringify(cleanDraft));
    }

    const semanticMutation = JSON.parse(JSON.stringify(clean));
    semanticMutation.cases[0].operations[0].type = 'Fill';
    semanticMutation.cases[0].operations[0].value = 'Service Request 042';
    const mutatedDraft = createAddScenarioOrderedDraft(semanticMutation);
    expect(mutatedDraft.sourceDigest).toBe(cleanDraft.sourceDigest);
    expect(mutatedDraft.contractDigest).not.toBe(cleanDraft.contractDigest);
    expect(mutatedDraft.cases[0].operations[0].id).not.toBe(cleanDraft.cases[0].operations[0].id);
  });

  it('preserves typed selection, required, text, and exact non-sensitive scalar authority', () => {
    const draft = createAddScenarioOrderedDraft(withSource({
      operations: [
        action('priority', {
          type: 'Select',
          text: 'Select Priority 01.',
          target: { kind: 'field', role: 'combobox', name: 'Priority' },
          selection: { kind: 'exact_text', text: 'Priority 01' },
          required: false,
        }),
        action('reference-code', {
          type: 'Fill',
          text: 'Enter reference code 001207.',
          target: { kind: 'field', role: 'textbox', name: 'Reference code' },
          value: '001207',
          dependencies: ['priority'],
        }),
      ],
    }));
    const operations = draft.cases[0].operations;
    expect(operations[0]).toMatchObject({
      type: 'Select',
      text: 'Select Priority 01.',
      required: false,
      selection: { kind: 'exact_text', text: 'Priority 01' },
    });
    expect(operations[1].value).toBe('001207');
  });

  it('uses the shared semantic type and policy vocabulary and rejects ambiguous temporal values', () => {
    const validDate = createAddScenarioOrderedDraft(withSource({
      operations: [action('service-date', {
        type: 'Date',
        text: 'Choose service date 2026-07-17.',
        target: { kind: 'field', name: 'Service date' },
        value: '2026-07-17',
      })],
    }));
    expect(validDate.cases[0].operations[0]).toMatchObject({ type: 'Date', value: '2026-07-17' });

    const unsupportedType = captureError(() => createAddScenarioOrderedDraft(withSource({
      operations: [action('unsupported', { type: 'GuessAndClick' })],
    })));
    expect(errorCodes(unsupportedType)).toContain('semantic_contract_step_type_unsupported');

    const unsupportedPolicy = captureError(() => createAddScenarioOrderedDraft(withSource({
      operations: [action('unsupported-policy', { failureBehavior: 'maybe_continue' })],
    })));
    expect(errorCodes(unsupportedPolicy)).toContain('semantic_contract_failure_behavior_invalid');

    const invalidCondition = captureError(() => createAddScenarioOrderedDraft(withSource({
      operations: [action('invalid-condition', { condition: { when: 'ready' } })],
    })));
    expect(errorCodes(invalidCondition)).toContain(CODES.CONDITION_INVALID);

    const ambiguousDate = captureError(() => createAddScenarioOrderedDraft(withSource({
      operations: [action('ambiguous-date', {
        type: 'Date',
        target: { kind: 'field', name: 'Service date' },
        value: '07/08/2026',
      })],
    })));
    expect(errorCodes(ambiguousDate)).toContain('semantic_contract_date_not_canonical');
  });

  it('validates granular source refs, exact spans, coverage, and entity containment with stable codes', () => {
    const repeatedSource = 'Click Continue. Click Continue.';
    const ambiguous = captureError(() => createAddScenarioOrderedDraft({
      sourceText: repeatedSource,
      sourceClauses: [{ id: 'repeat', disposition: 'action', sourceQuote: 'Click Continue.' }],
      operations: [action('repeat', { text: 'Click Continue.', sourceRefs: ['repeat'] })],
    }));
    expect(errorCodes(ambiguous)).toContain('semantic_contract_source_quote_ambiguous');

    const valid = withSource({ operations: [action('known')] });
    const unknownRef = JSON.parse(JSON.stringify(valid));
    unknownRef.operations[0].sourceRefs = ['missing'];
    expect(errorCodes(captureError(() => createAddScenarioOrderedDraft(unknownRef)))).toContain('semantic_contract_source_ref_unknown');

    const duplicateRef = JSON.parse(JSON.stringify(valid));
    duplicateRef.operations[0].sourceRefs = ['story.known', 'story.known'];
    expect(errorCodes(captureError(() => createAddScenarioOrderedDraft(duplicateRef)))).toContain('semantic_contract_source_ref_duplicate');

    const mismatch = JSON.parse(JSON.stringify(valid));
    mismatch.sourceClauses[0].sourceSpan.end -= 1;
    expect(errorCodes(captureError(() => createAddScenarioOrderedDraft(mismatch)))).toContain('semantic_contract_source_span_quote_mismatch');

    const overlap = captureError(() => createAddScenarioOrderedDraft({
      sourceText: 'Alpha Beta',
      sourceClauses: [
        { id: 'whole', disposition: 'action', sourceQuote: 'Alpha Beta', sourceSpan: { start: 0, end: 10 } },
        { id: 'tail', disposition: 'metadata', sourceQuote: 'Beta', sourceSpan: { start: 6, end: 10 } },
      ],
      operations: [action('whole', { text: 'Alpha Beta', sourceRefs: ['whole'] })],
    }));
    expect(errorCodes(overlap)).toContain('semantic_contract_source_span_overlap');

    const uncovered = captureError(() => createAddScenarioOrderedDraft({
      sourceText: 'Click Alpha. Extra',
      sourceClauses: [
        { id: 'alpha', disposition: 'action', sourceQuote: 'Click Alpha.', sourceSpan: { start: 0, end: 12 } },
      ],
      operations: [action('alpha', { text: 'Click Alpha.', sourceRefs: ['alpha'] })],
    }));
    expect(errorCodes(uncovered)).toContain('semantic_contract_source_text_uncovered');

    const sourceTextValue = 'Click Alpha.\nClick Beta.';
    const entityMismatch = captureError(() => createAddScenarioOrderedDraft({
      sourceText: sourceTextValue,
      sourceClauses: [
        { id: 'alpha-clause', disposition: 'action', sourceQuote: 'Click Alpha.', sourceSpan: { start: 0, end: 12 } },
        { id: 'beta-clause', disposition: 'action', sourceQuote: 'Click Beta.', sourceSpan: { start: 13, end: 24 } },
      ],
      operations: [
        action('alpha', { text: 'Click Alpha.', sourceRefs: ['alpha-clause'] }),
        action('beta', {
          text: 'Click Beta.',
          sourceRefs: ['beta-clause'],
          sourceQuote: 'Click Alpha.',
          sourceSpan: { start: 0, end: 12 },
        }),
      ],
    }));
    expect(errorCodes(entityMismatch)).toContain('semantic_contract_source_entity_link_mismatch');
  });

  it('redacts reference-only sensitive evidence, freezes the draft, and leaks no sentinel through failures', () => {
    const sentinel = 'S3nsitive_Sentinel_987!';
    const rawSource = `Enter ${sentinel} in the Password field.`;
    const sensitiveInput = {
      name: 'Sensitive login',
      intent: 'Authenticate with an approved secret reference.',
      sourceText: rawSource,
      sourceClauses: [{
        id: 'password-clause',
        disposition: 'action',
        sourceQuote: rawSource,
        sourceSpan: { start: 0, end: rawSource.length },
        sensitive: true,
      }],
      operations: [{
        id: 'password-step',
        kind: 'action',
        type: 'Fill',
        text: rawSource,
        target: { kind: 'field', role: 'textbox', name: 'Password' },
        valueRef: 'secret:login.password',
        required: true,
        condition: null,
        failureBehavior: 'stop_case',
        dependencies: [],
        sourceRefs: ['password-clause'],
      }],
    };
    const draft = createAddScenarioOrderedDraft(sensitiveInput, { sensitiveValues: [sentinel] });
    const serialized = JSON.stringify(draft);
    const operation = draft.cases[0].operations[0];

    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('sourceText');
    expect(draft.sourceClauses[0]).toMatchObject({ redacted: true, sourceQuote: REDACTED_SOURCE });
    expect(operation).toMatchObject({
      text: REDACTED_SOURCE,
      sourceQuote: REDACTED_SOURCE,
      redacted: true,
      valueRef: 'secret:login.password',
    });
    expect(operation).not.toHaveProperty('value');
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.cases)).toBe(true);
    expect(Object.isFrozen(operation.target)).toBe(true);

    const literalInput = JSON.parse(JSON.stringify(sensitiveInput));
    delete literalInput.operations[0].valueRef;
    literalInput.operations[0].value = sentinel;
    const literalError = captureError(() => createAddScenarioOrderedDraft(literalInput, { sensitiveValues: [sentinel] }));
    expect(errorCodes(literalError)).toContain(CODES.SENSITIVE_LITERAL);
    expect(JSON.stringify(literalError)).not.toContain(sentinel);

    const metadataInput = JSON.parse(JSON.stringify(sensitiveInput));
    metadataInput.name = sentinel;
    const metadataError = captureError(() => createAddScenarioOrderedDraft(metadataInput, { sensitiveValues: [sentinel] }));
    expect(errorCodes(metadataError)).toContain(CODES.SENSITIVE_LITERAL);
    expect(JSON.stringify(metadataError)).not.toContain(sentinel);
  });

  it('detects canonical identity, ordering, and digest tampering', () => {
    const draft = createAddScenarioOrderedDraft(withSource({
      operations: [action('first'), assertion('second', { dependencies: ['first'] })],
    }));
    const tampered = JSON.parse(JSON.stringify(draft));
    tampered.cases[0].operations[1].ordinal = 8;
    tampered.cases[0].operations[1].expected = false;
    tampered.cases[0].operations[0].target.name = 'Different target';

    const result = validateAddScenarioOrderedDraft(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'semantic_contract_ordinal_not_contiguous',
      'UNSTABLE_OPERATION_ID',
      CODES.CONTRACT_DIGEST_MISMATCH,
    ]));
  });
});
