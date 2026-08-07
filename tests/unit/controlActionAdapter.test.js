import { describe, expect, it } from 'vitest';
import adapter from '../../server/services/controlActionAdapter.js';
import contracts from '../../server/services/controlActionContracts.js';
import registry from '../../server/services/browserActionRegistry.js';

describe('website-neutral control action adapter', () => {
  it('normalizes every requested action family without website vocabulary', () => {
    expect([
      'Fill', 'Type', 'Select', 'Check', 'Uncheck', 'Radio', 'Hover', 'Press', 'Calendar', 'Scroll', 'Expand', 'Collapse',
    ].map((action) => adapter.actionKind({ action }))).toEqual([
      'fill', 'type', 'select', 'check', 'uncheck', 'radio', 'hover', 'press', 'date', 'scroll', 'expand', 'collapse',
    ]);
  });

  it('builds Fill as fresh unique resolution, registered dispatch, exact readback, and one retry', () => {
    const plan = adapter.buildControlActionPlan({ action: 'Fill', element: 'Email address', value: 'qa@example.test' });

    expect(plan).toMatchObject({
      schema: contracts.SCHEMA,
      kind: 'fill',
      websiteNeutral: true,
      postcondition: { kind: 'value_exact', expected: 'qa@example.test', exact: true },
      idempotency: { mode: 'set_exact_value', retrySafe: true },
      retryPolicy: { maxRetries: 1, freshObservationBeforeRetry: true, reResolveBeforeRetry: true },
    });
    expect(plan.phases[0]).toMatchObject({
      toolName: 'browser_fill_form',
      resolutionToolName: 'browser_fill_form',
      freshObservationRequired: true,
      resolution: { freshObservationRequired: true, unique: { count: 1, sameElement: true }, failClosed: true },
    });
    expect(plan.phases[0].resolution.roleHints).toEqual(expect.arrayContaining([
      'textbox', 'searchbox', 'spinbutton', 'combobox',
    ]));
    expect(registry.isRegisteredTool(plan.phases[0].toolName)).toBe(true);
    expect(contracts.validateControlActionPlan(plan)).toEqual([]);
  });

  it('builds a reference-backed secure textbox plan without retaining the secret', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Fill',
      element: 'Password',
      inputType: 'password',
      valueRef: 'env://LOGIN_PASSWORD',
      sensitive: true,
    });

    expect(plan).toMatchObject({
      kind: 'fill',
      postcondition: { kind: 'value_ref_exact', expected: { valueRef: 'env://LOGIN_PASSWORD', sensitive: true } },
      metadata: { valueRef: 'env://LOGIN_PASSWORD', referenceBacked: true, sensitive: true },
    });
    expect(JSON.stringify(plan)).not.toContain('resolved-secret');
    const materialized = adapter.materializeReferencePhase(plan.phases[0], 'resolved-secret');
    expect(materialized.args.fields[0]).toMatchObject({ value: 'resolved-secret', text: 'resolved-secret' });
    expect(JSON.stringify(plan)).not.toContain('resolved-secret');
    expect(adapter.proveControlAction(plan, { actualValue: 'resolved-secret' }, { resolvedValue: 'resolved-secret' })).toMatchObject({
      matched: true,
      details: {
        valueRef: 'env://LOGIN_PASSWORD',
        expectedFingerprint: adapter.valueFingerprint('resolved-secret'),
        actualFingerprint: adapter.valueFingerprint('resolved-secret'),
        nonEmpty: true,
      },
    });
  });

  it('keeps Type distinct while demanding the same exact value proof', () => {
    const plan = adapter.buildControlActionPlan({ action: 'Type', element: 'Search', value: 'Ada' });
    expect(plan.kind).toBe('type');
    expect(plan.phases[0]).toMatchObject({ toolName: 'browser_type', args: { text: 'Ada' } });
    expect(plan.postcondition).toMatchObject({ kind: 'value_exact', expected: 'Ada' });
  });

  it('rejects partial Fill readback instead of treating contains as exact', () => {
    const plan = adapter.buildControlActionPlan({ action: 'Fill', element: 'User name', value: 'Ada' });
    expect(adapter.proveControlAction(plan, { actualValue: 'Ada Lovelace' })).toMatchObject({ matched: false, status: 'blocked' });
    expect(adapter.proveControlAction(plan, { actualValue: 'Ada' })).toMatchObject({ matched: true, status: 'pass' });
  });

  it('builds a native Select around browser_select_option and exact selected value', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Select', element: 'Status', value: 'Enabled', controlKind: 'native', tag: 'select',
    });
    expect(plan).toMatchObject({ kind: 'select', variant: 'native', postcondition: { kind: 'selection_exact', expected: 'Enabled' } });
    expect(plan.phases.map((phase) => phase.toolName)).toEqual(['browser_select_option']);
    expect(adapter.proveControlAction(plan, { selectedValue: 'Enabled pending' }).matched).toBe(false);
    expect(adapter.proveControlAction(plan, { selectedValue: 'Enabled' }).matched).toBe(true);
  });

  it('accepts exact visible option text when the native stored value differs', () => {
    const plan = adapter.buildControlActionPlan({ action: 'Select', element: 'Country', value: 'Canada', controlKind: 'native' });
    expect(adapter.proveControlAction(plan, { selectedValue: 'CA', selectedText: 'Canada' })).toMatchObject({ matched: true });
  });

  it('treats equivalent 12-hour and 24-hour selected times as exact', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Select', element: 'Early Pickup Time', value: '09:00 AM', controlKind: 'aria',
    });
    expect(adapter.proveControlAction(plan, { selectedText: '09:00' })).toMatchObject({
      kind: 'selection_exact',
      matched: true,
    });
  });

  it('builds an ARIA/custom Select as open, fresh re-observe, exact option, and readback', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Select', element: 'User role', value: 'Admin', controlKind: 'aria', role: 'combobox',
    });
    expect(plan).toMatchObject({ kind: 'select', variant: 'custom', metadata: { optionMatch: 'exact', reopenOnRetry: true } });
    expect(plan.phases.map((phase) => phase.id)).toEqual([
      'open-choice-control',
      'open-choice-control-keyboard-assist',
      'choose-exact-option',
    ]);
    expect(plan.phases.every((phase) => phase.freshObservationRequired)).toBe(true);
    expect(plan.phases[1]).toMatchObject({
      toolName: 'browser_press_key',
      resolutionToolName: 'browser_click',
      args: { key: 'ArrowDown' },
      semanticTarget: { kind: 'control_opener', controlKind: 'choice', ownerTarget: 'User role' },
    });
    expect(plan.phases[2]).toMatchObject({
      toolName: 'browser_click',
      semanticTarget: { kind: 'option', name: 'Admin', match: 'exact' },
      resolution: { scope: { ownerTarget: 'User role', openedByPhase: 'open-choice-control' } },
    });
  });

  it('materializes exact and authored ordinal Select criteria without requiring a legacy value', () => {
    const exact = adapter.buildControlActionPlan({
      action: 'Select', element: 'Equipment', text: 'Select LTL from Equipment',
      selectionCriteria: { kind: 'exact_text', text: 'LTL' },
    });
    expect(exact).toMatchObject({
      postcondition: { kind: 'selection_exact', expected: 'LTL' },
      metadata: { optionMatch: 'exact', selectionSource: 'selectionCriteria' },
    });

    const ordinalWithLabel = adapter.buildControlActionPlan({
      action: 'Select', element: 'Organization',
      selectionCriteria: { kind: 'ordinal', ordinal: 2, expectedText: 'Northstar Europe' },
    });
    expect(ordinalWithLabel).toMatchObject({
      postcondition: { kind: 'selection_exact', expected: 'Northstar Europe' },
      metadata: { optionMatch: 'exact', authoredOrdinal: 2 },
    });
  });

  it('materializes a contains-text Select criterion as a custom live option match and contains proof', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Select', element: 'Time Zone',
      selectionCriteria: { kind: 'predicate', predicate: 'visible label contains Central' },
    });
    expect(plan).toMatchObject({
      kind: 'select', variant: 'custom',
      postcondition: { kind: 'selection_contains', expected: 'Central' },
      metadata: { optionMatch: 'contains', selectionSource: 'selectionCriteria' },
    });
    expect(plan.phases.map((phase) => phase.id)).toEqual([
      'open-choice-control',
      'open-choice-control-keyboard-assist',
      'choose-matching-option',
    ]);
    expect(plan.phases[2]).toMatchObject({
      resolution: { label: 'Central' },
      semanticTarget: { kind: 'option', name: 'Central', match: 'contains' },
    });
    expect(adapter.proveControlAction(plan, { selectedText: '(UTC-06:00) Central Time' })).toMatchObject({
      kind: 'selection_contains', matched: true,
    });
    expect(adapter.proveControlAction(plan, { selectedText: 'Eastern Time' })).toMatchObject({ matched: false });
  });

  it('still rejects Select when neither a value nor a safe criterion exists', () => {
    expect(() => adapter.buildControlActionPlan({
      action: 'Select', element: 'Time Zone', selectionCriteria: { kind: 'ordinal', ordinal: 2 },
    })).toThrow(/supported selectionCriteria/);
  });

  it('reuses exact dropdown certification for custom Select snapshots', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Select', element: 'User role', value: 'Admin', controlKind: 'custom',
    });
    const proof = adapter.proveControlAction(plan, {
      snapshotBeforeOpen: '- combobox "User role"',
      snapshotAfterOpen: '- combobox "User role"\n- option "Admin"\n- option "Administrator"',
      snapshotAfterSelect: '- combobox "User role": Admin',
    });
    expect(proof).toMatchObject({ kind: 'selection_exact', matched: true });
    expect(proof.details).toMatchObject({ optionMatched: true, valueReflected: true });
  });

  it.each([
    ['Check', 'check', 'browser_check', true, 'checkbox'],
    ['Uncheck', 'uncheck', 'browser_uncheck', false, 'checkbox'],
    ['Radio', 'radio', 'browser_check', true, 'radio'],
  ])('builds %s as an idempotent exact-state action', (action, kind, toolName, expected, role) => {
    const plan = adapter.buildControlActionPlan({ action, element: 'Receive updates' });
    expect(plan).toMatchObject({
      kind,
      role,
      idempotency: { mode: 'ensure_exact_state', expectedState: expected, retrySafe: true },
      postcondition: { kind: 'checked_exact', expected },
    });
    expect(plan.phases[0]).toMatchObject({ toolName, resolutionToolName: 'browser_click' });
    expect(adapter.alreadySatisfied(plan, { checked: expected })).toMatchObject({ satisfied: true, reason: 'exact_postcondition_already_satisfied' });
    expect(adapter.proveControlAction(plan, { checked: !expected }).matched).toBe(false);
  });

  it.each([
    ['Expand', 'expand', true],
    ['Collapse', 'collapse', false],
  ])('builds %s as an idempotent disclosure-state action', (action, kind, expected) => {
    const plan = adapter.buildControlActionPlan({ action, element: 'Details section' });
    expect(plan).toMatchObject({
      kind,
      idempotency: { mode: 'ensure_exact_state', expectedState: expected, retrySafe: true },
      postcondition: { kind: 'expanded_exact', expected },
      metadata: { stateAttribute: 'aria-expanded' },
    });
    expect(plan.phases[0]).toMatchObject({ toolName: 'browser_click', resolutionToolName: 'browser_click' });
    expect(adapter.alreadySatisfied(plan, { ariaExpanded: String(expected) }))
      .toMatchObject({ satisfied: true, reason: 'exact_postcondition_already_satisfied' });
    expect(adapter.proveControlAction(plan, { ariaExpanded: String(!expected) }).matched).toBe(false);
  });

  it('requires rendered exact tooltip text for Hover when text is declared', () => {
    const plan = adapter.buildControlActionPlan({ action: 'Hover', element: 'Help', tooltipText: 'More information' });
    expect(plan).toMatchObject({ kind: 'hover', postcondition: { kind: 'tooltip_visible_exact', expected: 'More information' } });
    expect(plan.phases[0]).toMatchObject({ toolName: 'browser_hover', freshObservationRequired: true });
    expect(adapter.proveControlAction(plan, { tooltipVisible: true, tooltipText: 'More information here' }).matched).toBe(false);
    expect(adapter.proveControlAction(plan, { tooltipVisible: true, tooltipText: 'More information' }).matched).toBe(true);
  });

  it('makes keyboard Press non-retryable unless the author explicitly proves retry safety', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Press', key: 'Enter', postcondition: { kind: 'url', url: 'https://example.test/complete' },
    });
    expect(plan).toMatchObject({ kind: 'press', idempotency: { mode: 'non_idempotent', retrySafe: false }, retryPolicy: { maxRetries: 0 } });
    expect(adapter.retryDecision({ plan, retryCount: 0, reason: 'dispatch_error' })).toMatchObject({ retry: false, reason: 'action_not_retry_safe' });
    expect(adapter.proveControlAction(plan, { url: 'https://example.test/complete?trace=1' }).matched).toBe(true);
  });

  it('permits one fresh bounded Press retry only when explicitly marked retrySafe', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Press', key: 'Escape', retrySafe: true, postcondition: { kind: 'hidden' },
    });
    expect(plan).toMatchObject({ idempotency: { mode: 'effect_bound', retrySafe: true }, retryPolicy: { maxRetries: 1 } });
    expect(adapter.retryDecision({ plan, retryCount: 0, reason: 'postcondition_not_met' })).toMatchObject({
      retry: true, nextRetryCount: 1, freshObservationRequired: true, reResolveRequired: true,
    });
    expect(adapter.retryDecision({ plan, retryCount: 1, reason: 'postcondition_not_met' })).toMatchObject({ retry: false, reason: 'retry_budget_exhausted' });
  });

  it('requires an exact typed postcondition for keyboard Press', () => {
    expect(() => adapter.buildControlActionPlan({ action: 'Press', key: 'Enter' }))
      .toThrow('requires an exact postcondition descriptor');
  });

  it('builds a native date input as an exact ISO value action', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Date', element: 'Due date', value: '2027-02-28', controlKind: 'native', inputType: 'date',
    });
    expect(plan).toMatchObject({
      kind: 'date', variant: 'native',
      postcondition: { kind: 'date_exact', expected: '2027-02-28' },
      metadata: { dateParts: { year: 2027, month: 2, day: 28 }, localeIndependent: true },
    });
    expect(plan.phases[0]).toMatchObject({
      toolName: 'browser_fill_form',
      args: { fields: [{ type: 'textbox', value: '2027-02-28' }] },
    });
    expect(adapter.proveControlAction(plan, { inputValue: '2027-02-28' }).matched).toBe(true);
  });

  it('proves an exact date from the locale-formatted owner readback', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Date', element: 'Early Pickup Date calendar', value: '2026-08-20', controlKind: 'semantic',
    });

    expect(adapter.proveControlAction(plan, { inputValue: '08/20/2026' })).toMatchObject({
      matched: true,
      details: { actual: '2026-08-20', expected: '2026-08-20', rawActual: '08/20/2026' },
    });
  });

  it('builds semantic calendar navigation from date parts without hardcoded month or arrow labels', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Calendar', element: 'Due date', value: '2027-11-09', controlKind: 'semantic',
    });
    expect(plan.phases.map((phase) => phase.id)).toEqual(['open-calendar', 'position-calendar', 'choose-calendar-day']);
    expect(plan.phases[1].semanticTarget).toMatchObject({
      kind: 'calendar_position', dateParts: { year: 2027, month: 11, day: 9 }, labelIndependent: true,
    });
    expect(plan.phases[2].semanticTarget).toMatchObject({
      kind: 'calendar_day', match: 'exact_date_parts', requireCurrentMonth: true, excludeDisabled: true,
    });
    const semanticContract = JSON.stringify([plan.phases[1].semanticTarget, plan.phases[2].semanticTarget]);
    expect(semanticContract).not.toMatch(/next|previous|january|february|march|april|may|june|july|august|september|october|november|december/i);
  });

  it('resolves authored calendar trigger wording against the underlying date owner', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Date', element: 'Delivery Date calendar', value: '2027-11-09', controlKind: 'semantic',
    });

    expect(plan.target).toBe('Delivery Date calendar');
    expect(plan.metadata).toMatchObject({
      ownerTarget: 'Delivery Date',
      authoredTarget: 'Delivery Date calendar',
    });
    expect(plan.phases[0]).toMatchObject({
      id: 'open-calendar',
      resolution: { label: 'Delivery Date' },
      args: { element: 'Delivery Date' },
    });
  });

  it('rejects ambiguous or invalid calendar values', () => {
    expect(() => adapter.buildControlActionPlan({ action: 'Date', element: 'Due date', value: '02/03/2027' }))
      .toThrow('unambiguous ISO date');
    expect(() => adapter.buildControlActionPlan({ action: 'Date', element: 'Due date', value: '2027-02-30' }))
      .toThrow('unambiguous ISO date');
  });

  it('scrolls an exact target into view and proves a visibility threshold', () => {
    const plan = adapter.buildControlActionPlan({ action: 'Scroll', element: 'Audit history', scrollMode: 'target' });
    expect(plan).toMatchObject({
      kind: 'scroll', variant: 'target',
      postcondition: { kind: 'target_visible_exact', expected: { visible: true, minimumIntersectionRatio: 0.01 } },
    });
    expect(plan.phases[0]).toMatchObject({
      toolName: 'browser_evaluate', resolutionToolName: 'browser_hover', allowUtilityDispatch: true,
    });
    expect(adapter.proveControlAction(plan, { visible: true, intersectionRatio: 0.009 }).matched).toBe(false);
    expect(adapter.proveControlAction(plan, { visible: true, intersectionRatio: 0.4 }).matched).toBe(true);
  });

  it('proves page/content scrolling by bounded position or declared content effect', () => {
    const endPlan = adapter.buildControlActionPlan({ action: 'Scroll', scrollMode: 'page', boundary: 'end' });
    expect(endPlan).toMatchObject({
      variant: 'page', idempotency: { mode: 'ensure_exact_state', retrySafe: true }, retryPolicy: { maxRetries: 1 },
    });
    expect(adapter.proveControlAction(endPlan, { before: 20, after: 980, max: 980 }).matched).toBe(true);
    expect(adapter.proveControlAction(endPlan, { before: 20, after: 979, max: 980 }).matched).toBe(false);

    const contentPlan = adapter.buildControlActionPlan({
      action: 'Scroll', element: 'Activity stream', scrollMode: 'content', contentEffect: { targetVisible: 'Last event' }, boundary: 'end',
    });
    expect(contentPlan.phases[0].args.function).toContain('el.scrollTop');
    expect(contentPlan.phases[0].args.function).not.toContain('document.scrollingElement');
    expect(adapter.proveControlAction(contentPlan, { contentEffectMatched: true }).matched).toBe(true);
  });

  it('does not retry relative scrolling because repeating it changes the requested position', () => {
    const plan = adapter.buildControlActionPlan({ action: 'Scroll', scrollMode: 'page', direction: 'forward', amount: 300 });
    expect(plan).toMatchObject({ idempotency: { mode: 'effect_bound', retrySafe: false }, retryPolicy: { maxRetries: 0 } });
    expect(adapter.proveControlAction(plan, { before: 100, after: 399 }).matched).toBe(false);
    expect(adapter.proveControlAction(plan, { before: 100, after: 400 }).matched).toBe(true);
  });

  it('routes Check resolution through the shared verified locator resolver before dispatch', async () => {
    const plan = adapter.buildControlActionPlan({ action: 'Check', element: 'Terms accepted' });
    const locator = { expression: 'getByRole("checkbox", { name: "Terms accepted" })' };
    const calls = [];
    const resolver = {
      async resolveVerifiedForTool(input) {
        calls.push(input);
        return { ok: true, actionLocator: locator, fulfilledBy: 'verified_dom_inspection' };
      },
      isVerifiedActionLocator(candidate) { return candidate === locator; },
    };
    const result = await adapter.resolvePhaseTarget({
      session: { client: {} }, plan, phaseId: 'ensure-checked', snapshotText: '- checkbox "Terms accepted" [ref=e1]',
      pageUrl: 'https://example.test/preferences', resolver,
    });
    expect(result).toMatchObject({ ok: true, actionLocator: locator });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolName: 'browser_click', elementLabel: 'Terms accepted' });

    const bound = adapter.bindResolvedTarget(plan.phases[0], 'e1');
    expect(bound.args).toMatchObject({ target: 'e1', ref: 'e1' });
  });

  it('fails closed when ordinary resolution is unverified and exposes semantic calendar resolution explicitly', async () => {
    const fill = adapter.buildControlActionPlan({ action: 'Fill', element: 'Email', value: 'a@example.test' });
    const weakResolver = {
      async resolveVerifiedForTool() { return { ok: false, actionLocator: { expression: 'getByRole("textbox")' }, gap: { code: 'ambiguous' } }; },
      isVerifiedActionLocator() { return false; },
    };
    await expect(adapter.resolvePhaseTarget({
      session: { client: {} }, plan: fill, phaseId: 'set-value', snapshotText: '- textbox "Email" [ref=e1]', resolver: weakResolver,
    })).resolves.toMatchObject({ ok: false, code: 'unique_live_target_not_proven', gap: { code: 'ambiguous' } });

    const calendar = adapter.buildControlActionPlan({ action: 'Calendar', element: 'Due date', value: '2027-11-09', controlKind: 'semantic' });
    await expect(adapter.resolvePhaseTarget({
      session: { client: {} }, plan: calendar, phaseId: 'choose-calendar-day', snapshotText: '- grid "calendar"', resolver: weakResolver,
    })).resolves.toMatchObject({ ok: false, code: 'semantic_resolution_required', semanticTarget: { kind: 'calendar_day' } });
  });

  it('resolves semantic calendar day and month navigation from structural date facts, never labels', async () => {
    const calendar = adapter.buildControlActionPlan({
      action: 'Calendar', element: 'Due date', value: '2027-11-09', controlKind: 'semantic',
    });
    await expect(adapter.resolvePhaseTarget({
      session: { client: {} },
      plan: calendar,
      phaseId: 'choose-calendar-day',
      snapshotText: '- grid "calendar"',
      semanticCandidates: [
        { ref: 'stale-duplicate', role: 'gridcell', dateParts: { year: 2027, month: 11, day: 9 }, currentMonth: true, disabled: true },
        { ref: 'day-9', role: 'gridcell', dateParts: { year: 2027, month: 11, day: 9 }, currentMonth: true },
        { ref: 'day-10', role: 'gridcell', dateParts: { year: 2027, month: 11, day: 10 }, currentMonth: true },
      ],
    })).resolves.toMatchObject({
      ok: true,
      semanticResolution: { reason: 'calendar_day_exact_date_parts' },
      resolvedCandidate: { ref: 'day-9' },
    });

    await expect(adapter.resolvePhaseTarget({
      session: { client: {} },
      plan: calendar,
      phaseId: 'position-calendar',
      snapshotText: '- grid "calendar"',
      calendarState: { year: 2026, month: 9 },
      semanticCandidates: [
        { ref: 'forward-control', role: 'button', semanticDirection: 'forward' },
        { ref: 'backward-control', role: 'button', semanticDirection: 'backward' },
      ],
    })).resolves.toMatchObject({
      ok: true,
      semanticResolution: {
        reason: 'calendar_directional_navigation',
        direction: 'forward',
        deltaMonths: 14,
        operations: [{ repeat: 14, candidate: { ref: 'forward-control' } }],
      },
    });

    await expect(adapter.resolvePhaseTarget({
      session: { client: {} },
      plan: calendar,
      phaseId: 'position-calendar',
      snapshotText: '- grid "calendar"',
      calendarState: { year: 2027, month: 11 },
      semanticCandidates: [],
    })).resolves.toMatchObject({
      ok: true,
      phaseAlreadySatisfied: true,
      semanticResolution: {
        alreadySatisfied: true,
        reason: 'calendar_month_year_already_positioned',
      },
    });
  });

  it('fails closed when semantic date facts identify multiple enabled calendar days', async () => {
    const calendar = adapter.buildControlActionPlan({
      action: 'Calendar', element: 'Due date', value: '2027-11-09', controlKind: 'semantic',
    });
    await expect(adapter.resolvePhaseTarget({
      session: { client: {} },
      plan: calendar,
      phaseId: 'choose-calendar-day',
      snapshotText: '- grid "calendar"',
      semanticCandidates: [
        { ref: 'day-9-a', role: 'gridcell', dateParts: { year: 2027, month: 11, day: 9 }, currentMonth: true },
        { ref: 'day-9-b', role: 'button', dateParts: { year: 2027, month: 11, day: 9 }, currentMonth: true },
      ],
    })).resolves.toMatchObject({ ok: false, code: 'semantic_target_ambiguous' });
  });

  it('selects the unique actionable hit target when equivalent date nodes overlap', async () => {
    const calendar = adapter.buildControlActionPlan({
      action: 'Calendar', element: 'Due date', value: '2027-11-09', controlKind: 'semantic',
    });
    await expect(adapter.resolvePhaseTarget({
      session: { client: {} },
      plan: calendar,
      phaseId: 'choose-calendar-day',
      snapshotText: '- grid "calendar"',
      semanticCandidates: [
        { ref: 'day-9-container', role: 'gridcell', dateParts: { year: 2027, month: 11, day: 9 }, currentMonth: true },
        { ref: 'day-9-hit', role: 'button', dateParts: { year: 2027, month: 11, day: 9 }, currentMonth: true, hitTarget: true },
        { role: 'generic', name: '9', dateParts: { year: 2027, month: 11, day: 9 }, currentMonth: true },
      ],
    })).resolves.toMatchObject({
      ok: true,
      semanticResolution: { reason: 'calendar_day_exact_hit_target' },
      resolvedCandidate: { ref: 'day-9-hit' },
    });
  });

  it('caps caller-supplied retries and excludes ambiguous target guessing', () => {
    const plan = adapter.buildControlActionPlan({
      action: 'Fill', element: 'Email', value: 'a@example.test',
      retryPolicy: { maxRetries: 99, retryOn: ['dispatch_error', 'postcondition_not_met'] },
    });
    expect(plan.retryPolicy.maxRetries).toBe(contracts.MAX_RETRIES);
    expect(adapter.retryDecision({ plan, retryCount: 0, reason: 'ambiguous_target' })).toMatchObject({ retry: false, reason: 'reason_not_retryable' });
  });
});
