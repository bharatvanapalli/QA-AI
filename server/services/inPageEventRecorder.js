'use strict';

const crypto = require('crypto');

const RECORDER_KEY = '__qaaiEvidenceRecorderV1';
const RECORDER_VERSION = 3;
const DEFAULT_MAX_EVENTS = 100;
const MAX_TEXT_LENGTH = 1000;
const SUPPORTED_EVENT_TYPES = Object.freeze([
  'click',
  'pointerdown',
  'input',
  'change',
  'keydown',
  'submit',
  'focus',
  'blur',
  'mouseover',
  'mouseenter',
  'navigation',
]);

const SENSITIVE_RE = /(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|session|otp|pin|credential)/i;
const SAFE_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space',
]);

function boundedEventCount(value) {
  return Math.max(1, Math.min(Number(value) || DEFAULT_MAX_EVENTS, 500));
}

function sanitizeText(value, { maxLength = MAX_TEXT_LENGTH } = {}) {
  if (value == null) return value;
  let output = String(value);
  output = output.replace(/([?&#](?:token|key|secret|password|passwd|session|auth|authorization|code|access_token|refresh_token)=)[^&#\s]*/gi, '$1[REDACTED]');
  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, 'Bearer [REDACTED]');
  output = output.replace(/\b(Basic)\s+[A-Za-z0-9+/=]+\b/gi, '$1 [REDACTED]');
  output = output.replace(/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie|session)\s*[:=]\s*)[^,;\s]+/gi, '$1[REDACTED]');
  output = output.replace(/(\[\s*value\s*=\s*["'])[^"']*(["']\s*\])/gi, '$1[REDACTED]$2');
  return output.slice(0, Math.max(0, Number(maxLength) || MAX_TEXT_LENGTH));
}

function sanitizeUrl(value) {
  if (!value) return '';
  const raw = sanitizeText(value);
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = '[REDACTED]';
    if (parsed.password) parsed.password = '[REDACTED]';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_RE.test(key) || /^(?:code|state|nonce)$/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    parsed.hash = sanitizeText(parsed.hash);
    return parsed.toString().slice(0, MAX_TEXT_LENGTH);
  } catch (_) {
    return raw;
  }
}

function isSensitiveDescriptor(value) {
  if (!value || typeof value !== 'object') return false;
  return Boolean(value.sensitive)
    || String(value.inputType || value.type || '').toLowerCase() === 'password'
    || SENSITIVE_RE.test([
      value.id,
      value.name,
      value.label,
      value.ariaLabel,
      value.placeholder,
      value.selector,
      value.target,
    ].filter(Boolean).join(' '));
}

function fingerprintValue(value, { salt = 'qaai-event-evidence', sensitive = false } = {}) {
  if (value == null) return null;
  const raw = String(value);
  const digest = crypto.createHmac('sha256', String(salt)).update(raw, 'utf8').digest('hex');
  return {
    algorithm: 'hmac-sha256',
    digest: `hmac-sha256:${digest}`,
    length: raw.length,
    present: raw.length > 0,
    sensitive: Boolean(sensitive),
  };
}

function normalizeFingerprint(value) {
  if (!value || typeof value !== 'object') return null;
  const digest = sanitizeText(value.digest || '', { maxLength: 160 });
  if (!/^(?:hmac-)?sha256:[a-f0-9]{64}$/i.test(digest)) return null;
  return {
    algorithm: digest.startsWith('hmac-') ? 'hmac-sha256' : 'sha256',
    digest,
    length: Number.isFinite(Number(value.length)) ? Math.max(0, Number(value.length)) : null,
    present: Boolean(value.present),
    sensitive: Boolean(value.sensitive),
  };
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function normalizeElementDescriptor(value, { sensitive = false } = {}) {
  if (!value || typeof value !== 'object') return null;
  const descriptorSensitive = sensitive || isSensitiveDescriptor(value);
  const safeName = (field) => {
    return sanitizeText(value[field] ?? null, { maxLength: 300 });
  };
  return {
    tagName: safeName('tagName')?.toLowerCase() || null,
    role: safeName('role'),
    name: safeName('name') || safeName('ariaLabel'),
    label: safeName('label'),
    placeholder: safeName('placeholder'),
    title: safeName('title'),
    alt: safeName('alt'),
    id: safeName('id'),
    testId: safeName('testId'),
    inputType: safeName('inputType') || safeName('type'),
    selectorHint: safeName('selectorHint') || safeName('selector') || safeName('target'),
    expanded: normalizeBoolean(value.expanded),
    selected: normalizeBoolean(value.selected),
    checked: normalizeBoolean(value.checked),
    disabled: normalizeBoolean(value.disabled),
    readOnly: normalizeBoolean(value.readOnly),
    editable: normalizeBoolean(value.editable),
    visible: normalizeBoolean(value.visible),
    sensitive: descriptorSensitive,
  };
}

function normalizeContextPath(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, 16)
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      return {
        frameId: sanitizeText(entry.frameId || null, { maxLength: 160 }),
        frameName: sanitizeText(entry.frameName || entry.name || null, { maxLength: 200 }),
        url: sanitizeUrl(entry.url || ''),
        host: normalizeElementDescriptor(entry.host || entry.frameElement || entry.element || entry),
      };
    })
    .filter(Boolean);
}

