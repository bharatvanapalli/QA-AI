import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const architect = require('../../server/services/agents/architect');

describe('Add Scenario Architect representation contract', () => {
  it('keeps inline values literal while reserving tokens for row-bound data', () => {
    const prompt = architect.contractBatchSystemPrompt();

    expect(prompt).toContain('preserve non-sensitive inline Add Scenario values as exact literals');
    expect(prompt).toContain('use semantic {{tokens}} only for workbook, matrix, fixture, or other row-bound data');
    expect(prompt).toContain('only concrete browser actions and observable product assertions become steps');
    expect(prompt).toContain('never convert a negative constraint such as "do not click" into a Click step');
    expect(prompt).not.toContain('Use semantic {{tokens}} from the pack for data inputs.');
  });

  it('preserves all 55 steps in one explicitly authored flow under the 100-step limit', () => {
    expect(architect.SYSTEM_PROMPT).toContain('up to 100 steps');
    expect(architect.SYSTEM_PROMPT).toContain('MUST remain one test case');
    expect(architect.SYSTEM_PROMPT).toContain('MORE than 100 steps');

    const steps = Array.from({ length: 55 }, (_, index) => ({
      order: index + 1,
      action: index === 0 ? 'Navigate' : 'Click',
      stepKind: 'action',
      element: `Control ${index + 1}`,
      value: index === 0 ? 'https://example.test/start' : undefined,
      expected: `Step ${index + 1} completed`,
      expectedKind: 'action_completed',
      verify: { kind: 'none' },
    }));

    const normalized = architect.normaliseCase({
      name: 'Continuous 55-step authored flow',
      type: 'functional',
      confidence: 90,
      assertions: 'The complete authored flow finishes.',
      steps,
    });

    expect(normalized.steps).toHaveLength(55);
    expect(normalized.steps.map((step) => step.order)).toEqual(
      Array.from({ length: 55 }, (_, index) => index + 1),
    );
    expect(normalized.steps[54].element).toBe('Control 55');
  });

  it('preserves explicit state-changing action effects for Conductor proof', () => {
    const click = architect.candidateStepFromCaseContract({
      id: 'click-navigation-item',
      ordinal: 1,
      type: 'Click',
      target: 'Work items',
      text: 'Click the Work items navigation control.',
      expected: 'Work items page is stable',
      dataRefs: [],
    });

    expect(click).toMatchObject({
      action: 'Click',
      target: 'Work items',
      expected: 'Work items page is stable',
    });
  });

  it('does not reinterpret slashes inside ordinary labels as browser routes', () => {
    const labelAssertion = architect.candidateStepFromCaseContract({
      id: 'assert-slash-labels',
      ordinal: 1,
      type: 'AssertText',
      text: 'Verify the options include Pre-Paid/Add and that Date/Time remains visible.',
      dataRefs: [],
    });
    const navigation = architect.candidateStepFromCaseContract({
      id: 'navigate-route',
      ordinal: 2,
      type: 'Navigate',
      text: 'Navigate to /orders/create.',
      dataRefs: [],
    });
    const urlAssertion = architect.candidateStepFromCaseContract({
      id: 'assert-route',
      ordinal: 3,
      type: 'AssertUrl',
      text: 'Verify the URL matches /orders/create.',
      dataRefs: [],
    });

    expect(labelAssertion).toMatchObject({
      target: 'the options include Pre-Paid/Add and that Date/Time remains visible',
      expected: 'Verify the options include Pre-Paid/Add and that Date/Time remains visible.',
      verify: {
        kind: 'text',
        text: 'Verify the options include Pre-Paid/Add and that Date/Time remains visible.',
      },
    });
    expect(labelAssertion.expected).not.toBe('/Add');
    expect(labelAssertion.expected).not.toBe('/Time');
    expect(navigation.target).toBe('/orders/create');
    expect(urlAssertion).toMatchObject({
      expected: '/orders/create',
      verify: { kind: 'url', url: '/orders/create' },
    });
  });

  it('preserves composite list assertions instead of collapsing them to one data reference', () => {
    const listAssertion = architect.candidateStepFromCaseContract({
      id: 'assert-composite-list',
      ordinal: 1,
      type: 'AssertText',
      text: 'Verify the Mode list contains these options in order: First option Pre-Paid/Add; Second option Date/Time; Third option Collect.',
      dataRefs: ['data.selected_mode'],
    });
    const scalarAssertion = architect.candidateStepFromCaseContract({
      id: 'assert-one-scalar',
      ordinal: 2,
      type: 'AssertText',
      text: 'Verify the selected Mode is exactly {{selected_mode}}.',
      dataRefs: ['data.selected_mode'],
    });

    expect(listAssertion.expected).toBe(
      'Verify the Mode list contains these options in order: First option Pre-Paid/Add; Second option Date/Time; Third option Collect.',
    );
    expect(listAssertion.verify.text).toBe(listAssertion.expected);
    expect(listAssertion.expected).not.toBe('{{selected_mode}}');
    expect(scalarAssertion.expected).toBe('{{selected_mode}}');
    expect(scalarAssertion.verify.text).toBe('{{selected_mode}}');
  });

  it('honors the authoritative human-readable target before text fallback inference', () => {
    const step = architect.candidateStepFromCaseContract({
      id: 'fill-explicit-target',
      ordinal: 1,
      type: 'Fill',
      text: 'Enter SIGROUP, in capital letters, into the organization input.',
      target: 'Owning Organization',
      dataRefs: ['data.organization'],
    });

    expect(step.target).toBe('Owning Organization');
    expect(step.element).toBe('Owning Organization');
  });

  it('gives Add Scenario a universal semantic boundary for noisy pasted stories', () => {
    const route = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/scenarios.js'), 'utf8');

    expect(route).toContain('[SEMANTIC ADD SCENARIO AUTHORING CONTRACT]');
    expect(route).toContain('Only concrete, affirmative browser interactions and observable product assertions become executable steps.');
    expect(route).toContain('authoring metadata; preserve their meaning in the case contract but NEVER turn them into browser actions.');
    expect(route).toContain('must never be inverted into the prohibited Click/Navigate action');
    expect(route).toContain('[ADD SCENARIO LITERAL CONTRACT]: Never emit {{...}} placeholders');
    expect(route).toContain('Materialize user-authored non-sensitive inline values as exact literals');
    expect(route).toContain('compiler-owned credential or env: reference');
    expect(route).toContain('Short values must match whole authored values only');
  });
});
