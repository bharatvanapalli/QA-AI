'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const JSZip = require('../server/node_modules/jszip');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'benchmark_artifacts', 'orangehrm_credibility_pack');
const PREPARED_ON = '2026-06-28';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeXml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function addSheet(wb, name, rows, widths = []) {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = widths.length
    ? widths.map((wch) => ({ wch }))
    : Object.keys(rows[0] || {}).map((key) => ({ wch: Math.max(14, Math.min(44, String(key).length + 8)) }));
  XLSX.utils.book_append_sheet(wb, ws, name);
}

const moduleMap = [
  { moduleName: 'Dashboard', menuLabel: 'Dashboard', expectedPath: '/web/index.php/dashboard/index', stableSignals: 'Dashboard header; Time at Work widget; My Actions widget; Quick Launch; Buzz Latest Posts' },
  { moduleName: 'Admin', menuLabel: 'Admin', expectedPath: '/web/index.php/admin/viewSystemUsers', stableSignals: 'System Users page; Username filter; User Role filter; Status filter; Add button' },
  { moduleName: 'PIM', menuLabel: 'PIM', expectedPath: '/web/index.php/pim/viewEmployeeList', stableSignals: 'Employee Information; Employee Name; Employee Id; Add Employee' },
  { moduleName: 'Leave', menuLabel: 'Leave', expectedPath: '/web/index.php/leave/viewLeaveList', stableSignals: 'Leave List; From Date; To Date; Show Leave with Status; Employee Name' },
  { moduleName: 'Time', menuLabel: 'Time', expectedPath: '/web/index.php/time/viewEmployeeTimesheet', stableSignals: 'Timesheets; Employee Name; View button; Attendance sub-menu' },
  { moduleName: 'Recruitment', menuLabel: 'Recruitment', expectedPath: '/web/index.php/recruitment/viewCandidates', stableSignals: 'Candidates; Vacancy; Hiring Manager; Status; Add button' },
  { moduleName: 'My Info', menuLabel: 'My Info', expectedPath: '/web/index.php/pim/viewPersonalDetails', stableSignals: 'Personal Details; Contact Details; Emergency Contacts; Dependents; Immigration; Qualifications' },
  { moduleName: 'Performance', menuLabel: 'Performance', expectedPath: '/web/index.php/performance/searchEvaluatePerformanceReview', stableSignals: 'Performance review/search surfaces; Configure/Manage Reviews/Trackers navigation' },
  { moduleName: 'Directory', menuLabel: 'Directory', expectedPath: '/web/index.php/directory/viewDirectory', stableSignals: 'Directory; Employee Name; Job Title; Location; employee cards or No Records Found' },
  { moduleName: 'Maintenance', menuLabel: 'Maintenance', expectedPath: '/web/index.php/maintenance/purgeEmployee', stableSignals: 'Administrator Access password gate; Maintenance section after valid password' },
  { moduleName: 'Claim', menuLabel: 'Claim', expectedPath: '/web/index.php/claim/viewAssignClaim', stableSignals: 'Claim request pages; Submit Claim/My Claims/Employee Claims/Event controls' },
  { moduleName: 'Buzz', menuLabel: 'Buzz', expectedPath: '/web/index.php/buzz/viewBuzz', stableSignals: 'Buzz Newsfeed; post composer; feed entries; comment/like actions' },
];

