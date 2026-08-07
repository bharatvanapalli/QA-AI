'use strict';

const {
  BrowserEvidenceAdapter,
  PlaywrightCdpEvidenceAdapter,
} = require('./browserEvidenceAdapter');

const REGISTRY_SCHEMA_VERSION = 'qaai.browser-evidence-adapter-registry.v1';

const ADAPTER_KIND = Object.freeze({
  AUTHORITATIVE: 'authoritative',
  ADVISORY: 'advisory',
});

const ADAPTER_IDS = Object.freeze({
  PLAYWRIGHT_CDP: 'playwright-cdp',
  WEBDRIVER_BIDI: 'webdriver-bidi',
  STAGEHAND_OBSERVE: 'stagehand-observe',
  FIRECRAWL_INTAKE: 'firecrawl-intake',
  VISUAL_OCR: 'visual-ocr',
});

const CAPABILITIES = Object.freeze({
  DETERMINISTIC_EVIDENCE: 'deterministic_browser_evidence',
  EVIDENCE_ENVELOPE: 'evidence_envelope',
  ACTION_PHASES: 'action_phase_capture',
  LOCATOR_PROOF: 'deterministic_locator_proof',
  PLAYWRIGHT_NATIVE_PROOF: 'playwright_native_proof',
  CDP: 'cdp',
  BIDI: 'webdriver_bidi',
  DOM: 'dom',
  ACCESSIBILITY: 'accessibility',
  CONTROL_READBACK: 'control_readback',
  ACTIONABILITY: 'actionability',
  FRAME_CONTEXT: 'frame_context',
  SHADOW_CONTEXT: 'shadow_context',
  NAVIGATION: 'navigation_evidence',
  NETWORK: 'network_evidence',
  VISUAL_CAPTURE: 'visual_capture',
  OBSERVE_HINTS: 'observe_hints',
  INTAKE_HINTS: 'intake_hints',
  NON_DOM_OCR: 'non_dom_ocr',
});

const DOM_SURFACES = new Set(['dom', 'html', 'form', 'control', 'document']);
const NON_DOM_SURFACES = new Set(['canvas', 'image', 'pdf', 'video', 'non_dom']);
const DEFAULT_REQUIRED_CAPABILITIES = Object.freeze([
  CAPABILITIES.DETERMINISTIC_EVIDENCE,
  CAPABILITIES.ACTION_PHASES,
]);

function cleanString(value, fallback = '') {
  const normalized = String(value == null ? '' : value).trim();
  return normalized || fallback;
}

function uniqueStrings(values = []) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => cleanString(value))
      .filter(Boolean),
  ));
}

function normalizeSurface(value) {
  const surface = cleanString(value, 'dom').toLowerCase().replace(/[ -]+/g, '_');
  if (DOM_SURFACES.has(surface)) return 'dom';
  if (NON_DOM_SURFACES.has(surface)) return surface;
  return surface;
}

function isNonDomSurface(surface) {
  return NON_DOM_SURFACES.has(normalizeSurface(surface));
}

function normalizeBrowser(value) {
  const browser = cleanString(value, 'chromium').toLowerCase();
  if (browser.includes('firefox')) return 'firefox';
  if (browser.includes('webkit') || browser.includes('safari')) return 'webkit';
  if (browser.includes('edge') || browser.includes('chrome') || browser.includes('chromium')) return 'chromium';
  return browser;
}

function freezeResult(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeResult(nested);
  return Object.freeze(value);
}

