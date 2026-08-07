import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  applyInterpretationPatch,
  interpretAddScenario,
  normalizeInterpretation,
  parseInterpretation,
} = require('../../server/services/addScenarioInterpretationPreview');

describe('Add Scenario interpretation preview', () => {
  it('prefers streaming and keeps an actively producing interpretation alive', async () => {
    const output = JSON.stringify({
      title: 'Streamed flow',
      intentSummary: 'Open and verify a page.',
      session: { mode: 'fresh', initialState: 'Browser open', finalState: 'Page visible' },
      operations: [
        { kind: 'action', type: 'Click', target: 'Orders', reason: 'Open Orders' },
        { kind: 'assertion', type: 'AssertVisible', target: 'Orders page', reason: 'Verify Orders' },
      ],
      questions: [],
      confidence: 'high',
    });
    let completeCalled = false;
    const provider = {
      complete: async () => { completeCalled = true; return { content: output }; },
      completeStream: async ({ onText }) => {
        let snapshot = '';
        const width = Math.ceil(output.length / 6);
        for (let index = 0; index < output.length; index += width) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const delta = output.slice(index, index + width);
          snapshot += delta;
          onText(delta, snapshot);
        }
        return { content: snapshot };
      },
    };

    const result = await interpretAddScenario({
      sourceText: 'Click Orders and verify the Orders page is visible.',
      timeoutMs: 500,
      stallTimeoutMs: 30,
    }, { provider });

    expect(result.parseStatus).toBe('parsed');
    expect(result.interpretation.operations).toHaveLength(2);
    expect(completeCalled).toBe(false);
  });

  it('terminates a streaming interpretation that stops producing output', async () => {
    const provider = {
      completeStream: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    };

    await expect(interpretAddScenario({
      sourceText: 'Click Orders and verify the Orders page is visible.',
      timeoutMs: 500,
      stallTimeoutMs: 20,
    }, { provider })).rejects.toMatchObject({
      code: 'ADD_SCENARIO_INTERPRETATION_STALLED',
      status: 504,
    });
  });

  it('returns Claude understanding without making it executable or persistent', async () => {
    const provider = {
      complete: async () => ({
        content: [{
          text: '```json\n{"title":"Continue order flow","intentSummary":"Create an order after login.","session":{"mode":"continue_from_case","predecessorCaseId":"case-1","initialState":"Authenticated dashboard","finalState":"Order form populated"},"operations":[{"ordinal":1,"kind":"action","type":"Fill","target":"Order Number field","value":"007995145","expected":null,"condition":null,"nonBlocking":false,"reason":"Authored literal"},{"ordinal":2,"kind":"assertion","type":"AssertValue","target":"Order Number field","value":null,"expected":"007995145","condition":null,"nonBlocking":false,"reason":"Exact validation"}],"questions":[],"confidence":"high"}\n```',
        }],
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: 'end_turn',
      }),
    };

    const result = await interpretAddScenario({
      sourceText: 'Continue from login. Fill Order Number with 007995145 and verify it equals 007995145.',
      provider: 'claude',
      apiKey: 'test-key',
      model: 'test-model',
      continuationContext: {
        requested: true,
        predecessorCaseId: 'case-1',
        currentGenerationId: 'generation-1',
        predecessorCase: { name: 'Login', steps: '[{"type":"Fill"}]' },
      },
    }, { provider });

    expect(result.parseStatus).toBe('parsed');
    expect(result.interpretation.operations).toHaveLength(2);
    expect(result.interpretation.operations.map((operation) => operation.id)).toEqual(['op-0001', 'op-0002']);
    expect(result.interpretation.operations[0].value).toBe('007995145');
    expect(result.persisted).toBe(false);
    expect(result.approvalEligible).toBe(false);
    expect(result.conductorInvoked).toBe(false);
    expect(result.diagnostics.provider).toBe('claude');
  });

  it('keeps non-JSON provider output reviewable instead of treating it as an executable contract', async () => {
    const provider = {
      complete: async () => ({ content: '1. Click Orders.\n2. Verify the Orders page is visible.' }),
    };
    const result = await interpretAddScenario({
      sourceText: 'Click Orders and verify the Orders page.',
      provider: 'claude',
      apiKey: 'test-key',
      model: 'test-model',
    }, { provider });

    expect(result.parseStatus).toBe('raw_only');
    expect(result.rawOutput).toContain('Click Orders');
    expect(result.interpretation).toBeNull();
    expect(result.persisted).toBe(false);
    expect(result.conductorInvoked).toBe(false);
  });

  it('accepts JSON surrounded by explanatory text for observation purposes', () => {
    const parsed = parseInterpretation('Interpretation:\n{"title":"Example","operations":[]}\nEnd.');
    expect(parsed.error).toBeNull();
    expect(parsed.value.title).toBe('Example');
  });

  it('applies a targeted patch while preserving every unmentioned operation', () => {
    const current = normalizeInterpretation({
      title: 'Order flow',
      operations: [
        { kind: 'action', type: 'Click', target: 'Orders' },
        { kind: 'assertion', type: 'AssertVisible', target: 'Create Order', expected: 'visible and enabled' },
        { kind: 'action', type: 'Fill', target: 'Order Number', value: '007995145' },
      ],
    });
    const untouched = current.operations[2];
    const revised = applyInterpretationPatch(current, {
      summary: 'Split visible and enabled checks.',
      changes: [{
        action: 'replace',
        operationId: 'op-0002',
        operations: [
          { kind: 'assertion', type: 'AssertVisible', target: 'Create Order' },
          { kind: 'assertion', type: 'AssertEnabled', target: 'Create Order' },
        ],
      }],
    });

    expect(revised.operations.map((operation) => operation.type)).toEqual(['Click', 'AssertVisible', 'AssertEnabled', 'Fill']);
    expect(revised.operations[1].id).toBe('op-0002');
    expect(revised.operations[3]).toMatchObject({ id: untouched.id, target: untouched.target, value: untouched.value });
    expect(revised.operations.map((operation) => operation.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it('keeps predicate selections separate from exact values', () => {
    const interpretation = normalizeInterpretation({
      operations: [{
        kind: 'action', type: 'Select', target: 'Time Zone',
        value: 'option whose visible label contains Central',
      }],
    });
    expect(interpretation.operations[0]).toMatchObject({
      selectionCriteria: { kind: 'predicate', field: 'visible_label', operator: 'contains', value: 'Central' },
    });
    expect(interpretation.operations[0]).not.toHaveProperty('value');
  });

  it('normalizes provider-friendly operation shapes before draft projection', () => {
    const interpretation = normalizeInterpretation({
      operations: [
        { kind: 'assertion', type: 'AssertCollection', target: 'Suggestion list', expected: 'Options in order: first = Alpha, second = Beta' },
        { kind: 'assertion', type: 'AssertCollection', target: 'Direction list', expected: 'List contains Outbound and Inbound' },
        { kind: 'action', type: 'Click', target: 'Suggestion list', selectionCriteria: { kind: 'ordinal', ordinal: 2, expectedText: 'Beta' } },
        { kind: 'action', type: 'Radio', target: 'Ship Date & Time option' },
        { kind: 'assertion', type: 'AssertTemporal', target: 'Early Pickup Date field', expected: '08/20/2026' },
        { kind: 'assertion', type: 'AssertValue', target: 'Time Zone field', expected: 'Selected label contains Central' },
      ],
    });

    expect(interpretation.operations[0].expected).toEqual(['Alpha', 'Beta']);
    expect(interpretation.operations[1].expected).toEqual(['Outbound', 'Inbound']);
    expect(interpretation.operations[2]).toMatchObject({ type: 'Click', target: 'Beta' });
    expect(interpretation.operations[2]).not.toHaveProperty('selectionCriteria');
    expect(interpretation.operations[3]).toMatchObject({ type: 'Radio', value: 'Ship Date & Time' });
    expect(interpretation.operations[4].type).toBe('AssertDate');
    expect(interpretation.operations[5]).toMatchObject({ type: 'AssertText', comparator: 'contains', expected: 'Central' });
  });

  it('normalizes date-field assertions and exact clock selections without domain-specific rules', () => {
    const dates = [
      ['Start Date field', '10/31/2027'],
      ['End Date calendar', '2027-11-01'],
      ['Review Date field', 'December 5, 2028'],
      ['Renewal Date field', '01/15/2029'],
    ];
    const times = [
      ['Start Time dropdown', 7, 'Select 07:30 AM as the start time.'],
      ['End Time dropdown', 11, 'Select 11:45 AM as the end time.'],
      ['Review Time dropdown', 1, 'Select 01:15 PM as the review time.'],
      ['Renewal Time dropdown', 4, 'Select 04:05 PM as the renewal time.'],
    ];
    const interpretation = normalizeInterpretation({
      operations: [
        ...dates.map(([target, expected]) => ({ kind: 'assertion', type: 'AssertValue', target, expected })),
        ...times.map(([target, ordinal, reason]) => ({
          kind: 'action', type: 'Select', target, selectionCriteria: { kind: 'ordinal', ordinal }, reason,
        })),
      ],
    });

    expect(interpretation.operations.slice(0, 4).map((operation) => operation.type)).toEqual([
      'AssertDate', 'AssertDate', 'AssertDate', 'AssertDate',
    ]);
    expect(interpretation.operations.slice(4).map((operation) => operation.value)).toEqual([
      '07:30 AM', '11:45 AM', '01:15 PM', '04:05 PM',
    ]);
    for (const operation of interpretation.operations.slice(4)) {
      expect(operation).not.toHaveProperty('selectionCriteria');
    }
  });
});
