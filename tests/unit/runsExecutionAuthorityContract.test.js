import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('alternate runs execution authority contract', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'server/services/runs.js'), 'utf8');
  const loader = source.slice(
    source.indexOf('async function expandDependenciesAndTopoSort'),
    source.indexOf('async function failRun'),
  );

  it('fails closed instead of dropping a missing prerequisite', () => {
    expect(loader).toContain("err.code = 'PREREQUISITE_MISSING'");
    expect(loader).toContain('err.missingIds = missingIds');
  });

  it.each([
    'declaredAssertions',
    'dataBindingJson',
    'operationsJson',
    'qualityContractJson',
    'rowExecutionPlanJson',
    'sessionMode',
    'failurePolicy',
    'authProfile',
    'requirementRefs',
    'producesData',
    'requiresData',
  ])('loads the persisted %s field for execution', (field) => {
    expect(loader).toContain(`${field}: true`);
  });
});
