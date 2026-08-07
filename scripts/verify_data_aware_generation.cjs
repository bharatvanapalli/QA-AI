#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  markDataAwareCases,
  placeholdersInCase,
  bindingsFor,
} = require('../server/services/testDataAuthoring');
const storyDataAlignment = require('../server/services/storyDataAlignment');
const testCaseContract = require('../server/services/testCaseContract');
const architect = require('../server/services/agents/architect');

let checks = 0;
let failures = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

const testData = {
  sheets: [
    {
      name: 'PIMSearch',
      headers: ['Employee Name', 'Employee ID', 'Expected Result'],
      rows: [{ 'Employee Name': 'Linda Anderson', 'Employee ID': '0101', 'Expected Result': 'employee row visible' }],
    },
    {
      name: 'FormValidation',
      headers: ['caseType', 'First Name', 'Expected Error'],
      rows: [{ caseType: 'negative', 'First Name': '', 'Expected Error': 'First Name is required' }],
    },
    {
      name: 'CRUDData',
      headers: ['First Name', 'Last Name', 'Expected Status'],
      rows: [{ 'First Name': 'Bharat', 'Last Name': 'QA', 'Expected Status': 'Saved' }],
    },
  ],
  mapping: {
    version: 2,
    bindings: [
      {
        sheet: 'PIMSearch',
        module: 'PIM',
        moduleKey: 'pim',
        purpose: 'search_data',
        columnToField: { fullName: 'Employee Name', employeeId: 'Employee ID' },
        expectedColumn: 'Expected Result',
        confidence: 'high',
      },
      {
        sheet: 'FormValidation',
        module: 'PIM',
        moduleKey: 'pim',
        purpose: 'validation_cases',
        columnToField: { firstName: 'First Name' },
        expectedColumn: 'Expected Error',
        rowClassColumn: 'caseType',
        confidence: 'high',
      },
      {
        sheet: 'CRUDData',
        module: 'PIM',
        moduleKey: 'pim',
        purpose: 'crud_data',
        columnToField: { firstName: 'First Name', lastName: 'Last Name' },
        expectedColumn: 'Expected Status',
        confidence: 'high',
      },
    ],
    unmapped: [],
  },
};

const parsed = [
  {
    name: 'PIM',
    module: 'pim',
    cases: [
      {
        name: 'Search employee by uploaded data',
        type: 'functional',
        assertions: 'Employee row shows {{expected}}',
        steps: [
          { order: 1, action: 'Fill', element: 'Employee Name', value: '{{fullName}}' },
          { order: 2, action: 'Fill', element: 'Employee ID', value: '{{employeeId}}' },
          { order: 3, action: 'Click', element: 'Search' },
        ],
        declaredAssertions: [
          { type: 'TEXT', criticality: 'must', payload: { expectedText: '{{expected}}' } },
        ],
      },
      {
        name: 'Negative first-name validation',
        type: 'boundary',
        assertions: 'validation error appears',
        dataBinding: { sheet: 'FormValidation' },
        steps: [
          { order: 1, action: 'Fill', element: 'First Name', value: '{{firstName}}' },
          { order: 2, action: 'Click', element: 'Save' },
        ],
        declaredAssertions: [
          { type: 'TEXT', criticality: 'must', payload: { expectedText: 'Required' } },
        ],
      },
      {
        name: 'Bad binding sheet is visible',
        type: 'functional',
        dataBinding: { sheet: 'DoesNotExist' },
        steps: [{ order: 1, action: 'Fill', element: 'Name', value: '{{firstName}}' }],
        declaredAssertions: [{ type: 'TEXT', criticality: 'must', payload: { expectedText: '{{expected}}' } }],
      },
    ],
  },
];

const requirementClauses = [
  {
    id: 'REQ-PIM-SEARCH',
    sourceType: 'USER_STORY',
    moduleHint: 'PIM',
    behaviourText: 'PIM employee records can be searched by employee name and employee id.',
  },
  {
    id: 'REQ-PIM-VALIDATION',
    sourceType: 'BRD',
    moduleHint: 'PIM',
    behaviourText: 'PIM employee creation requires first name and displays a validation error when missing.',
  },
  {
    id: 'REQ-LEAVE-DOWNLOAD',
    sourceType: 'BRD',
    moduleHint: 'Leave',
    behaviourText: 'Leave report data can be downloaded by managers.',
  },
];

