const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom');
const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs');

function verifiedLocator(expression, { role = 'button', name = 'Control', pageTitle = null } = {}) {
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'document-under-test',
    nodeId: `node-${name}`,
    connected: true,
  };
  return {
    strategy: role === 'textbox' ? 'label' : 'role',
    expression,
    frameworkExpressions: { playwright: expression },
    verificationSource: 'verified_dom_inspection',
    verified: true,
    captureBinding: { kind: 'mcp_bound_ref' },
    proof: {
      verified: true,
      sameElement: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      actedNodeBound: true,
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
      count: 1,
      visible: true,
      enabled: true,
      source: 'verified_dom_inspection',
    },
    domAtlas: { verifiedActions: [{ expression }] },
    targetFacts: { role, accessibleName: name },
    ...(pageTitle ? { pageIdentity: { pageTitle } } : {}),
  };
}

function runtimeIdentity(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function withOccurrenceIdentity(
  steps,
  {
    runId,
    caseId,
    actionOccurrenceId,
    authoredActionId,
    occurrenceKey,
    sequenceIndex,
    occurrenceOrdinal,
    operation,
  },
) {
  const identity = {
    runId,
    caseId,
    actionOccurrenceId,
    authoredActionId,
    occurrenceKey,
    sequenceIndex,
    occurrenceOrdinal,
    operation,
  };
  return steps.map((step) => ({ ...step, ...identity, actionIdentity: { ...identity } }));
}

function evidenceAndAuthoredAction({
  index,
  action,
  label,
  expression,
  pageUrl,
  pageUrlAfter = null,
  pageTitle = null,
  valueRef = null,
  optional = false,
  popup = false,
}) {
  const runtimeId = runtimeIdentity(index);
  const runtimeTarget = `runtimeTarget${index}`;
  const authoredTarget = `authoredTarget${index}`;
  const role = ['fill', 'type'].includes(action) ? 'textbox' : 'button';
  const locator = verifiedLocator(expression, { role, name: label, pageTitle });
  const occurrenceIdentity = {
    actionOccurrenceId: `step-${index}:${action}:1`,
    occurrenceKey: `step-${index}:${action}:1`,
    operation: action,
  };
  const pageContext = {
    pageUrl,
    ...(pageUrlAfter ? { pageUrlAfter } : {}),
    ...(popup ? { popup: true, transitionKind: 'popup' } : {}),
  };
  return {
    locator,
    declared: {
      id: `step-${index}`,
      action,
      target: label,
      ...occurrenceIdentity,
      ...(optional ? { optional: true, optionalAbsent: true, timeoutMs: 2500 } : {}),
    },
    evidence: [
      {
        op: 'resolve',
        as: runtimeTarget,
        contractStepId: runtimeId,
        authored: false,
        evidenceOnly: true,
        origin: 'unmatched_runtime_evidence',
        elementLabel: label,
        actionLocator: locator,
        ...occurrenceIdentity,
        ...pageContext,
      },
      {
        op: 'act',
        action,
        target: runtimeTarget,
        targetLabel: label,
        contractStepId: runtimeId,
        authored: false,
        evidenceOnly: true,
        origin: 'unmatched_runtime_evidence',
        actionLocator: locator,
        ...occurrenceIdentity,
        ...(valueRef ? { valueRef } : {}),
        ...pageContext,
      },
    ],
    authored: [
      {
        op: 'resolve',
        as: authoredTarget,
        contractStepId: `step-${index}`,
        elementLabel: label,
        candidates: [{ strategy: 'role', role, name: label }],
        guessedLocator: true,
        locatorConfidence: 'guessed',
        ...occurrenceIdentity,
      },
      {
        op: 'act',
        action,
        target: authoredTarget,
        targetLabel: label,
        contractStepId: `step-${index}`,
        ...occurrenceIdentity,
        ...(valueRef ? { valueRef } : {}),
      },
    ],
  };
}

function joinedSources(output) {
  return [output.content, ...Object.values(output.extraFiles || {})].join('\n');
}

function emittedPomSources(output) {
  const pomFiles = Object.entries(output.extraFiles || {})
    .filter(([file]) => /^(?:locators|pages)\//.test(file))
    .map(([, source]) => source);
  return [output.content, ...pomFiles].join('\n');
}

function microsoftJourneyCase() {
  const appUrl = 'https://app.example.test/auth/email-classifier';
  const microsoftUrl =
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=public-client';
  const actions = [
    evidenceAndAuthoredAction({
      index: 1,
      action: 'fill',
      label: 'Email Address',
      expression: 'getByLabel("Email Address", { exact: true })',
      pageUrl: appUrl,
      valueRef: 'env:QAAI_USERNAME',
    }),
    evidenceAndAuthoredAction({
      index: 2,
      action: 'click',
      label: 'Continue',
      expression: 'getByRole("button", { name: "Continue", exact: true })',
      pageUrl: appUrl,
    }),
    evidenceAndAuthoredAction({
      index: 3,
      action: 'click',
      label: 'Sign in with Microsoft',
      expression: 'getByRole("button", { name: "Sign in with Microsoft", exact: true })',
      pageUrl: appUrl,
      pageUrlAfter: microsoftUrl,
    }),
    evidenceAndAuthoredAction({
      index: 4,
      action: 'fill',
      label: 'Email, phone, or Skype',
      expression: 'getByLabel("Email, phone, or Skype", { exact: true })',
      pageUrl: microsoftUrl,
      pageTitle: 'Microsoft Sign-In',
      valueRef: 'env:QAAI_USERNAME',
    }),
    evidenceAndAuthoredAction({
      index: 5,
      action: 'click',
      label: 'Next',
      expression: 'getByRole("button", { name: "Next", exact: true })',
      pageUrl: microsoftUrl,
      pageTitle: 'Microsoft Sign-In',
    }),
    evidenceAndAuthoredAction({
      index: 6,
      action: 'fill',
      label: 'Password',
      expression: 'getByLabel("Password", { exact: true })',
      pageUrl: microsoftUrl,
      pageTitle: 'Microsoft Sign-In',
      valueRef: 'env:QAAI_PASSWORD',
    }),
    evidenceAndAuthoredAction({
      index: 7,
      action: 'click',
      label: 'Sign in',
      expression: 'getByRole("button", { name: "Sign in", exact: true })',
      pageUrl: microsoftUrl,
      pageTitle: 'Microsoft Sign-In',
    }),
    evidenceAndAuthoredAction({
      index: 8,
      action: 'click',
      label: 'No',
      expression: 'getByRole("button", { name: "No", exact: true })',
      pageUrl: microsoftUrl,
      pageUrlAfter: 'https://app.example.test/dashboard',
      pageTitle: 'Microsoft Sign-In',
      optional: true,
    }),
  ];
  return {
    caseName: 'Email Classifier Microsoft Sign-In to Dashboard',
    testCaseId: 'microsoft-login',
    startUrl:
      'https://app.example.test/auth/email-classifier?returnUrl=%2Fdashboard&tenant=acme#start',
    declaredSteps: actions.map((entry) => entry.declared),
    ir: {
      caseId: 'microsoft-login',
      title: 'Email Classifier Microsoft Sign-In to Dashboard',
      contextTransitions: [
        {
          kind: 'observed_start_state',
          observedUrl:
            'https://app.example.test/auth/email-classifier?returnUrl=%2Fdashboard&tenant=acme#start',
          helperOperation: true,
          authored: false,
        },
      ],
      steps: [
        {
          op: 'act',
          action: 'navigate',
          url: 'https://app.example.test/auth/email-classifier?returnUrl=%2Fdashboard&tenant=acme#start',
          contractStepId: 'open-email-classifier',
          actionOccurrenceId: 'open-email-classifier:navigate:1',
          occurrenceKey: 'open-email-classifier:navigate:1',
          authored: true,
          canonicalExecution: true,
          success: true,
          executionStatus: 'passed',
          origin: 'runtime_evidence',
        },
        ...actions.flatMap((entry) => entry.evidence),
        ...actions.flatMap((entry) => entry.authored),
        {
          op: 'assert',
          channel: 'UI_TEXT',
          expected: 'Welcome to OdysseyOne',
          contractRef: 'dashboard-welcome',
        },
      ],
      verdict: { status: 'pass', perAssertionOutcomes: [] },
    },
  };
}

describe('Playwright POM JavaScript standard output profile', () => {
  test('emits a clean, one-to-one Microsoft journey with exact captured locators', () => {
    const sourceCase = microsoftJourneyCase();
    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    for (const entry of sourceCase.ir.steps.filter(
      (step) => step.op === 'act' && step.authored === false && step.action !== 'navigate',
    )) {
      const authored = prepared.ir.steps.find(
        (step) =>
          step.op === 'act' &&
          step.contractStepId === `step-${Number(entry.target.replace('runtimeTarget', ''))}`,
      );
      expect(authored.actionLocator).toStrictEqual(entry.actionLocator);
    }

    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Authentication',
    });
    const sources = joinedSources(output);
    const pomSources = emittedPomSources(output);
    expect(output.content).toContain('await emailClassifierPage.openEmailClassifier();');
    expect(output.extraFiles['pages/EmailClassifierPage.js']).toContain(
      'await this.page.goto("https://app.example.test/auth/email-classifier?returnUrl=%2Fdashboard&tenant=acme#start", { waitUntil: "domcontentloaded" });',
    );
    expect(Object.keys(output.extraFiles)).toContain('pages/EmailClassifierPage.js');
    expect(Object.keys(output.extraFiles)).toContain('pages/MicrosoftSignInPage.js');
    expect(Object.keys(output.extraFiles)).not.toContain('pages/ApplicationPage.js');

    for (const entry of sourceCase.ir.steps.filter((step) => step.actionLocator)) {
      expect(sources).toContain(`page.${entry.actionLocator.expression}`);
    }
    expect(output.content.match(/\.clickContinue\(/g) || []).toHaveLength(1);
    expect(output.content).toContain('Welcome to OdysseyOne');
    expect(output.content).toContain('await microsoftSignInPage.clickNo();');
    expect(output.extraFiles['pages/MicrosoftSignInPage.js']).toContain(
      "waitFor({ state: 'visible', timeout: 2500 })",
    );
    expect(output.extraFiles['pages/MicrosoftSignInPage.js']).toContain(
      'if (appeared) { await optionalTarget.click(options); }',
    );
    expect(output.content).not.toContain('.isVisible({ timeout: 2500 })');
    expect(output.content).not.toMatch(/click[A-Za-z0-9_$]+\(\{\}\)/);
    expect(pomSources).not.toMatch(
      /qaai-runtime-evidence|qaai-observed-navigation|test\.info\(\)\.annotations|STATUS: DRAFT/i,
    );
    expect(pomSources).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(output.content).not.toContain('.catch(() => {})');
  });

  test('binds declared actions only through exact immutable runtime occurrences without guessing or cross-attachment', () => {
    const runId = 'run-occurrence-binding';
    const caseId = 'legacy-step-binding';
    const expression = 'getByRole("button", { name: "Continue", exact: true })';
    const locator = verifiedLocator(expression, { role: 'button', name: 'Continue' });
    const runtimeOccurrence = (ordinal) => withOccurrenceIdentity(
      [
        {
          op: 'resolve',
          as: `runtimeContinue${ordinal}`,
          contractStepId: `${caseId}:step:${ordinal}:runtime-hash-${ordinal}`,
          authored: false,
          evidenceOnly: true,
          origin: 'unmatched_runtime_evidence',
          elementLabel: 'Continue',
          actionLocator: locator,
        },
        {
          op: 'act',
          action: 'click',
          target: `runtimeContinue${ordinal}`,
          targetLabel: 'Continue',
          contractStepId: `${caseId}:step:${ordinal}:runtime-hash-${ordinal}`,
          authored: false,
          evidenceOnly: true,
          origin: 'unmatched_runtime_evidence',
          actionLocator: locator,
        },
      ],
      {
        runId,
        caseId,
        actionOccurrenceId: `${runId}:${caseId}:${ordinal}:click`,
        authoredActionId: `${caseId}:step:${ordinal}`,
        occurrenceKey: `${runId}:${caseId}:${ordinal}:click:1`,
        sequenceIndex: ordinal,
        occurrenceOrdinal: 1,
        operation: 'click',
      },
    );
    const sourceCase = {
      caseName: 'Legacy declared occurrence binding',
      runId,
      testCaseId: caseId,
      declaredSteps: [2, 3].map((ordinal) => ({
        id: `case_step_${ordinal}`,
        order: ordinal,
        action: 'click',
        target: 'Continue',
        actionOccurrenceId: `${runId}:${caseId}:${ordinal}:click`,
        occurrenceKey: `${runId}:${caseId}:${ordinal}:click:1`,
      })),
      ir: {
        runId,
        caseId,
        steps: [...runtimeOccurrence(2), ...runtimeOccurrence(3)],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const acts = prepared.ir.steps.filter((step) => step.op === 'act');
    expect(acts).toHaveLength(2);
    expect(acts.map((step) => step.actionOccurrenceId)).toStrictEqual([
      `${runId}:${caseId}:2:click`,
      `${runId}:${caseId}:3:click`,
    ]);
    expect(acts.map((step) => step.actionLocator)).toStrictEqual([locator, locator]);

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    const sources = joinedSources(output);
    expect(sources).toContain(`page.${expression}`);
    expect(sources).not.toContain('QAAI_GUESSED_LOCATOR');
    expect(output.content.match(/\.clickContinue\(/g) || []).toHaveLength(2);

    const ordinalOnly = structuredClone(sourceCase);
    for (const declared of ordinalOnly.declaredSteps) {
      delete declared.actionOccurrenceId;
      delete declared.occurrenceKey;
    }
    const rejected = playwrightPomJs._prepareCasesForStandardOutput([ordinalOnly])[0];
    expect(rejected.ir.steps.filter((step) => step.op === 'act')).toHaveLength(0);
  });

  test('keeps the positively executed runtime operation authoritative when authored semantics disagree', () => {
    const runId = 'run-runtime-operation-authority';
    const caseId = 'runtime-operation-authority';
    const occurrence = {
      runId,
      caseId,
      actionOccurrenceId: `${runId}:${caseId}:1:click`,
      authoredActionId: `${caseId}:step:1`,
      occurrenceKey: `${runId}:${caseId}:1:click:1`,
      sequenceIndex: 1,
      occurrenceOrdinal: 1,
      operation: 'click',
    };
    const locator = verifiedLocator(
      'getByRole("option", { name: "LTL", exact: true })',
      { role: 'option', name: 'LTL' },
    );
    const sourceCase = {
      caseName: 'Runtime operation authority',
      runId,
      testCaseId: caseId,
      declaredSteps: [{
        id: 'case_step_1',
        order: 1,
        action: 'selectOption',
        target: 'LTL option',
        ...occurrence,
      }],
      ir: {
        runId,
        caseId,
        steps: [
          {
            op: 'resolve',
            as: 'ltlOption',
            contractStepId: runtimeIdentity(1),
            elementLabel: 'LTL',
            actionLocator: locator,
            ...occurrence,
          },
          {
            op: 'act',
            action: 'click',
            target: 'ltlOption',
            targetLabel: 'LTL',
            contractStepId: runtimeIdentity(1),
            actionLocator: locator,
            ...occurrence,
          },
        ],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    expect(prepared.ir.steps.find((step) => step.op === 'act').action).toBe('click');

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    const sources = joinedSources(output);
    expect(sources).toContain('.click(');
    expect(sources).not.toContain('.selectOption(');
  });

  test('emits a successful typed ExecutedCaseAST wait without promoting other runtime evidence', () => {
    const sourceCase = {
      caseName: 'Executed wait projection',
      testCaseId: 'executed-wait-projection',
      declaredSteps: [],
      ir: {
        caseId: 'executed-wait-projection',
        steps: [{
          op: 'waitFor',
          condition: {
            kind: 'pageState',
            timeoutMs: 5000,
            expected: { effect: 'fingerprint_stable' },
          },
          contractStepId: 'executed-wait-projection:step:1',
          authored: false,
          executed: true,
          executionOutcome: 'succeeded',
          origin: 'executed_case_ast',
        }],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    expect(prepared.ir.steps.filter((step) => step.op === 'waitFor')).toHaveLength(1);

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    expect(output.content).toContain('waitForLoadState("domcontentloaded"');
    expect(output.content).toContain('timeout: 5000');
  });

  test('forwards expected values into parameterized text locator accessors', () => {
    const output = playwrightPomJs.emitJourneySpec([{
      caseName: 'Dynamic text assertion',
      testCaseId: 'dynamic-text-assertion',
      declaredSteps: [{ id: 'assert-welcome', action: 'verify', expected: 'Welcome OdysseyOne!' }],
      ir: {
        caseId: 'dynamic-text-assertion',
        steps: [{
          op: 'assert',
          channel: 'UI_TEXT',
          expected: 'Welcome OdysseyOne!',
          contractRef: 'assert-welcome',
          contractStepId: 'assert-welcome',
          authored: true,
        }],
      },
    }]);
    const pageSource = Object.entries(output.extraFiles)
      .filter(([name]) => /^pages\/.+Page\.js$/.test(name))
      .map(([, source]) => source)
      .join('\n');
    const locatorSource = Object.entries(output.extraFiles)
      .filter(([name]) => /^locators\/generated\/.+\.generated\.locators\.js$/.test(name))
      .map(([, source]) => source)
      .join('\n');

    expect(pageSource).toContain('(expected) { return');
    expect(pageSource).toContain('(this.page, expected)');
    expect(pageSource).toMatch(/async assert\w+UiText\(expected\)[\s\S]*?this\.\w+\(expected\)/);
    expect(locatorSource).toContain('getByText(expected, { exact: true }).first()');
    expect(pageSource).toMatch(/async assert\w+UiText\(expected\)[\s\S]*?\.toBeVisible\(/);
    expect(pageSource).not.toMatch(/async assert\w+UiText\(expected\)[\s\S]*?\.toContainText\(expected/);
  });

  test('preserves authoritative evaluated AST assertions and prefers exported row data over generic env placeholders', () => {
    const locator = verifiedLocator(
      'getByRole("textbox", { name: "Order Number", exact: true })',
      { role: 'textbox', name: 'Order Number' },
    );
    const sourceCase = {
      caseName: 'Evaluated order assertion',
      testCaseId: 'evaluated-order-assertion',
      declaredSteps: [
        { id: 'case_step_1', action: 'fill', target: 'Order Number field' },
        {
          id: runtimeIdentity(52),
          action: 'verify',
          target: 'Order Number field',
          channel: 'UI_TEXT',
          expected: 'the Order Number field contains exactly the supplied order number.',
        },
      ],
      ir: {
        caseId: 'evaluated-order-assertion',
        dataRows: [{ id: 'order-row-1', fields: { order_number: 'ORDER-1042' } }],
        steps: [
          {
            op: 'resolve',
            as: 'orderNumberField',
            contractStepId: runtimeIdentity(51),
            elementLabel: 'Order Number field',
            actionLocator: locator,
          },
          {
            op: 'act',
            action: 'fill',
            target: 'orderNumberField',
            contractStepId: runtimeIdentity(51),
            valueRef: 'env:QAAI_TEXTBOX',
            dataBinding: { isDataBound: true, sourceColumn: 'order_number' },
          },
          {
            op: 'assert',
            channel: 'VALUE',
            target: 'orderNumberField',
            contractStepId: runtimeIdentity(52),
            contractRef: runtimeIdentity(52),
            expectedRef: 'env:QAAI_TEXTBOX',
            dataBinding: { isDataBound: true, sourceColumn: 'order_number' },
            liveOutcome: 'matched',
            executionStatus: 'evaluated',
            authored: true,
            executed: true,
            executionOutcome: 'succeeded',
            liveDomGrounded: true,
            origin: 'executed_case_ast_assertion',
          },
        ],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const preparedAssertion = prepared.ir.steps.find((step) => step.op === 'assert');
    expect(preparedAssertion).toMatchObject({
      origin: 'executed_case_ast_assertion',
      authored: true,
    });
    expect(preparedAssertion.executable).not.toBe(false);

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    const sources = joinedSources(output);
    expect(sources).toMatch(/await \w+Page\.\w*OrderNumber\w*\(readData\(row, ["']order_number["']\)\);/);
    expect(sources).not.toContain('QAAI_TEXTBOX');
  });

  test('promotes safe value references from exact repeated runtime occurrences without copying raw credentials', () => {
    const runId = 'run-value-binding';
    const caseId = 'legacy-value-binding';
    const runtimeFill = (ordinal, valueRef) => {
      const locator = verifiedLocator(
        `getByTestId("credential-${ordinal}")`,
        { role: 'textbox', name: 'Credential' },
      );
      return withOccurrenceIdentity(
        [
          {
            op: 'resolve',
            as: `runtimeCredential${ordinal}`,
            contractStepId: `${caseId}:step:${ordinal}:runtime-hash-${ordinal}`,
            authored: false,
            evidenceOnly: true,
            origin: 'unmatched_runtime_evidence',
            elementLabel: 'Credential',
            actionLocator: locator,
          },
          {
            op: 'act',
            action: 'fill',
            target: `runtimeCredential${ordinal}`,
            targetLabel: 'Credential',
            contractStepId: `${caseId}:step:${ordinal}:runtime-hash-${ordinal}`,
            authored: false,
            evidenceOnly: true,
            origin: 'unmatched_runtime_evidence',
            actionLocator: locator,
            valueRef,
            rawValue: 'must-never-be-copied',
          },
        ],
        {
          runId,
          caseId,
          actionOccurrenceId: `${runId}:${caseId}:${ordinal}:fill`,
          authoredActionId: `${caseId}:step:${ordinal}`,
          occurrenceKey: `${runId}:${caseId}:${ordinal}:fill:1`,
          sequenceIndex: ordinal,
          occurrenceOrdinal: 1,
          operation: 'fill',
        },
      );
    };
    const sourceCase = {
      caseName: 'Exact secure value binding',
      runId,
      testCaseId: caseId,
      declaredSteps: [
        {
          id: 'case_step_2',
          order: 2,
          action: 'fill',
          target: 'Credential',
          actionOccurrenceId: `${runId}:${caseId}:2:fill`,
          occurrenceKey: `${runId}:${caseId}:2:fill:1`,
        },
        {
          id: 'case_step_3',
          order: 3,
          action: 'fill',
          target: 'Credential',
          actionOccurrenceId: `${runId}:${caseId}:3:fill`,
          occurrenceKey: `${runId}:${caseId}:3:fill:1`,
        },
      ],
      ir: {
        runId,
        caseId,
        steps: [
          ...runtimeFill(2, 'env:QAAI_USERNAME'),
          ...runtimeFill(3, 'env:QAAI_PASSWORD'),
        ],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const fills = prepared.ir.steps.filter((step) => step.op === 'act' && step.action === 'fill');
    expect(fills.map((step) => step.valueRef)).toStrictEqual([
      'env:QAAI_USERNAME',
      'env:QAAI_PASSWORD',
    ]);
    expect(fills.every((step) => step.rawValue == null)).toBe(true);

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    expect(output.content).toContain('readEnv("QAAI_USERNAME")');
    expect(output.content).toContain('readEnv("QAAI_PASSWORD")');
    expect(joinedSources(output)).not.toContain('must-never-be-copied');
    expect(output.content).not.toContain('undefined');
  });

  test('emits an authored navigate URL carried in the declared value instead of a blank goto', () => {
    const sourceCase = {
      caseName: 'Navigate from authored value',
      testCaseId: 'navigate-authored-value',
      declaredSteps: [{
        id: 'case_step_1',
        order: 1,
        action: 'Navigate',
        value: 'https://app.example.test/auth/email-classifier?returnUrl=%2Fdashboard',
      }],
      ir: {
        caseId: 'navigate-authored-value',
        steps: [{
          op: 'act',
          action: 'navigate',
          contractStepId: 'case_step_1',
          authored: true,
        }],
      },
    };

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    const pageSource = Object.values(output.extraFiles).find((source) =>
      typeof source === 'string' && source.includes('async open'),
    );
    expect(pageSource).toContain(
      'await this.page.goto("https://app.example.test/auth/email-classifier?returnUrl=%2Fdashboard", { waitUntil: "domcontentloaded" });',
    );
    expect(joinedSources(output)).not.toMatch(/page\.goto\(["']{2}\)/);
  });

  test('keeps unmatched runtime operations diagnostic-only while preserving authored assertions and waits', () => {
    const save = evidenceAndAuthoredAction({
      index: 21,
      action: 'click',
      label: 'Save settings',
      expression: 'getByRole("button", { name: "Save settings", exact: true })',
      pageUrl: 'https://app.example.test/settings',
    });
    const probe = evidenceAndAuthoredAction({
      index: 22,
      action: 'click',
      label: 'Diagnostic probe',
      expression: 'getByRole("button", { name: "Diagnostic probe", exact: true })',
      pageUrl: 'https://app.example.test/settings',
    });
    const sourceCase = {
      caseName: 'Runtime parity',
      ir: {
        caseId: 'runtime-parity',
        steps: [
          ...save.evidence,
          ...probe.evidence.map((step) => ({
            ...step,
            helperOperation: true,
            operationClass: 'diagnostic_probe',
          })),
          {
            op: 'waitFor',
            condition: { kind: 'visible', target: 'status', timeoutMs: 4100 },
            contractStepId: 'wait-ready',
          },
          {
            op: 'waitFor',
            condition: { kind: 'visible', target: 'status', timeoutMs: 4100 },
            contractStepId: 'wait-ready',
            authored: false,
            evidenceOnly: true,
            origin: 'unmatched_runtime_evidence',
          },
          {
            op: 'assert',
            channel: 'UI_TEXT',
            target: 'status',
            expected: 'Saved',
            contractRef: 'assert-ready',
          },
          {
            op: 'assert',
            channel: 'UI_TEXT',
            target: 'status',
            expected: 'Saved',
            contractRef: 'assert-ready',
            authored: false,
            evidenceOnly: true,
            origin: 'unmatched_runtime_evidence',
          },
          {
            op: 'waitFor',
            condition: { kind: 'networkidle', timeoutMs: 6200 },
            contractStepId: runtimeIdentity(23),
            authored: false,
            evidenceOnly: true,
            origin: 'unmatched_runtime_evidence',
          },
          {
            op: 'assert',
            channel: 'URL',
            expected: '/runtime-only-destination',
            contractStepId: runtimeIdentity(24),
            authored: false,
            evidenceOnly: true,
            origin: 'unmatched_runtime_evidence',
          },
        ],
      },
    };
    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    expect(
      prepared.ir.steps.filter((step) => step.op === 'act' && step.action !== 'navigate'),
    ).toHaveLength(0);
    expect(prepared.ir.steps.filter((step) => step.op === 'waitFor')).toHaveLength(1);
    expect(prepared.ir.steps.filter((step) => step.op === 'assert')).toHaveLength(1);
    expect(prepared.ir.runtimeEvidence).toHaveLength(8);
    expect(
      prepared.ir.runtimeEvidence.every(
        (step) => step.executable === false && step.diagnosticOnly === true,
      ),
    ).toBe(true);

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    const sources = joinedSources(output);
    const pomSources = emittedPomSources(output);
    expect(output.content.match(/\.clickSaveSettings\(/g) || []).toHaveLength(0);
    expect(sources).not.toContain('Diagnostic probe');
    expect(output.content).not.toContain("page.waitForLoadState('load', { timeout: 6200 })");
    expect(output.content).toContain('Saved');
    expect(output.content).not.toContain('/runtime-only-destination');
    expect(pomSources).not.toMatch(/qaai-runtime-evidence|test\.info\(\)\.annotations/i);
    expect(pomSources).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(output.content).not.toContain('.catch(() => {})');
  });

  test('keeps unexecuted authored actions and waits out of the runnable IR', () => {
    const sourceCase = {
      caseName: 'Declared wait recovery',
      testCaseId: 'declared-wait-recovery',
      declaredSteps: [
        {
          id: 'open-reports',
          action: 'navigate',
          url: 'https://app.example.test/reports',
        },
        {
          id: 'wait-reports-ready',
          op: 'waitFor',
          waitContract: { kind: 'visible', target: 'reportsStatus', timeoutMs: 4200 },
        },
        {
          id: 'open-summary',
          action: 'navigate',
          url: 'https://app.example.test/reports/summary',
        },
      ],
      ir: { caseId: 'declared-wait-recovery', steps: [] },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const executable = prepared.ir.steps.filter(
      (step) => step.op === 'act' || step.op === 'waitFor',
    );
    expect(executable).toEqual([]);
    const waits = executable.filter((step) => step.op === 'waitFor');
    expect(waits).toHaveLength(0);
    expect(prepared.declaredSteps.map((step) => step.contractStepId || step.id)).toEqual([
      'open-reports',
      'wait-reports-ready',
      'open-summary',
    ]);
  });

  test('does not duplicate an existing exact authored wait when runtime evidence repeats it', () => {
    const sourceCase = {
      caseName: 'Declared wait dedupe',
      testCaseId: 'declared-wait-dedupe',
      declaredSteps: [
        {
          id: 'wait-ready',
          op: 'waitFor',
          waitContract: { kind: 'visible', target: 'status', timeoutMs: 4500 },
        },
      ],
      ir: {
        caseId: 'declared-wait-dedupe',
        steps: [
          {
            op: 'waitFor',
            contractStepId: 'wait-ready',
            condition: { kind: 'visible', target: 'status', timeoutMs: 1000 },
          },
          {
            op: 'waitFor',
            contractStepId: 'wait-ready',
            condition: { kind: 'visible', target: 'status', timeoutMs: 1000 },
            authored: false,
            evidenceOnly: true,
            origin: 'unmatched_runtime_evidence',
          },
        ],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const waits = prepared.ir.steps.filter((step) => step.op === 'waitFor');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      contractStepId: 'wait-ready',
      waitContractId: 'wait-ready',
      condition: { kind: 'visible', target: 'status', timeoutMs: 4500 },
    });
  });

  test('executes runtime-required operations only with authored occurrence or declared-contract backing', () => {
    const backedLocator = verifiedLocator(
      'getByRole("button", { name: "Publish changes", exact: true })',
      { name: 'Publish changes' },
    );
    const unbackedLocator = verifiedLocator(
      'getByRole("button", { name: "Runtime only control", exact: true })',
      { name: 'Runtime only control' },
    );
    const sourceCase = {
      caseName: 'Runtime required backing',
      declaredSteps: [{ id: 'publish-step', action: 'click', target: 'Publish changes' }],
      ir: {
        caseId: 'runtime-required-backing',
        steps: [
          {
            op: 'resolve',
            as: 'publish',
            contractStepId: 'publish-step',
            authored: true,
            origin: 'runtime_required_operation',
            elementLabel: 'Publish changes',
            actionLocator: backedLocator,
          },
          {
            op: 'act',
            action: 'click',
            target: 'publish',
            contractStepId: 'publish-step',
            authored: true,
            origin: 'runtime_required_operation',
          },
          {
            op: 'resolve',
            as: 'runtimeOnly',
            contractStepId: 'foreign-runtime-step',
            authored: true,
            origin: 'runtime_required_operation',
            elementLabel: 'Runtime only control',
            actionLocator: unbackedLocator,
          },
          {
            op: 'act',
            action: 'click',
            target: 'runtimeOnly',
            contractStepId: 'foreign-runtime-step',
            authored: true,
            origin: 'runtime_required_operation',
          },
        ],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const actions = prepared.ir.steps.filter(
      (step) => step.op === 'act' && step.action === 'click',
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].contractStepId).toBe('publish-step');
    expect(prepared.ir.runtimeEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contractStepId: 'foreign-runtime-step',
          executable: false,
          diagnosticOnly: true,
        }),
      ]),
    );

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    expect(output.content.match(/\.clickPublishChanges\(/g) || []).toHaveLength(1);
    expect(output.content).not.toContain('RuntimeOnlyControl');
  });

  test('collapses an exact verified runtime duplicate without replacing the authored verified locator', () => {
    const action = evidenceAndAuthoredAction({
      index: 25,
      action: 'click',
      label: 'Confirm order',
      expression: 'getByRole("button", { name: "Confirm order", exact: true })',
      pageUrl: 'https://app.example.test/orders/confirm',
    });
    const exactAuthored = action.authored.map((step) => ({
      ...step,
      actionLocator: action.locator,
      pageUrl: 'https://app.example.test/orders/confirm',
      guessedLocator: false,
      locatorConfidence: 'verified',
    }));
    const sourceCase = {
      caseName: 'Confirm order',
      declaredSteps: [action.declared],
      ir: { caseId: 'confirm-order', steps: [...action.evidence, ...exactAuthored] },
    };
    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const actions = prepared.ir.steps.filter(
      (step) => step.op === 'act' && step.action !== 'navigate',
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].actionLocator).toStrictEqual(action.locator);
    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    expect(output.content.match(/\.clickConfirmOrder\(/g) || []).toHaveLength(1);
    expect(emittedPomSources(output)).not.toMatch(
      /qaai-runtime-evidence|test\.info\(\)\.annotations/i,
    );
  });

  test('never attaches stale repeated occurrence evidence by contract, semantics, or authored order', () => {
    const first = evidenceAndAuthoredAction({
      index: 81,
      action: 'click',
      label: 'Open document',
      expression: 'getByTestId("stale-primary-document")',
      pageUrl: 'https://app.example.test/documents',
    });
    const second = evidenceAndAuthoredAction({
      index: 82,
      action: 'click',
      label: 'Open document',
      expression: 'getByTestId("stale-secondary-document")',
      pageUrl: 'https://app.example.test/documents',
    });
    const currentIdentity = (ordinal) => ({
      runId: 'run-current',
      caseId: 'repeated-occurrence-case',
      actionOccurrenceId: `current-occurrence-${ordinal}`,
      authoredActionId: `current-authored-${ordinal}`,
      occurrenceKey: `run-current:repeated-occurrence-case:${ordinal}:click`,
      sequenceIndex: ordinal,
      occurrenceOrdinal: ordinal,
      operation: 'click',
    });
    const staleIdentity = (ordinal) => ({
      runId: 'run-stale',
      caseId: 'repeated-occurrence-case',
      actionOccurrenceId: `stale-occurrence-${ordinal}`,
      authoredActionId: `stale-authored-${ordinal}`,
      occurrenceKey: `run-stale:repeated-occurrence-case:${ordinal}:click`,
      sequenceIndex: ordinal,
      occurrenceOrdinal: ordinal,
      operation: 'click',
    });
    const waitCurrent = {
      runId: 'run-current',
      caseId: 'repeated-occurrence-case',
      actionOccurrenceId: 'current-wait',
      authoredActionId: 'current-wait-authored',
      occurrenceKey: 'run-current:repeated-occurrence-case:3:waitFor',
      sequenceIndex: 3,
      occurrenceOrdinal: 1,
      operation: 'waitFor',
    };
    const waitStale = {
      ...waitCurrent,
      runId: 'run-stale',
      actionOccurrenceId: 'stale-wait',
      authoredActionId: 'stale-wait-authored',
      occurrenceKey: 'run-stale:repeated-occurrence-case:3:waitFor',
    };
    const sourceCase = {
      runResultId: 'run-current',
      testCaseId: 'repeated-occurrence-case',
      caseName: 'Repeated occurrence isolation',
      declaredSteps: [first.declared, second.declared],
      ir: {
        caseId: 'repeated-occurrence-case',
        steps: [
          ...withOccurrenceIdentity(first.evidence, staleIdentity(1)),
          ...withOccurrenceIdentity(second.evidence, staleIdentity(2)),
          ...withOccurrenceIdentity(first.authored, currentIdentity(1)),
          ...withOccurrenceIdentity(second.authored, currentIdentity(2)),
          {
            op: 'waitFor',
            contractStepId: 'wait-ready',
            condition: { kind: 'visible', target: 'status' },
            ...waitCurrent,
            actionIdentity: waitCurrent,
          },
          {
            op: 'waitFor',
            contractStepId: 'wait-ready',
            condition: { kind: 'visible', target: 'status' },
            actual: 'stale-observation',
            authored: false,
            evidenceOnly: true,
            origin: 'unmatched_runtime_evidence',
            ...waitStale,
            actionIdentity: waitStale,
          },
        ],
      },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const authoredActs = prepared.ir.steps.filter(
      (step) => step.op === 'act' && step.setupOperation !== true,
    );
    expect(authoredActs).toHaveLength(0);
    expect(
      prepared.ir.steps.find(
        (step) => step.op === 'waitFor' && step.contractStepId === 'wait-ready',
      ).actual,
    ).toBeUndefined();
    expect(prepared.ir.runtimeEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionOccurrenceId: 'stale-occurrence-1',
          diagnosticOnly: true,
          executable: false,
        }),
        expect.objectContaining({
          actionOccurrenceId: 'stale-occurrence-2',
          diagnosticOnly: true,
          executable: false,
        }),
        expect.objectContaining({
          actionOccurrenceId: 'stale-wait',
          diagnosticOnly: true,
          executable: false,
        }),
      ]),
    );

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    expect(emittedPomSources(output)).not.toContain('stale-primary-document');
    expect(emittedPomSources(output)).not.toContain('stale-secondary-document');
  });

  test('does not convert an unexecuted unknown authored operation into a click', () => {
    const sourceCase = {
      caseName: 'Launch a workflow',
      testCaseId: 'generic-authored-operation',
      declaredSteps: [{ id: 'launch-workflow', action: 'activate', target: 'Launch workflow' }],
      ir: { caseId: 'generic-authored-operation', steps: [] },
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const action = prepared.ir.steps.find(
      (step) => step.op === 'act' && step.contractStepId === 'launch-workflow',
    );
    expect(action).toBeUndefined();

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    expect(output.content).not.toMatch(/await \w+Page\.clickLaunchWorkflow\(\);/);
    expect(emittedPomSources(output)).not.toContain('async clickLaunchWorkflow(');
  });

  test('pre-arms one popup event, performs one trigger click, adopts the page, and keeps timeout failures strict', () => {
    const open = evidenceAndAuthoredAction({
      index: 31,
      action: 'click',
      label: 'Open report',
      expression: 'getByRole("button", { name: "Open report", exact: true })',
      pageUrl: 'https://app.example.test/reports',
    });
    const download = evidenceAndAuthoredAction({
      index: 32,
      action: 'click',
      label: 'Download report',
      expression: 'getByRole("button", { name: "Download report", exact: true })',
      pageUrl: 'https://reports.example.org/generated?format=pdf',
      pageTitle: 'Generated Report',
    });
    const popupNavigation = {
      op: 'act',
      action: 'navigate',
      url: 'https://reports.example.org/generated?format=pdf',
      popup: true,
      transitionKind: 'popup',
      authored: false,
      evidenceOnly: true,
      origin: 'unmatched_runtime_evidence',
    };
    const sourceCase = {
      caseName: 'Open generated report',
      declaredSteps: [open.declared, download.declared],
      ir: {
        caseId: 'popup-report',
        contextTransitions: [
          { kind: 'observed_start_state', observedUrl: 'https://app.example.test/reports' },
        ],
        steps: [
          ...open.evidence,
          popupNavigation,
          ...open.authored,
          ...download.evidence,
          ...download.authored,
          { op: 'assert', channel: 'URL', expected: '/generated?format=pdf' },
        ],
      },
    };
    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    expect(output.content.match(/page\.waitForEvent\('popup'/g) || []).toHaveLength(1);
    expect(output.content).not.toContain("context().waitForEvent('page')");
    expect(output.content.match(/\.clickOpenReport\(/g) || []).toHaveLength(1);
    expect(output.content).toContain('const [popupPage] = await Promise.all([');
    expect(output.content).toContain('page = popupPage;');
    expect(output.content).toMatch(/\.usePage\(popupPage\);/);
    expect(output.content).toContain('format=pdf$');
    expect(output.content).toContain('timeout: 10000');
    expect(output.content).not.toContain('.catch(() => {})');
  });

  test('associates ambiguous repeated popup triggers by observed order and leaves missing or wrong popups as timeout failures', () => {
    const first = evidenceAndAuthoredAction({
      index: 41,
      action: 'click',
      label: 'Open document',
      expression: 'getByTestId("open-primary-document")',
      pageUrl: 'https://app.example.test/documents',
    });
    const second = evidenceAndAuthoredAction({
      index: 42,
      action: 'click',
      label: 'Open document',
      expression: 'getByTestId("open-secondary-document")',
      pageUrl: 'https://app.example.test/documents',
    });
    const popupNavigation = {
      op: 'act',
      action: 'navigate',
      url: 'https://documents.example.org/primary?mode=review',
      popup: true,
      transitionKind: 'popup',
      authored: false,
      evidenceOnly: true,
      origin: 'unmatched_runtime_evidence',
    };
    const sourceCase = {
      caseName: 'Open one of repeated documents',
      declaredSteps: [first.declared, second.declared],
      ir: {
        caseId: 'ambiguous-popup',
        steps: [
          ...first.evidence,
          popupNavigation,
          ...second.evidence,
          ...first.authored,
          ...second.authored,
        ],
      },
    };
    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const firstAuthored = prepared.ir.steps.find(
      (step) => step.op === 'act' && step.contractStepId === 'step-41',
    );
    const secondAuthored = prepared.ir.steps.find(
      (step) => step.op === 'act' && step.contractStepId === 'step-42',
    );
    expect(firstAuthored.opensPopup).toBe(true);
    expect(firstAuthored.popupExpectedUrl).toBe(
      'https://documents.example.org/primary?mode=review',
    );
    expect(secondAuthored.opensPopup).not.toBe(true);

    const output = playwrightPomJs.emitJourneySpec([sourceCase]);
    expect(output.content.match(/page\.waitForEvent\('popup'/g) || []).toHaveLength(1);
    expect(output.content).not.toContain("context().waitForEvent('page')");
    expect(output.content).toContain('primary\\\\?mode=review$');
    expect(output.content).toContain('timeout: 10000');
    expect(output.content).not.toContain('.catch(() => {})');
  });

  test('keeps observed startup diagnostic-only for fresh and continuation contracts', () => {
    const base = {
      caseName: 'Session-sensitive assertion',
      ir: {
        caseId: 'session-sensitive',
        contextTransitions: [
          {
            kind: 'observed_start_state',
            observedUrl: 'https://app.example.test/dashboard?returnUrl=%2Fusers#ready',
          },
        ],
        steps: [{ op: 'assert', channel: 'UI_TEXT', expected: 'Dashboard' }],
      },
    };
    const fresh = playwrightPomJs.emitJourneySpec([{ ...base, sessionMode: 'fresh' }]);
    const continuation = playwrightPomJs.emitJourneySpec([
      { ...base, sessionMode: 'continue_from_dependency' },
    ]);
    const sameSession = playwrightPomJs.emitJourneySpec([
      { ...base, sessionContract: { mode: 'same_session' } },
    ]);
    expect(fresh.content).not.toContain('openDashboard(');
    expect(fresh.content).not.toContain('page.goto(');
    expect(continuation.content).not.toContain('openDashboard(');
    expect(sameSession.content).not.toContain('openDashboard(');
  });

  test('does not turn a declaration-only start URL into executable navigation', () => {
    const output = playwrightPomJs.emitJourneySpec([
      {
        caseName: 'Authored start contract',
        testCaseId: 'authored-start-contract',
        startUrl: 'https://app.example.test/authored-start?mode=ready#top',
        ir: {
          caseId: 'authored-start-contract',
          contextTransitions: [
            {
              kind: 'observed_start_state',
              observedUrl: 'https://app.example.test/observed-start',
            },
          ],
          steps: [{ op: 'assert', channel: 'UI_TEXT', expected: 'Ready' }],
        },
      },
    ]);

    expect(output.content.match(/\.openAuthoredStart\(/g) || []).toHaveLength(0);
    expect(output.content).not.toContain('page.goto(');
    expect(output.extraFiles['pages/AuthoredStartPage.js']).toBeUndefined();
    expect(joinedSources(output)).not.toContain('/observed-start');
  });

  test('keeps one authored navigation and never replaces it with an observed start URL', () => {
    const prepared = playwrightPomJs._prepareCasesForStandardOutput([
      {
        caseName: 'Authored navigation owns startup',
        ir: {
          caseId: 'authored-navigation-startup',
          contextTransitions: [
            {
              kind: 'observed_start_state',
              observedUrl: 'https://app.example.test/observed-start',
            },
          ],
          steps: [
            {
              op: 'act',
              action: 'navigate',
              url: 'https://app.example.test/authored-start',
              contractStepId: 'open-authored-start',
              authored: true,
              canonicalExecution: true,
              success: true,
              executionStatus: 'passed',
              origin: 'runtime_evidence',
            },
          ],
        },
      },
    ])[0];

    const navigations = prepared.ir.steps.filter(
      (step) => step.op === 'act' && step.action === 'navigate',
    );
    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toMatchObject({
      url: 'https://app.example.test/authored-start',
      contractStepId: 'open-authored-start',
      authored: true,
    });
    expect(navigations[0].setupOperation).not.toBe(true);
  });

  test('rejects missing, empty, and whitespace-only environment values without altering valid values', () => {
    const output = playwrightPomJs.emitJourneySpec([microsoftJourneyCase()], {
      scenarioName: 'Support contract',
    });
    const support = output.extraFiles['tests/support/replayir.js'];
    expect(support).toContain("value == null || String(value).trim() === ''");
    const readEnvSource = support.match(/function readEnv\(name\) \{[\s\S]*?\n\}/)?.[0];
    expect(readEnvSource).toBeTruthy();
    const readEnv = new Function('process', `${readEnvSource}; return readEnv;`)({
      env: { EMPTY: '', BLANK: '   \t', VALID: '  secret value  ' },
    });
    expect(() => readEnv('MISSING')).toThrow(
      /Missing or blank required environment variable MISSING/,
    );
    expect(() => readEnv('EMPTY')).toThrow(/Missing or blank required environment variable EMPTY/);
    expect(() => readEnv('BLANK')).toThrow(/Missing or blank required environment variable BLANK/);
    expect(readEnv('VALID')).toBe('  secret value  ');
  });

  test('leaves TypeScript output byte-identical before and after JavaScript generation', () => {
    const cases = [microsoftJourneyCase()];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
    try {
      const before = JSON.stringify(
        playwrightPom.emitJourneySpec(cases, { lang: 'ts', scenarioName: 'Authentication' }),
      );
      playwrightPomJs.emitJourneySpec(cases, { scenarioName: 'Authentication' });
      const after = JSON.stringify(
        playwrightPom.emitJourneySpec(cases, { lang: 'ts', scenarioName: 'Authentication' }),
      );
      expect(after).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not synthesize unresolved action targets in the shared TypeScript profile', () => {
    const unresolvedCase = {
      runResultId: 'run-ts-unresolved-target',
      testCaseId: 'ts-unresolved-target',
      caseName: 'TypeScript unresolved target baseline',
      ir: {
        version: 1,
        caseId: 'ts-unresolved-target',
        title: 'TypeScript unresolved target baseline',
        steps: [
          {
            op: 'act',
            action: 'click',
            target: 'Submit order',
            authored: true,
            contractStepId: 'submit-order',
            pageUrl: 'https://portal.example.test/orders',
          },
        ],
      },
    };
    const output = playwrightPom.emitJourneySpec([unresolvedCase], {
      lang: 'ts',
      scenarioName: unresolvedCase.caseName,
    });
    const manifest = JSON.parse(output.extraFiles['evidence/locator-manifest.json']);
    expect(manifest).toEqual([]);
    expect(output.content).not.toMatch(/ordersPage\.click[A-Z]\w*\(/);
    expect(Object.keys(output.extraFiles)).not.toContain('pages/OrdersPage.ts');
  });
});
