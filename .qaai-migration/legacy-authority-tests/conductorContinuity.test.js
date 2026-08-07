import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const conductor = require('../../server/services/agents/conductorPinned');
const { proveEffect } = require('../../server/services/postActionEffectProof');
const deterministicActionEngine = require('../../server/services/agents/deterministicActionEngine');

describe('conductor scenario conversation continuity', () => {
  it('continues after observation assertions but blocks dependent flow for failed action postconditions', () => {
    expect(conductor._typedVerifyMustBlock({
      action: 'Verify',
      stepKind: 'verification',
      flowImpact: 'observation',
      failureBehavior: 'continue',
    }, 'blocked', 'text')).toBe(false);
    expect(conductor._typedVerifyMustBlock({
      action: 'Verify',
      flowImpact: 'observation',
    }, 'blocked', 'count_matches')).toBe(false);
    expect(conductor._typedVerifyMustBlock({
      action: 'Verify',
      requiredForContinuation: true,
    }, 'blocked', 'visible')).toBe(true);
    expect(conductor._typedVerifyMustBlock({
      action: 'Fill',
      flowImpact: 'state_change',
    }, 'blocked', 'value')).toBe(true);
    expect(conductor._typedVerifyMustBlock({
      action: 'Click',
      flowImpact: 'state_change',
    }, 'blocked', 'page_ready')).toBe(true);
    expect(conductor._typedVerifyMustBlock({
      action: 'Verify',
      failurePolicy: { onAssertionFailure: 'block_dependents' },
    }, 'blocked', 'tooltip_visible')).toBe(true);
    expect(conductor._typedVerifyMustBlock({
      action: 'Verify',
      failurePolicy: { onAssertionFailure: 'continue_independent' },
    }, 'blocked', 'text')).toBe(false);
  });

  it('records checked non-dependent mismatches as failed while leaving uncheckable checks non-failing', () => {
    expect(conductor._operationCheckReportStatus({
      status: 'blocked', matched: false, checked: true, required: false,
    })).toBe('fail');
    expect(conductor._operationCheckReportStatus({
      status: 'blocked', matched: false, checked: true, required: true,
    })).toBe('blocked');
    expect(conductor._operationCheckReportStatus({
      status: 'blocked', matched: null, checked: false, required: false,
    })).toBe('warning');
  });

  it('distinguishes visual tooltip capture from DOM/accessibility-only proof', () => {
    expect(conductor._tooltipProofMetadata({
      matched: true,
      actionTooltip: { source: 'browser_evaluate_visual_observation' },
    })).toEqual({
      proofType: 'visual',
      visualCaptured: true,
      proofSource: 'browser_evaluate_visual_observation',
    });
    expect(conductor._tooltipProofMetadata({
      matched: true,
      roleTooltip: true,
    })).toEqual({
      proofType: 'semantic',
      visualCaptured: false,
      proofSource: 'accessibility_tooltip_role',
    });
    expect(conductor._tooltipProofMetadata({
      matched: true,
      domTooltip: { source: 'hover_target_semantic_attribute' },
    })).toEqual({
      proofType: 'semantic',
      visualCaptured: false,
      proofSource: 'hover_target_semantic_attribute',
    });
  });

  it('keeps literal text divergence as a failed assertion contract rather than an uncheckable warning', () => {
    const source = fs.readFileSync('server/services/agents/conductor.js', 'utf8');
    expect(source).toContain("status: 'blocked', matched: false, checked: true, reason: 'text_not_matched'");
    expect(source).not.toContain("reason: 'text_uncheckable_soft'");
  });

  it('guards post-action closeout so passive final checks do not require another model turn', () => {
    const source = fs.readFileSync('server/services/agents/conductor.js', 'utf8');
    const passSideEffects = source.indexOf('if (reducedStep.advance)');
    const drain = source.indexOf("post_tool_step_drain", passSideEffects);
    const closeout = source.indexOf("backend_auto_closeout", drain);

    expect(passSideEffects).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(passSideEffects);
    expect(closeout).toBeGreaterThan(drain);
  });

  it('suppresses stale mutating tool plans after all approved steps are complete', () => {
    const source = fs.readFileSync('server/services/agents/conductor.js', 'utf8');
    const toolUseBranch = source.indexOf("} else if (block.type === 'tool_use')");
    const suppression = source.indexOf('final verification is observation-only', toolUseBranch);
    const actionTrailEmission = source.indexOf("type: 'browser.action'", suppression);

    expect(toolUseBranch).toBeGreaterThan(-1);
    expect(suppression).toBeGreaterThan(toolUseBranch);
    expect(actionTrailEmission).toBeGreaterThan(suppression);
  });

  it('appends continuation case prompts to the existing scenario conversation', () => {
    const scenarioContext = {
      messages: [
        { role: 'user', content: 'TC1 prompt' },
        { role: 'assistant', content: [{ type: 'text', text: 'TC1 completed' }] },
      ],
    };
    const originalMessages = scenarioContext.messages;

    const messages = conductor._appendCaseMessageToScenarioContext(
      scenarioContext,
      'TC2 continuation prompt',
      { freshConversationMessage: false },
    );

    expect(messages).toBe(originalMessages);
    expect(scenarioContext.messages).toBe(originalMessages);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ role: 'user', content: 'TC2 continuation prompt' });
  });

  it('starts a new conversation when the case is explicitly fresh', () => {
    const scenarioContext = {
      messages: [
        { role: 'user', content: 'TC1 prompt' },
        { role: 'assistant', content: [{ type: 'text', text: 'TC1 completed' }] },
      ],
    };
    const originalMessages = scenarioContext.messages;

    const messages = conductor._appendCaseMessageToScenarioContext(
      scenarioContext,
      'TC2 fresh prompt',
      { freshConversationMessage: true },
    );

    expect(messages).not.toBe(originalMessages);
    expect(scenarioContext.messages).toBe(messages);
    expect(messages).toEqual([{ role: 'user', content: 'TC2 fresh prompt' }]);
  });

  it('rejects disabled or readonly credential controls through the generic Fill resolver', () => {
    const disabledIdentifierPage = [
      '- heading "Sign in"',
      '- text "Enter a valid email address, phone number, or Skype name."',
      '- textbox "Email, phone, or Skype" [disabled] [ref=e29]',
      '- button "Next" [ref=e36]',
    ].join('\n');
    const readonlyPasswordPage = [
      '- heading "Enter password"',
      '- textbox "Password" [readonly] [ref=e40]',
      '- button "Sign in" [ref=e45]',
    ].join('\n');

    expect(conductor._resolveEditableControl(disabledIdentifierPage, 'Email field')).toMatchObject({
      field: null,
      reason: 'no_editable_control',
    });
    expect(conductor._resolveEditableControl(readonlyPasswordPage, 'Password field')).toMatchObject({
      field: null,
      reason: 'no_editable_control',
    });
  });

  it('requires a second equivalent page-ready observation after cached proof', async () => {
    let refreshCalls = 0;
    const cachedProbe = { matched: true, reason: 'page_state_observed', evidence: 'cached proof' };
    const result = await conductor._resolvePageReadyProbe({
      cachedProbe,
      refreshProbe: async () => {
        refreshCalls += 1;
        return { ...cachedProbe };
      },
      timeoutMs: 1_500,
      pollIntervalMs: 250,
      stableObservations: 2,
    });

    expect(result).toEqual({
      matched: true,
      probe: cachedProbe,
      source: 'stable_fresh',
      attempts: 1,
      consecutiveEquivalent: 2,
    });
    expect(refreshCalls).toBe(1);
  });

  it('polls page-ready evidence within budget and returns typed QAAI uncertainty when inconclusive', async () => {
    let refreshCalls = 0;
    let now = 0;
    const result = await conductor._resolvePageReadyProbe({
      cachedProbe: { matched: false, reason: 'cached_miss' },
      refreshProbe: async () => {
        refreshCalls += 1;
        return { matched: false, reason: 'fresh_miss', evidence: 'not present' };
      },
      timeoutMs: 500,
      pollIntervalMs: 250,
      stableObservations: 2,
      qaaiNow: () => now,
      qaaiSleep: async (ms) => { now += ms; },
    });

    expect(refreshCalls).toBe(3);
    expect(result).toEqual({
      matched: false,
      probe: { matched: false, reason: 'fresh_miss', evidence: 'not present' },
      source: 'qaai_transition_evidence_inconclusive',
      attempts: 3,
      consecutiveEquivalent: 0,
      qaaiEvidenceError: true,
    });
  });

  it('validates cached snapshots immediately and caps refresh at one attempt', async () => {
    let refreshCalls = 0;
    const cached = await conductor._validateSnapshotSinglePassPolicy({
      cachedSnapshot: '- heading "Password"',
      refreshSnapshot: async () => {
        refreshCalls += 1;
        return { text: '- heading "Other"', fresh: true };
      },
      probe: (snapshotText) => snapshotText.includes('Password'),
    });
    expect(cached.matched).toBe(true);
    expect(cached.source).toBe('cached');
    expect(cached.freshSnapshotAttempts).toBe(0);
    expect(refreshCalls).toBe(0);

    const refreshed = await conductor._validateSnapshotSinglePassPolicy({
      cachedSnapshot: '- heading "Sign in"',
      refreshSnapshot: async () => {
        refreshCalls += 1;
        return { text: '- heading "Password"', fresh: true };
      },
      probe: (snapshotText) => snapshotText.includes('Password'),
    });
    expect(refreshed.matched).toBe(true);
    expect(refreshed.source).toBe('fresh');
    expect(refreshed.freshSnapshotAttempts).toBe(1);
    expect(refreshCalls).toBe(1);
  });

  it('does not treat a blank or failed snapshot as proof of absence', async () => {
    let probeCalls = 0;
    const result = await conductor._validateSnapshotSinglePassPolicy({
      cachedSnapshot: '',
      refreshSnapshot: async () => ({ text: '', fresh: false }),
      probe: (snapshotText) => {
        probeCalls += 1;
        return !snapshotText.includes('Password');
      },
    });

    expect(result.matched).toBe(false);
    expect(result.source).toBe('refresh_failed');
    expect(result.freshSnapshotAttempts).toBe(1);
    expect(probeCalls).toBe(0);
  });

  it('allows browser waits only for explicitly authored wait steps', () => {
    expect(conductor._approvedStepAllowsBrowserWait({ action: 'Wait', element: 'Loading spinner' })).toBe(true);
    expect(conductor._approvedStepAllowsBrowserWait({ action: 'Click', waitContract: { kind: 'stabilization' } })).toBe(true);
    expect(conductor._approvedStepAllowsBrowserWait({ action: 'Click', waitContract: { kind: 'navigation', timeoutMs: 30000 } })).toBe(false);
    expect(conductor._approvedStepAllowsBrowserWait({ action: 'Verify', operationCheck: { kind: 'page_ready', timeoutMs: 30000 } })).toBe(false);
    expect(conductor._approvedStepAllowsBrowserWait({ action: 'Click', name: 'Click Next and wait for password' })).toBe(false);
  });

  it('keeps fast verification deterministic and reserves semantic fallback for thorough mode', () => {
    expect(conductor._selectEffectiveVerifierMode('fast', 'semantic_fallback')).toBe('deterministic');
    expect(conductor._selectEffectiveVerifierMode('fast', 'deterministic')).toBe('deterministic');
    expect(conductor._selectEffectiveVerifierMode('thorough', 'semantic_fallback')).toBe('semantic_fallback');
    expect(conductor._selectEffectiveVerifierMode('thorough', 'deterministic')).toBe('deterministic');
  });

  it('drains passive and deterministic steps to a bounded fixed point', async () => {
    const kinds = ['passive', 'deterministic', 'passive', 'deterministic'];
    const order = [];
    let index = 0;
    const drain = (kind) => async () => {
      order.push(kind);
      let count = 0;
      while (kinds[index] === kind) {
        index += 1;
        count += 1;
      }
      return count;
    };

    const result = await conductor._drainExecutionFixedPoint({
      getCurrentStepIndex: () => index,
      totalSteps: kinds.length,
      drainPassive: drain('passive'),
      drainDeterministic: drain('deterministic'),
    });

    expect(index).toBe(kinds.length);
    expect(result.advanced).toBe(kinds.length);
    expect(result.passiveCount).toBe(2);
    expect(result.deterministicCount).toBe(2);
    expect(order.slice(0, 3)).toEqual(['passive', 'deterministic', 'passive']);
    expect(result.passes).toBeLessThanOrEqual(kinds.length + 1);
  });

  it('does not re-probe an unmatched passive step when deterministic execution made no progress', async () => {
    let passiveCalls = 0;
    let deterministicCalls = 0;
    const result = await conductor._drainExecutionFixedPoint({
      getCurrentStepIndex: () => 2,
      totalSteps: 8,
      drainPassive: async () => {
        passiveCalls += 1;
        return 0;
      },
      drainDeterministic: async () => {
        deterministicCalls += 1;
        return 0;
      },
    });

    expect(result.advanced).toBe(0);
    expect(result.passes).toBe(1);
    expect(passiveCalls).toBe(1);
    expect(deterministicCalls).toBe(1);
  });

  it('extracts concrete landing text from page-ready instructions instead of filler words', () => {
    const signals = conductor._concreteTextSignalsFromExpectation(
      'Open User Management from the existing authenticated session.',
      'User Management menu icon',
    );
    const words = conductor._operationalProbeWords(
      'User Management page is loaded after opening the requested navigation item.',
    );
    const landedSnapshot = [
      '- main',
      '- heading "User Management"',
      '- text "Dashboard > User Management"',
      '- tab "All Users 65"',
      '- tab "Active 62"',
      '- table "Users"',
    ].join('\n');

    expect(signals).toContain('User Management');
    expect(words).toEqual(['user', 'management']);
    expect(words).not.toEqual(expect.arrayContaining(['after', 'opening', 'navigation', 'item']));
    expect(conductor._snapshotContainsConcreteTextSignal(landedSnapshot, signals)).toBe(true);
  });

  it('does not fabricate an action attempt for trail-free internal state reconciliation', () => {
    expect(conductor._shouldRecordStepAttempt({
      operationResult: { matched: true, reason: 'declared transition already reached' },
      internalOperationCompletion: true,
    })).toBe(false);
    expect(conductor._shouldRecordStepAttempt({
      latestTrail: { tool: 'browser_click', toolUseId: 'real-click' },
      operationResult: { matched: true },
      internalOperationCompletion: true,
    })).toBe(true);
    expect(conductor._shouldRecordStepAttempt({
      operationResult: { matched: true },
      internalOperationCompletion: false,
    })).toBe(true);
  });

  it('still rejects unregistered executable tools', () => {
    const positiveOperationResult = {
      status: 'pass', matched: true, checked: true, kind: 'operation_check',
    };
    expect(conductor._validateRuntimeToolForStepCompletion({
      status: 'pass',
      toolName: 'not_a_browser_tool',
      operationResult: positiveOperationResult,
      internalOperationCompletion: false,
    })).toMatchObject({
      status: 'blocked',
      reason: 'unregistered_runtime_tool',
      toolName: 'not_a_browser_tool',
    });
  });

  it('accepts WaitForState as a non-blocking internal wait without browser dispatch', () => {
    expect(conductor._validateRuntimeToolForStepCompletion({
      status: 'pass',
      toolName: 'internal_wait_for_state',
      step: { action: 'WaitForState', target: 'destination page' },
      operationResult: {
        status: 'pass',
        matched: null,
        checked: true,
        kind: 'wait_advisory',
        required: false,
      },
      internalOperationCompletion: true,
    })).toMatchObject({
      status: 'pass',
      reason: null,
      toolName: '',
    });
  });

  it('accepts scroll positioning as a non-blocking internal utility completion', () => {
    expect(conductor._validateRuntimeToolForStepCompletion({
      status: 'pass',
      toolName: 'internal_scroll_utility',
      step: { action: 'Scroll', target: 'Planning Date/Time section' },
      operationResult: {
        status: 'pass',
        matched: null,
        checked: true,
        kind: 'scroll_utility',
        required: false,
      },
      internalOperationCompletion: true,
    })).toMatchObject({
      status: 'pass',
      reason: null,
      toolName: '',
    });
  });

  it('accepts an authored on-false skip when an optional control is absent', () => {
    expect(conductor._validateRuntimeToolForStepCompletion({
      status: 'pass',
      toolName: 'generic_transition_already_satisfied',
      step: {
        action: 'Click',
        condition: {
          kind: 'authored_predicate',
          predicate: 'the optional prompt is visible',
          onFalse: 'skip',
        },
      },
      operationResult: {
        status: 'pass',
        reason: 'optional_target_absent',
        checked: true,
        matched: true,
        kind: 'operation_check',
        required: false,
      },
      internalOperationCompletion: true,
    })).toMatchObject({
      status: 'pass',
      reason: null,
      toolName: '',
    });
  });

  it('allows only confirmed exact-node Fill readback to pass', () => {
    for (const readback of ['unknown', 'nonempty', 'empty', 'mismatch']) {
      const result = deterministicActionEngine.readbackDisposition({
        label: 'Any editable field',
        value: 'approved value',
        readback,
        sensitive: false,
      });
      expect(result.status, readback).toBe('blocked');
      expect(result.matched, readback).toBe(false);
    }

    expect(deterministicActionEngine.readbackDisposition({
      label: 'Any editable field',
      value: 'approved value',
      readback: 'confirmed',
      sensitive: false,
    })).toMatchObject({ status: 'pass', matched: true });
  });

  it('routes authored date operations through persistent owner readback', () => {
    expect(deterministicActionEngine.stepKind({
      action: 'Date',
      element: 'Early Pickup Date calendar',
      value: '2026-08-20',
    })).toBe('date');

    const source = fs.readFileSync('server/services/agents/conductor.js', 'utf8');
    expect(source).toContain('deterministicDomSetDateByLabel');
    expect(source).toContain('date_owner_persisted_after_rerender');
    expect(source).toContain("const isDate = kernelKind === 'date'");
  });

  it('keeps explicit select intent ahead of a legacy fill classification', () => {
    const legacyContract = {
      isFillOrTypeStep: () => true,
      isSelectStep: () => true,
    };
    expect(deterministicActionEngine.stepKind({
      action: 'Select',
      element: 'Any custom combobox',
      value: 'Expected option',
    }, legacyContract)).toBe('select');
  });

  it('lets successful uncheckable action-completed clicks advance to the next step', () => {
    expect(conductor._uncheckableActionCompletedCanAdvance({
      record: {
        status: 'skipped',
        matched: null,
        checked: false,
        reason: 'no_deterministic_action_state_probe',
        kind: 'operation_check',
      },
      step: {
        action: 'Click',
        element: 'Continue button',
        operationCheck: { kind: 'action_completed' },
      },
      hasNextStep: true,
      toolName: 'browser_click',
    })).toBe(true);

    expect(conductor._uncheckableActionCompletedCanAdvance({
      record: {
        status: 'skipped',
        matched: null,
        checked: false,
        reason: 'no_deterministic_action_state_probe',
        kind: 'operation_check',
      },
      step: {
        action: 'Click',
        element: 'Continue button',
        operationCheck: { kind: 'action_completed' },
      },
      hasNextStep: true,
      toolName: 'browser_type',
    })).toBe(false);

    expect(conductor._uncheckableActionCompletedCanAdvance({
      record: {
        status: 'skipped',
        matched: null,
        checked: false,
        reason: 'no_deterministic_action_state_probe',
        kind: 'operation_check',
      },
      step: {
        action: 'Click',
        element: 'Final submit',
        operationCheck: { kind: 'action_completed' },
      },
      hasNextStep: false,
      toolName: 'browser_click',
    })).toBe(false);
  });

  it('allows stale state-check blocks to be recovered by later live-state proof only', () => {
    expect(conductor._recoverableBlockedOperationCheck({
      status: 'blocked',
      matched: false,
      reason: 'visible_not_confirmed',
      kind: 'visible',
    })).toBe(true);

    expect(conductor._recoverableBlockedOperationCheck({
      status: 'blocked',
      matched: false,
      reason: 'url_not_reached',
      kind: 'url',
    })).toBe(true);

    expect(conductor._recoverableBlockedOperationCheck({
      status: 'blocked',
      matched: false,
      reason: 'value_mismatch',
      kind: 'value',
    })).toBe(false);

    expect(conductor._recoverableBlockedOperationCheck({
      status: 'blocked',
      matched: false,
      reason: 'result_no_match',
      kind: 'selected',
    })).toBe(false);
  });

  it('classifies validation-looking toasts as validation errors, not successful command effects', () => {
    const proof = proveEffect({
      toolName: 'browser_click',
      targetRole: 'button',
      before: {
        url: 'https://login.example.test/password',
        toast: '',
        dialogOpen: 0,
        rowCount: 0,
        checkedCount: 0,
        errorCount: 0,
      },
      after: {
        url: 'https://login.example.test/password',
        toast: 'Please enter your password.',
        dialogOpen: 0,
        rowCount: 0,
        checkedCount: 0,
        errorCount: 0,
      },
    });

    expect(proof.signals).toContain('validation_error_shown');
    expect(proof.signals).not.toContain('toast');
    expect(proof.kind).toBe('validation_error_shown');
  });

  it('detects optional prompt-dismiss steps and rejects non-dismiss actions as completion', () => {
    const step = {
      action: 'Dismiss if visible',
      element: 'Welcome tour dialog',
      expected: 'Welcome tour dialog dismissed if visible; flow continues to application',
    };

    expect(conductor._isOptionalDismissStep(step)).toBe(true);
    expect(conductor._optionalDismissToolAllowed('browser_type', { element: 'Search' })).toBe(false);
    expect(conductor._optionalDismissToolAllowed('browser_fill_form', {
      fields: [{ name: 'Search', value: 'quarterly report' }],
    })).toBe(false);
    expect(conductor._optionalDismissToolAllowed('browser_click', { element: 'Skip tour' })).toBe(true);
    expect(conductor._optionalDismissToolAllowed('browser_click', { element: 'Save changes' })).toBe(false);
  });

  it('treats absent optional prompt targets as absent on the destination page', () => {
    const step = {
      action: 'Dismiss if visible',
      element: 'Welcome tour dialog',
      expected: 'Welcome tour dialog dismissed if visible; flow continues to application',
    };

    expect(conductor._optionalDismissTargetPresent('heading "Projects" button "New project"', step)).toBe(false);
    expect(conductor._optionalDismissTargetPresent('dialog "Welcome tour" button "Skip tour"', step)).toBe(true);
  });

  it('allows backend closeout only for post-loop ratifiable assertion types', () => {
    expect(conductor._declaredAssertionsPostLoopRatifiable([])).toBe(false);
    expect(conductor._declaredAssertionsPostLoopRatifiable([{ id: 'a1', type: 'TEXT' }])).toBe(true);
    expect(conductor._declaredAssertionsPostLoopRatifiable([
      { id: 'a1', type: 'TEXT' },
      { id: 'a2', type: 'URL' },
    ])).toBe(true);
    expect(conductor._declaredAssertionsPostLoopRatifiable([{ id: 'a1', type: 'EVALUATE' }])).toBe(false);
  });

});
