const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs');
const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom');

const PAGE_URL = 'https://app.example.test/automation-playground';

function verifiedLocator(expression, { role = 'button', name }) {
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'action-matrix-document',
    nodeId: `node-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
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
    pageIdentity: { pageTitle: 'Automation Playground' },
  };
}

function locatorBackedAction(
  index,
  action,
  label,
  { role = 'button', value, key, destinationTarget } = {},
) {
  const target = `target${index}`;
  const expression =
    role === 'textbox'
      ? `getByLabel(${JSON.stringify(label)}, { exact: true })`
      : `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(label)}, exact: true })`;
  const actionLocator = verifiedLocator(expression, { role, name: label });
  return {
    target,
    resolve: {
      op: 'resolve',
      as: target,
      contractStepId: `action-${index}`,
      elementLabel: label,
      actionLocator,
      candidates: [{ strategy: 'role', role, name: label }],
      authored: true,
      pageUrl: PAGE_URL,
      pageTitle: 'Automation Playground',
    },
    act: {
      op: 'act',
      action,
      target,
      targetLabel: label,
      contractStepId: `action-${index}`,
      actionLocator,
      authored: true,
      pageUrl: PAGE_URL,
      pageTitle: 'Automation Playground',
      ...(value !== undefined ? { value } : {}),
      ...(key !== undefined ? { key, value: key } : {}),
      ...(destinationTarget ? { destinationTarget } : {}),
    },
  };
}

function pageLevelAction(index, action, extra = {}) {
  return {
    op: 'act',
    action,
    contractStepId: `page-action-${index}`,
    authored: true,
    pageUrl: PAGE_URL,
    pageTitle: 'Automation Playground',
    ...extra,
  };
}

function actionMatrixCase() {
  const destination = locatorBackedAction(99, 'hover', 'Drop destination');
  const targeted = [
    locatorBackedAction(1, 'click', 'Primary action'),
    locatorBackedAction(2, 'doubleClick', 'Secondary action'),
    locatorBackedAction(3, 'tripleClick', 'Tertiary action'),
    locatorBackedAction(4, 'fill', 'Username', { role: 'textbox', value: 'alice' }),
    locatorBackedAction(5, 'type', 'Search terms', { role: 'textbox', value: 'query' }),
    locatorBackedAction(6, 'selectOption', 'Country', { role: 'combobox', value: 'US' }),
    locatorBackedAction(7, 'check', 'Terms', { role: 'checkbox' }),
    locatorBackedAction(8, 'uncheck', 'Newsletter', { role: 'checkbox' }),
    locatorBackedAction(9, 'press', 'Keyboard target', { role: 'textbox', key: 'Enter' }),
    locatorBackedAction(10, 'hover', 'Help'),
    locatorBackedAction(11, 'drag', 'Drag source', { destinationTarget: destination.target }),
    locatorBackedAction(12, 'upload', 'Attachment', { value: 'tests/fixtures/document.pdf' }),
  ];
  const pageLevel = [
    pageLevelAction(1, 'navigate', { url: PAGE_URL }),
    pageLevelAction(2, 'navigateBack'),
    pageLevelAction(3, 'navigateForward'),
    pageLevelAction(4, 'handleDialog', { accept: false, expectedMessage: 'Discard changes?' }),
    pageLevelAction(5, 'resize', { width: 1440, height: 900 }),
    pageLevelAction(6, 'close'),
  ];
  return {
    caseName: 'Complete Playwright action method matrix',
    testCaseId: 'action-method-matrix',
    declaredSteps: [
      ...pageLevel.map((step) => ({ id: step.contractStepId, action: step.action, ...step })),
      ...targeted.map(({ act }) => ({
        id: act.contractStepId,
        action: act.action,
        target: act.targetLabel,
      })),
    ],
    ir: {
      caseId: 'action-method-matrix',
      title: 'Complete Playwright action method matrix',
      steps: [
        pageLevel[0],
        ...targeted.flatMap(({ resolve, act }) => [resolve, act]),
        destination.resolve,
        ...pageLevel.slice(1),
      ],
      verdict: { status: 'pass', perAssertionOutcomes: [] },
    },
  };
}

function occurrences(source, pattern) {
  return (source.match(pattern) || []).length;
}

describe('Playwright POM JavaScript authored action method matrix', () => {
  test('centralizes every supported authored action as exactly one POM method and one spec call', () => {
    const output = playwrightPomJs.emitJourneySpec([actionMatrixCase()], {
      scenarioName: 'Action Method Matrix',
    });
    const pageSources = Object.entries(output.extraFiles || {})
      .filter(([file]) => /^pages\/.*\.js$/.test(file))
      .map(([, source]) => source)
      .join('\n');
    const methodNames = [...pageSources.matchAll(/\basync\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map(
      (match) => match[1],
    );
    const specCalls = [
      ...output.content.matchAll(
        /\bawait\s+[A-Za-z_$][A-Za-z0-9_$]*Page\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g,
      ),
    ].map((match) => match[1]);

    expect(
      methodNames,
      `Generated POM methods: ${JSON.stringify(methodNames)}; spec calls: ${JSON.stringify(specCalls)}`,
    ).toHaveLength(18);
    expect(new Set(methodNames).size).toBe(18);
    expect(specCalls).toHaveLength(18);
    expect(new Set(specCalls).size).toBe(18);
    for (const methodName of methodNames) {
      expect(specCalls.filter((name) => name === methodName)).toHaveLength(1);
    }

    for (const body of [
      'this.page.goto("https://app.example.test/automation-playground", { waitUntil: "domcontentloaded" })',
      'this.page.goBack({ waitUntil: "domcontentloaded" })',
      'this.page.goForward({ waitUntil: "domcontentloaded" })',
      "this.page.once('dialog'",
      'this.page.setViewportSize({ width: 1440, height: 900 })',
      'this.page.close()',
      '.fill(value)',
      '.pressSequentially(value)',
      '.click(options)',
      '.dblclick(options)',
      '.click({ ...options, clickCount: 3 })',
      '.selectOption(value)',
      '.check()',
      '.uncheck()',
      '.press(value)',
      '.hover()',
      '.dragTo(target)',
      '.setInputFiles(value)',
    ]) {
      expect(pageSources).toContain(body);
    }

    expect(output.content).not.toMatch(
      /\bawait\s+page\.(?:goto|goBack|goForward|setViewportSize|close)\s*\(/,
    );
    expect(output.content).not.toMatch(/\bawait\s+page\.(?:getBy|locator\s*\()/);
    expect(output.content).not.toMatch(/QAAI_FALLBACK_ACTION|test\.info\(\)\.annotations\.push/);
  });

  test('guards every locator-backed optional action exactly once inside its POM method', () => {
    const sourceCase = actionMatrixCase();
    const locatorActions = new Set([
      'click',
      'doubleClick',
      'tripleClick',
      'fill',
      'type',
      'selectOption',
      'check',
      'uncheck',
      'press',
      'hover',
      'drag',
      'upload',
    ]);
    for (const step of sourceCase.ir.steps) {
      if (step.op === 'act' && locatorActions.has(step.action)) step.optional = true;
    }
    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Optional Action Method Matrix',
    });
    const pageSources = Object.entries(output.extraFiles || {})
      .filter(([file]) => /^pages\/.*\.js$/.test(file))
      .map(([, source]) => source)
      .join('\n');

    expect(pageSources.match(/const appeared = await optionalTarget\.waitFor/g) || []).toHaveLength(12);
    expect(pageSources.match(/if \(appeared\) \{/g) || []).toHaveLength(12);
    expect(output.content).not.toContain('const appeared = await optionalTarget.waitFor');
  });

  test('preserves page-level method payloads through graph merge and regeneration', () => {
    const output = playwrightPomJs.emitJourneySpec([actionMatrixCase()], {
      scenarioName: 'Action Method Matrix',
    });
    const mergedGraph = playwrightPom._mergePomGraphs([output.pomGraph], {
      lang: 'js',
      moduleFormat: 'esm',
    });
    const regenerated = playwrightPom._emitPomGraphFiles(mergedGraph, {
      lang: 'js',
      moduleFormat: 'esm',
    });
    const pageSources = Object.entries(regenerated)
      .filter(([file]) => /^pages\/.*\.js$/.test(file))
      .map(([, source]) => source)
      .join('\n');

    expect(pageSources).toContain('this.page.goto("https://app.example.test/automation-playground", { waitUntil: "domcontentloaded" })');
    expect(pageSources).not.toContain('this.page.goto("")');
    expect(pageSources).toContain('Discard changes?');
    expect(pageSources).toContain('dialog.dismiss()');
    expect(pageSources).toContain('this.page.setViewportSize({ width: 1440, height: 900 })');
  });
});