function normalizeKey(value) {
  const key = String(value || '');
  if (!key) return null;
  if (SAFE_KEYS.has(key) || /^F(?:[1-9]|1[0-2])$/.test(key)) return key;
  return key.length === 1 ? '[printable]' : '[non-printable]';
}

function normalizeRecorderEvent(event, {
  fingerprintSalt = 'qaai-event-evidence',
  defaultValueRef = null,
} = {}) {
  const rawType = String(event?.type || '').toLowerCase();
  const type = SUPPORTED_EVENT_TYPES.includes(rawType) ? rawType : 'unknown';
  const targetInput = event?.target && typeof event.target === 'object'
    ? event.target
    : { selectorHint: event?.target, inputType: event?.inputType };
  const sensitive = Boolean(event?.sensitive) || isSensitiveDescriptor(targetInput);
  const target = normalizeElementDescriptor(targetInput, { sensitive });
  const rawAfterValue = event?.afterValue ?? event?.value ?? event?.targetValue;
  const rawBeforeValue = event?.beforeValue;
  const beforeValueFingerprint = normalizeFingerprint(event?.beforeValueFingerprint)
    || fingerprintValue(rawBeforeValue, { salt: fingerprintSalt, sensitive });
  const afterValueFingerprint = normalizeFingerprint(event?.afterValueFingerprint || event?.valueFingerprint)
    || fingerprintValue(rawAfterValue, { salt: fingerprintSalt, sensitive });
  const path = Array.isArray(event?.composedPath) ? event.composedPath : [];

  return {
    eventId: sanitizeText(event?.eventId || null, { maxLength: 120 }),
    sequence: Number.isFinite(Number(event?.sequence)) ? Number(event.sequence) : null,
    type,
    at: Number.isFinite(Number(event?.at)) ? Number(event.at) : null,
    url: sanitizeUrl(event?.url || ''),
    target,
    activeElement: normalizeElementDescriptor(event?.activeElement, { sensitive: isSensitiveDescriptor(event?.activeElement) }),
    activeElementPath: (Array.isArray(event?.activeElementPath) ? event.activeElementPath : [])
      .slice(0, 16)
      .map((entry) => normalizeElementDescriptor(entry, { sensitive: isSensitiveDescriptor(entry) }))
      .filter(Boolean),
    relatedTarget: normalizeElementDescriptor(event?.relatedTarget, { sensitive: isSensitiveDescriptor(event?.relatedTarget) }),
    composedPath: path.slice(0, 16).map((entry) => normalizeElementDescriptor(entry, {
      sensitive: isSensitiveDescriptor(entry),
    })).filter(Boolean),
    framePath: normalizeContextPath(event?.framePath),
    shadowPath: (Array.isArray(event?.shadowPath) ? event.shadowPath : [])
      .slice(0, 16)
      .map((entry) => normalizeElementDescriptor(entry?.host || entry, {
        sensitive: isSensitiveDescriptor(entry?.host || entry),
      }))
      .filter(Boolean),
    inputType: sanitizeText(event?.inputType || target?.inputType || null, { maxLength: 80 }),
    key: normalizeKey(event?.key),
    code: type === 'keydown' ? sanitizeText(event?.code || null, { maxLength: 80 }) : null,
    modifiers: {
      alt: Boolean(event?.altKey),
      ctrl: Boolean(event?.ctrlKey),
      meta: Boolean(event?.metaKey),
      shift: Boolean(event?.shiftKey),
    },
    pointer: {
      button: Number.isFinite(Number(event?.button)) ? Number(event.button) : null,
      buttons: Number.isFinite(Number(event?.buttons)) ? Number(event.buttons) : null,
      pointerType: sanitizeText(event?.pointerType || null, { maxLength: 40 }),
    },
    trusted: normalizeBoolean(event?.trusted ?? event?.isTrusted),
    defaultPrevented: Boolean(event?.defaultPrevented),
    valueChanged: Boolean(event?.valueChanged)
      || Boolean(beforeValueFingerprint && afterValueFingerprint
        && beforeValueFingerprint.digest !== afterValueFingerprint.digest),
    beforeValueFingerprint,
    afterValueFingerprint,
    valueRef: sensitive
      ? sanitizeText(event?.valueRef || defaultValueRef || null, { maxLength: 300 })
      : null,
    valuePersistence: sensitive ? 'value_ref_only' : 'fingerprint_only',
    valueRefMissing: Boolean(sensitive && !(event?.valueRef || defaultValueRef)),
    sensitive,
    source: 'in_page_event_recorder',
    authority: {
      level: 'corroborating',
      rank: 70,
      proves: ['browser_event_observed'],
      doesNotProve: ['requested_target_intent'],
    },
  };
}

