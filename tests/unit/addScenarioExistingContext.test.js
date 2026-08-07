import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  EXISTING_SCENARIO_CONTEXT_VERSION,
  CODES,
  ExistingScenarioContextError,
  createAddScenarioExistingContext,
  validateAddScenarioExistingContext,
  computeAddScenarioExistingContextDigest,
} = require('../../server/services/addScenarioExistingContext');

const EMAIL = 'OdysseyOneAutomationTester1@odysseylogistics.com';
const PASSWORD = 'Behavior-ticket-organize1*';

function loginInput() {
  return {
    currentProject: { id: 'project-odyssey', revision: 'project-r7' },
    currentGeneration: {
      id: 'generation-7',
      projectId: 'project-odyssey',
      version: 7,
      isCurrent: true,
    },
    scenarios: [{
      id: 'scenario-login',
      projectId: 'project-odyssey',
      generationId: 'generation-7',
      ordinal: 1,
      name: 'Authenticate and continue',
      dependencyOn: '[]',
      cases: [{
        id: 'case-login',
        projectId: 'project-odyssey',
        generationId: 'generation-7',
        scenarioId: 'scenario-login',
        ordinal: 1,
        name: 'Login through Microsoft',
        updatedAt: '2026-07-17T08:00:00.000Z',
        readinessStatus: 'ready',
        runEligibility: 'eligible',
        sessionMode: 'fresh',
        failurePolicy: 'block_dependents',
        dependsOnIds: '[]',
        requiresStateJson: JSON.stringify({ page: 'email-classifier' }),
        producesStateJson: JSON.stringify({
          page: 'home',
          authenticated: true,
          identity: { email: EMAIL },
          password: PASSWORD,
        }),
        dataBindingJson: JSON.stringify({
          emailRef: '{{login.email}}',
          passwordRef: 'secret:odyssey.password',
          inlineEmail: EMAIL,
          inlinePassword: PASSWORD,
        }),
        steps: JSON.stringify([
          { id: 'step-open', order: 1, action: 'Navigate to the classifier URL.' },
          {
            id: 'step-email',
            order: 2,
            type: 'Fill',
            target: { kind: 'field', role: 'textbox', name: 'Email Address' },
            value: EMAIL,
            valueRef: '{{login.email}}',
            dependsOnIds: ['step-open'],
          },
          {
            id: 'step-password',
            order: 3,
            type: 'Fill',
            target: { kind: 'field', role: 'textbox', name: 'Password' },
            value: PASSWORD,
            valueRef: 'secret:odyssey.password',
            dependsOnIds: ['step-email'],
          },
          {
            id: 'step-home',
            order: 4,
            type: 'AssertVisible',
            target: { kind: 'page', role: 'heading', name: 'Welcome OdysseyOne!' },
            expected: 'Welcome OdysseyOne!',
            dependsOnIds: ['step-password'],
          },
        ]),
      }, {
        id: 'case-admin',
        projectId: 'project-odyssey',
        generationId: 'generation-7',
        scenarioId: 'scenario-login',
        ordinal: 2,
        name: 'Open administration',
        updatedAt: '2026-07-17T08:05:00.000Z',
        readinessStatus: 'ready',
        runEligibility: 'eligible',
        sessionMode: 'continue_from_dependency',
        failurePolicy: 'block_dependents',
        dependsOnIds: JSON.stringify(['case-login']),
        requiresStateJson: JSON.stringify({ page: 'home', authenticated: true }),
        producesStateJson: JSON.stringify({ page: 'administration' }),
        steps: JSON.stringify([
          { id: 'step-admin', order: 1, type: 'Click', target: { role: 'link', name: 'Admin' } },
        ]),
      }],
    }],
    runResults: [
      { id: 'result-login-old', testCaseId: 'case-login', status: 'fail', createdAt: '2026-07-16T08:00:00.000Z' },
      { id: 'result-login', testCaseId: 'case-login', status: 'pass', createdAt: '2026-07-17T09:00:00.000Z' },
      { id: 'result-admin', testCaseId: 'case-admin', status: 'blocked', createdAt: '2026-07-17T09:01:00.000Z' },
    ],
    requestedInitialState: { page: 'home', authenticated: true },
    predecessorCaseId: 'case-login',
  };
}

function captureError(fn) {
  try { fn(); } catch (error) { return error; }
  throw new Error('Expected operation to throw.');
}