function normalizeAdapterDefinition(definition = {}) {
  const id = cleanString(definition.id);
  if (!id) throw new Error('Browser evidence adapter id is required');

  const kind = cleanString(definition.kind, ADAPTER_KIND.AUTHORITATIVE).toLowerCase();
  if (!Object.values(ADAPTER_KIND).includes(kind)) {
    throw new Error(`Unsupported browser evidence adapter kind: ${kind}`);
  }

  if (kind === ADAPTER_KIND.AUTHORITATIVE && definition.canCreateActionEvidence === false) {
    throw new Error(`Authoritative adapter ${id} must be able to create canonical evidence`);
  }
  if (kind === ADAPTER_KIND.ADVISORY && definition.canCreateActionEvidence === true) {
    throw new Error(`Advisory adapter ${id} cannot create ActionEvidence`);
  }

  return Object.freeze({
    id,
    kind,
    priority: Number.isFinite(Number(definition.priority)) ? Number(definition.priority) : 0,
    status: cleanString(definition.status, 'available').toLowerCase(),
    browsers: Object.freeze(uniqueStrings(definition.browsers || ['*']).map((value) => value.toLowerCase())),
    surfaces: Object.freeze(uniqueStrings(definition.surfaces || ['*']).map(normalizeSurface)),
    capabilities: Object.freeze(uniqueStrings(definition.capabilities)),
    optionalCapabilities: Object.freeze(uniqueStrings(definition.optionalCapabilities)),
    canCreateActionEvidence: kind === ADAPTER_KIND.AUTHORITATIVE,
    canRaiseConfidenceAlone: false,
    requiresDeterministicCorroboration: kind === ADAPTER_KIND.ADVISORY,
    create: typeof definition.create === 'function' ? definition.create : null,
    invoke: typeof definition.invoke === 'function' ? definition.invoke : null,
    availability: typeof definition.availability === 'function' ? definition.availability : null,
    metadata: Object.freeze({ ...(definition.metadata || {}) }),
  });
}

function adapterSupportsContext(definition, request) {
  const browserSupported = definition.browsers.includes('*') || definition.browsers.includes(request.browser);
  const surfaceSupported = definition.surfaces.includes('*') || definition.surfaces.includes(request.surface);
  return browserSupported && surfaceSupported;
}

function capabilitySatisfied(capability, capabilities) {
  if (capabilities.has(capability)) return true;
  if (capability === CAPABILITIES.LOCATOR_PROOF) {
    return capabilities.has(CAPABILITIES.CDP)
      || capabilities.has(CAPABILITIES.PLAYWRIGHT_NATIVE_PROOF)
      || capabilities.has(CAPABILITIES.BIDI);
  }
  return false;
}

function proofModeFor(capabilities) {
  if (capabilities.has(CAPABILITIES.CDP)) return 'cdp';
  if (capabilities.has(CAPABILITIES.PLAYWRIGHT_NATIVE_PROOF)) return 'playwright_native';
  if (capabilities.has(CAPABILITIES.BIDI)) return 'webdriver_bidi';
  return 'none';
}

function normalizeNegotiationRequest(request = {}) {
  return Object.freeze({
    browser: normalizeBrowser(request.browser || request.browserName || request.engine),
    surface: normalizeSurface(request.surface || request.surfaceType),
    requiredCapabilities: Object.freeze(uniqueStrings(
      request.requiredCapabilities == null
        ? DEFAULT_REQUIRED_CAPABILITIES
        : request.requiredCapabilities,
    )),
    optionalCapabilities: Object.freeze(uniqueStrings(request.optionalCapabilities)),
    requestedAssists: Object.freeze(uniqueStrings(request.requestedAssists || request.assists)),
    allowManualGate: request.allowManualGate !== false,
  });
}

function manualGate(request, missingCapabilities, candidates = []) {
  return freezeResult({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    status: 'manual_gate',
    request,
    authoritativeAdapter: null,
    assists: [],
    missingCapabilities: uniqueStrings(missingCapabilities),
    consideredAdapters: candidates,
    confidencePolicy: {
      canonicalEvidenceRequired: true,
      advisoryCanRaiseConfidenceAlone: false,
      advisoryCanCreateActionEvidence: false,
    },
    manualGate: {
      required: true,
      code: 'UNSUPPORTED_BROWSER_EVIDENCE_PATH',
      reason: missingCapabilities.length
        ? `No deterministic adapter provides: ${missingCapabilities.join(', ')}`
        : 'No deterministic browser evidence adapter supports this browser and surface',
      preservesExecutionHistory: true,
    },
  });
}