const userStories = [
  {
    id: 'US-OHRM-001',
    title: 'Dashboard launchpad proves a clean Admin login and live widgets',
    module: 'Dashboard',
    intent: 'Expected PASS',
    actor: 'HR administrator',
    story: 'As an HR administrator, I want to log in normally and confirm the dashboard widgets and quick launch shortcuts are visible so I know the session is established and the landing page is usable.',
    workflow: [
      'Navigate to the OrangeHRM login page.',
      'Log in with the ADMIN_DEFAULT profile from ExecutionProfiles.',
      'Verify the Dashboard page is reached.',
      'Verify Time at Work, My Actions, Quick Launch, and Buzz Latest Posts are visible.',
      'Open each configured Quick Launch item from Dashboard_QuickLaunch and verify the target page or page signal appears.',
    ],
    acceptance: [
      'The user reaches /dashboard/index after login.',
      'Dashboard widgets are present and not blank.',
      'Quick Launch shortcuts navigate to the correct modules.',
    ],
    dataSheets: ['ExecutionProfiles', 'Dashboard_QuickLaunch'],
  },
  {
    id: 'US-OHRM-002',
    title: 'Global menu navigation covers every visible OrangeHRM module',
    module: 'Navigation',
    intent: 'Expected PASS',
    actor: 'HR administrator',
    story: 'As an HR administrator, I want to open every left-menu module and verify a stable module-specific signal so broken routing or hidden menu regressions are caught.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'For each row in Menu_Navigation, click the left menu item.',
      'Verify the current URL contains the expected path or the page shows the expected stable signal.',
      'Return to Dashboard between modules only when the application state becomes ambiguous.',
    ],
    acceptance: [
      'All visible menu entries are clickable.',
      'The app does not remain stuck on the prior module.',
      'Each target page shows its expected page-level signal.',
    ],
    dataSheets: ['ExecutionProfiles', 'Menu_Navigation'],
  },
  {
    id: 'US-OHRM-003',
    title: 'Admin user search finds enabled Admin users and supports filters',
    module: 'Admin',
    intent: 'Expected PASS',
    actor: 'System administrator',
    story: 'As a system administrator, I want to search system users by username, role, employee name, and status so I can audit account access.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Admin > User Management > Users.',
      'Apply each Admin_UserSearch row independently.',
      'Click Search and verify either a matching row/table result or a clear No Records Found message according to shouldFind.',
      'Reset filters between rows.',
    ],
    acceptance: [
      'Valid filters return a table or matching user row.',
      'Invalid filters return No Records Found without a crash.',
      'The Search and Reset controls remain usable after each row.',
    ],
    dataSheets: ['ExecutionProfiles', 'Admin_UserSearch'],
  },
  {
    id: 'US-OHRM-004',
    title: 'Admin missing bulk export is caught as a real product gap',
    module: 'Admin',
    intent: 'Expected FAIL_PRODUCT_GAP',
    actor: 'Compliance administrator',
    story: 'As a compliance administrator, I want to export the system-user table to CSV from Admin > Users so I can archive monthly access reviews.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Admin > User Management > Users.',
      'Search for enabled users.',
      'Verify a visible Export CSV or Download Users control exists.',
    ],
    acceptance: [
      'This story intentionally expects a feature the current demo does not expose.',
      'The correct platform result is a product FAIL, not needs_human and not pass.',
    ],
    dataSheets: ['ExecutionProfiles', 'Admin_MissingFeature_Bugs'],
  },
  {
    id: 'US-OHRM-005',
    title: 'PIM creates, searches, and edits an employee record',
    module: 'PIM',
    intent: 'Expected PASS',
    actor: 'HR administrator',
    story: 'As an HR administrator, I want to add a new employee, find that employee in the employee list, and update a personal-detail field so the PIM lifecycle is covered end to end.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open PIM > Add Employee.',
      'Fill first name, middle name, last name, and employee id from PIM_EmployeeLifecycle.',
      'Save and verify the Personal Details page opens for the created employee.',
      'Return to PIM > Employee List, search by employee id and employee name, and open the record.',
      'Update the configured nickname or other safe non-critical field and save.',
    ],
    acceptance: [
      'Employee creation succeeds with valid required fields.',
      'The created employee is searchable by id/name.',
      'A later detail update persists or shows a success toast.',
    ],
    dataSheets: ['ExecutionProfiles', 'PIM_EmployeeLifecycle'],
  },
  {
    id: 'US-OHRM-006',
    title: 'PIM Add Employee required-field validation stays on the form',
    module: 'PIM',
    intent: 'Expected PASS_NEGATIVE_VALIDATION',
    actor: 'HR administrator',
    story: 'As an HR administrator, I want Add Employee to block incomplete employee submissions so bad records are not created.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open PIM > Add Employee.',
      'Apply each PIM_Validation row independently.',
      'Leave the field named by emptyField blank, submit, and verify the required error appears.',
    ],
    acceptance: [
      'The user remains on Add Employee.',
      'Required validation appears for the missing field.',
      'No employee details page is reached for invalid rows.',
    ],
    dataSheets: ['ExecutionProfiles', 'PIM_Validation'],
  },
  {
    id: 'US-OHRM-007',
    title: 'Leave list and assign leave use real employee/date filters',
    module: 'Leave',
    intent: 'Expected PASS_WITH_DEMO_DATA',
    actor: 'Leave administrator',
    story: 'As a leave administrator, I want to filter leave requests and attempt an assignment with valid employee/date data so leave workflow controls are verified.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Leave > Leave List and search with the date/status filters from Leave_ListFilters.',
      'Open Leave > Assign Leave.',
      'Use Leave_AssignRequests rows to fill employee, leave type, from date, to date, duration/comment, then submit only when shouldAssign is Yes.',
      'Verify either a success path or a validation message according to the row intent.',
    ],
    acceptance: [
      'Leave List filters are usable and return either table results or No Records Found.',
      'Assign Leave validates required employee/date/type data.',
      'The story does not convert validation rows into product bugs.',
    ],
    dataSheets: ['ExecutionProfiles', 'Leave_ListFilters', 'Leave_AssignRequests'],
  },
  {
    id: 'US-OHRM-008',
    title: 'Time module opens timesheets and attendance surfaces',
    module: 'Time',
    intent: 'Expected PASS',
    actor: 'Time administrator',
    story: 'As a time administrator, I want to search employee timesheets and inspect attendance controls so time tracking navigation and forms are covered.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Time > Timesheets > Employee Timesheets.',
      'Search the employee from Time_TimesheetSearch.',
      'Verify a timesheet page, validation message, or No Records Found according to expectedOutcome.',
      'Open Time > Attendance and verify Punch In/Out or Employee Records controls are present.',
    ],
    acceptance: [
      'Timesheets page is reachable from normal login.',
      'Employee search does not crash on valid or no-result data.',
      'Attendance navigation exposes a stable attendance signal.',
    ],
    dataSheets: ['ExecutionProfiles', 'Time_TimesheetSearch'],
  },
  {
    id: 'US-OHRM-009',
    title: 'Recruitment adds and searches candidates',
    module: 'Recruitment',
    intent: 'Expected PASS',
    actor: 'Recruiter',
    story: 'As a recruiter, I want to add a candidate and then find the candidate by name/status so applicant intake is proven.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Recruitment > Candidates.',
      'Click Add and fill candidate name, email, contact number, keywords, vacancy, consent, and notes from Recruitment_Candidates.',
      'Save and verify candidate profile or success toast.',
      'Return to Candidates and search by candidate name/status.',
    ],
    acceptance: [
      'Candidate creation succeeds for valid rows.',
      'Candidate search/filter controls remain usable.',
      'Email/required-field validation is respected for invalid validation rows.',
    ],
    dataSheets: ['ExecutionProfiles', 'Recruitment_Candidates'],
  },
  {
    id: 'US-OHRM-010',
    title: 'Recruitment missing LinkedIn profile field is caught',
    module: 'Recruitment',
    intent: 'Expected FAIL_PRODUCT_GAP',
    actor: 'Recruiter',
    story: 'As a recruiter, I want to capture a candidate LinkedIn profile URL during candidate creation so sourcing provenance is retained.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Recruitment > Candidates > Add.',
      'Verify a LinkedIn Profile URL field is visible and editable.',
    ],
    acceptance: [
      'This story intentionally expects a field not exposed by the current demo.',
      'The correct platform result is product FAIL with evidence that the field is missing.',
    ],
    dataSheets: ['ExecutionProfiles', 'Recruitment_MissingFeature_Bugs'],
  },
  {
    id: 'US-OHRM-011',
    title: 'Directory search proves employee directory behavior and no-result state',
    module: 'Directory',
    intent: 'Expected PASS',
    actor: 'Employee',
    story: 'As an employee, I want to search the company directory by name, job title, and location so I can find coworkers or see a clear empty state.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Directory.',
      'Apply each Directory_Search row independently.',
      'Verify either employee cards or No Records Found according to shouldFind.',
      'Reset filters between rows.',
    ],
    acceptance: [
      'Directory filters are reachable and usable.',
      'No-result cases are reported as passing negative checks, not product failures.',
    ],
    dataSheets: ['ExecutionProfiles', 'Directory_Search'],
  },
  {
    id: 'US-OHRM-012',
    title: 'Maintenance password gate blocks wrong password and permits valid password',
    module: 'Maintenance',
    intent: 'Expected PASS_MIXED_GATE',
    actor: 'Maintenance administrator',
    story: 'As an administrator, I want Maintenance to require password re-authentication so sensitive purge/access-record tools are protected.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Maintenance.',
      'For wrong-password rows, enter the invalid password and verify the access page remains with an error.',
      'For valid-password rows, enter the valid maintenance password and verify a Maintenance page signal appears.',
    ],
    acceptance: [
      'Wrong password does not enter Maintenance.',
      'Valid Admin password passes the gate.',
      'Results are separated by row intent.',
    ],
    dataSheets: ['ExecutionProfiles', 'Maintenance_Access'],
  },
  {
    id: 'US-OHRM-013',
    title: 'Claim request form validates event, currency, amount, and remarks',
    module: 'Claim',
    intent: 'Expected PASS_WITH_VALIDATION',
    actor: 'Employee claims administrator',
    story: 'As a claims user, I want to submit or validate a claim request with event/currency/amount/remarks so expense workflow quality is tested.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Claim > Submit Claim or accessible claim request form.',
      'Apply Claim_Submit rows.',
      'For valid rows, save/submit and verify claim request detail or success message.',
      'For validation rows, verify required/amount validation and remain on form.',
    ],
    acceptance: [
      'Claim module is reachable.',
      'Required fields and amount validation are enforced.',
      'A valid claim flow reaches a stable saved/request page where the demo supports it.',
    ],
    dataSheets: ['ExecutionProfiles', 'Claim_Submit'],
  },
  {
    id: 'US-OHRM-014',
    title: 'Buzz post composer creates a feed post',
    module: 'Buzz',
    intent: 'Expected PASS',
    actor: 'Employee',
    story: 'As an employee, I want to post an announcement in Buzz and verify it appears in the latest feed so internal social posting is covered.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Buzz.',
      'Create the configured Buzz_Posts text post.',
      'Verify the new post text appears in the feed.',
      'Optionally add a comment if the comment control is visible.',
    ],
    acceptance: [
      'Buzz page loads from normal login.',
      'The text composer accepts a post.',
      'The posted content appears in the feed or success confirmation appears.',
    ],
    dataSheets: ['ExecutionProfiles', 'Buzz_Posts'],
  },
  {
    id: 'US-OHRM-015',
    title: 'Buzz scheduled post request is caught as missing capability',
    module: 'Buzz',
    intent: 'Expected FAIL_PRODUCT_GAP',
    actor: 'Internal communications manager',
    story: 'As an internal communications manager, I want to schedule a Buzz post for a future date and time so announcements can be prepared ahead of release.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Buzz.',
      'Verify a Schedule Post or Publish Later control exists.',
    ],
    acceptance: [
      'This story intentionally expects a feature not visible in the current demo.',
      'The correct result is product FAIL with missing-control evidence.',
    ],
    dataSheets: ['ExecutionProfiles', 'Buzz_MissingFeature_Bugs'],
  },
  {
    id: 'US-OHRM-016',
    title: 'My Info validates personal/contact details without corrupting the profile',
    module: 'My Info',
    intent: 'Expected PASS_WITH_VALIDATION',
    actor: 'Logged-in employee',
    story: 'As a logged-in employee, I want to inspect and safely update non-critical My Info fields while invalid contact formats are rejected.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open My Info.',
      'Verify Personal Details and Contact Details navigation is present.',
      'Apply MyInfo_ProfileValidation rows: valid safe field updates should save; invalid email/contact data should show validation and remain editable.',
    ],
    acceptance: [
      'My Info opens for the logged-in employee.',
      'Safe updates show a success toast or persist.',
      'Invalid formats are blocked with inline validation.',
    ],
    dataSheets: ['ExecutionProfiles', 'MyInfo_ProfileValidation'],
  },
  {
    id: 'US-OHRM-017',
    title: 'Performance missing 9-box calibration matrix is caught',
    module: 'Performance',
    intent: 'Expected FAIL_PRODUCT_GAP',
    actor: 'Performance administrator',
    story: 'As a performance administrator, I want a 9-box talent calibration matrix view so employee potential/performance can be compared visually.',
    workflow: [
      'Log in with ADMIN_DEFAULT.',
      'Open Performance.',
      'Search or inspect the Performance navigation.',
      'Verify a 9-Box Matrix or Talent Calibration view is visible.',
    ],
    acceptance: [
      'This story intentionally expects a feature not visible in the current demo.',
      'The correct result is product FAIL, not platform uncertainty.',
    ],
    dataSheets: ['ExecutionProfiles', 'Performance_MissingFeature_Bugs'],
  },
];

