const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom');
const playwrightReference = require('../../server/services/codegen/adapters/playwrightReference');

const CASE_ID = 'case-authored-a';
const STEP_ID = 'step-authored-1';

function stepWith(valueBinding, rawValue = 'authored-inline-value') {
  return {
    op: 'act',
    action: 'fill',
    target: 'accountField',
    contractStepId: STEP_ID,
    rawValue,
    valueBinding,
  };
}

function referenceLine(valueBinding, options = {}) {
  return playwrightReference.emitStep(
    stepWith(valueBinding, options.rawValue),
    [],
    { accountField: 'accountField' },
    {
      hasDataLoop: options.hasDataLoop === true,
      dataRows: options.dataRows || [],
      bindingMetadata: options.bindingMetadata || {},
      caseId: options.caseId || CASE_ID,
    },
  );
}

function pomLine(valueBinding, options = {}) {
  const asMap = new Map([
    ['accountField', {
      file: 'applicationPage',
      name: 'accountFieldInput',
      pageVar: 'applicationPage',
    }],
  ]);
  return playwrightPom._pomEmitAct(
    stepWith(valueBinding, options.rawValue),
    asMap,
    options.hasDataLoop === true,
    null,
    null,
    {
      exportedKeys: options.exportedKeys || new Map(),
      bindingMetadata: options.bindingMetadata || {},
      caseId: options.caseId || CASE_ID,
    },
    null,
  );
}

function bothLines(valueBinding, options = {}) {
  return [
    referenceLine(valueBinding, options),
    pomLine(valueBinding, options),
  ];
}

describe('Playwright typed binding output', () => {
  test('keeps literal authored values inline without inventing tokens', () => {
    for (const output of bothLines({ kind: 'literal', value: 'All Users = 66' })) {
      expect(output).toContain('"All Users = 66"');
      expect(output).not.toMatch(/\{\{|\}\}/);
    }
  });

  test('emits secret_env through a required stable environment accessor only', () => {
    for (const output of bothLines(
      { kind: 'secret_env', envKey: 'QAAI_ACCOUNT_PASSWORD' },
      { rawValue: 'must-never-be-embedded' },
    )) {
      expect(output).toContain('readEnv("QAAI_ACCOUNT_PASSWORD")');
      expect(output).toContain('throws when missing; no secret is embedded');
      expect(output).not.toContain('must-never-be-embedded');
      expect(output).not.toMatch(/readEnv\([^)]*\)\s*\|\||\|\|\s*["']{2}/);
    }
  });

  test('uses a workbook column only with usable proof scoped to the current case', () => {
    const binding = {
      kind: 'workbook_column',
      column: 'UserName',
      proof: { usable: true, caseId: CASE_ID },
    };
    const options = {
      hasDataLoop: true,
      dataRows: [{ index: 0, label: 'authored row', fields: { UserName: 'row-user' } }],
      exportedKeys: new Map([['username', 'UserName']]),
    };
    for (const output of bothLines(binding, options)) {
      expect(output).toContain('readData(row, "UserName")');
      expect(output).not.toContain('lacks case-scoped usable-row proof');
    }
  });

  test('rejects another case workbook proof and retains the authored inline literal', () => {
    const binding = {
      kind: 'workbook_column',
      column: 'UserName',
      proof: { usable: true, caseId: 'case-authored-b' },
    };
    const options = {
      rawValue: 'current-case-inline-user',
      hasDataLoop: true,
      dataRows: [{ index: 0, label: 'authored row', fields: { UserName: 'wrong-case-row-user' } }],
      exportedKeys: new Map([['username', 'UserName']]),
    };
    for (const output of bothLines(binding, options)) {
      expect(output).toContain('lacks case-scoped usable-row proof');
      expect(output).toContain('"current-case-inline-user"');
      expect(output).not.toContain('readData(row');
      expect(output).not.toContain('wrong-case-row-user');
    }
  });

  test('emits runtime and dependency outputs through explicit missing-value accessors', () => {
    for (const output of bothLines({ kind: 'runtime_output', outputKey: 'createdUserId' })) {
      expect(output).toContain('readRuntimeOutput("createdUserId")');
      expect(output).toContain('throws when unavailable');
    }
    for (const output of bothLines({
      kind: 'dependency_output',
      dependencyCaseId: 'login-case',
      outputKey: 'authenticatedUserId',
    })) {
      expect(output).toContain('readDependencyOutput("login-case", "authenticatedUserId")');
      expect(output).toContain('throws when unavailable');
    }
  });

  test('emits deterministic authored generated_value contracts without randomness', () => {
    const binding = {
      kind: 'generated_value',
      contract: {
        name: 'orderReference',
        prefix: 'order-',
        length: 8,
        seed: 'authored-seed',
      },
    };
    for (const emit of [referenceLine, pomLine]) {
      const first = emit(binding);
      const second = emit(binding);
      expect(first).toBe(second);
      expect(first).toContain('generateDeterministicValue(');
      expect(first).toContain('"caseId":"case-authored-a"');
      expect(first).toContain('"stepId":"step-authored-1"');
      expect(first).not.toMatch(/Math\.random|Date\.now|randomUUID/);
    }
  });

  test('generated support files define and export every typed-binding helper', () => {
    const typeScriptSupport = playwrightReference.supportFiles()['tests/support/replayir.ts'];
    const commonJsSupport = playwrightReference.playwrightReferenceJs.supportFiles()['tests/support/replayir.js'];
    const esmSupport = playwrightReference.supportFilesJsEsm()['tests/support/replayir.js'];
    for (const helper of [
      'missingBindingValue',
      'readRuntimeOutput',
      'readDependencyOutput',
      'generateDeterministicValue',
    ]) {
      expect(typeScriptSupport).toContain(`export function ${helper}`);
      expect(commonJsSupport).toMatch(new RegExp(`function ${helper}\\b`));
      expect(commonJsSupport).toMatch(new RegExp(`module\\.exports = \\{[^}]*\\b${helper}\\b`));
      expect(esmSupport).toMatch(new RegExp(`export \\{[^}]*\\b${helper}\\b`));
    }
  });
});
