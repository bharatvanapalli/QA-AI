import fs from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  QAAI_AUTHORING_TEMPLATE,
  convertFlowToTemplate,
  summarizeMessyFlow,
} from '../../src/components/testCases/AuthoringAssist';
import {
  buildStepEditorDraft,
  mergeStepMutationResult,
  StepsPanel,
} from '../../src/pages/TestCases';

function read(relativePath) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('Tests page non-blocking authoring and step editing contract', () => {
  it('summarizes a messy single paragraph with inline data without requiring headings', () => {
    const summary = summarizeMessyFlow(
      'username=admin@example.test password=Secret123 then open login, enter username, '
      + 'enter password, click Login and verify the dashboard is visible',
    );

    expect(summary.scenarios).toBe(1);
    expect(summary.cases).toBe(1);
    expect(summary.steps).toBeGreaterThanOrEqual(2);
    expect(summary.dataValues).toBeGreaterThanOrEqual(2);
    expect(summary.assertions).toBeGreaterThanOrEqual(1);
    expect(summary.cues.join(' ')).toContain('inline data');
  });

  it('keeps the guided format optional and preserves the current messy flow when converting', () => {
    const flow = 'open the user page then click Add and verify the form appears';
    const converted = convertFlowToTemplate(flow);

    expect(QAAI_AUTHORING_TEMPLATE).toContain('User Story:');
    expect(QAAI_AUTHORING_TEMPLATE).toContain('Test Data');
    expect(QAAI_AUTHORING_TEMPLATE).toContain('Scenario 1:');
    expect(converted).toContain(flow);
    expect(converted).toContain('QAAI will extract inline values');
  });

  it('builds an editable logical-step draft without losing the authored instruction', () => {
    const draft = buildStepEditorDraft({
      id: 'logical-2',
      authoredText: 'Enter {{email}} and verify it is accepted.',
      steps: [{
        id: 'atomic-2',
        action: 'Fill',
        target: 'Email field',
        value: '{{email}}',
        expected: 'Email value is accepted',
      }],
    });

    expect(draft).toEqual(expect.objectContaining({
      instruction: 'Enter {{email}} and verify it is accepted.',
      action: 'Fill',
      target: 'Email field',
      value: '{{email}}',
      validation: 'Email value is accepted',
      condition: '',
    }));
  });

  it('uses the server-returned step order and logical count when replacing a case', () => {
    const current = {
      id: 'case-1',
      name: 'Login',
      steps: [{ id: 'step-1', action: 'Open' }, { id: 'step-2', action: 'Click' }],
    };
    const updated = mergeStepMutationResult(current, {
      testCase: {
        id: 'case-1',
        steps: [{ id: 'step-2', action: 'Click' }],
        logicalStepCount: 1,
      },
    });

    expect(updated.name).toBe('Login');
    expect(updated.steps.map((step) => step.id)).toEqual(['step-2']);
    expect(updated.logicalStepCount).toBe(1);
  });

  it('wires every step mutation route and keeps destructive confirmation inside useConfirm', () => {
    const ui = read('src/pages/TestCases.jsx');

    expect(ui).toContain('api.post(`/projects/${current.id}/test-cases/${encodeURIComponent(testCase.id)}/steps`');
    expect(ui).toContain('`/projects/${current.id}/test-cases/${encodeURIComponent(testCase.id)}/steps/${encodeURIComponent(stepId)}`');
    expect(ui).toContain('`/projects/${current.id}/test-cases/${encodeURIComponent(testCase.id)}/steps/order`');
    expect(ui).toContain('`/projects/${current.id}/test-cases/${encodeURIComponent(testCase.id)}/steps/undo`');
    expect(ui).toContain("title: 'Remove this step?'");
    expect(ui).not.toContain('window.confirm(');
    expect(ui).toContain('This change will apply to the next execution.');
  });

  it('uses provider-neutral labels and exposes both preview and continue actions', () => {
    const ui = read('src/pages/TestCases.jsx');

    expect(ui).toContain('QAAI interpretation preview');
    expect(ui).toContain('Preview interpretation');
    expect(ui).toContain('Continue with this flow');
    expect(ui).toContain('QAAI accepts the description as written');
    expect(ui).not.toContain('Claude responded');
    expect(ui).not.toContain('raw Claude output');
    expect(ui).not.toContain('Tell Claude');
    expect(ui).not.toContain('Test Claude understanding');
    expect(ui).not.toContain('Interpret with Claude');
    expect(ui).toContain('onClick={deterministicMode ? onContinue : onApprove}');
    expect(ui).toContain('originalRequest: { ...requestPayload, design }');
    expect(ui).toContain('sessionGuidance: design,');
    expect(ui).not.toContain('sessionGuidance: design.trim()');
  });

  it('edits a logical step in place and sends the preserved step identity', async () => {
    const user = userEvent.setup();
    const onSaveStep = vi.fn().mockResolvedValue({ logicalStepCount: 1 });
    render(
      <StepsPanel
        steps={[{
          id: 'step-stable-2',
          logicalStepId: 'logical-stable-2',
          logicalOrdinal: 1,
          authoredText: 'Enter the original email.',
          action: 'Fill',
          target: 'Email field',
        }]}
        onSaveStep={onSaveStep}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Open options for Step 1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit step' }));
    const instruction = screen.getByRole('textbox', { name: 'Edit step instruction' });
    await user.clear(instruction);
    await user.type(instruction, 'Enter john@example.com and verify it is accepted.');
    await user.click(screen.getByRole('button', { name: 'Save step' }));

    await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
    expect(onSaveStep).toHaveBeenCalledWith(
      'logical-stable-2',
      expect.objectContaining({
        instruction: 'Enter john@example.com and verify it is accepted.',
        action: 'Fill',
        target: 'Email field',
      }),
    );
  });

  it('offers removal undo without hiding the remaining step controls', async () => {
    const user = userEvent.setup();
    const onRemoveStep = vi.fn().mockResolvedValue({
      mutation: { undoAvailable: true, undoToken: 'undo-1' },
    });
    const onUndoStep = vi.fn().mockResolvedValue({ logicalStepCount: 1 });
    render(
      <StepsPanel
        steps={[{
          id: 'step-stable-1',
          logicalStepId: 'logical-stable-1',
          logicalOrdinal: 1,
          authoredText: 'Open the dashboard.',
          action: 'Open',
          target: 'Dashboard',
        }]}
        onRemoveStep={onRemoveStep}
        onUndoStep={onUndoStep}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Open options for Step 1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete step' }));
    await waitFor(() => expect(onRemoveStep).toHaveBeenCalledWith('logical-stable-1', 'Open the dashboard.'));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(onUndoStep).toHaveBeenCalledWith('logical-stable-1', 'undo-1'));
    await user.click(screen.getByRole('button', { name: 'Open options for Step 1' }));
    expect(screen.getByRole('menuitem', { name: 'Edit step' })).toBeVisible();
  });
});
