import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const registry = require('../../server/services/codegen/adapters/bddStepRegistry');
const compiler = require('../../server/services/codegen/adapters/bddCompiler');
const readiness = require('../../server/services/codegen/adapters/bddExportReadiness');
const replayIrBdd = require('../../server/services/codegen/adapters/replayIrBdd');

describe('generic BDD and ReplayIR output', () => {
  it('preserves authored step count/order with semantic names and executable neutral glue', () => {
    const authoredSteps = [
      { action: 'click', target: 'el1', element: 'Review control' },
      { kind: 'wait', action: 'wait', element: 'Review panel', value: 'visible' },
      { kind: 'assertion', action: 'verify', element: 'Review result', expected: 'Ready', soft: true },
      { kind: 'context', action: 'establish', element: 'current browser context' },
      { kind: 'dependency', action: 'continue', element: 'prior authenticated session', value: 'dependency:session.state' },
    ];
    const result = compiler.compileFeature({
      featureName: 'RootPage',
      scenarioName: 'el1',
      authoredSteps,
      adapterId: 'playwright-bdd',
    });

    const semanticLines = result.feature.split('\n').filter((line) => /^\s+(?:Given|When|Then)\s/.test(line));
    expect(semanticLines).toHaveLength(authoredSteps.length);
    expect(result.feature).toContain('Feature: Authored browser workflow');
    expect(result.feature).toContain('Scenario: Execute authored browser workflow');
    expect(result.feature).toContain('QAAI_NON_BLOCKING');
    expect(result.feature).not.toMatch(/\bel1\b|\bRootPage\b|\bstep\s+\d+\b/i);
  });

  it('keeps all six typed binding kinds distinct and case-local without blank fallbacks', () => {
    const fixtures = [
      [{ kind: 'literal', value: 'Alpha' }, 'Alpha'],
      [{ kind: 'secret_env', reference: 'env:QAAI_ACCESS_SECRET' }, 'env:QAAI_ACCESS_SECRET'],
      [{ kind: 'workbook_column', sheet: 'Rows', column: 'Account Name', usableRowCount: 2 }, '{{Account Name}}'],
      [{ kind: 'runtime_output', reference: 'runtime:created_record' }, 'runtime:created_record'],
      [{ kind: 'dependency_output', reference: 'dependency:session.state' }, 'dependency:session.state'],
      [{ kind: 'generated_value', reference: 'generated:unique_name' }, 'generated:unique_name'],
    ];
    const values = fixtures.map(([binding, expected], index) => {
      const step = registry.toAuthoredStep({
        action: 'fill',
        element: `Neutral field ${String.fromCharCode(65 + index)}`,
        value: 'raw authored value',
        valueBinding: binding,
      }, index, null);
      expect(step.params.value).toBe(expected);
      return step.params.value;
    });
    expect(values.every((value) => String(value).trim().length > 0)).toBe(true);

    const first = registry.toAuthoredStep(
      { action: 'fill', element: 'Shared field', value: 'unscoped' },
      0,
      { entries: [{ step: 1, key: 'value', kind: 'literal', value: 'First case value' }] },
    );
    const second = registry.toAuthoredStep(
      { action: 'fill', element: 'Shared field', value: 'unscoped' },
      0,
      { entries: [{ step: 1, key: 'value', kind: 'literal', value: 'Second case value' }] },
    );
    expect(first.params.value).toBe('First case value');
    expect(second.params.value).toBe('Second case value');
  });

  it('emits files for weak locator diagnostics and localizes the guessed-locator comment', () => {
    const result = readiness.assessBddExportReadiness({
      framework: 'playwright-bdd',
      caseStatus: 'pass',
      featureName: 'Review workflow',
      scenarioName: 'Activate review control',
      moduleName: 'Review',
      operations: [{
        operation: 'activateControl',
        action: 'click',
        element: 'Review control',
        locatorProvenance: { kind: 'llm_candidate' },
        candidates: [{ strategy: 'role', role: 'button', name: 'Review control' }],
      }],
    });

    expect(result.exportable).toBe(true);
    expect(Object.keys(result.files).some((file) => file.endsWith('.feature'))).toBe(true);
    const feature = Object.entries(result.files).find(([file]) => file.endsWith('.feature'))?.[1] || '';
    expect(feature).toContain('QAAI_LOCATOR_FALLBACK');
    expect(feature.indexOf('QAAI_LOCATOR_FALLBACK')).toBeLessThan(feature.indexOf('When I perform authored action'));
    expect(result.files['support/capabilityOperations.ts']).toContain('authoredLocator');
    expect(result.files['support/capabilityOperations.ts']).toContain("'authoredAction'");
    expect(result.files['support/capabilityOperations.ts']).toContain('doAuthoredStep');
  });

  it('preserves exact verified locator evidence when capability proof exists', () => {
    const selector = '[data-testid="review-control"]';
    const result = readiness.assessBddExportReadiness({
      framework: 'playwright-bdd',
      featureName: 'Review workflow',
      scenarioName: 'Invoke review action',
      moduleName: 'Review',
      operations: [{ operation: 'invokeAction', capabilityRef: 'review-action', params: { action: 'review' } }],
      capabilities: [{
        id: 'review-action',
        type: 'workflow_action',
        name: 'Review action',
        operations: ['invokeAction'],
        evidence: { button: { selector } },
        elementRefs: ['review-control'],
      }],
    });

    expect(result.exportable).toBe(true);
    expect(result.files['support/capabilityOperations.ts']).toContain('[data-testid=\\"review-control\\"]');
    expect(result.boundOperations[0].capability.evidence.button.selector).toBe(selector);
  });

  it('keeps observed navigation as evidence and preserves ReplayIR authored parity', () => {
    const observedUrl = 'https://example.test/runtime/landing';
    const result = {
      runId: 'internal-run',
      runResultId: 'internal-result',
      testCaseId: 'internal-case',
      caseName: 'Review landing state',
      moduleName: 'Review',
      status: 'pass',
      envelope: {
        complete: true,
        ir: {
          version: 1,
          caseId: 'internal-case',
          authProfile: { id: 'none', strategy: 'none' },
          steps: [
            { op: 'act', action: 'navigate', url: observedUrl, origin: 'inferred_helper', helperOperation: true, authored: false },
            { op: 'resolve', as: 'reviewControl', candidates: [{ strategy: 'role', role: 'button', name: 'Review control' }] },
            { op: 'act', action: 'click', target: 'reviewControl' },
            { op: 'assert', channel: 'UI_TEXT', expected: 'Ready', contractRef: 'review-ready', soft: true },
          ],
          verdict: { status: 'pass', perAssertionOutcomes: [] },
        },
      },
    };
    const compiled = replayIrBdd.compileResults({ results: [result] });

    expect(compiled.blocked).toEqual([]);
    const admitted = compiled.admitted[0];
    expect(admitted.featureContent).toContain('QAAI_OBSERVED_NAVIGATION');
    expect(admitted.featureContent).toContain('current page should match observed transition "/runtime/landing"');
    expect(admitted.featureContent).not.toContain(`Given I open "${observedUrl}"`);
    expect(admitted.bdd).toMatchObject({
      authoredStepCount: 3,
      emittedAuthoredStepCount: 3,
      authoredStepParity: true,
    });
    expect(admitted.featureContent).toContain('QAAI_NON_BLOCKING');
  });

  it('contains no website-domain templates in the generic BDD architecture', () => {
    const files = [
      'bddBoundOperations.js', 'bddCompiler.js', 'bddExportReadiness.js',
      'bddGlueEmitters.js', 'bddStepRegistry.js', 'replayIrBdd.js',
    ];
    const source = files.map((file) => fs.readFileSync(path.resolve(
      process.cwd(), 'server/services/codegen/adapters', file,
    ), 'utf8')).join('\n');
    expect(source).not.toMatch(/\b(?:product|category|brand|price)\b/i);
  });
});