function advisoryEnvelope(adapterId, capability, suggestion, context = {}) {
  return freezeResult({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    kind: 'advisory_hint',
    adapterId,
    capability,
    authority: 'advisory',
    suggestion: suggestion == null ? null : suggestion,
    context: { ...context },
    canCreateActionEvidence: false,
    canRaiseConfidenceAlone: false,
    requiresDeterministicCorroboration: true,
  });
}

class BrowserEvidenceAdapterRegistry {
  constructor({ registerDefaults = true, adapters = [], defaults = {} } = {}) {
    this.adapters = new Map();
    if (registerDefaults) this.registerDefaults(defaults);
    for (const adapter of adapters) this.register(adapter);
  }

  registerDefaults(defaults = {}) {
    const playwright = defaults.playwrightCdp || {};
    this.register({
      id: ADAPTER_IDS.PLAYWRIGHT_CDP,
      kind: ADAPTER_KIND.AUTHORITATIVE,
      priority: 100,
      status: playwright.available === false ? 'unavailable' : 'available',
      browsers: ['chromium', 'firefox', 'webkit'],
      surfaces: ['*'],
      capabilities: [
        CAPABILITIES.DETERMINISTIC_EVIDENCE,
        CAPABILITIES.EVIDENCE_ENVELOPE,
        CAPABILITIES.ACTION_PHASES,
        CAPABILITIES.LOCATOR_PROOF,
        CAPABILITIES.PLAYWRIGHT_NATIVE_PROOF,
        CAPABILITIES.DOM,
        CAPABILITIES.ACCESSIBILITY,
        CAPABILITIES.CONTROL_READBACK,
        CAPABILITIES.ACTIONABILITY,
        CAPABILITIES.FRAME_CONTEXT,
        CAPABILITIES.SHADOW_CONTEXT,
        CAPABILITIES.NAVIGATION,
        CAPABILITIES.VISUAL_CAPTURE,
        ...(playwright.cdpAvailable === true ? [CAPABILITIES.CDP, CAPABILITIES.NETWORK] : []),
      ],
      optionalCapabilities: [CAPABILITIES.CDP, CAPABILITIES.NETWORK],
      create: playwright.create || ((options = {}) => new PlaywrightCdpEvidenceAdapter({
        ...(playwright.adapterOptions || {}),
        ...options,
      })),
      availability: playwright.availability,
      metadata: {
        primary: true,
        cdpPreferredOnChromium: true,
        cdpRequired: false,
      },
    });

    const bidi = defaults.webdriverBidi || {};
    this.register({
      id: ADAPTER_IDS.WEBDRIVER_BIDI,
      kind: ADAPTER_KIND.AUTHORITATIVE,
      priority: 90,
      status: bidi.available === true && typeof bidi.create === 'function' ? 'available' : 'planned',
      browsers: ['chromium', 'firefox', 'webkit'],
      surfaces: ['*'],
      capabilities: [
        CAPABILITIES.DETERMINISTIC_EVIDENCE,
        CAPABILITIES.EVIDENCE_ENVELOPE,
        CAPABILITIES.ACTION_PHASES,
        CAPABILITIES.LOCATOR_PROOF,
        CAPABILITIES.BIDI,
        CAPABILITIES.DOM,
        CAPABILITIES.ACCESSIBILITY,
        CAPABILITIES.CONTROL_READBACK,
        CAPABILITIES.FRAME_CONTEXT,
        CAPABILITIES.NAVIGATION,
      ],
      create: bidi.create,
      availability: bidi.availability,
      metadata: { futureAdapter: true },
    });

    this.registerAdvisoryDefaults(defaults);
  }

