import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const planner = require('../../server/services/addScenarioSemanticPlanner');
const {
  createAddScenarioExistingContext,
} = require('../../server/services/addScenarioExistingContext');

const here = path.dirname(fileURLToPath(import.meta.url));
const routePath = path.resolve(here, '../../server/routes/scenarios.js');

function compactSemanticPlan() {
  return {
    version: 'SemanticIntentPlanV1',
    cases: [{
      name: 'Continue and verify the summary',
      intent: 'Continue the authored flow and verify its result.',
      initialState: 'The existing session is available.',
      expectedFinalState: 'The Summary heading is visible.',
      actions: [{
        type: 'Click',
        sourceQuote: 'Click the Continue button.',
        target: { kind: 'control', label: 'Continue', role: 'button' },
      }],
      assertions: [{
        type: 'AssertVisible',
        sourceQuote: 'Verify the Summary heading is visible.',
        target: { kind: 'region', label: 'Summary heading', role: 'heading' },
      }],
    }],
  };
}

function promptInput(call) {
  const content = call.messages[0].content;
  const prefix = 'INPUT_JSON:\n';
  const suffix = '\nReturn JSON only.';
  const start = content.indexOf(prefix);
  const end = content.lastIndexOf(suffix);
  return JSON.parse(content.slice(start + prefix.length, end));
}

describe('Add Scenario existing-context route/planner integration', () => {
  it('forwards the resolved inferred predecessor through a canonical context without raw project secrets', async () => {
    const routeSource = fs.readFileSync(routePath, 'utf8');
    const assemblerCall = routeSource.indexOf('createAddScenarioExistingContext({');
    const plannerCall = routeSource.indexOf('addScenarioSemanticPlanner.planAddScenario({', assemblerCall);
    const boundary = routeSource.slice(assemblerCall, plannerCall + 1_500);

    expect(assemblerCall).toBeGreaterThan(0);
    expect(plannerCall).toBeGreaterThan(assemblerCall);
    expect(routeSource).toContain(
      'const resolvedContinuationParentCaseId = appendContinuationParentCase?.id || continuationParentCaseId || null;',
    );
    expect(boundary).toContain('generation: appendCurrentGeneration');
    expect(boundary).toContain('scenarios: appendExistingScenarios');
    expect(boundary).toContain('predecessorCaseId: resolvedContinuationParentCaseId');
    expect(boundary).toContain('sameSession: continuationRequested');
    expect(boundary).toContain('existingScenarioContext,');
    expect(boundary).not.toContain('requestedInitialState:');
    expect(boundary).not.toContain('producesStateJson');

    const secret = 'route-planner-secret-sentinel';
    const projectId = 'project-route-planner';
    const generationId = 'generation-route-planner';
    const inferredParentCaseId = 'case-inferred-login-parent';
    const rawProject = {
      id: projectId,
      testCredentials: JSON.stringify([{ email: 'tester@example.test', password: secret }]),
      contextExtraHeaders: JSON.stringify({ Authorization: `Bearer ${secret}` }),
    };
    const generation = {
      id: generationId,
      projectId,
      version: 3,
      isCurrent: true,
    };
    const scenarios = [{
      id: 'scenario-existing-login',
      projectId,
      generationId,
      name: 'Existing login',
      dependencyOn: null,
      cases: [{
        id: inferredParentCaseId,
        projectId,
        generationId,
        scenarioId: 'scenario-existing-login',
        name: 'Log in and reach Home',
        steps: JSON.stringify([{
          id: 'step-existing-login',
          order: 1,
          action: 'Click Continue',
          target: { kind: 'control', name: 'Continue' },
          valueRef: 'credential:standard-user.password',
        }]),
        dependsOnIds: null,
        requiresStateJson: JSON.stringify([]),
        producesStateJson: JSON.stringify([{ key: 'authenticated_session', type: 'auth_session' }]),
        sessionMode: 'fresh',
        failurePolicy: 'block_dependents',
      }],
    }];
    const existingScenarioContext = createAddScenarioExistingContext({
      project: rawProject,
      generation,
      scenarios,
      continuation: {
        requested: true,
        mode: 'continue_from_dependency',
        predecessorCaseId: inferredParentCaseId,
        sameSession: true,
      },
    });
    const sourceText = 'Click the Continue button. Verify the Summary heading is visible.';
    const provider = {
      name: 'claude',
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(compactSemanticPlan()) }],
        stop_reason: 'end_turn',
      }),
    };

    await planner.planAddScenario({
      sourceText,
      provider: 'claude',
      apiKey: 'test-key',
      model: 'test-model',
      continuationContext: {
        requested: true,
        predecessorCaseId: inferredParentCaseId,
        currentGenerationId: generationId,
      },
      currentCases: existingScenarioContext.cases,
      existingScenarioContext,
    }, { provider });

    const input = promptInput(provider.complete.mock.calls[0][0]);
    const wholeContext = input.WHOLE_CONTEXT;
    expect(wholeContext.continuation.predecessorCaseId).toBe(inferredParentCaseId);
    expect(wholeContext.existingScenarioContext.continuation.predecessorCaseId)
      .toBe(inferredParentCaseId);
    expect(wholeContext.existingScenarioContext.continuation).toMatchObject({
      requestedInitialState: null,
      predecessorCaseId: inferredParentCaseId,
      resolution: 'pending_state_validation',
    });
    expect(wholeContext.existingScenarioContext)
      .toEqual(JSON.parse(JSON.stringify(existingScenarioContext)));
    expect(wholeContext.existingScenarioContext.project).toEqual({ id: projectId, revision: null });
    expect(wholeContext).not.toHaveProperty('project');
    expect(JSON.stringify(wholeContext)).not.toContain(secret);
    expect(JSON.stringify(wholeContext)).not.toContain('testCredentials');
    expect(JSON.stringify(wholeContext)).not.toContain('contextExtraHeaders');
  });
});
