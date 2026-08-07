import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const conductorPath = path.resolve('server/services/agents/conductor.js');
const conductorSource = fs.readFileSync(conductorPath, 'utf8');
const mcpSource = fs.readFileSync(path.resolve('server/services/mcp.js'), 'utf8');

describe('conductor contract boundaries', () => {
  it('fails closed when an independent scenario cannot start a fresh session', () => {
    expect(conductorSource).toContain('fresh_session_required');
    // A fresh-session start failure is LOCAL to this one independent scenario:
    // its cases are blocked (environmental, not a verdict) and the suite continues.
    // It must NOT inherit the previous session and must NOT abort the whole suite
    // (the old suite-wide abort skipped every remaining independent scenario).
    expect(conductorSource).toContain("blockedReason: 'session_start_failed'");
    expect(conductorSource).toContain('do NOT abort the suite');
    expect(conductorSource).not.toContain('Continuing with existing session.');
  });

  it('runs runtime environment pre-flight before opening a browser session', () => {
    const preflightIdx = conductorSource.indexOf('const runtimePreflight = await environmentPreflight.preflightTargetEnvironment');
    const mcpStartIdx = conductorSource.indexOf('mcp.startMcpSession({');

    expect(preflightIdx).toBeGreaterThan(-1);
    expect(mcpStartIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeLessThan(mcpStartIdx);
    expect(conductorSource).toContain('runtime_environment_preflight_failed');
    expect(conductorSource).toContain("blockedReason: 'environment_defect'");
    expect(conductorSource).toContain('Browser was not opened');
  });

  it('performs in-loop healing with hard budgets before reporting locator failures', () => {
    expect(conductorSource).toContain('runtimeHealingAllowedForTool(tu.name)');
    expect(conductorSource).toContain("status: healingAllowed ? 'started' : 'not_allowed_by_action_contract'");
    expect(conductorSource).toContain("phase: 'fresh_snapshot'");
    expect(conductorSource).toContain("phase: 'kb_ref_retry'");
    expect(conductorSource).toContain("phase: 'healer_llm'");
    expect(conductorSource).toContain("phase: 'healed_retry'");
    expect(conductorSource).toContain('buildHealingBudgetFailureResult');
    expect(conductorSource).toContain('RUNTIME_HEALING_BUDGET_EXHAUSTED');
    expect(conductorSource).toContain('browserActionRegistry.RUNTIME_STATUSES.FAILED_AFTER_HEALING_BUDGET');
    expect(conductorSource).toContain('browserActionRegistry.RUNTIME_STATUSES.PASS_HEALED');
    expect(conductorSource).toContain('originalError: errPreview');
    expect(conductorSource).toContain('freshSnapshotEvidence: snapshotEvidenceSummary(freshSnap)');
    expect(conductorSource).toContain('if (result.isError && !healingBudgetExhausted)');
  });

  it('resets continuation login cases without a precision feature flag', () => {
    expect(conductorSource).toContain('Per-case clean-session reset before continuation login case');
    // A case already classified as fresh must keep that decision; continuation
    // login cases upgrade the same flag after their clean-session reset.
    expect(conductorSource).toContain('let __forceFreshCaseConversation = forceFreshCaseStart');
    expect(conductorSource).toContain('&& !forceFreshCaseStart');
    expect(conductorSource).toContain('__forceFreshCaseConversation = true');
    expect(conductorSource).toContain('forceFreshConversation: !!(__forceFreshCaseConversation || (row && ei > 0))');
    const resetIdx = conductorSource.indexOf('Per-case clean-session reset before continuation login case');
    const precisionFlagAfterReset = conductorSource.indexOf("require('../conductorPrecisionBridge').enabled()", resetIdx);
    expect(resetIdx).toBeGreaterThan(-1);
    expect(precisionFlagAfterReset === -1 || precisionFlagAfterReset > resetIdx + 3000).toBe(true);
  });

  it('keeps hidden logout blocked unless logout is the approved current step', () => {
    expect(conductorSource).toContain('isLogoutLikeToolCall');
    expect(conductorSource).toContain('approvedStepAllowsLogout');
    expect(conductorSource).toContain('Blocked hidden logout');
    expect(conductorSource).toContain('Independent scenario isolation is handled by the runner with a fresh browser session');
  });

  it('prevents project memory from treating unverified login/navigation as success', () => {
    expect(conductorSource).toContain('memoryReplayRequiresLiveProof');
    expect(conductorSource).toContain('snapshotShowsLoginContradiction');
    expect(conductorSource).toContain('project_memory_destination_unverified');
    expect(conductorSource).toContain('memoryReplayTerminalBlock');
  });

  it('advances only to the next dependency-runnable step after a terminal outcome', () => {
    // A failed required action stops its descendants, but an independent later
    // step remains runnable. Functional assertion mismatches record a successful
    // action and can continue without being turned into a fake action pass.
    expect(conductorSource).toContain('executionJournal.selectNextRunnableStep(stepResults)');
    expect(conductorSource).toContain("reduced.advance = sealed.actionOutcome === 'succeeded'");
    expect(conductorSource).toContain('affectedDescendantStepIds');
    expect(conductorSource).toContain("outcome: 'not_matched'");
  });

  it('validates journey test-data pins and fails closed on validator errors', () => {
    expect(conductorSource).not.toContain('if (!isJourneyMember) {');
    expect(conductorSource).toContain("code: 'data_binding_validation_error'");
    expect(conductorSource).toContain('Test-data binding validation failed closed');
  });

  it('does not let helper clicks complete Fill or Type steps', () => {
    expect(conductorSource).toContain('wrong_tool_for_input_state');
    expect(conductorSource).toContain('CURRENT_STEP_FAILED');
    expect(conductorSource).toContain('not a recorded/synced completion');
    expect(conductorSource).toContain('Fill/Type step');
    expect(conductorSource).toContain('suppressStepCompletion');
  });

  it('blocks hard browser navigation as stale-ref recovery on non-navigation steps', () => {
    expect(conductorSource).toContain('Blocked recovery navigation');
    expect(conductorSource).toContain('browser_navigate cannot complete Step');
    expect(conductorSource).toContain('erase already-filled form state');
    expect(conductorSource).toContain('pipelineContract.isNavigateStep');
  });

  it('auto-commits passive verification steps before executing the next action', () => {
    expect(conductorSource).toContain('realignPastPassiveVerification');
    expect(conductorSource).toContain('Strict step realignment: auto-committed passive step');
    expect(conductorSource).toContain('realigned');
    expect(conductorSource).not.toContain('Do not assume the previously proposed ${tu.name} call ran; it was intentionally deferred.');
  });

  it('prevents future-step narration and batched passive verdicts', () => {
    expect(conductorSource).toContain('textMentionsFutureStep');
    expect(conductorSource).toContain('sanitizeAssistantContentForCurrentStep');
    expect(conductorSource).toContain('strict mode accepts only one current-step verdict per model turn');
    expect(conductorSource).toContain('Ignored natural-language verification');
    expect(conductorSource).toContain('future-step narration suppressed');
  });

  it('keeps active conductor context current-step framed and resets only fresh cases', () => {
    expect(conductorSource).toContain('one backend-selected current step at a time');
    expect(conductorSource).toContain('Do not infer, narrate, or execute future cases or future steps');
    expect(conductorSource).toContain('let messages = appendCaseMessageToScenarioContext(scenarioContext, perCaseUserMsg, { freshConversationMessage })');

    // Fresh/independent cases replace prior chat context with the current case;
    // an explicit same-scenario continuation appends to the retained context.
    expect(conductorSource).toContain('&& !freshConversationMessage');
    expect(conductorSource).toContain('scenarioContext.messages.push(nextTurn)');
    expect(conductorSource).toContain('const messages = [nextTurn]');
    expect(conductorSource).toContain('if (scenarioContext) scenarioContext.messages = messages');
  });

  it('does not block routine browser actions on per-action screenshots', () => {
    expect(conductorSource).toContain('pendingEvidenceCaptures');
    expect(conductorSource).toContain("source: 'step_boundary'");
    expect(conductorSource).toContain("blocking: true");
    expect(conductorSource).not.toContain('await captureFrame({\n          label: `${tc.id}-s${stepForFrame}-t${turn}`');
  });

  it('allows current live refs to dispatch without pretending they are export-grade locators', () => {
    expect(conductorSource).toContain('live_ref_dispatch_allowed');
    expect(conductorSource).toContain('exportGrade: false');
    expect(conductorSource).toContain('Durable locator proof will remain diagnostic-only until verified');
  });

  it('does not mark non-matching operation checks as passing steps', () => {
    expect(conductorSource).toContain("operationFailed = record && record.kind === 'operation_check' && record.matched === false");
    expect(conductorSource).toContain("operationFailed = operationRecord && operationRecord.matched === false");
  });

  it('uses bounded adaptive validation and blocks model-invented waits', () => {
    expect(conductorSource).toContain('validateSnapshotAdaptivePolicy');
    expect(conductorSource).toContain('adaptiveValidationContractForStep');
    expect(conductorSource).toContain('pollIntervalMs: Math.max(1');
    expect(conductorSource).toContain('stableObservations: Math.max(1');
    expect(conductorSource).toContain("reason: uncheckable ? 'qaai_validation_snapshot_unavailable'");
    expect(conductorSource).toContain("source: 'single_pass_validation_snapshot'");
    expect(mcpSource).toContain('adaptiveValidationSnapshot');
    expect(mcpSource).toContain('ADAPTIVE_VALIDATION_SNAPSHOT_SOURCES');
    expect(mcpSource).toContain('waitContract.STABLE_OBSERVATIONS');
    expect(conductorSource).toContain('skipDispatchForUnauthorizedWait');
    expect(conductorSource).toContain('Blocked implicit browser_wait_for');
    expect(conductorSource).not.toContain("browser_wait_for', { time: 1.0 }");
    expect(conductorSource).not.toContain("browser_wait_for', { time: 1.2 }");
    const ordinaryRecipes = conductorSource.slice(
      conductorSource.indexOf('If you need to SELECT ALL existing text'),
      conductorSource.indexOf('function pause(ms)'),
    );
    expect(ordinaryRecipes).not.toContain('browser_wait_for');
  });

  it('bounds validation-only DOM probes and treats probe failure as uncheckable', () => {
    for (const sourceName of ['input_value_readback', 'tooltip_visible_probe', 'field_blocked_probe']) {
      const sourceIdx = conductorSource.indexOf(`source: '${sourceName}'`);
      expect(sourceIdx).toBeGreaterThan(-1);
      const options = conductorSource.slice(sourceIdx, sourceIdx + 180);
      expect(options).toContain('timeoutMs: VALIDATION_SNAPSHOT_TIMEOUT_MS');
    }
    expect(conductorSource).toContain("'tooltip_probe_unavailable'");
    expect(conductorSource).toContain("reason: 'field_blocked_probe_unavailable'");
    expect(conductorSource).not.toContain("reason: 'field_blocked_probe_error'");
  });

  it('keeps fast mode free of semantic and post-loop validation latency', () => {
    expect(conductorSource).toContain('const effectiveVerifierMode = selectEffectiveVerifierMode(execMode, verifierMode)');
    expect(conductorSource).toContain('verifierMode: effectiveVerifierMode');
    expect(conductorSource).toContain("if (effectiveVerifierMode === 'semantic_fallback' && apiKey)");
    expect(conductorSource).toContain("const criticValidationMiss = execMode === 'thorough'");
    expect(conductorSource).toContain('profile, execMode, scenarioContext');
    expect(conductorSource).toMatch(/profile = EXEC_MODE_PROFILES\.fast,\r?\n\s+execMode = 'fast'/);
    expect(conductorSource).toContain('exhaustiveRatify: false');
  });

  it('keeps click execution free of password-specific pre-dispatch guards', () => {
    expect(conductorSource).not.toContain('authPasswordSubmitPlan');
    expect(conductorSource).not.toContain('prefillAuthPasswordBeforeSubmit');
    expect(conductorSource).not.toContain('refreshSnapshotForPotentialAuthPasswordSubmit');
  });

  it('bounds and deduplicates model validation snapshots per browser-state epoch', () => {
    expect(conductorSource).toContain('const currentBrowserStateEpoch = () => `${currentStepIndex}:${browserStateRevision}`');
    expect(conductorSource).toContain('reuseModelValidationSnapshot');
    expect(conductorSource).toContain("source: 'single_pass_model_validation_snapshot'");
    expect(conductorSource).toContain('skipSnapshotStability: true');
    expect(conductorSource).toContain('timeoutMs: VALIDATION_SNAPSHOT_TIMEOUT_MS');
    expect(conductorSource).toContain('browserStateRevision += 1');
  });

  it('does not fetch an unused final post-mortem snapshot', () => {
    const start = conductorSource.indexOf('// Final history reuses the most recent action/validation snapshot.');
    const end = conductorSource.indexOf('// P3-3: screenshotsByTc removed', start);
    const finalSnapshotBlock = conductorSource.slice(start, end);
    expect(finalSnapshotBlock).toContain('mcp.getLastSnapshot(mcpSession)');
    expect(finalSnapshotBlock).not.toContain("mcp.callTool(mcpSession, 'browser_snapshot'");
  });

  it('keeps select/dropdown steps pending until the value is reflected on the control', () => {
    expect(conductorSource).toContain('selected_not_reflected');
    expect(conductorSource).toContain('stay on this step until the CLOSED control reflects it');
  });

  it('emits snapshots and other helper probes as diagnostic traffic instead of failed step attempts', () => {
    expect(conductorSource).toContain('const helperTraffic = STEP_UTILITY_TOOLS.has(block.name) || pipelineContract.isStepUtilityTool(block.name)');
    expect(conductorSource).toContain("const actionStatus = helperTraffic ? 'diagnostic' : 'attempted'");
    expect(conductorSource).toContain("trailEntry.actionStatus = helperTraffic ? 'diagnostic' : (result.isError ? 'failed' : 'succeeded')");
    expect(conductorSource).toContain("status: helperTraffic ? (result.isError ? 'warning' : 'pass') : (result.isError ? 'fail' : 'pass')");
  });
});
