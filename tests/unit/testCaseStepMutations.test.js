import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import stepMutations from '../../server/services/testCaseStepMutations.js';
import stepShape from '../../server/lib/stepShape.js';

describe('user-authored test-case step mutations', () => {
  it('preserves unknown natural language exactly and uses a non-blocking semantic fallback', () => {
    const authoredText = 'Do the necessary thing for the newest invoice  ';
    const interpreted = stepMutations.interpretStep({ authoredText });

    expect(interpreted.authoredText).toBe(authoredText);
    expect(interpreted.atomicActions).toHaveLength(1);
    expect(interpreted.atomicActions[0].action).toBe('Semantic');
    expect(interpreted.atomicActions[0].executionMode).toBe('semantic');
    expect(stepShape.normaliseStepShape(interpreted.atomicActions[0], 1)).toMatchObject({
      action: 'Semantic',
      element: 'Do the necessary thing for the newest invoice',
    });
    expect(interpreted.diagnostics).toContainEqual(expect.objectContaining({
      code: 'semantic_runtime_fallback',
      level: 'info',
    }));
  });

  it('decomposes action plus verification into one logical step with executable atomic children', () => {
    const result = stepMutations.addStep([], {
      authoredText: 'Click Save and verify the success message is visible.',
    });

    expect(result.logicalStepCount).toBe(1);
    expect(result.atomicActionCount).toBe(2);
    expect(result.steps.map((step) => step.action)).toEqual(['Click', 'Verify']);
    expect(new Set(result.steps.map((step) => step.logicalStepId)).size).toBe(1);
    expect(result.steps.every((step) => (
      step.authoredText === 'Click Save and verify the success message is visible.'
    ))).toBe(true);
    expect(result.steps[0].atomicActions).toHaveLength(2);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'compound_step_decomposed',
    }));
  });

  it('replaces a logical step in place and preserves IDs of surviving rows', () => {
    const original = [
      {
        id: 'step-a',
        contractStepId: 'step-a',
        logicalStepId: 'logical-a',
        order: 1,
        action: 'Click',
        element: 'Old button',
        authoredText: 'Click the old button.',
      },
      {
        id: 'step-b',
        contractStepId: 'step-b',
        logicalStepId: 'logical-b',
        order: 2,
        action: 'Verify',
        expected: 'Dashboard is visible',
        authoredText: 'Verify the dashboard is visible.',
      },
    ];

    const result = stepMutations.editStep(original, 'logical-a', {
      action: 'Fill',
      target: 'Email field',
      value: 'john@example.com',
      expected: 'Email value is accepted',
    });

    expect(result.logicalStepCount).toBe(2);
    expect(result.steps[0]).toMatchObject({
      id: 'step-a',
      logicalStepId: 'logical-a',
      order: 1,
      action: 'Fill',
      element: 'Email field',
      value: 'john@example.com',
    });
    expect(result.steps[0].authoredText).toContain('john@example.com');
    const untouched = result.steps.find((step) => step.id === 'step-b');
    expect(untouched).toMatchObject({
      id: 'step-b',
      logicalStepId: 'logical-b',
    });
    expect(untouched.order).toBe(result.steps.length);
  });

  it('removes a complete logical group, renumbers rows, and reconnects a stale dependency', () => {
    const original = [
      {
        id: 'step-a',
        logicalStepId: 'logical-a',
        order: 1,
        action: 'Open',
        element: 'Users page',
      },
      {
        id: 'step-b1',
        logicalStepId: 'logical-b',
        order: 2,
        action: 'Click',
        element: 'Save button',
        atomicOrdinal: 1,
        atomicCount: 2,
      },
      {
        id: 'step-b2',
        logicalStepId: 'logical-b',
        order: 3,
        action: 'Verify',
        expected: 'Saved',
        atomicOrdinal: 2,
        atomicCount: 2,
      },
      {
        id: 'step-c',
        logicalStepId: 'logical-c',
        order: 4,
        action: 'Click',
        element: 'Continue button',
        dependsOn: ['step-b2'],
      },
    ];

    const result = stepMutations.removeStep(original, 'step-b1');

    expect(result.logicalStepCount).toBe(2);
    expect(result.atomicActionCount).toBe(2);
    expect(result.steps.map((step) => step.id)).toEqual(['step-a', 'step-c']);
    expect(result.steps.map((step) => step.order)).toEqual([1, 2]);
    expect(result.steps[1].dependsOn).toEqual(['step-a']);
    expect(result.removedStep).toMatchObject({
      logicalStepId: 'logical-b',
      atomicActionCount: 2,
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'dependency_reconnected',
      stepId: 'step-c',
    }));
  });

  it('reorders logical groups without changing their stable IDs', () => {
    const original = [
      { id: 'step-a', logicalStepId: 'logical-a', order: 1, action: 'Open' },
      { id: 'step-b', logicalStepId: 'logical-b', order: 2, action: 'Click' },
      { id: 'step-c', logicalStepId: 'logical-c', order: 3, action: 'Verify' },
    ];

    const result = stepMutations.reorderSteps(original, ['logical-c', 'logical-a', 'logical-b']);

    expect(result.steps.map((step) => step.id)).toEqual(['step-c', 'step-a', 'step-b']);
    expect(result.steps.map((step) => step.order)).toEqual([1, 2, 3]);
    expect(result.logicalStepCount).toBe(3);
  });

  it('rejects stale IDs but not semantic uncertainty', () => {
    expect(() => stepMutations.editStep(
      [{ id: 'step-a', logicalStepId: 'logical-a', action: 'Click' }],
      'missing-step',
      { authoredText: 'Whatever the user wants to do next' },
    )).toThrowError(expect.objectContaining({
      code: 'STALE_STEP_ID',
      status: 409,
    }));

    expect(() => stepMutations.addStep([], {
      authoredText: 'Whatever the user wants to do next',
    })).not.toThrow();
    expect(() => stepMutations.addStep([], {})).toThrowError(expect.objectContaining({
      code: 'EMPTY_STEP',
      status: 400,
    }));
  });

  it('persists with compare-and-swap while preserving approval and execution status fields', async () => {
    const current = {
      id: 'case-1',
      projectId: 'project-1',
      status: 'approved',
      runEligibility: 'allowed',
      specCode: 'old generated script',
      steps: JSON.stringify([
        {
          id: 'step-a',
          logicalStepId: 'logical-a',
          action: 'Click',
          element: 'Old button',
          authoredText: 'Click the old button.',
        },
      ]),
    };
    let updateArgs = null;
    const tx = {
      testCase: {
        findFirst: async () => current,
        updateMany: async (args) => {
          updateArgs = args;
          return { count: 1 };
        },
        findUnique: async () => ({ ...current, ...updateArgs.data }),
      },
    };
    const prisma = {
      $transaction: async (callback) => callback(tx),
    };

    const result = await stepMutations.persistMutation({
      prisma,
      projectId: 'project-1',
      testCaseId: 'case-1',
      type: 'edit',
      stepId: 'logical-a',
      step: { authoredText: 'Click the new button.' },
    });

    expect(updateArgs.where).toEqual({
      id: 'case-1',
      projectId: 'project-1',
      steps: current.steps,
    });
    expect(updateArgs.data.specCode).toBeNull();
    expect(updateArgs.data).not.toHaveProperty('status');
    expect(updateArgs.data).not.toHaveProperty('runEligibility');
    expect(result.testCase.status).toBe('approved');
    expect(result.appliesTo).toBe('next_execution');
  });
});

describe('step mutation route contract', () => {
  it('wires CSRF-protected add, edit, remove, reorder, and undo endpoints', () => {
    const source = readFileSync(resolve(process.cwd(), 'server/routes/testCases.js'), 'utf8');

    expect(source).toContain("router.post('/:tcId/steps', requireCsrf");
    expect(source).toContain("router.patch('/:tcId/steps/:stepId', requireCsrf");
    expect(source).toContain("router.delete('/:tcId/steps/:stepId', requireCsrf");
    expect(source).toContain("router.patch('/:tcId/steps/order', requireCsrf");
    expect(source).toContain("router.post('/:tcId/steps/undo', requireCsrf");
    expect(source).toContain("type: 'testcases.updated'");
    expect(source).toContain("mode: 'observation_only'");
    expect(source).toContain('wouldHaveBlockedRun');
  });

  it('keeps strict generation compilation out of the manual mutation service', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'server/services/testCaseStepMutations.js'),
      'utf8',
    );

    expect(source).not.toContain("require('./testDesignStepCompiler')");
    expect(source).not.toContain('mutationBlockedPayload');
    expect(source).toContain("executionMode: action === 'Semantic' ? 'semantic' : 'structured'");
    expect(source).toContain("specCode: null");
  });
});
