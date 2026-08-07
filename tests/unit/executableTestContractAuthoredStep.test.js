import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const executableTestContract = require('../../server/services/executableTestContract.js');
const { normaliseSteps } = require('../../server/lib/stepShape.js');

describe('authored semantic step execution contract', () => {
  it('preserves exact authored intent and internal execution hints through run planning', () => {
    const declaredSteps = normaliseSteps([{
      id: 'step-user-8',
      logicalStepId: 'logical-user-8',
      order: 8,
      authoredText: 'Click Save and verify that the employee was created.',
      interpretation: {
        action: 'Click',
        target: 'Save button',
        validation: 'Employee was created',
      },
      atomicActions: [
        { action: 'Click', target: 'Save button' },
        { action: 'Verify', target: 'employee-created result' },
      ],
      executionMode: 'semantic',
      interpretationDiagnostics: [
        { code: 'compound_instruction_split', blocking: false },
      ],
    }]);

    const contract = executableTestContract.buildExecutionContract({
      testCase: {
        id: 'tc-user-authored',
        name: 'User-authored employee flow',
        steps: JSON.stringify(declaredSteps),
        declaredAssertions: '[]',
      },
      declaredSteps,
      declaredAssertions: [],
      runId: 'run-authored',
    });

    expect(contract.nodes).toHaveLength(1);
    expect(contract.nodes[0]).toMatchObject({
      persistedStepId: 'step-user-8',
      plannedText: 'Click Save and verify that the employee was created.',
      authoredText: 'Click Save and verify that the employee was created.',
      executionMode: 'semantic',
    });
    expect(contract.nodes[0].interpretation).toMatchObject({
      action: 'Click',
      target: 'Save button',
      validation: 'Employee was created',
    });
    expect(contract.nodes[0].atomicActions).toHaveLength(2);
    expect(contract.nodes[0].interpretationDiagnostics[0].blocking).toBe(false);
  });

  it('pins exact authored whitespace separately from cleaned planned text', () => {
    const authoredText = '  Click   Save,\nthen verify the employee row.  ';
    const declaredSteps = normaliseSteps([authoredText]);
    const contract = executableTestContract.buildExecutionContract({
      testCase: {
        id: 'tc-exact-authored',
        name: 'Exact authored text',
        steps: JSON.stringify(declaredSteps),
        declaredAssertions: '[]',
      },
      declaredSteps,
      declaredAssertions: [],
      runId: 'run-exact-authored',
    });

    expect(contract.nodes[0].authoredText).toBe(authoredText);
    expect(contract.nodes[0].plannedText).toBe('Click Save, then verify the employee row.');
  });
});
