import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const reference = require('../../server/services/codegen/adapters/playwrightReference.js');
const pom = require('../../server/services/codegen/adapters/playwrightPom.js');

describe('Playwright authored-step continuation parity', () => {
  it('requires visible rendered text instead of accessibility-only or fuzzy matches', () => {
    const supportSources = [
      ...Object.values(reference.supportFiles()),
      ...Object.values(reference.playwrightReferenceJs.supportFiles()),
    ];
    for (const source of supportSources) {
      expect(source).toContain('page.getByText(expected, { exact: false })');
      expect(source).toContain('matches.nth(index).isVisible()');
      expect(source).toContain('expect.poll');
      expect(source).not.toContain('.or(page.locator');
      expect(source).not.toContain('accessible-but-non-visible');
      expect(source).not.toContain('const _STOP');
    }
  });

  it('retains unsupported/manual operations as explicit soft failures', () => {
    const emissions = [
      reference.emitStep({ op: 'act', action: 'gesture', target: 'el9' }, [], {}),
      reference.emitWait({ kind: 'business_event' }),
      reference.emitHumanInput('manual_gate', { field: 'approval code' }),
      reference.emitHumanInput('unsupported', { field: 'biometric confirmation' }),
      reference.emitAssertion({ op: 'assert', channel: 'API', expected: '201' }),
      reference.emitAssertion({ op: 'assert', channel: 'DB_READ', expected: 'saved' }),
    ];

    for (const source of emissions) {
      expect(source).toContain('QAAI_FALLBACK_');
      expect(source).toContain('expect.soft(false');
      expect(source).not.toContain('throw new Error');
    }
  });

  it('uses a semantic executable locator guess when only the locator is missing', () => {
    const source = reference.emitStep({
      op: 'act',
      action: 'click',
      target: 'el7',
      targetName: 'Continue',
    }, [], {});

    expect(source).toContain('QAAI_GUESSED_LOCATOR');
    expect(source).toContain('const continueButton = page.getByRole("button"');
    expect(source).toContain('await continueButton.click');
    expect(source).not.toContain('el7');
  });

  it('softens the whole runtime assertion by default and keeps explicit flow prerequisites hard', () => {
    const ordinary = reference.emitAssertion({
      op: 'assert',
      channel: 'A11Y',
      expected: 'critical',
      criticality: 'must',
    });
    const prerequisite = reference.emitAssertion({
      op: 'assert',
      channel: 'UI_TEXT',
      expected: 'Authenticated dashboard',
      flowCritical: true,
    });

    expect(ordinary).toContain('await (async () =>');
    expect(ordinary).toContain('await checkAccessibility');
    expect(ordinary).toContain('expect.soft(false');
    expect(prerequisite).toContain('await assertTextPresent');
    expect(prerequisite).not.toContain('expect.soft(false');
  });

  it('keeps POM waits, consequence navigation, fallbacks, and later steps in authored order', () => {
    const emitted = pom.emitJourneySpec([{
      caseName: 'Continue the complete flow',
      ir: {
        caseId: 'continuation-case',
        title: 'Continue the complete flow',
        steps: [
          { op: 'resolve', as: 'continueButton', candidates: [{ strategy: 'role', role: 'button', name: 'Continue' }] },
          { op: 'act', action: 'click', target: 'continueButton' },
          { op: 'waitFor', condition: { kind: 'visible', target: 'continueButton', timeoutMs: 5000 } },
          { op: 'act', action: 'navigate', url: 'https://example.test/dashboard' },
          { op: 'assert', channel: 'UI_TEXT', target: 'continueButton', expected: 'Ready' },
          { op: 'humanInput', disposition: 'manual_gate', field: 'approval code' },
          { op: 'assert', channel: 'API', expected: '201' },
          { op: 'act', action: 'gesture', target: 'continueButton' },
          { op: 'act', action: 'hover', target: 'continueButton' },
        ],
      },
    }], { scenarioName: 'Continuation parity' });

    const source = emitted.content;
    const click = source.indexOf('.clickContinue(');
    const wait = source.indexOf('.waitFor({ state: \'visible\'');
    const navigation = source.indexOf('page.waitForURL(new RegExp');
    const manual = source.indexOf('QAAI_FALLBACK_HUMAN_INPUT');
    const api = source.indexOf('QAAI_FALLBACK_ASSERTION');
    const unsupported = source.indexOf('QAAI_FALLBACK_ACTION');
    const hover = source.indexOf('.hoverContinue(');

    expect(source).toMatch(/import \{ test, expect \} from '@playwright\/test'/);
    for (const [label, index] of Object.entries({ click, wait, navigation, manual, api, unsupported, hover })) {
      expect(index, `${label} emission must be present`).toBeGreaterThanOrEqual(0);
    }
    expect(click).toBeLessThan(wait);
    expect(wait).toBeLessThan(navigation);
    expect(manual).toBeLessThan(api);
    expect(api).toBeLessThan(unsupported);
    expect(unsupported).toBeLessThan(hover);
    expect(source).not.toContain('throw new Error("Unsupported ReplayIR');
    expect(source).not.toContain('ContinueButt');
  });

  it('makes POM EvaluateMethods soft unless the assertion is explicitly flow-critical', () => {
    const soft = pom.emitJourneySpec([{
      caseName: 'Soft evaluate',
      ir: { caseId: 'soft-evaluate', steps: [{ op: 'assert', channel: 'EVALUATE', script: '() => "actual"', expected: 'expected' }] },
    }], { scenarioName: 'Soft evaluate' });
    const hard = pom.emitJourneySpec([{
      caseName: 'Hard evaluate',
      ir: { caseId: 'hard-evaluate', steps: [{ op: 'assert', channel: 'EVALUATE', script: '() => "actual"', expected: 'expected', dependencyPrerequisite: true }] },
    }], { scenarioName: 'Hard evaluate' });

    expect(soft.extraFiles['pages/EvaluateMethods.ts']).toContain('expect.soft(_result');
    expect(hard.extraFiles['pages/EvaluateMethods.ts']).toContain('expect(_result');
    expect(hard.extraFiles['pages/EvaluateMethods.ts']).not.toContain('expect.soft(_result');
  });
});