describe('ExistingScenarioContextV1', () => {
  it('emits exact ordered persisted identity and state metadata without raw test data', () => {
    const input = loginInput();
    const before = JSON.parse(JSON.stringify(input));
    const context = createAddScenarioExistingContext(input);

    expect(input).toEqual(before);
    expect(context.version).toBe(EXISTING_SCENARIO_CONTEXT_VERSION);
    expect(context.project).toEqual({ id: 'project-odyssey', revision: 'project-r7' });
    expect(context.generation).toMatchObject({ id: 'generation-7', projectId: 'project-odyssey', revision: 7, isCurrent: true });
    expect(context.scenarios[0]).toMatchObject({
      id: 'scenario-login',
      ordinal: 1,
      caseIds: ['case-login', 'case-admin'],
    });
    expect(context.cases.map((entry) => [entry.id, entry.revision, entry.ordinal])).toEqual([
      ['case-login', '2026-07-17T08:00:00.000Z', 1],
      ['case-admin', '2026-07-17T08:05:00.000Z', 2],
    ]);
    expect(context.cases[0]).toMatchObject({
      initialState: { page: 'email-classifier' },
      expectedFinalState: {
        authenticated: true,
        identity: { email: '[REDACTED]' },
        page: 'home',
        password: '[REDACTED]',
      },
      sessionIntent: { mode: 'fresh', failurePolicy: 'block_dependents' },
      dependsOnIds: [],
      approvalState: 'ready',
      runEligibility: 'eligible',
      executionState: 'pass',
      executionResultId: 'result-login',
    });
    expect(context.cases[1]).toMatchObject({
      dependsOnIds: ['case-login'],
      sessionIntent: { mode: 'continue_from_dependency', failurePolicy: 'block_dependents' },
      executionState: 'blocked',
    });
    expect(context.cases[0].operations.map((entry) => ({ id: entry.id, ordinal: entry.ordinal, kind: entry.kind }))).toEqual([
      { id: 'step-open', ordinal: 1, kind: 'action' },
      { id: 'step-email', ordinal: 2, kind: 'action' },
      { id: 'step-password', ordinal: 3, kind: 'action' },
      { id: 'step-home', ordinal: 4, kind: 'assertion' },
    ]);
    expect(context.cases[0].operations[1].inlineDataRefs).toEqual(['{{login.email}}']);
    expect(context.cases[0].operations[2].inlineDataRefs).toEqual(['secret:odyssey.password']);
    expect(context.cases[0].inlineDataRefs).toEqual(['{{login.email}}', 'secret:odyssey.password']);
    expect(JSON.stringify(context)).not.toContain(EMAIL);
    expect(JSON.stringify(context)).not.toContain(PASSWORD);
  });

  it('resolves only a proven explicit predecessor and keeps ambiguous matches unresolved', () => {
    const input = loginInput();
    const context = createAddScenarioExistingContext(input);
    expect(context.continuation).toMatchObject({
      predecessorCaseId: 'case-login',
      status: 'resolved',
      selectedCaseId: 'case-login',
      unresolved: null,
    });
    expect(context.continuation.candidates.map((entry) => entry.caseId)).toEqual(['case-login']);

    const ambiguous = loginInput();
    ambiguous.predecessorCaseId = null;
    ambiguous.scenarios[0].cases.push({
      id: 'case-login-alternative',
      projectId: 'project-odyssey',
      generationId: 'generation-7',
      scenarioId: 'scenario-login',
      ordinal: 3,
      name: 'Alternative login',
      updatedAt: '2026-07-17T08:06:00.000Z',
      readinessStatus: 'ready',
      runEligibility: 'eligible',
      sessionMode: 'fresh',
      failurePolicy: 'block_dependents',
      dependsOnIds: '[]',
      requiresStateJson: JSON.stringify({ page: 'classifier' }),
      producesStateJson: JSON.stringify({ page: 'home', authenticated: true }),
      steps: JSON.stringify([{ id: 'alternative-step', order: 1, type: 'Navigate' }]),
    });
    const unresolved = createAddScenarioExistingContext(ambiguous);
    expect(unresolved.continuation.status).toBe('unresolved');
    expect(unresolved.continuation.selectedCaseId).toBeNull();
    expect(unresolved.continuation.unresolved).toEqual({
      code: 'continuation_ambiguous',
      message: 'More than one existing case can satisfy the requested initial state.',
      candidateCaseIds: ['case-login', 'case-login-alternative'],
    });
  });

  it('preserves an explicit predecessor without fabricating state when semantic state is not authored yet', () => {
    const input = loginInput();
    delete input.requestedInitialState;

    const context = createAddScenarioExistingContext(input);

    expect(context.continuation).toMatchObject({
      requested: true,
      mode: 'continue_from_dependency',
      resolution: 'pending_state_validation',
      status: 'pending_state_validation',
      reason: 'awaiting_requested_initial_state',
      predecessorCaseId: 'case-login',
      selectedCaseId: 'case-login',
      candidateCaseIds: ['case-login'],
      ancestryCaseIds: ['case-login'],
      requestedInitialState: null,
      requiredInitialState: null,
      resolvedFinalState: null,
      finalStateCompatible: null,
      unresolved: null,
    });
    expect(context.continuation.candidates).toEqual([
      expect.objectContaining({
        caseId: 'case-login',
        proof: 'explicit_predecessor_pending_state_validation',
      }),
    ]);
    expect(validateAddScenarioExistingContext(context)).toEqual({ valid: true, findings: [] });
  });

  it('uses persisted ordinals deterministically across scenario and case input order', () => {
    const input = {
      project: { id: 'project-1', revision: 'p1' },
      generation: { id: 'generation-1', projectId: 'project-1', version: 1, isCurrent: true },
      persistedScenarios: [
        { id: 'scenario-2', projectId: 'project-1', generationId: 'generation-1', ordinal: 2, name: 'Second', dependencyOn: ['scenario-1'] },
        { id: 'scenario-1', projectId: 'project-1', generationId: 'generation-1', ordinal: 1, name: 'First', dependencyOn: [] },
      ],
      persistedCases: [
        { id: 'case-2', projectId: 'project-1', generationId: 'generation-1', scenarioId: 'scenario-2', ordinal: 2, updatedAt: '2026-07-17T02:00:00Z', dependsOnIds: ['case-1'], steps: [] },
        { id: 'case-1', projectId: 'project-1', generationId: 'generation-1', scenarioId: 'scenario-1', ordinal: 1, updatedAt: '2026-07-17T01:00:00Z', dependsOnIds: [], steps: [] },
      ],
      requestedInitialState: { state: 'not-produced' },
    };
    const first = createAddScenarioExistingContext(input);
    const repeated = createAddScenarioExistingContext(JSON.parse(JSON.stringify(input)));

    expect(first.scenarios.map((entry) => entry.id)).toEqual(['scenario-1', 'scenario-2']);
    expect(first.cases.map((entry) => [entry.id, entry.ordinal])).toEqual([['case-1', 1], ['case-2', 2]]);
    expect(first).toEqual(repeated);
    expect(first.digest).toBe(repeated.digest);
    expect(first.digest).toBe(computeAddScenarioExistingContextDigest(first));
  });

  it.each([
    ['cross-project scenario', (input) => { input.scenarios[0].projectId = 'project-other'; }, CODES.PROJECT_MISMATCH],
    ['cross-generation case', (input) => { input.scenarios[0].cases[0].generationId = 'generation-other'; }, CODES.GENERATION_MISMATCH],
    ['missing dependency', (input) => { input.scenarios[0].cases[1].dependsOnIds = JSON.stringify(['missing-case']); }, CODES.DEPENDENCY_MISSING],
    ['forward dependency', (input) => { input.scenarios[0].cases[0].dependsOnIds = JSON.stringify(['case-admin']); }, CODES.DEPENDENCY_FORWARD],
    ['duplicate dependency', (input) => { input.scenarios[0].cases[1].dependsOnIds = JSON.stringify(['case-login', 'case-login']); }, CODES.DEPENDENCY_DUPLICATE],
    ['inconsistent ordinal', (input) => { input.scenarios[0].cases[1].ordinal = 3; }, CODES.ORDINAL_NOT_CONTIGUOUS],
  ])('rejects %s', (_label, mutate, expectedCode) => {
    const input = loginInput();
    mutate(input);
    const error = captureError(() => createAddScenarioExistingContext(input));
    expect(error).toBeInstanceOf(ExistingScenarioContextError);
    expect(error.status).toBe(422);
    expect(error.findings.map((finding) => finding.code)).toContain(expectedCode);
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
  });

  it('rejects a non-existent explicit predecessor and reports unprovable continuation explicitly', () => {
    const invalid = loginInput();
    invalid.predecessorCaseId = 'case-does-not-exist';
    const error = captureError(() => createAddScenarioExistingContext(invalid));
    expect(error.findings.map((finding) => finding.code)).toContain(CODES.DEPENDENCY_MISSING);

    const unprovable = loginInput();
    unprovable.predecessorCaseId = null;
    unprovable.requestedInitialState = { page: 'never-produced' };
    const context = createAddScenarioExistingContext(unprovable);
    expect(context.continuation).toMatchObject({
      status: 'unresolved',
      selectedCaseId: null,
      candidates: [],
      unresolved: { code: 'continuation_not_provable', candidateCaseIds: [] },
    });
  });

  it('deep-freezes valid output and detects digest, ordering, and freeze tampering', () => {
    const context = createAddScenarioExistingContext(loginInput());
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.cases)).toBe(true);
    expect(Object.isFrozen(context.cases[0].operations[0])).toBe(true);
    expect(validateAddScenarioExistingContext(context)).toEqual({ valid: true, findings: [] });

    const tampered = JSON.parse(JSON.stringify(context));
    tampered.cases[0].ordinal = 9;
    tampered.digest = computeAddScenarioExistingContextDigest(tampered);
    const validation = validateAddScenarioExistingContext(tampered);
    expect(validation.valid).toBe(false);
    expect(validation.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      CODES.ORDINAL_NOT_CONTIGUOUS,
      CODES.CONTRACT_NOT_FROZEN,
    ]));

    tampered.digest = 'sha256-0000000000000000000000000000000000000000000000000000000000000000';
    expect(validateAddScenarioExistingContext(tampered).findings.map((finding) => finding.code)).toContain(CODES.DIGEST_MISMATCH);
  });
});
