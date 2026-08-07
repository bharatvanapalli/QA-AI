'use strict';

const recorder = require('../../server/services/inPageEventRecorder');

describe('inPageEventRecorder', () => {
  test('builds an idempotent initialization source for every required event type', () => {
    const source = recorder.createRecorderInitializationSource({ maxEvents: 25 });

    expect(source).toContain(recorder.RECORDER_KEY);
    expect(source).toContain('maxEvents = 25');
    expect(source).toContain('event.composedPath()');
    expect(source).toContain('eventPath.find');
    expect(source).toContain('deepActivePath');
    expect(source).toContain('frameContextPath');
    expect(source).toContain('shadowHostPath');
    expect(source).toContain('bindValueRef(node, valueRef)');
    expect(source).toContain("crypto.subtle.digest('SHA-256'");
    for (const type of [
      'click', 'pointerdown', 'input', 'change', 'keydown', 'submit',
      'focus', 'blur', 'mouseover', 'mouseenter',
    ]) {
      expect(source).toContain(`\"${type}\"`);
    }
    expect(source).not.toContain('afterValue: currentValue');
    expect(recorder.installExpression).toBe(recorder.createRecorderInitializationSource);
    expect(recorder.drainExpression()).toContain('await recorder.drain()');
    expect(recorder.peekExpression()).toContain('await recorder.peek()');
    expect(recorder.uninstallExpression()).toContain('recorder.uninstall()');
  });

  test('redacts password values, bearer tokens, and sensitive URL parameters', () => {
    const normalized = recorder.normalizeRecorderEvents([{
      eventId: 'event-1',
      sequence: 1,
      type: 'input',
      at: 123,
      url: 'https://example.test/?token=raw-token&safe=yes',
      target: {
        tagName: 'input',
        id: 'account-password',
        label: 'Password',
        inputType: 'password',
      },
      value: 'Behavior-ticket-organize1*',
      valueRef: 'env:QAAI_PASSWORD',
      authorization: 'Bearer raw-authorization-token',
    }], { fingerprintSalt: 'test-run' });

    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain('raw-token');
    expect(serialized).not.toContain('raw-authorization-token');
    expect(serialized).not.toContain('Behavior-ticket-organize1*');
    expect(normalized[0].target.id).toBe('account-password');
    expect(normalized[0]).toMatchObject({
      valueRef: 'env:QAAI_PASSWORD',
      valuePersistence: 'value_ref_only',
      valueRefMissing: false,
    });
    expect(normalized[0].afterValueFingerprint.digest).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(normalized[0].afterValueFingerprint.sensitive).toBe(true);
  });

  test('normalizes composed path, control state, pointer data, and safe keyboard categories', () => {
    const [event] = recorder.normalizeRecorderEvents([{
      type: 'keydown',
      key: 'x',
      code: 'KeyX',
      ctrlKey: true,
      target: {
        tagName: 'input',
        role: 'combobox',
        name: 'Equipment',
        expanded: 'true',
      },
      activeElement: { tagName: 'input', role: 'combobox', name: 'Equipment' },
      activeElementPath: [
        { tagName: 'qaai-shell', role: 'group', name: 'Order editor' },
        { tagName: 'input', role: 'combobox', name: 'Equipment' },
      ],
      composedPath: [
        { tagName: 'input', role: 'combobox', name: 'Equipment' },
        { tagName: 'div', role: 'group', name: 'General Information' },
      ],
      framePath: [{
        frameName: 'order-frame',
        url: 'https://example.test/order?state=private-state',
        frameElement: { tagName: 'iframe', title: 'Order editor' },
      }],
      shadowPath: [{ tagName: 'qaai-combobox', role: 'group', name: 'Equipment widget' }],
    }]);

    expect(event.key).toBe('[printable]');
    expect(event.code).toBe('KeyX');
    expect(event.modifiers.ctrl).toBe(true);
    expect(event.target).toMatchObject({ role: 'combobox', name: 'Equipment', expanded: true });
    expect(event.composedPath).toHaveLength(2);
    expect(event.activeElementPath).toHaveLength(2);
    expect(event.framePath).toHaveLength(1);
    expect(event.framePath[0].url).not.toContain('private-state');
    expect(event.shadowPath).toEqual([
      expect.objectContaining({ tagName: 'qaai-combobox', name: 'Equipment widget' }),
    ]);
    expect(event.authority).toMatchObject({ level: 'corroborating', rank: 70 });
    expect(event.authority.doesNotProve).toContain('requested_target_intent');
  });

  test('creates deterministic run-scoped fingerprints without retaining values', () => {
    const first = recorder.fingerprintValue('LTL', { salt: 'run-a' });
    const second = recorder.fingerprintValue('LTL', { salt: 'run-a' });
    const third = recorder.fingerprintValue('LTL', { salt: 'run-b' });

    expect(first).toEqual(second);
    expect(first.digest).not.toBe(third.digest);
    expect(JSON.stringify(first)).not.toContain('LTL');
    expect(first).toMatchObject({ length: 3, present: true, sensitive: false });
  });

  test('keeps only the newest bounded evidence events and normalizes unknown types', () => {
    const normalized = recorder.normalizeRecorderEvents([
      { type: 'click', at: 1 },
      { type: 'change', at: 2 },
      { type: 'not-supported', at: 3 },
    ], { maxEvents: 2 });

    expect(normalized.map((event) => event.at)).toEqual([2, 3]);
    expect(normalized.map((event) => event.type)).toEqual(['change', 'unknown']);
  });

  test('captures the actual composed shadow target, deep active element, paths, and value fingerprint', async () => {
    document.body.innerHTML = '';
    const host = document.createElement('qaai-password-field');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    input.type = 'password';
    input.id = 'account-password';
    input.setAttribute('aria-label', 'Password');
    shadowRoot.appendChild(input);
    document.body.appendChild(host);

    window.eval(recorder.createRecorderInitializationSource({ maxEvents: 20 }));
    const installed = window[recorder.RECORDER_KEY];
    expect(installed.bindValueRef(input, 'env:ACCOUNT_PASSWORD')).toBe(true);

    try {
      input.focus();
      input.value = 'runtime-secret-value';
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
      }));
      const rawEvents = await installed.drain();
      const normalized = recorder.normalizeRecorderEvents(rawEvents);
      const inputEvent = normalized.find((event) => event.type === 'input');
      const serialized = JSON.stringify(normalized);

      expect(inputEvent).toBeTruthy();
      expect(inputEvent.target).toMatchObject({
        tagName: 'input',
        id: 'account-password',
        inputType: 'password',
      });
      expect(inputEvent.composedPath.map((entry) => entry.tagName)).toEqual(
        expect.arrayContaining(['input', 'qaai-password-field']),
      );
      expect(inputEvent.activeElement).toMatchObject({ tagName: 'input', id: 'account-password' });
      expect(inputEvent.activeElementPath.map((entry) => entry.tagName)).toEqual([
        'qaai-password-field',
        'input',
      ]);
      expect(inputEvent.shadowPath).toEqual([
        expect.objectContaining({ tagName: 'qaai-password-field' }),
      ]);
      expect(inputEvent.framePath.length).toBeGreaterThan(0);
      expect(inputEvent.afterValueFingerprint).toMatchObject({ present: true, sensitive: true });
      expect(inputEvent.valueRef).toBe('env:ACCOUNT_PASSWORD');
      expect(serialized).not.toContain('runtime-secret-value');
    } finally {
      installed.uninstall();
      document.body.innerHTML = '';
    }
  });
});