  registerAdvisoryDefaults(defaults = {}) {
    const stagehand = defaults.stagehand || {};
    this.register({
      id: ADAPTER_IDS.STAGEHAND_OBSERVE,
      kind: ADAPTER_KIND.ADVISORY,
      priority: 30,
      status: typeof stagehand.observe === 'function' ? 'available' : 'unavailable',
      capabilities: [CAPABILITIES.OBSERVE_HINTS],
      invoke: stagehand.observe,
      metadata: { purpose: 'action_discovery_and_repair_hint' },
    });

    const firecrawl = defaults.firecrawl || {};
    this.register({
      id: ADAPTER_IDS.FIRECRAWL_INTAKE,
      kind: ADAPTER_KIND.ADVISORY,
      priority: 20,
      status: typeof firecrawl.intake === 'function' ? 'available' : 'unavailable',
      capabilities: [CAPABILITIES.INTAKE_HINTS],
      invoke: firecrawl.intake,
      metadata: { purpose: 'pre_execution_public_context_hint' },
    });

    const visualOcr = defaults.visualOcr || {};
    this.register({
      id: ADAPTER_IDS.VISUAL_OCR,
      kind: ADAPTER_KIND.ADVISORY,
      priority: 10,
      status: typeof visualOcr.inspect === 'function' ? 'available' : 'unavailable',
      surfaces: Array.from(NON_DOM_SURFACES),
      capabilities: [CAPABILITIES.NON_DOM_OCR],
      invoke: visualOcr.inspect,
      metadata: { purpose: 'non_dom_surface_hint', domForbidden: true },
    });
  }

  register(definition) {
    const normalized = normalizeAdapterDefinition(definition);
    this.adapters.set(normalized.id, normalized);
    return normalized;
  }

  unregister(id) {
    return this.adapters.delete(cleanString(id));
  }

  list({ kind = null } = {}) {
    return Array.from(this.adapters.values())
      .filter((adapter) => !kind || adapter.kind === kind)
      .map((adapter) => ({ ...adapter, create: undefined, invoke: undefined, availability: undefined }));
  }

  adapterAvailable(adapter, request) {
    if (adapter.status !== 'available') return false;
    if (!adapterSupportsContext(adapter, request)) return false;
    if (!adapter.availability) return true;
    try {
      return adapter.availability(request) === true;
    } catch {
      return false;
    }
  }

  negotiate(input = {}) {
    const request = normalizeNegotiationRequest(input);
    const consideredAdapters = [];
    const candidates = [];

    for (const adapter of this.adapters.values()) {
      if (adapter.kind !== ADAPTER_KIND.AUTHORITATIVE) continue;
      const available = this.adapterAvailable(adapter, request);
      const capabilitySet = new Set(adapter.capabilities);
      const missing = request.requiredCapabilities.filter(
        (capability) => !capabilitySatisfied(capability, capabilitySet),
      );
      consideredAdapters.push({
        id: adapter.id,
        status: adapter.status,
        available,
        missingCapabilities: missing,
      });
      if (available && missing.length === 0) candidates.push({ adapter, capabilitySet });
    }

    candidates.sort((left, right) => {
      const browserBiasLeft = request.browser === 'chromium' && left.capabilitySet.has(CAPABILITIES.CDP) ? 20 : 0;
      const browserBiasRight = request.browser === 'chromium' && right.capabilitySet.has(CAPABILITIES.CDP) ? 20 : 0;
      return (right.adapter.priority + browserBiasRight) - (left.adapter.priority + browserBiasLeft);
    });

    if (candidates.length === 0) {
      const missing = consideredAdapters.length
        ? uniqueStrings(consideredAdapters.flatMap((adapter) => adapter.missingCapabilities))
        : request.requiredCapabilities;
      return manualGate(request, missing, consideredAdapters);
    }

    const selected = candidates[0];
    const assists = this.selectAssists(request);
    const proofMode = proofModeFor(selected.capabilitySet);
    return freezeResult({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      status: 'ready',
      request,
      authoritativeAdapter: {
        id: selected.adapter.id,
        kind: selected.adapter.kind,
        capabilities: Array.from(selected.capabilitySet),
        proofMode,
        cdpUsed: proofMode === 'cdp',
        cdpFallbackUsed: selected.adapter.id === ADAPTER_IDS.PLAYWRIGHT_CDP && proofMode === 'playwright_native',
        canCreateActionEvidence: true,
      },
      assists,
      missingCapabilities: [],
      consideredAdapters,
      confidencePolicy: {
        canonicalEvidenceRequired: true,
        advisoryCanRaiseConfidenceAlone: false,
        advisoryCanCreateActionEvidence: false,
      },
      manualGate: null,
    });
  }

