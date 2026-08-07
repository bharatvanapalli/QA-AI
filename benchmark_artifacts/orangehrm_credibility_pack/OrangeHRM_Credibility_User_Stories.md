# OrangeHRM Credibility Benchmark User Stories

Prepared: 2026-06-28

## Purpose

This pack is designed to prove whether QAAI can generate and execute useful scenarios from a clean requirements document plus a clean test-data workbook. It deliberately avoids the previously broken user stories and broken data bindings. Every story begins with a normal Admin login. Expected product-gap stories are included so a missing feature becomes a truthful product FAIL, not a fake PASS.

## Ground Rules for QAAI

- Do not reuse any prior generated OrangeHRM stories or prior test-data sheets.
- Start every story with the normal login flow using `ExecutionProfiles.ADMIN_DEFAULT`.
- Bind only to the sheet named by the story. Do not join unrelated sheets unless the story explicitly references `ExecutionProfiles` for login.
- `expectedPlatformVerdict = FAIL_PRODUCT_GAP` means the test is intentionally asking for a capability that the current demo does not expose. The correct result is a product failure with evidence.
- Negative validation rows such as required-field checks are expected to PASS when the application correctly blocks invalid input.
- Never convert a validation row into a success-login row or a product bug.

## Observed Current OrangeHRM Demo Menu Map

| Module | Left Menu Label | Expected Path | Stable Signals |
| --- | --- | --- | --- |
| Dashboard | Dashboard | `/web/index.php/dashboard/index` | Dashboard header; Time at Work widget; My Actions widget; Quick Launch; Buzz Latest Posts |
| Admin | Admin | `/web/index.php/admin/viewSystemUsers` | System Users page; Username filter; User Role filter; Status filter; Add button |
| PIM | PIM | `/web/index.php/pim/viewEmployeeList` | Employee Information; Employee Name; Employee Id; Add Employee |
| Leave | Leave | `/web/index.php/leave/viewLeaveList` | Leave List; From Date; To Date; Show Leave with Status; Employee Name |
| Time | Time | `/web/index.php/time/viewEmployeeTimesheet` | Timesheets; Employee Name; View button; Attendance sub-menu |
| Recruitment | Recruitment | `/web/index.php/recruitment/viewCandidates` | Candidates; Vacancy; Hiring Manager; Status; Add button |
| My Info | My Info | `/web/index.php/pim/viewPersonalDetails` | Personal Details; Contact Details; Emergency Contacts; Dependents; Immigration; Qualifications |
| Performance | Performance | `/web/index.php/performance/searchEvaluatePerformanceReview` | Performance review/search surfaces; Configure/Manage Reviews/Trackers navigation |
| Directory | Directory | `/web/index.php/directory/viewDirectory` | Directory; Employee Name; Job Title; Location; employee cards or No Records Found |
| Maintenance | Maintenance | `/web/index.php/maintenance/purgeEmployee` | Administrator Access password gate; Maintenance section after valid password |
| Claim | Claim | `/web/index.php/claim/viewAssignClaim` | Claim request pages; Submit Claim/My Claims/Employee Claims/Event controls |
| Buzz | Buzz | `/web/index.php/buzz/viewBuzz` | Buzz Newsfeed; post composer; feed entries; comment/like actions |

## User Stories

### US-OHRM-001: Dashboard launchpad proves a clean Admin login and live widgets

- Module: Dashboard
- Intent: Expected PASS
- Actor: HR administrator
- User story: As an HR administrator, I want to log in normally and confirm the dashboard widgets and quick launch shortcuts are visible so I know the session is established and the landing page is usable.
- Data sheets: ExecutionProfiles, Dashboard_QuickLaunch

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Navigate to the OrangeHRM login page.
2. Log in with the ADMIN_DEFAULT profile from ExecutionProfiles.
3. Verify the Dashboard page is reached.
4. Verify Time at Work, My Actions, Quick Launch, and Buzz Latest Posts are visible.
5. Open each configured Quick Launch item from Dashboard_QuickLaunch and verify the target page or page signal appears.

