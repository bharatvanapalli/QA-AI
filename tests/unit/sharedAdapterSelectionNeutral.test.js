const adapterRegistry = require('../../server/services/codegen/adapters');
const resiliencyRules = require('../../server/services/codegen/adapters/resiliencyRules');
const regressionCorpus = require('../../server/services/codegen/adapters/regressionCorpus');

describe('website-neutral shared adapter selection', () => {
  test('selects only an exact registered framework id in deterministic order', () => {
    expect(adapterRegistry.getAdapter('playwright-pom-js')).toBe(adapterRegistry.playwrightPomJs);
    expect(adapterRegistry.getAdapter('PLAYWRIGHT-POM-JS')).toBeNull();
    expect(adapterRegistry.getAdapter('playwright-pom')).toBe(adapterRegistry.playwrightPom);
    expect(adapterRegistry.listAdapters()).toEqual([...adapterRegistry.listAdapters()].sort());

    const selection = adapterRegistry.resolveAdapterSelection('playwright-pom-js');
    expect(selection.selectedFramework).toBe('playwright-pom-js');
    expect(selection.legacyFallbackUsed).toBe(false);
  });

  test('emits a helper diagnostic for an unsupported framework without selecting a fallback', () => {
    const result = adapterRegistry.resolveAdapterSelection('unregistered-framework');

    expect(result.supported).toBe(false);
    expect(result.outputKind).toBe('diagnostic-helper');
    expect(result.adapterId).toBeNull();
    expect(result.selectedFramework).toBeNull();
    expect(result.legacyFallbackUsed).toBe(false);
    expect(result.diagnostics[0].code).toBe('adapter_framework_unsupported');
    expect(result.files.QAAI_ADAPTER_DIAGNOSTIC_JSON).toBeUndefined();
    expect(result.files['QAAI_ADAPTER_DIAGNOSTIC.json']).toContain('adapter_framework_unsupported');
  });

  test('emits a helper diagnostic for an unsupported operation without invoking another adapter', () => {
    const result = adapterRegistry.dispatchAdapterOperation('playwright-pom-js', 'notImplemented');

    expect(result.supported).toBe(false);
    expect(result.adapterId).toBe('playwright-pom-js');
    expect(result.diagnostics[0].code).toBe('adapter_operation_unsupported');
    expect(result.diagnostics[0].message).toContain('No legacy adapter or alternate framework was invoked.');
  });

  test('passes authored ReplayIR, provenance, typed bindings, and transitions by identity', () => {
    const probeOperation = '__trackNIdentityProbe';
    const replayIR = {
      steps: [{ id: 'STEP_ONE', authored: true }],
      locatorProvenance: { status: 'verified', source: 'runtime_dom' },
      bindings: [{ name: 'amount', valueType: 'number', kind: 'inline' }],
      contextTransitions: [{ kind: 'popup_observed', authored: false, observed: true }],
    };
    const options = { projectId: 'PROJECT_SCOPE' };
    adapterRegistry.playwrightPomJs[probeOperation] = (...args) => args;

    try {
      const result = adapterRegistry.dispatchAdapterOperation(
        'playwright-pom-js',
        probeOperation,
        [replayIR, options],
      );

      expect(result.supported).toBe(true);
      expect(result.selectedFramework).toBe('playwright-pom-js');
      expect(result.legacyFallbackUsed).toBe(false);
      expect(result.dispatchInput.arguments[0]).toBe(replayIR);
      expect(result.dispatchInput.arguments[1]).toBe(options);
      expect(result.output[0]).toBe(replayIR);
      expect(result.output[1]).toBe(options);
    } finally {
      delete adapterRegistry.playwrightPomJs[probeOperation];
    }
  });

  test('keeps accessible names exact and emits one verified locator without an OR chain', () => {
    const capturedName = '(6) Primary action';
    expect(resiliencyRules.nameArg(capturedName)).toBe(JSON.stringify(capturedName));
    expect(resiliencyRules.semanticRegex(capturedName).test(capturedName)).toBe(true);
    expect(resiliencyRules.semanticRegex(capturedName).test('Primary action')).toBe(false);
    expect(resiliencyRules.semanticRegex(capturedName).test('(6) primary action')).toBe(false);

    const expression = resiliencyRules.buildOrChain([
      { strategy: 'role', role: 'button', name: capturedName },
      {
        strategy: 'css',
        selector: '[data-qa="primary-action"]',
        verificationStatus: 'verified',
        verificationSource: 'runtime_dom',
      },
    ]);
    expect(expression).toBe('page.locator("[data-qa=\\"primary-action\\"]")');
    expect(expression).not.toContain('.or(');
    expect(expression).not.toContain('RegExp');
  });

  test('retains frame, shadow, popup, and wait evidence without inventing operations', () => {
    const exactExpression = 'secondaryPage.frameLocator("#frame").locator("#host").getByText("Ready", { exact: true })';
    const plan = resiliencyRules.buildLocatorPlan([{
      selected: true,
      expression: exactExpression,
      verificationStatus: 'verified',
      verificationSource: 'runtime_dom',
      pageAlias: 'secondaryPage',
      popupIdentity: 'observedPopup',
      framePath: ['#frame'],
      shadowPath: ['#host'],
      waitContract: { timeoutMs: 5000, condition: 'visible' },
      contextTransition: { kind: 'popup_observed', authored: false },
    }]);

    expect(plan.expression).toBe(exactExpression);
    expect(plan.provenance).toMatchObject({ source: 'runtime_dom', status: 'verified' });
    expect(plan.context).toMatchObject({
      pageAlias: 'secondaryPage',
      popupIdentity: 'observedPopup',
      framePath: ['#frame'],
      shadowPath: ['#host'],
      waitContract: { timeoutMs: 5000, condition: 'visible' },
    });
    expect(JSON.stringify(plan)).not.toContain('page.goto');
    expect(plan.warnings).toEqual([]);
  });

  test('uses only a website-neutral regression contract', () => {
    const serialized = JSON.stringify(regressionCorpus).toLowerCase();
    for (const forbidden of ['username', 'password', 'login', 'dashboard', 'approvalcode', 'product', 'brand']) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(regressionCorpus.cases).toHaveLength(2);
    expect(regressionCorpus.cases.every((entry) => entry.replayIR === regressionCorpus.neutralReplayIR)).toBe(true);
    expect(regressionCorpus.neutralReplayIR.bindings[0]).toMatchObject({
      kind: 'workbook_column',
      valueType: 'string',
      source: 'case_scoped_data_rows',
      column: 'authoredInput',
      proof: { usable: true, caseId: 'CONTRACT_CASE' },
    });
    expect(regressionCorpus.neutralReplayIR.steps.map((step) => step.op)).toEqual([
      'handlePopup', 'resolve', 'act', 'waitFor', 'assert', 'humanInput',
    ]);
    expect(regressionCorpus.neutralReplayIR.steps.every((step) => step.authored === true)).toBe(true);
    const resolveStep = regressionCorpus.neutralReplayIR.steps.find((step) => step.op === 'resolve');
    expect(resolveStep.candidates[0]).toMatchObject({
      verificationStatus: 'verified',
      verificationSource: 'runtime_dom',
      unique: true,
      actionable: true,
    });
    expect(regressionCorpus.neutralReplayIR.contextTransitions[0]).toMatchObject({
      authored: false,
      observed: true,
    });
  });
});
