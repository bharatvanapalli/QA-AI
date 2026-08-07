const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs');

function verifiedContinueLocator({ documentId, nodeId, pageTitle }) {
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId,
    nodeId,
    connected: true,
  };
  const expression = 'getByRole("button", { name: "Continue", exact: true })';
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
    targetFacts: { role: 'button', accessibleName: 'Continue' },
    pageIdentity: { pageTitle },
  };
}

function pageAction({ id, target, pageTitle, pageUrl, documentId, nodeId }) {
  const actionLocator = verifiedContinueLocator({ documentId, nodeId, pageTitle });
  return [
    {
      op: 'resolve',
      as: target,
      contractStepId: id,
      elementLabel: 'Continue',
      actionLocator,
      candidates: [{ strategy: 'role', role: 'button', name: 'Continue' }],
      authored: true,
      pageUrl,
      pageIdentity: { pageTitle },
    },
    {
      op: 'act',
      action: 'click',
      target,
      targetLabel: 'Continue',
      contractStepId: id,
      actionLocator,
      authored: true,
      pageUrl,
      pageIdentity: { pageTitle },
    },
  ];
}

function verifiedAction({
  id,
  action,
  target,
  label,
  expression,
  role,
  accessibleName,
  pageTitle,
  pageUrl,
  documentId,
  nodeId,
}) {
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId,
    nodeId,
    connected: true,
  };
  const actionLocator = {
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
    targetFacts: { role, accessibleName },
    context: { documentUrl: pageUrl },
    pageIdentity: { pageTitle },
  };
  return [
    {
      op: 'resolve',
      as: target,
      contractStepId: id,
      elementLabel: label,
      actionLocator,
      candidates: [{ strategy: 'role', role, name: accessibleName }],
      authored: true,
      pageIdentity: { pageTitle },
    },
    {
      op: 'act',
      action,
      target,
      targetLabel: label,
      contractStepId: id,
      actionLocator,
      authored: true,
      pageIdentity: { pageTitle },
    },
  ];
}

