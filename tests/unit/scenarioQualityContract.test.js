import { describe, expect, it } from 'vitest';
import quality from '../../server/services/scenarioQualityContract.js';
import generationCompiler from '../../server/services/generationCompiler.js';

const mustText = {
  id: 'ASN-1',
  type: 'TEXT',
  criticality: 'must',
  payload: { expectedText: 'Personal Details' },
  checkAt: 'end',
};

const goodCase = (name = 'Add employee and verify Personal Details') => ({
  name,
  type: 'functional',
  confidence: 90,
  assertions: 'Personal Details page opens',
  declaredAssertions: [mustText],
  steps: [
    { order: 1, action: 'Navigate', element: 'PIM Add Employee page', value: '/pim/addEmployee', expected: 'Add Employee form visible' },
    { order: 2, action: 'Fill', element: 'First Name field', value: 'QAAI' },
    { order: 3, action: 'Click', element: 'Save button', expected: 'Personal Details page opens' },
  ],
});

describe('scenario quality contract', () => {
  it('rejects vague generated steps before a case becomes ready', () => {
    const c = goodCase('Vague page check');
    c.steps = [{ order: 1, action: 'Verify', element: 'page', expected: 'page works properly' }];

    const result = quality.evaluateCaseQuality({
      scenario: { name: 'Bad scenario', module: 'pim' },
      caseObj: c,
    });

    expect(result.blockers.some((b) => b.code === 'vague_step')).toBe(true);
    expect(c.qualityContract.markdownSpecStatus).toBe('blocked_quality_contract');
  });

  it('blocks unresolved executable semantic findings and caps misleading confidence', () => {
    const c = goodCase('Semantically invalid high-confidence case');
    c.confidence = 99;
    c.semanticFindings = [{ code: 'instruction_prose_target', index: 1 }];

    const result = quality.evaluateCaseQuality({
      scenario: { name: 'Semantic health', module: 'orders' },
      caseObj: c,
    });

    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'semantic_design_defect',
        semanticCode: 'instruction_prose_target',
        step: 2,
      }),
    ]));
    expect(c.confidence).toBe(60);
    expect(c.qualityContract).toMatchObject({
      markdownSpecStatus: 'blocked_quality_contract',
      confidence: 60,
      semanticHealth: 'blocked',
      semanticFindingCount: 1,
    });
  });

  it('detects duplicate cases and stamps a clean session rule', () => {
    const scenarios = [{
      name: 'PIM lifecycle',
      module: 'pim',
      cases: [goodCase('Create employee A'), goodCase('Create employee duplicate')],
    }];

    const result = quality.compileScenarioQuality({ scenarios, authProfileName: 'ADMIN_DEFAULT' });

    expect(result.report.total).toBe(2);
    expect(result.report.duplicates).toBe(1);
    expect(result.report.blocked).toBe(1);
    expect(scenarios[0].cases[0].qualityContract.sessionRule).toMatchObject({
      isolation: 'fresh_context_per_case',
      cleanup: 'close_context_after_case',
      dirtyStatePolicy: 'never_reuse_dirty_state',
    });
    expect(scenarios[0].cases[0].qualityContract.role).toBe('ADMIN_DEFAULT');
  });

  it('keeps duplicate or vague cases out of GenerationCompiler ready output', () => {
    const scenarios = [{
      name: 'PIM lifecycle',
      module: 'pim',
      cases: [
        goodCase('Create employee A'),
        goodCase('Create employee duplicate'),
        { ...goodCase('Vague verifier'), steps: [{ action: 'Verify', element: 'functionality', expected: 'works as expected' }] },
      ],
    }];

    const compiled = generationCompiler.compileGeneration({ scenarios, authProfileName: 'ADMIN_DEFAULT' });

    expect(compiled.report.total).toBe(3);
    expect(compiled.report.ready).toBe(1);
    expect(compiled.readyScenarios[0].cases).toHaveLength(1);
    expect(compiled.report.defects.some((d) => d.code === 'duplicate_case')).toBe(true);
    expect(compiled.report.defects.some((d) => d.code === 'vague_step')).toBe(true);
  });

  it('builds native-agent Markdown specs with preconditions and session cleanup', () => {
    const c = goodCase();
    quality.evaluateCaseQuality({
      scenario: { name: 'PIM lifecycle', module: 'pim' },
      caseObj: c,
      opts: { authProfileName: 'ADMIN_DEFAULT' },
    });

    const spec = quality.buildMarkdownSpec({
      project: { name: 'OrangeHRM', targetUrl: 'https://opensource-demo.orangehrmlive.com/' },
      scenario: { name: 'PIM lifecycle', module: 'pim' },
      testCase: c,
    });

    expect(spec).toContain('## Preconditions');
    expect(spec).toContain('Authenticate as ADMIN_DEFAULT');
    expect(spec).toContain('## Session And Cleanup');
    expect(spec).toContain('Dirty-state policy: never_reuse_dirty_state');
  });
});