**Acceptance Criteria**
- The user reaches /dashboard/index after login.
- Dashboard widgets are present and not blank.
- Quick Launch shortcuts navigate to the correct modules.

### US-OHRM-002: Global menu navigation covers every visible OrangeHRM module

- Module: Navigation
- Intent: Expected PASS
- Actor: HR administrator
- User story: As an HR administrator, I want to open every left-menu module and verify a stable module-specific signal so broken routing or hidden menu regressions are caught.
- Data sheets: ExecutionProfiles, Menu_Navigation

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. For each row in Menu_Navigation, click the left menu item.
3. Verify the current URL contains the expected path or the page shows the expected stable signal.
4. Return to Dashboard between modules only when the application state becomes ambiguous.

**Acceptance Criteria**
- All visible menu entries are clickable.
- The app does not remain stuck on the prior module.
- Each target page shows its expected page-level signal.

### US-OHRM-003: Admin user search finds enabled Admin users and supports filters

- Module: Admin
- Intent: Expected PASS
- Actor: System administrator
- User story: As a system administrator, I want to search system users by username, role, employee name, and status so I can audit account access.
- Data sheets: ExecutionProfiles, Admin_UserSearch

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Admin > User Management > Users.
3. Apply each Admin_UserSearch row independently.
4. Click Search and verify either a matching row/table result or a clear No Records Found message according to shouldFind.
5. Reset filters between rows.

**Acceptance Criteria**
- Valid filters return a table or matching user row.
- Invalid filters return No Records Found without a crash.
- The Search and Reset controls remain usable after each row.

### US-OHRM-004: Admin missing bulk export is caught as a real product gap

- Module: Admin
- Intent: Expected FAIL_PRODUCT_GAP
- Actor: Compliance administrator
- User story: As a compliance administrator, I want to export the system-user table to CSV from Admin > Users so I can archive monthly access reviews.
- Data sheets: ExecutionProfiles, Admin_MissingFeature_Bugs

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Admin > User Management > Users.
3. Search for enabled users.
4. Verify a visible Export CSV or Download Users control exists.

**Acceptance Criteria**
- This story intentionally expects a feature the current demo does not expose.
- The correct platform result is a product FAIL, not needs_human and not pass.

### US-OHRM-005: PIM creates, searches, and edits an employee record

- Module: PIM
- Intent: Expected PASS
- Actor: HR administrator
- User story: As an HR administrator, I want to add a new employee, find that employee in the employee list, and update a personal-detail field so the PIM lifecycle is covered end to end.
- Data sheets: ExecutionProfiles, PIM_EmployeeLifecycle

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open PIM > Add Employee.
3. Fill first name, middle name, last name, and employee id from PIM_EmployeeLifecycle.
4. Save and verify the Personal Details page opens for the created employee.
5. Return to PIM > Employee List, search by employee id and employee name, and open the record.
6. Update the configured nickname or other safe non-critical field and save.

**Acceptance Criteria**
- Employee creation succeeds with valid required fields.
- The created employee is searchable by id/name.
- A later detail update persists or shows a success toast.

### US-OHRM-006: PIM Add Employee required-field validation stays on the form

- Module: PIM
- Intent: Expected PASS_NEGATIVE_VALIDATION
- Actor: HR administrator
- User story: As an HR administrator, I want Add Employee to block incomplete employee submissions so bad records are not created.
- Data sheets: ExecutionProfiles, PIM_Validation

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open PIM > Add Employee.
3. Apply each PIM_Validation row independently.
4. Leave the field named by emptyField blank, submit, and verify the required error appears.

**Acceptance Criteria**
- The user remains on Add Employee.
- Required validation appears for the missing field.
- No employee details page is reached for invalid rows.

### US-OHRM-007: Leave list and assign leave use real employee/date filters