check('bindingsFor returns mapping bindings', bindingsFor(testData).length === 3);
check('placeholdersInCase extracts role tokens', placeholdersInCase(parsed[0].cases[0]).sort().join(',') === 'employeeId,expected,fullName');

const stats = markDataAwareCases(parsed, testData, { moduleScope: 'pim' });
const searchCase = parsed[0].cases[0];
const validationCase = parsed[0].cases[1];
const badCase = parsed[0].cases[2];

check('placeholder-matched case is auto-bound', searchCase.dataBinding?.sheet === 'PIMSearch');
check('auto-bound case is complete', searchCase.dataBinding?.status === 'complete');
check('auto-bound case carries expectedColumn', searchCase.dataBinding?.expectedColumn === 'Expected Result');
check('auto-bound case carries columnToField', searchCase.dataBinding?.columnToField?.fullName === 'Employee Name');
check('auto-bound case records source', searchCase.dataBinding?.source === 'placeholder_match');

check('explicit binding is hydrated', validationCase.dataBinding?.sheet === 'FormValidation');
check('explicit binding preserves rowClassColumn', validationCase.dataBinding?.rowClassColumn === 'caseType');
check('missing expected placeholder marks binding incomplete', validationCase.dataBinding?.status === 'incomplete');
check('missing expected placeholder finding is specific', validationCase.dataBinding?.findings?.some((f) => f.code === 'data_expected_placeholder_missing'));
check('negative validation gets rowSelector', validationCase.dataBinding?.rowSelector === 'negative');

check('invalid explicit sheet is incomplete', badCase.dataBinding?.status === 'incomplete');
check('invalid explicit sheet finding is specific', badCase.dataBinding?.findings?.some((f) => f.code === 'data_binding_sheet_not_found'));

check('stats count assigned cases', stats.assigned === 1);
check('stats count hydrated explicit bindings', stats.hydrated === 1);
check('stats count incomplete bindings', stats.incomplete === 2);
check('stats reports uncovered relevant sheets', stats.uncoveredSheets.some((s) => s.sheet === 'CRUDData'));

const normalised = architect.normaliseCase(searchCase);
check('normaliseCase preserves dataBinding status', normalised.dataBinding?.status === 'complete');
check('normaliseCase preserves placeholders', normalised.dataBinding?.placeholders?.includes('fullName'));
check('normaliseCase preserves expectedColumn', normalised.dataBinding?.expectedColumn === 'Expected Result');

const block = architect.buildTestDataBlock(testData);
check('Architect data block includes document-aware workbook rules', /DOCUMENT-AWARE WORKBOOK RULES/.test(block));
check('Architect data block requires non-auth data-driven cases', /For every non-auth sheet relevant/.test(block));
check('Architect data block instructs role placeholders', /field roles from columnToField/.test(block));

const alignmentIndex = storyDataAlignment.buildStoryDataAlignmentIndex(testData, requirementClauses, { moduleScope: 'pim' });
const searchAlignment = alignmentIndex.find((row) => row.sheet === 'PIMSearch');
check('story/data index aligns search sheet to search requirement', searchAlignment?.alignedRequirementRefs?.includes('REQ-PIM-SEARCH'));
const storyBlock = storyDataAlignment.buildStoryDataAlignmentBlock({ testData, requirementClauses, moduleScope: 'pim' });
check('Architect story-data block is emitted when clauses exist', /STORY-DATA ALIGNMENT CONTRACT/.test(storyBlock || ''));
check('Architect story-data block lists aligned requirement refs', /REQ-PIM-SEARCH/.test(storyBlock || ''));

const alignedScenarios = [
  {
    name: 'PIM',
    module: 'pim',
    cases: [
      {
        name: 'Aligned employee search',
        type: 'functional',
        requirementRefs: ['REQ-PIM-SEARCH'],
        steps: [
          { order: 1, action: 'Fill', element: 'Employee Name', value: '{{fullName}}' },
          { order: 2, action: 'Fill', element: 'Employee ID', value: '{{employeeId}}' },
          { order: 3, action: 'Click', element: 'Search' },
        ],
        declaredAssertions: [
          { type: 'TEXT', criticality: 'must', requirementRefs: ['REQ-PIM-SEARCH'], payload: { expectedText: '{{expected}}' } },
        ],
      },
    ],
  },
];
markDataAwareCases(alignedScenarios, testData, { moduleScope: 'pim' });
const alignedStats = storyDataAlignment.validateScenarioDataAlignment(alignedScenarios, testData, requirementClauses, { moduleScope: 'pim' });
const alignedCase = alignedScenarios[0].cases[0];
check('story/data aligned case remains complete', alignedCase.dataBinding?.status === 'complete');
check('story/data aligned case records aligned refs', alignedCase.dataBinding?.alignedRequirementRefs?.includes('REQ-PIM-SEARCH'));
check('story/data aligned stats have no mismatches', alignedStats.mismatchedCases === 0 && alignedStats.missingRefs === 0);
const normalisedAligned = architect.normaliseCase(alignedCase);
check('normaliseCase preserves aligned requirement refs', normalisedAligned.dataBinding?.alignedRequirementRefs?.includes('REQ-PIM-SEARCH'));
check('normaliseCase preserves alignment score', typeof normalisedAligned.dataBinding?.alignmentScore === 'number');

