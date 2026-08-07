export const SEMANTIC_PLANNER_PRIOR_CASE_ID = 'case-prior-authenticated-profile-001';
export const SEMANTIC_PLANNER_SENSITIVE_REF = 'credential:website-neutral.standard-user.password';
export const SEMANTIC_PLANNER_SENSITIVE_SENTINEL = 'Phase3-Sensitive-Sentinel-Must-Not-Appear!';
export const SEMANTIC_PLANNER_UNRESOLVED_QUESTION = 'Which owner should be selected?';

const TARGETS = Object.freeze({
  region: (label) => ({ kind: 'region', label }),
  field: (label, role = 'textbox') => ({ kind: 'field', label, role }),
  control: (label, role = 'button') => ({ kind: 'control', label, role }),
  collection: (label) => ({ kind: 'collection', label, role: 'listbox' }),
});

function clone(value) {
  return structuredClone(value);
}

export function buildLargeSemanticPlannerFixture(options = {}) {
  const includeUnresolved = options.includeUnresolved !== false;
  const sourceParts = [
    `This is one continuous continuation after prior case ${SEMANTIC_PLANNER_PRIOR_CASE_ID} in the same browser session, and the inherited Profile page is the starting state instead of a fresh login.`,
    'The prose is intentionally repetitive and messy, all validations are nonblocking so later independent checks continue, and every normal inline value below is literal.',
    ...(includeUnresolved ? [
      `For the Owner field the phrase relevant owner is ambiguous; preserve the unresolved question ${SEMANTIC_PLANNER_UNRESOLVED_QUESTION} and do not guess an option.`,
    ] : []),
  ];
  const actions = [];
  const assertions = [];
  const semanticOrder = [];

  const addAction = (record) => {
    actions.push(record);
    sourceParts.push(record.sourceQuote);
    semanticOrder.push({ kind: 'action', type: record.type, sourceQuote: record.sourceQuote });
  };
  const addAssertion = (record) => {
    assertions.push({ ...record, nonBlocking: true });
    sourceParts.push(record.sourceQuote);
    semanticOrder.push({ kind: 'assertion', type: record.type, sourceQuote: record.sourceQuote });
  };

  addAction({
    type: 'Scroll',
    sourceQuote: 'Scroll the Schedule workspace into view.',
    target: TARGETS.region('Schedule workspace'),
  });
  addAction({
    type: 'Expand',
    sourceQuote: 'If the Advanced schedule panel is collapsed, expand the Advanced schedule panel.',
    target: TARGETS.region('Advanced schedule panel'),
    condition: 'If the Advanced schedule panel is collapsed',
  });
  addAction({
    type: 'Select',
    sourceQuote: 'Select High from the Priority dropdown.',
    target: TARGETS.field('Priority', 'combobox'),
    selection: 'High',
  });
  addAssertion({
    type: 'AssertValue',
    sourceQuote: 'Verify the Priority field equals High.',
    target: TARGETS.field('Priority', 'combobox'),
    expected: 'High',
    relation: 'exact',
  });
  addAction({
    type: 'Select',
    sourceQuote: 'Select Draft from the Workflow Stage dropdown.',
    target: TARGETS.field('Workflow Stage', 'combobox'),
    selection: 'Draft',
  });
  addAssertion({
    type: 'AssertCollection',
    sourceQuote: 'Verify the Workflow Stage options are Draft, Review, Approved in that exact order.',
    target: TARGETS.collection('Workflow Stage options'),
    expected: ['Draft', 'Review', 'Approved'],
    relation: 'exact_order',
  });

  const schedules = [
    { date: '2026-09-10', time: '09:15', zone: 'UTC' },
    { date: '2026-09-11', time: '11:30', zone: 'America/New_York' },
    { date: '2026-09-12', time: '14:45', zone: 'Europe/London' },
    { date: '2026-09-13', time: '17:00', zone: 'Asia/Kolkata' },
  ];
  schedules.forEach((schedule, index) => {
    const number = index + 1;
    addAction({
      type: 'Date',
      sourceQuote: `Choose ${schedule.date} in Schedule ${number} Date.`,
      target: TARGETS.field(`Schedule ${number} Date`),
      value: schedule.date,
    });
    addAssertion({
      type: 'AssertDate',
      sourceQuote: `Verify Schedule ${number} Date equals ${schedule.date}.`,
      target: TARGETS.field(`Schedule ${number} Date`),
      expected: schedule.date,
      relation: 'exact',
    });
    addAction({
      type: 'Select',
      sourceQuote: `Select ${schedule.time} from Schedule ${number} Time.`,
      target: TARGETS.field(`Schedule ${number} Time`, 'combobox'),
      selection: schedule.time,
    });
    addAssertion({
      type: 'AssertValue',
      sourceQuote: `Verify Schedule ${number} Time equals ${schedule.time}.`,
      target: TARGETS.field(`Schedule ${number} Time`, 'combobox'),
      expected: schedule.time,
      relation: 'exact',
    });
    addAction({
      type: 'Select',
      sourceQuote: `Select ${schedule.zone} from Schedule ${number} Time Zone.`,
      target: TARGETS.field(`Schedule ${number} Time Zone`, 'combobox'),
      selection: schedule.zone,
    });
    addAssertion({
      type: 'AssertValue',
      sourceQuote: `Verify Schedule ${number} Time Zone equals ${schedule.zone}.`,
      target: TARGETS.field(`Schedule ${number} Time Zone`, 'combobox'),
      expected: schedule.zone,
      relation: 'exact',
    });
  });

  for (let number = 1; number <= 12; number += 1) {
    const suffix = String(number).padStart(2, '0');
    const value = `Detail-${suffix}-Value`;
    addAction({
      type: 'Fill',
      sourceQuote: `Enter ${value} in Detail Field ${suffix}.`,
      target: TARGETS.field(`Detail Field ${suffix}`),
      value,
    });
    addAssertion({
      type: 'AssertValue',
      sourceQuote: `Verify Detail Field ${suffix} equals ${value}.`,
      target: TARGETS.field(`Detail Field ${suffix}`),
      expected: value,
      relation: 'exact',
    });
  }

  for (let number = 1; number <= 24; number += 1) {
    const suffix = String(number).padStart(2, '0');
    addAction({
      type: 'Click',
      sourceQuote: `Click Workflow Control ${suffix}.`,
      target: TARGETS.control(`Workflow Control ${suffix}`),
    });
    if (number % 3 === 0) {
      addAssertion({
        type: 'AssertVisible',
        sourceQuote: `Verify Workflow Marker ${suffix} is visible.`,
        target: TARGETS.region(`Workflow Marker ${suffix}`),
      });
    }
  }

  addAction({
    type: 'Fill',
    sourceQuote: `Enter ${SEMANTIC_PLANNER_SENSITIVE_REF} in Authentication Password.`,
    target: TARGETS.field('Authentication Password'),
    valueRef: SEMANTIC_PLANNER_SENSITIVE_REF,
  });
  addAction({
    type: 'Submit',
    sourceQuote: 'Submit the Service Request form.',
    target: TARGETS.region('Service Request form'),
  });
  addAssertion({
    type: 'AssertVisible',
    sourceQuote: 'Verify the Completion banner is visible, and if that validation fails, continue with the remaining independent checks.',
    target: TARGETS.region('Completion banner'),
  });

  const rawSource = sourceParts.join(' ');
  const compactPlan = {
    version: 'SemanticIntentPlanV1',
    cases: [{
      name: 'Continue the inherited service request and validate the completed schedule',
      intent: includeUnresolved
        ? `Continue from ${SEMANTIC_PLANNER_PRIOR_CASE_ID}, preserve every authored operation, and retain the unresolved question ${SEMANTIC_PLANNER_UNRESOLVED_QUESTION}`
        : `Continue from ${SEMANTIC_PLANNER_PRIOR_CASE_ID} and preserve every authored operation.`,
      initialState: `The Profile page and authenticated browser state produced by ${SEMANTIC_PLANNER_PRIOR_CASE_ID} are available.`,
      expectedFinalState: 'The Service Request is submitted and the Completion banner is visible after all nonblocking validations.',
      continuationIntent: {
        mode: 'continue',
        predecessorCaseId: SEMANTIC_PLANNER_PRIOR_CASE_ID,
        sameSession: true,
        reason: `The authored flow explicitly continues ${SEMANTIC_PLANNER_PRIOR_CASE_ID} in the same browser session.`,
      },
      actions,
      assertions,
    }],
    unresolvedQuestions: includeUnresolved ? [{
      sourceQuote: `For the Owner field the phrase relevant owner is ambiguous; preserve the unresolved question ${SEMANTIC_PLANNER_UNRESOLVED_QUESTION} and do not guess an option.`,
      question: SEMANTIC_PLANNER_UNRESOLVED_QUESTION,
      reason: 'The authored owner selection is ambiguous and must not be guessed.',
      affectedRecord: { caseIndex: 0, kind: 'case' },
    }] : [],
  };

  const existingScenarioContext = {
    version: 'ExistingScenarioContextV1',
    projectId: 'project-semantic-planner-001',
    generation: {
      id: 'generation-semantic-planner-007',
      revision: 'generation-revision-007',
      version: 7,
      isCurrent: true,
    },
    cases: [{
      id: SEMANTIC_PLANNER_PRIOR_CASE_ID,
      ordinal: 1,
      name: 'Authenticate and open the Profile page',
      revision: {
        planRevision: 'plan-revision-prior-003',
        caseRevision: 'case-revision-prior-005',
        compiledCaseRevision: 'compiled-case-revision-prior-008',
      },
      sessionMode: 'fresh',
      dependsOnIds: [],
      expectedFinalState: {
        page: 'Profile',
        authentication: 'standard_user',
      },
      steps: [{
        type: 'Fill',
        target: { kind: 'field', label: 'Password' },
        valueRef: SEMANTIC_PLANNER_SENSITIVE_REF,
      }],
    }],
    continuation: {
      requested: true,
      resolution: 'resolved',
      predecessorCaseId: SEMANTIC_PLANNER_PRIOR_CASE_ID,
      ancestryCaseIds: [SEMANTIC_PLANNER_PRIOR_CASE_ID],
      sameSession: true,
    },
    contextDigest: `sha256-${'a'.repeat(64)}`,
  };

  return {
    rawSource,
    compactPlan: clone(compactPlan),
    existingScenarioContext: clone(existingScenarioContext),
    continuationContext: {
      requested: true,
      predecessorCaseId: SEMANTIC_PLANNER_PRIOR_CASE_ID,
      mode: 'continue_from_case',
      sameSession: true,
    },
    semanticOrder: clone(semanticOrder),
    schedules: clone(schedules),
    expectedActionCount: actions.length,
    expectedAssertionCount: assertions.length,
    expectedOperationCount: actions.length + assertions.length,
  };
}
