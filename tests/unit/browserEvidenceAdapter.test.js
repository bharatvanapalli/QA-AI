'use strict';

const {
  BrowserEvidenceAdapter,
  PlaywrightCdpEvidenceAdapter,
  sourceAuthority,
  normalizeCdpEvidence,
  normalizeAxEvidence,
  createCaptureEnvelope,
  toSerializable,
} = require('../../server/services/browserEvidenceAdapter');

describe('browserEvidenceAdapter', () => {
  test('defines observed-fact authority without claiming requested target intent', () => {
    for (const source of ['playwright', 'cdp', 'accessibility', 'dom', 'browser_event', 'screenshot', 'stagehand']) {
      const authority = sourceAuthority(source);
      expect(authority.rank).toBeGreaterThanOrEqual(0);
      expect(authority.doesNotProve).toContain('requested_target_intent');
    }

    expect(sourceAuthority('playwright')).toMatchObject({ level: 'authoritative_observation', rank: 90 });
    expect(sourceAuthority('stagehand')).toMatchObject({ level: 'advisory', rank: 10, proves: [] });
  });

  test('normalizes CDP and accessibility node identity, paths, hit test, and control state', () => {
    const cdp = normalizeCdpEvidence({
      backendNodeId: 701,
      nodeId: 70,
      frameId: 'frame-main',
      framePath: [{ frameId: 'frame-main', tagName: 'iframe', name: 'Order editor' }],
      shadowPath: [{ backendNodeId: 699, tagName: 'qaai-combobox' }],
      tagName: 'input',
      role: 'combobox',
      name: 'Equipment',
      value: 'LTL',
      expanded: true,
      selected: false,
      hitTest: {
        backendNodeId: 701,
        nodeId: 70,
        sameNode: true,
        receivesEvents: true,
        x: 500,
        y: 300,
      },
      boundingBox: { x: 100, y: 200, width: 400, height: 44 },
    });
    const ax = normalizeAxEvidence({
      nodeId: 'ax-1',
      backendDOMNodeId: 701,
      role: { value: 'combobox' },
      name: { value: 'Equipment' },
      value: { value: 'LTL' },
      properties: [
        { name: 'expanded', value: { value: true } },
        { name: 'selected', value: { value: false } },
      ],
    });

    expect(cdp).toMatchObject({
      backendNodeId: 701,
      frameId: 'frame-main',
      identity: { tagName: 'input', role: 'combobox', name: 'Equipment' },
      state: { value: 'LTL', expanded: true, selected: false },
      hitTest: { backendNodeId: 701, sameNode: true, receivesEvents: true },
    });
    expect(cdp.framePath).toHaveLength(1);
    expect(cdp.shadowPath).toHaveLength(1);
    expect(ax).toMatchObject({
      backendNodeId: 701,
      identity: { role: 'combobox', name: 'Equipment' },
      state: { value: 'LTL', expanded: true, selected: false },
    });
  });

  test('captures serializable pre, action, and post envelopes through injected providers', async () => {
    let clock = 1000;
    let sequence = 0;
    const adapter = new PlaywrightCdpEvidenceAdapter({
      now: () => ++clock,
      idFactory: (prefix) => `${prefix}-${++sequence}`,
      fingerprintSalt: 'unit-run',
      capturePlaywright: async ({ phase }) => ({
        locator: { strategy: 'role', expression: `getByRole('combobox', { name: 'Equipment' })`, count: 1 },
        target: {
          tagName: 'input', role: 'combobox', name: 'Equipment',
          visible: true, enabled: true, editable: true,
          value: phase === 'post' ? 'LTL' : '',
        },
        action: { type: 'select', dispatched: phase !== 'pre', completed: phase === 'post' },
      }),
      captureCdp: async () => ({
        backendNodeId: 701,
        nodeId: 70,
        frameId: 'main-frame',
        shadowPath: [{ backendNodeId: 699, tagName: 'qaai-combobox' }],
        role: 'combobox',
        name: 'Equipment',
        expanded: true,
        hitTest: { backendNodeId: 701, sameNode: true, receivesEvents: true },
      }),
      captureAx: async () => ({
        backendDOMNodeId: 701,
        role: { value: 'combobox' },
        name: { value: 'Equipment' },
        expanded: true,
      }),
      captureDom: async ({ phase }) => ({
        backendNodeId: 701,
        tagName: 'input',
        role: 'combobox',
        ariaLabel: 'Equipment',
        value: phase === 'post' ? 'LTL' : '',
        owner: { tagName: 'label', name: 'Equipment' },
        popup: { tagName: 'div', role: 'listbox', name: 'Equipment options' },
      }),
      captureEvents: async () => ([{
        eventId: 'browser-event-1',
        type: 'change',
        target: { tagName: 'input', role: 'combobox', name: 'Equipment' },
        composedPath: [
          { tagName: 'input', role: 'combobox', name: 'Equipment' },
          { tagName: 'div', role: 'group', name: 'General Information' },
        ],
      }]),
      captureScreenshot: async ({ phase }) => ({
        artifactRef: `screenshots/${phase}.png`,
        sha256: 'a'.repeat(64),
        width: 1280,
        height: 720,
        redacted: true,
      }),
    });
    const request = {
      actionOccurrenceId: 'occurrence-1',
      stepId: 'step-17',
      actionType: 'select',
      controlType: 'combobox',
      targetDescription: 'Equipment',
      expectedValue: 'LTL',
    };

    const pre = await adapter.beforeAction(request);
    const action = await adapter.captureAction(request);
    const post = await adapter.afterAction(request);

    expect([pre.phase, action.phase, post.phase]).toEqual(['pre', 'action', 'post']);
    expect(post.schemaVersion).toBe('qaai.browser-evidence.v1');
    expect(post.semanticIntentClaimed).toBe(false);
    expect(post.observedIdentity).toMatchObject({
      facts: { tagName: 'input', role: 'combobox', name: 'Equipment' },
      intentAssessment: 'not_performed',
      intentMatch: null,
    });
    const cdpSource = post.sources.find((source) => source.source === 'cdp');
    expect(cdpSource).toMatchObject({
      status: 'captured',
      authority: { rank: 90 },
      facts: {
        backendNodeId: 701,
        frameId: 'main-frame',
        hitTest: { sameNode: true, receivesEvents: true },
      },
    });
    expect(post.sourceCorrelation.backendNode).toMatchObject({
      status: 'matched',
      value: 701,
    });
    const eventSource = post.sources.find((source) => source.source === 'browser_event');
    expect(eventSource.facts.events[0].composedPath).toHaveLength(2);
    expect(() => JSON.stringify(post)).not.toThrow();
    expect(JSON.parse(JSON.stringify(post))).toEqual(post);
  });

  test('never serializes raw passwords, tokens, authorization values, or binary screenshots', async () => {
    let providerRequest = null;
    const adapter = new PlaywrightCdpEvidenceAdapter({
      fingerprintSalt: 'secret-test',
      idFactory: () => 'evidence-secret',
      capturePlaywright: async ({ request }) => {
        providerRequest = request;
        return {
          locator: { strategy: 'label', expression: "getByLabel('Password')", count: 1 },
          target: { tagName: 'input', inputType: 'password', label: 'Password' },
        };
      },
      captureDom: async () => ({
        tagName: 'input',
        inputType: 'password',
        name: 'account-password',
        value: 'Behavior-ticket-organize1*',
        attributes: { type: 'password', value: 'Behavior-ticket-organize1*' },
      }),
      captureCdp: async () => {
        throw new Error('capture failed with token=raw-browser-token');
      },
      captureEvents: async () => ([{
        type: 'input',
        target: { tagName: 'input', inputType: 'password', label: 'Password' },
        value: 'Behavior-ticket-organize1*',
      }]),
      captureScreenshot: async () => ({
        artifactRef: 'screenshots/password.png',
        data: Buffer.from('raw-image'),
        authorization: 'Bearer raw-authorization-token',
      }),
    });

    const envelope = await adapter.afterAction({
      actionType: 'fill',
      controlType: 'password',
      targetDescription: 'Password',
      expectedValue: 'Behavior-ticket-organize1*',
      valueRef: 'env:QAAI_PASSWORD',
      password: 'Behavior-ticket-organize1*',
    });
    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain('Behavior-ticket-organize1*');
    expect(serialized).not.toContain('raw-browser-token');
    expect(serialized).not.toContain('raw-authorization-token');
    expect(serialized).not.toContain('raw-image');
    expect(envelope.request.expectedValue).toMatchObject({
      value: null,
      valueRef: 'env:QAAI_PASSWORD',
      redacted: true,
      persistedLiteral: false,
    });
    expect(envelope.privacy).toMatchObject({
      sensitive: true,
      persistence: 'value_ref_only',
      valueRef: 'env:QAAI_PASSWORD',
      valueRefMissing: false,
      rawLiteralPersisted: false,
    });
    expect(providerRequest).not.toHaveProperty('expectedValue');
    expect(providerRequest).not.toHaveProperty('password');
    expect(providerRequest.valueRef).toBe('env:QAAI_PASSWORD');
    const playwright = envelope.sources.find((source) => source.source === 'playwright');
    expect(playwright.facts.locator.expression).toBe("getByLabel('Password')");
    const dom = envelope.sources.find((source) => source.source === 'dom');
    expect(dom.facts.state).toMatchObject({
      value: null,
      valueRef: 'env:QAAI_PASSWORD',
      valueRedacted: true,
      valueLiteralPersisted: false,
    });
    const screenshot = envelope.sources.find((source) => source.source === 'screenshot');
    expect(screenshot.facts).toMatchObject({
      artifactRef: null,
      suppressed: true,
      suppressionReason: 'sensitive_capture_requires_explicit_redaction',
    });
    const browserEvent = envelope.sources.find((source) => source.source === 'browser_event');
    expect(browserEvent.facts.events[0]).toMatchObject({
      valueRef: 'env:QAAI_PASSWORD',
      valuePersistence: 'value_ref_only',
      valueRefMissing: false,
    });
  });

  test('forces sensitive normalization from the action request even when a source omits password semantics', async () => {
    const adapter = new PlaywrightCdpEvidenceAdapter({
      fingerprintSalt: 'forced-sensitive',
      idFactory: () => 'evidence-forced-sensitive',
      captureDom: async () => ({ tagName: 'input', value: 'unlabelled-secret-value' }),
    });

    const envelope = await adapter.afterAction({
      actionType: 'fill',
      controlType: 'password',
      value: 'unlabelled-secret-value',
      valueRef: 'env:ACCOUNT_PASSWORD',
    });
    const serialized = JSON.stringify(envelope);
    const dom = envelope.sources.find((source) => source.source === 'dom');

    expect(serialized).not.toContain('unlabelled-secret-value');
    expect(dom.facts.state).toMatchObject({
      value: null,
      valueRef: 'env:ACCOUNT_PASSWORD',
      valueRedacted: true,
      valueLiteralPersisted: false,
    });
  });

  test('records cross-source identity conflicts without claiming semantic intent', () => {
    const envelope = createCaptureEnvelope({
      phase: 'action',
      request: { actionType: 'click', targetDescription: 'Equipment' },
      sources: [
        {
          source: 'cdp',
          authority: sourceAuthority('cdp'),
          status: 'captured',
          facts: { backendNodeId: 41, frameId: 'main', identity: { role: 'combobox', name: 'Equipment' } },
        },
        {
          source: 'accessibility',
          authority: sourceAuthority('accessibility'),
          status: 'captured',
          facts: { backendNodeId: 41, identity: { role: 'textbox', name: 'Equipment' } },
        },
      ],
    });

    expect(envelope.sourceCorrelation.backendNode).toMatchObject({ status: 'matched', value: 41 });
    expect(envelope.sourceCorrelation.fieldConflicts.role).toEqual(['combobox', 'textbox']);
    expect(envelope.sourceCorrelation.semanticIntentAssessment).toBe('not_performed');
    expect(envelope.semanticIntentClaimed).toBe(false);
  });

  test('captures provider errors as evidence and keeps the base contract abstract', async () => {
    const adapter = new PlaywrightCdpEvidenceAdapter({
      idFactory: () => 'evidence-error',
      capturePlaywright: async () => { throw new Error('locator failed'); },
    });
    const envelope = await adapter.beforeAction({ actionType: 'click', targetDescription: 'Submit' });
    const source = envelope.sources.find((entry) => entry.source === 'playwright');

    expect(source).toMatchObject({ status: 'capture_error', error: { message: 'locator failed' } });
    await expect(new BrowserEvidenceAdapter().beforeAction({})).rejects.toThrow(/must be implemented/);
  });

  test('serializes cycles, dates, bigint, and binary data without leaking object internals', () => {
    const input = {
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      count: 9n,
      bytes: Buffer.from('private-image'),
    };
    input.self = input;

    const output = toSerializable(input);
    expect(output).toMatchObject({
      createdAt: '2026-07-20T00:00:00.000Z',
      count: '9',
      bytes: { omittedBinary: true },
      self: '[Circular]',
    });
    expect(JSON.stringify(output)).not.toContain('private-image');
  });

  test('builds a stable envelope from already-normalized sources', () => {
    const envelope = createCaptureEnvelope({
      phase: 'pre',
      evidenceId: 'evidence-1',
      capturedAt: 100,
      request: { actionOccurrenceId: 'occ-1', actionType: 'click', targetDescription: 'Create Order' },
      sources: [{
        source: 'accessibility',
        authority: sourceAuthority('accessibility'),
        status: 'captured',
        facts: { identity: { role: 'button', name: 'Create Order' } },
      }],
    });

    expect(envelope).toMatchObject({
      phase: 'pre',
      evidenceId: 'evidence-1',
      observedIdentity: {
        facts: { role: 'button', name: 'Create Order' },
        intentAssessment: 'not_performed',
        intentMatch: null,
      },
      semanticIntentClaimed: false,
    });
  });
});
