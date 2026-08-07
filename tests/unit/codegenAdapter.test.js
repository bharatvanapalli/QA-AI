import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adapterContract = require('../../server/services/codegen/adapters/frameworkAdapter');
const adapterRegistry = require('../../server/services/codegen/adapters');
const exportValidate = require('../../server/services/codegen/_exportValidate');
const regressionCorpus = require('../../server/services/codegen/adapters/regressionCorpus');

describe('ReplayIR adapter scaffold', () => {
  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  it('freezes a valid ReplayIR sample fixture for the P6/P7 seam', () => {
    const corpus = regressionCorpus.forAdapter('playwright-reference');
    expect(corpus).toHaveLength(1);

    const result = adapterContract.validateReplayIR(corpus[0].replayIR);
    expect(result.valid).toBe(true);
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);

    expect(corpus[0].replayIR.steps.map((s) => s.op)).toEqual([
      'handlePopup', 'resolve', 'act', 'waitFor', 'assert', 'humanInput',
    ]);
    expect(corpus[0].replayIR.steps.map((s) => s.id)).toEqual([
      'STEP_HANDLE_OVERLAY', 'STEP_RESOLVE_INPUT', 'STEP_FILL_INPUT',
      'STEP_WAIT_FOR_INPUT', 'STEP_ASSERT_STATE', 'STEP_READ_TEST_HOOK',
    ]);
    expect(corpus[0].compileOptions.dependsOn).toEqual(['CONTRACT_PREREQUISITE']);
    expect(corpus[0].replayIR.dataRows).toHaveLength(2);
    expect([...adapterContract.ASSERT_CHANNELS]).toContain('UI_TEXT');
    expect([...adapterContract.ASSERT_CHANNELS]).toContain('FORBIDDEN_ROLE');
    expect([...adapterContract.DATA_SENSITIVITY]).toEqual(['synthetic', 'masked', 'restricted']);
  });

  it('reports inline act values and unsafe valueRef schemes without suppressing output', () => {
    const base = regressionCorpus.forAdapter('playwright-reference')[0].replayIR;
    const inline = clone(base);
    const fill = inline.steps.find((s) => s.op === 'act' && s.action === 'fill');
    delete fill.valueRef;
    delete fill.valueBinding;
    delete fill.dataRole;
    fill.value = 'super-secret-under-a-generic-key';

    const inlineResult = adapterContract.validateReplayIR(inline);
    expect(inlineResult.valid).toBe(true);
    expect(inlineResult.findings.some((f) => f.rule === 'replayir_inline_value_forbidden')).toBe(true);
    expect(inlineResult.findings.some((f) => f.rule === 'replayir_value_ref_required')).toBe(true);
    const adapter = adapterRegistry.getAdapter('playwright-reference');
    const inlineCompiled = adapterContract.compileReplayIR(adapter, inline);
    const inlineArtifacts = Object.values(inlineCompiled.files).join('\n');
    expect(Object.keys(inlineCompiled.files).length).toBeGreaterThan(0);
    expect(inlineArtifacts).not.toContain('super-secret-under-a-generic-key');

    const unsafe = clone(base);
    unsafe.steps.find((s) => s.op === 'act' && s.action === 'fill').valueRef = 'data:password';
    const unsafeResult = adapterContract.validateReplayIR(unsafe);
    expect(unsafeResult.valid).toBe(true);
    expect(unsafeResult.findings.some((f) => f.rule === 'replayir_value_ref_unsafe')).toBe(true);
    const unsafeCompiled = adapterContract.compileReplayIR(adapter, unsafe);
    expect(Object.keys(unsafeCompiled.files).length).toBeGreaterThan(0);
  });

  it('reports a missing test-hook valueRef without suppressing output', () => {
    const ir = clone(regressionCorpus.forAdapter('playwright-reference')[0].replayIR);
    delete ir.steps.find((s) => s.op === 'humanInput').valueRef;

    const result = adapterContract.validateReplayIR(ir);
    expect(result.valid).toBe(true);
    expect(result.findings.some((f) => f.rule === 'replayir_value_ref_required')).toBe(true);
    const adapter = adapterRegistry.getAdapter('playwright-reference');
    const compiled = adapterContract.compileReplayIR(adapter, ir);
    expect(Object.keys(compiled.files).length).toBeGreaterThan(0);
  });

  it('rejects unknown assertion channels and data sensitivity values', () => {
    const ir = clone(regressionCorpus.forAdapter('playwright-reference')[0].replayIR);
    ir.steps.find((s) => s.op === 'assert').channel = 'UI_ROLE/PAGE';
    ir.dataRows[0].sensitivity = 'plaintext';

    const result = adapterContract.validateReplayIR(ir);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === 'replayir_assert_bad_channel')).toBe(true);
    expect(result.findings.some((f) => f.rule === 'replayir_data_row_bad_sensitivity')).toBe(true);
  });

  it('validates the reference Playwright adapter interface', () => {
    const adapter = adapterRegistry.getAdapter('playwright-reference');
    expect(adapterRegistry.listAdapters()).toContain('playwright-reference');

    const result = adapterContract.validateAdapter(adapter);
    expect(result.valid).toBe(true);
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('compiles the sample ReplayIR through the reference Playwright adapter', () => {
    const adapter = adapterRegistry.getAdapter('playwright-reference');
    const corpus = regressionCorpus.forAdapter('playwright-reference')[0];
    const compiled = adapterContract.compileReplayIR(adapter, corpus.replayIR, corpus.compileOptions);
    const file = compiled.layout.testFile;
    const content = compiled.files[file];

    expect(file).toBe('tests/replayir/contract-case.spec.ts');
    expect(compiled.compileCommand).toEqual({ cmd: 'npx', args: ['playwright', 'test', '--list'] });
    expect(compiled.runCommand).toEqual({ cmd: 'npx', args: ['playwright', 'test'] });
    for (const fragment of corpus.expectedFragments) {
      expect(content).toContain(fragment);
    }
    expect(content).toContain('"Row 1 - primary contract data"');
    expect(content).toContain('"Row 2 - alternate contract data"');
    expect(content).toContain('readData(row, "authoredInput")');
    expect(content).toContain('"authoredInput": "primary-contract-value"');
    expect(content).toContain('"authoredInput": "alternate-contract-value"');
    expect(content).toContain('DATA DEPENDENCY: Requires data created by: CONTRACT_PREREQUISITE');
    expect(content).not.toContain('scenarioVariant');
    expect(content).not.toContain('CHANGE_ME_PASSWORD');
    expect(content).not.toMatch(/password\s*[:=]\s*["'][^"']+["']/i);
  });

  it('emits parseable Playwright TypeScript that still passes export validation', () => {
    const adapter = adapterRegistry.getAdapter('playwright-reference');
    const corpus = regressionCorpus.forAdapter('playwright-reference')[0];
    const compiled = adapterContract.compileReplayIR(adapter, corpus.replayIR, corpus.compileOptions);

    const result = exportValidate.validateExport({
      framework: 'playwright-pom',
      caseStatus: corpus.replayIR.verdict.status,
      files: compiled.files,
    });

    expect(result.exportPassed).toBe(true);
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});
