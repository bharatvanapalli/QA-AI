import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const resolver = require('../../server/services/actionLocatorResolver.js');

function verifiedLocator(overrides = {}) {
  const expression = overrides.expression || 'page.getByRole("button", { name: "Continue", exact: true })';
  const targetIdentity = { scheme: 'qaai-dom-node-v1', documentId: 'doc:test', nodeId: `node:${expression}`, connected: true };
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
    evidenceSource: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
    expression,
    frameworkExpressions: { playwright: expression },
    pageUrl: 'https://example.test/work/items?view=active',
    targetIdentity,
    actedNodeFingerprint: { schema: 'qaai-acted-node-fingerprint/1', hash: `fingerprint:${expression}` },
    context: { targetIdentity, captureBinding: { kind: 'mcp_bound_ref', ref: 'e-test' } },
    proof: {
      verified: true,
      sameElement: true,
      count: 1,
      visible: true,
      enabled: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
      source: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
    },
    domAtlas: { verifiedActions: [{ expression }] },
    ...overrides,
    context: {
      targetIdentity,
      captureBinding: { kind: 'mcp_bound_ref', ref: 'e-test' },
      ...(overrides.context || {}),
    },
  };
}

describe('website-neutral action locator context integrity', () => {
  it('preserves exact expressions and complete frame, shadow, container and popup context', () => {
    const locator = verifiedLocator({
      context: {
        framePath: ['iframe[name="payment"]', 'iframe[data-zone="controls"]'],
        shadowPath: ['account-shell', 'action-panel'],
        rowSelector: '[data-row-key="record-7"]',
      },
    });
    const evidence = resolver.buildLocatorEvidenceRecord({
      actionLocator: locator,
      contractStepId: 'case-step-4',
      sourceContractStepId: 'runtime-step-91',
      actionOccurrenceId: 'case-step-4:click:2',
      sourceActionOccurrenceId: 'runtime-step-91:click:1',
      authoredActionId: 'authored-action-4',
      sequenceIndex: 2,
      actionIdentity: {
        schemaVersion: 'qaai-action-identity-v1',
        occurrenceKey: 'case:case-step-4:2:click',
      },
      pageAlias: 'work-items-page',
      tabAlias: 'primary-tab',
      popupIdentity: { id: 'popup-2', alias: 'details-popup' },
      contextTransition: { kind: 'popup_opened', transitionId: 'popup-2' },
      capturedAt: '2026-07-15T10:00:00.000Z',
    });

    expect(evidence).toMatchObject({
      contractStepId: 'case-step-4',
      sourceContractStepId: 'runtime-step-91',
      actionOccurrenceId: 'case-step-4:click:2',
      sourceActionOccurrenceId: 'runtime-step-91:click:1',
      authoredActionId: 'authored-action-4',
      sequenceIndex: 2,
      actionIdentity: {
        schemaVersion: 'qaai-action-identity-v1',
        occurrenceKey: 'case:case-step-4:2:click',
      },
      verified: true,
      pageAlias: 'work-items-page',
      tabAlias: 'primary-tab',
      origin: 'https://example.test',
      stableRoute: '/work/items',
      popupIdentity: { id: 'popup-2' },
      pageIdentity: { documentId: 'doc:test', pageAlias: 'work-items-page', tabAlias: 'primary-tab' },
      framePath: ['iframe[name="payment"]', 'iframe[data-zone="controls"]'],
      shadowHostPath: ['account-shell', 'action-panel'],
      containerScope: '[data-row-key="record-7"]',
      uniqueness: { count: 1, sameElement: true, unique: true },
      actionability: { visible: true, enabled: true },
      targetIdentity: { documentId: 'doc:test' },
      actedNodeFingerprint: { hash: `fingerprint:${locator.expression}` },
      capturedAt: '2026-07-15T10:00:00.000Z',
    });
    expect(evidence.exactFrameworkExpressions.playwright).toBe(locator.expression);
    expect(evidence.locator.frameworkExpressions.playwright).toBe(locator.expression);
    expect(evidence.contextTransition).toMatchObject({ origin: 'context_evidence', authored: false });
    expect(evidence.locator).toMatchObject({
      actionOccurrenceId: 'case-step-4:click:2',
      sourceActionOccurrenceId: 'runtime-step-91:click:1',
      authoredActionId: 'authored-action-4',
      sequenceIndex: 2,
      contextEvidence: {
        actionOccurrenceId: 'case-step-4:click:2',
        sourceActionOccurrenceId: 'runtime-step-91:click:1',
      },
    });
  });

  it('marks structural, candidate, LLM and semantic sources explicitly unverified', () => {
    for (const source of ['structural_fallback', 'candidate_recovery', 'llm_locator', 'semantic_guess']) {
      const expression = 'page.locator("[data-action=continue]")';
      const evidence = resolver.buildLocatorEvidenceRecord({
        actionLocator: {
          kind: 'playwright',
          verified: false,
          verificationSource: source,
          expression,
          frameworkExpressions: { playwright: expression },
          proof: { sameElement: false, count: 2, visible: true, enabled: true },
        },
        contractStepId: `step-${source}`,
        pageUrl: 'https://example.test/work',
      });
      expect(evidence).toMatchObject({ verified: false, verificationStatus: 'unverified', verificationSource: source });
      expect(evidence.locator.verified).toBe(false);
    }
  });

  it('keeps repeated-field locators distinct in a multi-field evidence record', () => {
    const first = verifiedLocator({ expression: 'page.locator("form[data-key=primary]").getByLabel("Email")' });
    const second = verifiedLocator({ expression: 'page.locator("form[data-key=secondary]").getByLabel("Email")' });
    const record = resolver.buildLocatorEvidenceRecord({
      actionLocator: {
        kind: 'multi',
        fields: [
          { index: 0, name: 'Primary email', actionLocator: first },
          { index: 1, name: 'Secondary email', actionLocator: second },
        ],
      },
      contractStepId: 'step-repeated-fields',
      pageUrl: 'https://example.test/profile',
    });

    expect(record.locator.fields.map((field) => field.actionLocator.expression)).toEqual([
      first.expression,
      second.expression,
    ]);
    expect(record.locator.fields.map((field) => field.fieldIndex)).toEqual([0, 1]);
  });

  it('returns unresolved evidence without throwing or dropping the step', async () => {
    await expect(resolver.forceExcavateDeepLocator({
      session: null,
      toolName: 'browser_click',
      contractNode: { contractStepId: 'unknown-step' },
    })).resolves.toBeNull();
    const record = resolver.buildLocatorEvidenceRecord({
      actionLocator: null,
      contractStepId: 'unknown-step',
      pageUrl: 'https://example.test/current',
    });
    expect(record).toMatchObject({
      contractStepId: 'unknown-step',
      verified: false,
      verificationStatus: 'unverified',
      locator: null,
    });
  });
});
