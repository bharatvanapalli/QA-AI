#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  understandWorkbook,
  classifyPurpose,
  detectSensitivity,
  isNonExecutableSheet,
} = require('../server/services/testDataUnderstanding');

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

const documentUnderstanding = {
  summary: {
    moduleCount: 2,
    dataNeedCount: 4,
    status: 'ready_for_test_data',
  },
  modules: [
    {
      key: 'pim',
      name: 'PIM',
      dataNeeds: [
        { key: 'search_criteria', fields: ['employeeName', 'employeeId', 'employmentStatus'] },
        { key: 'create_update_fields', fields: ['firstName', 'lastName', 'employeeId', 'jobTitle'] },
        { key: 'validation_rows', fields: ['firstName', 'lastName', 'expectedError'] },
      ],
      sourceEvidence: [{ text: 'PIM employee records can be searched, created, edited, and deleted.' }],
    },
    {
      key: 'leave',
      name: 'Leave',
      dataNeeds: [{ key: 'download_expectation', fields: ['reportType', 'fileName'] }],
      sourceEvidence: [{ text: 'Leave module exports reports.' }],
    },
  ],
  entities: [
    { key: 'employee', name: 'Employee' },
    { key: 'employee_id', name: 'Employee ID' },
  ],
  dataNeeds: [
    { fields: ['username', 'password', 'authRole'] },
    { fields: ['employeeName', 'employeeId', 'jobTitle'] },
  ],
};

const sheets = [
  {
    name: 'AuthProfiles',
    headers: ['testCaseID', 'authRole', 'username', 'password', 'sensitivity', 'expectedLandingPage', 'notes'],
    rows: [
      { testCaseID: 'TC-AUTH-01', authRole: 'admin', username: 'Admin', password: 'admin123', sensitivity: 'MASKED', expectedLandingPage: 'Dashboard', notes: 'valid admin' },
      { testCaseID: 'TC-AUTH-02', authRole: 'ess', username: 'ess_user_01', password: 'Secret@123', sensitivity: 'MASKED', expectedLandingPage: 'My Info', notes: 'valid ess' },
    ],
  },
  {
    name: 'PIMSearch',
    headers: ['caseId', 'Employee Name', 'Employee ID', 'Employment Status', 'Expected Result'],
    rows: [
      { caseId: 'TC-PIM-01', 'Employee Name': 'Linda Anderson', 'Employee ID': '0101', 'Employment Status': 'Full-Time', 'Expected Result': 'employee row visible' },
    ],
  },
  {
    name: 'CRUDData',
    headers: ['testCaseID', 'First Name', 'Last Name', 'Employee ID', 'Job Title', 'Expected Status'],
    rows: [
      { testCaseID: 'TC-PIM-02', 'First Name': 'Bharat', 'Last Name': 'QA', 'Employee ID': '9001', 'Job Title': 'QA Analyst', 'Expected Status': 'Saved' },
    ],
  },
  {
    name: 'FormValidation',
    headers: ['caseType', 'First Name', 'Last Name', 'Expected Error'],
    rows: [
      { caseType: 'negative', 'First Name': '', 'Last Name': 'QA', 'Expected Error': 'First Name is required' },
    ],
  },
  {
    name: 'Downloads',
    headers: ['reportType', 'fileName', 'Expected File'],
    rows: [
      { reportType: 'Employee list', fileName: 'employees.csv', 'Expected File': 'employees.csv' },
    ],
  },
  {
    name: 'README',
    headers: ['Field', 'Description'],
    rows: [
      { Field: 'username', Description: 'Use the Username column from AuthProfiles' },
      { Field: 'password', Description: 'Sensitive values should be masked' },
    ],
  },
];

const result = understandWorkbook({ sheets, documentUnderstanding });
const mapping = result.mapping;
const bySheet = new Map(mapping.bindings.map((b) => [b.sheet, b]));

check('understandWorkbook returns version 2 mapping', mapping.version === 2);
check('mapping strategy is pre-generation document-aware', mapping.strategy === 'pre_generation_document_aware');
check('one binding is created per executable sheet', mapping.bindings.length === sheets.length - 1);
check('understanding summary is embedded in mapping', mapping.understanding?.sheetCount === sheets.length);
check('README sheet is ignored, not bound', !bySheet.has('README') && mapping.ignoredSheets?.some((x) => x.sheet === 'README'));

