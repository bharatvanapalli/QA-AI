import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const generationCompiler = require('../../server/services/generationCompiler');
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');
const testDataAuthoring = require('../../server/services/testDataAuthoring');
const { buildWorkbookContract } = require('../../server/services/workbookContract');

function procedural(source, id = 'generic-flow') {
  return proceduralFlowContract.extractProceduralFlowContract([{
    id,
    source: 'uploaded_requirement',
    content: source,
  }]);
}

function oneCase(candidate) {
  return [{ name: 'Generic module', module: 'Generic', cases: [candidate] }];
}

describe('inline data pipeline integration', () => {
  it.each(['initial_upload', 'add_scenario'])(
    'uses explicit inline data over contradictory later prose on %s',
    (inlineSourceSurface) => {
      const contract = procedural(`
Inline test data:
Expected Item Count: 12

Test Case: Validate the item summary
Test steps:
1. Verify Expected Item Count = 9.
`);
      const compiled = generationCompiler.compileGeneration({
        scenarios: oneCase({
          name: 'Validate the item summary',
          steps: [{ action: 'Verify', element: 'Expected Item Count', expected: '9' }],
          assertions: 'Expected Item Count = 9',
          declaredAssertions: [],
        }),
        proceduralFlowContract: contract,
        inlineSourceSurface,
      }).scenarios[0].cases[0];

      expect(compiled.steps[0].expected).toBe('12');
      expect(compiled.assertions).toContain('12');
      expect(compiled.inlineRequirementData).toMatchObject({
        source: inlineSourceSurface,
        provenance: { expected_item_count: 'inline_data_block' },
      });
    },
  );

  it('allows workbook tokens only for an explicit case-scoped mapping with usable rows', () => {
    const contract = procedural(`
Inline test data:
Search Term: Alice

Test Case: Search the directory
Test steps:
1. Enter Alice in the Search Term field.
`);
    const mapping = {
      bindings: [{
        caseScopeId: 'case-search-directory',
        sheet: 'SearchRows',
        columnToField: { search_term: 'Search Term' },
      }],
    };
    const candidate = () => ({
      caseScopeId: 'case-search-directory',
      name: 'Search the directory',
      dataBinding: { sheet: 'SearchRows', columnToField: { search_term: 'Search Term' } },
      steps: [{ action: 'Fill', element: 'Search Term', value: 'Alice' }],
      assertions: 'Search completes.',
      declaredAssertions: [],
    });

    const headerOnly = generationCompiler.compileGeneration({
      scenarios: oneCase(candidate()),
      proceduralFlowContract: contract,
      testData: { mapping, sheets: [{ name: 'SearchRows', headers: ['Search Term'], rows: [] }] },
    }).scenarios[0].cases[0];
    expect(headerOnly.steps[0].value).toBe('Alice');
    expect(headerOnly.dataBinding).toBeNull();

    const blankMappedRow = generationCompiler.compileGeneration({
      scenarios: oneCase(candidate()),
      proceduralFlowContract: contract,
      testData: {
        mapping,
        sheets: [{ name: 'SearchRows', headers: ['Search Term'], rows: [{ 'Search Term': '   ' }] }],
      },
    }).scenarios[0].cases[0];
    expect(blankMappedRow.steps[0].value).toBe('Alice');
    expect(blankMappedRow.dataBinding).toBeNull();

    const foreignCaseMapping = generationCompiler.compileGeneration({
      scenarios: oneCase(candidate()),
      proceduralFlowContract: contract,
      testData: {
        mapping: {
          bindings: [{
            caseScopeId: 'case-another-search',
            sheet: 'SearchRows',
            columnToField: { search_term: 'Search Term' },
          }],
        },
        sheets: [{ name: 'SearchRows', headers: ['Search Term'], rows: [{ 'Search Term': 'Alice' }] }],
      },
    }).scenarios[0].cases[0];
    expect(foreignCaseMapping.steps[0].value).toBe('Alice');
    expect(foreignCaseMapping.dataBinding).toBeNull();

    const sheets = [{ name: 'SearchRows', headers: ['Search Term'], rows: [{ 'Search Term': 'Alice' }] }];
    const usable = generationCompiler.compileGeneration({
      scenarios: oneCase(candidate()),
      proceduralFlowContract: contract,
      testData: { mapping, sheets },
    }).scenarios[0].cases[0];
    expect(usable.steps[0].value).toBe('{{search_term}}');
    expect(usable.dataBinding).toMatchObject({
      sheet: 'SearchRows',
      caseScopeId: 'case-search-directory',
    });

    const workbook = buildWorkbookContract({ sheets });
    expect(testDataAuthoring.mappingEligibleBindings({ mapping, sheets }, workbook)).toHaveLength(1);
    expect(testDataAuthoring.mappingEligibleBindings({ mapping, sheets: [{ ...sheets[0], rows: [] }] },
      buildWorkbookContract({ sheets: [{ ...sheets[0], rows: [] }] }))).toHaveLength(0);
  });

  it('does not move repeated labels or equal values between case scopes', () => {
    const contract = procedural(`
Test Case: First account
Inline test data:
Account Tier: Shared
Test steps:
1. Verify Account Tier = Shared.

Test Case: Second account
Inline test data:
Account Tier: Shared
Test steps:
1. Verify Account Tier = Shared.

Test Case: Third account
Inline test data:
Account Tier: Restricted
Test steps:
1. Verify Account Tier = Restricted.
`, 'three-scoped-cases');
    const candidate = (name) => ({
      name,
      steps: [{ action: 'Verify', element: 'Account Tier', expected: '{{account_tier}}' }],
      assertions: 'Verify Account Tier.',
      declaredAssertions: [],
    });
    const cases = generationCompiler.compileGeneration({
      scenarios: [{
        name: 'Accounts',
        cases: [candidate('First account'), candidate('Second account'), candidate('Third account')],
      }],
      proceduralFlowContract: contract,
      inlineSourceSurface: 'initial_upload',
    }).scenarios[0].cases;

    expect(cases.map((item) => item.steps[0].expected)).toEqual(['Shared', 'Shared', 'Restricted']);
    expect(new Set(cases.map((item) => item.caseScopeId)).size).toBe(3);
  });

  it('applies scenario-scoped inline data until the next scenario boundary', () => {
    const contract = procedural(`
Scenario 01: Shared accounts
Test Data:
Account Tier: Shared

Test Case: First account
Test steps:
1. Verify Account Tier = Shared.

Test Case: Second account
Test steps:
1. Verify Account Tier = Shared.

Scenario 02: Restricted accounts
Test Data:
Account Tier: Restricted

Test Case: Third account
Test steps:
1. Verify Account Tier = Restricted.
`, 'scenario-scoped-cases');
    const candidate = (name) => ({
      name,
      steps: [{ action: 'Verify', element: 'Account Tier', expected: '{{account_tier}}' }],
      assertions: 'Verify Account Tier.',
      declaredAssertions: [],
    });
    const cases = generationCompiler.compileGeneration({
      scenarios: [{
        name: 'Accounts',
        cases: [candidate('First account'), candidate('Second account'), candidate('Third account')],
      }],
      proceduralFlowContract: contract,
      inlineSourceSurface: 'initial_upload',
    }).scenarios[0].cases;

    expect(cases.map((item) => item.steps[0].expected)).toEqual(['Shared', 'Shared', 'Restricted']);
  });

  it('does not borrow scenario data when a step explicitly supplies a different value', () => {
    const contract = procedural(`
Scenario 01: Form Inputs
Test Data:
First Name: Ada
Last Name: Lovelace
Email: ada.lovelace@example.test

Test Case: Submit the valid form
Test steps:
1. Enter ada.lovelace@example.test in the Email field.

Test Case: Validate an invalid email
Test steps:
1. Enter "not-an-email" in the Email field.
`, 'form-scenario-data');
    const cases = generationCompiler.compileGeneration({
      scenarios: [{
        name: 'Form Inputs',
        cases: [
          {
            name: 'Submit the valid form',
            steps: [{ action: 'Fill', element: 'Email', value: 'ada.lovelace@example.test' }],
            assertions: 'Verify form submission.',
            declaredAssertions: [],
          },
          {
            name: 'Validate an invalid email',
            steps: [{ action: 'Fill', element: 'Email', value: '"not-an-email"' }],
            assertions: 'Verify validation message.',
            declaredAssertions: [],
          },
        ],
      }],
      proceduralFlowContract: contract,
      inlineSourceSurface: 'initial_upload',
    }).scenarios[0].cases;

    expect(cases[0].caseContractV1.steps[0].dataRefs).toEqual(['data.email']);
    expect(cases[1].caseContractV1.steps[0].dataRefs).toEqual([]);
    expect(cases[1].steps[0].value).toContain('not-an-email');
    expect(cases[1].dataBinding).toBeNull();
  });

  it('preserves all six binding kinds as non-blocking compiler metadata', () => {
    const caseObj = {
      caseScopeId: 'case-six-kinds',
      dataBinding: {
        sheet: 'Rows',
        caseScopeId: 'case-six-kinds',
        columnToField: { account: 'Account' },
      },
      steps: [
        { action: 'Fill', element: 'Display Name', value: 'Alice' },
        { action: 'Fill', element: 'Password', value: 'Authored-Secret-1!' },
        { action: 'Fill', element: 'Account', value: '{{account}}' },
        { action: 'Fill', element: 'Runtime Id', value: 'runtime:created_id' },
        { action: 'Fill', element: 'Session', value: 'dependency:login.session' },
        { action: 'Fill', element: 'Unique Name', value: 'generated:uuid' },
      ],
    };
    const generationContract = {
      bindings: [{
        sheet: 'Rows',
        columnToField: { account: 'Account' },
        usableRowCount: 1,
      }],
    };

    const entries = generationCompiler._private.annotateTypedBindings(caseObj, generationContract);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'literal',
      'secret_env',
      'workbook_column',
      'runtime_output',
      'dependency_output',
      'generated_value',
    ]);
    expect(caseObj.steps[0].value).toBe('Alice');
    expect(caseObj.steps[1].value).toBe('Authored-Secret-1!');
    expect(caseObj.steps[1].valueBinding.reference).toBe('env:QAAI_PASSWORD');
  });

  it('routes both generation surfaces through the same compiler source contract', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/scenarios.js'), 'utf8');
    expect(source).toContain("inlineSourceSurface: appendToCurrent ? 'add_scenario' : 'initial_upload'");
  });
});
