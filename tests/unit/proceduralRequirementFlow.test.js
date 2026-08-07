import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const requirementOracle = require('../../server/services/requirementOracle');
const requirementsRoute = require('../../server/routes/requirements');
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');
const generationCompiler = require('../../server/services/generationCompiler');
const architect = require('../../server/services/agents/architect');
const { MAX_AUTHORED_CASE_STEPS } = require('../../server/lib/stepShape');
const crawlPlanner = require('../../server/lib/crawlPlanner');

const SAMPLE_FLOW = `
Requirement Title: OdysseyOne email classifier Microsoft sign-in opens the Home dashboard

Target URL:
https://qa.example.test/auth/email-classifier?returnUrl=%2Fuser%2Fadministration

Test Data:
Email Address: tester@example.test
Password: Secret-Test-Password-1

Scenario:
Verify that a user can start from the OdysseyOne email classifier URL, continue with the supplied email address, choose Microsoft sign-in, complete the Microsoft login form with the same email address and password, and land on the OdysseyOne Home dashboard.

Authoring Rule:
This is one continuous login flow and should be generated as one test case in one fresh browser session. Do not split the email classifier step, Microsoft sign-in step, and final dashboard validation into separate independent test cases.

Test Case: Login through email classifier and Microsoft sign-in

Steps:
1. Open a fresh browser session.
2. Navigate to https://qa.example.test/auth/email-classifier?returnUrl=%2Fuser%2Fadministration.
3. In the Email Address field, enter tester@example.test.
4. Click the Continue button.
5. Verify that the Sign in with Microsoft option is displayed.
6. Click Sign in with Microsoft.
7. On the Microsoft sign-in page, enter tester@example.test in the email, phone, or Skype field.
8. Click the Next button.
9. Enter Secret-Test-Password-1 in the password field.
10. Click the Sign in button.
11. If Microsoft asks whether to stay signed in, choose the option that continues to the application.
12. Verify that the OdysseyOne Home dashboard is displayed.

Final Validation:
The test passes only when the authenticated OdysseyOne dashboard is visible after login. Use visible dashboard text from the application as the final assertion. Valid final dashboard signals include:
- OdysseyONE logo
- Home
- Welcome OdysseyOne!
- What would you like to do?
- Go to Create a New Order
- Management Users

Preferred Final Assertion:
Verify that the Home page is displayed and the text "Welcome OdysseyOne!" is visible.

Session Policy:
sessionMode: fresh
dependsOnIds: none
failurePolicy: block_dependents

Data Binding Rule:
Use the exact email address and password from the Test Data section. Do not invent substitute credentials. Do not generate draft or placeholder credentials.

Expected Scenario/Test Case Shape:
Expected scenario count: 1
Expected test case count: 1
Reason: this is one coherent authentication flow with one final business outcome, not separate independent behaviors.
`;

const SAMPLE_APPEND_CONTINUATION_FLOW = `
Suite: OdysseyOne authenticated user management continuation flow
Existing prerequisite test case:
TC-1 - Login through email classifier and Microsoft sign-in, ending on the OdysseyOne Home dashboard.
New test case:
TC-2 - Continue from Home dashboard to validate User Management tabs and user profile locked fields.
Dependency and session contract:
TC-2 depends on TC-1.
sessionMode: continue_from_dependency
failurePolicy: block_dependents
TC-2 must continue in the same authenticated browser session created by TC-1.
Do not start a fresh browser session for TC-2.
Do not navigate back to the login page.
Do not repeat email classifier login or Microsoft login.
Starting state:
TC-1 has passed.
The browser is already authenticated and remains on the OdysseyOne Home dashboard.
The Home page shows the text Welcome OdysseyOne.
Inline test data:
Expected Home validation text: Welcome OdysseyOne
Target menu tooltip: User Management
Expected User Management page title: User Management
Expected User Management breadcrumb or navigation context: Dashboard > User Management
Expected tabs and counts:
All Users = 66
Active = 63
Locked = 1
Terminated = 2
Expected record count text: 66 Records found
Expected pagination text: Showing 1 to 50 of 66
Target user link text: Pranavijay Ikhar
Target user URL path: /user/view-user/3460
Expected User Profile page title: User Profile
Expected User Profile breadcrumb: User Management > User Profile
Expected first name: pranavijay
Expected last name: ikhar
Expected profile initials: PI
Blocked-field probe values:
Email ID probe value: blocked.email@example.com
First Name probe value: BlockedFirst
Middle Name probe value: BlockedMiddle
Last Name probe value: BlockedLast
User Name probe value: Blocked User
Contact Number probe value: 9999999999
Test steps:
1. Verify the continuation start state.
   Confirm the browser is still authenticated and the Home dashboard is visible.
   Validate that the page contains Welcome OdysseyOne.
   This is a continuation from TC-1, so do not perform login again.
2. Hover over the left-side menu icons from top to bottom.
   Continue hovering menu icons until the tooltip text User Management appears.
   As soon as the User Management tooltip appears, stop checking the remaining menu icons and click the User Management icon immediately.
3. Wait for the User Management page to load.
   Wait until the User Management title, tabs, and records table are visible.
   Wait up to 10 seconds.
   If the table or page content is not visible within 5 seconds, refresh or reload the current User Management page once, then wait again until the title, tabs, and records table are visible.
   If the content loads before 5 seconds, continue immediately.
4. Validate the User Management page.
5. Validate the tab counts and record count.
   Confirm All Users shows 64.
   Confirm Active shows 61.
   Confirm the page shows 64 Records found.
6. Open the target user profile.
   In the records table, find and click the user link Pranavijay Ikhar.
7. Validate the User Profile page.
8. Validate the profile avatar initials.
9. Validate profile field values before editing attempts.
10. Verify the profile input fields are blocked through Contact Number only.
11. Final validation.
Validation guidance:
Text validations should be tolerant for casing and whitespace.
Numeric counts must match exactly.
`;

