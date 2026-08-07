const replayEmitter = require('../../server/services/codegen/replayEmitter');
const replayExport = require('../../server/services/codegen/replayExport');
const pageObjectRepository = require('../../server/services/codegen/pageObjectRepository');
const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom');
const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs');
const playwrightReference = require('../../server/services/codegen/adapters/playwrightReference');

describe('guessed locator completion contract', () => {
  test('removes internal and positional action locators before export', () => {
    const result = {
      envelope: {
        complete: false,
        ir: {
          caseId: 'semantic-locator-sanitization',
          authProfile: { id: 'default', strategy: 'none', disposition: 'bypass_fixture' },
          steps: [
            {
              op: 'resolve',
              as: 'el2',
              elementLabel: 'Continue',
              actionLocator: { expression: 'page.getByText("el2").nth(1)' },
              candidates: [{ strategy: 'text', text: 'el2', expression: 'page.getByText("el2")' }],
            },
            { op: 'act', action: 'click', target: 'el2', targetLabel: 'Continue' },
          ],
          verdict: { status: 'fail', perAssertionOutcomes: [] },
        },
      },
    };

    replayExport.completeReplayIrLocators(result);
    const serialized = JSON.stringify(result.envelope.ir);
    const resolve = result.envelope.ir.steps.find((step) => step.op === 'resolve');
    expect(serialized).not.toMatch(/getByText.*el2|\.nth\(/i);
    expect(resolve.guessedLocator).toBe(true);
    expect(resolve.elementLabel).toBe('Continue');
    expect(resolve.locatorProvenance.warning).toMatch(/guessed/i);
  });

  test('keeps a clean semantic candidate when a UUID action locator is discarded', () => {
    const result = {
      envelope: {
        complete: false,
        ir: {
          caseId: 'uuid-locator-sanitization',
          authProfile: { id: 'default', strategy: 'none', disposition: 'bypass_fixture' },
          steps: [
            {
              op: 'resolve',
              as: 'saveControl',
              elementLabel: 'Save user',
              actionLocator: { expression: 'page.locator("#8f14e45f-ea2f-4c21-9f13-7dbe22391abc")' },
              candidates: [{ strategy: 'role', role: 'button', name: 'Save user' }],
            },
            { op: 'act', action: 'click', target: 'saveControl', targetLabel: 'Save user' },
          ],
          verdict: { status: 'pass', perAssertionOutcomes: [] },
        },
      },
    };

    replayExport.completeReplayIrLocators(result);
    const resolve = result.envelope.ir.steps.find((step) => step.op === 'resolve');
    expect(resolve).not.toHaveProperty('actionLocator');
    expect(resolve.candidates).toEqual([expect.objectContaining({ strategy: 'role', role: 'button', name: 'Save user' })]);
    expect(resolve.guessedLocator).not.toBe(true);
  });

  test('preserves a failed locator action as diagnostics without emitting a guessed POM locator', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'case-guessed-click',
      title: 'Submit an order',
      trail: [{
        tool: 'browser_click',
        ok: false,
        pageUrl: 'https://example.test/checkout',
        args: { element: 'Submit order button', role: 'button' },
        actionLocatorGap: { code: 'missing_verified_action_locator', strategiesTried: ['snapshot_ref', 'targeted_ref_excavation'] },
      }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'fail',
    });

    const resolve = emitted.ir.steps.find((step) => step.op === 'resolve');
    const act = emitted.ir.steps.find((step) => step.op === 'act' && step.action === 'click');
    expect(emitted.complete).toBe(true);
    expect(resolve.guessedLocator).toBe(true);
    expect(resolve.locatorProvenance.kind).toBe('qaai_guessed_locator');
    expect(resolve.locatorProvenance.chosenExpression).toMatch(/getBy(?:Role|Label|Text)|locator/);
    expect(act.target).toBe(resolve.as);

    const repo = pageObjectRepository.buildLocatorRepository({ cases: [{ ir: emitted.ir }] });
    expect(repo.files).toEqual({});
    expect(repo.manifest).toEqual([]);
    expect(repo.diagnostics).toEqual([
      expect.objectContaining({
        as: resolve.as,
        executable: false,
        diagnosticOnly: true,
        reason: 'semantic_or_narrative_guess',
      }),
    ]);
  });

  test('preserves every field in a form when none of the locators were captured', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'case-guessed-form',
      title: 'Enter identity details',
      trail: [{
        tool: 'browser_fill_form',
        ok: false,
        args: {
          fields: [
            { name: 'Email', type: 'textbox', value: 'person@example.test' },
            { name: 'Password', type: 'textbox', value: 'secret-ref' },
          ],
        },
      }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'fail',
    });

    expect(emitted.complete).toBe(true);
    expect(emitted.ir.steps.filter((step) => step.op === 'resolve')).toHaveLength(2);
    expect(emitted.ir.steps.filter((step) => step.op === 'act' && step.action === 'fill')).toHaveLength(2);
    expect(emitted.ir.steps.filter((step) => step.op === 'resolve').every((step) => step.guessedLocator === true)).toBe(true);
  });

  test('preserves a standalone key press using the focused-element fallback', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'case-guessed-press',
      title: 'Submit with Enter',
      trail: [{ tool: 'browser_press_key', ok: false, args: { key: 'Enter' } }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'fail',
    });
    const resolve = emitted.ir.steps.find((step) => step.op === 'resolve');
    const press = emitted.ir.steps.find((step) => step.op === 'act' && step.action === 'press');
    expect(resolve.candidates).toContainEqual(expect.objectContaining({ strategy: 'css', selector: ':focus' }));
    expect(press.rawValue).toBe('Enter');
  });

  test('keeps unexecuted dependent contract steps diagnostic instead of synthesizing methods and calls', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'case-contract-reconcile',
      title: 'Complete checkout',
      trail: [],
      caseContractV1: {
        steps: [
          { id: 'step-1', ordinal: 1, type: 'Fill', text: 'Fill Email textbox', dataRefs: ['email'], dependsOn: [] },
          { id: 'step-2', ordinal: 2, type: 'Click', text: 'Click Continue button', dependsOn: ['step-1'] },
          { id: 'step-3', ordinal: 3, type: 'Wait', text: 'Wait for Password textbox', dependsOn: ['step-2'] },
        ],
      },
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'fail',
    });
    expect(emitted.complete).toBe(false);
    expect(emitted.ir.steps).toEqual([]);
    expect(emitted.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'planned_step_not_executed', where: 'step-1' }),
      expect.objectContaining({ code: 'planned_step_not_executed', where: 'step-2' }),
      expect.objectContaining({ code: 'planned_step_not_executed', where: 'step-3' }),
    ]));
  });

  test('keeps identity-free runtime actions as evidence when authored contract ids are authoritative', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'case-partial-contract',
      title: 'Continue checkout',
      trail: [{
        tool: 'browser_click',
        ok: true,
        args: { element: 'Continue button', role: 'button' },
      }],
      caseContractV1: {
        steps: [
          { id: 'step-1', type: 'Click', text: 'Click Continue button', dependsOn: [] },
          { id: 'step-2', type: 'Fill', text: 'Fill Password textbox', dependsOn: ['step-1'] },
        ],
      },
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'fail',
    });

    const clicks = emitted.ir.steps.filter((step) => step.op === 'act' && step.action === 'click');
    const fills = emitted.ir.steps.filter((step) => step.op === 'act' && step.action === 'fill');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ origin: 'unbound_runtime_evidence', evidenceOnly: false });
    expect(clicks[0].contractStepId).toBeUndefined();
    expect(fills).toEqual([]);
    expect(emitted.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'planned_step_not_executed', where: 'step-1' }),
      expect.objectContaining({ code: 'planned_step_not_executed', where: 'step-2' }),
      expect.objectContaining({ code: 'runtime_operation_without_authored_match' }),
    ]));

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([
      { caseName: emitted.ir.title, ir: emitted.ir },
    ])[0];
    expect(prepared.ir.steps.filter((step) => step.op === 'act')).toEqual([]);
    expect(prepared.ir.runtimeEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        diagnosticOnly: true,
        executable: false,
        origin: 'unbound_runtime_evidence',
        locatorProvenance: expect.objectContaining({ kind: 'qaai_guessed_locator' }),
      }),
    ]));
  });

  test('keeps foreign runtime step ids under their runtime identity without synthesizing an authored duplicate', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'case-foreign-contract-id',
      title: 'Continue checkout',
      trail: [{
        tool: 'browser_click',
        ok: true,
        contractStepId: 'runtime-attempt-77',
        args: { element: 'Continue button', role: 'button' },
      }],
      caseContractV1: {
        steps: [
          { id: 'case_step_1', type: 'Click', text: 'Click Continue button', dependsOn: [] },
        ],
      },
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'fail',
    });

    const clicks = emitted.ir.steps.filter((step) => step.op === 'act' && step.action === 'click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({
      contractStepId: 'runtime-attempt-77',
      origin: 'runtime_evidence',
      evidenceOnly: false,
    });
    expect(clicks.some((step) => step.contractStepId === 'case_step_1')).toBe(false);
    expect(emitted.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'planned_step_not_executed', where: 'case_step_1' }),
      expect.objectContaining({
        code: 'runtime_operation_without_authored_match',
        where: 'runtime-attempt-77',
      }),
    ]));
  });

  test('does not fabricate root navigation when an authored destination has no URL evidence', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'case-semantic-navigation',
      title: 'Open user management',
      trail: [],
      caseContractV1: {
        steps: [
          { id: 'step-open-users', type: 'Navigate', text: 'Navigate to User Management page', dependsOn: [] },
        ],
      },
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'fail',
    });

    const navigations = emitted.ir.steps.filter((step) => step.op === 'act' && step.action === 'navigate');
    expect(navigations.some((step) => step.url === '/')).toBe(false);
    expect(emitted.ir.steps).toEqual([]);
    expect(emitted.findings.map((finding) => finding.rule || finding.code))
      .toContain('planned_step_not_executed');
    expect(emitted.findings).toContainEqual(expect.objectContaining({
      code: 'planned_step_not_executed',
      where: 'step-open-users',
    }));
  });

  test('preserves inferred popup destinations as non-authored observed context without inventing navigation', () => {
    const step = {
      op: 'act',
      action: 'navigate',
      url: 'https://example.test/popup',
      contextSwitchInferred: true,
      transitionKind: 'popup_context',
      authored: false,
    };
    const lines = [
      playwrightPom._pomEmitAct(step, new Map(), false, 'click', new Map(), null),
      playwrightReference.emitStep(step, [], {}),
    ];
    for (const line of lines) {
      expect(line).toContain('popup/new-tab context switch');
      expect(line).toContain('qaai-observed-popup');
      expect(line).toContain('page.waitForURL');
      expect(line).not.toContain('page.goto');
    }
  });
});
