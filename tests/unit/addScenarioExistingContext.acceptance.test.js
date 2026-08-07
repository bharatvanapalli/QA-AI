import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  EXISTING_CONTEXT_CASE_IDS,
  EXISTING_CONTEXT_CASE_REVISIONS,
  EXISTING_CONTEXT_GENERATION_ID,
  EXISTING_CONTEXT_GENERATION_REVISION,
  EXISTING_CONTEXT_OTHER_PROJECT_ID,
  EXISTING_CONTEXT_PROJECT_ID,
  EXISTING_CONTEXT_SENSITIVE_REF,
  EXISTING_CONTEXT_SENSITIVE_SENTINEL,
  EXISTING_CONTEXT_STATES,
  buildAmbiguousExistingScenarioContextFixture,
  buildExistingScenarioContextFixture,
  buildFreshExistingScenarioContextFixture,
} from '../fixtures/addScenarioExistingContext.fixture.js';

const require = createRequire(import.meta.url);
const {
  EXISTING_SCENARIO_CONTEXT_VERSION,
  ExistingScenarioContextError,
  computeAddScenarioExistingContextDigest,
  createAddScenarioExistingContext,
  validateAddScenarioExistingContext,
} = require('../../server/services/addScenarioExistingContext');

const FINDING_CODES = Object.freeze({
  finalStateIncompatible: 'existing_context_final_state_incompatible',
  caseNotApproved: 'existing_context_case_not_approved',
  caseNotExecuted: 'existing_context_case_not_executed',
  dependencyInvalid: 'existing_context_dependency_invalid',
  crossProject: 'existing_context_cross_project',
});

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]),
  );
}

function buildContext(fixture) {
  return createAddScenarioExistingContext(fixture.input, fixture.options);
}

function captureContextError(input, options) {
  try {
    createAddScenarioExistingContext(input, options);
  } catch (error) {
    return error;
  }
  throw new Error('Expected ExistingScenarioContextV1 construction to fail.');
}

function expectContextError(error, findingCode) {
  expect(error).toBeInstanceOf(ExistingScenarioContextError);
  expect(error).toMatchObject({
    code: 'ADD_SCENARIO_EXISTING_CONTEXT_INVALID',
    status: 422,
  });
  expect(error.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: findingCode }),
  ]));
}