  selectAssists(request) {
    const requested = new Set(request.requestedAssists);
    const explicitRequest = requested.size > 0;
    const assists = [];
    for (const adapter of this.adapters.values()) {
      if (adapter.kind !== ADAPTER_KIND.ADVISORY) continue;
      if (!this.adapterAvailable(adapter, request)) continue;
      if (explicitRequest && !requested.has(adapter.id) && !adapter.capabilities.some((cap) => requested.has(cap))) {
        continue;
      }
      if (adapter.id === ADAPTER_IDS.VISUAL_OCR && !isNonDomSurface(request.surface)) continue;
      assists.push({
        id: adapter.id,
        capabilities: Array.from(adapter.capabilities),
        authority: 'advisory',
        canCreateActionEvidence: false,
        canRaiseConfidenceAlone: false,
        requiresDeterministicCorroboration: true,
      });
    }
    return assists.sort((left, right) => {
      const leftPriority = this.adapters.get(left.id)?.priority || 0;
      const rightPriority = this.adapters.get(right.id)?.priority || 0;
      return rightPriority - leftPriority;
    });
  }

  createAuthoritativeAdapter(negotiation, options = {}) {
    if (!negotiation || negotiation.status !== 'ready' || !negotiation.authoritativeAdapter) {
      return {
        status: 'manual_gate',
        adapter: null,
        manualGate: negotiation?.manualGate || {
          required: true,
          code: 'EVIDENCE_ADAPTER_NOT_NEGOTIATED',
          reason: 'A ready evidence-adapter negotiation is required',
        },
      };
    }
    const definition = this.adapters.get(negotiation.authoritativeAdapter.id);
    if (!definition || typeof definition.create !== 'function') {
      return {
        status: 'manual_gate',
        adapter: null,
        manualGate: {
          required: true,
          code: 'EVIDENCE_ADAPTER_FACTORY_UNAVAILABLE',
          reason: `Adapter ${negotiation.authoritativeAdapter.id} has no runtime factory`,
        },
      };
    }
    const adapter = definition.create(options);
    if (!(adapter instanceof BrowserEvidenceAdapter)) {
      throw new TypeError(`Adapter factory ${definition.id} must return a BrowserEvidenceAdapter`);
    }
    return { status: 'ready', adapter, manualGate: null };
  }

  async collectAdvisoryHints(negotiation, request = {}) {
    if (!negotiation || negotiation.status !== 'ready') return [];
    const hints = [];
    for (const selected of negotiation.assists || []) {
      const definition = this.adapters.get(selected.id);
      if (!definition || typeof definition.invoke !== 'function') continue;
      const capability = definition.capabilities[0] || 'advisory_hint';
      try {
        const suggestion = await definition.invoke({ ...request, surface: negotiation.request.surface });
        hints.push(advisoryEnvelope(definition.id, capability, suggestion, {
          browser: negotiation.request.browser,
          surface: negotiation.request.surface,
        }));
      } catch (error) {
        hints.push(advisoryEnvelope(definition.id, capability, {
          status: 'assist_error',
          message: cleanString(error?.message, 'Advisory assistant failed').slice(0, 500),
        }, {
          browser: negotiation.request.browser,
          surface: negotiation.request.surface,
        }));
      }
    }
    return hints;
  }
}

function createBrowserEvidenceAdapterRegistry(options = {}) {
  return new BrowserEvidenceAdapterRegistry(options);
}

module.exports = {
  REGISTRY_SCHEMA_VERSION,
  ADAPTER_KIND,
  ADAPTER_IDS,
  CAPABILITIES,
  BrowserEvidenceAdapterRegistry,
  createBrowserEvidenceAdapterRegistry,
  normalizeNegotiationRequest,
  advisoryEnvelope,
  isNonDomSurface,
};