describe('procedural requirement flow ingestion', () => {
  it('preserves coherent authored cases through 100 steps without the old 18-step split rule', () => {
    const makeCase = (count) => ({
      name: `Continuous ${count}-step flow`,
      type: 'functional',
      steps: Array.from({ length: count }, (_, index) => ({
        order: index + 1,
        action: 'Verify',
        element: `Control ${index + 1}`,
        expected: `Control ${index + 1} is visible`,
      })),
    });

    expect(MAX_AUTHORED_CASE_STEPS).toBe(100);
    expect(architect.normaliseCase(makeCase(55)).steps).toHaveLength(55);
    expect(architect.normaliseCase(makeCase(100)).steps).toHaveLength(100);
    expect(() => architect.normaliseCase(makeCase(101))).toThrow(/maximum is 100/i);
    expect(architect.SYSTEM_PROMPT).toContain('100 or fewer steps');
    expect(architect.SYSTEM_PROMPT).not.toMatch(/MORE than ~18 steps/i);
  });

  it('classifies scenario/test-case/steps text files as requirement documents', () => {
    expect(requirementsRoute._private.guessCategory('email_classifier_login_flow.txt', SAMPLE_FLOW)).toBe('user-stories');
  });

  it('does not inflate supporting steps, data notes, or final-oracle signal bullets into clauses', async () => {
    const clauses = requirementOracle.deterministicSplit(SAMPLE_FLOW);

    expect(clauses.some((clause) => clause.includes('can start from the OdysseyOne email classifier URL'))).toBe(true);
    expect(clauses.some((clause) => clause.includes('Welcome OdysseyOne'))).toBe(true);
    expect(clauses.some((clause) => clause.includes('What would you like to do'))).toBe(false);
    expect(clauses.some((clause) => clause.includes('Go to Create a New Order'))).toBe(false);
    expect(clauses.some((clause) => clause.includes('Do not generate draft'))).toBe(false);
    expect(clauses.some((clause) => clause.includes('one continuous login flow'))).toBe(false);
    expect(clauses.length).toBeLessThanOrEqual(4);

    const extracted = await requirementOracle.extractRequirements({
      documents: [{ id: 'doc-flow', name: 'email_classifier_login_flow.txt', category: 'user-stories', content: SAMPLE_FLOW }],
      projectId: 'project-flow',
    });
    expect(extracted.requirements.length).toBeLessThanOrEqual(4);
  });

  it('extracts explicit one-flow shape and inline test data from procedural files', () => {
    const contract = proceduralFlowContract.extractProceduralFlowContract([
      { title: 'flow', content: SAMPLE_FLOW },
    ]);

    expect(contract.isProcedural).toBe(true);
    expect(contract.strictOneCase).toBe(true);
    expect(contract.expectedScenarioCount).toBe(1);
    expect(contract.expectedTestCaseCount).toBe(1);
    expect(contract.testData).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Email Address', token: 'email', value: 'tester@example.test' }),
      expect.objectContaining({
        label: 'Password',
        token: 'password',
        value: '${QAAI_INLINE_PASSWORD}',
        classification: 'sensitive',
        source: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD' },
      }),
    ]));
    expect(contract.finalAssertions).toContain('Welcome OdysseyOne!');
    expect(JSON.stringify(contract)).not.toContain('Secret-Test-Password-1');
  });

  it('keeps initial-upload procedural values literal when no workbook is selected', () => {
    const contract = proceduralFlowContract.extractProceduralFlowContract([
      { title: 'flow', content: SAMPLE_FLOW },
    ]);
    const suite = [{
      name: 'OdysseyOne email classifier Microsoft sign-in',
      module: 'auth',
      cases: [{
        name: 'Full SSO login from fresh session',
        type: 'functional',
        confidence: 95,
        automatability: 'automatable',
        assertions: 'Verify Welcome OdysseyOne! is visible.',
        requirementRefs: ['REQ-flow'],
        steps: [
          { action: 'Navigate', element: 'Target URL', value: 'https://qa.example.test/auth/email-classifier?returnUrl=%2Fuser%2Fadministration' },
          { action: 'Fill', element: 'Email Address', value: '{{email}}' },
          { action: 'Click', element: 'Continue' },
          { action: 'Click', element: 'Sign in with Microsoft' },
          { action: 'Fill', element: 'Email, phone, or Skype', value: '{{email}}' },
          { action: 'Click', element: 'Next' },
          { action: 'Fill', element: 'Password', value: '{{password}}' },
          { action: 'Click', element: 'Sign in' },
          { action: 'Verify', element: 'Home dashboard', expected: 'Welcome OdysseyOne!' },
        ],
        declaredAssertions: [{
          id: 'ASN-dashboard',
          type: 'TEXT',
          criticality: 'must',
          payload: { expectedText: 'Welcome OdysseyOne!' },
        }],
      }],
    }];

    const compiled = generationCompiler.compileGeneration({
      scenarios: suite,
      proceduralFlowContract: contract,
      atlasHasCapabilities: false,
    });

    expect(compiled.report.ready).toBe(1);
    expect(compiled.report.blocked).toBe(0);
    expect(compiled.report.notReady).toHaveLength(0);
    const readyCase = compiled.readyScenarios[0].cases[0];
    expect(JSON.stringify(readyCase.steps)).not.toContain('{{email}}');
    expect(JSON.stringify(readyCase.steps)).not.toContain('{{password}}');
    expect(JSON.stringify(readyCase.steps)).toContain('tester@example.test');
    expect(JSON.stringify(readyCase.steps)).toContain('Secret-Test-Password-1');
    const emailSteps = readyCase.steps.filter((step) => step.value === 'tester@example.test');
    expect(emailSteps).toHaveLength(2);
    expect(emailSteps.every((step) => step.dataRef == null)).toBe(true);
    expect(readyCase.dataBinding == null).toBe(true);
    expect(readyCase.caseContractV1.dataBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'data.password',
        classification: 'sensitive',
        source: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD' },
      }),
    ]));
  });

  it('keeps every unmapped Add Scenario inline value literal, including credentials', () => {
    const source = `
New test case:
TC-2 - Validate User Management counts.

Inline test data:
Target menu tooltip: User Management
All Users = 66
Active = 63
Password: Never-Persist-This-Secret

Test steps:
1. Verify User Management is visible.
2. Verify All Users = 66.
3. Verify Active = 63.
4. Enter Never-Persist-This-Secret in the Password field.

Final validation:
Verify User Management is visible.
`;
    const contract = proceduralFlowContract.extractProceduralFlowContract([{
      id: 'append-design:project:user-management',
      source: 'add_scenario',
      content: source,
    }]);
    const suite = [{
      name: 'User Management continuation',
      module: 'User Management',
      cases: [{
        name: 'Validate User Management counts All Users 66 Active 63',
        type: 'functional',
        confidence: 90,
        automatability: 'automatable',
        assertions: 'User Management is visible; All Users = 66; Active = 63.',
        dataBinding: {
          source: 'inline_requirement_text',
          matchKind: 'inline_values',
          inlineValues: { targetPageTitle: 'User Management', allUsers: '66', active: '63' },
        },
        steps: [
          { action: 'Verify', element: 'User Management page', expected: 'User Management is visible.' },
          { action: 'Verify', element: 'All Users count', expected: 'All Users = 66' },
          { action: 'Verify', element: 'Active count', expected: 'Active = 63' },
          { action: 'Fill', element: 'Password', value: 'Never-Persist-This-Secret' },
        ],
        declaredAssertions: [{
          id: 'ASN-user-management',
          type: 'TEXT',
          criticality: 'must',
          payload: { expectedText: 'User Management' },
        }],
      }],
    }];

    const compiled = generationCompiler.compileGeneration({
      scenarios: suite,
      proceduralFlowContract: contract,
      testData: null,
      atlasHasCapabilities: false,
    });

    // Add Scenario intentionally persists the compiled candidate for review even
    // when an unrelated readiness advisory exists, so assert the shape the route
    // actually saves (`gc.scenarios`), not the full-generation ready-only subset.
    const compiledCase = compiled.scenarios[0].cases[0];
    const visibleCase = JSON.stringify({
      name: compiledCase.name,
      assertions: compiledCase.assertions,
      steps: compiledCase.steps,
      declaredAssertions: compiledCase.declaredAssertions,
    });
    expect(visibleCase).toContain('User Management');
    expect(visibleCase).toContain('All Users = 66');
    expect(visibleCase).toContain('Active = 63');
    expect(visibleCase).not.toContain('{{target_menu_tooltip}}');
    expect(visibleCase).not.toContain('{{all_users}}');
    expect(visibleCase).not.toContain('{{active}}');
    expect(visibleCase).toContain('Never-Persist-This-Secret');
    expect(visibleCase).not.toContain('{{password}}');
    expect(compiledCase.dataBinding).toBeNull();

    const lineageOnly = {
      steps: [{ action: 'Verify', expected: 'All Users = 66' }],
      caseContractV1: compiledCase.caseContractV1,
      inlineRequirementData: compiledCase.inlineRequirementData,
    };
    expect(generationCompiler.caseConsumesRowData(lineageOnly)).toBe(false);
    expect(generationCompiler.caseConsumesRowData({
      ...lineageOnly,
      steps: [{ action: 'Verify', expected: 'All Users = {{all_users}}' }],
    })).toBe(true);
  });

  it('keeps the existing token path when Add Scenario selected a real mapped workbook sheet', () => {
    const source = `
Test data:
Search Name: Alice

Test case: Search for the mapped employee
Test steps:
1. Enter Alice in the Search Name field.
2. Verify Results is visible.
`;
    const contract = proceduralFlowContract.extractProceduralFlowContract([{
      id: 'append-design:project:mapped-search',
      source: 'add_scenario',
      content: source,
    }]);
    const suite = [{
      name: 'Mapped search',
      module: 'Search',
      cases: [{
        name: 'Search for Alice',
        type: 'functional',
        confidence: 90,
        automatability: 'automatable',
        assertions: 'Results is visible.',
        dataBinding: {
          sheet: 'SearchData',
          status: 'complete',
          columnToField: { search_name: 'Search Name' },
        },
        steps: [
          { action: 'Fill', element: 'Search Name', value: 'Alice' },
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
    const testData = {
      sheets: [{ name: 'SearchData', headers: ['Search Name'], rows: [{ 'Search Name': 'Alice' }] }],
      mapping: { bindings: [{ sheet: 'SearchData', columnToField: { search_name: 'Search Name' } }] },
    };

    const compiled = generationCompiler.compileGeneration({
      scenarios: suite,
      proceduralFlowContract: contract,
      preserveUnmappedProceduralLiterals: true,
      testData,
      atlasHasCapabilities: false,
    });

    const compiledCase = compiled.scenarios[0].cases[0];
    expect(compiledCase.steps[0].value).toBe('{{search_name}}');
    expect(compiledCase.dataBinding.sheet).toBe('SearchData');
  });

  it('repairs missing procedural final assertions before zero-assertion demotion', () => {
    const contract = proceduralFlowContract.extractProceduralFlowContract([
      { title: 'flow', content: SAMPLE_FLOW },
    ]);
    const suite = [{
      name: 'OdysseyOne email classifier Microsoft sign-in',
      module: 'auth',
      cases: [{
        name: 'Full SSO login from fresh session',
        type: 'functional',
        confidence: 95,
        automatability: 'automatable',
        requirementRefs: ['REQ-flow'],
        steps: [
          { action: 'Navigate', element: 'Target URL', value: 'https://qa.example.test/auth/email-classifier?returnUrl=%2Fuser%2Fadministration' },
          { action: 'Fill', element: 'Email Address', value: '{{email}}' },
          { action: 'Click', element: 'Continue' },
          { action: 'Click', element: 'Sign in with Microsoft' },
          { action: 'Fill', element: 'Password', value: '{{password}}' },
          { action: 'Verify', element: 'Home dashboard', expected: 'Welcome OdysseyOne!' },
        ],
        declaredAssertions: [],
      }],
    }];

    const before = JSON.parse(JSON.stringify(suite));
    expect(architect.demoteZeroAssertionAutomation(before).demotedCount).toBe(1);

    const repaired = architect.ensureProceduralFinalAssertions(suite, contract);
    expect(repaired.added).toBe(1);
    expect(architect.demoteZeroAssertionAutomation(suite).demotedCount).toBe(0);
    expect(suite[0].cases[0].automatability).toBe('automatable');
    expect(suite[0].cases[0].declaredAssertions[0]).toMatchObject({
      type: 'TEXT',
      criticality: 'must',
      provenance: 'uploaded_requirement',
      payload: { expectedText: 'Welcome OdysseyOne!' },
    });
  });

  it('uses pasted Add Scenario procedural text for timeout fallback instead of inventing QAAI modal steps', () => {
    const scenario = architect.deterministicScenarioFromPack({
      coverageRef: 'append-design:project:user-management-continuation',
      storyId: 'append-design:project:user-management-continuation',
      title: 'Add Scenario request',
      source: 'add_scenario',
      sourceText: SAMPLE_APPEND_CONTINUATION_FLOW,
      requiredActions: ['verify'],
    }, 'single_pack_provider_timeout');

    const serialized = JSON.stringify(scenario);
    expect(scenario.name).toBe('OdysseyOne authenticated user management continuation flow');
    expect(scenario.cases).toHaveLength(1);
    expect(serialized).toContain('User Management');
    expect(serialized).toContain('Pranavijay Ikhar');
    expect(serialized).toContain('/user/view-user/3460');
    expect(serialized).toContain('PI');
    expect(serialized).toContain('66 Records found');
    const waitStep = scenario.cases[0].steps.find((step) => step.action === 'Wait');
    expect(waitStep).toBeTruthy();
    expect(waitStep.expected).toContain('Wait up to 10 seconds');
    expect(waitStep.expected).toContain('missing after 5 seconds');
    expect(waitStep.expected).toContain('Continue immediately');
    expect(waitStep.operationCheck).toMatchObject({
      kind: 'page_ready',
      timeoutMs: 10_000,
      refreshAfterMs: 5_000,
      recovery: { action: 'reload', maxAttempts: 1 },
    });
    expect(waitStep.operationCheck.expected).toBe(waitStep.expected);
    expect(waitStep.waitContract).toMatchObject({ timeoutMs: 10_000, refreshAfterMs: 5_000 });
    const countSteps = scenario.cases[0].steps.filter((step) => step.operationCheck?.kind === 'count_matches');
    expect(countSteps.filter((step) => step.element === 'All Users count')).toHaveLength(1);
    expect(countSteps.find((step) => step.element === 'All Users count')?.expected).toContain('66');
    expect(countSteps.find((step) => step.element === 'Active count')?.expected).toContain('63');
    expect(countSteps.some((step) => /All Users count is 64|Active count is 61/.test(step.expected))).toBe(false);

    const proceduralContract = proceduralFlowContract.extractProceduralFlowContract([{
      id: 'append-design:project:user-management-continuation',
      source: 'add_scenario',
      content: SAMPLE_APPEND_CONTINUATION_FLOW,
    }]);
    const compiled = generationCompiler.compileGeneration({
      scenarios: [scenario],
      proceduralFlowContract: proceduralContract,
      preserveUnmappedProceduralLiterals: true,
      testData: null,
      atlasHasCapabilities: false,
    });
    const persistedCase = compiled.scenarios[0].cases[0];
    const persistedVisibleFields = JSON.stringify({
      name: persistedCase.name,
      assertions: persistedCase.assertions,
      steps: persistedCase.steps,
      declaredAssertions: persistedCase.declaredAssertions,
    });
    expect(persistedVisibleFields).toContain('User Management');
    expect(persistedVisibleFields).toContain('All Users = 66');
    expect(persistedVisibleFields).toContain('Active = 63');
    expect(persistedVisibleFields).not.toMatch(/\{\{\s*(?:target_menu_tooltip|all_users|active|expected_record_count_text)\s*\}\}/i);
    expect(serialized).not.toContain('Save button');
    expect(serialized).not.toContain('Required field validation');
    expect(serialized).not.toContain('Add Scenario request page is available');
  });

  it('uses a sole authored five-second wait as the maximum instead of the default', () => {
    const fiveSecondSource = SAMPLE_APPEND_CONTINUATION_FLOW
      .replace('Wait up to 10 seconds.', 'Wait 5 seconds.')
      .replace(
        'If the table or page content is not visible within 5 seconds, refresh or reload the current User Management page once, then wait again until the title, tabs, and records table are visible.',
        'Refresh or reload the current User Management page once if the required content is still missing.',
      )
      .replace('If the content loads before 5 seconds, continue immediately.', '');
    const scenario = architect.deterministicScenarioFromPack({
      coverageRef: 'append-design:project:five-second-wait',
      storyId: 'append-design:project:five-second-wait',
      title: 'Add Scenario request',
      source: 'add_scenario',
      sourceText: fiveSecondSource,
      requiredActions: ['verify'],
    }, 'single_pack_provider_timeout');

    const waitStep = scenario.cases[0].steps.find((step) => step.action === 'Wait');
    expect(waitStep.expected).toContain('Wait up to 5 seconds');
    expect(waitStep.operationCheck.timeoutMs).toBe(5_000);
    expect(waitStep.operationCheck.refreshAfterMs).toBeUndefined();
    expect(waitStep.waitContract.timeoutMs).toBe(5_000);
  });

  it('does not confuse a recovery threshold with the total wait deadline', () => {
    const thresholdOnlySource = SAMPLE_APPEND_CONTINUATION_FLOW
      .replace('Wait up to 10 seconds.', 'Wait until the requested page content is visible.')
      .replace(/within 5 seconds/g, 'within 3 seconds')
      .replace(/before 5 seconds/g, 'before 3 seconds');

    const scenario = architect.deterministicScenarioFromPack({
      coverageRef: 'append-design:project:threshold-only-wait',
      storyId: 'append-design:project:threshold-only-wait',
      title: 'Add Scenario request',
      source: 'add_scenario',
      sourceText: thresholdOnlySource,
      requiredActions: ['verify'],
    }, 'single_pack_provider_timeout');

    const waitStep = scenario.cases[0].steps.find((step) => step.action === 'Wait');
    expect(waitStep.expected).toContain('Wait up to 10 seconds');
    expect(waitStep.expected).toContain('missing after 3 seconds');
    expect(waitStep.operationCheck.timeoutMs).toBe(10_000);
    expect(waitStep.operationCheck.refreshAfterMs).toBe(3_000);
  });

  it('flags Add Scenario provider output that contains placeholders or empty action steps', () => {
    const defects = architect.appendScenarioOutputDefects([{
      name: 'Continuation flow',
      cases: [{
        name: 'Continuation case',
        steps: [
          { order: 1, action: 'Verify', value: '{{odysseyone_home_dashboard_url}}' },
          { order: 2, action: 'Verify' },
          { order: 3, action: 'Navigate', value: '{{shipment_search_url}}' },
        ],
      }],
    }]);

    expect(defects).toContain('unresolved_placeholder:{{odysseyone_home_dashboard_url}}');
    expect(defects).toContain('unresolved_placeholder:{{shipment_search_url}}');
    expect(defects.some((defect) => defect.startsWith('empty_verify_step:'))).toBe(true);
  });

  it('keeps Add Scenario timeout fallback generic and grounded only in pasted target-app text', () => {
    const sourceText = [
      'Suite: Warehouse order review continuation flow',
      'Existing prerequisite test case:',
      'TC-1 - Login and land on the Warehouse Dashboard.',
      'New test case:',
      'TC-2 - Continue from the dashboard to validate order records and locked fields.',
      'Dependency and session contract:',
      'TC-2 depends on TC-1.',
      'sessionMode: continue_from_dependency',
      'Starting state:',
      'TC-1 has passed and the browser remains on the Warehouse Dashboard.',
      'Inline test data:',
      'Expected start validation text: Warehouse Dashboard',
      'Target menu tooltip: Orders',
      'Expected Orders page title: Orders',
      'Expected tabs and counts:',
      'Open = 12',
      'Closed = 3',
      'Expected record count text: 15 Records found',
      'Target order link text: Order A-100',
      'Target order URL path: /orders/A-100',
      'Expected detail page title: Order Details',
      'Expected order status: Open',
      'Blocked-field probe values:',
      'Order Name probe value: Probe Order',
      'Test steps:',
      '1. Verify the continuation start state and confirm Warehouse Dashboard is visible.',
      '2. Hover menu icons until the Orders tooltip appears, then click Orders.',
      '3. Wait until the Orders page title, tabs, and records table are visible.',
      '4. Confirm Open shows 12, Closed shows 3, and 15 Records found is visible.',
      '5. Click Order A-100 and confirm /orders/A-100 is loaded.',
      '6. Confirm Order Details is visible and order status is Open.',
      '7. Try entering Probe Order in Order Name and confirm the value is blocked.',
    ].join('\n');

    const scenario = architect.deterministicScenarioFromPack({
      coverageRef: 'append-design:project:warehouse-order-continuation',
      storyId: 'append-design:project:warehouse-order-continuation',
      title: 'Add Scenario request',
      source: 'add_scenario',
      sourceText,
      requiredActions: ['verify'],
    }, 'single_pack_provider_timeout');

    const serialized = JSON.stringify(scenario);
    const steps = scenario.cases[0].steps;
    expect(serialized).toContain('Warehouse order review continuation flow');
    expect(serialized).toContain('Warehouse Dashboard');
    expect(serialized).toContain('Orders');
    expect(serialized).toContain('Order A-100');
    expect(serialized).toContain('/orders/A-100');
    expect(serialized).toContain('15 Records found');
    expect(steps.some((step) => step.action === 'Wait' && step.stepKind === 'verification')).toBe(true);
    const defaultWaitStep = steps.find((step) => step.action === 'Wait');
    expect(defaultWaitStep.expected).toContain('Wait up to 10 seconds');
    expect(defaultWaitStep.operationCheck.timeoutMs).toBe(10_000);
    expect(defaultWaitStep.operationCheck.refreshAfterMs).toBeUndefined();
    expect(steps.some((step) => step.action === 'Hover'
      && step.operationCheck?.kind === 'tooltip_visible'
      && step.operationCheck?.required !== true
      && step.operationCheck?.condition?.text === 'Orders')).toBe(true);
    expect(steps.some((step) => step.action === 'Click'
      && step.operationCheck?.kind === 'page_ready'
      && step.operationCheck?.required === true
      && step.operationCheck?.condition?.text === 'Orders')).toBe(true);
    expect(steps.some((step) => step.element === 'Open count'
      && step.operationCheck?.kind === 'count_matches'
      && step.operationCheck?.required !== true
      && step.operationCheck?.condition?.expectedValue === '12')).toBe(true);
    expect(steps.some((step) => step.element === 'Closed count'
      && step.operationCheck?.kind === 'count_matches'
      && step.operationCheck?.required !== true
      && step.operationCheck?.condition?.expectedValue === '3')).toBe(true);
    expect(steps.some((step) => step.element === 'Record count summary' && step.expected.includes('15 Records found'))).toBe(true);
    expect(steps.some((step) => step.operationCheck?.kind === 'field_blocked'
      && step.operationCheck?.required === true
      && step.operationCheck?.condition?.field === 'Order Name'
      && step.operationCheck?.condition?.probeValue === 'Probe Order')).toBe(true);
    expect(serialized).not.toContain('Save button');
    expect(serialized).not.toContain('Required field validation');
    expect(serialized).not.toContain('Add Scenario request page is available');
  });

  it('refuses Add Scenario fallback when only QAAI modal metadata is available', () => {
    expect(() => architect.deterministicScenarioFromPack({
      coverageRef: 'append-design:project:missing-user-flow',
      storyId: 'append-design:project:missing-user-flow',
      title: 'Add Scenario request',
      name: 'Add Scenario request',
      source: 'add_scenario',
      requiredActions: ['verify'],
    }, 'single_pack_provider_timeout')).toThrow(/fallback refused to generate/i);

    expect(() => architect.deterministicScenarioFromPack({
      coverageRef: 'append-design:project:modal-noise',
      storyId: 'append-design:project:modal-noise',
      title: 'Add Scenario request',
      source: 'add_scenario',
      sourceText: 'Add Scenario request page is available. Click Save button. Required field validation message is required.',
      requiredActions: ['verify'],
    }, 'single_pack_provider_timeout')).toThrow(/fallback refused to generate/i);
  });

  it('does not force short Add Scenario user stories through the step-by-step compiler', () => {
    expect(() => architect.deterministicScenarioFromPack({
      coverageRef: 'append-design:project:user-story-only',
      storyId: 'append-design:project:user-story-only',
      title: 'Validate user administration',
      source: 'add_scenario',
      sourceText: [
        'Flow: Admin should be able to review user administration after login.',
        'Validate that user records, status tabs, and profile details are available.',
        'This is a continuation from the existing login test case.',
      ].join('\n'),
      requiredActions: ['verify'],
    }, 'authoritative_pasted_add_scenario_procedure')).toThrow(/fallback refused to generate/i);
  });

  it('does not reuse a recent atlas when the persisted sufficiency is insufficient', () => {
    const decision = crawlPlanner.decideAtlasRefresh({
      explicitRefresh: false,
      latestAtlas: {
        startUrl: 'https://qa.example.test/auth/email-classifier',
        authProfileId: null,
        crawlMode: 'deep',
        sufficiency: 'insufficient',
        completedAt: new Date('2026-07-07T10:00:00Z'),
      },
      targetUrl: 'https://qa.example.test/auth/email-classifier',
      authProfileId: null,
      crawlMode: 'deep',
      now: new Date('2026-07-07T10:30:00Z').getTime(),
      staleMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(decision.refresh).toBe(true);
    expect(decision.reason).toContain('insufficient');
  });

  it('does not reuse a recent partial atlas when complete/deep coverage is requested', () => {
    const decision = crawlPlanner.decideAtlasRefresh({
      explicitRefresh: false,
      latestAtlas: {
        startUrl: 'https://qa.example.test/auth/email-classifier',
        authProfileId: null,
        crawlMode: 'deep',
        sufficiency: 'partial',
        completedAt: new Date('2026-07-07T10:00:00Z'),
      },
      targetUrl: 'https://qa.example.test/auth/email-classifier',
      authProfileId: null,
      crawlMode: 'deep',
      now: new Date('2026-07-07T10:30:00Z').getTime(),
      staleMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(decision.refresh).toBe(true);
    expect(decision.reason).toContain('partial');
  });

  it('defaults crawl scope to the requested entry page and requires explicit whole-site traversal', () => {
    expect(crawlPlanner.resolveCrawlScope()).toBe('entry-page');
    expect(crawlPlanner.resolveCrawlScope('unknown-client-value')).toBe('entry-page');
    expect(crawlPlanner.resolveCrawlScope('content links')).toBe('entry-page');
    expect(crawlPlanner.resolveCrawlScope('site')).toBe('site');
    expect(crawlPlanner.resolveCrawlScope('whole-site')).toBe('site');
  });

  it('keeps complete/deep crawl from stopping a module after only four pages', () => {
    const deep = crawlPlanner.crawlBudget('deep');

    expect(deep.pagesPerModule).toBeGreaterThanOrEqual(10);
    expect(deep.otherPagesPerModule).toBeGreaterThanOrEqual(10);
    expect(deep.scrollSnapshotsPerPage).toBeGreaterThan(0);
    expect(deep.modalProbeBudgetPerPage).toBeGreaterThan(0);
    expect(crawlPlanner.withinModuleBudget('https://qa.example.test/user', new Map([
      ['https://qa.example.test/user', 4],
    ]), deep)).toBe(true);
  });

  it('collapses repeated record-detail URLs into one crawl route template', () => {
    const first = crawlPlanner.normalizeRecordRouteTemplate('https://qa.example.test/user/view-user/32');
    const second = crawlPlanner.normalizeRecordRouteTemplate('https://qa.example.test/user/view-user/21');

    expect(first).toBe('https://qa.example.test/user/view-user/:id');
    expect(second).toBe(first);
    expect(crawlPlanner.normalizeRecordRouteTemplate('https://qa.example.test/user/administration')).toBeNull();
    expect(crawlPlanner.normalizeRecordRouteTemplate('https://qa.example.test/order/detail/019f3d8a-836f-7fad-a4a9-447dca574135')).toBe('https://qa.example.test/order/detail/:id');
  });
});
