import { describe, expect, it } from 'vitest';
import actionPlan from '../../server/services/codegen/_actionPlan.js';

describe('action plan recovery shaping', () => {
  it('keeps lost-form-state restore actions as canonical and drops earlier same-step actions', () => {
    const plan = actionPlan.buildActionPlan({
      status: 'pass',
      stepResults: [],
      trail: [
        {
          tool: 'browser_click',
          args: { element: 'Status dropdown', target: 'e10' },
          ok: true,
          stepIndex: 9,
          narration: 'Clicked Status dropdown',
        },
        {
          tool: 'browser_click',
          args: { element: 'Enabled option', target: 'e11' },
          ok: true,
          stepIndex: 9,
          narration: 'Clicked Enabled option',
        },
        {
          tool: 'browser_click',
          args: { element: 'Enabled option', target: 'e51' },
          ok: true,
          stepIndex: 9,
          narration: 'Selected Enabled to restore Status dropdown',
          recoveryReason: 'lost_form_state',
          supersedesStepIndex: 9,
          canonicalForStepIndex: 9,
        },
      ],
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].args.target).toBe('e51');
    expect(plan.actions[0].recoveryReason).toBe('lost_form_state');
    expect(plan.droppedActions.map((a) => a.disposition)).toEqual(['dead', 'dead']);
  });
});
