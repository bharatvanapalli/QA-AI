const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs');

const PAGE_URL = 'https://portal.example.test/profile';

function verifiedLocator(expression, { role, name, nodeId }) {
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'assertion-matrix-document',
    nodeId,
    connected: true,
  };
  return {
    strategy: 'role',
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
      targetIdentity: identity,
      matchedIdentity: { ...identity },
      count: 1,
      visible: true,
      enabled: true,
      source: 'verified_dom_inspection',
    },
    domAtlas: { verifiedActions: [{ expression }] },
    targetFacts: { role, accessibleName: name },
    pageIdentity: { pageTitle: 'User Profile' },
  };
}

function resolve(index, label, role = 'status') {
  const as = `assertionTarget${index}`;
  const expression = `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(label)}, exact: true })`;
  return {
    as,
    step: {
      op: 'resolve',
      as,
      contractStepId: `resolve-${index}`,
      elementLabel: label,
      actionLocator: verifiedLocator(expression, { role, name: label, nodeId: `node-${index}` }),
      candidates: [{ strategy: 'role', role, name: label }],
      authored: true,
      pageUrl: PAGE_URL,
      pageIdentity: { pageTitle: 'User Profile' },
    },
  };
}

function assertionMatrixCase() {
  const targets = [
    resolve(1, 'Profile status'),
    resolve(2, 'Profile heading', 'heading'),
    resolve(3, 'Account number'),
    resolve(4, 'Visible control', 'button'),
    resolve(5, 'Hidden control', 'button'),
    resolve(6, 'Username', 'textbox'),
    resolve(7, 'Role', 'combobox'),
    resolve(8, 'Remember me', 'checkbox'),
    resolve(9, 'Result rows', 'row'),
    resolve(10, 'Disclosure', 'button'),
    resolve(11, 'Enabled action', 'button'),
    resolve(12, 'Disabled action', 'button'),
    resolve(13, 'Editable name', 'textbox'),
    resolve(14, 'Read only email', 'textbox'),
  ];
  const [
    text,
    role,
    number,
    visible,
    hidden,
    value,
    selected,
    checked,
    count,
    attribute,
    enabled,
    disabled,
    editable,
    readOnly,
  ] = targets;
  const assertions = [
    {
      op: 'assert',
      channel: 'UI_TEXT',
      target: text.as,
      expected: 'Profile ready status wrapper',
      expectedSignals: { text: ['Profile ready', 'Profile ready status wrapper'] },
      contractRef: 'assert-text',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'UI_ROLE',
      target: role.as,
      expected: 'Profile heading',
      contractRef: 'assert-role',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'NUMBER',
      target: number.as,
      expected: 42,
      contractRef: 'assert-number',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'VISIBLE',
      target: visible.as,
      expected: true,
      contractRef: 'assert-visible',
      authored: true,
      flowCritical: true,
    },
    {
      op: 'assert',
      channel: 'HIDDEN',
      target: hidden.as,
      expected: true,
      contractRef: 'assert-hidden',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'VALUE',
      target: value.as,
      expected: 'alice',
      contractRef: 'assert-value',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'SELECTED',
      target: selected.as,
      expected: 'admin',
      contractRef: 'assert-selected',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'CHECKED',
      target: checked.as,
      contractRef: 'assert-checked',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'COUNT',
      target: count.as,
      contractRef: 'assert-count',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'ATTRIBUTE',
      target: attribute.as,
      contractRef: 'assert-attribute',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'ENABLED',
      target: enabled.as,
      expected: true,
      contractRef: 'assert-enabled',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'DISABLED',
      target: disabled.as,
      expected: true,
      contractRef: 'assert-disabled',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'EDITABLE',
      target: editable.as,
      expected: true,
      contractRef: 'assert-editable',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'READ_ONLY',
      target: readOnly.as,
      expected: true,
      contractRef: 'assert-read-only',
      authored: true,
    },
    {
      op: 'assert',
      channel: 'URL',
      expected: '/profile',
      contractRef: 'assert-url',
      authored: true,
      flowCritical: true,
    },
  ];
  return {
    caseName: 'Complete assertion matcher matrix',
    testCaseId: 'assertion-matrix',
    declaredAssertionsRaw: [
      {
        id: 'assert-checked',
        type: 'CHECKED',
        payload: { target: checked.as, expectedChecked: false },
      },
      {
        id: 'assert-count',
        type: 'COUNT',
        payload: { target: count.as, expectedCount: 3, comparator: 'gte' },
      },
      {
        id: 'assert-attribute',
        type: 'ATTRIBUTE',
        payload: { target: attribute.as, attributeName: 'aria-expanded', expectedValue: 'true' },
      },
    ],
    ir: {
      caseId: 'assertion-matrix',
      title: 'Complete assertion matcher matrix',
      steps: [...targets.map((target) => target.step), ...assertions],
      verdict: { status: 'pass', perAssertionOutcomes: [] },
    },
  };
}