function normalizeRecorderEvents(events, options = {}) {
  const boundedMax = boundedEventCount(options.maxEvents);
  return (Array.isArray(events) ? events : [])
    .slice(-boundedMax)
    .map((event) => normalizeRecorderEvent(event, options));
}

function createRecorderInitializationSource({ maxEvents = DEFAULT_MAX_EVENTS } = {}) {
  const boundedMax = boundedEventCount(maxEvents);
  const browserEventTypes = SUPPORTED_EVENT_TYPES.filter((type) => type !== 'navigation');
  return `(() => {
    const key = ${JSON.stringify(RECORDER_KEY)};
    const version = ${RECORDER_VERSION};
    if (window[key] && window[key].version === version) {
      return { installed: true, reused: true, version };
    }
    if (window[key] && typeof window[key].uninstall === 'function') {
      try { window[key].uninstall(); } catch (_) {}
    }
    const maxEvents = ${boundedMax};
    const eventTypes = ${JSON.stringify(browserEventTypes)};
    const queue = [];
    const pending = new Set();
    const lastValueFingerprint = new WeakMap();
    const valueRefs = new WeakMap();
    let sequence = 0;
    const saltBytes = new Uint8Array(16);
    crypto.getRandomValues(saltBytes);
    const salt = Array.from(saltBytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const sensitivePattern = ${SENSITIVE_RE.toString()};
    const sanitize = (value, max = 300) => value == null ? null : String(value)
      .replace(/([?&#](?:token|key|secret|password|passwd|session|auth|authorization|code|state|nonce|access_token|refresh_token)=)[^&#\\s]*/gi, '$1[REDACTED]')
      .replace(/\\bBearer\\s+[A-Za-z0-9._~+\\/-]+=*\\b/gi, 'Bearer [REDACTED]')
      .slice(0, max);
    const boolAttr = (node, name) => {
      if (!node || !node.getAttribute) return null;
      const value = node.getAttribute(name);
      return value === 'true' ? true : value === 'false' ? false : null;
    };
    const isSensitive = (node) => {
      if (!node || node.nodeType !== 1) return false;
      return String(node.type || '').toLowerCase() === 'password'
        || sensitivePattern.test([
          node.id,
          node.name,
          node.getAttribute('aria-label'),
          node.getAttribute('autocomplete'),
          node.getAttribute('title'),
          node.placeholder,
          node.labels && node.labels[0] && node.labels[0].innerText,
        ].filter(Boolean).join(' '));
    };
    const selectorHint = (node) => {
      if (!node || node.nodeType !== 1) return null;
      const tag = String(node.tagName || '').toLowerCase();
      const testId = node.getAttribute && (node.getAttribute('data-testid') || node.getAttribute('data-qaai-id'));
      const id = node.id ? '#' + String(node.id).replace(/[^A-Za-z0-9_-]/g, '') : '';
      return sanitize(testId ? tag + '[data-testid="' + testId + '"]' : tag + id);
    };
    const describe = (node) => {
      if (!node || node.nodeType !== 1) return null;
      const sensitive = isSensitive(node);
      return {
        tagName: sanitize(String(node.tagName || '').toLowerCase(), 60),
        role: sanitize(node.getAttribute && node.getAttribute('role'), 100),
        name: sanitize(node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('name')), 200),
        label: sanitize(node.labels && node.labels[0] && node.labels[0].innerText, 200),
        placeholder: sanitize(node.getAttribute && node.getAttribute('placeholder'), 200),
        title: sanitize(node.getAttribute && node.getAttribute('title'), 200),
        alt: sanitize(node.getAttribute && node.getAttribute('alt'), 200),
        id: sanitize(node.id, 120),
        testId: sanitize(node.getAttribute && (node.getAttribute('data-testid') || node.getAttribute('data-qaai-id')), 120),
        inputType: sanitize(node.type, 60),
        selectorHint: selectorHint(node),
        expanded: boolAttr(node, 'aria-expanded'),
        selected: boolAttr(node, 'aria-selected'),
        checked: typeof node.checked === 'boolean' ? node.checked : boolAttr(node, 'aria-checked'),
        disabled: typeof node.disabled === 'boolean' ? node.disabled : boolAttr(node, 'aria-disabled'),
        readOnly: typeof node.readOnly === 'boolean' ? node.readOnly : null,
        editable: node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName),
        sensitive,
      };
    };
    const readValue = (node) => {
      if (!node || node.nodeType !== 1) return null;
      if ('value' in node) return node.value == null ? null : String(node.value);
      if (node.isContentEditable) return String(node.textContent || '');
      return null;
    };
    const deepActivePath = () => {
      const path = [];
      let active = document.activeElement;
      while (active && active.nodeType === 1) {
        path.push(active);
        active = active.shadowRoot && active.shadowRoot.activeElement;
      }
      return path;
    };
    const shadowHostPath = (node) => {
      const hosts = [];
      let current = node;
      while (current && typeof current.getRootNode === 'function') {
        const root = current.getRootNode();
        const host = root && root.host;
        if (!host || host.nodeType !== 1) break;
        hosts.push(host);
        current = host;
      }
      return hosts;
    };
    const frameContextPath = () => {
      const frames = [];
      let currentWindow = window;
      for (let depth = 0; depth < 16; depth += 1) {
        let frameElement = null;
        try { frameElement = currentWindow.frameElement; } catch (_) { frameElement = null; }
        let frameName = null;
        let frameUrl = null;
        try { frameName = sanitize(currentWindow.name, 200); } catch (_) { frameName = null; }
        try { frameUrl = sanitize(String(currentWindow.location && currentWindow.location.href || ''), 1000); } catch (_) { frameUrl = null; }
        frames.unshift({ frameName, url: frameUrl, frameElement: describe(frameElement) });
        if (!frameElement) break;
        try { currentWindow = currentWindow.parent; } catch (_) { break; }
      }
      return frames;
    };
    const fingerprint = async (value, sensitive) => {
      if (value == null) return null;
      const raw = String(value);
      const bytes = new TextEncoder().encode(salt + '\\u0000' + raw);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return { algorithm: 'sha256', digest: 'sha256:' + hex, length: raw.length, present: raw.length > 0, sensitive: Boolean(sensitive) };
    };
    const keyCategory = (keyValue) => {
      const keyName = String(keyValue || '');
      const safe = new Set(['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Space']);
      if (safe.has(keyName) || /^F(?:[1-9]|1[0-2])$/.test(keyName)) return keyName;
      return keyName.length === 1 ? '[printable]' : keyName ? '[non-printable]' : null;
    };
    const push = (entry) => {
      queue.push(entry);
      queue.sort((left, right) => left.sequence - right.sequence);
      if (queue.length > maxEvents) queue.splice(0, queue.length - maxEvents);
    };
    const record = (type, event = {}) => {
      const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const target = eventPath.find((entry) => entry && entry.nodeType === 1)
        || (event.target && event.target.nodeType === 1 ? event.target : null);
      const eventSequence = ++sequence;
      const currentValue = readValue(target);
      const sensitive = isSensitive(target);
      const beforeValueFingerprint = target ? lastValueFingerprint.get(target) || null : null;
      const activePath = deepActivePath();
      const framePath = frameContextPath();
      const shadowPath = shadowHostPath(target);
      const task = Promise.resolve(fingerprint(currentValue, sensitive)).then((afterValueFingerprint) => {
        if (target && afterValueFingerprint) lastValueFingerprint.set(target, afterValueFingerprint);
        push({
          eventId: 'browser-event-' + eventSequence,
          sequence: eventSequence,
          type,
          at: Date.now(),
          url: sanitize(String(location.href), 1000),
          target: describe(target),
          activeElement: describe(activePath[activePath.length - 1] || document.activeElement),
          activeElementPath: activePath.map(describe).filter(Boolean),
          relatedTarget: describe(event.relatedTarget),
          composedPath: eventPath.slice(0, 16).map(describe).filter(Boolean),
          framePath,
          shadowPath: shadowPath.map(describe).filter(Boolean),
          inputType: sanitize(event.inputType || (target && target.type), 80),
          key: type === 'keydown' ? keyCategory(event.key) : null,
          code: type === 'keydown' ? sanitize(event.code, 80) : null,
          altKey: Boolean(event.altKey),
          ctrlKey: Boolean(event.ctrlKey),
          metaKey: Boolean(event.metaKey),
          shiftKey: Boolean(event.shiftKey),
          button: Number.isFinite(event.button) ? event.button : null,
          buttons: Number.isFinite(event.buttons) ? event.buttons : null,
          pointerType: sanitize(event.pointerType, 40),
          trusted: Boolean(event.isTrusted),
          defaultPrevented: Boolean(event.defaultPrevented),
          valueChanged: Boolean(beforeValueFingerprint && afterValueFingerprint && beforeValueFingerprint.digest !== afterValueFingerprint.digest),
          beforeValueFingerprint,
          afterValueFingerprint,
          valueRef: sensitive && target
            ? sanitize(valueRefs.get(target) || (target.getAttribute && target.getAttribute('data-qaai-value-ref')), 300)
            : null,
          sensitive,
        });
      }).finally(() => pending.delete(task));
      pending.add(task);
    };
    const listeners = eventTypes.map((type) => {
      const handler = (event) => record(type, event);
      addEventListener(type, handler, true);
      return { type, handler };
    });
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    history.pushState = (...args) => { const out = originalPushState(...args); record('navigation'); return out; };
    history.replaceState = (...args) => { const out = originalReplaceState(...args); record('navigation'); return out; };
    const popstateHandler = (event) => record('navigation', event);
    addEventListener('popstate', popstateHandler, true);
    window[key] = {
      version,
      async flush() { await Promise.allSettled(Array.from(pending)); return queue.length; },
      async drain() { await this.flush(); return queue.splice(0, queue.length); },
      async peek() { await this.flush(); return queue.slice(); },
      size() { return queue.length; },
      bindValueRef(node, valueRef) {
        if (!node || node.nodeType !== 1) return false;
        const safeRef = sanitize(valueRef, 300);
        if (!safeRef || /\\s/.test(safeRef)) return false;
        valueRefs.set(node, safeRef);
        return true;
      },
      uninstall() {
        listeners.forEach(({ type, handler }) => removeEventListener(type, handler, true));
        removeEventListener('popstate', popstateHandler, true);
        history.pushState = originalPushState;
        history.replaceState = originalReplaceState;
        delete window[key];
        return { uninstalled: true, version };
      },
    };
    return { installed: true, reused: false, version };
  })()`;
}