const workbookSheets = {
  README: [
    { field: 'Purpose', value: 'Fresh OrangeHRM credibility benchmark pack. Do not mix with previous generated data.' },
    { field: 'Login model', value: 'Every user story starts with normal Admin login using ExecutionProfiles.ADMIN_DEFAULT.' },
    { field: 'Binding safety', value: 'Positive workflow sheets and bug-catching sheets are separated. No sheet mixes success rows with expected product-gap rows.' },
    { field: 'Expected failures', value: 'Rows whose expectedPlatformVerdict is FAIL_PRODUCT_GAP should fail the product when the requested feature is missing; that is a useful result.' },
    { field: 'Prepared on', value: PREPARED_ON },
  ],
  ExecutionProfiles: [
    { profileKey: 'ADMIN_DEFAULT', loginUsername: 'Admin', loginPassword: 'admin123', expectedLandingPath: '/web/index.php/dashboard/index', expectedLandingHeader: 'Dashboard', sensitivityLevel: 'MASKED', notes: 'Use this normal login at the start of every story.' },
  ],
  Menu_Navigation: moduleMap.map((m, i) => ({
    navCaseId: `NAV-${String(i + 1).padStart(2, '0')}`,
    storyId: 'US-OHRM-002',
    profileKey: 'ADMIN_DEFAULT',
    menuLabel: m.menuLabel,
    expectedPath: m.expectedPath,
    expectedVisibleSignal: m.stableSignals,
    expectedPlatformVerdict: 'PASS',
  })),
  Dashboard_QuickLaunch: [
    { quickLaunchCaseId: 'DASH-QL-01', storyId: 'US-OHRM-001', profileKey: 'ADMIN_DEFAULT', shortcutLabel: 'Assign Leave', expectedModule: 'Leave', expectedVisibleSignal: 'Assign Leave', expectedPlatformVerdict: 'PASS' },
    { quickLaunchCaseId: 'DASH-QL-02', storyId: 'US-OHRM-001', profileKey: 'ADMIN_DEFAULT', shortcutLabel: 'Leave List', expectedModule: 'Leave', expectedVisibleSignal: 'Leave List', expectedPlatformVerdict: 'PASS' },
    { quickLaunchCaseId: 'DASH-QL-03', storyId: 'US-OHRM-001', profileKey: 'ADMIN_DEFAULT', shortcutLabel: 'Timesheets', expectedModule: 'Time', expectedVisibleSignal: 'Timesheets', expectedPlatformVerdict: 'PASS' },
  ],
  Admin_UserSearch: [
    { adminSearchCaseId: 'ADM-SRCH-01', storyId: 'US-OHRM-003', profileKey: 'ADMIN_DEFAULT', caseIntent: 'positive_search', usernameFilter: 'Admin', userRoleFilter: 'Admin', employeeNameFilter: '', statusFilter: 'Enabled', shouldFind: 'Yes', expectedVisibleSignal: 'Admin', expectedPlatformVerdict: 'PASS' },
    { adminSearchCaseId: 'ADM-SRCH-02', storyId: 'US-OHRM-003', profileKey: 'ADMIN_DEFAULT', caseIntent: 'no_result_search', usernameFilter: 'NoSuchUser_778899', userRoleFilter: '', employeeNameFilter: '', statusFilter: '', shouldFind: 'No', expectedVisibleSignal: 'No Records Found', expectedPlatformVerdict: 'PASS' },
    { adminSearchCaseId: 'ADM-SRCH-03', storyId: 'US-OHRM-003', profileKey: 'ADMIN_DEFAULT', caseIntent: 'filter_reset', usernameFilter: '', userRoleFilter: 'ESS', employeeNameFilter: '', statusFilter: 'Disabled', shouldFind: 'Maybe', expectedVisibleSignal: 'System Users table or No Records Found', expectedPlatformVerdict: 'PASS' },
  ],
  Admin_MissingFeature_Bugs: [
    { bugCaseId: 'ADM-BUG-01', storyId: 'US-OHRM-004', profileKey: 'ADMIN_DEFAULT', moduleName: 'Admin', requestedFeature: 'Export CSV from System Users', mustHaveVisibleControl: 'Export CSV', expectedFailureReason: 'Current demo does not expose a system-user export control.', expectedPlatformVerdict: 'FAIL_PRODUCT_GAP' },
  ],
  PIM_EmployeeLifecycle: [
    { employeeCaseId: 'PIM-LIFE-01', storyId: 'US-OHRM-005', profileKey: 'ADMIN_DEFAULT', caseIntent: 'create_search_edit_employee', firstNameInput: 'QAAI', middleNameInput: 'Credibility', lastNameInput: 'Alpha001', employeeIdInput: 'QA001901', safeNicknameInput: 'QA Alpha', searchNameInput: 'QAAI Alpha001', expectedVisibleSignal: 'Personal Details', expectedPlatformVerdict: 'PASS' },
    { employeeCaseId: 'PIM-LIFE-02', storyId: 'US-OHRM-005', profileKey: 'ADMIN_DEFAULT', caseIntent: 'create_search_edit_employee', firstNameInput: 'QAAI', middleNameInput: 'Credibility', lastNameInput: 'Beta002', employeeIdInput: 'QA001902', safeNicknameInput: 'QA Beta', searchNameInput: 'QAAI Beta002', expectedVisibleSignal: 'Personal Details', expectedPlatformVerdict: 'PASS' },
  ],
  PIM_Validation: [
    { validationCaseId: 'PIM-VAL-01', storyId: 'US-OHRM-006', profileKey: 'ADMIN_DEFAULT', caseIntent: 'required_field_validation', firstNameInput: '', middleNameInput: '', lastNameInput: 'MissingFirstName', employeeIdInput: 'QA001903', emptyField: 'First Name', expectedValidationMessage: 'Required', expectedPlatformVerdict: 'PASS' },
    { validationCaseId: 'PIM-VAL-02', storyId: 'US-OHRM-006', profileKey: 'ADMIN_DEFAULT', caseIntent: 'required_field_validation', firstNameInput: 'MissingLast', middleNameInput: '', lastNameInput: '', employeeIdInput: 'QA001904', emptyField: 'Last Name', expectedValidationMessage: 'Required', expectedPlatformVerdict: 'PASS' },
  ],
  Leave_ListFilters: [
    { leaveListCaseId: 'LEV-LIST-01', storyId: 'US-OHRM-007', profileKey: 'ADMIN_DEFAULT', caseIntent: 'date_status_filter', fromDateInput: '2026-06-01', toDateInput: '2026-06-30', leaveStatusFilter: 'Pending Approval', employeeNameInput: '', expectedVisibleSignal: 'Leave List table or No Records Found', expectedPlatformVerdict: 'PASS' },
    { leaveListCaseId: 'LEV-LIST-02', storyId: 'US-OHRM-007', profileKey: 'ADMIN_DEFAULT', caseIntent: 'no_result_filter', fromDateInput: '2035-01-01', toDateInput: '2035-01-31', leaveStatusFilter: 'Taken', employeeNameInput: 'No Such Employee 778899', expectedVisibleSignal: 'No Records Found or validation', expectedPlatformVerdict: 'PASS' },
  ],
  Leave_AssignRequests: [
    { assignCaseId: 'LEV-ASN-01', storyId: 'US-OHRM-007', profileKey: 'ADMIN_DEFAULT', caseIntent: 'required_validation', employeeNameInput: '', leaveTypeInput: '', fromDateInput: '', toDateInput: '', partialDaysInput: '', commentsInput: 'QAAI required validation check', shouldAssign: 'No', expectedValidationMessage: 'Required', expectedPlatformVerdict: 'PASS' },
    { assignCaseId: 'LEV-ASN-02', storyId: 'US-OHRM-007', profileKey: 'ADMIN_DEFAULT', caseIntent: 'valid_or_balance_validation', employeeNameInput: 'Shahzaib', leaveTypeInput: 'CAN - Personal', fromDateInput: '2026-07-15', toDateInput: '2026-07-15', partialDaysInput: 'Full Day', commentsInput: 'QAAI single day leave benchmark', shouldAssign: 'Yes', expectedVisibleSignal: 'Successfully Saved or leave-balance validation', expectedPlatformVerdict: 'PASS' },
  ],
  Time_TimesheetSearch: [
    { timeCaseId: 'TIME-TS-01', storyId: 'US-OHRM-008', profileKey: 'ADMIN_DEFAULT', caseIntent: 'employee_timesheet_search', employeeNameInput: 'Shahzaib', expectedVisibleSignal: 'Timesheet or No Records Found', expectedPlatformVerdict: 'PASS' },
    { timeCaseId: 'TIME-TS-02', storyId: 'US-OHRM-008', profileKey: 'ADMIN_DEFAULT', caseIntent: 'employee_timesheet_no_result', employeeNameInput: 'No Such Employee 445566', expectedVisibleSignal: 'Invalid or No Records Found', expectedPlatformVerdict: 'PASS' },
  ],
  Recruitment_Candidates: [
    { candidateCaseId: 'REC-CAND-01', storyId: 'US-OHRM-009', profileKey: 'ADMIN_DEFAULT', caseIntent: 'add_candidate', firstNameInput: 'QAAI', middleNameInput: 'Recruit', lastNameInput: 'Gamma001', emailInput: 'qaai.candidate.gamma001@example.test', contactNumberInput: '9876500011', vacancyInput: '', keywordsInput: 'automation,benchmark', notesInput: 'QAAI credibility candidate', consentToKeepData: 'Yes', expectedVisibleSignal: 'Candidate profile or success toast', expectedPlatformVerdict: 'PASS' },
    { candidateCaseId: 'REC-CAND-02', storyId: 'US-OHRM-009', profileKey: 'ADMIN_DEFAULT', caseIntent: 'candidate_email_validation', firstNameInput: 'QAAI', middleNameInput: '', lastNameInput: 'BadEmail', emailInput: 'not-an-email', contactNumberInput: '9876500012', vacancyInput: '', keywordsInput: 'validation', notesInput: 'Expect email validation', consentToKeepData: 'Yes', expectedValidationMessage: 'Expected format', expectedPlatformVerdict: 'PASS' },
  ],
  Recruitment_MissingFeature_Bugs: [
    { bugCaseId: 'REC-BUG-01', storyId: 'US-OHRM-010', profileKey: 'ADMIN_DEFAULT', moduleName: 'Recruitment', requestedFeature: 'Candidate LinkedIn Profile URL field', mustHaveVisibleControl: 'LinkedIn Profile URL', expectedFailureReason: 'Current demo Add Candidate form does not expose a LinkedIn URL field.', expectedPlatformVerdict: 'FAIL_PRODUCT_GAP' },
  ],
  Directory_Search: [
    { directoryCaseId: 'DIR-SRCH-01', storyId: 'US-OHRM-011', profileKey: 'ADMIN_DEFAULT', caseIntent: 'name_search', employeeNameInput: 'Shahzaib', jobTitleFilter: '', locationFilter: '', shouldFind: 'Yes', expectedVisibleSignal: 'employee card or directory result', expectedPlatformVerdict: 'PASS' },
    { directoryCaseId: 'DIR-SRCH-02', storyId: 'US-OHRM-011', profileKey: 'ADMIN_DEFAULT', caseIntent: 'no_result_search', employeeNameInput: 'No Such Employee 998877', jobTitleFilter: '', locationFilter: '', shouldFind: 'No', expectedVisibleSignal: 'No Records Found', expectedPlatformVerdict: 'PASS' },
  ],
  Maintenance_Access: [
    { maintenanceCaseId: 'MNT-GATE-01', storyId: 'US-OHRM-012', profileKey: 'ADMIN_DEFAULT', caseIntent: 'valid_maintenance_password', maintenancePasswordInput: 'admin123', expectedVisibleSignal: 'Maintenance or Purge Records or Access Records', expectedPlatformVerdict: 'PASS', sensitivityLevel: 'MASKED' },
    { maintenanceCaseId: 'MNT-GATE-02', storyId: 'US-OHRM-012', profileKey: 'ADMIN_DEFAULT', caseIntent: 'invalid_maintenance_password', maintenancePasswordInput: 'wrongPassword123', expectedVisibleSignal: 'Administrator Access remains or Invalid credentials', expectedPlatformVerdict: 'PASS', sensitivityLevel: 'MASKED' },
  ],
  Claim_Submit: [
    { claimCaseId: 'CLM-SUB-01', storyId: 'US-OHRM-013', profileKey: 'ADMIN_DEFAULT', caseIntent: 'required_validation', eventInput: '', currencyInput: '', expenseTypeInput: '', amountInput: '', remarksInput: 'QAAI claim required validation', shouldSubmit: 'No', expectedValidationMessage: 'Required', expectedPlatformVerdict: 'PASS' },
    { claimCaseId: 'CLM-SUB-02', storyId: 'US-OHRM-013', profileKey: 'ADMIN_DEFAULT', caseIntent: 'valid_or_config_validation', eventInput: 'Accommodation', currencyInput: 'United States Dollar', expenseTypeInput: 'Accommodation', amountInput: '125.50', remarksInput: 'QAAI hotel reimbursement benchmark', shouldSubmit: 'Yes', expectedVisibleSignal: 'Successfully Saved or claim configuration validation', expectedPlatformVerdict: 'PASS' },
  ],
  Buzz_Posts: [
    { buzzCaseId: 'BUZZ-POST-01', storyId: 'US-OHRM-014', profileKey: 'ADMIN_DEFAULT', caseIntent: 'create_text_post', postTextInput: 'QAAI credibility benchmark post 001 - dashboard and buzz smoke.', commentTextInput: 'QAAI comment verification 001', expectedVisibleSignal: 'QAAI credibility benchmark post 001', expectedPlatformVerdict: 'PASS' },
  ],
  Buzz_MissingFeature_Bugs: [
    { bugCaseId: 'BUZZ-BUG-01', storyId: 'US-OHRM-015', profileKey: 'ADMIN_DEFAULT', moduleName: 'Buzz', requestedFeature: 'Schedule post for future publish date', mustHaveVisibleControl: 'Schedule Post', expectedFailureReason: 'Current demo Buzz composer does not expose scheduled publishing.', expectedPlatformVerdict: 'FAIL_PRODUCT_GAP' },
  ],
  MyInfo_ProfileValidation: [
    { myInfoCaseId: 'MYINFO-VAL-01', storyId: 'US-OHRM-016', profileKey: 'ADMIN_DEFAULT', caseIntent: 'safe_profile_navigation', targetTab: 'Personal Details', safeFieldName: 'Nickname', safeFieldValue: 'QAAI Profile Check', expectedVisibleSignal: 'Successfully Updated or Personal Details', expectedPlatformVerdict: 'PASS' },
    { myInfoCaseId: 'MYINFO-VAL-02', storyId: 'US-OHRM-016', profileKey: 'ADMIN_DEFAULT', caseIntent: 'invalid_email_validation', targetTab: 'Contact Details', fieldName: 'Work Email', invalidFieldValue: 'bad-email-format', expectedValidationMessage: 'Expected format', expectedPlatformVerdict: 'PASS' },
  ],
  Performance_MissingFeature_Bugs: [
    { bugCaseId: 'PERF-BUG-01', storyId: 'US-OHRM-017', profileKey: 'ADMIN_DEFAULT', moduleName: 'Performance', requestedFeature: '9-Box Talent Calibration Matrix', mustHaveVisibleControl: '9-Box Matrix', expectedFailureReason: 'Current demo Performance module does not expose a 9-box calibration matrix.', expectedPlatformVerdict: 'FAIL_PRODUCT_GAP' },
  ],
  GlobalSearch_Menu: [
    { globalSearchCaseId: 'GLOB-01', storyId: 'US-OHRM-002', profileKey: 'ADMIN_DEFAULT', searchTermInput: 'PIM', expectedMenuLabel: 'PIM', expectedPlatformVerdict: 'PASS' },
    { globalSearchCaseId: 'GLOB-02', storyId: 'US-OHRM-002', profileKey: 'ADMIN_DEFAULT', searchTermInput: 'Buzz', expectedMenuLabel: 'Buzz', expectedPlatformVerdict: 'PASS' },
    { globalSearchCaseId: 'GLOB-03', storyId: 'US-OHRM-002', profileKey: 'ADMIN_DEFAULT', searchTermInput: 'Payroll', expectedMenuLabel: '', expectedVisibleSignal: 'No matching menu item', expectedPlatformVerdict: 'PASS' },
  ],
};

