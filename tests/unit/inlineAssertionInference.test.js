import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  inferInlineAssertionsForCase,
  inferInlineAssertionsForScenarios,
} = require('../../server/services/inlineAssertionInference');
const declaredAssertions = require('../../server/lib/declaredAssertions');
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');
const architect = require('../../server/services/agents/architect');

describe('inline assertion inference', () => {
  it('recovers visible final validation from plain step text', () => {
    const result = inferInlineAssertionsForCase({
      name: 'Login through OdysseyOne SSO',
      automatability: 'automatable',
      assertions: 'After login, verify Welcome OdysseyOne! is visible.',
      steps: [
        { action: 'Click', element: 'Sign in' },
        { action: 'Verify', element: 'Home dashboard', expected: 'Welcome OdysseyOne! is visible' },
      ],
      declaredAssertions: [],
    });

    expect(result.added.length).toBeGreaterThan(0);
    expect(result.case.declaredAssertions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'TEXT',
        criticality: 'should',
        provenance: 'inline_text',
        payload: expect.objectContaining({
          expectedText: 'Welcome OdysseyOne!',
          matchMode: 'contains_or_semantic',
          strict: false,
        }),
      }),
    ]));
    expect(result.case.declaredAssertions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'PAGE',
        criticality: 'must',
        payload: expect.objectContaining({
          expectedSignals: { text: ['Welcome OdysseyOne!'] },
          strictText: false,
        }),
      }),
    ]));

    const normalized = declaredAssertions.normalizeForCase(result.case.declaredAssertions, {
      automatability: 'automatable',
      caseName: 'Login through OdysseyOne SSO',
    });
    expect(normalized.normalized.some((a) => a.parseFailed)).toBe(false);
  });

  it('recovers validation-message checks even when the source does not label them as assertions', () => {
    const result = inferInlineAssertionsForCase({
      name: 'Microsoft email retry validation',
      automatability: 'automatable',
      steps: [
        { action: 'Click', element: 'Next' },
        {
          action: 'Verify',
          element: 'Email validation message',
          expected: 'Enter a valid email address, phone number, or Skype name.',
        },
      ],
      declaredAssertions: [],
    });

    expect(result.case.declaredAssertions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'EVALUATE',
        criticality: 'should',
        payload: expect.objectContaining({
          expectedReturn: 'Enter a valid email address, phone number, or Skype name.',
          strict: false,
        }),
      }),
    ]));
  });

  it('does not turn entered credentials into final UI assertions', () => {
    const result = inferInlineAssertionsForCase({
      name: 'Enter email',
      automatability: 'automatable',
      steps: [{
        action: 'Fill',
        element: 'Email Address',
        value: 'tester@example.test',
        verify: { kind: 'value', equals: 'tester@example.test' },
      }],
      declaredAssertions: [],
    });

    expect(result.added).toHaveLength(0);
  });

  it('replaces no-assertions placeholders and prefers the final screen validation', () => {
    const result = inferInlineAssertionsForCase({
      name: 'Login through email classifier and Microsoft sign-in',
      automatability: 'automatable',
      assertions: 'Verify Welcome OdysseyOne! is visible after successful login.',
      declaredAssertions: [{
        id: 'ASN-old',
        type: 'TEXT',
        criticality: 'must',
        payload: {},
        source: 'architect',
        parseFailed: true,
        parseIssue: 'no_assertions_declared',
      }],
      steps: [
        {
          id: 'case_step_1',
          action: 'Navigate',
          element: 'Email classifier page',
          expected: 'Email classifier page loaded with Email Address field visible',
          verify: { kind: 'visible', element: { role: 'textbox', name: 'Email Address' } },
        },
        {
          id: 'case_step_2',
          action: 'Fill',
          element: 'Email Address field',
          value: 'OdysseyOneAutomationTester1@odysseylogistics.com',
          expected: 'Email address entered in Email Address field',
          verify: { kind: 'value', equals: 'OdysseyOneAutomationTester1@odysseylogistics.com' },
        },
        {
          id: 'case_step_4',
          action: 'Verify',
          element: 'Sign in with Microsoft option',
          expected: 'Sign in with Microsoft option is displayed',
          verify: { kind: 'visible', element: { role: 'button', name: 'Sign in with Microsoft' } },
        },
        {
          id: 'case_step_11',
          action: 'Verify',
          element: 'OdysseyOne Home dashboard',
          expected: "Home dashboard displayed with 'Welcome OdysseyOne!' visible",
          verify: { kind: 'text', text: 'Welcome OdysseyOne!' },
        },
      ],
    });

    const next = result.case.declaredAssertions;
    expect(result.added.length).toBeGreaterThan(0);
    expect(next.some((assertion) => assertion.parseFailed)).toBe(false);
    expect(next.some((assertion) => assertion.id === 'ASN-old')).toBe(false);
    expect(next).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'TEXT',
        criticality: 'should',
        payload: expect.objectContaining({
          expectedText: 'Welcome OdysseyOne!',
          strict: false,
        }),
      }),
      expect.objectContaining({
        type: 'PAGE',
        criticality: 'must',
        payload: expect.objectContaining({
          expectedSignals: { text: ['Welcome OdysseyOne!'] },
          strictText: false,
        }),
      }),
    ]));
    expect(JSON.stringify(next)).not.toContain('accepts the provided value');
    expect(JSON.stringify(next)).not.toContain('"is"');
  });

  it('runs before Architect zero-assertion demotion for unlabeled plain-text validations', () => {
    const suite = [{
      name: 'OdysseyOne SSO',
      module: 'auth',
      cases: [{
        name: 'Full login from fresh browser',
        automatability: 'automatable',
        steps: [
          { action: 'Click', element: 'Sign in' },
          { action: 'Verify', element: 'Home dashboard', expected: 'Welcome OdysseyOne! is visible' },
        ],
        declaredAssertions: [],
      }],
    }];

    expect(architect.demoteZeroAssertionAutomation(JSON.parse(JSON.stringify(suite))).demotedCount).toBe(1);
    const recovered = inferInlineAssertionsForScenarios(suite);
    expect(recovered.assertionsAdded).toBeGreaterThan(0);
    expect(architect.demoteZeroAssertionAutomation(suite).demotedCount).toBe(0);
  });

  it('uses unlabeled validation prose to identify procedural flows without promoting full sentences as exact assertions', () => {
    const contract = proceduralFlowContract.extractProceduralFlowContract([{
      title: 'plain flow',
      content: `
Scenario:
Login through SSO.

Test Case:
One SSO login.

Steps:
1. Open the login page.
2. Enter the email address.
3. Click Sign in.
4. Verify that Welcome OdysseyOne! is visible.

Expected Scenario/Test Case Shape:
Expected scenario count: 1
Expected test case count: 1
Reason: this is one continuous login flow.
`,
    }]);

    expect(contract.isProcedural).toBe(true);
    expect(contract.strictOneCase).toBe(true);
    expect(contract.finalAssertions).toEqual([]);
  });
});
