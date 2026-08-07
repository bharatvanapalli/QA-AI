const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom');
const playwrightReference = require('../../server/services/codegen/adapters/playwrightReference');

function verifiedActionLocator(expression, accessibleName) {
  const nodeId = String(accessibleName || 'target').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'target';
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'document-neutral-output-test',
    nodeId,
    connected: true,
  };
  return {
    expression,
    frameworkExpressions: { playwright: expression },
    verificationSource: 'verified_dom_inspection',
    verified: true,
    targetFacts: { accessibleName },
    captureBinding: { kind: 'mcp_bound_ref', ref: nodeId },
    proof: {
      source: 'verified_dom_inspection',
      verified: true,
      count: 1,
      sameElement: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
    },
    domAtlas: { verifiedActions: [{ nodeId }] },
  };
}

describe('website-neutral Playwright lowering', () => {
  test('preserves an exact verified locator and never broadens it', () => {
    const exact = 'page.getByRole("button", { name: "Continue", exact: true })';
    const output = playwrightPom._emitLocatorFileGenerated('applicationPage', {
      continueButton: {
        source: 'actionLocator',
        verified: true,
        expr: exact,
        actionLocator: verifiedActionLocator(exact, 'Continue'),
        candidates: [
          { strategy: 'role', role: 'button', name: 'Continue' },
          { strategy: 'text', text: 'Continue' },
        ],
      },
    }, 'js', 'esm');

    expect(output).toContain(exact);
    expect(output).not.toContain('.or(');
    expect(output).not.toContain('.first(');
    expect(output).not.toContain('new RegExp');
    expect(output).not.toContain('QAAI_UNVERIFIED_LOCATOR');
  });

  test.each([
    ['passwordStructuralFallback', 'structural locator fallback'],
    ['candidates', 'unverified locator candidate'],
    ['llmLocatorInference', 'LLM locator inference'],
    ['qaaiGuessedLocator', 'semantic locator guess'],
  ])('omits every non-verified %s locator from runnable output', (source, reason) => {
    const output = playwrightPom._emitLocatorFileGenerated('applicationPage', {
      submitButton: {
        source,
        verified: false,
        expr: 'page.getByRole("button", { name: "Submit", exact: true })',
      },
    }, 'js', 'esm');

    expect(output).not.toContain(reason);
    expect(output).not.toContain('Replace this locator with a reliable DOM locator');
    expect(output).not.toContain('getByRole("button", { name: "Submit", exact: true })');
    expect(output).toContain('export const applicationPageLocators = {');
  });

  test('emits only canonical action methods and ignores injected business templates', () => {
    const entries = {
      signInWithMicrosoftButton: {
        source: 'actionLocator',
        verified: true,
        expr: 'page.getByRole("button", { name: "Sign in with Microsoft", exact: true })',
      },
    };
    const methods = new Map([
      ['click:signInWithMicrosoftButton', { action: 'click', name: 'signInWithMicrosoftButton' }],
    ]);
    const page = playwrightPom._emitPageFile('applicationPage', entries, methods, 'js', 'esm', {
      architectMethods: [{ kind: 'selectBrand', name: 'selectBrand' }],
      assertionMethods: [{ name: 'expectProductGridHasPrices' }],
    });

    expect(page).toContain('async clickSignInWithMicrosoft');
    expect(page).not.toMatch(/selectBrand|expectProduct|searchForProduct|features_items|brands_products|price range/i);
  });

  test('does not emit an inferred redirect or popup destination as page.goto', () => {
    const line = playwrightPom._pomEmitAct({
      op: 'act',
      action: 'navigate',
      contextSwitchInferred: true,
      url: 'https://identity.example.test/oauth/authorize?client-request-id=123&nonce=secret&state=volatile',
    }, new Map(), false, 'click', new Map(), null, null);

    expect(line).not.toContain('page.goto');
    expect(line).toContain('qaai-observed-navigation');
    expect(line).toContain('/oauth/authorize');
    expect(line).not.toMatch(/client-request-id|nonce|state=|volatile/);
  });

  test('keeps a candidate-only reference action executable and visibly qualified', () => {
    const line = playwrightReference.emitLocatorResolver([
      { strategy: 'role', role: 'button', name: 'Save changes' },
    ], { as: 'saveChanges' });

    expect(line).toContain('QAAI_UNVERIFIED_LOCATOR');
    expect(line).toContain('page.getByRole("button", { name: "Save changes" })');
    expect(line).not.toContain('.or(');
    expect(line).not.toContain('.first(');
  });

  test('removes e-mail, UUID and long value material from public identifiers', () => {
    const page = playwrightPom._emitPageFile('applicationPage', {
      enterThePasswordForPersonExampleComInput: {
        source: 'passwordStructuralFallback',
        verified: false,
        expr: 'page.getByLabel("Enter the password for person@example.com")',
      },
    }, new Map([
      ['fill:enterThePasswordForPersonExampleComInput', {
        action: 'fill',
        name: 'enterThePasswordForPersonExampleComInput',
      }],
    ]), 'js', 'esm');

    expect(page).not.toMatch(/personExampleCom|person@example\.com/i);
    expect(page).toContain('passwordInput');
    expect(page).toContain('fillPassword');
  });
});
