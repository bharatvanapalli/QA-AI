import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const generationCompiler = require('../../server/services/generationCompiler');
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');

const INLINE_FLOW = `
Requirement Title: Review a work queue with an authenticated user

Inline test data:
Email Address: inline.user@example.test
Password: Authored-Credential-9!
Expected Banner: Ready for review

Test Case: Open the assigned work queue

Test steps:
1. Enter inline.user@example.test in the Email Address field.
2. Enter Authored-Credential-9! in the Password field.
3. Verify Ready for review is visible.

Final validation:
Verify Ready for review is visible.
`;

function proceduralContract(source = 'uploaded_requirement') {
  return proceduralFlowContract.extractProceduralFlowContract([{
    id: `${source}:work-queue`,
    source,
    title: 'Work queue flow',
    content: INLINE_FLOW,
  }]);
}

function inlineCandidate(dataBinding = {
  source: 'inline_requirement_text',
  matchKind: 'inline_values',
  inlineValues: { email: 'inline.user@example.test' },
}) {
  return [{
    name: 'Work queue',
    module: 'Queue',
    cases: [{
      name: 'Open queue for {{email}}',
      type: 'functional',
      confidence: 90,
      automatability: 'automatable',
      assertions: 'Verify {{expected_banner}} is visible.',
      dataBinding,
      steps: [
        { action: 'Fill', element: 'Email Address', value: '{{email}}' },
        { action: 'Fill', element: 'Password', value: '{{password}}' },
        { action: 'Verify', element: 'Queue banner', expected: '{{expected_banner}}' },
      ],
      declaredAssertions: [{
        id: 'ASN-queue-banner',
        type: 'TEXT',
        criticality: 'must',
        payload: { expectedText: '{{expected_banner}}' },
      }],
    }],
  }];
}

function visibleCaseFields(caseObj) {
  return {
    name: caseObj.name,
    assertions: caseObj.assertions,
    steps: caseObj.steps,
    declaredAssertions: caseObj.declaredAssertions,
  };
}