describe('Playwright POM JavaScript assertion matcher matrix', () => {
  test('preserves every assertion once with typed matchers and authored continuation semantics', () => {
    const sourceCase = assertionMatrixCase();
    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const normalizedAssertions = prepared.ir.steps.filter((step) => step.op === 'assert');
    expect(normalizedAssertions).toHaveLength(15);
    expect(
      new Set(normalizedAssertions.map((step) => step.contractRef || step.contractStepId)).size,
    ).toBe(15);
    expect(
      normalizedAssertions.find((step) => step.contractRef === 'assert-checked'),
    ).toMatchObject({ expected: false, expectedChecked: false });
    expect(normalizedAssertions.find((step) => step.contractRef === 'assert-count')).toMatchObject({
      expected: 3,
      expectedCount: 3,
      comparator: 'gte',
    });
    expect(
      normalizedAssertions.find((step) => step.contractRef === 'assert-attribute'),
    ).toMatchObject({ expected: 'true', expectedValue: 'true', attributeName: 'aria-expanded' });

    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Assertion Matrix',
    });
    const source = output.content;
    const pageSource = output.extraFiles['pages/UserProfilePage.js'];
    expect(source.match(/await userProfilePage\.assert[A-Za-z0-9_$]+\(/g) || []).toHaveLength(15);
    expect(pageSource.match(/async assert[A-Za-z0-9_$]+\(/g) || []).toHaveLength(15);
    expect(source).toContain('assertProfileStatusUiText("Profile ready")');
    expect(source).toContain('assertAccountNumberStatusNumber("42")');
    expect(source).toContain('assertUsernameValue("alice")');
    expect(source).toContain('assertRoleSelected("admin")');
    expect(source).toContain('assertResultRowsRowCount("3")');
    expect(source).toContain('assertDisclosureAttribute("true")');
    expect(source).toContain('assertPageUrl("/profile")');
    expect(pageSource).toContain('.toContainText(String(expected)');
    expect(pageSource).toContain('.toHaveText(String(expected)');
    expect(pageSource.match(/\.toHaveValue\(String\(expected\)/g) || []).toHaveLength(2);
    expect(pageSource).toContain('.not.toBeChecked(');
    expect(pageSource).toContain('.toBeGreaterThanOrEqual(Number(expected))');
    expect(pageSource).toContain('.toHaveAttribute("aria-expanded", String(expected)');
    expect(pageSource).toContain('.toBeEnabled(');
    expect(pageSource).toContain('.toBeDisabled(');
    expect(pageSource).toContain('.toBeEditable(');
    expect(pageSource).toContain('.not.toBeEditable(');
    expect(pageSource).toContain('.toBeHidden(');
    expect(pageSource).toContain('expect(this.page).toHaveURL(');
    expect(pageSource).toMatch(/expect\.soft\([^\n]*profileStatus/i);
    expect(pageSource).toMatch(/await expect\([^\n]*visibleControl/i);
    expect(pageSource).not.toMatch(/expect\.soft\([^\n]*visibleControl/i);
    expect(pageSource).not.toMatch(/expect\.configure\(\{ soft: true \}\)\(/);
    expect([source, pageSource].join('\n')).not.toContain('Authored assertion could not be evaluated');
  });

  test('keeps a targeted assertion with no authored expected value diagnostic-only and nonblocking', () => {
    const sourceCase = assertionMatrixCase();
    const assertion = sourceCase.ir.steps.find(
      (step) => step.op === 'assert' && step.contractRef === 'assert-text',
    );
    delete assertion.expected;
    delete assertion.expectedSignals;
    assertion.missingAuthoredExpected = true;
    assertion.authoredContractText = 'Profile status should match the authored value';

    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Missing Expected Assertion',
    });
    const pageSource = output.extraFiles['pages/UserProfilePage.js'];
    const diagnostics = JSON.parse(output.extraFiles['evidence/assertion-diagnostics.json']);
    expect(pageSource).not.toContain('assertProfileStatusUiText');
    expect(output.content).not.toContain('assertProfileStatusUiText');
    expect([output.content, pageSource].join('\n')).not.toContain('QAAI_ASSERTION_CONTRACT_UNRESOLVED');
    expect(diagnostics.summary).toEqual({ diagnosticCount: 1, blockingCount: 0 });
    expect(diagnostics.assertions).toEqual([
      expect.objectContaining({
        contractRef: 'assert-text',
        channel: 'UI_TEXT',
        reason: 'missing_expected_value',
        nonBlocking: true,
        runnableCodeEmitted: false,
      }),
    ]);
  });

  test('keeps failed targetless narrative assertions out of runnable code without blocking executed actions', () => {
    const malformedAssertions = ['001', '003', '004', '008', '009', '010', '011'].map((suffix) => ({
      op: 'assert',
      assertionId: `case-assertions.assertion.${suffix}`,
      contractRef: `case-assertions.assertion.${suffix}`,
      channel: 'UI_TEXT',
      expected: null,
      authored: true,
      canonicalExecution: true,
      checked: true,
      executionStatus: 'failed',
      liveOutcome: 'not_matched',
      outcome: 'not_matched',
      evidence: {
        source: 'MCP',
        outcome: 'not_matched',
        snapshotText: 'A narrative verification sentence was not a concrete expected value.',
      },
    }));
    const sourceCase = {
      caseName: 'Preserve executed prefix',
      ir: {
        caseId: 'case-assertions',
        steps: [
          {
            op: 'act',
            action: 'navigate',
            url: 'https://example.test/dashboard',
            contractStepId: 'open-dashboard',
          },
          ...malformedAssertions,
        ],
      },
    };

    const output = playwrightPomJs.emitJourneySpec([sourceCase], {
      scenarioName: 'Malformed Runtime Assertions',
    });
    const diagnostics = JSON.parse(output.extraFiles['evidence/assertion-diagnostics.json']);
    const userSources = [
      output.content,
      ...Object.entries(output.extraFiles)
        .filter(([file]) => /^(?:pages|tests)\/.+\.js$/.test(file))
        .map(([, source]) => source),
    ].join('\n');

    expect(output.content).toContain('openDashboard');
    expect(diagnostics.summary).toEqual({ diagnosticCount: 7, blockingCount: 0 });
    expect(diagnostics.assertions).toHaveLength(7);
    expect(diagnostics.assertions.every((entry) =>
      entry.reason === 'missing_expected_value'
      && entry.nonBlocking === true
      && entry.runnableCodeEmitted === false)).toBe(true);
    expect(userSources).not.toMatch(/assert[A-Za-z0-9_]*\((?:""|'')\)/);
    expect(userSources).not.toContain('QAAI_ASSERTION_CONTRACT_UNRESOLVED');
    expect(userSources).not.toContain('expect.soft(false');
  });
});