function drainExpression() {
  return `(async () => {
    const recorder = window[${JSON.stringify(RECORDER_KEY)}];
    return recorder && typeof recorder.drain === 'function' ? await recorder.drain() : [];
  })()`;
}

function peekExpression() {
  return `(async () => {
    const recorder = window[${JSON.stringify(RECORDER_KEY)}];
    return recorder && typeof recorder.peek === 'function' ? await recorder.peek() : [];
  })()`;
}

function uninstallExpression() {
  return `(() => {
    const recorder = window[${JSON.stringify(RECORDER_KEY)}];
    return recorder && typeof recorder.uninstall === 'function'
      ? recorder.uninstall()
      : { uninstalled: false, version: ${RECORDER_VERSION} };
  })()`;
}

const installExpression = createRecorderInitializationSource;

module.exports = {
  RECORDER_KEY,
  RECORDER_VERSION,
  DEFAULT_MAX_EVENTS,
  SUPPORTED_EVENT_TYPES,
  SENSITIVE_RE,
  sanitizeText,
  sanitizeUrl,
  isSensitiveDescriptor,
  fingerprintValue,
  normalizeElementDescriptor,
  normalizeContextPath,
  normalizeRecorderEvent,
  normalizeRecorderEvents,
  createRecorderInitializationSource,
  installExpression,
  drainExpression,
  peekExpression,
  uninstallExpression,
};