- Module: Leave
- Intent: Expected PASS_WITH_DEMO_DATA
- Actor: Leave administrator
- User story: As a leave administrator, I want to filter leave requests and attempt an assignment with valid employee/date data so leave workflow controls are verified.
- Data sheets: ExecutionProfiles, Leave_ListFilters, Leave_AssignRequests

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Leave > Leave List and search with the date/status filters from Leave_ListFilters.
3. Open Leave > Assign Leave.
4. Use Leave_AssignRequests rows to fill employee, leave type, from date, to date, duration/comment, then submit only when shouldAssign is Yes.
5. Verify either a success path or a validation message according to the row intent.

**Acceptance Criteria**
- Leave List filters are usable and return either table results or No Records Found.
- Assign Leave validates required employee/date/type data.
- The story does not convert validation rows into product bugs.

### US-OHRM-008: Time module opens timesheets and attendance surfaces

- Module: Time
- Intent: Expected PASS
- Actor: Time administrator
- User story: As a time administrator, I want to search employee timesheets and inspect attendance controls so time tracking navigation and forms are covered.
- Data sheets: ExecutionProfiles, Time_TimesheetSearch

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Time > Timesheets > Employee Timesheets.
3. Search the employee from Time_TimesheetSearch.
4. Verify a timesheet page, validation message, or No Records Found according to expectedOutcome.
5. Open Time > Attendance and verify Punch In/Out or Employee Records controls are present.

**Acceptance Criteria**
- Timesheets page is reachable from normal login.
- Employee search does not crash on valid or no-result data.
- Attendance navigation exposes a stable attendance signal.

### US-OHRM-009: Recruitment adds and searches candidates

- Module: Recruitment
- Intent: Expected PASS
- Actor: Recruiter
- User story: As a recruiter, I want to add a candidate and then find the candidate by name/status so applicant intake is proven.
- Data sheets: ExecutionProfiles, Recruitment_Candidates

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Recruitment > Candidates.
3. Click Add and fill candidate name, email, contact number, keywords, vacancy, consent, and notes from Recruitment_Candidates.
4. Save and verify candidate profile or success toast.
5. Return to Candidates and search by candidate name/status.

**Acceptance Criteria**
- Candidate creation succeeds for valid rows.
- Candidate search/filter controls remain usable.
- Email/required-field validation is respected for invalid validation rows.

### US-OHRM-010: Recruitment missing LinkedIn profile field is caught

- Module: Recruitment
- Intent: Expected FAIL_PRODUCT_GAP
- Actor: Recruiter
- User story: As a recruiter, I want to capture a candidate LinkedIn profile URL during candidate creation so sourcing provenance is retained.
- Data sheets: ExecutionProfiles, Recruitment_MissingFeature_Bugs

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Recruitment > Candidates > Add.
3. Verify a LinkedIn Profile URL field is visible and editable.

**Acceptance Criteria**
- This story intentionally expects a field not exposed by the current demo.
- The correct platform result is product FAIL with evidence that the field is missing.

### US-OHRM-011: Directory search proves employee directory behavior and no-result state

- Module: Directory
- Intent: Expected PASS
- Actor: Employee
- User story: As an employee, I want to search the company directory by name, job title, and location so I can find coworkers or see a clear empty state.
- Data sheets: ExecutionProfiles, Directory_Search

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Directory.
3. Apply each Directory_Search row independently.
4. Verify either employee cards or No Records Found according to shouldFind.
5. Reset filters between rows.

**Acceptance Criteria**
- Directory filters are reachable and usable.
- No-result cases are reported as passing negative checks, not product failures.

### US-OHRM-012: Maintenance password gate blocks wrong password and permits valid password

- Module: Maintenance
- Intent: Expected PASS_MIXED_GATE
- Actor: Maintenance administrator
- User story: As an administrator, I want Maintenance to require password re-authentication so sensitive purge/access-record tools are protected.
- Data sheets: ExecutionProfiles, Maintenance_Access

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Maintenance.
3. For wrong-password rows, enter the invalid password and verify the access page remains with an error.
4. For valid-password rows, enter the valid maintenance password and verify a Maintenance page signal appears.

