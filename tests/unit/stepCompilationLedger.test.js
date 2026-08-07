import { describe, expect, it } from 'vitest';
import ledger from '../../server/services/codegen/stepCompilationLedger.js';
import replayEmitter from '../../server/services/codegen/replayEmitter.js';

const TARGETLESS = new Set(['navigate', 'navigateBack', 'navigateForward', 'reload', 'handleDialog', 'resize', 'close']);
const ADAPTERS = [
  'playwright-reference',
  'playwright-pom',
  'selenium-reference',
  'selenium-pom',
  'replayir-bdd',
  'selenium-bdd-reference',
];

function replaySteps(action, contractStepId = 'step-1', { alias = 'el1', label = 'Target', role = 'button' } = {}) {
  const act = { op: 'act', action, contractStepId, targetRef: contractStepId };
  if (action === 'navigate') act.url = 'https://example.test/start';
  if (TARGETLESS.has(action)) return [act];
  act.target = alias;
  if (action === 'drag') act.destinationTarget = 'el2';
  return [
    {
      op: 'resolve',
      as: alias,
      candidates: [{ strategy: 'role', role, name: label }],
      contractStepId,
      targetRef: contractStepId,
    },
    ...(action === 'drag'
      ? [{
        op: 'resolve',
        as: 'el2',
        candidates: [{ strategy: 'role', role: 'button', name: 'Destination' }],
        contractStepId,
        targetRef: contractStepId,
      }]
      : []),
    act,
  ];
}

function resultFor(action, options = {}) {
  const id = options.contractStepId || 'step-1';
  return {
    testCaseId: options.testCaseId || 'TC-1',
    runResultId: options.runResultId || 'RR-1',
    caseName: options.caseName || action,
    declaredSteps: options.declaredSteps === undefined
      ? [{ id, action, target: 'Target', text: `${action} Target` }]
      : options.declaredSteps,
    envelope: {
      findings: [],
      ir: {
        steps: options.steps || replaySteps(action, id, options.resolveOptions),
      },
    },
  };
}

function targetlessProof(action, selenium = false) {
  if (selenium) {
    return {
      navigate: 'driver.get("https://example.test/start");',
      navigateBack: 'driver.navigate().back();',
      navigateForward: 'driver.navigate().forward();',
      reload: 'driver.navigate().refresh();',
      handleDialog: 'driver.switchTo().alert().accept();',
      resize: 'driver.manage().window().setSize(new Dimension(1280, 720));',
      close: 'driver.close();',
    }[action];
  }
  return {
    navigate: 'await page.goto("/start");',
    navigateBack: 'await page.goBack();',
    navigateForward: 'await page.goForward();',
    reload: 'await page.reload();',
    handleDialog: 'page.once("dialog", dialog => dialog.accept());',
    resize: 'await page.setViewportSize({ width: 1280, height: 720 });',
    close: 'await page.close();',
  }[action];
}

function bddProof(action) {
  return {
    navigate: 'Given I open "https://example.test/start"',
    navigateBack: 'When I go back',
    navigateForward: 'When I go forward',
    reload: 'When I reload the page',
    click: 'When I click "Target"',
    doubleClick: 'When I double-click "Target"',
    tripleClick: 'When I triple-click "Target"',
    fill: 'When I fill "Target" with "QAAI_VALUE"',
    type: 'When I fill "Target" with "QAAI_VALUE"',
    selectOption: 'When I select option "QAAI_VALUE" in "Target"',
    check: 'When I check "Target"',
    uncheck: 'When I uncheck "Target"',
    press: 'When I press "Enter"',
    hover: 'When I hover "Target"',
    drag: 'When I drag "Target" to "Destination"',
    upload: 'When I upload "QAAI_FILE" to "Target"',
    waitFor: 'Then I wait for "Target"',
    handleDialog: 'When I accept the dialog',
    resize: 'When I resize the viewport to 1280 by 720',
    close: 'When I close the page',
  }[action];
}