describe('ExistingScenarioContextV1 independent acceptance', () => {
  it('keeps fresh authoring independent without inferring a predecessor from two prior cases', () => {
    const fixture = buildFreshExistingScenarioContextFixture();
    const context = buildContext(fixture);

    expect(context).toMatchObject({
      version: EXISTING_SCENARIO_CONTEXT_VERSION,
      projectId: EXISTING_CONTEXT_PROJECT_ID,
      generation: {
        id: EXISTING_CONTEXT_GENERATION_ID,
        revision: EXISTING_CONTEXT_GENERATION_REVISION,
        version: 12,
      },
      continuation: {
        requested: false,
        mode: 'fresh',
        resolution: 'fresh',
        predecessorCaseId: null,
        candidateCaseIds: [],
        ancestryCaseIds: [],
        requiredInitialState: [],
        sameSession: false,
      },
    });
    expect(context.cases.map((entry) => entry.id)).toEqual([
      EXISTING_CONTEXT_CASE_IDS.login,
      EXISTING_CONTEXT_CASE_IDS.profile,
    ]);
    expect(context.continuation).not.toHaveProperty('guessedPredecessorCaseId');
    expect(validateAddScenarioExistingContext(context)).toEqual({ valid: true, findings: [] });
  });

  it('preserves exact persisted IDs, revisions, records, and order for two prior cases', () => {
    const fixture = buildExistingScenarioContextFixture();
    const context = buildContext(fixture);

    expect(context.cases.map((entry) => ({
      id: entry.id,
      ordinal: entry.ordinal,
      projectId: entry.projectId,
      generationId: entry.generationId,
      scenarioId: entry.scenarioId,
      revision: entry.revision,
    }))).toEqual([
      {
        id: EXISTING_CONTEXT_CASE_IDS.login,
        ordinal: 1,
        projectId: EXISTING_CONTEXT_PROJECT_ID,
        generationId: EXISTING_CONTEXT_GENERATION_ID,
        scenarioId: 'scenario-existing-authentication-001',
        revision: EXISTING_CONTEXT_CASE_REVISIONS.login,
      },
      {
        id: EXISTING_CONTEXT_CASE_IDS.profile,
        ordinal: 2,
        projectId: EXISTING_CONTEXT_PROJECT_ID,
        generationId: EXISTING_CONTEXT_GENERATION_ID,
        scenarioId: 'scenario-existing-profile-002',
        revision: EXISTING_CONTEXT_CASE_REVISIONS.profile,
      },
    ]);
    expect(context.cases[0]).toMatchObject({
      approvalStatus: 'approved',
      executionStatus: 'passed',
      executionRevision: EXISTING_CONTEXT_CASE_REVISIONS.login.compiledCaseRevision,
      dependsOnIds: [],
      sessionMode: 'fresh',
      failurePolicy: 'block_dependents',
      requiresState: [EXISTING_CONTEXT_STATES.publicLogin],
      producesState: [EXISTING_CONTEXT_STATES.authenticated, EXISTING_CONTEXT_STATES.home],
      assertions: 'Verify the Home dashboard is displayed and Welcome is visible.',
    });
    expect(context.cases[1]).toMatchObject({
      approvalStatus: 'approved',
      executionStatus: 'passed',
      executionRevision: EXISTING_CONTEXT_CASE_REVISIONS.profile.compiledCaseRevision,
      dependsOnIds: [EXISTING_CONTEXT_CASE_IDS.login],
      sessionMode: 'continue_from_dependency',
      failurePolicy: 'block_dependents',
      requiresState: [EXISTING_CONTEXT_STATES.authenticated, EXISTING_CONTEXT_STATES.home],
      producesState: [EXISTING_CONTEXT_STATES.authenticated, EXISTING_CONTEXT_STATES.profile],
      assertions: 'Verify the Profile details region is visible.',
    });
    expect(context.cases[0].steps.map((step) => step.id)).toEqual([
      'persisted-login-step-001',
      'persisted-login-step-002',
      'persisted-login-step-003',
      'persisted-login-step-004',
    ]);
    expect(context.cases[1].steps.map((step) => step.id)).toEqual([
      'persisted-profile-step-001',
      'persisted-profile-step-002',
    ]);
    expect(context.cases[0].declaredAssertions.map((assertion) => assertion.id))
      .toEqual(['persisted-login-assertion-001']);
    expect(context.cases[1].declaredAssertions.map((assertion) => assertion.id))
      .toEqual(['persisted-profile-assertion-001']);
  });

  it('resolves an explicit compatible continuation through its same-session ancestry', () => {
    const fixture = buildExistingScenarioContextFixture();
    const context = buildContext(fixture);

    expect(context.continuation).toEqual(expect.objectContaining({
      requested: true,
      mode: 'continue_from_dependency',
      resolution: 'resolved',
      predecessorCaseId: EXISTING_CONTEXT_CASE_IDS.profile,
      candidateCaseIds: [EXISTING_CONTEXT_CASE_IDS.profile],
      ancestryCaseIds: [EXISTING_CONTEXT_CASE_IDS.login, EXISTING_CONTEXT_CASE_IDS.profile],
      requiredInitialState: [EXISTING_CONTEXT_STATES.authenticated, EXISTING_CONTEXT_STATES.profile],
      resolvedFinalState: [EXISTING_CONTEXT_STATES.authenticated, EXISTING_CONTEXT_STATES.profile],
      finalStateCompatible: true,
      sameSession: true,
    }));
    expect(context.cases[1].dependsOnIds).toEqual([EXISTING_CONTEXT_CASE_IDS.login]);
    expect(context.cases[1].sessionMode).toBe('continue_from_dependency');
    expect(context.cases[1].failurePolicy).toBe('block_dependents');
    expect(validateAddScenarioExistingContext(context)).toEqual({ valid: true, findings: [] });
  });

  it('rejects an explicit predecessor whose persisted final state cannot satisfy the requested initial state', () => {
    const fixture = buildExistingScenarioContextFixture({
      requiredInitialState: [{
        id: 'state.unavailable-admin-console',
        type: 'page',
        scope: 'browser_session',
        value: { route: '/admin', marker: 'Administration' },
      }],
    });
    const error = captureContextError(fixture.input, fixture.options);

    expectContextError(error, FINDING_CODES.finalStateIncompatible);
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'continuation.requiredInitialStateJson',
        predecessorCaseId: EXISTING_CONTEXT_CASE_IDS.profile,
      }),
    ]));
  });

  it('preserves historical approval and execution metadata without gating state-compatible authoring', () => {
    const fixture = buildExistingScenarioContextFixture();
    fixture.input.currentCases[0].status = 'pending';
    fixture.input.currentCases[0].latestExecution.status = 'failed';
    fixture.input.currentCases[0].latestExecution.executedCaseRevision = 'compiled-case-revision-login-historical';
    fixture.input.currentCases[1].status = 'rejected';
    fixture.input.currentCases[1].latestExecution.status = 'blocked';
    fixture.input.currentCases[1].latestExecution.executedCaseRevision = 'compiled-case-revision-profile-historical';

    const context = buildContext(fixture);

    expect(context.continuation).toEqual(expect.objectContaining({
      resolution: 'resolved',
      predecessorCaseId: EXISTING_CONTEXT_CASE_IDS.profile,
      ancestryCaseIds: [EXISTING_CONTEXT_CASE_IDS.login, EXISTING_CONTEXT_CASE_IDS.profile],
      finalStateCompatible: true,
      sameSession: true,
    }));
    expect(context.cases[0]).toMatchObject({
      revision: EXISTING_CONTEXT_CASE_REVISIONS.login,
      approvalStatus: 'pending',
      executionStatus: 'failed',
      executionRevision: 'compiled-case-revision-login-historical',
      dependsOnIds: [],
      failurePolicy: 'block_dependents',
    });
    expect(context.cases[1]).toMatchObject({
      revision: EXISTING_CONTEXT_CASE_REVISIONS.profile,
      approvalStatus: 'rejected',
      executionStatus: 'blocked',
      executionRevision: 'compiled-case-revision-profile-historical',
      dependsOnIds: [EXISTING_CONTEXT_CASE_IDS.login],
      failurePolicy: 'block_dependents',
    });
    expect(validateAddScenarioExistingContext(context)).toEqual({ valid: true, findings: [] });
  });

  it('rejects missing, forward, cyclic, and cross-project dependency context instead of repairing it', () => {
    const missing = buildExistingScenarioContextFixture();
    missing.input.currentCases[1].dependsOnIds = JSON.stringify(['case-that-does-not-exist']);
    expectContextError(
      captureContextError(missing.input, missing.options),
      FINDING_CODES.dependencyInvalid,
    );

    const forwardAndCyclic = buildExistingScenarioContextFixture();
    forwardAndCyclic.input.currentCases[0].dependsOnIds = JSON.stringify([EXISTING_CONTEXT_CASE_IDS.profile]);
    expectContextError(
      captureContextError(forwardAndCyclic.input, forwardAndCyclic.options),
      FINDING_CODES.dependencyInvalid,
    );

    const crossProject = buildExistingScenarioContextFixture();
    crossProject.input.currentCases[1].projectId = EXISTING_CONTEXT_OTHER_PROJECT_ID;
    expectContextError(
      captureContextError(crossProject.input, crossProject.options),
      FINDING_CODES.crossProject,
    );
  });

  it('leaves an ambiguous continuation unresolved and never guesses between compatible prior cases', () => {
    const fixture = buildAmbiguousExistingScenarioContextFixture();
    const context = buildContext(fixture);

    expect(context.continuation).toEqual(expect.objectContaining({
      requested: true,
      mode: 'continue_from_dependency',
      resolution: 'unresolved',
      reason: 'ambiguous_compatible_predecessors',
      predecessorCaseId: null,
      candidateCaseIds: [EXISTING_CONTEXT_CASE_IDS.login, EXISTING_CONTEXT_CASE_IDS.profile],
      ancestryCaseIds: [],
      requiredInitialState: [EXISTING_CONTEXT_STATES.authenticated],
      sameSession: true,
    }));
    expect(context.continuation).not.toHaveProperty('guessedPredecessorCaseId');
    expect(validateAddScenarioExistingContext(context)).toEqual({ valid: true, findings: [] });
  });

  it('keeps the actual sensitive sentinel out of context and errors while preserving its approved reference', () => {
    const fixture = buildExistingScenarioContextFixture();
    const context = buildContext(fixture);

    expect(JSON.stringify({ input: fixture.input, options: fixture.options }))
      .toContain(EXISTING_CONTEXT_SENSITIVE_SENTINEL);
    expect(JSON.stringify(context)).not.toContain(EXISTING_CONTEXT_SENSITIVE_SENTINEL);
    expect(context.cases[0].steps[2]).toMatchObject({
      id: 'persisted-login-step-003',
      valueRef: EXISTING_CONTEXT_SENSITIVE_REF,
    });
    expect(context.cases[0].steps[2]).not.toHaveProperty('value');

    const crossProject = structuredClone(fixture.input);
    crossProject.currentCases[1].projectId = EXISTING_CONTEXT_OTHER_PROJECT_ID;
    const error = captureContextError(crossProject, fixture.options);
    expectContextError(error, FINDING_CODES.crossProject);
    expect([error.message, error.stack, JSON.stringify(error)].join('\n'))
      .not.toContain(EXISTING_CONTEXT_SENSITIVE_SENTINEL);
  });

  it('produces a deterministic production digest and deeply immutable canonical context', () => {
    const fixture = buildExistingScenarioContextFixture();
    const baseline = buildContext(fixture);
    const baselineBytes = JSON.stringify(baseline);

    expect(baseline.contextDigest).toBe(computeAddScenarioExistingContextDigest(baseline));
    expect(baseline.contextDigest).toMatch(/^sha256-[a-f0-9]{64}$/);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const repeated = createAddScenarioExistingContext(
        structuredClone(fixture.input),
        structuredClone(fixture.options),
      );
      expect(JSON.stringify(repeated)).toBe(baselineBytes);
      expect(repeated.contextDigest).toBe(baseline.contextDigest);
    }

    const keyReordered = createAddScenarioExistingContext(
      reverseObjectKeys(fixture.input),
      reverseObjectKeys(fixture.options),
    );
    expect(JSON.stringify(keyReordered)).toBe(baselineBytes);
    expect(keyReordered.contextDigest).toBe(computeAddScenarioExistingContextDigest(keyReordered));

    expect(Object.isFrozen(baseline)).toBe(true);
    expect(Object.isFrozen(baseline.generation)).toBe(true);
    expect(Object.isFrozen(baseline.cases)).toBe(true);
    expect(Object.isFrozen(baseline.cases[0])).toBe(true);
    expect(Object.isFrozen(baseline.cases[0].steps)).toBe(true);
    expect(Object.isFrozen(baseline.cases[0].steps[0])).toBe(true);
    expect(Object.isFrozen(baseline.continuation)).toBe(true);
    expect(() => {
      baseline.cases[0].name = 'Mutated case name';
    }).toThrow(TypeError);
    expect(validateAddScenarioExistingContext(baseline)).toEqual({ valid: true, findings: [] });
  });
});