**Acceptance Criteria**
- Wrong password does not enter Maintenance.
- Valid Admin password passes the gate.
- Results are separated by row intent.

### US-OHRM-013: Claim request form validates event, currency, amount, and remarks

- Module: Claim
- Intent: Expected PASS_WITH_VALIDATION
- Actor: Employee claims administrator
- User story: As a claims user, I want to submit or validate a claim request with event/currency/amount/remarks so expense workflow quality is tested.
- Data sheets: ExecutionProfiles, Claim_Submit

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Claim > Submit Claim or accessible claim request form.
3. Apply Claim_Submit rows.
4. For valid rows, save/submit and verify claim request detail or success message.
5. For validation rows, verify required/amount validation and remain on form.

**Acceptance Criteria**
- Claim module is reachable.
- Required fields and amount validation are enforced.
- A valid claim flow reaches a stable saved/request page where the demo supports it.

### US-OHRM-014: Buzz post composer creates a feed post

- Module: Buzz
- Intent: Expected PASS
- Actor: Employee
- User story: As an employee, I want to post an announcement in Buzz and verify it appears in the latest feed so internal social posting is covered.
- Data sheets: ExecutionProfiles, Buzz_Posts

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Buzz.
3. Create the configured Buzz_Posts text post.
4. Verify the new post text appears in the feed.
5. Optionally add a comment if the comment control is visible.

**Acceptance Criteria**
- Buzz page loads from normal login.
- The text composer accepts a post.
- The posted content appears in the feed or success confirmation appears.

### US-OHRM-015: Buzz scheduled post request is caught as missing capability

- Module: Buzz
- Intent: Expected FAIL_PRODUCT_GAP
- Actor: Internal communications manager
- User story: As an internal communications manager, I want to schedule a Buzz post for a future date and time so announcements can be prepared ahead of release.
- Data sheets: ExecutionProfiles, Buzz_MissingFeature_Bugs

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Buzz.
3. Verify a Schedule Post or Publish Later control exists.

**Acceptance Criteria**
- This story intentionally expects a feature not visible in the current demo.
- The correct result is product FAIL with missing-control evidence.

### US-OHRM-016: My Info validates personal/contact details without corrupting the profile

- Module: My Info
- Intent: Expected PASS_WITH_VALIDATION
- Actor: Logged-in employee
- User story: As a logged-in employee, I want to inspect and safely update non-critical My Info fields while invalid contact formats are rejected.
- Data sheets: ExecutionProfiles, MyInfo_ProfileValidation

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open My Info.
3. Verify Personal Details and Contact Details navigation is present.
4. Apply MyInfo_ProfileValidation rows: valid safe field updates should save; invalid email/contact data should show validation and remain editable.

**Acceptance Criteria**
- My Info opens for the logged-in employee.
- Safe updates show a success toast or persist.
- Invalid formats are blocked with inline validation.

### US-OHRM-017: Performance missing 9-box calibration matrix is caught

- Module: Performance
- Intent: Expected FAIL_PRODUCT_GAP
- Actor: Performance administrator
- User story: As a performance administrator, I want a 9-box talent calibration matrix view so employee potential/performance can be compared visually.
- Data sheets: ExecutionProfiles, Performance_MissingFeature_Bugs

**Normal login flow**
1. Navigate to `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login`.
2. Login with `ExecutionProfiles.profileKey = ADMIN_DEFAULT`.
3. Verify Dashboard is reached before continuing the module workflow.

**Workflow**
1. Log in with ADMIN_DEFAULT.
2. Open Performance.
3. Search or inspect the Performance navigation.
4. Verify a 9-Box Matrix or Talent Calibration view is visible.

**Acceptance Criteria**
- This story intentionally expects a feature not visible in the current demo.
- The correct result is product FAIL, not platform uncertainty.
