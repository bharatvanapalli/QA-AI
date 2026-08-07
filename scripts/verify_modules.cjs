#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { detectProjectModules, extractHeadingCandidates } = require('../server/services/moduleIntelligence');

let pass = 0;
function ok(condition, message, detail) {
  assert.ok(condition, detail || message);
  pass += 1;
  console.log(`✓ ${message}`);
}

function byKey(preview) {
  return new Map(preview.modules.map((m) => [m.key, m]));
}

const docs = [
  {
    id: 'doc-brd',
    name: 'OrangeHRM_BRD.docx',
    category: 'brd',
    content: `
1. Introduction
2. Admin Module
The admin user must create and maintain users, roles, jobs, organization details, and qualifications.
3. PIM Module
The HR user can add employee records, search the employee list, and update personal details.
4. Leave Module
The employee can apply leave and the manager can assign leave entitlements.
5. Recruitment Module
The recruiter can create vacancies, add candidates, shortlist candidates, and schedule interviews.
6. Business Requirements
These requirements should not become a fake module.
7. OrangeHRM The Story Belongs To
This is user-story boilerplate and must not become a fake module.
8. Application Modules In Scope
This section label is metadata and must not become a fake module.
`,
  },
  {
    id: 'doc-us',
    name: 'OrangeHRM_UserStories.docx',
    category: 'user-stories',
    content: `
Authentication
As an Admin user I can login with username and password and land on the dashboard.
PIM Module
As an HR user I can create a new employee and verify the employee appears in the list.
Leave Module
As an employee I can request leave for a date range.
Recruitment Module
As a recruiter I can update candidate interview status.
`,
  },
];

const testDataSets = [
  {
    id: 'td-1',
    name: 'OrangeHRM_TestData.xlsx',
    rowCount: 12,
    sheetsJson: JSON.stringify({
      sheets: [
        { name: 'LoginData', headers: ['username', 'password', 'role'], rows: [{}, {}] },
        { name: 'AdminUsers', headers: ['username', 'role', 'employeeName'], rows: [{}] },
        { name: 'EmployeeData', headers: ['firstName', 'lastName', 'employeeId'], rows: [{}, {}, {}] },
        { name: 'LeaveData', headers: ['leaveType', 'fromDate', 'toDate'], rows: [{}, {}] },
        { name: 'RecruitmentData', headers: ['candidateName', 'vacancy', 'interviewDate'], rows: [{}, {}] },
      ],
    }),
    mappingJson: JSON.stringify({
      version: 1,
      bindings: [
        { sheet: 'EmployeeData', module: 'PIM', columnToField: { firstName: 'firstName' } },
        { sheet: 'LeaveData', module: 'Leave', columnToField: { leaveType: 'leaveType' } },
      ],
      unmapped: [],
    }),
  },
];

const scenarios = [
  { id: 'scn-pim', name: 'Create employee', module: 'PIM' },
  { id: 'scn-admin', name: 'Create user role', module: 'Admin' },
];

const calibrations = [
  { id: 'cal-pim', module: 'pim', isCurrent: true, pagesCount: 8, version: 1, startUrl: 'https://example.test/pim' },
  { id: 'cal-leave', module: 'leave', isCurrent: true, pagesCount: 4, version: 1, startUrl: 'https://example.test/leave' },
];

console.log('\n[1] Heading extraction');
const headings = extractHeadingCandidates(docs[0].content).map((h) => h.name.toLowerCase());
ok(headings.includes('admin'), 'extracts Admin from "Admin Module"');
ok(headings.includes('pim'), 'extracts PIM from "PIM Module"');
ok(!headings.includes('business requirements'), 'does not treat generic Business Requirements heading as a module');
ok(!headings.includes('orangehrm the story belongs to'), 'drops story-boilerplate heading');
ok(!headings.includes('application modules in scope'), 'drops application-scope boilerplate heading');
const domainHeadings = extractHeadingCandidates('1. Claims Intake\nThe adjuster can create a claim intake record.\n2. Payment Reconciliation\nFinance can reconcile failed payments.').map((h) => h.name.toLowerCase());
ok(domainHeadings.includes('claims intake'), 'keeps domain-specific module heading: Claims Intake');
ok(domainHeadings.includes('payment reconciliation'), 'keeps domain-specific module heading: Payment Reconciliation');

