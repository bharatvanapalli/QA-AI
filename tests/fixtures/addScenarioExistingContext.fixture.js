export const EXISTING_CONTEXT_PROJECT_ID = 'project-existing-context-alpha';
export const EXISTING_CONTEXT_OTHER_PROJECT_ID = 'project-existing-context-beta';
export const EXISTING_CONTEXT_GENERATION_ID = 'generation-existing-context-012';
export const EXISTING_CONTEXT_GENERATION_REVISION = 'generation-revision-012';

export const EXISTING_CONTEXT_CASE_IDS = Object.freeze({
  login: 'case-existing-login-001',
  profile: 'case-existing-profile-002',
});

export const EXISTING_CONTEXT_CASE_REVISIONS = Object.freeze({
  login: Object.freeze({
    planRevision: 'plan-revision-login-004',
    caseRevision: 'case-revision-login-007',
    compiledCaseRevision: 'compiled-case-revision-login-009',
  }),
  profile: Object.freeze({
    planRevision: 'plan-revision-profile-005',
    caseRevision: 'case-revision-profile-008',
    compiledCaseRevision: 'compiled-case-revision-profile-010',
  }),
});

export const EXISTING_CONTEXT_SENSITIVE_SENTINEL = 'Phase2-Existing-Context-Sensitive-Sentinel!';
export const EXISTING_CONTEXT_SENSITIVE_REF = 'credential:website-neutral.standard-user.password';

const PUBLIC_LOGIN_STATE = Object.freeze({
  id: 'state.public-login-page',
  type: 'page',
  scope: 'browser_session',
  value: Object.freeze({ route: '/login' }),
});

const AUTHENTICATED_STATE = Object.freeze({
  id: 'state.authenticated-standard-user',
  type: 'authenticated_session',
  scope: 'browser_session',
  value: Object.freeze({ role: 'standard_user' }),
});

const HOME_STATE = Object.freeze({
  id: 'state.home-dashboard-visible',
  type: 'page',
  scope: 'browser_session',
  value: Object.freeze({ route: '/home', marker: 'Welcome' }),
});

const PROFILE_STATE = Object.freeze({
  id: 'state.profile-page-visible',
  type: 'page',
  scope: 'browser_session',
  value: Object.freeze({ route: '/profile', marker: 'Profile details' }),
});

export const EXISTING_CONTEXT_STATES = Object.freeze({
  publicLogin: PUBLIC_LOGIN_STATE,
  authenticated: AUTHENTICATED_STATE,
  home: HOME_STATE,
  profile: PROFILE_STATE,
});

function encode(value) {
  return JSON.stringify(value);
}

function planLineage(key, planCaseId) {
  const revisions = EXISTING_CONTEXT_CASE_REVISIONS[key];
  return {
    version: 'TestDesignPlanV1',
    planId: `test-design-plan-${key}`,
    revision: revisions.planRevision,
    planCaseId,
    caseRevision: revisions.caseRevision,
    compiledCaseRevision: revisions.compiledCaseRevision,
  };
}

function loginCase() {
  const lineage = planLineage('login', 'plan-case-login-001');
  return {
    id: EXISTING_CONTEXT_CASE_IDS.login,
    ordinal: 1,
    projectId: EXISTING_CONTEXT_PROJECT_ID,
    generationId: EXISTING_CONTEXT_GENERATION_ID,
    scenarioId: 'scenario-existing-authentication-001',
    name: 'Authenticate the standard user',
    module: 'Identity',
    status: 'approved',
    steps: encode([
      {
        id: 'persisted-login-step-001',
        ordinal: 1,
        action: 'Navigate',
        target: { kind: 'page', name: 'Login page' },
        value: 'https://qa.example.test/login',
      },
      {
        id: 'persisted-login-step-002',
        ordinal: 2,
        action: 'Fill',
        target: { kind: 'field', name: 'Email Address' },
        value: 'qa.standard.user@example.test',
      },
      {
        id: 'persisted-login-step-003',
        ordinal: 3,
        action: 'Fill',
        target: { kind: 'field', name: 'Password' },
        valueRef: EXISTING_CONTEXT_SENSITIVE_REF,
      },
      {
        id: 'persisted-login-step-004',
        ordinal: 4,
        action: 'Click',
        target: { kind: 'control', name: 'Sign in' },
      },
    ]),
    assertions: 'Verify the Home dashboard is displayed and Welcome is visible.',
    declaredAssertions: encode([
      {
        id: 'persisted-login-assertion-001',
        ordinal: 1,
        type: 'AssertText',
        target: { kind: 'region', name: 'Home dashboard' },
        comparator: 'contains',
        expected: 'Welcome',
      },
    ]),
    dependsOnIds: null,
    sessionMode: 'fresh',
    requiresStateJson: encode([PUBLIC_LOGIN_STATE]),
    producesStateJson: encode([AUTHENTICATED_STATE, HOME_STATE]),
    failurePolicy: 'block_dependents',
    qualityContractJson: encode({ testDesignPlan: lineage }),
    latestExecution: {
      runId: 'run-existing-login-041',
      resultId: 'result-existing-login-041',
      status: 'passed',
      sequence: 41,
      executedCaseRevision: lineage.compiledCaseRevision,
    },
  };
}

