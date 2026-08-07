const fs = require('fs');
const path = require('path');

const resolver = require('../../server/services/actionLocatorResolver');

function verifiedLocator(expression, overrides = {}) {
  const verifiedSource = resolver.VERIFIED_DOM_INSPECTION_SOURCE;
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'doc:propagation-test',
    nodeId: 'node:save-button',
    connected: true,
    tag: 'button',
  };
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: verifiedSource,
    evidenceSource: verifiedSource,
    expression,
    frameworkExpressions: {
      playwright: expression,
      selenium: 'By.cssSelector("[data-control=save]")',
    },
    domAtlas: {
      verifiedActions: [{ expression, source: verifiedSource }],
    },
    targetIdentity,
    proof: {
      count: 1,
      sameElement: true,
      visible: true,
      enabled: true,
      editable: false,
      verified: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
      source: verifiedSource,
    },
    context: { captureBinding: { kind: 'mcp_bound_ref', ref: 'e-save' } },
    ...overrides,
    context: {
      captureBinding: { kind: 'mcp_bound_ref', ref: 'e-save' },
      ...(overrides.context || {}),
    },
  };
}

describe('action locator context propagates inside public locator results', () => {
  it('preserves exact verified expressions, contract identity, provenance, uniqueness, and actionability', () => {
    const expression = 'getByRole("button",   { name: "Save changes", exact: true })';
    const record = resolver.buildLocatorEvidenceRecord({
      actionLocator: verifiedLocator(expression),
      contractStepId: 'contract-save',
      sourceContractStepId: 'source-save',
      pageUrl: 'https://example.test/accounts/42?view=details',
      capturedAt: '2026-07-15T10:00:00.000Z',
    });

    expect(record.locator.expression).toBe(expression);
    expect(record.locator.frameworkExpressions.playwright).toBe(expression);
    expect(record.locator.exactFrameworkExpressions.playwright).toBe(expression);
    expect(record.locator.contextEvidence.exactFrameworkExpressions.playwright).toBe(expression);
    expect(record.locator).toMatchObject({
      contractStepId: 'contract-save',
      sourceContractStepId: 'source-save',
      verified: true,
      verificationStatus: 'verified',
      verificationSource: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
      uniqueness: { count: 1, sameElement: true, unique: true },
      actionability: { visible: true, enabled: true, editable: false },
    });
  });

  it('propagates context through the public argument fallback without promoting it to verified', async () => {
    const locator = await resolver.resolveForTool({
      toolName: 'browser_click',
      args: { selector: '[data-action="save"]' },
      pageUrl: 'https://example.test/editor',
      contractStepId: 'contract-fallback',
      sourceContractStepId: 'source-fallback',
      pageAlias: 'editor-page',
      tabAlias: 'primary-tab',
      popupIdentity: { id: 'popup-settings', alias: 'settings' },
      contextTransition: { from: 'primary-tab', to: 'settings' },
      capturedAt: '2026-07-15T10:01:00.000Z',
    });

    expect(locator.expression).toBe('locator("[data-action=\\"save\\"]")');
    expect(locator).toMatchObject({
      verified: false,
      verificationStatus: 'unverified',
      verificationSource: 'args',
      contractStepId: 'contract-fallback',
      sourceContractStepId: 'source-fallback',
      pageAlias: 'editor-page',
      tabAlias: 'primary-tab',
      popupIdentity: { id: 'popup-settings', alias: 'settings' },
      contextTransition: {
        from: 'primary-tab',
        to: 'settings',
        origin: 'context_evidence',
        authored: false,
      },
    });
  });

  it('keeps structural and LLM locator evidence explicitly unverified and unchanged', () => {
    const structuralExpression = 'locator("section[data-zone=\\"billing\\"] input[name=\\"code\\"]")';
    const structural = resolver.buildLocatorEvidenceRecord({
      actionLocator: {
        ...verifiedLocator(structuralExpression),
        verified: false,
        diagnosticOnly: true,
        verificationSource: 'structural_dom_capture',
        evidenceSource: 'structural_dom_capture',
        proof: { count: 1, sameElement: true, source: 'structural_dom_capture' },
      },
      contractStepId: 'contract-structural',
      capturedAt: '2026-07-15T10:02:00.000Z',
    }).locator;
    const guessedExpression = 'getByRole("button", { name: "Continue" })';
    const guessed = resolver.buildLocatorEvidenceRecord({
      actionLocator: {
        kind: 'playwright',
        verified: false,
        diagnosticOnly: true,
        verificationSource: 'llm_guessed_role',
        evidenceSource: 'llm_guessed_role',
        expression: guessedExpression,
        frameworkExpressions: { playwright: guessedExpression },
        proof: { count: null, sameElement: false, source: 'llm_guessed_role' },
      },
      contractStepId: 'contract-guessed',
      capturedAt: '2026-07-15T10:03:00.000Z',
    }).locator;

    expect(structural).toMatchObject({ verified: false, verificationStatus: 'unverified', verificationSource: 'structural_dom_capture' });
    expect(structural.expression).toBe(structuralExpression);
    expect(guessed).toMatchObject({ verified: false, verificationStatus: 'unverified', verificationSource: 'llm_guessed_role' });
    expect(guessed.expression).toBe(guessedExpression);
  });

  it('carries frame, shadow-host, and container scope without rewriting the locator', () => {
    const expression = 'frameLocator("iframe[name=\\"workspace\\"]").locator("custom-panel").getByRole("textbox", { name: "Reference" })';
    const locator = resolver.buildLocatorEvidenceRecord({
      actionLocator: verifiedLocator(expression, {
        context: {
          framePath: ['iframe[name="workspace"]', 'iframe[name="details"]'],
          shadowPath: ['custom-shell', 'custom-panel'],
          tableSelector: '[role="grid"]',
        },
      }),
      contractStepId: 'contract-context',
      capturedAt: '2026-07-15T10:04:00.000Z',
    }).locator;

    expect(locator.expression).toBe(expression);
    expect(locator.framePath).toEqual(['iframe[name="workspace"]', 'iframe[name="details"]']);
    expect(locator.shadowHostPath).toEqual(['custom-shell', 'custom-panel']);
    expect(locator.containerScope).toBe('[role="grid"]');
  });

  it('carries popup and tab identity and forces observed transitions to non-authored evidence', () => {
    const locator = resolver.buildLocatorEvidenceRecord({
      actionLocator: verifiedLocator('getByRole("button", { name: "Confirm" })'),
      pageAlias: 'confirmation-page',
      tabAlias: 'confirmation-tab',
      popupIdentity: { id: 'confirmation-popup', opener: 'primary-tab' },
      contextTransition: { type: 'popup', from: 'primary-tab', to: 'confirmation-tab', authored: true },
      capturedAt: '2026-07-15T10:05:00.000Z',
    }).locator;

    expect(locator).toMatchObject({
      pageAlias: 'confirmation-page',
      tabAlias: 'confirmation-tab',
      popupIdentity: { id: 'confirmation-popup', opener: 'primary-tab' },
      contextTransition: {
        type: 'popup',
        from: 'primary-tab',
        to: 'confirmation-tab',
        origin: 'context_evidence',
        authored: false,
      },
    });
  });

  it('keeps repeated multi-field locators independent with their own expressions and scopes', () => {
    const firstExpression = 'locator("[data-row=\\"0\\"]").getByLabel("Contact number")';
    const secondExpression = 'locator("[data-row=\\"1\\"]").getByLabel("Contact number")';
    const multi = resolver.buildLocatorEvidenceRecord({
      actionLocator: {
        kind: 'multi',
        fields: [
          { index: 0, name: 'Primary contact', scope: 'contact-row-0', actionLocator: verifiedLocator(firstExpression) },
          { index: 1, name: 'Secondary contact', scope: 'contact-row-1', actionLocator: verifiedLocator(secondExpression) },
        ],
      },
      contractStepId: 'contract-fill-contacts',
      pageAlias: 'contacts-page',
      capturedAt: '2026-07-15T10:06:00.000Z',
    }).locator;

    expect(multi.fields).toHaveLength(2);
    expect(multi.fields[0].actionLocator.expression).toBe(firstExpression);
    expect(multi.fields[1].actionLocator.expression).toBe(secondExpression);
    expect(multi.fields[0].actionLocator.fieldIndex).toBe(0);
    expect(multi.fields[1].actionLocator.fieldIndex).toBe(1);
    expect(multi.fields[0].actionLocator.repeatedFieldScope).toBe('contact-row-0');
    expect(multi.fields[1].actionLocator.repeatedFieldScope).toBe('contact-row-1');
    expect(multi.fields[0].actionLocator.contextEvidence).not.toBe(multi.fields[1].actionLocator.contextEvidence);

    const source = fs.readFileSync(path.resolve(__dirname, '../../server/services/actionLocatorResolver.js'), 'utf8');
    expect(source).not.toMatch(/features_items|productinfo|single-products|brands_products|RootPage/i);
    expect(source).not.toMatch(/certification gate|readiness gate|Math\.random|randomUUID/i);
  });
});
