'use strict';

const { buildCaseInstanceV1 } = require('../../server/services/caseInstanceV1');

describe('CaseInstanceV1', () => {
  test('requires an exact case and generation revision', () => {
    expect(() => buildCaseInstanceV1({ testCase: { id: 'case-1' } }))
      .toThrow(/generationId/);
    expect(() => buildCaseInstanceV1({ generationId: 'gen-1' }))
      .toThrow(/testCase\.id/);
  });

  test('redacts sensitive row values and preserves safe fixture data', () => {
    const instance = buildCaseInstanceV1({
      testCase: { id: 'case-1', updatedAt: '2026-07-12T00:00:00.000Z' },
      generationId: 'gen-1',
      dataRow: { fields: [
        { name: 'email', value: 'user@example.test' },
        { name: 'password', value: 'do-not-persist' },
      ] },
      caseContract: {
        inlineData: [
          { name: 'email', used: true, boundStepIds: ['enter-email'] },
          { name: 'password', sensitive: true, used: true, boundStepIds: ['enter-password'] },
        ],
        steps: [
          { id: 'enter-email', dependencyStepIds: [] },
          { id: 'enter-password', dependencyStepIds: ['enter-email'] },
        ],
      },
    });

    const serialized = JSON.stringify(instance);
    expect(serialized).toContain('user@example.test');
    expect(serialized).not.toContain('do-not-persist');
    expect(instance.inlineDataBindings.find((item) => item.name === 'password').reference)
      .toBe('env:QAAI_INLINE_PASSWORD');
    expect(instance.stepDependencyGraph[1].dependencyStepIds).toEqual(['enter-email']);
  });

  test('keeps explicit fresh and continuation boundaries', () => {
    const fresh = buildCaseInstanceV1({
      testCase: { id: 'case-1' },
      generationId: 'gen-1',
      caseContract: { sessionRequirement: 'fresh' },
    });
    const continued = buildCaseInstanceV1({
      testCase: { id: 'case-2' },
      generationId: 'gen-1',
      caseContract: { continueFromCaseId: 'case-1' },
    });
    expect(fresh.sessionPlan.requirement).toBe('fresh');
    expect(continued.sessionPlan).toEqual(expect.objectContaining({
      requirement: 'continue_from_case',
      continueFromCaseId: 'case-1',
    }));
  });
});