const auth = bySheet.get('AuthProfiles');
check('AuthProfiles classified as auth profiles', auth?.purpose === 'auth_profiles');
check('AuthProfiles is shared auth module', auth?.moduleKey === 'auth');
check('authRole maps to role', auth?.columnToField?.role === 'authRole');
check('username maps to username', auth?.columnToField?.username === 'username');
check('password maps to password', auth?.columnToField?.password === 'password');
check('password defaults masked', auth?.sensitivity?.password === 'masked');
check('expectedLandingPage becomes expected column', auth?.expectedColumn === 'expectedLandingPage');
check('testCaseID and notes are ignored metadata', (auth?.ignoredColumns || []).some((x) => x.header === 'testCaseID') && (auth?.ignoredColumns || []).some((x) => x.header === 'notes'));

const search = bySheet.get('PIMSearch');
check('PIMSearch classified as search data', search?.purpose === 'search_data');
check('PIMSearch maps to PIM module', search?.moduleKey === 'pim');
check('Employee Name maps to fullName', search?.columnToField?.fullName === 'Employee Name');
check('Employee ID maps to employeeId', search?.columnToField?.employeeId === 'Employee ID');
check('Expected Result becomes expected column', search?.expectedColumn === 'Expected Result');

const crud = bySheet.get('CRUDData');
check('CRUDData classified as CRUD data', crud?.purpose === 'crud_data');
check('CRUDData maps create fields', crud?.columnToField?.firstName === 'First Name' && crud?.columnToField?.lastName === 'Last Name');
check('Job Title maps to jobTitle', crud?.columnToField?.jobTitle === 'Job Title');

const validation = bySheet.get('FormValidation');
check('FormValidation classified as validation cases', validation?.purpose === 'validation_cases');
check('caseType is row class column', validation?.rowClassColumn === 'caseType');
check('Expected Error becomes expected column', validation?.expectedColumn === 'Expected Error');
check('row class summary counts negative rows', validation?.rowClassSummary?.values?.some((x) => x.value === 'negative' && x.count === 1));

const downloads = bySheet.get('Downloads');
check('Downloads classified as download expectations', downloads?.purpose === 'download_expectations');
check('Expected File becomes expected column', downloads?.expectedColumn === 'Expected File');

check('classifyPurpose detects auth by username/password headers', classifyPurpose(sheets[0]) === 'auth_profiles');
check('classifyPurpose ignores README/instruction sheets', classifyPurpose(sheets[5]) === 'non_executable_metadata' && isNonExecutableSheet(sheets[5]));
check('detectSensitivity restricts email-like samples', detectSensitivity('email', 'Email', { rows: [{ Email: 'a@example.com' }] }) === 'restricted');

const root = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const routeSource = read('server/routes/testData.js');
check('upload route auto-maps parsed workbook', routeSource.includes('understandWorkbook({ sheets: parsed.sheets, documentUnderstanding })'));
check('upload route persists auto mapping', routeSource.includes('mappingJson: JSON.stringify(understood.mapping)'));
check('remap route can run without existing scenarios', routeSource.includes('let mapping = understood.mapping'));
check('manual save preserves mapping metadata', routeSource.includes('...mapping') && routeSource.includes('bindings: mapping.bindings'));

const contextSource = read('server/services/testDataContext.js');
check('testDataContext preserves workbook understandings', contextSource.includes('const understandings = []') && contextSource.includes('understandings.push'));
check('draft context returns understandings', contextSource.includes('bindings, unmapped, understandings'));

const architectSource = read('server/services/agents/architect.js');
check('Architect receives document-aware workbook rules', architectSource.includes('DOCUMENT-AWARE WORKBOOK RULES'));
check('Architect sees sheet purpose and module key', architectSource.includes('Purpose: ${b.purpose}') && architectSource.includes('Module key: ${b.moduleKey}'));
check('Architect tells model to use role placeholders', architectSource.includes('Map placeholders to field roles from columnToField'));

const runSuiteSource = read('src/pages/RunSuite.jsx');
check('Run Suite renders TestDataUnderstandingSummary', runSuiteSource.includes('function TestDataUnderstandingSummary'));
check('Run Suite reads dataset.testDataUnderstanding', runSuiteSource.includes('dataset.testDataUnderstanding'));
check('cloneMapping preserves understanding metadata', runSuiteSource.includes('...mapping') && runSuiteSource.includes('version: mapping.version || 1'));

if (failures) {
  console.error(`FAIL — ${failures}/${checks} checks failed`);
  process.exit(1);
}

console.log(`PASS — ${checks}/${checks} TestData understanding checks`);