function storyMarkdown(story) {
  return [
    `### ${story.id}: ${story.title}`,
    '',
    `- Module: ${story.module}`,
    `- Intent: ${story.intent}`,
    `- Actor: ${story.actor}`,
    `- User story: ${story.story}`,
    `- Data sheets: ${story.dataSheets.join(', ')}`,
    '',
    '**Normal login flow**',
    '1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.',
    '2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.',
    '3. Verify Dashboard is reached before continuing the module workflow.',
    '',
    '**Workflow**',
    ...story.workflow.map((step, index) => `${index + 1}. ${step}`),
    '',
    '**Acceptance Criteria**',
    ...story.acceptance.map((criterion) => `- ${criterion}`),
    '',
  ].join('\n');
}

const markdown = [
  '# OrangeHRM Credibility Benchmark User Stories',
  '',
  `Prepared: ${PREPARED_ON}`,
  '',
  '## Purpose',
  '',
  'This pack is designed to prove whether QAAI can generate and execute useful scenarios from a clean requirements document plus a clean test-data workbook. It deliberately avoids the previously broken user stories and broken data bindings. Every story begins with a normal Admin login. Expected product-gap stories are included so a missing feature becomes a truthful product FAIL, not a fake PASS.',
  '',
  '## Ground Rules for QAAI',
  '',
  '- Do not reuse any prior generated OrangeHRM stories or prior test-data sheets.',
  '- Start every story with the normal login flow using `ExecutionProfiles.ADMIN_DEFAULT`.',
  '- Bind only to the sheet named by the story. Do not join unrelated sheets unless the story explicitly references `ExecutionProfiles` for login.',
  '- `expectedPlatformVerdict = FAIL_PRODUCT_GAP` means the test is intentionally asking for a capability that the current demo does not expose. The correct result is a product failure with evidence.',
  '- Negative validation rows such as required-field checks are expected to PASS when the application correctly blocks invalid input.',
  '- Never convert a validation row into a success-login row or a product bug.',
  '',
  '## Observed Current OrangeHRM Demo Menu Map',
  '',
  '| Module | Left Menu Label | Expected Path | Stable Signals |',
  '| --- | --- | --- | --- |',
  ...moduleMap.map((m) => `| ${m.moduleName} | ${m.menuLabel} | \`${m.expectedPath}\` | ${m.stableSignals} |`),
  '',
  '## User Stories',
  '',
  ...userStories.map(storyMarkdown),
].join('\n');