function profileCase() {
  const lineage = planLineage('profile', 'plan-case-profile-002');
  return {
    id: EXISTING_CONTEXT_CASE_IDS.profile,
    ordinal: 2,
    projectId: EXISTING_CONTEXT_PROJECT_ID,
    generationId: EXISTING_CONTEXT_GENERATION_ID,
    scenarioId: 'scenario-existing-profile-002',
    name: 'Open the profile in the authenticated session',
    module: 'Profile',
    status: 'approved',
    steps: encode([
      {
        id: 'persisted-profile-step-001',
        ordinal: 1,
        action: 'Click',
        target: { kind: 'control', name: 'Profile' },
      },
      {
        id: 'persisted-profile-step-002',
        ordinal: 2,
        action: 'WaitForState',
        target: { kind: 'region', name: 'Profile details' },
      },
    ]),
    assertions: 'Verify the Profile details region is visible.',
    declaredAssertions: encode([
      {
        id: 'persisted-profile-assertion-001',
        ordinal: 1,
        type: 'AssertVisible',
        target: { kind: 'region', name: 'Profile details' },
        comparator: 'visible',
        expected: true,
      },
    ]),
    dependsOnIds: encode([EXISTING_CONTEXT_CASE_IDS.login]),
    sessionMode: 'continue_from_dependency',
    requiresStateJson: encode([AUTHENTICATED_STATE, HOME_STATE]),
    producesStateJson: encode([AUTHENTICATED_STATE, PROFILE_STATE]),
    failurePolicy: 'block_dependents',
    qualityContractJson: encode({ testDesignPlan: lineage }),
    latestExecution: {
      runId: 'run-existing-profile-042',
      resultId: 'result-existing-profile-042',
      status: 'passed',
      sequence: 42,
      executedCaseRevision: lineage.compiledCaseRevision,
    },
  };
}

/**
 * Produces the persisted-record projection consumed by ExistingScenarioContextV1.
 * JSON-backed fields intentionally mirror TestCase storage instead of inventing
 * initialState/expectedFinalState/sessionRequirement aliases.
 */
export function buildExistingScenarioContextFixture({
  continuationRequested = true,
  predecessorCaseId = EXISTING_CONTEXT_CASE_IDS.profile,
  requiredInitialState = [AUTHENTICATED_STATE, PROFILE_STATE],
} = {}) {
  const currentCases = [loginCase(), profileCase()];
  const input = {
    project: { id: EXISTING_CONTEXT_PROJECT_ID },
    generation: {
      id: EXISTING_CONTEXT_GENERATION_ID,
      projectId: EXISTING_CONTEXT_PROJECT_ID,
      version: 12,
      revision: EXISTING_CONTEXT_GENERATION_REVISION,
      isCurrent: true,
    },
    currentCases,
    continuation: {
      requested: continuationRequested,
      mode: continuationRequested ? 'continue_from_dependency' : 'fresh',
      predecessorCaseId: continuationRequested ? predecessorCaseId : null,
      requiredInitialStateJson: encode(continuationRequested ? requiredInitialState : []),
      sameSession: continuationRequested,
    },
  };

  return {
    input,
    options: { sensitiveValues: [EXISTING_CONTEXT_SENSITIVE_SENTINEL] },
    persistedCases: currentCases,
  };
}

export function buildFreshExistingScenarioContextFixture() {
  return buildExistingScenarioContextFixture({
    continuationRequested: false,
    predecessorCaseId: null,
    requiredInitialState: [],
  });
}

export function buildAmbiguousExistingScenarioContextFixture() {
  return buildExistingScenarioContextFixture({
    continuationRequested: true,
    predecessorCaseId: null,
    requiredInitialState: [AUTHENTICATED_STATE],
  });
}
