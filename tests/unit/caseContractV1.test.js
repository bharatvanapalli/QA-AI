import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const caseContractV1 = require('../../server/services/caseContractV1');
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');
const planningBridge = require('../../server/services/caseContractPlanningBridge');
const testDesignPlanV1 = require('../../server/services/testDesignPlanV1');
const stepCompiler = require('../../server/services/testDesignStepCompiler');
const architect = require('../../server/services/agents/architect');

describe('CaseContractV1', () => {
  it('keeps one authored dropdown or calendar operation as one valued, verified step', () => {
    const source = `
Scenario Title: Populate scheduling controls
Test Steps and Validations:
1. Open the Early Pickup Time dropdown, select 09:00 AM, and verify the selected time.
2. Open the Early Pickup Date calendar and select August 20, 2026.
3. Verify that Early Pickup Date represents August 20, 2026.
`;
    const envelope = caseContractV1.compileCaseContractV1([{ id: 'req-compound', title: 'flow.txt', content: source }]);
    const contract = envelope.cases[0];

    expect(contract.steps).toHaveLength(3);
    expect(contract.steps.map((step) => step.logicalOrdinal)).toEqual([1, 2, 3]);
    expect(contract.steps.every((step) => step.logicalStepId && step.authoredText)).toBe(true);
    expect(contract.steps[0]).toMatchObject({
      type: 'Select',
      target: 'Early Pickup Time dropdown',
      selectionCriteria: { kind: 'exact_text', text: '09:00 AM' },
      verificationPoint: true,
    });
    expect(contract.steps[1]).toMatchObject({
      type: 'Date',
      target: 'Early Pickup Date calendar',
      value: '2026-08-20',
    });
    expect(contract.steps[2]).toMatchObject({ type: 'AssertText' });
    expect(contract.assertions.some((assertion) => assertion.stepId === contract.steps[0].id)).toBe(true);
  });

  it('preserves an authored case failure policy and derives dependency blocking for continuation cases', () => {
    const freshSource = `
Test Case: Fresh authentication
Session Policy:
sessionMode: fresh
failurePolicy: block_dependents
Steps:
1. Navigate to https://example.test/login.
`;
    const continuationSource = `
Test Case: Continue authenticated work
Session Requirement:
continue_from_previous_case
Steps:
1. Click Orders.
`;
    const fresh = caseContractV1.compileCaseContractV1([{ id: 'req-session-policy', content: freshSource }]).cases[0];
    const continuation = caseContractV1.compileCaseContractV1([{ id: 'req-continuation-policy', content: continuationSource }]).cases[0];

    expect(fresh.failurePolicy).toBe('block_dependents');
    expect(continuation.sessionRequirement.mode).toBe('continue_from_case');
    expect(continuation.failurePolicy).toBe('block_dependents');
  });

  it('keeps conditional controls, option predicates, and continuation policy in separate semantic fields', () => {
    const source = `
Scenario Title: Configure a universal planning form
Test Steps and Validations:
1. Verify that the Freight Term field has automatically changed from Pre-Paid to exactly COL. If it has not changed to COL, record a functional validation failure and continue with the next independent step.
2. Inspect whether the Pickup and Delivery section is collapsed; if it is collapsed, click its header or expand control and wait for it to open.
3. Select Ship Date & Time when it is not already selected.
4. Open the Pickup Time Zone dropdown, select an available option whose visible label contains Central, and verify that the selected Pickup Time Zone label contains Central.
`;
    const contract = caseContractV1.compileCaseContractV1([{ id: 'req-semantic-separation', content: source }]).cases[0];

    expect(contract.steps[0]).toMatchObject({
      type: 'AssertText',
      target: 'Freight Term field',
      expected: 'the Freight Term field has automatically changed from Pre-Paid to exactly COL',
      failureBehavior: 'continue',
    });
    expect(contract.steps[0].expected).not.toContain('record a functional validation failure');
    expect(contract.steps[1]).toMatchObject({
      type: 'Expand',
      target: 'Pickup and Delivery section',
      condition: {
        kind: 'authored_predicate',
        predicate: 'Pickup and Delivery section is collapsed',
        onFalse: 'skip',
      },
    });
    expect(contract.steps[2]).toMatchObject({
      type: 'Radio',
      target: 'Ship Date & Time',
      value: true,
      checked: true,
    });
    expect(contract.steps[3]).toMatchObject({
      type: 'Select',
      target: 'Pickup Time Zone dropdown',
      selectionCriteria: { kind: 'predicate', expectedText: 'Central' },
      verificationPoint: true,
    });
    expect(contract.steps[3].selectionCriteria.expectedText).toBe('Central');
  });

  it('inherits a control only by explicit reference and clears it at a scope boundary', () => {
    const source = `
Scenario Title: Keep control target scope local
Test Steps and Validations:
1. Click the Freight Term dropdown.
2. Select COL from that dropdown.
3. Scroll the Pickup and Delivery section into view.
4. Select LTL.
`;
    const contract = caseContractV1.compileCaseContractV1([{ id: 'req-target-scope', content: source }]).cases[0];
    const selections = contract.steps.filter((step) => step.type === 'Select');

    expect(selections[0]).toMatchObject({
      target: 'Freight Term dropdown',
      selectionCriteria: { kind: 'exact_text', text: 'COL' },
    });
    expect(selections[1]).toMatchObject({
      selectionCriteria: { kind: 'exact_text', text: 'LTL' },
    });
    expect(selections[1]).not.toHaveProperty('target');
    expect(selections[1]).not.toHaveProperty('element');
  });

  it('compiles headings, numbered steps, bullets, and key=value data without losing order', () => {
    const source = `
Requirement Title: Generic repeated-identity flow

Test Data:
email=person@example.test
password=Never-Persist-This-Secret
unused_note=not consumed

Scenario:
The user supplies the same email on two separate prompts before authentication.

Steps:
1. Navigate to https://example.test/start.
2. Enter person@example.test in the Email field.
- Click Continue.
4. Enter person@example.test in the confirmation Email field.
5. Enter Never-Persist-This-Secret in the Password field.
6. Verify that the Home heading is visible.

Final Validation:
- Home is visible.
`;
    const envelope = caseContractV1.compileCaseContractV1([{ id: 'req-1', title: 'flow.txt', content: source }]);
    const contract = envelope.cases[0];

    expect(contract.steps.map((step) => step.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(contract.steps.map((step) => step.type)).toEqual([
      'Navigate', 'Fill', 'Click', 'Fill', 'Fill', 'AssertVisible',
    ]);
    const repeatedEmail = contract.steps.filter((step) => step.dataRefs.includes('data.email'));
    expect(repeatedEmail).toHaveLength(2);
    expect(repeatedEmail.every((step) => step.text.includes('person@example.test'))).toBe(true);
    expect(contract.steps.find((step) => step.dataRefs.includes('data.password'))?.text)
      .toContain('env:QAAI_INLINE_PASSWORD');
    expect(contract.unusedDataRefs).toContain('data.unused_note');
    expect(envelope.unusedDataRefs).toContain('data.unused_note');
    expect(JSON.stringify(envelope)).not.toContain('Never-Persist-This-Secret');
    expect(JSON.stringify(envelope)).toContain('QAAI_INLINE_PASSWORD');
    expect(envelope.dataDictionary).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'data.password',
        classification: 'sensitive',
        source: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD' },
      }),
    ]));
    expect(caseContractV1.rawRowsForCase(envelope, contract.id)).toEqual([{
      id: contract.dataRows[0].id,
      bindings: {
        email: 'person@example.test',
        password: 'Never-Persist-This-Secret',
      },
    }]);
    expect(caseContractV1.rawBindingsForCase(envelope, contract.id).get('password')).toEqual([
      'Never-Persist-This-Secret',
    ]);
  });

  it('keeps same-topology table values as row instances of one case', () => {
    const source = `
Test Data:
| Email | Password | Expected message |
| --- | --- | --- |
| first@example.test | First-Secret | Welcome first |
| second@example.test | Second-Secret | Welcome second |

Test Case: Authenticate an account row
Steps:
1. Enter {{email}} in the Email field.
2. Enter {{password}} in the Password field.
3. Click Sign in.
4. Verify {{expected_message}} is visible.
`;
    const envelope = caseContractV1.compileCaseContractV1([{ id: 'req-table', content: source }]);

    expect(envelope.cases).toHaveLength(1);
    expect(envelope.dataRows).toHaveLength(2);
    expect(envelope.partitioning.dataRowsDoNotCreateCases).toBe(true);
    expect(envelope.cases[0].dataRows).toHaveLength(2);
    expect(envelope.cases[0].dataRows[0].bindings.password).toEqual({
      kind: 'environment',
      name: 'QAAI_INLINE_PASSWORD_ROW_1',
    });
    expect(JSON.stringify(envelope)).not.toContain('First-Secret');
    expect(JSON.stringify(envelope)).not.toContain('Second-Secret');
    expect(caseContractV1.rawRowsForCase(envelope, envelope.cases[0].id)).toEqual([
      {
        id: envelope.cases[0].dataRows[0].id,
        bindings: {
          email: 'first@example.test',
          password: 'First-Secret',
          expected_message: 'Welcome first',
        },
      },
      {
        id: envelope.cases[0].dataRows[1].id,
        bindings: {
          email: 'second@example.test',
          password: 'Second-Secret',
          expected_message: 'Welcome second',
        },
      },
    ]);
  });

  it('merges shared scalar data into every table row without exposing a shared secret', () => {
    const source = `
Test Data:
Tenant Code: shared-tenant
Access Key: Shared-Access-Key-Secret
| Email | Expected message |
| --- | --- |
| first@example.test | Welcome first |
| second@example.test | Welcome second |

Test Case: Authenticate each account in one tenant
Steps:
1. Enter Email in the Email field.
2. Enter Tenant Code in the Tenant Code field.
3. Enter Access Key in the Access Key field.
4. Verify Expected message is visible.
`;
    const envelope = caseContractV1.compileCaseContractV1([{ id: 'req-shared-scalar', content: source }]);
    const contract = envelope.cases[0];
    const rawRows = caseContractV1.rawRowsForCase(envelope, contract.id);

    expect(contract.dataRows).toHaveLength(2);
    expect(contract.dataRows.map((row) => row.bindings.tenant_code.value)).toEqual([
      'shared-tenant', 'shared-tenant',
    ]);
    expect(contract.dataRows.map((row) => row.bindings.access_key)).toEqual([
      { kind: 'environment', name: 'QAAI_INLINE_ACCESS_KEY' },
      { kind: 'environment', name: 'QAAI_INLINE_ACCESS_KEY' },
    ]);
    expect(rawRows.map((row) => row.bindings.access_key)).toEqual([
      'Shared-Access-Key-Secret', 'Shared-Access-Key-Secret',
    ]);
    expect(rawRows.map((row) => row.bindings.email)).toEqual([
      'first@example.test', 'second@example.test',
    ]);
    expect(JSON.stringify(envelope)).not.toContain('Shared-Access-Key-Secret');
  });

  it('assigns stable authored-order row IDs across multiple inline tables', () => {
    const source = `
Test Case: Use two inline tables
Test Data:
| Email | Password |
| --- | --- |
| first@example.test | First-Table-Secret |
| second@example.test | Second-Table-Secret |

Credentials:
| Username | Access token |
| --- | --- |
| alpha-user | Alpha-Token-Secret |
| beta-user | Beta-Token-Secret |

Steps:
1. Enter {{email}} in the Email field.
2. Enter {{password}} in the Password field.
3. Enter {{username}} in the Username field.
4. Enter {{access_token}} in the Access token field.
`;
    const envelope = caseContractV1.compileCaseContractV1([{ id: 'req-two-tables', content: source }]);
    const contract = envelope.cases[0];
    const rawRows = caseContractV1.rawRowsForCase(envelope, contract.id);

    expect(contract.dataRows.map((row) => row.id)).toEqual([
      'row-001', 'row-002', 'row-003', 'row-004',
    ]);
    expect(new Set(contract.dataRows.map((row) => row.id)).size).toBe(4);
    expect(rawRows.map((row) => row.id)).toEqual(contract.dataRows.map((row) => row.id));
    expect(rawRows.map((row) => row.bindings)).toEqual([
      { email: 'first@example.test', password: 'First-Table-Secret' },
      { email: 'second@example.test', password: 'Second-Table-Secret' },
      { username: 'alpha-user', access_token: 'Alpha-Token-Secret' },
      { username: 'beta-user', access_token: 'Beta-Token-Secret' },
    ]);
    expect(contract.dataRows[2].bindings.access_token).toEqual({
      kind: 'environment',
      name: 'QAAI_INLINE_ACCESS_TOKEN_ROW_3',
    });
    expect(JSON.stringify(envelope)).not.toContain('First-Table-Secret');
    expect(JSON.stringify(envelope)).not.toContain('Alpha-Token-Secret');
    expect(JSON.stringify(caseContractV1.sanitizeForPersistence(envelope))).not.toContain('Beta-Token-Secret');
  });

  it('preserves ten or more explicit behavioral cases without a generation cap', () => {
    const listedCases = Array.from({ length: 12 }, (_, index) => `${index + 1}. Verify behavior ${index + 1}`).join('\n');
    const source = `
Requirement Title: Twelve independent behaviors
Test Cases:
${listedCases}
`;
    const envelope = caseContractV1.compileCaseContractV1([{ id: 'req-many', content: source }]);

    expect(envelope.cases).toHaveLength(12);
    expect(envelope.cases.map((item) => item.name)).toEqual(
      Array.from({ length: 12 }, (_, index) => `Verify behavior ${index + 1}`),
    );
    expect(envelope.partitioning.mode).toBe('explicit_behavioral_cases');
    const legacy = proceduralFlowContract.extractProceduralFlowContract([{ id: 'req-many', content: source }]);
    expect(legacy.isProcedural).toBe(true);
    expect(legacy.strictOneCase).toBe(false);
    expect(legacy.controlsFixedQuota).toBe(false);
  });

  it('extracts executable sentences from prose when no Steps heading exists', () => {
    const source = `
Requirement Title: Search from prose
email=reader@example.test
The tester should navigate to https://example.test/search. Then enter reader@example.test in the Email field. Click Search. Verify that Results is visible.
`;
    const envelope = caseContractV1.compileCaseContractV1([{ id: 'req-prose', content: source }]);
    const types = envelope.cases[0].steps.map((step) => step.type);

    expect(types).toEqual(expect.arrayContaining(['Navigate', 'Fill', 'Click', 'AssertVisible']));
    expect(envelope.cases[0].steps.find((step) => step.type === 'Fill')?.dataRefs).toContain('data.email');
  });

  it('decomposes compound browser operations and applies semantic assertion types', () => {
    const source = `
Scenario Title: Configure a generic scheduling form

Inline Test Data:
Order Number = 007995145
Early Pickup Time = 09:00 AM

Test Steps and Validations:
1. Open the Early Pickup Time dropdown, select 09:00 AM, and verify the selected time is 09:00 AM.
2. Fill the Order Number field with 007995145 and verify the Order Number field contains exactly 007995145.
3. Verify the Order Number field contains exactly 007995145.
4. Verify the Early Pickup Date represents August 20, 2026.
5. Verify that the total number of results is exactly 3.
6. Verify that the suggestion list contains these visible options in this order: First option: Open, Second option: Select, Third option: Verify.
7. Verify that no required-field validation message is displayed.
8. Select the Ship Date & Time radio option if it is not already selected.
9. Scroll the References section into view.
10. Open the Early Pickup Date calendar and select August 20, 2026.
11. If the Pickup and Delivery section is collapsed, expand the Pickup and Delivery section; if it is already expanded, do not expand it.
12. Verify that the Create Order heading and the General Information section are visible.
`;
    const envelope = caseContractV1.compileCaseContractV1([{ id: 'req-atomic-semantics', content: source }]);
    const steps = envelope.cases[0].steps;

    expect(steps.map((step) => step.type)).toEqual([
      'Select', 'Fill',
      'AssertText', 'AssertText', 'AssertNumber',
      'AssertVisible', 'AssertHidden', 'Radio',
      'Scroll', 'Date', 'Expand',
      'AssertVisible', 'AssertVisible',
    ]);
    expect(steps.map((step) => step.ordinal)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));
    expect(steps[1].dependsOn).toEqual([steps[0].id]);
    expect(steps[2].dependsOn).toEqual([steps[1].id]);
    expect(steps[0]).toEqual(expect.objectContaining({
      type: 'Select',
      target: 'Early Pickup Time dropdown',
      selectionCriteria: { kind: 'exact_text', text: '09:00 AM' },
      verificationPoint: true,
    }));
    expect(steps[0].dataRefs).toContain('data.early_pickup_time');
    expect(steps[1].dataRefs).toContain('data.order_number');
    expect(steps[5].text).toBe('Verify that the suggestion list contains these visible options in this order: First option: Open, Second option: Select, Third option: Verify.');
    expect(caseContractV1._private.decomposeStepText(steps[5].text)).toEqual([steps[5].text]);
    expect(steps[7]).toEqual(expect.objectContaining({ type: 'Radio', value: true, checked: true }));
    expect(steps[8]).toEqual(expect.objectContaining({
      type: 'Scroll', target: 'References section', scrollMode: 'target',
    }));
    expect(steps[9]).toEqual(expect.objectContaining({ type: 'Date', value: '2026-08-20' }));
    expect(steps[10]).toEqual(expect.objectContaining({
      type: 'Expand',
      target: 'Pickup and Delivery section',
      idempotent: true,
      expectedState: { property: 'expanded', equals: true },
    }));
    expect(caseContractV1._private.decomposeStepText(
      'Open the Status dropdown and verify that the suggestion list contains these options in order: Open, Select, Verify.',
    )).toEqual(['Open the Status dropdown and verify that the suggestion list contains these options in order: Open, Select, Verify.']);
    expect(caseContractV1._private.decomposeStepText(
      'If the Details section is collapsed, open the Details section.',
    )).toEqual(['If the Details section is collapsed, open the Details section.']);
    expect(caseContractV1._private.stepType('If the Details section is collapsed, open the Details section.')).toBe('Expand');
    expect(caseContractV1._private.stepType('Collapse the Details section if it is expanded.')).toBe('Collapse');
    expect(caseContractV1._private.stepType('Select 03/04/2026 from the Due Date calendar.')).toBe('Select');
    expect(JSON.stringify(steps)).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('keeps noisy Add Scenario literals intact and excludes metadata and failure policy from executable steps', () => {
    const source = `
Scenario Title:
Configure a generic carrier profile

Generation Requirement:
Generate exactly one test case. Preserve every authored value and do not introduce placeholders.

Session Requirement:
continue_from_previous_case
Reuse the same browser session. Do not launch a new browser.

Initial State:
The profile editor is already open.

Expected Final State:
The editor remains open with the populated values.
Do not click Save.

Inline Test Data:
Transport Code = TL
Billing Code = COL
Equipment Code = LTL

Test Steps and Validations:
1. Fill Transport Code with TL.
2. Verify the word exactly remains visible.
3. Fill Billing Code with COL.
4. Verify the collapsed panel is visible.
5. Select LTL from the Equipment Code dropdown.
6. Verify Collect is visible in the Billing choices.

Failure and Continuation Behavior:
1. Do not invent a successful result.
2. If evidence is uncertain, record the uncertainty and stop dependent work.
`;
    const envelope = caseContractV1.compileCaseContractV1([{ id: 'req-noisy-add-scenario', content: source }]);
    const contract = envelope.cases[0];
    const executable = JSON.stringify({ steps: contract.steps, assertions: contract.assertions });

    expect(contract.name).toBe('Configure a generic carrier profile');
    expect(contract.sessionRequirement.mode).toBe('continue_from_case');
    expect(contract.steps.map((step) => step.text)).toEqual([
      'Fill Transport Code with TL.',
      'Verify the word exactly remains visible.',
      'Fill Billing Code with COL.',
      'Verify the collapsed panel is visible.',
      'Select LTL from the Equipment Code dropdown.',
      'Verify Collect is visible in the Billing choices.',
    ]);
    expect(contract.steps.map((step) => step.dataRefs)).toEqual([
      ['data.transport_code'],
      [],
      ['data.billing_code'],
      [],
      ['data.equipment_code'],
      [],
    ]);
    expect(executable).not.toMatch(/\{\{[^}]+\}\}/);
    expect(executable).toContain('exactly');
    expect(executable).toContain('Collect');
    expect(executable).toContain('collapsed');
    expect(executable).not.toContain('launch a new browser');
    expect(executable).not.toContain('invent a successful result');
    expect(executable).not.toContain('click Save');
  });

  it('binds a shared literal to the uniquely authored field and compiles both dropdown actions', () => {
    const content = `
Scenario Title: Generic shared-value dropdowns

Inline Test Data:
Primary Mode = COL
Secondary Mode = COL

Test Steps and Validations:
1. Select COL from the Primary Mode dropdown.
2. Select COL from the Secondary Mode dropdown.
3. Verify the Profile Editor heading is visible.
`;
    const requirement = {
      id: 'req-shared-dropdown-literal',
      source: 'add_scenario',
      title: 'Shared-value dropdown flow',
      content,
    };
    const procedural = proceduralFlowContract.extractProceduralFlowContract([requirement]);
    const contract = procedural.caseContractV1.cases[0];

    expect(contract.steps.map((step) => step.dataRefs)).toEqual([
      ['data.primary_mode'],
      ['data.secondary_mode'],
      [],
    ]);
    expect(contract.steps.map((step) => step.text)).toEqual([
      'Select COL from the Primary Mode dropdown.',
      'Select COL from the Secondary Mode dropdown.',
      'Verify the Profile Editor heading is visible.',
    ]);
    const ambiguous = caseContractV1._private.bindText(
      'Select COL from the Mode dropdown.',
      contract.dataBindings,
      caseContractV1.rawBindingsForCase(procedural.caseContractV1, contract.id),
      { inputLike: true, referenceLike: true },
    );
    expect(ambiguous.dataRefs).toEqual([]);

    const bridged = planningBridge.buildCaseContractPlanningBridge({
      proceduralFlowContract: procedural,
      coverageManifest: { version: 1, items: [] },
      caseContractPacks: [],
    });
    const plan = testDesignPlanV1.buildTestDesignPlanV1({
      coverageManifest: bridged.coverageManifest,
      caseContractPacks: bridged.caseContractPacks,
      requirements: [requirement],
    });
    const casePlan = plan.scenarios[0].cases[0];
    const candidate = architect.deterministicScenarioFromPack({
      ...bridged.caseContractPacks[0],
      planCaseId: casePlan.planCaseId,
    }, 'shared_literal_dropdown_regression');
    const compiled = stepCompiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: [candidate],
      proceduralFlowContract: procedural,
    });
    const compiledSteps = compiled.scenarios[0].cases[0].steps;

    expect(compiledSteps.slice(0, 2).map((step) => step.value)).toEqual(['COL', 'COL']);
    expect(compiledSteps.slice(0, 2).map((step) => step.dataRefs)).toEqual([
      ['data.primary_mode'],
      ['data.secondary_mode'],
    ]);
    expect(JSON.stringify(compiledSteps)).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('projects a custom option Click target from authored text when candidate metadata is absent', () => {
    const requirement = {
      id: 'req-custom-option-click',
      source: 'add_scenario',
      title: 'Choose a custom option',
      content: `
Scenario Title: Choose a custom option

Test Steps and Validations:
1. Click the Collect option.
2. Verify the Selection Complete heading is visible.
`,
    };
    const procedural = proceduralFlowContract.extractProceduralFlowContract([requirement]);
    const contract = procedural.caseContractV1.cases[0];
    expect(contract.steps[0]).toMatchObject({
      ordinal: 1,
      type: 'Click',
      text: 'Click the Collect option.',
      dataRefs: [],
    });

    const bridged = planningBridge.buildCaseContractPlanningBridge({
      proceduralFlowContract: procedural,
      coverageManifest: { version: 1, items: [] },
      caseContractPacks: [],
    });
    const plan = testDesignPlanV1.buildTestDesignPlanV1({
      coverageManifest: bridged.coverageManifest,
      caseContractPacks: bridged.caseContractPacks,
      requirements: [requirement],
    });
    const casePlan = plan.scenarios[0].cases[0];
    const candidate = architect.deterministicScenarioFromPack({
      ...bridged.caseContractPacks[0],
      planCaseId: casePlan.planCaseId,
    }, 'custom_option_click_regression');
    const candidateClick = candidate.cases[0].steps.find((step) => /^click$/i.test(step.action));
    delete candidateClick.target;
    delete candidateClick.element;
    candidateClick.dataRefs = ['data.model_invented_option'];

    const compiled = stepCompiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: [candidate],
      proceduralFlowContract: procedural,
    });
    const click = compiled.scenarios[0].cases[0].steps[0];

    expect(click).toMatchObject({
      action: 'Click',
      type: 'Click',
      text: 'Click the Collect option.',
      target: 'Collect option',
      element: 'Collect option',
      dataRefs: [],
    });
    expect(JSON.stringify(click)).not.toContain('model_invented_option');
  });

  it('retains 55 authored final validations below the universal 100-assertion limit', () => {
    const assertions = Array.from(
      { length: 55 },
      (_, index) => `Validation ${String(index + 1).padStart(2, '0')} is visible.`,
    );
    const parsed = proceduralFlowContract._private.parseFinalAssertions([
      'Final Validation:',
      ...assertions.map((assertion) => `- ${assertion}`),
    ].join('\n'));

    expect(parsed).toHaveLength(55);
    expect(parsed).toEqual(assertions);
  });

  it('retains 55 authored logical steps while exposing atomic children for execution', () => {
    const authored = Array.from({ length: 55 }, (_, index) => `Verify that Field ${index + 1} is visible.`);
    authored[22] = 'Verify that the Freight Term field automatically changes from Pre-Paid to exactly COL. If it does not, record the observed value and continue with the next independent step.';
    authored[31] = 'Inspect whether the Pickup and Delivery section is collapsed; if it is collapsed, click its header or expand control and wait for it to open.';
    authored[35] = 'Select Ship Date & Time when it is not already selected.';
    authored[39] = 'Open the Early Pickup Time Zone dropdown, select an available option whose visible label contains Central, and verify that the selected label contains Central.';
    const source = [
      'Scenario Title: Fifty-five authored planning steps',
      'Test Steps and Validations:',
      ...authored.map((line, index) => `${index + 1}. ${line}`),
    ].join('\n');
    const contract = caseContractV1.compileCaseContractV1([{ id: 'req-55-logical', content: source }]).cases[0];
    const logicalIds = new Set(contract.steps.map((step) => step.logicalStepId));

    expect(logicalIds.size).toBe(55);
    expect(contract.steps.find((step) => step.type === 'Radio')).toMatchObject({
      target: 'Ship Date & Time',
      failureBehavior: 'stop_descendants',
    });
    expect(contract.steps.find((step) => step.type === 'Expand')).toMatchObject({
      target: 'Pickup and Delivery section',
      condition: expect.objectContaining({ predicate: 'Pickup and Delivery section is collapsed' }),
    });
    expect(contract.steps.find((step) => step.type === 'Select')).toMatchObject({
      target: 'Early Pickup Time Zone dropdown',
      selectionCriteria: { kind: 'predicate', predicate: 'visible label contains Central', expectedText: 'Central' },
    });
    const freightAssertion = contract.steps.find((step) => /^Assert/.test(step.type) && /Freight Term/i.test(step.target || ''));
    expect(freightAssertion).toMatchObject({ failureBehavior: 'continue', target: 'Freight Term field' });
    expect(freightAssertion.expected).not.toContain('record the observed value');
    expect(contract.assertions.find((assertion) => assertion.stepId === freightAssertion.id)).toMatchObject({
      comparator: 'equals',
      expected: 'COL',
      failureBehavior: 'continue',
      target: 'Freight Term field',
      payload: {
        channel: 'text',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'text' },
          { role: 'expected', kind: 'text', value: 'COL' },
        ],
      },
    });
    const timeZoneStep = contract.steps.find((step) => step.type === 'Select' && /Early Pickup Time Zone/i.test(step.target || ''));
    expect(contract.assertions.find((assertion) => assertion.stepId === timeZoneStep.id)).toMatchObject({
      comparator: 'contains',
      expected: 'Central',
      failureBehavior: 'stop_descendants',
    });
  });

  it('reduces generated confidence when deterministic semantic findings remain', () => {
    const generated = architect.deterministicScenarioFromPack({
      coverageRef: 'semantic-health-regression',
      title: 'Semantic health regression',
      caseContractV1: {
        id: 'case-semantic-health',
        name: 'Semantic health regression',
        sessionRequirement: { mode: 'fresh' },
        steps: [{
          id: 'case-semantic-health.step.001',
          type: 'Select',
          text: 'Select an option.',
          target: 'Inspect whether the Settings section',
          selectionCriteria: { kind: 'exact_text', text: 'Central, and verify the selected value' },
        }],
        assertions: [],
      },
    }, 'semantic_health_test');
    const generatedCase = generated.cases[0];

    expect(generatedCase.confidence).toBeLessThan(100);
    expect(generatedCase.semanticFindings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'instruction_prose_target',
      'selection_contains_assertion',
    ]));
  });

  it('preserves and compiles all 55 authored literal steps without placeholders or ordinal loss', () => {
    const stepCount = 55;
    const actionCount = stepCount - 1;
    const inlineData = Array.from(
      { length: actionCount },
      (_, index) => `field_${String(index + 1).padStart(2, '0')} = literal-value-${String(index + 1).padStart(2, '0')}`,
    );
    const authoredSteps = [...Array.from(
      { length: actionCount },
      (_, index) => `${index + 1}. Enter literal-value-${String(index + 1).padStart(2, '0')} in Field ${String(index + 1).padStart(2, '0')}.`,
    ), `${stepCount}. Verify the Workflow Complete heading is visible.`];
    const requirement = {
      id: 'req-55-literal-steps',
      source: 'add_scenario',
      title: 'Fifty-five literal step flow',
      content: [
        'Scenario Title: Fifty-five literal step flow',
        '',
        'Inline Test Data:',
        ...inlineData,
        '',
        'Test Steps and Validations:',
        ...authoredSteps,
      ].join('\n'),
    };

    const procedural = proceduralFlowContract.extractProceduralFlowContract([requirement]);
    const contract = procedural.caseContractV1.cases[0];
    expect(contract.steps).toHaveLength(stepCount);
    expect(contract.steps.map((step) => step.ordinal)).toEqual(
      Array.from({ length: stepCount }, (_, index) => index + 1),
    );
    expect(contract.steps.slice(0, actionCount).every((step, index) => (
      step.text === authoredSteps[index].replace(/^\d+\.\s*/, '')
      && step.dataRefs.length === 1
      && step.dataRefs[0] === `data.field_${String(index + 1).padStart(2, '0')}`
    ))).toBe(true);
    expect(contract.steps[actionCount]).toEqual(expect.objectContaining({
      ordinal: stepCount,
      type: 'AssertVisible',
      dataRefs: [],
    }));

    const bridged = planningBridge.buildCaseContractPlanningBridge({
      proceduralFlowContract: procedural,
      coverageManifest: { version: 1, items: [] },
      caseContractPacks: [],
    });
    const plan = testDesignPlanV1.buildTestDesignPlanV1({
      coverageManifest: bridged.coverageManifest,
      caseContractPacks: bridged.caseContractPacks,
      requirements: [requirement],
    });
    const casePlan = plan.scenarios[0].cases[0];
    const candidate = architect.deterministicScenarioFromPack({
      ...bridged.caseContractPacks[0],
      planCaseId: casePlan.planCaseId,
    }, 'fifty_five_literal_steps_regression');
    const compiled = stepCompiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: [candidate],
      proceduralFlowContract: procedural,
    });
    const compiledSteps = compiled.scenarios[0].cases[0].steps;

    expect(compiledSteps).toHaveLength(stepCount);
    expect(compiledSteps.map((step) => step.ordinal)).toEqual(
      Array.from({ length: stepCount }, (_, index) => index + 1),
    );
    expect(compiledSteps.slice(0, actionCount).map((step) => step.value)).toEqual(
      Array.from({ length: actionCount }, (_, index) => `literal-value-${String(index + 1).padStart(2, '0')}`),
    );
    expect(JSON.stringify(compiledSteps)).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('sanitizes and nests a per-case contract under the existing quality contract', () => {
    const envelope = caseContractV1.compileCaseContractV1([{
      id: 'req-persist',
      content: 'Test Data:\npassword=Do-Not-Store\nSteps:\n1. Enter Do-Not-Store in Password.\n2. Click Continue.',
    }]);
    const quality = caseContractV1.mergeIntoQualityContract(
      { blockers: [], existingField: true },
      envelope.cases[0],
    );

    expect(quality.existingField).toBe(true);
    expect(quality.caseContractV1.version).toBe('CaseContractV1');
    expect(quality.caseContractV1.dataBindings[0].source).toEqual({
      kind: 'environment',
      name: 'QAAI_INLINE_PASSWORD',
    });
    expect(JSON.stringify(quality)).not.toContain('Do-Not-Store');
    expect(JSON.stringify(quality)).toContain('env:QAAI_INLINE_PASSWORD');
  });
});