describe('Playwright POM JavaScript captured page ownership', () => {
  test('keeps identical control labels attached to their exact captured page context', () => {
    const account = pageAction({
      id: 'account-continue',
      target: 'accountContinue',
      pageTitle: 'Account Entry',
      pageUrl: 'https://portal.example.test/session/account',
      documentId: 'document-account',
      nodeId: 'node-account-continue',
    });
    const verification = pageAction({
      id: 'verification-continue',
      target: 'verificationContinue',
      pageTitle: 'Verification Challenge',
      pageUrl: 'https://portal.example.test/session/verification',
      documentId: 'document-verification',
      nodeId: 'node-verification-continue',
    });
    const output = playwrightPomJs.emitJourneySpec(
      [
        {
          caseName: 'Continue through two captured page contexts',
          testCaseId: 'captured-page-ownership',
          declaredSteps: [
            {
              id: 'account-continue',
              action: 'click',
              target: 'Continue',
              pageTitle: 'Account Entry',
            },
            {
              id: 'verification-continue',
              action: 'click',
              target: 'Continue',
              pageTitle: 'Verification Challenge',
            },
          ],
          ir: {
            caseId: 'captured-page-ownership',
            title: 'Continue through two captured page contexts',
            steps: [...account, ...verification],
            verdict: { status: 'pass', perAssertionOutcomes: [] },
          },
        },
      ],
      { scenarioName: 'Captured Page Ownership' },
    );

    const accountPage = output.extraFiles['pages/AccountEntryPage.js'];
    const verificationPage = output.extraFiles['pages/VerificationChallengePage.js'];
    expect(accountPage).toBeTruthy();
    expect(verificationPage).toBeTruthy();
    expect(accountPage.match(/async clickContinue\(/g)).toHaveLength(1);
    expect(verificationPage.match(/async clickContinue\(/g)).toHaveLength(1);
    expect(output.content.match(/await accountEntryPage\.clickContinue\(\);/g)).toHaveLength(1);
    expect(
      output.content.match(/await verificationChallengePage\.clickContinue\(\);/g),
    ).toHaveLength(1);

    const pageFiles = Object.keys(output.extraFiles).filter((file) =>
      /^pages\/.*Page\.js$/.test(file),
    );
    expect(pageFiles).toEqual(
      expect.arrayContaining(['pages/AccountEntryPage.js', 'pages/VerificationChallengePage.js']),
    );
    expect(pageFiles).not.toEqual(
      expect.arrayContaining([
        'pages/RootPage.js',
        'pages/ApplicationPage.js',
        'pages/WorkspacePage.js',
        'pages/AuthorizePage.js',
      ]),
    );
  });

  test('does not split one observed browser context into implementation-acronym pages', () => {
    const first = pageAction({
      id: 'first-action',
      target: 'firstContinue',
      pageTitle: 'Customer Login',
      pageUrl: 'https://portal.example.test/customer/login',
      documentId: 'document-login',
      nodeId: 'node-first-continue',
    });
    const second = pageAction({
      id: 'second-action',
      target: 'secondContinue',
      pageTitle: 'OIDC Adapter',
      pageUrl: 'https://portal.example.test/customer/login',
      documentId: 'document-login',
      nodeId: 'node-second-continue',
    });
    const output = playwrightPomJs.emitJourneySpec(
      [
        {
          caseName: 'Remain on one observed login page',
          testCaseId: 'one-observed-context',
          declaredSteps: [],
          ir: {
            caseId: 'one-observed-context',
            title: 'Remain on one observed login page',
            steps: [...first, ...second],
            verdict: { status: 'pass', perAssertionOutcomes: [] },
          },
        },
      ],
      { scenarioName: 'Observed Context Consolidation' },
    );

    const pageFiles = Object.keys(output.extraFiles).filter((file) =>
      /^pages\/.*Page\.js$/.test(file),
    );
    expect(pageFiles).toEqual(['pages/CustomerLoginPage.js']);
    expect(pageFiles).not.toContain('pages/OidcAdapterPage.js');
    expect(output.content).not.toContain('oidcAdapterPage');
    expect(output.extraFiles['pages/CustomerLoginPage.js']).not.toContain('usePage(');
  });

  test('owns provider actions and final assertions by observed browser context', () => {
    const appUrl = 'https://portal.example.test/customer/login';
    const providerUrl = 'https://identity.example.test/common/signin';
    const homeUrl = 'https://portal.example.test/home';
    const chooseProvider = verifiedAction({
      id: 'choose-provider',
      action: 'click',
      target: 'providerButton',
      label: 'Continue with identity provider',
      expression: 'getByRole("button", { name: "Continue with identity provider", exact: true })',
      role: 'button',
      accessibleName: 'Continue with identity provider',
      pageTitle: 'Customer Login',
      pageUrl: appUrl,
      documentId: 'document-app',
      nodeId: 'node-provider-button',
    });
    const enterAccount = verifiedAction({
      id: 'enter-account',
      action: 'fill',
      target: 'accountInput',
      label: 'Account',
      expression: 'getByRole("textbox", { name: "Account", exact: true })',
      role: 'textbox',
      accessibleName: 'Account',
      pageTitle: 'Company Sign In',
      pageUrl: providerUrl,
      documentId: 'document-provider',
      nodeId: 'node-account-input',
    });
    const dismissPrompt = verifiedAction({
      id: 'dismiss-prompt',
      action: 'click',
      target: 'dismissPromptButton',
      label: 'No',
      expression: 'getByRole("button", { name: "No", exact: true })',
      role: 'button',
      accessibleName: 'No',
      pageTitle: 'Stay signed in',
      pageUrl: providerUrl,
      documentId: 'document-provider',
      nodeId: 'node-dismiss-prompt',
    });
    const welcome = verifiedAction({
      id: 'welcome-message',
      action: 'check',
      target: 'welcomeMessage',
      label: 'Welcome message',
      expression: 'getByRole("status", { name: new RegExp("Welcome.*ready", "i") })',
      role: 'status',
      accessibleName: 'Welcome — ready ✓',
      pageTitle: 'Home Dashboard',
      pageUrl: homeUrl,
      documentId: 'document-home',
      nodeId: 'node-welcome-message',
    });
    const welcomeResolve = welcome[0];
    dismissPrompt[1].optional = true;
    const output = playwrightPomJs.emitJourneySpec(
      [
        {
          caseName: 'Continue through observed authentication contexts',
          testCaseId: 'observed-auth-contexts',
          declaredSteps: [],
          ir: {
            caseId: 'observed-auth-contexts',
            title: 'Continue through observed authentication contexts',
            steps: [
              ...chooseProvider,
              ...enterAccount,
              ...dismissPrompt,
              welcomeResolve,
              {
                op: 'assert',
                channel: 'DOM',
                contractStepId: 'welcome-message',
                target: 'welcomeMessage',
                assertion: 'visible',
                expected: 'Welcome — ready ✓',
                authored: true,
                pageUrl: homeUrl,
                pageIdentity: { pageTitle: 'Home Dashboard' },
              },
              {
                op: 'assert',
                channel: 'PAGE',
                contractStepId: 'signed-in-page-copy',
                expectedSignals: { text: ['Signed in successfully'] },
                expected: 'Signed in successfully',
                authored: true,
                pageUrl: homeUrl,
                pageIdentity: { pageTitle: 'Home Dashboard' },
              },
            ],
            verdict: { status: 'pass', perAssertionOutcomes: [] },
          },
        },
      ],
      { scenarioName: 'Observed Authentication Contexts' },
    );

    const appPage = output.extraFiles['pages/CustomerLoginPage.js'];
    const providerPage = output.extraFiles['pages/CompanySignInPage.js'];
    const homePage = output.extraFiles['pages/HomeDashboardPage.js'];
    expect(appPage).toBeTruthy();
    expect(providerPage).toBeTruthy();
    expect(homePage).toBeTruthy();
    expect(providerPage).toContain('clickNo');
    expect(appPage).not.toContain('clickNo');
    expect(homePage).toContain('welcomeReadyStatus');
    expect(homePage).toContain('async assertWelcomeReadyStatusDom(expected)');
    expect(output.extraFiles['locators/generated/homeDashboardPage.generated.locators.js'])
      .toContain('new RegExp("Welcome.*ready", "i")');
    expect(output.content).toContain('homeDashboardPage');
    const homeLocators = output.extraFiles['locators/generated/homeDashboardPage.generated.locators.js'];
    expect(homeLocators).toContain('page.getByText("Signed in successfully", { exact: false })');
    const locatorManifest = JSON.parse(output.extraFiles['evidence/locator-manifest.json']);
    const authoredAssertionLocator = locatorManifest.find((entry) => entry.name === 'signedInSuccessfullyPage');
    expect(authoredAssertionLocator).toMatchObject({
      source: 'authoredAssertionContract',
      verificationStatus: 'authored_contract',
      contractual: true,
      caseKey: 'observed-auth-contexts',
      contractStepId: 'signed-in-page-copy',
    });
    expect(homePage).not.toContain('this.page.getByText(');
    expect(providerPage).toContain("\n    const appeared = await optionalTarget.waitFor(");
    expect(providerPage).not.toContain("\n        const appeared = await optionalTarget.waitFor(");
    const architectReport = JSON.parse(output.extraFiles['evidence/pom-architect-report.json']);
    expect(architectReport.specPlan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contractStepId: 'choose-provider',
        action: 'click',
        exportedPageMethod: 'clickContinueWithIdentityProvider',
      }),
      expect.objectContaining({
        contractStepId: 'signed-in-page-copy',
        op: 'assert',
        exportedPageMethod: 'assertSignedInSuccessfullyPage',
      }),
    ]));
    expect(output.content).toContain('assertWelcomeReadyStatusDom("Welcome — ready ✓")');

    for (const [fileName, source] of Object.entries(output.extraFiles)) {
      if (!/^(pages|locators)\/.*\.js$/.test(fileName)) continue;
      expect(source).not.toContain('usePage(');
      const comments = source
        .split('\n')
        .filter((line) => line.trim().startsWith('//'))
        .join('\n');
      expect(comments).toMatch(/^[\x00-\x7F]*$/);
    }
  });

  test('assigns URL-less post-action checks to the next verified browser context', () => {
    const listingUrl = 'https://portal.example.test/orders';
    const creationUrl = 'https://portal.example.test/orders/create';
    const openCreate = verifiedAction({
      id: 'open-create',
      action: 'click',
      target: 'createButton',
      label: 'Create',
      expression: 'getByRole("button", { name: "Create", exact: true })',
      role: 'button',
      accessibleName: 'Create',
      pageTitle: 'Orders',
      pageUrl: listingUrl,
      documentId: 'document-orders',
      nodeId: 'node-create',
    });
    const createHeading = verifiedAction({
      id: 'create-heading',
      action: 'check',
      target: 'createHeading',
      label: 'Create Order',
      expression: 'getByRole("heading", { name: "Create Order", exact: true })',
      role: 'heading',
      accessibleName: 'Create Order',
      pageTitle: 'Create Order',
      pageUrl: creationUrl,
      documentId: 'document-create-order',
      nodeId: 'node-create-heading',
    });
    const output = playwrightPomJs.emitJourneySpec([
      {
        caseName: 'Open a creation form',
        testCaseId: 'context-transition-checks',
        declaredSteps: [],
        ir: {
          caseId: 'context-transition-checks',
          title: 'Open a creation form',
          steps: [
            ...openCreate,
            {
              op: 'waitFor',
              contractStepId: 'wait-create-form',
              condition: { type: 'pageState', timeoutMs: 5000 },
              authored: true,
            },
            {
              op: 'assert',
              channel: 'PAGE',
              contractStepId: 'assert-general-information',
              expectedSignals: { text: ['General Information'] },
              expected: 'General Information',
              authored: true,
            },
            createHeading[0],
          ],
          verdict: { status: 'pass', perAssertionOutcomes: [] },
        },
      },
    ], { scenarioName: 'Observed Route Transition' });

    const pageFiles = Object.keys(output.extraFiles).filter((file) =>
      /^pages\/.*Page\.js$/.test(file),
    );
    expect(pageFiles).toContain('pages/OrdersPage.js');
    const creationPageFile = pageFiles.find((file) => /^pages\/Create.*Page\.js$/.test(file));
    expect(creationPageFile).toBeTruthy();
    expect(pageFiles).not.toContain('pages/GeneralInformationPage.js');
    expect(output.extraFiles[creationPageFile]).toContain(
      'assertGeneralInformationPage',
    );
    expect(output.content).toMatch(/create\w*Page\.assertGeneralInformationPage/);
  });

  test('assigns a terminal assertion to the verified owner of its continuation case', () => {
    const signIn = verifiedAction({
      id: 'sign-in',
      action: 'click',
      target: 'signInButton',
      label: 'Sign in',
      expression: 'getByRole("button", { name: "Sign in", exact: true })',
      role: 'button',
      accessibleName: 'Sign in',
      pageTitle: 'Identity Provider',
      pageUrl: 'https://identity.example.test/signin',
      documentId: 'document-identity',
      nodeId: 'node-sign-in',
    });
    const openOrders = verifiedAction({
      id: 'open-orders',
      action: 'click',
      target: 'ordersLink',
      label: 'Orders',
      expression: 'getByRole("link", { name: "Orders", exact: true })',
      role: 'link',
      accessibleName: 'Orders',
      pageTitle: 'Home Dashboard',
      pageUrl: 'https://portal.example.test/home',
      documentId: 'document-home',
      nodeId: 'node-orders',
    });
    const output = playwrightPomJs.emitJourneySpec([
      {
        caseName: 'Authenticate',
        testCaseId: 'authentication-case',
        declaredSteps: [],
        ir: {
          caseId: 'authentication-case',
          title: 'Authenticate',
          steps: [
            ...signIn,
            {
              op: 'assert',
              channel: 'UI_TEXT',
              contractStepId: 'assert-home-copy',
              target: null,
              targetLabel: 'visible landing-page text',
              expected: 'Signed in successfully',
              liveOutcome: 'matched',
              executionStatus: 'evaluated',
              authored: true,
              executed: true,
              executionOutcome: 'succeeded',
            },
          ],
          verdict: { status: 'pass', perAssertionOutcomes: [] },
        },
      },
      {
        caseName: 'Continue from dashboard',
        testCaseId: 'continuation-case',
        dependsOn: ['authentication-case'],
        declaredSteps: [],
        ir: {
          caseId: 'continuation-case',
          title: 'Continue from dashboard',
          sessionRequirement: {
            sessionMode: 'continue_from_dependency',
            dependsOnCaseId: 'authentication-case',
          },
          steps: [...openOrders],
          verdict: { status: 'pass', perAssertionOutcomes: [] },
        },
      },
    ], { scenarioName: 'Cross Case Continuation Ownership' });

    expect(output.extraFiles['pages/HomeDashboardPage.js']).toContain(
      'assertVisibleLandingPageTextUiText',
    );
    expect(output.extraFiles['pages/IdentityProviderPage.js']).not.toContain(
      'assertVisibleLandingPageTextUiText',
    );
    expect(output.content).toMatch(
      /homeDashboardPage\.assertVisibleLandingPageTextUiText\(["']Signed in successfully["']\)/,
    );
  });

  it('keeps an optional guessed locator diagnostic-only and out of runnable output', () => {
    const contractStepId = 'optional-flow:step:3:prompt';
    const actionOccurrenceId = `${contractStepId}:dismiss_if_visible:1`;
    const authoredActionId = `${contractStepId}:action:1`;
    const occurrenceKey = `optional-flow:${contractStepId}:1:dismiss_if_visible`;
    const output = playwrightPomJs.emitJourneySpec([
      {
        caseName: 'Dismiss optional prompt',
        testCaseId: 'optional-flow',
        declaredSteps: [],
        ir: {
          caseId: 'optional-flow',
          title: 'Dismiss optional prompt',
          steps: [
            {
              op: 'resolve',
              as: 'optionalPrompt',
              contractStepId,
              actionOccurrenceId,
              authoredActionId,
              occurrenceKey,
              elementLabel: 'Optional prompt',
              candidates: [{ strategy: 'role', role: 'button', name: 'Optional prompt' }],
              guessedLocator: true,
              locatorProvenance: {
                kind: 'qaai_guessed_locator',
                deterministicEvidenceExhausted: true,
                warning: 'Replace this optional semantic fallback if needed.',
              },
            },
            {
              op: 'act',
              action: 'click',
              target: 'optionalPrompt',
              contractStepId,
              actionOccurrenceId,
              authoredActionId,
              occurrenceKey,
              optional: true,
            },
          ],
          verdict: { status: 'pass', perAssertionOutcomes: [] },
        },
      },
    ], { scenarioName: 'Optional flow' });

    const locatorManifest = JSON.parse(output.extraFiles['evidence/locator-manifest.json']);
    const sources = [output.content, ...Object.values(output.extraFiles)].join('\n');
    expect(locatorManifest.find((entry) => entry.as === 'optionalPrompt')).toBeUndefined();
    expect(output.content).not.toContain('clickOptionalPrompt');
    expect(sources).not.toContain('qaaiGuessedLocator');
    expect(sources).not.toContain('QAAI_GUESSED_LOCATOR');
  });
});