function docxParagraph(text, style = null) {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${safeXml(text)}</w:t></w:r></w:p>`;
}

function markdownToDocxXml(md) {
  const lines = md.split(/\r?\n/);
  const body = [];
  for (const line of lines) {
    if (line.startsWith('# ')) body.push(docxParagraph(line.slice(2), 'Title'));
    else if (line.startsWith('## ')) body.push(docxParagraph(line.slice(3), 'Heading1'));
    else if (line.startsWith('### ')) body.push(docxParagraph(line.slice(4), 'Heading2'));
    else if (line.startsWith('- ')) body.push(docxParagraph(`• ${line.slice(2)}`));
    else if (/^\d+\.\s+/.test(line)) body.push(docxParagraph(line));
    else if (line.startsWith('| ')) body.push(docxParagraph(line));
    else if (line.trim() === '') body.push(docxParagraph(''));
    else body.push(docxParagraph(line.replace(/\*\*/g, '')));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${body.join('\n')}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>
  </w:body>
</w:document>`;
}

async function createDocx(docxPath, md) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
  zip.file('word/document.xml', markdownToDocxXml(md));
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:title>OrangeHRM Credibility Benchmark User Stories</dc:title>
  <dc:creator>QAAI benchmark pack generator</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${PREPARED_ON}T00:00:00Z</dcterms:created>
</cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>QAAI</Application></Properties>`);

  fs.rmSync(docxPath, { force: true });
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    platform: 'UNIX',
  });
  fs.writeFileSync(docxPath, buffer);
}

async function main() {
  ensureDir(OUT_DIR);

  const wb = XLSX.utils.book_new();
  for (const [sheetName, rows] of Object.entries(workbookSheets)) {
    addSheet(wb, sheetName, rows, [18, 18, 18, 18, 22, 24, 24, 24, 28, 36, 42]);
  }
  const workbookPath = path.join(OUT_DIR, 'OrangeHRM_Credibility_Test_Data.xlsx');
  XLSX.writeFile(wb, workbookPath);

  const markdownPath = path.join(OUT_DIR, 'OrangeHRM_Credibility_User_Stories.md');
  fs.writeFileSync(markdownPath, markdown, 'utf8');

  const docxPath = path.join(OUT_DIR, 'OrangeHRM_Credibility_User_Stories.docx');
  await createDocx(docxPath, markdown);

  const manifest = {
    preparedOn: PREPARED_ON,
    outputDir: OUT_DIR,
    files: {
      userStoriesMarkdown: markdownPath,
      userStoriesDocx: docxPath,
      testDataWorkbook: workbookPath,
    },
    storyCount: userStories.length,
    sheetCount: Object.keys(workbookSheets).length,
    expectedProductGapStories: userStories.filter((s) => s.intent.includes('FAIL_PRODUCT_GAP')).map((s) => s.id),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