console.log('\n[2] Module detection across docs + TestData + atlas');
const preview = detectProjectModules({ documents: docs, testDataSets, scenarios, calibrations });
const modules = byKey(preview);
ok(modules.has('auth'), 'detects Authentication/Login shared module');
ok(modules.has('admin'), 'detects Admin module');
ok(modules.has('pim'), 'detects PIM module');
ok(modules.has('leave'), 'detects Leave module');
ok(modules.has('recruitment'), 'detects Recruitment module');
ok(!modules.has('business-requirements'), 'does not create a generic business-requirements module');
ok(!modules.has('orangehrm-the-story-belongs-to'), 'does not create noisy story-belongs-to module');
ok(!modules.has('application-in-scope'), 'does not create noisy application-in-scope module');
ok(modules.get('auth').sourceEvidence.some((e) => /login|password|dashboard/i.test(e.text || '')), 'seeded auth module carries real document evidence');

console.log('\n[3] Counts and mapping signals');
ok(modules.get('auth').testData.sheetCount >= 1, 'LoginData sheet maps to Authentication');
ok(modules.get('pim').requirements.count >= 1, 'PIM receives requirement-like document evidence');
ok(modules.get('pim').testData.sheetCount >= 1, 'EmployeeData maps to PIM');
ok(modules.get('leave').testData.sheetCount >= 1, 'LeaveData maps to Leave');
ok(modules.get('recruitment').testData.sheetCount >= 1, 'RecruitmentData maps to Recruitment');
ok(modules.get('pim').atlas.currentSliceCount === 1, 'PIM atlas slice count is surfaced');
ok(preview.totals.requirementSource === 'document_fragments', 'fresh docs without RequirementClause rows still get requirement-like counts');

console.log('\n[4] Route wiring and org safety');
const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const routeSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'modules.js'), 'utf8');
ok(/require\('\.\/routes\/modules'\)/.test(indexSrc), 'server/index.js imports modules route');
ok(/\/api\/projects\/:projectId\/modules/.test(indexSrc), 'server/index.js mounts /api/projects/:projectId/modules');
ok(/router\.use\(requireAuth\)/.test(routeSrc) && /router\.use\(requireOrg\)/.test(routeSrc), 'modules route uses requireAuth + requireOrg');
ok(/orgId:\s*req\.org\.id/.test(routeSrc), 'modules route scopes project lookup by orgId');
ok(/detectProjectModules/.test(routeSrc), 'modules route calls deterministic detector');

console.log('\n[5] Test Cases module-scope UI wiring');
const testCasesSrc = fs.readFileSync(path.join(root, 'src', 'pages', 'TestCases.jsx'), 'utf8');
ok(/\/projects\/\$\{projectId\}\/modules\/preview/.test(testCasesSrc), 'TestCases fetches module preview for the active project');
ok(/Module scope/.test(testCasesSrc), 'TestCases renders a Module scope selector');
ok(/selectedModuleKey/.test(testCasesSrc) && /setSelectedModuleKey/.test(testCasesSrc), 'TestCases keeps a selected module key');
ok(/body\.module\s*=\s*options\.module/.test(testCasesSrc), 'Generate request sends selected module as body.module');
ok(/onGenerate\(parts\.join\('\\n\\n'\) \|\| null,\s*selectedModule/.test(testCasesSrc), 'GenerateConfigCard passes selected module options to the caller');
ok(/projectId=\{current\?\.id\}/.test(testCasesSrc), 'GenerateConfigCard receives current project id');

console.log(`\nPASS verify_modules.cjs (${pass} checks)`);
