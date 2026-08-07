import { describe, expect, it, vi } from 'vitest';
import runtimeModule from '../../server/services/conductorUniversalRuntime';
import clickTargetResolverModule from '../../server/services/clickTargetResolver';
import evidenceRegistryModule from '../../server/services/browserEvidenceAdapterRegistry';

const { eventKindForStep, createConductorUniversalRuntime } = runtimeModule;
const { resolveClickableControl } = clickTargetResolverModule;
const { ADAPTER_IDS, BrowserEvidenceAdapterRegistry } = evidenceRegistryModule;

function isPreDispatchStateSource(source) {
  return ['control_exact_state_before', 'dropdown_transaction_precondition'].includes(String(source || ''));
}

function stateAfterPreDispatch(source, after, before = {}) {
  return isPreDispatchStateSource(source) ? before : after;
}

function baseHooks(overrides = {}) {
  return {
    snapshot: vi.fn(async ({ source }) => ({ fresh: true, source, snapshotText: '- textbox "Email" [ref=e1]', url: 'https://example.test/form' })),
    evaluate: vi.fn(async ({ source } = {}) => stateAfterPreDispatch(
      source,
      { actualValue: 'user@example.test', valueAfter: 'user@example.test' },
      { actualValue: '', valueAfter: '' },
    )),
    resolveRef: vi.fn(async () => 'e1'),
    dispatch: vi.fn(async () => ({ ok: true, result: { isError: false } })),
    dispatchEvent: vi.fn(async () => ({ ok: true, isError: false })),
    seal: vi.fn(async () => ({ sealed: { continuationOutcome: 'continue' }, hasRunnableStep: true })),
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
}

function resolveFromSnapshot({ step, snapshotText }) {
  const resolution = resolveClickableControl(snapshotText, {
    authoredLabel: step.target,
    role: step.targetRole || step.role || null,
    contextTokens: step.contextTokens || step.targetContextTokens || null,
  });
  return resolution.ok ? resolution.ref : null;
}

describe('Conductor universal runtime adapter', () => {
  it('negotiates deterministic Playwright-native evidence when CDP is unavailable', () => {
    const runtime = createConductorUniversalRuntime({ hooks: baseHooks() });

    expect(runtime.evidenceNegotiation).toMatchObject({
      status: 'ready',
      authoritativeAdapter: {
        id: ADAPTER_IDS.PLAYWRIGHT_CDP,
        proofMode: 'playwright_native',
        cdpUsed: false,
      },
      confidencePolicy: {
        advisoryCanCreateActionEvidence: false,
        advisoryCanRaiseConfidenceAlone: false,
      },
    });
  });

  it('keeps discovery assistants diagnostic-only at the runtime boundary', async () => {
    const observe = vi.fn(async () => ({ suggestedLocator: 'getByLabel("Email")' }));
    const evidenceRegistry = new BrowserEvidenceAdapterRegistry({
      defaults: { stagehand: { observe } },
    });
    const hooks = baseHooks();
    const runtime = createConductorUniversalRuntime({
      hooks,
      evidenceRegistry,
      evidenceRequest: { requestedAssists: [ADAPTER_IDS.STAGEHAND_OBSERVE] },
    });

    const result = await runtime.run({
      idx: 0,
      actionId: 'case:step:assist',
      step: { action: 'Fill', target: 'Email', value: 'user@example.test' },
    });

    expect(result.outcome.status).toBe('pass');
    expect(hooks.dispatch).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
    expect(result.evidenceRouting.advisoryHints).toEqual([
      expect.objectContaining({
        adapterId: ADAPTER_IDS.STAGEHAND_OBSERVE,
        authority: 'advisory',
        canCreateActionEvidence: false,
        canRaiseConfidenceAlone: false,
        requiresDeterministicCorroboration: true,
      }),
    ]);
    expect(result.outcome.diagnostics.evidenceRouting).toEqual(result.evidenceRouting);
  });

  it('recognizes only explicit typed events on Click steps', () => {
    expect(eventKindForStep({ action: 'Click', operationCheck: { kind: 'page_ready' } })).toBeNull();
    expect(eventKindForStep({ action: 'Click', operationCheck: { kind: 'navigation' } })).toBe('navigation');
    expect(eventKindForStep({
      action: 'Click',
      target: 'second Organization option, Secondary Organization',
      operationCheck: { kind: 'page_ready' },
    })).toBeNull();
    expect(eventKindForStep({
      action: 'Click',
      operationCheck: { kind: 'page_ready' },
      condition: { kind: 'authored_predicate', predicate: 'the optional prompt is visible', onFalse: 'skip' },
    })).toBeNull();
    expect(eventKindForStep({ action: 'Click', eventKind: 'popup' })).toBe('popup');
    expect(eventKindForStep({ action: 'Click' })).toBeNull();
  });

  it('executes Fill through fresh resolution, dispatch, exact proof, and seal', async () => {
    const hooks = baseHooks();
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:step:1',
      step: { action: 'Fill', target: 'Email', value: 'user@example.test' },
    });
    expect(result).toMatchObject({ handled: true, terminal: false, outcome: { status: 'pass' } });
    expect(hooks.resolveRef).toHaveBeenCalled();
    expect(hooks.dispatch).toHaveBeenCalledOnce();
    expect(hooks.evaluate.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(hooks.seal).toHaveBeenCalledOnce();
  });

  it('commits a delivered Fill from exact control readback when the postcondition snapshot is unavailable', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ source, phase }) => phase === 'postcondition'
        ? null
        : { fresh: true, source, snapshotText: '- textbox "Email" [ref=e1]', url: 'https://example.test/form' }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });

    const result = await runtime.run({
      idx: 0,
      actionId: 'case:step:fill-without-post-snapshot',
      step: { action: 'Fill', target: 'Email', value: 'user@example.test' },
    });

    expect(result).toMatchObject({ handled: true, terminal: false, outcome: { status: 'pass' } });
    expect(hooks.dispatch).toHaveBeenCalledOnce();
    expect(hooks.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      target: 'e1',
      source: 'control_exact_state_after',
    }));
    expect(hooks.snapshot.mock.calls.some(([request]) => request?.phase === 'postcondition')).toBe(false);
  });

  it('uses unique semantic DOM owner state when ref-based readback is unavailable', async () => {
    const hooks = baseHooks({
      evaluate: vi.fn(async ({ source } = {}) => {
        if (source === 'control_exact_state_after') return null;
        if (source === 'control_semantic_state_after') {
          return {
            candidates: [{
              role: 'textbox',
              accessibleName: 'Email Address',
              associatedLabels: ['Email Address'],
              visible: true,
              enabled: true,
              value: 'user@example.test',
            }],
          };
        }
        return stateAfterPreDispatch(
          source,
          { actualValue: 'user@example.test', valueAfter: 'user@example.test' },
          { actualValue: '', valueAfter: '' },
        );
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });

    const result = await runtime.run({
      idx: 0,
      actionId: 'case:step:semantic-owner-readback',
      step: { action: 'Fill', target: 'Email Address field', value: 'user@example.test' },
    });

    expect(result).toMatchObject({ handled: true, terminal: false, outcome: { status: 'pass' } });
    expect(hooks.dispatch).toHaveBeenCalledOnce();
    expect(hooks.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      source: 'control_semantic_state_after',
    }));
  });

  it('retains the authoritative dispatch ref when the authored label differs from the accessible name', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ source, phase }) => phase === 'postcondition'
        ? null
        : { fresh: true, source, snapshotText: '- textbox "Email Address" [ref=e1]', url: 'https://example.test/form' }),
      dispatch: vi.fn(async () => ({
        ok: true,
        result: { isError: false },
        qaaiActionLocator: {
          kind: 'multi',
          fields: [{
            name: 'Email Address field',
            ref: 'e1',
            actionLocator: { expression: 'getByRole("textbox", { name: "Email Address", exact: true })' },
          }],
        },
      })),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const suppliedPlan = {
      ...runtimeModule.controlActionAdapter?.buildControlActionPlan?.({}) || {},
      schema: 'qaai_control_action_v1',
      kind: 'fill',
      target: 'Email Address field',
      phases: [{
        id: 'set-value',
        toolName: 'browser_fill_form',
        resolutionToolName: 'browser_fill_form',
        args: { fields: [{ name: 'Email Address field', element: 'Email Address field', type: 'textbox', value: 'user@example.test' }] },
        resolution: { label: 'Email Address', roleHints: ['textbox'], freshObservationRequired: true, unique: { count: 1 }, failClosed: true },
        freshObservationRequired: true,
      }],
      postcondition: { kind: 'value_exact', expected: 'user@example.test', exact: true },
      retryPolicy: { maxRetries: 0, retryOn: [], freshObservationBeforeRetry: true },
      waitContract: { timeoutMs: 1000, pollIntervalMs: 10, stableObservations: 2 },
      metadata: {},
    };

    const result = await runtime.run({
      idx: 0,
      actionId: 'case:step:dispatch-ref-handoff',
      suppliedPlan,
      step: { action: 'Fill', target: 'Email Address field', value: 'user@example.test' },
    });

    expect(result).toMatchObject({ handled: true, terminal: false, outcome: { status: 'pass' } });
    expect(hooks.dispatch).toHaveBeenCalledOnce();
    expect(hooks.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      target: 'e1',
      source: 'control_exact_state_after',
    }));
  });

  it('commits an authoritatively absent optional control before resolution or dispatch', async () => {
    const hooks = baseHooks({
      resolveOptionalPresence: vi.fn(async () => ({
        present: false,
        authoritativeAbsence: true,
        source: 'fresh_semantic_snapshot_zero_candidates',
      })),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:optional-backup-email:1',
      step: { action: 'Fill', target: 'Backup Email', value: 'backup@example.test', optional: true },
    });

    expect(result).toMatchObject({
      handled: true,
      terminal: false,
      reason: 'optional_target_absent',
      outcome: {
        status: 'pass',
        runtimeToolName: 'internal_optional_absent',
        record: { optionalAbsent: true },
      },
    });
    expect(hooks.resolveOptionalPresence).toHaveBeenCalledOnce();
    expect(hooks.snapshot).not.toHaveBeenCalled();
    expect(hooks.resolveRef).not.toHaveBeenCalled();
    expect(hooks.dispatch).not.toHaveBeenCalled();
    expect(hooks.dispatchEvent).not.toHaveBeenCalled();
    expect(hooks.seal).toHaveBeenCalledOnce();
  });

  it('does not treat ambiguous optional presence as absence', async () => {
    const hooks = baseHooks({
      resolveOptionalPresence: vi.fn(async () => ({
        present: null,
        authoritativeAbsence: false,
        source: 'fresh_semantic_snapshot',
        reason: 'ambiguous_snapshot_element',
      })),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:optional-email-ambiguous:1',
      step: { action: 'Fill', target: 'Email', value: 'user@example.test', optional: true },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(result.outcome.reason).not.toBe('optional_target_absent');
    expect(hooks.dispatch).toHaveBeenCalledOnce();
  });

  it('checkpoints the exact action transaction on the conductor step journal', async () => {
    const persistActionTransaction = vi.fn(async () => ({ persisted: true }));
    const hooks = baseHooks({
      transactionContext: { runId: 'run-1', caseId: 'case-1' },
      readActionTransaction: vi.fn(async () => null),
      persistActionTransaction,
    });
    const runtime = createConductorUniversalRuntime({ hooks });

    const result = await runtime.run({
      idx: 4,
      actionId: 'case-1:fill-email:1',
      step: { id: 'fill-email', action: 'Fill', target: 'Email', value: 'user@example.test' },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(persistActionTransaction).toHaveBeenCalled();
    const finalCheckpoint = persistActionTransaction.mock.calls.at(-1)[0];
    expect(finalCheckpoint).toMatchObject({ idx: 4, actionId: 'case-1:fill-email:1' });
    expect(finalCheckpoint.transaction).toMatchObject({
      runId: 'run-1',
      caseId: 'case-1',
      stepId: 'fill-email',
      actionOccurrenceId: 'case-1:fill-email:1',
      status: 'committed',
      dispatchAttemptCount: 1,
    });
  });

  it('fills an editable combobox resolved by its accessible label', async () => {
    let stateRead = 0;
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ source }) => ({
        fresh: true,
        source,
        snapshotText: '- combobox "Owning Organization *" [ref=e1930]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async () => {
        stateRead += 1;
        return stateRead === 1
          ? { actualValue: '', valueAfter: '' }
          : { actualValue: 'SIGROUP', valueAfter: 'SIGROUP' };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });

    const result = await runtime.run({
      idx: 10,
      actionId: 'case:step:11',
      step: { action: 'Fill', target: 'Owning Organization field', value: 'SIGROUP' },
    });

    expect(result).toMatchObject({ handled: true, terminal: false, outcome: { status: 'pass' } });
    expect(hooks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      resolution: expect.objectContaining({ ref: 'e1930' }),
    }));
  });

  it('waits for a slow required control to appear before declaring resolution uncertainty', async () => {
    let snapshotReads = 0;
    let typed = false;
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ source }) => {
        snapshotReads += 1;
        return {
          fresh: true,
          source,
          snapshotText: snapshotReads < 3
            ? '- heading "Loading sign-in" [level=1]'
            : '- textbox "Enter your email, phone, or Skype." [active] [ref=identifier]',
          url: 'https://example.test/sign-in',
        };
      }),
      resolveRef: vi.fn(async () => null),
      dispatch: vi.fn(async () => {
        typed = true;
        return { ok: true, result: { isError: false } };
      }),
      evaluate: vi.fn(async ({ source }) => source === 'semantic_control_dom_evidence'
        ? { candidates: [] }
        : {
            actualValue: typed ? 'user@example.test' : '',
            valueAfter: typed ? 'user@example.test' : '',
          }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });

    const result = await runtime.run({
      idx: 9,
      actionId: 'case:step:10',
      step: {
        action: 'Fill',
        target: 'Microsoft email, phone, or Skype field',
        value: 'user@example.test',
      },
    });

    expect(result).toMatchObject({ handled: true, terminal: false, outcome: { status: 'pass' } });
    expect(snapshotReads).toBeGreaterThanOrEqual(3);
    expect(hooks.dispatch).toHaveBeenCalledOnce();
    expect(hooks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      resolution: expect.objectContaining({ ref: 'identifier' }),
    }));
  });

  it('executes a custom dropdown as open then exact option then visible-text proof', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ controlPhase }) => ({
        fresh: true,
        snapshotText: controlPhase?.id === 'choose-exact-option'
          ? [
              '- group "Country":',
              '  - combobox "Country" [expanded] [ref=e1]',
              '  - listbox "Country options" [ref=country-options]:',
              '    - option "Canada" [ref=e2]',
            ].join('\n')
          : '- combobox "Country" [ref=e1]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async ({ step }) => step.target === 'Canada' ? 'e2' : 'e1'),
      evaluate: vi.fn(async ({ source } = {}) => stateAfterPreDispatch(
        source,
        { selectedValue: 'CA', selectedText: 'Canada', selectedTexts: ['Canada'] },
        { selectedValue: '', selectedText: '', selectedTexts: [] },
      )),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0, actionId: 'case:select:1',
      step: { action: 'Select', target: 'Country', value: 'Canada', controlKind: 'custom' },
    });
    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(result.outcome.diagnostics.dropdownTransaction).toMatchObject({
      state: 'VALUE_COMMITTED',
      stateHistory: ['CLOSED', 'OPENING', 'OPEN', 'SELECTING', 'VALUE_COMMITTED'],
    });
    expect(hooks.dispatch).toHaveBeenCalledTimes(3);
    expect(hooks.dispatch.mock.calls.map(([call]) => call.phase.toolName))
      .toEqual(['browser_click', 'browser_press_key', 'browser_click']);
  });

  it('selects from an already-open dropdown without repeating opener gestures', async () => {
    let selected = false;
    const openSnapshot = [
      '- group "Equipment":',
      '  - combobox "Equipment" [expanded] [ref=e1]',
      '  - listbox "Equipment options" [ref=equipment-options]:',
      '    - option "RR" [ref=e2]',
      '    - option "LTL" [ref=e3]',
    ].join('\n');
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: selected ? '- combobox "Equipment" [ref=e1]: LTL' : openSnapshot,
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async ({ step }) => step.target === 'LTL' ? 'e3' : 'e1'),
      evaluate: vi.fn(async ({ source }) => {
        if (String(source || '').startsWith('dropdown_transaction')) {
          const owner = {
            ref: 'e1', role: 'combobox', label: 'Equipment',
            expanded: !selected, visible: true, enabled: true,
            selectedValue: selected ? 'LTL' : '',
            displayedValue: selected ? 'LTL' : '',
            attributes: {},
          };
          return {
            available: true,
            owner,
            trigger: owner,
            valueNode: owner,
            // Simulate a provider that cannot correlate the popup even though
            // the fresh accessibility snapshot proves the owner is expanded.
            popups: [],
            visibleOptions: [],
          };
        }
        return {
          selectedValue: selected ? 'LTL' : '',
          selectedText: selected ? 'LTL' : '',
          selectedTexts: selected ? ['LTL'] : [],
          value: selected ? 'LTL' : '',
        };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.id === 'choose-exact-option') selected = true;
        return { ok: true, result: { isError: false } };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });

    const result = await runtime.run({
      idx: 19,
      actionId: 'case:select:already-open',
      step: { action: 'Select', target: 'Equipment', value: 'LTL', controlKind: 'custom' },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(hooks.dispatch).toHaveBeenCalledOnce();
    expect(hooks.dispatch.mock.calls[0][0].phase).toMatchObject({
      id: 'choose-exact-option',
      toolName: 'browser_click',
    });
    expect(hooks.dispatch.mock.calls.some(([call]) => call.phase.toolName === 'browser_press_key')).toBe(false);
  });

  it('routes an adaptive non-select combobox through the custom click branch', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ controlPhase }) => ({
        fresh: true,
        snapshotText: controlPhase?.id === 'choose-exact-option'
          ? [
              '- group "Equipment":',
              '  - combobox "Equipment" [expanded] [ref=e1]',
              '  - listbox "Equipment options" [ref=equipment-options]:',
              '    - option "LTL" [ref=e2]',
            ].join('\n')
          : '- combobox "Equipment" [ref=e1]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async ({ step }) => step.target === 'LTL' ? 'e2' : 'e1'),
      evaluate: vi.fn(async ({ source, target }) => source === 'control_dispatch_branch_probe'
        ? { found: true, tagName: target === 'e2' ? 'div' : 'button', role: target === 'e2' ? 'option' : 'combobox' }
        : stateAfterPreDispatch(
            source,
            { selectedValue: 'LTL', selectedText: 'LTL', selectedTexts: ['LTL'] },
            { selectedValue: '', selectedText: '', selectedTexts: [] },
          )),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:adaptive-select:1',
      step: { action: 'Select', target: 'Equipment', value: 'LTL' },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(hooks.dispatch).toHaveBeenCalledTimes(3);
    expect(hooks.dispatch.mock.calls.map(([call]) => call.phase.toolName))
      .toEqual(['browser_click', 'browser_press_key', 'browser_click']);
    const optionResolution = hooks.resolveRef.mock.calls
      .map(([call]) => call)
      .find((call) => call.step.target === 'LTL');
    expect(optionResolution).toMatchObject({
      step: {
        targetRole: 'option',
        targetRoleHints: ['option', 'menuitemradio', 'menuitemcheckbox', 'treeitem'],
        contextTokens: ['Equipment'],
        targetScope: { ownerTarget: 'Equipment', openedByPhase: 'open-choice-control' },
        semanticTarget: { kind: 'option', name: 'LTL', match: 'exact' },
        ownerInteractionConfirmed: true,
      },
      phase: { id: 'choose-exact-option' },
    });
  });

  it('falls back to exact owner typeahead when an opened combobox exposes no option refs', async () => {
    let typed = false;
    let selected = false;
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ controlPhase, phase }) => ({
        fresh: true,
        snapshotText: controlPhase?.id === 'open-choice-control'
          ? '- combobox "Equipment" [ref=e1]'
          : typed
            ? [
                '- group "Equipment":',
                '  - combobox "Equipment" [expanded] [ref=e1]',
                '  - listbox "Option List" [ref=list]:',
                '    - option "LTL" [ref=e2]',
              ].join('\n')
            : '- combobox "Equipment" [expanded] [ref=e1]',
        url: 'https://example.test/form',
        phase,
      })),
      resolveRef: vi.fn(async ({ step }) => step.target === 'Equipment' ? 'e1' : null),
      evaluate: vi.fn(async ({ source }) => {
        if (source === 'control_dispatch_branch_probe') {
          return { found: true, tagName: 'input', role: 'combobox' };
        }
        if (source === 'owner_typeahead_editability_probe') {
          return { found: true, tagName: 'input', role: 'combobox', readOnly: false, disabled: false };
        }
        return selected
          ? { selectedValue: 'LTL', selectedText: 'LTL', selectedTexts: ['LTL'] }
          : { selectedValue: '', selectedText: '', selectedTexts: [] };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.toolName === 'browser_type') typed = true;
        if (phase.toolName === 'browser_click' && phase.args.target === 'e2') selected = true;
        return { ok: true, result: { isError: false } };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:typeahead-select:1',
      step: { action: 'Select', target: 'Equipment', value: 'LTL' },
    });

    expect(hooks.dispatch.mock.calls.map(([call]) => call.phase.toolName).slice(0, 3))
      .toEqual(['browser_press_key', 'browser_type', 'browser_click']);
    expect(hooks.dispatch.mock.calls[0][0].phase.args).toMatchObject({ key: 'Control+A', resolvedTarget: 'e1' });
    expect(hooks.dispatch.mock.calls[1][0].phase.args).toMatchObject({ text: 'LTL', slowly: true, target: 'e1', ref: 'e1' });
    expect(hooks.dispatch.mock.calls[2][0].phase.args).toMatchObject({ target: 'e2', ref: 'e2' });
    expect(selected).toBe(true);
    expect(result.outcome).toMatchObject({ status: 'pass' });
  });

  it('does not confirm free text when typeahead never exposes the exact option', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: '- combobox "Equipment" [expanded] [ref=e1]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async ({ step }) => step.target === 'Equipment' ? 'e1' : null),
      evaluate: vi.fn(async ({ source }) => {
        if (source === 'control_dispatch_branch_probe') {
          return { found: true, tagName: 'input', role: 'combobox' };
        }
        if (source === 'owner_typeahead_editability_probe') {
          return { found: true, tagName: 'input', role: 'combobox', readOnly: false, disabled: false };
        }
        return { selectedValue: '', selectedText: '', selectedTexts: [] };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:typeahead-no-option:1',
      step: { action: 'Select', target: 'Equipment', value: 'LTL' },
    });
    const keys = hooks.dispatch.mock.calls
      .map(([call]) => call.phase.args.key)
      .filter(Boolean);

    expect(result.outcome.status).not.toBe('pass');
    expect(keys).not.toContain('Enter');
    expect(keys).toEqual(expect.arrayContaining(['Control+A', 'Backspace']));
  });

  it('preserves an existing typeahead query while waiting for its exact authored option', async () => {
    let selected = false;
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ source }) => ({
        fresh: true,
        snapshotText: source === 'owner_typeahead_existing_query'
          ? [
              '- group "Owning Organization":',
              '  - combobox "Owning Organization" [expanded] [ref=e1]: SEARCH',
              '  - listbox "Option List" [ref=list]:',
              '    - option "*SEARCH-EUR SOURCE SYSTEM 01" [ref=e2]',
            ].join('\n')
          : '- combobox "Owning Organization" [expanded] [ref=e1]: SEARCH',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async ({ step }) => step.target === 'Owning Organization' ? 'e1' : null),
      evaluate: vi.fn(async ({ source }) => {
        if (source === 'control_dispatch_branch_probe') {
          return { found: true, tagName: 'input', role: 'combobox' };
        }
        if (source === 'owner_typeahead_editability_probe') {
          return { found: true, tagName: 'input', role: 'combobox', readOnly: false, disabled: false };
        }
        return selected
          ? { selectedValue: '*SEARCH-EUR SOURCE SYSTEM 01', selectedText: '*SEARCH-EUR SOURCE SYSTEM 01', selectedTexts: ['*SEARCH-EUR SOURCE SYSTEM 01'] }
          : { selectedValue: 'SEARCH', selectedText: 'SEARCH', selectedTexts: ['SEARCH'] };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.toolName === 'browser_click' && phase.args.target === 'e2') selected = true;
        return { ok: true, result: { isError: false } };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:typeahead-preserve:1',
      step: { action: 'Select', target: 'Owning Organization', value: '*SEARCH-EUR SOURCE SYSTEM 01' },
    });

    expect(hooks.dispatch.mock.calls.map(([call]) => call.phase.toolName))
      .toEqual(['browser_click']);
    expect(hooks.dispatch.mock.calls[0][0].phase.args).toMatchObject({ target: 'e2', ref: 'e2' });
    expect(result.outcome).toMatchObject({ status: 'pass' });
  });

  it('reacquires the owner control after selecting from an already-open popup', async () => {
    let selected = false;
    const before = [
      '- generic [ref=direction-field]:',
      '  - generic [ref=direction-label]: Ship Direction *',
      '  - combobox "Ship Direction *" [expanded] [ref=direction-control]: Outbound',
      '- listbox "Option List" [ref=direction-options]:',
      '  - option "Outbound" [ref=outbound-option]',
      '  - option "Inbound" [ref=inbound-option]',
    ].join('\n');
    const after = [
      '- generic [ref=direction-field]:',
      '  - generic [ref=direction-label]: Ship Direction *',
      '  - combobox "Ship Direction *" [ref=direction-control]: Inbound',
    ].join('\n');
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: selected ? after : before,
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source }) => {
        if (source === 'semantic_control_dom_evidence'
          || source === 'semantic_control_postcondition_dom_evidence') {
          return { candidates: [], roleCounts: {} };
        }
        return selected
          ? { selectedValue: 'Inbound', selectedText: 'Inbound', selectedTexts: ['Inbound'] }
          : { selectedValue: 'Outbound', selectedText: 'Outbound', selectedTexts: ['Outbound'] };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.args.target === 'inbound-option') selected = true;
        return { ok: true, isError: false, toolName: phase.toolName };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:preopened-selection:1',
      step: {
        action: 'Select',
        target: 'Ship Direction dropdown',
        value: 'Inbound',
        controlKind: 'custom',
      },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(hooks.dispatch.mock.calls.map(([call]) => call.phase.args.target))
      .toEqual(['inbound-option']);
    expect(hooks.evaluate.mock.calls.some(([call]) => call.target === 'direction-control')).toBe(true);
  });

  it('waits for the exact selected value instead of retrying a successful option click', async () => {
    let selected = false;
    let postconditionReads = 0;
    const before = [
      '- combobox "Ship Direction *" [expanded] [ref=direction-control]: Outbound',
      '- listbox "Option List" [ref=direction-options]:',
      '  - option "Outbound" [ref=outbound-option]',
      '  - option "Inbound" [ref=inbound-option]',
    ].join('\n');
    const after = '- combobox "Ship Direction *" [ref=direction-control]: Inbound';
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: selected ? after : before,
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source }) => {
        if (source === 'semantic_control_dom_evidence'
          || source === 'semantic_control_postcondition_dom_evidence') {
          return { candidates: [], roleCounts: {} };
        }
        if (source === 'control_exact_state_after') {
          postconditionReads += 1;
          return postconditionReads < 3
            ? { selectedValue: 'Outbound', selectedText: 'Outbound', selectedTexts: ['Outbound'] }
            : { selectedValue: 'Inbound', selectedText: 'Inbound', selectedTexts: ['Inbound'] };
        }
        return { selectedValue: 'Outbound', selectedText: 'Outbound', selectedTexts: ['Outbound'] };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.args.target === 'inbound-option') selected = true;
        return { ok: true, isError: false, toolName: phase.toolName };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:delayed-selection:1',
      step: {
        action: 'Select',
        target: 'Ship Direction dropdown',
        value: 'Inbound',
        controlKind: 'custom',
        waitContract: { timeoutMs: 1_000, pollIntervalMs: 100, stableObservations: 2 },
      },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(postconditionReads).toBe(3);
    expect(hooks.dispatch.mock.calls.filter(([call]) => call.phase.args.target === 'inbound-option')).toHaveLength(1);
  });

  it('honors the fresh utility ref when a scroll label has multiple semantic matches', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: [
          '- region "References" [ref=e1]',
          '- region "References" [ref=e2]',
        ].join('\n'),
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => 'e2'),
      evaluate: vi.fn(async ({ source } = {}) => stateAfterPreDispatch(
        source,
        { visible: true, intersectionRatio: 1 },
        { visible: false, intersectionRatio: 0 },
      )),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:scroll:1',
      step: { action: 'Scroll', target: 'References', scrollMode: 'target' },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(hooks.dispatch).toHaveBeenCalledOnce();
    expect(hooks.dispatch.mock.calls[0][0].phase.args).toMatchObject({ target: 'e2', ref: 'e2' });
  });

  it('uses DOM label evidence to resolve an unnamed custom control, then selects from its owner scope', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ controlPhase }) => ({
        fresh: true,
        snapshotText: controlPhase?.semanticTarget?.kind === 'option'
          ? [
              '- group "Transport Mode":',
              '  - combobox "Transport Mode" [expanded] [ref=mode-control]',
              '  - listbox "Transport Mode options" [ref=mode-options]:',
              '    - option "Rail" [ref=rail-option]',
            ].join('\n')
          : '- combobox [ref=mode-control] [id="transport-mode"]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source }) => source === 'semantic_control_dom_evidence'
        ? {
            roleCounts: { combobox: 1 },
            candidates: [{
              role: 'combobox', roleOrdinal: 0, id: 'transport-mode',
              associatedLabels: ['Transport Mode'], visible: true, enabled: true,
            }],
          }
        : stateAfterPreDispatch(
            source,
            { selectedValue: 'Rail', selectedText: 'Rail', selectedTexts: ['Rail'] },
            { selectedValue: '', selectedText: '', selectedTexts: [] },
          )),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:dom-labelled-select:1',
      step: { action: 'Select', target: 'Transport Mode', value: 'Rail', controlKind: 'custom' },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(hooks.dispatch).toHaveBeenCalledTimes(3);
    expect(hooks.dispatch.mock.calls.map(([call]) => call.phase.args.target || call.phase.args.resolvedTarget))
      .toEqual(['mode-control', 'mode-control', 'rail-option']);
  });

  it('handles an explicit dropdown Click as one opener phase', async () => {
    const before = [
      '- group "Freight":',
      '  - text "Equipment"',
      '  - combobox [ref=equipment-control]',
    ].join('\n');
    const after = [
      '- group "Freight":',
      '  - text "Equipment"',
      '  - combobox [expanded] [ref=equipment-control]',
      '  - listbox "Equipment options" [ref=equipment-options]',
    ].join('\n');
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ phase, controlPhase }) => ({
        fresh: true,
        snapshotText: phase === 'postcondition'
          || controlPhase?.id === 'open-choice-control-trigger-assist'
          || controlPhase?.id === 'open-choice-control-keyboard-assist'
          ? after
          : before,
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source }) => source === 'semantic_control_dom_evidence'
        ? { candidates: [], roleCounts: {} }
        : stateAfterPreDispatch(source, { ariaExpanded: 'true' }, { ariaExpanded: 'false' })),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:dropdown-opener:1',
      step: { action: 'Click', target: 'Equipment dropdown' },
    });

    expect(result).toMatchObject({ handled: true, outcome: { status: 'pass' } });
    expect(hooks.dispatch).toHaveBeenCalledOnce();
    expect(hooks.dispatch.mock.calls[0][0]).toMatchObject({
      phase: { id: 'open-choice-control', toolName: 'browser_click', args: { target: 'equipment-control' } },
    });
  });

  it('clicks an associated trigger when the labelled dropdown body only receives focus', async () => {
    const before = [
      '- generic [ref=field]:',
      '  - generic [ref=label]: Equipment *',
      '  - generic [ref=control]:',
      '    - combobox "Equipment *" [active] [ref=equipment-control]',
      '    - button [ref=equipment-trigger]',
    ].join('\n');
    const after = [
      '- generic [ref=field]:',
      '  - generic [ref=label]: Equipment *',
      '  - generic [ref=control]:',
      '    - combobox "Equipment *" [expanded] [ref=equipment-control]',
      '    - button [ref=equipment-trigger]',
      '  - listbox "Equipment options" [ref=equipment-options]:',
      '    - option "LTL" [ref=ltl-option]',
    ].join('\n');
    let triggerClicked = false;
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ phase }) => ({
        fresh: true,
        snapshotText: phase === 'postcondition' || triggerClicked ? after : before,
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.args?.target === 'equipment-trigger') triggerClicked = true;
        return { ok: true, isError: false, toolName: phase.toolName };
      }),
      evaluate: vi.fn(async ({ source }) => source === 'semantic_control_dom_evidence'
        ? { candidates: [], roleCounts: {} }
        : { ariaExpanded: triggerClicked ? 'true' : 'false' }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:dropdown-trigger-fallback:1',
      step: { action: 'Click', target: 'Equipment dropdown' },
    });

    expect(result).toMatchObject({ handled: true, outcome: { status: 'pass' } });
    expect(hooks.dispatch.mock.calls.map(([call]) => [call.phase.id, call.phase.args.target]))
      .toEqual([
        ['open-choice-control', 'equipment-trigger'],
      ]);
  });

  it('prefers the semantically scoped repeated control over an unrelated hook ref', async () => {
    const snapshotText = [
      '- button "Dismiss status" [ref=e2132]',
      '- generic [ref=early-pickup]:',
      '  - generic [ref=early-pickup-title]: Early Pickup Date and Time',
      '  - generic [ref=early-pickup-time-field]:',
      '    - generic [ref=early-pickup-time-label]: Time',
      '    - combobox [ref=e2169]: Select Time',
      '- generic [ref=late-delivery]:',
      '  - generic [ref=late-delivery-title]: Late Delivery Date and Time',
      '  - generic [ref=late-delivery-time-field]:',
      '    - generic [ref=late-delivery-time-label]: Time',
      '    - combobox [ref=e2260]: Select Time',
    ].join('\n');
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({ fresh: true, snapshotText, url: 'https://example.test/form' })),
      resolveRef: vi.fn(async () => 'e2132'),
      evaluate: vi.fn(async ({ source }) => source === 'control_dispatch_branch_probe'
        ? { found: true, role: 'combobox', tagName: 'input', disabled: false, readOnly: false }
        : stateAfterPreDispatch(source, { ariaExpanded: 'true' }, { ariaExpanded: 'false' })),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:repeated-time:1',
      step: { action: 'Click', target: 'Early Pickup Time dropdown' },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(hooks.dispatch).toHaveBeenCalled();
    expect(hooks.dispatch.mock.calls.map(([call]) => call.phase.args.target || call.phase.args.resolvedTarget))
      .toEqual(expect.arrayContaining(['e2169']));
    expect(hooks.dispatch.mock.calls.map(([call]) => call.phase.args.target || call.phase.args.resolvedTarget))
      .not.toContain('e2132');
  });

  it('does not dispatch a non-utility control through an unrelated hook ref', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: '- button "Dismiss status" [ref=e2132]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => 'e2132'),
      evaluate: vi.fn(async ({ source }) => source === 'semantic_control_dom_evidence'
        ? { candidates: [], roleCounts: { button: 1 } }
        : { found: true, role: 'button', tagName: 'button' }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:missing-time:1',
      step: { action: 'Click', target: 'Early Pickup Time dropdown' },
    });

    expect(result.outcome.status).not.toBe('pass');
    expect(hooks.dispatch).not.toHaveBeenCalled();
  });

  it('resolves structurally labelled disclosure and radio controls without accessible names', async () => {
    const disclosureHooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: '- text "Pickup and Delivery"\n- button [ref=disclosure-ref]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source }) => source === 'semantic_control_dom_evidence'
        ? {
            candidates: [{
              role: 'button',
              roleOrdinal: 0,
              associatedLabels: ['Pickup and Delivery'],
              ariaExpanded: 'false',
              visible: true,
              enabled: true,
              hitTarget: true,
              inViewport: true,
            }],
            roleCounts: { button: 1 },
          }
        : stateAfterPreDispatch(source, { ariaExpanded: 'true' }, { ariaExpanded: 'false' })),
    });
    const disclosureRuntime = createConductorUniversalRuntime({ hooks: disclosureHooks });
    const disclosure = await disclosureRuntime.run({
      idx: 0,
      actionId: 'case:disclosure:1',
      step: { action: 'Expand', target: 'Pickup and Delivery' },
    });

    const radioHooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: '- text "Ship Date & Time"\n- radio [ref=radio-ref]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source } = {}) => stateAfterPreDispatch(
        source,
        { checked: true },
        { checked: false },
      )),
    });
    const radioRuntime = createConductorUniversalRuntime({ hooks: radioHooks });
    const radio = await radioRuntime.run({
      idx: 1,
      actionId: 'case:radio:2',
      step: { action: 'Radio', target: 'Ship Date & Time' },
    });

    expect(disclosure.outcome).toMatchObject({ status: 'pass' });
    expect(disclosureHooks.dispatch.mock.calls[0][0].phase.args.target).toBe('disclosure-ref');
    expect(radio.outcome).toMatchObject({ status: 'pass' });
    expect(radioHooks.dispatch.mock.calls[0][0].phase.args.target).toBe('radio-ref');
  });

  it('does not dispatch an already-checked radio whose label is the following sibling', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: [
          '- generic:',
          '  - radio [checked] [ref=ship-date-radio]',
          '  - generic [ref=ship-date-label]: Ship Date & Time',
        ].join('\n'),
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async () => ({ checked: true })),
    });
    const runtime = createConductorUniversalRuntime({ hooks });

    const result = await runtime.run({
      idx: 0,
      actionId: 'case:radio:already-checked',
      step: { action: 'Radio', target: 'Ship Date & Time' },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(hooks.dispatch).not.toHaveBeenCalled();
  });

  it('commits an already-selected owner before opening, transaction persistence, or dispatch', async () => {
    const persistActionTransaction = vi.fn(async () => ({ persisted: true }));
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: '- combobox "Ship Direction" [ref=direction-owner]: Inbound',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(resolveFromSnapshot),
      evaluate: vi.fn(async () => ({
        selectedValue: 'Inbound',
        selectedText: 'Inbound',
        selectedTexts: ['Inbound'],
        value: 'Inbound',
        visible: true,
        disabled: false,
      })),
      persistActionTransaction,
    });
    const runtime = createConductorUniversalRuntime({ hooks });

    const result = await runtime.run({
      idx: 0,
      actionId: 'case:ship-direction:already-selected',
      step: { action: 'Select', target: 'Ship Direction', value: 'Inbound', controlKind: 'custom' },
    });

    expect(result.outcome).toMatchObject({
      status: 'pass',
      reason: 'control_postcondition_already_satisfied',
      actionOutcome: 'succeeded',
    });
    expect(hooks.dispatch).not.toHaveBeenCalled();
    expect(persistActionTransaction).not.toHaveBeenCalled();
    expect(hooks.seal).toHaveBeenCalledOnce();
  });

  it('selects Inbound from Ship Direction using the opened owner scope', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ controlPhase }) => ({
        fresh: true,
        snapshotText: controlPhase?.semanticTarget?.kind === 'option'
          ? [
              '- group "Shipping":',
              '  - combobox "Ship Direction" [expanded] [ref=d1]',
              '  - listbox "Ship Direction options" [ref=direction-options]:',
              '    - option "Outbound" [ref=d2]',
              '    - option "Inbound" [ref=d3]',
            ].join('\n')
          : '- combobox "Ship Direction" [ref=d1]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(resolveFromSnapshot),
      evaluate: vi.fn(async ({ source } = {}) => stateAfterPreDispatch(
        source,
        { selectedValue: 'Inbound', selectedText: 'Inbound', selectedTexts: ['Inbound'] },
        { selectedValue: '', selectedText: '', selectedTexts: [] },
      )),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:ship-direction:1',
      step: { action: 'Select', target: 'Ship Direction', value: 'Inbound', controlKind: 'custom' },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(hooks.dispatch).toHaveBeenCalledTimes(3);
    expect(hooks.dispatch.mock.calls[2][0].phase.args.target).toBe('d3');
    const optionResolution = hooks.resolveRef.mock.calls
      .map(([call]) => call)
      .find((call) => call.step.target === 'Inbound');
    expect(optionResolution.step).toMatchObject({
      targetRole: 'option',
      contextTokens: ['Ship Direction'],
      semanticTarget: { kind: 'option', name: 'Inbound', match: 'exact' },
    });
  });

  it('rejects a duplicate option outside the owning dropdown scope', async () => {
    const beforeOpen = [
      '- group "Shipping Method":',
      '  - listbox "Shipping Method options" [ref=other-options]:',
      '    - option "LTL" [ref=outside-ltl]',
      '- combobox "Equipment" [ref=e1]',
    ].join('\n');
    const afterOpen = [
      '- group "Shipping Method":',
      '  - listbox "Shipping Method options" [ref=other-options]:',
      '    - option "LTL" [ref=outside-ltl]',
      '- group "Equipment":',
      '  - combobox "Equipment" [expanded] [ref=e1]',
      '  - listbox "Equipment options" [ref=equipment-options]:',
      '    - option "LTL" [ref=inside-ltl]',
    ].join('\n');
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ controlPhase }) => ({
        fresh: true,
        snapshotText: controlPhase?.semanticTarget?.kind === 'option' ? afterOpen : beforeOpen,
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(resolveFromSnapshot),
      evaluate: vi.fn(async ({ source } = {}) => stateAfterPreDispatch(
        source,
        { selectedValue: 'LTL', selectedText: 'LTL' },
        { selectedValue: '', selectedText: '' },
      )),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:scoped-equipment:1',
      step: { action: 'Select', target: 'Equipment', value: 'LTL', controlKind: 'custom' },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(hooks.dispatch).toHaveBeenCalledTimes(3);
    expect(hooks.dispatch.mock.calls[2][0].phase.args.target).toBe('inside-ltl');
    expect(hooks.dispatch.mock.calls[2][0].phase.args.target).not.toBe('outside-ltl');
  });

  it('blocks when duplicate options remain ambiguous inside the owner scope', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ controlPhase }) => ({
        fresh: true,
        snapshotText: controlPhase?.semanticTarget?.kind === 'option'
          ? [
              '- group "Equipment":',
              '  - combobox "Equipment" [expanded] [ref=e1]',
              '  - listbox "Equipment options" [ref=equipment-options]:',
              '    - option "LTL" [ref=ltl-a]',
              '    - option "LTL" [ref=ltl-b]',
            ].join('\n')
          : '- combobox "Equipment" [ref=e1]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(resolveFromSnapshot),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:ambiguous-equipment:1',
      step: { action: 'Select', target: 'Equipment', value: 'LTL', controlKind: 'custom' },
    });

    expect(result.outcome).toMatchObject({
      status: 'blocked',
      reason: 'control_target_ambiguous',
    });
    expect(hooks.dispatch).toHaveBeenCalledTimes(2);
  });

  it('executes numeric and structured table assertions through typed comparison', async () => {
    const numericHooks = baseHooks({
      readAssertion: vi.fn(async () => ({ fresh: true, actual: '1,250.00' })),
    });
    const numericRuntime = createConductorUniversalRuntime({ hooks: numericHooks });
    const numeric = await numericRuntime.run({
      idx: 0, actionId: 'case:number:1',
      step: { action: 'Verify', assertion: { type: 'NUMBER', payload: { expectedNumber: 1250 } } },
    });
    expect(numeric.outcome).toMatchObject({ status: 'pass', assertionOutcome: 'matched', actionOutcome: 'succeeded' });

    const tableHooks = baseHooks({
      readAssertion: vi.fn(async () => ({
        fresh: true,
        actual: { headers: ['Name', 'Status'], rows: [['Alice', 'Active'], ['Bob', 'Suspended']] },
      })),
    });
    const tableRuntime = createConductorUniversalRuntime({ hooks: tableHooks });
    const table = await tableRuntime.run({
      idx: 1, actionId: 'case:table:2',
      step: { action: 'Verify', assertion: { type: 'TABLE_CELL', payload: { where: { Name: 'Bob' }, column: 'Status', expectedValue: 'Suspended' } } },
    });
    expect(table.outcome).toMatchObject({ status: 'pass', assertionOutcome: 'matched' });
  });

  it('polls a slow exact assertion until its target becomes readable', async () => {
    let now = 0;
    const readAssertion = vi.fn()
      .mockResolvedValueOnce({ fresh: true, uncheckable: true, reason: 'typed_assertion_target_not_observed' })
      .mockResolvedValueOnce({
        fresh: true,
        actual: 'Ready',
        evidenceChannels: [{
          kind: 'dom_visible_text', text: 'Ready', visible: true,
          searched: true, targetMatched: true, source: 'exact_target_readback',
        }],
      });
    const hooks = baseHooks({
      now: () => now,
      sleep: vi.fn(async (ms) => { now += ms; }),
      readAssertion,
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 0,
      actionId: 'case:slow-assertion:1',
      step: { action: 'AssertText', target: 'Status field', verify: { kind: 'text', text: 'Ready' } },
    });

    expect(result.outcome).toMatchObject({ status: 'pass', assertionOutcome: 'matched' });
    expect(readAssertion).toHaveBeenCalledTimes(2);
  });

  it('resolves temporal relationship operands independently by exact authored refs', async () => {
    const hooks = baseHooks({
      readAssertion: vi.fn(async ({ assertion }) => {
        const target = assertion.payload.target.name;
        return { fresh: true, actual: target === 'Pickup appointment'
          ? '2026-08-20T09:00:00Z' : '2026-08-20T11:00:00Z' };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 2,
      actionId: 'case:relationship:3',
      step: {
        action: 'Verify',
        assertion: {
          type: 'AssertTemporal',
          comparator: 'before',
          payload: {
            comparator: 'before',
            operands: [
              { role: 'actual', kind: 'field_ref', ref: 'Pickup appointment' },
              { role: 'comparison', kind: 'field_ref', ref: 'Delivery appointment' },
            ],
          },
        },
      },
    });
    expect(result.outcome).toMatchObject({ status: 'pass', assertionOutcome: 'matched', reason: 'typed_relationship_matched' });
    expect(hooks.readAssertion).toHaveBeenCalledTimes(2);
    expect(hooks.readAssertion.mock.calls.map(([call]) => call.assertion.payload.target.name))
      .toEqual(['Pickup appointment', 'Delivery appointment']);
  });

  it('combines separately captured date and time controls for authored Date/Time relationships', async () => {
    const values = {
      'Pickup Date': '2026-08-20',
      'Pickup Time': '09:00 AM',
      'Delivery Date': '2026-08-20',
      'Delivery Time': '11:00 AM',
    };
    const hooks = baseHooks({
      readAssertion: vi.fn(async ({ assertion }) => ({
        fresh: true,
        actual: values[assertion.payload.target.name],
      })),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 3,
      actionId: 'case:compound-relationship:4',
      step: {
        action: 'AssertText',
        target: 'Pickup Date/Time',
        expected: 'Pickup Date/Time is before Delivery Date/Time.',
        verify: { kind: 'text', text: 'Verify that Pickup Date/Time is before Delivery Date/Time.' },
      },
    });

    expect(result.outcome).toMatchObject({ status: 'pass', assertionOutcome: 'matched', reason: 'typed_relationship_matched' });
    expect(hooks.readAssertion.mock.calls.map(([call]) => call.assertion.payload.target.name))
      .toEqual(['Pickup Date', 'Pickup Time', 'Delivery Date', 'Delivery Time']);
  });

  it('opens a semantic calendar once and selects the exact authored date once', async () => {
    let opened = false;
    let selected = false;
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: opened
          ? [
              '- textbox "Early Pickup Date" [ref=date-owner]',
              '- dialog "Early Pickup Date calendar" [ref=calendar-dialog]:',
              '  - gridcell "August 20, 2026" [ref=day-20]',
            ].join('\n')
          : '- textbox "Early Pickup Date" [ref=date-owner]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source }) => {
        if (source === 'control_exact_state_after' && selected) {
          return { found: false };
        }
        if (source === 'control_semantic_state_after' && selected) {
          return {
            candidates: [{
              role: 'textbox', accessibleName: 'Early Pickup Date',
              associatedLabels: ['Early Pickup Date and Time', 'Date'],
              visible: true, enabled: true, value: '08/20/2026',
            }],
          };
        }
        if (source === 'semantic_calendar_candidate_probe') {
          return opened ? {
            candidates: [{
              role: 'gridcell', name: 'August 20, 2026',
              dateParts: { year: 2026, month: 8, day: 20 },
              currentMonth: true, disabled: false,
            }],
            calendarState: { year: 2026, month: 8 },
          } : { candidates: [], calendarState: null };
        }
        if (source === 'control_dispatch_branch_probe') {
          return { found: true, role: 'textbox', tagName: 'input', inputType: 'text' };
        }
        if (source === 'semantic_control_dom_evidence'
          || source === 'semantic_control_postcondition_dom_evidence') {
          return { candidates: [], roleCounts: { textbox: 1 } };
        }
        if (source === 'control_exact_state_after' && selected) return { found: false };
        if (source === 'control_semantic_state_after' && selected) {
          return {
            candidates: [
              { role: 'textbox', accessibleName: 'Early Pickup Date', visible: true, enabled: true, value: '' },
              { role: 'textbox', accessibleName: 'Early Pickup Date', visible: true, enabled: true, value: '08/20/2026' },
            ],
          };
        }
        return {
          actualValue: selected ? '2026-08-20' : '',
          inputValue: selected ? '2026-08-20' : '',
          valueAfter: selected ? '2026-08-20' : '',
        };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.id === 'open-calendar') opened = true;
        if (phase.id === 'choose-calendar-day') selected = true;
        return { ok: true, isError: false, toolName: phase.toolName };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 36,
      actionId: 'case:early-pickup-date:1',
      step: {
        action: 'Date',
        target: 'Early Pickup Date',
        value: '2026-08-20',
        controlKind: 'semantic',
      },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(result.outcome.diagnostics.temporalTransaction).toMatchObject({
      intentKind: 'date',
      state: 'VALUE_COMMITTED',
      expected: '2026-08-20',
    });
    expect(hooks.dispatch.mock.calls.map(([call]) => call.phase.id))
      .toEqual(['open-calendar', 'choose-calendar-day']);
    const selectedDay = hooks.dispatch.mock.calls.find(([call]) => call.phase.id === 'choose-calendar-day')?.[0];
    expect(selectedDay).toMatchObject({
      phase: { args: { target: 'day-20', ref: 'day-20' } },
      semanticOperation: { kind: 'calendarday', candidate: { ref: 'day-20' } },
    });
  });

  it('waits for a delivered month navigation to settle before resolving the calendar day', async () => {
    let opened = false;
    let month = 7;
    let navigationDelivered = false;
    let settlePolls = 0;
    let selected = false;
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ source }) => {
        if (source === 'semantic_calendar_state_settle' && navigationDelivered && month === 7) {
          settlePolls += 1;
          if (settlePolls >= 2) month = 8;
        }
        return {
          fresh: true,
          snapshotText: opened
            ? [
                '- textbox "Early Pickup Date" [ref=date-owner]',
                '- dialog "Early Pickup Date calendar" [ref=calendar-dialog]:',
                month === 7
                  ? '  - button "Next month" [ref=next-month]'
                  : '  - gridcell "August 20, 2026" [ref=day-20]',
              ].join('\n')
            : '- textbox "Early Pickup Date" [ref=date-owner]',
          url: 'https://example.test/form',
        };
      }),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source }) => {
        if (source === 'semantic_calendar_candidate_probe') {
          if (!opened) return { candidates: [], calendarState: null };
          if (month === 7) {
            return {
              candidates: [{ role: 'button', name: 'Next month', direction: 'forward', disabled: false }],
              calendarState: { year: 2026, month: 7 },
            };
          }
          return {
            candidates: [{
              role: 'gridcell', name: 'August 20, 2026',
              dateParts: { year: 2026, month: 8, day: 20 },
              currentMonth: true, disabled: false,
            }],
            calendarState: { year: 2026, month: 8 },
          };
        }
        if (source === 'control_dispatch_branch_probe') {
          return { found: true, role: 'textbox', tagName: 'input', inputType: 'text' };
        }
        if (source === 'semantic_control_dom_evidence'
          || source === 'semantic_control_postcondition_dom_evidence') {
          return { candidates: [], roleCounts: { textbox: 1 } };
        }
        return {
          actualValue: selected ? '2026-08-20' : '',
          inputValue: selected ? '2026-08-20' : '',
          valueAfter: selected ? '2026-08-20' : '',
        };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.id === 'open-calendar') opened = true;
        if (phase.id === 'position-calendar') navigationDelivered = true;
        if (phase.id === 'choose-calendar-day') selected = true;
        return { ok: true, isError: false, toolName: phase.toolName };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 36,
      actionId: 'case:delayed-calendar-month:1',
      step: {
        action: 'Date',
        target: 'Early Pickup Date',
        value: '2026-08-20',
        controlKind: 'semantic',
      },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(settlePolls).toBe(2);
    expect(hooks.dispatch.mock.calls.map(([call]) => call.phase.id))
      .toEqual(['open-calendar', 'position-calendar', 'choose-calendar-day']);
    const selectedDay = hooks.dispatch.mock.calls.find(([call]) => call.phase.id === 'choose-calendar-day')?.[0];
    expect(selectedDay).toMatchObject({
      phase: { args: { target: 'day-20', ref: 'day-20' } },
      semanticOperation: { kind: 'calendarday', candidate: { ref: 'day-20' } },
    });
  });

  it('reveals an off-screen calendar owner once before resolving and opening it', async () => {
    let revealed = false;
    let opened = false;
    const revealTarget = vi.fn(async () => {
      revealed = true;
      return {
        ok: true,
        visible: true,
        candidateCount: 1,
        confidenceMargin: 500,
        runtimeBinding: { marker: 'qaai-runtime-calendar-owner', hadAriaLabel: false, previousAriaLabel: null },
      };
    });
    const releaseRevealedTarget = vi.fn(async () => ({ ok: true, reason: 'runtime_binding_released' }));
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: !revealed
          ? '- heading "References" [ref=references]'
          : opened
            ? [
                '- textbox "Date input" [ref=date-owner]',
                '- dialog "Early Pickup Date calendar" [ref=calendar-dialog]:',
                '  - gridcell "August 20, 2026" [ref=day-20]',
              ].join('\n')
            : '- textbox "Date input" [ref=date-owner]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => (revealed ? 'date-owner' : null)),
      revealTarget,
      releaseRevealedTarget,
      evaluate: vi.fn(async ({ source }) => {
        if (source === 'semantic_control_dom_evidence'
          || source === 'semantic_control_postcondition_dom_evidence') {
          return { candidates: [], roleCounts: { textbox: revealed ? 1 : 0 } };
        }
        return { ariaExpanded: opened, expanded: opened };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        expect(phase.args.target).toBe('date-owner');
        opened = true;
        return { ok: true, isError: false, toolName: phase.toolName };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 43,
      actionId: 'case:early-pickup-date-opener:1',
      step: {
        action: 'Click',
        target: 'Early Pickup Date calendar',
        operationCheck: { kind: 'menu_opened', required: true },
      },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(revealTarget).toHaveBeenCalledTimes(1);
    expect(releaseRevealedTarget).toHaveBeenCalledTimes(1);
    expect(hooks.dispatch).toHaveBeenCalledTimes(1);
    expect(releaseRevealedTarget.mock.invocationCallOrder[0]).toBeLessThan(hooks.dispatch.mock.invocationCallOrder[0]);
  });

  it('commits a uniquely revealed utility scroll without dispatching another scroll', async () => {
    const revealTarget = vi.fn(async () => ({
      ok: true,
      visible: true,
      moved: true,
      candidateCount: 1,
      confidenceMargin: 500,
    }));
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: '- heading "References" [ref=references]',
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      revealTarget,
      evaluate: vi.fn(async ({ source }) => source === 'semantic_control_dom_evidence'
        ? { candidates: [], roleCounts: {} }
        : { visible: true, intersectionRatio: 1 }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 39,
      actionId: 'case:planning-scroll:1',
      step: { action: 'Scroll', target: 'Planning Date/Time' },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(revealTarget).toHaveBeenCalledTimes(1);
    expect(hooks.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'time',
      target: 'Early Pickup Time',
      option: '09:00 AM',
      options: ['09:00 AM', '11:00 AM'],
      step: { value: '09:00 AM' },
      expected: '09:00',
      intentKind: 'time',
    },
    {
      name: 'timezone',
      target: 'Early Pickup Time Zone',
      option: 'Central Standard Time',
      options: ['Eastern Time', 'Central Standard Time', 'Pacific Time'],
      step: {
        selectionCriteria: {
          kind: 'contains', field: 'visible_label', operator: 'contains', value: 'Central',
        },
      },
      expected: 'Central',
      intentKind: 'timezone',
    },
  ])('selects a semantic $name option once and records exact owner readback', async (fixture) => {
    let selected = '';
    const optionLines = fixture.options
      .map((option, index) => `  - option "${option}" [ref=temporal-option-${index}]`)
      .join('\n');
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ controlPhase }) => ({
        fresh: true,
        snapshotText: controlPhase?.id?.startsWith('choose-')
          ? `- combobox "${fixture.target}" [expanded] [ref=temporal-owner]\n- listbox "${fixture.target} options" [ref=temporal-options]:\n${optionLines}`
          : `- combobox "${fixture.target}" [ref=temporal-owner]`,
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source }) => {
        if (source === 'semantic_control_dom_evidence'
          || source === 'semantic_control_postcondition_dom_evidence') {
          return { candidates: [], roleCounts: { combobox: 1 } };
        }
        if (source === 'control_exact_state_after') {
          return { found: true, selectedValue: null, selectedText: null, value: null };
        }
        return {
          selectedValue: selected,
          selectedText: selected,
          selectedTexts: selected ? [selected] : [],
        };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        const targetMatch = String(phase.args.target || '').match(/^temporal-option-(\d+)$/);
        let index = targetMatch ? Number(targetMatch[1]) : fixture.options.indexOf(phase.args.element);
        if (index < 0) {
          index = fixture.options.findIndex((option) => option.includes(String(phase.args.element || '')));
        }
        if (index >= 0) selected = fixture.options[index];
        return { ok: true, isError: false, toolName: phase.toolName };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 37,
      actionId: `case:${fixture.name}:1`,
      step: {
        action: 'Select',
        target: fixture.target,
        controlKind: 'custom',
        ...fixture.step,
      },
    });

    expect(
      result.outcome.status,
      `${fixture.name}: ${result.outcome.reason || 'no reason'}; temporal=${result.outcome.diagnostics?.temporalTransaction?.controlValidation?.code || 'none'}; resolutions=${JSON.stringify(result.outcome.diagnostics?.resolutions || [])}`,
    ).toBe('pass');
    expect(result.outcome.diagnostics.temporalTransaction).toMatchObject({
      intentKind: fixture.intentKind,
      state: 'VALUE_COMMITTED',
      expected: fixture.expected,
    });
    expect(hooks.dispatch.mock.calls.filter(([call]) => call.phase.id?.startsWith('choose-')))
      .toHaveLength(1);
  });

  it('reveals an offscreen virtualized time option and selects its normalized exact value', async () => {
    let revealed = false;
    let selected = '';
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ controlPhase }) => {
        const choosing = controlPhase?.id?.startsWith('choose-');
        const options = revealed
          ? ['08:30', '09:00', '09:30']
          : ['00:00', '00:30', '01:00', '01:30', '02:00', '02:30'];
        return {
          fresh: true,
          snapshotText: choosing
            ? [
                '- combobox "Early Pickup Time" [expanded] [ref=time-owner]',
                '- listbox "Early Pickup Time options" [ref=time-options]:',
                ...options.map((option) => `  - option "${option}" [ref=time-${option.replace(':', '')}]`),
              ].join('\n')
            : '- combobox "Early Pickup Time" [ref=time-owner]',
          url: 'https://example.test/form',
        };
      }),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source }) => {
        if (String(source).startsWith('virtualized_time_option_reveal_')) {
          revealed = true;
          return { ok: true, reason: 'owner_scoped_option_panel_repositioned' };
        }
        if (source === 'semantic_control_dom_evidence'
          || source === 'semantic_control_postcondition_dom_evidence') {
          return { candidates: [], roleCounts: { combobox: 1 } };
        }
        return {
          selectedValue: selected,
          selectedText: selected,
          selectedTexts: selected ? [selected] : [],
        };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.args.target === 'time-0900' || phase.args.element === '09:00 AM') selected = '09:00';
        return { ok: true, isError: false, toolName: phase.toolName };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 37,
      actionId: 'case:virtual-time:1',
      step: {
        action: 'Select',
        target: 'Early Pickup Time',
        controlKind: 'custom',
        value: '09:00 AM',
      },
    });

    expect(
      selected,
      JSON.stringify(hooks.dispatch.mock.calls.map(([call]) => ({
        id: call.phase?.id,
        args: call.phase?.args,
      }))),
    ).toBe('09:00');
    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(hooks.evaluate.mock.calls.some(([call]) => (
      String(call.source).startsWith('virtualized_time_option_reveal_')
    ))).toBe(true);
    expect(hooks.dispatch.mock.calls.filter(([call]) => call.phase.id?.startsWith('choose-')))
      .toHaveLength(1);
    expect(result.outcome.diagnostics.temporalTransaction).toMatchObject({
      intentKind: 'time',
      expected: '09:00',
      state: 'VALUE_COMMITTED',
    });
  });

  it('searches a virtualized timezone list for an owner-scoped contains match', async () => {
    let revealCount = 0;
    let selected = '';
    const hooks = baseHooks({
      snapshot: vi.fn(async ({ controlPhase }) => {
        const choosing = controlPhase?.id?.startsWith('choose-');
        const options = revealCount >= 3
          ? ['Mountain Time', 'Central Standard Time', 'Central Daylight Time']
          : ['Atlantic Time', 'Eastern Time'];
        return {
          fresh: true,
          snapshotText: choosing
            ? [
                '- combobox "Early Pickup Time Zone" [expanded] [ref=zone-owner]',
                '- listbox "Early Pickup Time Zone options" [ref=zone-options]:',
                ...options.map((option, index) => `  - option "${option}" [ref=zone-${index}]`),
              ].join('\n')
            : '- combobox "Early Pickup Time Zone" [ref=zone-owner]',
          url: 'https://example.test/form',
        };
      }),
      resolveRef: vi.fn(async () => null),
      evaluate: vi.fn(async ({ source }) => {
        if (String(source).startsWith('virtualized_timezone_option_reveal_')) {
          revealCount += 1;
          return { ok: true, reason: 'owner_scoped_option_panel_repositioned' };
        }
        if (source === 'semantic_control_dom_evidence'
          || source === 'semantic_control_postcondition_dom_evidence') {
          return { candidates: [], roleCounts: { combobox: 1 } };
        }
        return {
          selectedValue: selected,
          selectedText: selected,
          selectedTexts: selected ? [selected] : [],
        };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.args.element === 'Central') selected = 'Central Standard Time';
        return { ok: true, isError: false, toolName: phase.toolName };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 39,
      actionId: 'case:virtual-timezone:1',
      step: {
        action: 'Select',
        target: 'Early Pickup Time Zone',
        controlKind: 'custom',
        selectionCriteria: {
          kind: 'contains',
          field: 'visible_label',
          operator: 'contains',
          value: 'Central',
        },
      },
    });

    expect(result.outcome).toMatchObject({ status: 'pass' });
    expect(selected).toContain('Central');
    expect(revealCount).toBe(3);
    expect(hooks.dispatch.mock.calls.filter(([call]) => call.phase.id?.startsWith('choose-')))
      .toHaveLength(1);
    expect(result.outcome.diagnostics.temporalTransaction).toMatchObject({
      intentKind: 'timezone',
      expected: 'Central',
      state: 'VALUE_COMMITTED',
    });
  });

  it('reuses a revalidated owner across authored Click and Select steps', async () => {
    let opened = false;
    let selected = '';
    let resolveOwner = true;
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({
        fresh: true,
        snapshotText: opened
          ? [
              '- listbox "Early Pickup Time Zone options" [ref=zone-options]:',
              '  - option "Central Standard Time" [ref=zone-central]',
            ].join('\n')
          : `- combobox "Early Pickup Time Zone" [ref=zone-owner]${selected ? `: ${selected}` : ''}`,
        url: 'https://example.test/form',
      })),
      resolveRef: vi.fn(async ({ step }) => (
        resolveOwner && String(step.target || '').includes('Early Pickup Time Zone')
          ? 'zone-owner'
          : null
      )),
      evaluate: vi.fn(async ({ source, target }) => {
        if (source === 'semantic_control_dom_evidence'
          || source === 'semantic_control_postcondition_dom_evidence') {
          return { candidates: [], roleCounts: { combobox: 1 } };
        }
        if (String(source).endsWith('_verified_owner_binding')) {
          return { found: target === 'zone-owner', tagName: 'div', role: 'combobox', disabled: false };
        }
        if (String(source).startsWith('dropdown_transaction')) {
          const owner = {
            ref: 'zone-owner', role: 'combobox', label: 'Early Pickup Time Zone',
            expanded: opened, visible: true, enabled: true,
            selectedValue: selected, displayedValue: selected,
          };
          return {
            available: true,
            owner,
            trigger: owner,
            valueNode: owner,
            popups: opened ? [{ ref: 'zone-options', role: 'listbox', ownerRef: 'zone-owner', visible: true }] : [],
            visibleOptions: opened ? [{ ref: 'zone-central', role: 'option', text: 'Central Standard Time', visible: true }] : [],
          };
        }
        return {
          found: true,
          role: 'combobox',
          ariaExpanded: opened,
          expanded: opened,
          selectedValue: selected,
          selectedText: selected,
          selectedTexts: selected ? [selected] : [],
        };
      }),
      dispatch: vi.fn(async ({ phase }) => {
        if (phase.args.target === 'zone-owner') opened = true;
        if (phase.args.target === 'zone-central' || phase.args.element === 'Central') {
          selected = 'Central Standard Time';
          opened = false;
        }
        return { ok: true, isError: false, toolName: phase.toolName };
      }),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const opener = await runtime.run({
      idx: 51,
      actionId: 'case:timezone:open',
      step: {
        action: 'Click',
        target: 'Early Pickup Time Zone dropdown',
        operationCheck: { kind: 'menu_opened', required: true },
      },
    });
    expect(opener.outcome).toMatchObject({ status: 'pass' });

    resolveOwner = false;
    const selection = await runtime.run({
      idx: 53,
      actionId: 'case:timezone:select',
      step: {
        action: 'Select',
        target: 'Early Pickup Time Zone dropdown',
        controlKind: 'custom',
        selectionCriteria: {
          kind: 'contains', field: 'visible_label', operator: 'contains', value: 'Central',
        },
      },
    });

    expect(
      selection.outcome.status,
      JSON.stringify({
        opener: { status: opener.outcome.status, reason: opener.outcome.reason },
        reason: selection.outcome.reason,
        sources: hooks.evaluate.mock.calls.map(([call]) => call.source).filter(Boolean),
        resolutions: selection.outcome.diagnostics?.resolutions,
        dropdown: selection.outcome.diagnostics?.dropdownTransaction,
        temporal: selection.outcome.diagnostics?.temporalTransaction,
      }),
    ).toBe('pass');
    expect(selected).toBe('Central Standard Time');
    expect(hooks.evaluate.mock.calls.some(([call]) => (
      String(call.source).endsWith('_verified_owner_binding')
    ))).toBe(true);
  });

  it('runs standalone WaitForState without dispatching a browser mutation', async () => {
    const hooks = baseHooks({
      snapshot: vi.fn(async () => ({ fresh: true, snapshotText: '- heading "Ready"', url: 'https://neutral.test/ready', title: 'Ready' })),
    });
    const runtime = createConductorUniversalRuntime({ hooks });
    const result = await runtime.run({
      idx: 3,
      actionId: 'case:wait:4',
      step: { action: 'WaitForState', waitContract: { kind: 'stabilization', timeoutMs: 20, pollIntervalMs: 1, stableObservations: 2, expected: { effect: 'fingerprint_stable' } } },
    });
    expect(result.outcome).toMatchObject({ family: 'wait', status: 'pass' });
    expect(hooks.dispatch).not.toHaveBeenCalled();
    expect(hooks.dispatchEvent).not.toHaveBeenCalled();
  });
});
