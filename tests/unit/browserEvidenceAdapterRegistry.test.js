'use strict';

const {
  BrowserEvidenceAdapter,
  PlaywrightCdpEvidenceAdapter,
} = require('../../server/services/browserEvidenceAdapter');
const {
  ADAPTER_IDS,
  ADAPTER_KIND,
  CAPABILITIES,
  BrowserEvidenceAdapterRegistry,
} = require('../../server/services/browserEvidenceAdapterRegistry');

class StubBidiEvidenceAdapter extends BrowserEvidenceAdapter {
  async capturePhase(phase, request = {}) {
    return { phase, request, adapter: 'webdriver-bidi' };
  }
}

describe('browserEvidenceAdapterRegistry', () => {
  test('uses Playwright native deterministic proof when CDP is unavailable', () => {
    const registry = new BrowserEvidenceAdapterRegistry({
      defaults: { playwrightCdp: { cdpAvailable: false } },
    });

    const result = registry.negotiate({
      browser: 'chromium',
      surface: 'dom',
      requiredCapabilities: [
        CAPABILITIES.DETERMINISTIC_EVIDENCE,
        CAPABILITIES.LOCATOR_PROOF,
      ],
    });

    expect(result.status).toBe('ready');
    expect(result.authoritativeAdapter).toMatchObject({
      id: ADAPTER_IDS.PLAYWRIGHT_CDP,
      proofMode: 'playwright_native',
      cdpUsed: false,
      cdpFallbackUsed: true,
      canCreateActionEvidence: true,
    });
    expect(result.confidencePolicy.advisoryCanRaiseConfidenceAlone).toBe(false);
  });

  test('prefers CDP proof on Chromium when it is available without requiring it', () => {
    const registry = new BrowserEvidenceAdapterRegistry({
      defaults: { playwrightCdp: { cdpAvailable: true } },
    });

    const result = registry.negotiate({
      browser: 'chrome',
      requiredCapabilities: [CAPABILITIES.LOCATOR_PROOF],
    });

    expect(result.status).toBe('ready');
    expect(result.authoritativeAdapter.proofMode).toBe('cdp');
    expect(result.authoritativeAdapter.cdpUsed).toBe(true);
  });

  test('can negotiate and instantiate a future WebDriver BiDi adapter', () => {
    const registry = new BrowserEvidenceAdapterRegistry({
      defaults: {
        playwrightCdp: { available: false },
        webdriverBidi: {
          available: true,
          create: () => new StubBidiEvidenceAdapter(),
        },
      },
    });

    const negotiation = registry.negotiate({
      browser: 'firefox',
      requiredCapabilities: [
        CAPABILITIES.DETERMINISTIC_EVIDENCE,
        CAPABILITIES.LOCATOR_PROOF,
      ],
    });
    const created = registry.createAuthoritativeAdapter(negotiation);

    expect(negotiation.status).toBe('ready');
    expect(negotiation.authoritativeAdapter).toMatchObject({
      id: ADAPTER_IDS.WEBDRIVER_BIDI,
      proofMode: 'webdriver_bidi',
    });
    expect(created.status).toBe('ready');
    expect(created.adapter).toBeInstanceOf(StubBidiEvidenceAdapter);
  });

  test('instantiates the primary Playwright adapter through the negotiated factory', () => {
    const registry = new BrowserEvidenceAdapterRegistry();
    const negotiation = registry.negotiate({ browser: 'chromium' });
    const created = registry.createAuthoritativeAdapter(negotiation);

    expect(created.status).toBe('ready');
    expect(created.adapter).toBeInstanceOf(PlaywrightCdpEvidenceAdapter);
  });

  test('seals Stagehand and Firecrawl output as advisory-only hints', async () => {
    const registry = new BrowserEvidenceAdapterRegistry({
      defaults: {
        stagehand: { observe: async () => ({ locator: 'getByRole("button")' }) },
        firecrawl: { intake: async () => ({ pageHint: 'Public help content' }) },
      },
    });
    const negotiation = registry.negotiate({
      surface: 'dom',
      requestedAssists: [ADAPTER_IDS.STAGEHAND_OBSERVE, ADAPTER_IDS.FIRECRAWL_INTAKE],
    });
    const hints = await registry.collectAdvisoryHints(negotiation, { target: 'Continue' });

    expect(hints).toHaveLength(2);
    for (const hint of hints) {
      expect(hint).toMatchObject({
        kind: 'advisory_hint',
        authority: 'advisory',
        canCreateActionEvidence: false,
        canRaiseConfidenceAlone: false,
        requiresDeterministicCorroboration: true,
      });
      expect(Object.isFrozen(hint)).toBe(true);
    }
  });

  test('allows OCR hints only for non-DOM surfaces', () => {
    const registry = new BrowserEvidenceAdapterRegistry({
      defaults: {
        visualOcr: { inspect: async () => ({ text: 'Chart total 42' }) },
      },
    });

    const domResult = registry.negotiate({
      surface: 'dom',
      requestedAssists: [ADAPTER_IDS.VISUAL_OCR],
    });
    const canvasResult = registry.negotiate({
      surface: 'canvas',
      requestedAssists: [ADAPTER_IDS.VISUAL_OCR],
    });

    expect(domResult.assists).toEqual([]);
    expect(canvasResult.assists).toEqual([
      expect.objectContaining({
        id: ADAPTER_IDS.VISUAL_OCR,
        capabilities: [CAPABILITIES.NON_DOM_OCR],
        authority: 'advisory',
        canCreateActionEvidence: false,
      }),
    ]);
  });

  test('returns an explicit manual gate when deterministic evidence is unsupported', () => {
    const registry = new BrowserEvidenceAdapterRegistry({ registerDefaults: false });
    registry.register({
      id: ADAPTER_IDS.STAGEHAND_OBSERVE,
      kind: ADAPTER_KIND.ADVISORY,
      capabilities: [CAPABILITIES.OBSERVE_HINTS],
      invoke: async () => ({ action: 'click' }),
    });

    const result = registry.negotiate({
      browser: 'unknown-browser',
      surface: 'dom',
      requiredCapabilities: [CAPABILITIES.DETERMINISTIC_EVIDENCE],
    });

    expect(result).toMatchObject({
      status: 'manual_gate',
      authoritativeAdapter: null,
      missingCapabilities: [CAPABILITIES.DETERMINISTIC_EVIDENCE],
      manualGate: {
        required: true,
        code: 'UNSUPPORTED_BROWSER_EVIDENCE_PATH',
        preservesExecutionHistory: true,
      },
    });
  });

  test('does not silently replace an explicitly required CDP capability', () => {
    const registry = new BrowserEvidenceAdapterRegistry({
      defaults: { playwrightCdp: { cdpAvailable: false } },
    });

    const result = registry.negotiate({
      browser: 'chromium',
      requiredCapabilities: [CAPABILITIES.CDP],
    });

    expect(result.status).toBe('manual_gate');
    expect(result.missingCapabilities).toContain(CAPABILITIES.CDP);
  });

  test('rejects advisory adapters that claim they can fabricate ActionEvidence', () => {
    const registry = new BrowserEvidenceAdapterRegistry({ registerDefaults: false });

    expect(() => registry.register({
      id: 'unsafe-model-adapter',
      kind: ADAPTER_KIND.ADVISORY,
      capabilities: [CAPABILITIES.OBSERVE_HINTS],
      canCreateActionEvidence: true,
    })).toThrow(/cannot create ActionEvidence/);
  });
});