function playwrightPrimitive(action) {
  return {
    fill: 'await targetButton.fill("value");',
    type: 'await targetButton.fill("value");',
    click: 'await targetButton.click();',
    doubleClick: 'await targetButton.dblclick();',
    tripleClick: 'await targetButton.click({ clickCount: 3 });',
    selectOption: 'await targetButton.selectOption("value");',
    check: 'await targetButton.check();',
    uncheck: 'await targetButton.uncheck();',
    press: 'await targetButton.press("Enter");',
    hover: 'await targetButton.hover();',
    drag: 'await targetButton.dragTo(destinationButton);',
    upload: 'await targetButton.setInputFiles("file.txt");',
    waitFor: 'await targetButton.waitFor({ state: "visible" });',
  }[action];
}

function seleniumPrimitive(action) {
  return {
    fill: 'el1.clear();',
    type: 'el1.clear();',
    click: 'el1.click();',
    doubleClick: 'new Actions(driver).doubleClick(el1).perform();',
    tripleClick: 'new Actions(driver).click(el1).click(el1).click(el1).perform();',
    selectOption: 'new Select(el1).selectByVisibleText("value");',
    check: 'if (!el1.isSelected()) el1.click();',
    uncheck: 'if (el1.isSelected()) el1.click();',
    press: 'el1.sendKeys(Keys.ENTER);',
    hover: 'new Actions(driver).moveToElement(el1).perform();',
    drag: 'new Actions(driver).dragAndDrop(el1, el2).perform();',
    upload: 'el1.sendKeys("file.txt");',
    waitFor: 'wait.until(ExpectedConditions.visibilityOf(el1));',
  }[action];
}

function proofFor(adapterId, action) {
  if (adapterId.includes('bdd')) return bddProof(action);
  if (TARGETLESS.has(action)) return targetlessProof(action, adapterId.startsWith('selenium'));
  if (adapterId === 'playwright-reference') return playwrightPrimitive(action);
  if (adapterId === 'selenium-reference') return seleniumPrimitive(action);
  const method = ledger._methodNameFor(action, 'targetButton');
  return adapterId === 'selenium-pom'
    ? `page.${method}();`
    : `await page.${method}();`;
}

function compile({ adapterId, result, source, file = 'generated.spec', extraFiles = {} }) {
  return ledger.buildStepCompilationLedger({
    results: [result],
    admitted: [{ testCaseId: result.testCaseId, filePath: file }],
    blocked: [],
    files: { [file]: `${source}\n`, ...extraFiles },
    adapterId,
  });
}