const mismatchedScenarios = [
  {
    name: 'PIM',
    module: 'pim',
    cases: [
      {
        name: 'Misbound employee search',
        type: 'functional',
        requirementRefs: ['REQ-LEAVE-DOWNLOAD'],
        steps: [
          { order: 1, action: 'Fill', element: 'Employee Name', value: '{{fullName}}' },
          { order: 2, action: 'Click', element: 'Search' },
        ],
        declaredAssertions: [
          { type: 'TEXT', criticality: 'must', requirementRefs: ['REQ-LEAVE-DOWNLOAD'], payload: { expectedText: '{{expected}}' } },
        ],
      },
    ],
  },
];
markDataAwareCases(mismatchedScenarios, testData, { moduleScope: 'pim' });
const mismatchStats = storyDataAlignment.validateScenarioDataAlignment(mismatchedScenarios, testData, requirementClauses, { moduleScope: 'pim' });
const mismatchCase = mismatchedScenarios[0].cases[0];
check('story/data mismatched case is detected', mismatchStats.mismatchedCases === 1);
check('story/data mismatched case is incomplete', mismatchCase.dataBinding?.status === 'incomplete');
check('story/data mismatch finding is specific', mismatchCase.dataBinding?.findings?.some((f) => f.code === 'story_data_requirement_mismatch'));
const mismatchGate = testCaseContract.assertContractComplete({
  automatability: 'automatable',
  declaredAssertions: mismatchCase.declaredAssertions,
  dataBinding: mismatchCase.dataBinding,
});
check('contract gate blocks mismatched story/data binding', mismatchGate.violations.includes('data_binding_incomplete'));

const missingRefsScenarios = [
  {
    name: 'PIM',
    module: 'pim',
    cases: [
      {
        name: 'Untraced employee search',
        type: 'functional',
        steps: [
          { order: 1, action: 'Fill', element: 'Employee Name', value: '{{fullName}}' },
          { order: 2, action: 'Click', element: 'Search' },
        ],
        declaredAssertions: [
          { type: 'TEXT', criticality: 'must', payload: { expectedText: '{{expected}}' } },
        ],
      },
    ],
  },
];
markDataAwareCases(missingRefsScenarios, testData, { moduleScope: 'pim' });
const missingRefsStats = storyDataAlignment.validateScenarioDataAlignment(missingRefsScenarios, testData, requirementClauses, { moduleScope: 'pim' });
const missingRefsCase = missingRefsScenarios[0].cases[0];
check('story/data missing requirement refs are detected', missingRefsStats.missingRefs === 1);
check('story/data missing refs mark binding incomplete', missingRefsCase.dataBinding?.status === 'incomplete');
check('story/data missing refs finding is specific', missingRefsCase.dataBinding?.findings?.some((f) => f.code === 'story_data_requirement_ref_missing'));

const root = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
const architectSource = read('server/services/agents/architect.js');
check('architect imports testDataAuthoring', architectSource.includes("require('../testDataAuthoring')"));
check('architect calls markDataAwareCases before normalisation', architectSource.includes('testDataAuthoring.markDataAwareCases(parsed, testData'));
check('architect imports storyDataAlignment', architectSource.includes("require('../storyDataAlignment')"));
check('architect emits story-data alignment block', architectSource.includes('buildStoryDataAlignmentBlock'));
check('architect validates story-data alignment before normalisation', architectSource.includes('validateScenarioDataAlignment(parsed, testData, requirementClauses'));

if (failures) {
  console.error(`FAIL — ${failures}/${checks} checks failed`);
  process.exit(1);
}

console.log(`PASS — ${checks}/${checks} data-aware generation checks`);
