import { describe, expect, it } from 'vitest';
import pipelineContract from '../../server/services/pipelineContract.js';

describe('pipeline contract', () => {
  it('keeps agent roles separated', () => {
    expect(pipelineContract.ROLE_CONTRACT.architect).toBe('author_candidate_contract');
    expect(pipelineContract.ROLE_CONTRACT.planner).toBe('order_explicit_dependencies_only');
    expect(pipelineContract.ROLE_CONTRACT.conductor).toBe('execute_current_approved_step_only');
    expect(pipelineContract.ROLE_CONTRACT.critic).toBe('diagnose_and_suggest_only');
    expect(pipelineContract.ROLE_CONTRACT.supervisor).toBe('diagnose_and_suggest_only');
    expect(pipelineContract.ROLE_CONTRACT.projectMemory).toBe('locator_resolution_only');
    expect(pipelineContract.ROLE_CONTRACT.exporter).toBe('emit_approved_and_recorded_actions_only');
  });

  it('keeps rewrite auto-apply off unless explicitly enabled', () => {
    expect(pipelineContract.autoApplyAgentRewritesEnabled({})).toBe(false);
    expect(pipelineContract.autoApplyAgentRewritesEnabled({ QAAI_AUTO_APPLY_AGENT_REWRITES: 'off' })).toBe(false);
    expect(pipelineContract.autoApplyAgentRewritesEnabled({ QAAI_AUTO_APPLY_AGENT_REWRITES: 'on' })).toBe(true);
  });

  it('requires real typing tools to complete Fill and Type steps', () => {
    const fillStep = { action: 'Fill', element: 'Username textbox' };
    expect(pipelineContract.toolCanCompleteStep('browser_type', fillStep)).toBe(true);
    expect(pipelineContract.toolCanCompleteStep('browser_fill_form', fillStep)).toBe(true);
    expect(pipelineContract.toolCanCompleteStep('browser_fill', fillStep)).toBe(true);
    expect(pipelineContract.toolCanCompleteStep('browser_click', fillStep)).toBe(false);
    expect(pipelineContract.toolCanCompleteStep('browser_navigate', fillStep)).toBe(false);
    expect(pipelineContract.stepCompletionBlockReason({ toolName: 'browser_click', step: fillStep, stepNo: 4 })?.code)
      .toBe('wrong_tool_for_step_completion');
  });

  it('keeps navigation, click, and select step completion separate', () => {
    expect(pipelineContract.toolCanCompleteStep('browser_navigate', { action: 'Navigate', element: 'Login page', value: '/login' })).toBe(true);
    expect(pipelineContract.toolCanCompleteStep('browser_click', { action: 'Navigate', element: 'Login page', value: '/login' })).toBe(false);
    expect(pipelineContract.toolCanCompleteStep('browser_click', { action: 'Click', element: 'Save button' })).toBe(true);
    expect(pipelineContract.toolCanCompleteStep('browser_navigate', { action: 'Click', element: 'Save button' })).toBe(false);
    expect(pipelineContract.toolCanCompleteStep('browser_select_option', { action: 'Select', element: 'Status dropdown', value: 'Enabled' })).toBe(true);
    expect(pipelineContract.toolCanCompleteStep('browser_click', { action: 'Select', element: 'Status dropdown', value: 'Enabled' })).toBe(true);
    expect(pipelineContract.toolCanCompleteStep('browser_type', { action: 'Select', element: 'Status dropdown', value: 'Enabled' })).toBe(false);
  });

  it('treats helper tools as utility traffic instead of step-completion tools', () => {
    expect(pipelineContract.isStepUtilityTool('browser_snapshot')).toBe(true);
    expect(pipelineContract.isStepUtilityTool('browser_evaluate')).toBe(true);
    expect(pipelineContract.isStepUtilityTool('browser_wait_for')).toBe(false);
    expect(pipelineContract.isStepUtilityTool('browser_click')).toBe(false);
  });

  it('disambiguates checkbox Check actions from verification checks', () => {
    const toggleByRole = { action: 'Check', element: 'Remember me', role: 'checkbox' };
    const toggleByTarget = { action: 'Check', element: 'Accept terms checkbox' };
    const verification = { action: 'Check', element: 'Account summary', expected: 'Visible' };

    expect(pipelineContract.stepCompletionKind(toggleByRole)).toBe('click');
    expect(pipelineContract.stepCompletionKind(toggleByTarget)).toBe('click');
    expect(pipelineContract.toolCanCompleteStep('browser_check', toggleByRole)).toBe(true);
    expect(pipelineContract.toolCanCompleteStep('browser_uncheck', { action: 'Uncheck', element: 'Alerts switch' })).toBe(true);
    expect(pipelineContract.stepCompletionKind(verification)).toBe('verify');
    expect(pipelineContract.toolCanCompleteStep('browser_check', verification)).toBe(false);
  });

  it('produces action-specific guidance for wrong completion tools', () => {
    const reason = pipelineContract.stepCompletionBlockReason({
      toolName: 'browser_navigate',
      step: { action: 'Click', element: 'Save button' },
      stepNo: 16,
    });
    expect(reason?.actionKind).toBe('click');
    expect(reason?.message).toContain('browser_click');
  });
});
