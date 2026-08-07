#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildDocumentUnderstanding, classifyTestability, classifyTestType } = require('../server/services/documentUnderstanding');

let pass = 0;
function ok(condition, message, detail) {
  assert.ok(condition, detail || message);
  pass += 1;
  console.log(`✓ ${message}`);
}

function byKey(list) {
  return new Map((list || []).map((x) => [x.key, x]));
}

const documents = [
  {
    id: 'doc-brd',
    name: 'OrangeHRM_BRD.docx',
    category: 'brd',
    content: `
1. Admin Module
The Admin user must create users, roles, jobs, organization details, and qualifications.

2. PIM Module
The HR user can add employee records, search the employee list, update personal details, and delete inactive employees.

3. Leave Module
The employee user can apply leave and the manager user can approve or reject leave requests.

4. Reports
The Admin user can export employee reports to CSV.
`,
  },
  {
    id: 'doc-us',
    name: 'OrangeHRM_UserStories.docx',
    category: 'user-stories',
    content: `
Authentication
As an Admin user I can login with username and password and land on the dashboard.
As an ESS user I can login and view only my allowed menu items.

PIM Module
As an HR user I want to create a new employee using first name, last name, and employee id.
Invalid mandatory fields should display validation messages.
OTP login must be manually reviewed when enabled by the identity provider.
`,
  },
];

const requirementClauses = [
  {
    id: 'REQ-auth',
    sourceType: 'USER_STORY',
    behaviourText: 'As an Admin user I can login with username and password and land on the dashboard.',
    excerpt: 'As an Admin user I can login with username and password and land on the dashboard.',
  },
  {
    id: 'REQ-pim-create',
    sourceType: 'BRD',
    behaviourText: 'The HR user can add employee records, search the employee list, update personal details, and delete inactive employees.',
    excerpt: 'The HR user can add employee records, search the employee list, update personal details, and delete inactive employees.',
  },
  {
    id: 'REQ-ess-login',
    sourceType: 'USER_STORY',
    behaviourText: 'As an ESS user I can login and view only my allowed menu items.',
    excerpt: 'As an ESS user I can login and view only my allowed menu items.',
  },
  {
    id: 'REQ-pim-validation',
    sourceType: 'USER_STORY',
    behaviourText: 'Invalid mandatory fields should display validation messages.',
    excerpt: 'Invalid mandatory fields should display validation messages.',
  },
  {
    id: 'REQ-download',
    sourceType: 'BRD',
    behaviourText: 'The Admin user can export employee reports to CSV.',
    excerpt: 'The Admin user can export employee reports to CSV.',
  },
  {
    id: 'REQ-otp',
    sourceType: 'USER_STORY',
    behaviourText: 'OTP login must be manually reviewed when enabled by the identity provider.',
    excerpt: 'OTP login must be manually reviewed when enabled by the identity provider.',
  },
];

const testDataSets = [
  {
    id: 'td-1',
    name: 'OrangeHRM_TestData.xlsx',
    rowCount: 9,
    sheetsJson: JSON.stringify({
      sheets: [
        { name: 'AuthProfiles', headers: ['authRole', 'username', 'password', 'expectedLandingPage'], rows: [{}, {}] },
        { name: 'PIMSearch', headers: ['employeeName', 'employeeId', 'expectedResult'], rows: [{}, {}] },
      ],
    }),
    mappingJson: null,
  },
];

const understanding = buildDocumentUnderstanding({
  project: { id: 'p1', name: 'OrangeHRM', targetUrl: 'https://opensource-demo.orangehrmlive.com' },
  documents,
  requirementClauses,
  testDataSets,
  scenarios: [],
  calibrations: [],
});

console.log('\n[1] Contract shape');
ok(understanding.version === 1, 'understanding has version 1');
ok(understanding.readiness.status === 'ready_for_test_data', 'ready_for_test_data once docs expose modules + data needs');
ok(understanding.readiness.nextAction.includes('TestData'), 'next action asks for TestData before generation');
ok(understanding.summary.documentCount === 2, 'document count surfaced');
ok(understanding.summary.requirementItemCount === requirementClauses.length, 'uses RequirementClause rows when available');

console.log('\n[2] Modules + data needs');
const modules = byKey(understanding.modules);
ok(modules.has('auth'), 'detects Authentication/Login module');
ok(modules.has('pim'), 'detects PIM module');
ok(modules.has('admin'), 'detects Admin module');
ok(modules.get('auth').dataNeeds.some((n) => n.key === 'auth_credentials'), 'auth module asks for credentials data');
ok(modules.get('pim').dataNeeds.some((n) => n.key === 'search_criteria'), 'PIM module asks for search criteria data');
ok(modules.get('pim').dataNeeds.some((n) => n.key === 'create_update_fields'), 'PIM module asks for create/update rows');
ok(understanding.dataNeeds.some((n) => n.key === 'validation_rows'), 'negative/validation data need detected');
ok(understanding.dataNeeds.some((n) => n.key === 'download_expectation'), 'download/export data need detected');

console.log('\n[3] Roles + entities');
const roles = byKey(understanding.roles);
const entities = byKey(understanding.entities);
ok(roles.has('admin'), 'extracts Admin role');
ok(roles.has('hr'), 'extracts HR role');
ok(roles.has('ess'), 'extracts ESS role');
ok(entities.has('employee-records') || entities.has('employee'), 'extracts employee business entity');
ok(entities.has('employee-reports') || entities.has('report'), 'extracts report/download entity');

console.log('\n[4] Testability classification');
ok(understanding.testability.automatableCount >= 3, 'automatable behaviours counted');
ok(understanding.testability.needsReviewCount >= 1, 'OTP/external identity is needs-review, not silently treated as normal');
ok(classifyTestability({ text: 'This must be manual only and visually inspected.' }).disposition === 'not_automatable', 'manual-only text is not automatable');
ok(classifyTestType('Invalid mandatory fields should show error messages.').includes('negative'), 'negative test type detected');

console.log('\n[5] Empty project readiness');
const empty = buildDocumentUnderstanding({ documents: [] });
ok(empty.readiness.status === 'needs_documents', 'empty project asks for documents first');
ok(empty.readiness.blockers.length >= 1, 'empty project explains blocker');

console.log('\n[6] Route wiring');
const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'requirements.js'), 'utf8');
ok(/buildDocumentUnderstanding/.test(routeSrc), 'requirements route imports document understanding service');
ok(/router\.get\('\/understanding'/.test(routeSrc), 'requirements route exposes /understanding endpoint');
ok(/requireAuth/.test(routeSrc) && /requireOrg/.test(routeSrc), 'understanding endpoint stays behind auth + org middleware');
ok(/orgId:\s*req\.org\.id/.test(routeSrc), 'project lookup remains org-scoped');

console.log('\n[7] Run Suite UI wiring');
const runSuiteSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'RunSuite.jsx'), 'utf8');
ok(/requirements\/understanding/.test(runSuiteSrc), 'RunSuite fetches document understanding before TestData mapping');
ok(/DocumentUnderstandingPanel/.test(runSuiteSrc), 'RunSuite renders a document understanding panel');
ok(/Ready for TestData/.test(runSuiteSrc), 'understanding panel tells the user when docs are ready for TestData');
ok(/TestData QAAI will ask for/.test(runSuiteSrc), 'understanding panel shows data needs before generation');

console.log(`\nPASS verify_document_understanding.cjs (${pass} checks)`);
