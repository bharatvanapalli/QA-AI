import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  findScenarioDeletionBlockers,
  scenarioDeletionBlockedError,
} = require('../../server/services/scenarioDeletionPolicy');

describe('scenario deletion policy', () => {
  it('allows deleting an immutable-plan leaf while keeping the plan as history', () => {
    const result = findScenarioDeletionBlockers({
      scenarioId: 'scenario-leaf',
      scenarioName: 'Leaf scenario',
      caseIds: ['case-leaf'],
      survivingScenarios: [{ id: 'scenario-parent', name: 'Parent', dependencyOn: '[]' }],
      survivingCases: [{ id: 'case-parent', scenarioId: 'scenario-parent', dependsOnIds: '[]' }],
    });

    expect(result).toEqual({ blocked: false, scenarioDependents: [], caseDependents: [] });
  });

  it('blocks deletion when a surviving scenario depends on the target by id or authored name', () => {
    const result = findScenarioDeletionBlockers({
      scenarioId: 'scenario-login',
      scenarioName: 'Login flow',
      caseIds: ['case-login'],
      survivingScenarios: [
        { id: 'scenario-orders', name: 'Orders', dependencyOn: '["Login flow"]' },
        { id: 'scenario-profile', name: 'Profile', dependencyOn: ['scenario-login'] },
      ],
      survivingCases: [],
    });

    expect(result.blocked).toBe(true);
    expect(result.scenarioDependents.map((row) => row.id)).toEqual([
      'scenario-orders',
      'scenario-profile',
    ]);
  });

  it('blocks deletion when a surviving case depends on any case being deleted', () => {
    const result = findScenarioDeletionBlockers({
      scenarioId: 'scenario-login',
      caseIds: ['case-login', 'case-mfa'],
      survivingScenarios: [],
      survivingCases: [
        { id: 'case-order', name: 'Create order', scenarioId: 'scenario-orders', dependsOnIds: '["case-login"]' },
        { id: 'case-independent', scenarioId: 'scenario-search', dependsOnIds: '[]' },
      ],
    });

    expect(result.blocked).toBe(true);
    expect(result.caseDependents).toEqual([{
      id: 'case-order',
      name: 'Create order',
      scenarioId: 'scenario-orders',
    }]);
    const error = scenarioDeletionBlockedError(result);
    expect(error).toMatchObject({ code: 'SCENARIO_HAS_DEPENDENTS', status: 409 });
  });
});