describe('generation compiler inline literal boundary', () => {
  it.each([
    ['initial uploaded procedural text', 'uploaded_requirement'],
    ['Add Scenario procedural text', 'add_scenario'],
  ])('keeps all authored inline values literal for %s', (_label, source) => {
    const compiled = generationCompiler.compileGeneration({
      scenarios: inlineCandidate(),
      proceduralFlowContract: proceduralContract(source),
      testData: null,
      atlasHasCapabilities: false,
    });

    const compiledCase = compiled.scenarios[0].cases[0];
    const visible = JSON.stringify(visibleCaseFields(compiledCase));
    expect(visible).toContain('inline.user@example.test');
    expect(visible).toContain('Authored-Credential-9!');
    expect(visible).toContain('Ready for review');
    expect(visible).not.toMatch(/\{\{\s*(?:email|password|expected_banner)\s*\}\}/i);
    expect(compiledCase.dataBinding).toBeNull();
  });

  it('tokenizes only when this case sheet is present in both mapping and sheets', () => {
    const source = `
Inline test data:
Search Term: Alice

Test Case: Search the employee directory
Test steps:
1. Enter Alice in the Search Term field.
2. Verify Results is visible.
`;
    const contract = proceduralFlowContract.extractProceduralFlowContract([{
      id: 'uploaded_requirement:employee-search',
      source: 'uploaded_requirement',
      content: source,
    }]);
    const candidate = () => [{
      name: 'Employee search',
      module: 'Directory',
      cases: [{
        name: 'Search for Alice',
        type: 'functional',
        confidence: 90,
        automatability: 'automatable',
        assertions: 'Results is visible.',
        dataBinding: {
          sheet: 'SearchRows',
          status: 'complete',
          columnToField: { search_term: 'Search Term' },
        },
        steps: [
          { action: 'Fill', element: 'Search Term', value: 'Alice' },
          { action: 'Verify', element: 'Results', expected: 'Results is visible.' },
        ],
        declaredAssertions: [{
          id: 'ASN-results',
          type: 'TEXT',
          criticality: 'must',
          payload: { expectedText: 'Results' },
        }],
      }],
    }];
    const sheets = [{ name: 'SearchRows', headers: ['Search Term'], rows: [{ 'Search Term': 'Alice' }] }];
    const mapping = { bindings: [{ sheet: 'SearchRows', columnToField: { search_term: 'Search Term' } }] };

    const mappingOnly = generationCompiler.compileGeneration({
      scenarios: candidate(),
      proceduralFlowContract: contract,
      testData: { mapping, sheets: [] },
    }).scenarios[0].cases[0];
    expect(mappingOnly.steps[0].value).toBe('Alice');
    expect(mappingOnly.dataBinding).toBeNull();

    const sheetsOnly = generationCompiler.compileGeneration({
      scenarios: candidate(),
      proceduralFlowContract: contract,
      testData: { mapping: { bindings: [] }, sheets },
    }).scenarios[0].cases[0];
    expect(sheetsOnly.steps[0].value).toBe('Alice');
    expect(sheetsOnly.dataBinding).toBeNull();

    const emptySheet = generationCompiler.compileGeneration({
      scenarios: candidate(),
      proceduralFlowContract: contract,
      testData: { mapping, sheets: [{ name: 'SearchRows', headers: ['Search Term'], rows: [] }] },
    }).scenarios[0].cases[0];
    expect(emptySheet.steps[0].value).toBe('Alice');
    expect(emptySheet.dataBinding).toBeNull();

    const emptyRow = generationCompiler.compileGeneration({
      scenarios: candidate(),
      proceduralFlowContract: contract,
      testData: { mapping, sheets: [{ name: 'SearchRows', headers: ['Search Term'], rows: [{}] }] },
    }).scenarios[0].cases[0];
    expect(emptyRow.steps[0].value).toBe('Alice');
    expect(emptyRow.dataBinding).toBeNull();

    const unusableMapping = generationCompiler.compileGeneration({
      scenarios: candidate(),
      proceduralFlowContract: contract,
      testData: {
        mapping: { bindings: [{ sheet: 'SearchRows', columnToField: {} }] },
        sheets,
      },
    }).scenarios[0].cases[0];
    expect(unusableMapping.steps[0].value).toBe('Alice');
    expect(unusableMapping.dataBinding).toBeNull();

    const provenWorkbook = generationCompiler.compileGeneration({
      scenarios: candidate(),
      proceduralFlowContract: contract,
      testData: { mapping, sheets },
    }).scenarios[0].cases[0];
    expect(provenWorkbook.steps[0].value).toBe('{{search_term}}');
    expect(provenWorkbook.dataBinding.sheet).toBe('SearchRows');
  });

  it('keeps repeated inline labels isolated to their own explicit case', () => {
    const source = `
Test Case: Sign in with the first account
Inline test data:
Email Address: first.user@example.test
Password: First-Credential-1!
Test steps:
1. Enter first.user@example.test in the Email Address field.
2. Enter First-Credential-1! in the Password field.
3. Verify First workspace is visible.

Test Case: Sign in with the second account
Inline test data:
Email Address: second.user@example.test
Password: Second-Credential-2!
Test steps:
1. Enter second.user@example.test in the Email Address field.
2. Enter Second-Credential-2! in the Password field.
3. Verify Second workspace is visible.
`;
    const contract = proceduralFlowContract.extractProceduralFlowContract([{
      id: 'uploaded_requirement:two-accounts',
      source: 'uploaded_requirement',
      content: source,
    }]);
    const candidateCase = (name, workspace) => ({
      name,
      type: 'functional',
      confidence: 90,
      automatability: 'automatable',
      assertions: `Verify ${workspace} is visible.`,
      steps: [
        { action: 'Fill', element: 'Email Address', value: '{{email}}' },
        { action: 'Fill', element: 'Password', value: '{{password}}' },
        { action: 'Verify', element: 'Workspace', expected: `${workspace} is visible.` },
      ],
      declaredAssertions: [{
        id: `ASN-${workspace}`,
        type: 'TEXT',
        criticality: 'must',
        payload: { expectedText: workspace },
      }],
    });
    const compiled = generationCompiler.compileGeneration({
      scenarios: [{
        name: 'Two account sign-ins',
        module: 'Authentication',
        cases: [
          candidateCase('Sign in with the first account', 'First workspace'),
          candidateCase('Sign in with the second account', 'Second workspace'),
        ],
      }],
      proceduralFlowContract: contract,
      testData: null,
    });

    const [first, second] = compiled.scenarios[0].cases;
    expect(first.steps.map((step) => step.value).filter(Boolean)).toEqual([
      'first.user@example.test',
      'First-Credential-1!',
    ]);
    expect(second.steps.map((step) => step.value).filter(Boolean)).toEqual([
      'second.user@example.test',
      'Second-Credential-2!',
    ]);
    expect(JSON.stringify(first)).not.toContain('second.user@example.test');
    expect(JSON.stringify(second)).not.toContain('first.user@example.test');
  });

  it('does not shift a repeated equal value into the following explicit case', () => {
    const source = `
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
`;
    const contract = proceduralFlowContract.extractProceduralFlowContract([{
      id: 'uploaded_requirement:repeated-tier',
      source: 'uploaded_requirement',
      content: source,
    }]);
    const candidateCase = (name) => ({
      name,
      type: 'functional',
      confidence: 90,
      automatability: 'automatable',
      assertions: 'Verify Account Tier.',
      steps: [{ action: 'Verify', element: 'Account Tier', expected: '{{account_tier}}' }],
      declaredAssertions: [],
    });
    const compiled = generationCompiler.compileGeneration({
      scenarios: [{
        name: 'Account tiers',
        module: 'Accounts',
        cases: [candidateCase('First account'), candidateCase('Second account'), candidateCase('Third account')],
      }],
      proceduralFlowContract: contract,
      testData: null,
    });
    expect(compiled.scenarios[0].cases.map((item) => item.steps[0].expected)).toEqual([
      'Shared',
      'Shared',
      'Restricted',
    ]);
  });

  it.each([
    ['initial uploaded procedural text', 'uploaded_requirement'],
    ['Add Scenario procedural text', 'add_scenario'],
  ])('keeps the selected inline-data block authoritative over later contradictory literals for %s', (_label, sourceKind) => {
    const source = `
Inline test data:
Expected Queue Count: 12
Expected Queue Status: Ready

Test Case: Validate the queue summary
Test steps:
1. Verify Expected Queue Count = 9.
2. Verify Expected Queue Status: Pending.
`;
    const contract = proceduralFlowContract.extractProceduralFlowContract([{
      id: `${sourceKind}:queue-summary`,
      source: sourceKind,
      content: source,
    }]);
    const compiled = generationCompiler.compileGeneration({
      scenarios: [{
        name: 'Queue summary',
        module: 'Queue',
        cases: [{
          name: 'Validate the queue summary',
          type: 'functional',
          confidence: 90,
          automatability: 'automatable',
          assertions: 'Expected Queue Count = 9; Expected Queue Status: Pending',
          steps: [
            { action: 'Verify', element: 'Expected Queue Count', expected: '9' },
            { action: 'Verify', element: 'Expected Queue Status', expected: 'Pending' },
          ],
          declaredAssertions: [
            { id: 'ASN-count', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Expected Queue Count = 9' } },
            { id: 'ASN-status', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Expected Queue Status: Pending' } },
          ],
        }],
      }],
      proceduralFlowContract: contract,
      testData: null,
    }).scenarios[0].cases[0];

    expect(compiled.assertions).toBe('Expected Queue Count = 12; Expected Queue Status: Ready');
    expect(compiled.steps.map((step) => step.expected)).toEqual(['12', 'Ready']);
    expect(compiled.declaredAssertions.map((assertion) => assertion.payload.expectedText)).toEqual([
      'Expected Queue Count = 12',
      'Expected Queue Status: Ready',
    ]);
  });
});