describe('stepCompilationLedger action parity', () => {
  it('tracks exactly the actions emitted by replayEmitter.TOOL_ACTION', () => {
    const emitted = [...new Set(Object.values(replayEmitter.TOOL_ACTION))].sort();
    expect([...ledger.ACTION_VOCABULARY].sort()).toEqual(emitted);
    expect(emitted).toHaveLength(20);
  });

  it.each(ADAPTERS)('audits all 17 actions with adapter-aware concrete calls for %s', (adapterId) => {
    for (const action of ledger.ACTION_VOCABULARY) {
      const report = compile({
        adapterId,
        result: resultFor(action),
        source: proofFor(adapterId, action),
        file: adapterId.includes('bdd') ? 'case.feature' : 'case.spec',
      });
      const row = report.cases[0].ledger[0];
      expect(row.exportStatus, `${adapterId}:${action}`).toBe('exported');
      expect(row.status, `${adapterId}:${action}`).toBe('exported_direct');
      expect(row.exportedSpecLine, `${adapterId}:${action}`).toBe(1);
    }
  });

  it('does not treat comments or locator declarations as action proof', () => {
    const commentOnly = compile({
      adapterId: 'playwright-reference',
      result: resultFor('click'),
      source: [
        'const targetButton = page.getByRole("button", { name: "Target" }); // await targetButton.click();',
        '// await targetButton.click();',
      ].join('\n'),
    });
    expect(commentOnly.cases[0].ledger[0]).toMatchObject({
      exportStatus: 'held',
      status: 'requires_repair',
      exportedSpecLine: null,
    });

    const targetlessComment = compile({
      adapterId: 'replayir-bdd',
      result: resultFor('close'),
      source: '# When I close the page',
      file: 'case.feature',
    });
    expect(targetlessComment.cases[0].ledger[0]).toMatchObject({
      exportStatus: 'held',
      status: 'requires_repair',
      exportedSpecLine: null,
    });
  });

  it('keeps authored steps after an explicit runtime boundary diagnostic-only', () => {
    const result = resultFor('click', {
      declaredSteps: [
        { id: 'step-1', action: 'click', text: 'Click Start' },
        { id: 'step-2', action: 'fill', text: 'Fill Details' },
        { id: 'step-3', action: 'click', text: 'Click Save' },
      ],
    });
    result.envelope.ir.runtimeEvidence = [{
      kind: 'partial_run_boundary',
      failureBoundary: {
        code: 'partial_run_evidence_boundary',
        afterAuthoredStepNumber: 1,
        nextAuthoredStepNumber: 2,
      },
    }];

    const report = compile({
      adapterId: 'playwright-reference',
      result,
      source: 'await targetButton.click();',
    });

    expect(report.summary).toMatchObject({
      blockedInternal: 0,
      postBoundaryDiagnostic: 2,
    });
    expect(report.findings).toEqual([]);
    expect(report.cases[0].ledger.slice(1).map((row) => row.status)).toEqual([
      'diagnostic_only_post_boundary',
      'diagnostic_only_post_boundary',
    ]);

    delete result.envelope.ir.runtimeEvidence;
    const withoutBoundary = compile({
      adapterId: 'playwright-reference',
      result,
      source: 'await targetButton.click();',
    });
    expect(withoutBoundary.summary).toMatchObject({
      blockedInternal: 0,
      authoredIntentDiagnostic: 2,
    });
    expect(withoutBoundary.findings).toEqual([]);
    expect(withoutBoundary.cases[0].ledger.slice(1).map((row) => row.status)).toEqual([
      'diagnostic_only_authored_intent',
      'diagnostic_only_authored_intent',
    ]);
  });

  it('proves a repaired assertion through its unique final fixture binding', () => {
    const result = resultFor('click', {
      declaredSteps: [],
      steps: [{
        op: 'assert',
        channel: 'VALUE',
        contractStepId: 'assert-selection',
        contractRef: 'assert-selection',
        expected: 'Selected Option',
        authored: true,
        executed: true,
        executionStatus: 'evaluated',
        executionOutcome: 'succeeded',
        liveOutcome: 'matched',
      }],
    });
    const report = compile({
      adapterId: 'playwright-pom',
      result,
      source: [
        'await formPage.assertSelectionValue(',
        "  readData(row, 'selection'),",
        ');',
      ].join('\n'),
      file: 'tests/case.spec.js',
      extraFiles: {
        'tests/data/case.json': JSON.stringify([{ fields: { selection: 'Selected Option' } }]),
      },
    });
    expect(report.summary.blockedInternal).toBe(0);
    expect(report.cases[0].ledger[0]).toMatchObject({
      exportStatus: 'exported',
      status: 'exported_assertion_method',
      exportedPageMethod: 'assertSelectionValue',
      dataBinding: { column: 'selection' },
    });
  });

  it('keeps a failed replay-only runtime assertion diagnostic-only', () => {
    const result = resultFor('click', {
      declaredSteps: [],
      steps: [{
        op: 'assert',
        channel: 'UI_TEXT',
        contractRef: 'runtime.assertion.1',
        origin: 'runtime_evidence',
        authored: true,
        executionStatus: 'failed',
        liveOutcome: 'not_matched',
      }],
    });
    const report = compile({
      adapterId: 'playwright-pom',
      result,
      source: 'await page.waitForLoadState();',
      file: 'tests/case.spec.js',
    });
    expect(report.summary).toMatchObject({
      blockedInternal: 0,
      runtimeAssertionDiagnostic: 1,
    });
    expect(report.cases[0].ledger[0]).toMatchObject({
      exportStatus: 'diagnostic_only',
      status: 'diagnostic_only_runtime_assertion',
    });
  });

  it('keeps dialog, resize, and close as auditable replay-only actions, never skipped noise', () => {
    for (const action of ['handleDialog', 'resize', 'close']) {
      const report = compile({
        adapterId: 'playwright-reference',
        result: resultFor(action, { declaredSteps: [] }),
        source: targetlessProof(action),
      });
      expect(report.cases[0].ledger[0]).toMatchObject({
        replayAction: action,
        exportStatus: 'exported',
        status: 'exported_direct',
      });
      expect(report.summary.skippedNoise).toBe(0);
    }
  });

  it('pairs planned and ReplayIR actions by stable contractStepId before order', () => {
    const steps = [
      ...replaySteps('click', 'step-a', { alias: 'elA', label: 'First', role: 'button' }),
      ...replaySteps('fill', 'step-b', { alias: 'elB', label: 'Second', role: 'textbox' }),
    ];
    const result = resultFor('click', {
      declaredSteps: [
        { id: 'step-b', action: 'fill', target: 'Second', text: 'Fill Second' },
        { id: 'step-a', action: 'click', target: 'First', text: 'Click First' },
      ],
      steps,
    });
    const report = compile({
      adapterId: 'playwright-reference',
      result,
      source: 'await firstButton.click();\nawait secondTextbox.fill("value");',
    });
    expect(report.cases[0].ledger.map((row) => [row.plannedStepId, row.replayAction])).toEqual([
      ['step-b', 'fill'],
      ['step-a', 'click'],
    ]);
  });

  it('uses emitted POM identity proof for waits, verification projections, and normalized aliases', () => {
    const specFile = 'tests/authentication/provider-flow.spec.js';
    const source = [
      "await authPage.emailAddressInput().waitFor({ state: 'visible' });",
      'await authPage.assertProviderOptionVisible();',
      'await authPage.submit();',
    ].join('\n');
    const result = {
      testCaseId: 'TC-POM',
      runResultId: 'RR-POM',
      caseName: 'Provider flow',
      declaredSteps: [
        { id: 'step-1', action: 'waitFor', text: 'Wait for the account field' },
        { id: 'step-2', action: 'Verify', text: 'Verify the provider option is visible' },
        { id: 'step-3', action: 'click', text: 'Click Submit' },
      ],
      envelope: {
        findings: [],
        ir: {
          steps: [
            { op: 'resolve', as: 'accountInput', contractStepId: 'step-1', candidates: [] },
            { op: 'waitFor', authored: true, contractStepId: 'step-1', condition: { kind: 'visible', target: 'accountInput' } },
            { op: 'act', action: 'customAction', authored: true, authoredOperation: 'Verify', contractStepId: 'step-2' },
            { op: 'assert', authored: true, contractRef: 'case_step_2', channel: 'UI_TEXT', expected: 'Provider option' },
            { op: 'resolve', as: 'submitButton', contractStepId: 'step-3', candidates: [] },
            { op: 'act', action: 'click', authored: true, contractStepId: 'step-3', target: 'submitButton' },
          ],
        },
      },
    };
    const report = ledger.buildStepCompilationLedger({
      results: [result],
      admitted: [{ testCaseId: result.testCaseId, filePath: specFile }],
      blocked: [],
      files: {
        [specFile]: `${source}\n`,
        'evidence/locator-manifest.json': JSON.stringify([
          { as: 'accountInput', file: 'authPage', name: 'emailAddressInput' },
          { as: 'submitButton', file: 'authPage', name: 'submitButton' },
        ]),
        'evidence/pom-architect-report.json': JSON.stringify({
          specPlan: [
            { testCaseId: 'TC-POM', contractStepId: 'step-1', op: 'waitFor', action: 'waitFor', exportedPageMethod: 'emailAddressInput', emittedSource: source.split('\n')[0] },
            { testCaseId: 'TC-POM', contractStepId: 'step-2', op: 'act', action: 'customAction', exportedPageMethod: 'assertProviderOptionVisible', emittedSource: source.split('\n')[1] },
            { testCaseId: 'TC-POM', contractStepId: 'step-3', op: 'act', action: 'click', exportedPageMethod: 'submit', emittedSource: source.split('\n')[2] },
          ],
        }),
      },
      adapterId: 'playwright-pom-js',
    });

    expect(report.summary).toMatchObject({
      totalPlannedSteps: 3,
      totalReplaySteps: 3,
      exported: 3,
      blockedInternal: 0,
      replayOnly: 0,
    });
    expect(report.cases[0].ledger.map((row) => row.exportedPageMethod)).toEqual([
      'emailAddressInput',
      'assertProviderOptionVisible',
      'submit',
    ]);
  });
});
