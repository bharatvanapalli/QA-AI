import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const recorder = require('../../server/services/liveScriptRecorder');

describe('liveScriptRecorder', () => {
  it('preserves the complete runtime action taxonomy in the canonical ledger', () => {
    const ledger = recorder.newLedger({ runResultId: 'rr-action-matrix', testCaseId: 'tc-action-matrix' });
    const locator = (expression) => ({
      frameworkExpressions: { playwright: expression },
    });
    const target = locator('page.getByTestId("target")');
    const source = locator('page.getByTestId("source")');
    const destination = locator('page.getByTestId("destination")');
    const cases = [
      ['browser_navigate', 'navigate', { url: 'https://example.test/start' }, null, 'page.goto'],
      ['browser_navigate_back', 'navigateBack', {}, null, 'page.goBack'],
      ['browser_navigate_forward', 'navigateForward', {}, null, 'page.goForward'],
      ['browser_click', 'click', { element: 'Target' }, target, '.click()'],
      ['browser_double_click', 'doubleClick', { element: 'Target' }, target, '.dblclick()'],
      ['browser_triple_click', 'tripleClick', { element: 'Target' }, target, 'clickCount: 3'],
      ['browser_fill', 'fill', { element: 'Target', value: 'replacement' }, target, '.fill('],
      ['browser_type', 'type', { element: 'Target', value: 'sequential' }, target, '.pressSequentially('],
      ['browser_select_option', 'selectOption', { element: 'Target', value: 'active' }, target, '.selectOption('],
      ['browser_check', 'check', { element: 'Target' }, target, '.check()'],
      ['browser_uncheck', 'uncheck', { element: 'Target' }, target, '.uncheck()'],
      ['browser_press_key', 'press', { key: 'Enter' }, null, 'page.keyboard.press'],
      ['browser_hover', 'hover', { element: 'Target' }, target, '.hover()'],
      ['browser_drag', 'drag', { startElement: 'Source', endElement: 'Destination' }, {
        ...destination,
        kind: 'drag',
        dragSourceLocator: source,
        dragTargetLocator: destination,
      }, '.dragTo('],
      ['browser_file_upload', 'upload', { element: 'Target', value: 'fixture.txt' }, target, '.setInputFiles('],
      ['browser_handle_dialog', 'handleDialog', { accept: false }, null, "page.once('dialog'"],
      ['browser_resize', 'resize', { width: 1440, height: 900 }, null, 'page.setViewportSize'],
      ['browser_close', 'close', {}, null, 'page.close'],
      ['browser_wait_for', 'waitFor', { text: 'Ready', timeoutMs: 2500 }, null, 'getByText("Ready"'],
    ];

    for (const [tool, kind, args, actionLocator, command] of cases) {
      recorder.appendScriptLine(ledger, {
        trailEntry: { tool, args, ok: true, ...(actionLocator ? { actionLocator } : {}) },
      });
      const line = ledger.lines.at(-1);
      expect(line, `${tool} must create a ledger line`).toBeTruthy();
      expect(line.kind, `${tool} must retain ${kind}`).toBe(kind);
      expect(line.command.playwright, `${tool} must emit its own operation`).toContain(command);
      expect(line.canonical, `${tool} must remain canonical`).toBe(true);
    }
    expect(recorder.canonicalLines(ledger)).toHaveLength(cases.length);
  });

  it('keeps unverifiable coordinate and scroll operations as diagnostic metadata', () => {
    const ledger = recorder.newLedger({ runResultId: 'rr-diagnostic-actions', testCaseId: 'tc-diagnostic-actions' });
    for (const tool of ['browser_mouse_click', 'browser_click_xy', 'browser_scroll']) {
      recorder.appendScriptLine(ledger, { trailEntry: { tool, args: { x: 10, y: 20 }, ok: true } });
    }
    expect(recorder.canonicalLines(ledger)).toEqual([]);
    expect(ledger.utilityMetadata.map((entry) => entry.tool)).toEqual([
      'browser_mouse_click',
      'browser_click_xy',
      'browser_scroll',
    ]);
  });

  it('keeps deterministic DOM fills as canonical fill lines instead of utility metadata', () => {
    const ledger = recorder.newLedger({ runResultId: 'rr-dom', testCaseId: 'tc-dom' });

    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'deterministic_dom_fill',
        contractStepId: 'tc-dom:step:8',
        args: { element: 'Password', target: 'dom-label', valueRef: 'secret:PASSWORD' },
      },
    });

    expect(recorder.canonicalLines(ledger)).toHaveLength(1);
    expect(recorder.canonicalLines(ledger)[0]).toMatchObject({
      contractStepId: 'tc-dom:step:8',
      tool: 'deterministic_dom_fill',
      kind: 'fill',
    });
    expect(ledger.utilityMetadata).toEqual([]);
  });

  it('records executable actions as canonical runnable script lines', () => {
    const ledger = recorder.newLedger({ runResultId: 'rr-1', testCaseId: 'tc-1', scriptMode: 'passed_run_script' });

    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_click',
        args: { element: 'Save' },
        ok: true,
        actionLocator: {
          frameworkExpressions: {
            playwright: 'page.getByRole("button", { name: "Save" })',
          },
        },
      },
    });

    const lines = recorder.canonicalLines(ledger);
    expect(lines).toHaveLength(1);
    expect(lines[0].command.playwright).toContain('getByRole("button"');
    expect(lines[0].command.playwright).toContain('.click()');
    expect(lines[0].locatorStability).toBe('strong');
  });

  it('preserves ordinary inline values while keeping unreferenced secrets out of generated code', () => {
    const ledger = recorder.newLedger({ runResultId: 'rr-inline-values', testCaseId: 'tc-inline-values' });
    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_select_option',
        args: { element: 'Equipment', value: 'LTL' },
        ok: true,
        actionLocator: { frameworkExpressions: { playwright: 'page.getByLabel("Equipment")' } },
      },
    });
    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_fill',
        args: { element: 'Order Number', value: '007995145' },
        ok: true,
        actionLocator: { frameworkExpressions: { playwright: 'page.getByLabel("Order Number")' } },
      },
    });
    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_fill',
        args: { element: 'Password', value: 'must-not-leak' },
        ok: true,
        actionLocator: { frameworkExpressions: { playwright: 'page.getByLabel("Password")' } },
      },
    });

    const lines = recorder.canonicalLines(ledger);
    const spec = recorder.compileLedgerToPlaywrightSpec({ ledger });
    expect(lines[0]).toMatchObject({ literalValue: 'LTL', valueRef: null });
    expect(lines[1]).toMatchObject({ literalValue: '007995145', valueRef: null });
    expect(lines[2]).toMatchObject({ valueRef: 'QAAI_SECRET_VALUE' });
    expect(spec).toContain('selectOption("LTL")');
    expect(spec).toContain('fill("007995145")');
    expect(spec).toContain('runtimeValue("QAAI_SECRET_VALUE")');
    expect(spec).not.toContain('must-not-leak');
  });

  it('emits executable weak locator fallbacks instead of dropping actions', () => {
    const ledger = recorder.newLedger({ runResultId: 'rr-2', testCaseId: 'tc-2' });

    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_click',
        args: { element: 'Continue button' },
        ok: true,
      },
    });

    const [line] = recorder.canonicalLines(ledger);
    expect(line.command.concrete).toBe(true);
    expect(line.command.playwright).toContain("getByRole('button'");
    expect(line.locatorStability).toBe('weak');
    expect(ledger.health.scriptHealth).toBe('generated_with_weak_locators');
  });

  it('records locator health using action-time ranking rules', () => {
    const ledger = recorder.newLedger({ runResultId: 'rr-locators', testCaseId: 'tc-locators' });

    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_click',
        args: { element: 'Save user' },
        ok: true,
        actionLocator: {
          strategy: 'testId',
          frameworkExpressions: { playwright: 'page.getByTestId("save-user")' },
        },
      },
    });
    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_type',
        args: { element: 'Search field', valueRef: 'data:search' },
        ok: true,
        actionLocator: {
          strategy: 'placeholder',
          frameworkExpressions: { playwright: 'page.getByPlaceholder("Search")' },
        },
      },
    });
    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_click',
        args: { element: 'Second row action' },
        ok: true,
        actionLocator: {
          strategy: 'css',
          frameworkExpressions: { playwright: 'page.locator("tbody tr:nth-child(2) button")' },
        },
      },
    });

    const lines = recorder.canonicalLines(ledger);
    expect(lines[0].locatorStability).toBe('strong');
    expect(lines[0].locatorSource).toBe('testid');
    expect(lines[1].locatorStability).toBe('medium');
    expect(lines[1].locatorSource).toBe('placeholder');
    expect(lines[2].locatorStability).toBe('weak');
    expect(lines[2].locatorWarnings).toContain('structural_position_selector');
    expect(ledger.health.locatorStability).toBe('weak');
    expect(ledger.health.missingStableLocatorCount).toBe(2);
  });

  it('downgrades dynamic and duplicate locator evidence without dropping executable commands', () => {
    const weakUuid = recorder.assessLocatorHealth('page.locator("#user-550e8400-e29b-41d4-a716-446655440000")');
    expect(weakUuid.locatorStability).toBe('weak');
    expect(weakUuid.locatorWarnings).toContain('dynamic_uuid');

    const generatedClass = recorder.assessLocatorHealth('page.locator(".css-1abcde9")');
    expect(generatedClass.locatorStability).toBe('weak');
    expect(generatedClass.locatorWarnings).toContain('generated_class_like_selector');

    const duplicate = recorder.assessLocatorHealth('page.getByRole("button", { name: "Save" })', {
      strategy: 'role_name',
      proof: { count: 2, visible: true },
    });
    expect(duplicate.locatorStability).toBe('weak');
    expect(duplicate.locatorWarnings).toContain('hidden_or_duplicate_matches');
  });

  it('attaches utility actions as metadata instead of standalone script lines', () => {
    const ledger = recorder.newLedger({ runResultId: 'rr-3', testCaseId: 'tc-3' });

    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_navigate',
        args: { url: 'https://example.test' },
        ok: true,
      },
    });
    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_snapshot',
        args: { element: 'debug scan' },
        ok: true,
      },
    });

    expect(recorder.canonicalLines(ledger)).toHaveLength(1);
    expect(ledger.utilityMetadata).toHaveLength(1);
    expect(ledger.utilityMetadata[0].attachedToScriptLineId).toBe(recorder.canonicalLines(ledger)[0].id);
  });

  it('decomposes browser_fill_form into per-field script lines', () => {
    const ledger = recorder.newLedger({ runResultId: 'rr-4', testCaseId: 'tc-4' });

    recorder.appendScriptLine(ledger, {
      trailEntry: {
        tool: 'browser_fill_form',
        args: {
          fields: [
            {
              label: 'Email Address',
              valueRef: 'data:login_email',
              actionLocator: { frameworkExpressions: { playwright: 'page.getByLabel("Email Address")' } },
            },
            {
              label: 'Password',
              valueRef: 'secret:login_password',
              actionLocator: { frameworkExpressions: { playwright: 'page.getByLabel("Password")' } },
            },
          ],
        },
        ok: true,
      },
    });

    const lines = recorder.canonicalLines(ledger);
    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe('fill');
    expect(lines[1].kind).toBe('fill');
    expect(lines[0].command.playwright).toContain('runtimeValue("QAAI_DATA_LOGIN_EMAIL")');
    expect(lines[1].command.playwright).toContain('runtimeValue("QAAI_SECRET_LOGIN_PASSWORD")');
  });

  it('keeps evaluated failed assertions as canonical failure boundaries', () => {
    const ledger = recorder.newLedger({ runResultId: 'rr-5', testCaseId: 'tc-5', scriptMode: 'failed_run_script' });

    recorder.appendScriptLine(ledger, {
      kind: 'assert',
      trailEntry: {
        tool: 'assertion_check',
        args: { expectedText: 'Active 61', actualText: 'Active 62' },
        ok: false,
      },
    });

    const [line] = recorder.canonicalLines(ledger);
    expect(line).toBeTruthy();
    expect(line.kind).toBe('assert');
    expect(line.failureBoundary.expected).toBe('Active 61');
    expect(line.failureBoundary.actual).toBe('Active 62');
    expect(ledger.health.reproducesRunFailure).toBe(true);
    expect(recorder.compileLedgerToPlaywrightSpec({ ledger })).toContain('Active 61');
  });

  it('prefers persisted RunResult-backed live ledgers over reconstructed evidence', () => {
    const persisted = recorder.newLedger({
      runResultId: 'shadow',
      testCaseId: 'tc-persisted',
      scriptMode: 'failed_run_script',
    });
    recorder.appendScriptLine(persisted, {
      trailEntry: {
        tool: 'browser_click',
        args: { element: 'Persisted action button' },
        ok: true,
      },
    });

    const loaded = recorder.buildLedgerFromResult({
      runResultId: 'rr-persisted',
      testCaseId: 'tc-persisted',
      status: 'failed',
      captureFirstEvidence: {
        evidenceCompleteness: {
          liveScriptLedger: persisted,
        },
        actionEvidences: [],
      },
    });

    const [line] = recorder.canonicalLines(loaded);
    expect(loaded.runResultId).toBe('rr-persisted');
    expect(line.runResultId).toBe('rr-persisted');
    expect(line.label).toBe('Persisted action button');
  });

  it('keeps plan-shaped synthesized ReplayIR diagnostic instead of making it canonical', () => {
    const warning = 'QAAI could not fetch this locator from the live DOM; replace it with a reliable DOM locator when available.';
    const ledger = recorder.buildLedgerFromResult({
      runResultId: 'rr-semantic-replay',
      testCaseId: 'tc-semantic-replay',
      status: 'failed',
      envelope: {
        ir: {
          steps: [
            {
              op: 'resolve',
              as: 'el2',
              guessedLocator: true,
              locatorConfidence: 'guessed',
              locatorProvenance: {
                kind: 'qaai_guessed_locator',
                semanticLabel: 'Sign in with Microsoft button',
                chosenExpression: 'getByRole("button", { name: "Sign in with Microsoft" })',
                warning,
              },
            },
            {
              op: 'act',
              action: 'click',
              target: 'el2',
              contractStepId: 'step-sign-in',
              dependsOnStepIds: ['step-continue'],
              synthesizedFromContract: true,
            },
          ],
        },
      },
    });

    expect(recorder.canonicalLines(ledger)).toEqual([]);
    const line = ledger.lines.find((candidate) => candidate.kind === 'click');
    expect(line).toMatchObject({
      label: 'Sign in with Microsoft button',
      locatorExpression: 'page.getByRole("button", { name: "Sign in with Microsoft" })',
      contractStepId: 'step-sign-in',
      locatorGuessed: true,
      locatorFallbackUsed: true,
      locatorFallbackReason: 'qaai_guessed_locator',
      locatorProvenance: expect.objectContaining({ kind: 'qaai_guessed_locator', warning }),
      metadata: expect.objectContaining({
        dependsOnStepIds: ['step-continue'],
        synthesizedFromContract: true,
        diagnosticOnly: true,
        executable: false,
        diagnosticReason: 'contract_synthesis_without_execution_proof',
      }),
    });
    expect(line.label).not.toBe('el2');
    expect(line.locatorExpression).not.toContain('getByText("el2")');
  });

  it('preserves a persisted live ledger without backfilling unexecuted ReplayIR plan steps', () => {
    const partial = recorder.newLedger({ runResultId: 'shadow', testCaseId: 'tc-partial' });
    recorder.appendScriptLine(partial, {
      contractStepId: 'step-email',
      trailEntry: {
        tool: 'browser_fill',
        contractStepId: 'step-email',
        args: { element: 'Email address', valueRef: 'env:LOGIN_EMAIL' },
        actionLocator: { frameworkExpressions: { playwright: 'page.getByTestId("login-email")' } },
        ok: true,
      },
    });

    const ledger = recorder.buildLedgerFromResult({
      runResultId: 'rr-partial-merge',
      testCaseId: 'tc-partial',
      status: 'failed',
      liveScriptLedger: partial,
      envelope: {
        ir: {
          steps: [
            { op: 'resolve', as: 'email', elementLabel: 'Email address', guessedLocator: true, candidates: [{ strategy: 'label', text: 'Email address' }] },
            { op: 'act', action: 'fill', target: 'email', valueRef: 'env:LOGIN_EMAIL', contractStepId: 'step-email' },
            { op: 'resolve', as: 'next', elementLabel: 'Next button', guessedLocator: true, candidates: [{ strategy: 'role', role: 'button', name: 'Next' }] },
            { op: 'act', action: 'click', target: 'next', contractStepId: 'step-next', dependsOnStepIds: ['step-email'], synthesizedFromContract: true },
            { op: 'waitFor', condition: { kind: 'visible', target: 'next', timeoutMs: 5000 }, contractStepId: 'step-ready', dependsOnStepIds: ['step-next'] },
            { op: 'assert', channel: 'UI_TEXT', target: 'next', expected: 'Ready', contractStepId: 'step-assert', dependsOnStepIds: ['step-ready'] },
          ],
        },
      },
    });

    const lines = recorder.canonicalLines(ledger);
    expect(lines.map((line) => line.contractStepId)).toEqual(['step-email']);
    expect(lines.map((line) => line.kind)).toEqual(['fill']);
    expect(lines[0].locatorExpression).toBe('page.getByTestId("login-email")');
    expect(lines[0].locatorGuessed).toBe(false);
  });

  it('merges repeated same-kind action evidence only by immutable occurrence identity', () => {
    const occurrence = (ordinal) => `rr-occurrence:tc-occurrence:save:${ordinal}`;
    const evidence = (ordinal, testId) => ({
      id: `evidence-${ordinal}`,
      runResultId: 'rr-occurrence',
      testCaseId: 'tc-occurrence',
      contractStepId: 'save-account',
      actionOccurrenceId: occurrence(ordinal),
      occurrenceKey: occurrence(ordinal),
      toolName: 'browser_click',
      status: 'passed',
      locatorRecipe: {
        primaryExpression: `page.getByTestId("${testId}")`,
        frameworkExpressions: { playwright: `page.getByTestId("${testId}")` },
        proof: { count: 1, sameElement: true, identityVerified: true },
      },
      evidenceJson: JSON.stringify({
        ok: true,
        target: `Save account ${ordinal}`,
        actionOccurrenceId: occurrence(ordinal),
        occurrenceKey: occurrence(ordinal),
      }),
    });
    const replayAct = (ordinal) => ({
      op: 'act',
      action: 'click',
      target: `save${ordinal}`,
      contractStepId: 'save-account',
      actionOccurrenceId: occurrence(ordinal),
      occurrenceKey: occurrence(ordinal),
      origin: 'runtime_evidence',
      canonicalExecution: true,
      status: 'passed',
    });
    const replayResolve = (ordinal) => ({
      op: 'resolve',
      as: `save${ordinal}`,
      contractStepId: 'save-account',
      actionOccurrenceId: occurrence(ordinal),
      occurrenceKey: occurrence(ordinal),
      elementLabel: `Save account ${ordinal}`,
      candidates: [{ strategy: 'testId', testId: `replay-save-${ordinal}` }],
    });

    const ledger = recorder.buildLedgerFromResult({
      runResultId: 'rr-occurrence',
      testCaseId: 'tc-occurrence',
      status: 'passed',
      captureFirstEvidence: {
        actionEvidences: [evidence(2, 'captured-save-two'), evidence(1, 'captured-save-one')],
      },
      envelope: {
        ir: {
          steps: [replayResolve(1), replayAct(1), replayResolve(2), replayAct(2)],
        },
      },
    });

    const lines = recorder.canonicalLines(ledger).filter((line) => line.kind === 'click');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      actionOccurrenceId: occurrence(1),
      locatorExpression: 'page.getByTestId("captured-save-one")',
    });
    expect(lines[1]).toMatchObject({
      actionOccurrenceId: occurrence(2),
      locatorExpression: 'page.getByTestId("captured-save-two")',
    });
  });

  it('never treats source occurrence ancestry as the child occurrence identity', () => {
    const parentOccurrence = 'rr-lineage:tc-lineage:parent';
    const childOccurrence = 'rr-lineage:tc-lineage:child';
    const ledger = recorder.buildLedgerFromResult({
      runResultId: 'rr-lineage',
      testCaseId: 'tc-lineage',
      status: 'passed',
      captureFirstEvidence: {
        actionEvidences: [{
          id: 'child-evidence',
          runResultId: 'rr-lineage',
          testCaseId: 'tc-lineage',
          contractStepId: 'shared-click',
          actionOccurrenceId: childOccurrence,
          sourceActionOccurrenceId: parentOccurrence,
          occurrenceKey: childOccurrence,
          toolName: 'browser_click',
          status: 'passed',
          locatorRecipe: {
            primaryExpression: 'page.getByTestId("child-button")',
            frameworkExpressions: { playwright: 'page.getByTestId("child-button")' },
          },
          evidenceJson: JSON.stringify({ ok: true, target: 'Child button' }),
        }],
      },
      envelope: {
        ir: {
          steps: [
            {
              op: 'resolve', as: 'parentButton', contractStepId: 'shared-click',
              actionOccurrenceId: parentOccurrence, occurrenceKey: parentOccurrence,
              elementLabel: 'Parent button',
              candidates: [{ strategy: 'testId', testId: 'parent-button' }],
            },
            {
              op: 'act', action: 'click', target: 'parentButton', contractStepId: 'shared-click',
              actionOccurrenceId: parentOccurrence, occurrenceKey: parentOccurrence,
              origin: 'runtime_evidence', canonicalExecution: true, status: 'passed',
            },
          ],
        },
      },
    });

    const parent = recorder.canonicalLines(ledger).find(
      (line) => line.actionOccurrenceId === parentOccurrence,
    );
    expect(parent.locatorExpression).toBe('page.getByTestId("parent-button")');
    expect(parent.source).toBe('ReplayIR');
  });

  it('canonicalizes ActionEvidence only with explicit successful execution proof', () => {
    const successfulStatuses = ['passed', 'pass', 'success', 'succeeded', 'completed', 'complete', 'ok'];
    const rejectedStatuses = ['blocked', 'skipped', 'cancelled', 'error', 'unknown'];
    const actionEvidences = [
      ...successfulStatuses.map((status, index) => ({
        runResultId: 'rr-action-status',
        testCaseId: 'tc-action-status',
        toolName: 'browser_click',
        status,
        evidenceJson: JSON.stringify({ target: `Successful ${index + 1}` }),
      })),
      {
        runResultId: 'rr-action-status',
        testCaseId: 'tc-action-status',
        toolName: 'browser_click',
        evidenceJson: JSON.stringify({ target: 'Explicit ok', ok: true }),
      },
      {
        runResultId: 'rr-action-status',
        testCaseId: 'tc-action-status',
        toolName: 'browser_click',
        evidenceJson: JSON.stringify({ target: 'Explicit success', success: true }),
      },
      ...rejectedStatuses.map((status, index) => ({
        runResultId: 'rr-action-status',
        testCaseId: 'tc-action-status',
        toolName: 'browser_click',
        status,
        evidenceJson: JSON.stringify({ target: `Rejected ${index + 1}` }),
      })),
      {
        runResultId: 'rr-action-status',
        testCaseId: 'tc-action-status',
        toolName: 'browser_click',
        evidenceJson: JSON.stringify({ target: 'Missing outcome' }),
      },
    ];

    const ledger = recorder.buildLedgerFromResult({
      runResultId: 'rr-action-status',
      testCaseId: 'tc-action-status',
      captureFirstEvidence: { actionEvidences },
    });

    expect(recorder.canonicalLines(ledger)).toHaveLength(successfulStatuses.length + 2);
    expect(ledger.lines.filter((line) => line.source === 'ActionEvidence' && line.metadata.diagnosticOnly)).toHaveLength(rejectedStatuses.length + 1);
  });

  it('requires capture evidence rows to carry the current run and case scope', () => {
    const row = (overrides = {}) => ({
      runResultId: 'rr-scope',
      testCaseId: 'tc-scope',
      toolName: 'browser_click',
      status: 'passed',
      evidenceJson: JSON.stringify({ target: 'Scoped action' }),
      ...overrides,
    });
    const ledger = recorder.buildLedgerFromResult({
      runResultId: 'rr-scope',
      testCaseId: 'tc-scope',
      captureFirstEvidence: {
        actionEvidences: [
          row(),
          row({ runResultId: undefined }),
          row({ testCaseId: undefined }),
          row({ runResultId: 'rr-other' }),
          row({ testCaseId: 'tc-other' }),
        ],
      },
    });

    expect(recorder.canonicalLines(ledger)).toHaveLength(1);
    expect(ledger.lines).toHaveLength(1);
  });

  it('does not claim a locator recipe is verified from sequence-only association', () => {
    const ledger = recorder.buildLedgerFromResult({
      runResultId: 'rr-sequence-only',
      testCaseId: 'tc-sequence-only',
      captureFirstEvidence: {
        locatorRecipes: [{
          id: 'recipe-unbound',
          runResultId: 'rr-sequence-only',
          testCaseId: 'tc-sequence-only',
          sequenceIndex: 1,
          locatorRecipeJson: JSON.stringify({
            primaryExpression: 'page.getByTestId("wrong-sequence-match")',
          }),
        }],
        actionEvidences: [{
          id: 'evidence-unbound',
          runResultId: 'rr-sequence-only',
          testCaseId: 'tc-sequence-only',
          sequenceIndex: 1,
          toolName: 'browser_click',
          status: 'passed',
          evidenceJson: JSON.stringify({ ok: true, target: 'Continue' }),
        }],
      },
    });

    const line = recorder.canonicalLines(ledger)[0];
    expect(line.locatorExpression).not.toContain('wrong-sequence-match');
    expect(line.locatorProvenance?.verified).not.toBe(true);
    expect(line.locatorProvenance?.actionTimeResolved).not.toBe(true);
  });

  it('canonicalizes only evaluated AssertionEvidence and keeps unknown assertions diagnostic', () => {
    const base = {
      runResultId: 'rr-assertions',
      testCaseId: 'tc-assertions',
      expectedJson: JSON.stringify('Expected text'),
    };
    const ledger = recorder.buildLedgerFromResult({
      runResultId: 'rr-assertions',
      testCaseId: 'tc-assertions',
      captureFirstEvidence: {
        assertionEvidences: [
          { ...base, assertionId: 'matched-pass', matched: true },
          { ...base, assertionId: 'matched-fail', matched: false, actualJson: JSON.stringify('Other text') },
          { ...base, assertionId: 'status-pass', status: 'passed' },
          { ...base, assertionId: 'unknown' },
        ],
      },
    });

    const canonical = recorder.canonicalLines(ledger);
    expect(canonical).toHaveLength(3);
    expect(canonical.find((line) => line.failureBoundary)).toMatchObject({
      metadata: expect.objectContaining({ assertionEvaluated: true, assertionPassed: false }),
    });
    expect(ledger.lines.find((line) => line.metadata.evidenceOutcome === 'unknown')).toMatchObject({
      canonical: false,
      metadata: expect.objectContaining({ diagnosticOnly: true, assertionEvaluated: false }),
    });
  });

  it('keeps plan-only ReplayIR noncanonical but preserves positively executed runtime ReplayIR', () => {
    const ledger = recorder.buildLedgerFromResult({
      runResultId: 'rr-replay-proof',
      testCaseId: 'tc-replay-proof',
      envelope: {
        ir: {
          steps: [
            { op: 'resolve', as: 'planned', elementLabel: 'Planned action' },
            { op: 'act', action: 'click', target: 'planned', origin: 'authored_contract_recovery', synthesizedFromContract: true },
            { op: 'resolve', as: 'executed', elementLabel: 'Executed action', candidates: [{ strategy: 'role', role: 'button', name: 'Execute' }] },
            {
              op: 'act',
              action: 'click',
              target: 'executed',
              canonicalExecution: true,
              executionStatus: 'completed',
              synthesizedFromContract: true,
            },
            {
              op: 'waitFor',
              condition: { kind: 'visible', target: 'executed' },
              captureEvidenceHydrated: true,
              status: 'passed',
            },
          ],
        },
      },
    });

    expect(recorder.canonicalLines(ledger).map((line) => line.kind)).toEqual(['click', 'waitFor']);
    expect(ledger.lines.find((line) => line.label === 'Planned action')).toMatchObject({
      canonical: false,
      metadata: expect.objectContaining({ diagnosticOnly: true }),
    });
  });
});
