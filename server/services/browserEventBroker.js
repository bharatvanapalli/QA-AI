'use strict';

/**
 * Pre-armed, website-neutral broker for browser events with side effects.
 * Browser control and persistence stay behind injected adapters; this module
 * only owns ordering, bounded settlement, typed proof, and idempotency.
 */

const crypto = require('crypto');
const path = require('path');
const waitContract = require('./waitContract');
const pageFingerprint = require('./pageFingerprint');

const CONTRACT_SCHEMA = 'qaai_browser_event_contract_v1';
const EVIDENCE_SCHEMA = 'qaai_browser_event_evidence_v1';
const MAX_TIMEOUT_MS = 120_000;
const HANDLE_RECORD = Symbol('qaaiBrowserEventRecord');

const EVENT_KINDS = Object.freeze({
  POPUP: 'popup',
  DOWNLOAD: 'download',
  FILE_CHOOSER: 'file_chooser',
  UPLOAD: 'upload',
  DIALOG: 'dialog',
  NAVIGATION: 'navigation',
  PAGE_CHANGE: 'page_change',
});
const KINDS = new Set(Object.values(EVENT_KINDS));

function clean(value, limit = 500) {
  return String(value == null ? '' : value)
    .replace(/\b(password|passcode|pwd|secret|token|api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

function boundedNumber(value, fallback, minimum = 0, maximum = MAX_TIMEOUT_MS) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, Math.floor(number)))
    : fallback;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20);
}

function baseName(value) {
  const text = clean(value, 1000);
  return text ? path.basename(text.replace(/\\/g, '/')).slice(0, 240) || null : null;
}

function normalizeEventKind(value) {
  const raw = clean(value, 120).toLowerCase().replace(/-/g, '_');
  if (!raw) return null;
  if (KINDS.has(raw)) return raw;
  if (/popup|new[_ ]?(?:page|tab|window)/.test(raw)) return EVENT_KINDS.POPUP;
  if (/file[_ ]?chooser/.test(raw)) return EVENT_KINDS.FILE_CHOOSER;
  if (/download/.test(raw)) return EVENT_KINDS.DOWNLOAD;
  if (/upload|attach/.test(raw)) return EVENT_KINDS.UPLOAD;
  if (/dialog|alert|confirm|prompt/.test(raw)) return EVENT_KINDS.DIALOG;
  if (/page[_ ]?change|fingerprint[_ ]?change/.test(raw)) return EVENT_KINDS.PAGE_CHANGE;
  if (/navigation|navigate|goto|open[_ ]?url|url[_ ]?change/.test(raw)) return EVENT_KINDS.NAVIGATION;
  return null;
}

function inferKind(input, wait) {
  const direct = normalizeEventKind(
    input.eventKind || input.event || input.expectedEvent
    || input.expected?.event || wait?.expected?.event,
  );
  if (direct) return direct;
  const action = clean(input.action || input.type || input.kind || input.stepKind, 160).toLowerCase();
  const effect = clean(input.expected?.effect || input.operationCheck?.kind || wait?.expected?.effect, 160).toLowerCase();
  if (/file[_ ]?chooser/.test(action)) return EVENT_KINDS.FILE_CHOOSER;
  if (/download/.test(action)) return EVENT_KINDS.DOWNLOAD;
  if (/upload|attach/.test(action)) return EVENT_KINDS.UPLOAD;
  if (/popup|new[_ ]?(?:page|tab|window)/.test(action)) return EVENT_KINDS.POPUP;
  if (/dialog|alert|confirm|prompt/.test(action) || /dialog|modal/.test(effect)) return EVENT_KINDS.DIALOG;
  if (wait?.kind === 'navigation' || /navigate|goto|open url/.test(action)) return EVENT_KINDS.NAVIGATION;
  if (/fingerprint_change|page_change/.test(effect)) return EVENT_KINDS.PAGE_CHANGE;
  return null;
}

function list(value) {
  return (Array.isArray(value) ? value : [value]).filter((item) => item != null && String(item).trim());
}

function normalizedExpected(kind, input, wait) {
  const source = {
    ...(wait?.expected && typeof wait.expected === 'object' ? wait.expected : {}),
    ...(input.expected && typeof input.expected === 'object' ? input.expected : {}),
  };
  return Object.freeze({
    urlPattern: clean(input.urlPattern || input.expectedUrlPattern || source.urlPattern, 1000) || null,
    readiness: clean(input.readiness || source.readiness, 80).toLowerCase() || null,
    filenamePattern: clean(input.filenamePattern || source.filenamePattern, 500) || null,
    minSize: boundedNumber(input.minSize ?? source.minSize, null, 0, Number.MAX_SAFE_INTEGER),
    mimeType: clean(input.mimeType || source.mimeType, 160).toLowerCase() || null,
    dialogType: clean(input.dialogType || source.dialogType || source.type, 80).toLowerCase() || null,
    messagePattern: clean(input.messagePattern || source.messagePattern, 500) || null,
    multiple: typeof (input.multiple ?? source.multiple) === 'boolean' ? (input.multiple ?? source.multiple) : null,
    fileCount: boundedNumber(input.fileCount ?? source.fileCount, null, 0, 10_000),
    fileNames: list(input.fileNames || source.fileNames).map(baseName).filter(Boolean),
    fingerprint: input.fingerprint || source.fingerprint || null,
    allowMultiple: input.allowMultiple === true || source.allowMultiple === true,
    adoptActivePage: input.adoptActivePage == null && source.adoptActivePage == null
      ? kind === EVENT_KINDS.POPUP
      : (input.adoptActivePage ?? source.adoptActivePage) === true,
  });
}

function buildEventContract(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('browser event contract input must be an object');
  }
  if (input.schema === CONTRACT_SCHEMA && KINDS.has(input.eventKind)) return input;
  const step = input.step && typeof input.step === 'object' ? input.step : input;
  const merged = { ...step, ...input };
  const wait = input.waitContract && typeof input.waitContract === 'object'
    ? input.waitContract
    : waitContract.buildWaitContract(step);
  const eventKind = inferKind(merged, wait);
  if (!eventKind) throw new TypeError('browser event contract requires a supported typed event kind');
  const navigationLike = [EVENT_KINDS.NAVIGATION, EVENT_KINDS.PAGE_CHANGE].includes(eventKind);
  const timeoutMs = boundedNumber(
    input.timeoutMs ?? wait.timeoutMs,
    navigationLike ? waitContract.DEFAULT_TIMEOUTS.navigation : waitContract.DEFAULT_TIMEOUTS.action,
    1,
  );
  return Object.freeze({
    schema: CONTRACT_SCHEMA,
    eventKind,
    armBeforeTrigger: true,
    timeoutMs,
    pollIntervalMs: boundedNumber(input.pollIntervalMs ?? wait.pollIntervalMs, waitContract.POLL_INTERVAL_MS, 1, timeoutMs),
    stableObservations: boundedNumber(input.stableObservations ?? wait.stableObservations, waitContract.STABLE_OBSERVATIONS, 1, 20),
    expected: normalizedExpected(eventKind, merged, wait),
    idempotencyKey: clean(input.idempotencyKey || input.actionId, 500) || null,
    duplicatePolicy: 'reuse_result_never_retrigger_automatically',
    sourceWaitContract: Object.freeze({ schema: wait.schema || waitContract.SCHEMA, kind: wait.kind || null, expected: wait.expected || null }),
  });
}

function safeRegex(pattern) {
  if (!pattern) return null;
  try {
    const text = String(pattern);
    if (text.startsWith('/') && text.lastIndexOf('/') > 0) {
      const end = text.lastIndexOf('/');
      return new RegExp(text.slice(1, end), text.slice(end + 1));
    }
    return new RegExp(text, 'i');
  } catch (_) { return null; }
}

function fingerprintOf(value) {
  if (!value || typeof value !== 'object') return null;
  return value.fingerprint || value.pageFingerprint || value.afterFingerprint
    || (value.structuralHash || value.fields || value.controls ? value : null);
}

function compactFingerprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    schema: value.schema || pageFingerprint.SCHEMA,
    url: value.url || null,
    title: clean(value.title, 160) || null,
    primaryHeading: clean(value.primaryHeading, 180) || null,
    structuralHash: value.structuralHash || null,
  };
}

function eventUrl(event, after) {
  return clean(event?.url || event?.pageUrl || after?.url || fingerprintOf(after)?.url, 1000) || null;
}

function eventFiles(event) {
  const files = event?.acceptedFiles || event?.files || event?.fileNames || [];
  return list(files).map((item) => baseName(
    item && typeof item === 'object' ? item.name || item.path || item.fileName : item,
  )).filter(Boolean);
}

function verifyTypedEvent(contract, event = {}, context = {}) {
  const kind = contract.eventKind;
  const expected = contract.expected || {};
  const actualKind = normalizeEventKind(event.eventKind || event.kind || event.event || kind);
  if (actualKind && actualKind !== kind) {
    return {
      checked: false, matched: null, qaaiEvidenceError: true,
      reason: 'qaai_event_kind_mismatch',
      checks: [{ channel: 'event_kind', expected: kind, actual: actualKind, matched: false }],
    };
  }

  const checks = [];
  const missing = [];
  const add = (channel, wanted, actual, matched, requireActual = true) => {
    if (requireActual && (actual == null || actual === '')) {
      missing.push(channel);
      checks.push({ channel, expected: wanted, actual: null, matched: null });
    } else {
      checks.push({ channel, expected: wanted, actual, matched: matched === true });
    }
  };
  const after = context.after || event.after || null;
  const url = eventUrl(event, after);
  if (expected.urlPattern) add('url', expected.urlPattern, url, waitContract.urlMatches(url, expected.urlPattern));

  if (kind === EVENT_KINDS.DOWNLOAD) {
    const filename = baseName(event.suggestedFilename || event.filename || event.fileName || event.path);
    if (expected.filenamePattern) {
      const regex = safeRegex(expected.filenamePattern);
      if (!regex) missing.push('valid_filename_pattern');
      else add('filename', expected.filenamePattern, filename, regex.test(filename || ''));
    }
    if (expected.minSize != null) {
      const size = Number.isFinite(Number(event.sizeBytes ?? event.size)) ? Number(event.sizeBytes ?? event.size) : null;
      add('minimum_size', expected.minSize, size, size >= expected.minSize);
    }
    if (expected.mimeType) {
      const mime = clean(event.mimeType || event.mime, 160).toLowerCase() || null;
      add('mime_type', expected.mimeType, mime, mime === expected.mimeType);
    }
    if (event.complete === false) add('download_complete', true, false, false, false);
  } else if (kind === EVENT_KINDS.FILE_CHOOSER && expected.multiple != null) {
    const multiple = typeof event.multiple === 'boolean' ? event.multiple : null;
    add('multiple', expected.multiple, multiple, multiple === expected.multiple);
  } else if (kind === EVENT_KINDS.UPLOAD) {
    const files = eventFiles(event);
    const accepted = event.accepted === false
      ? false
      : event.accepted === true || event.uploaded === true || files.length > 0
        ? true
        : null;
    add('upload_accepted', true, accepted, accepted === true);
    if (expected.fileCount != null) add('file_count', expected.fileCount, files.length, files.length === expected.fileCount);
    if (expected.fileNames.length) {
      const actual = new Set(files.map((name) => name.toLowerCase()));
      add('file_names', expected.fileNames, files, expected.fileNames.every((name) => actual.has(name.toLowerCase())));
    }
  } else if (kind === EVENT_KINDS.DIALOG) {
    if (expected.dialogType) {
      const type = clean(event.dialogType || event.subtype, 80).toLowerCase() || null;
      add('dialog_type', expected.dialogType, type, type === expected.dialogType);
    }
    if (expected.messagePattern) {
      const regex = safeRegex(expected.messagePattern);
      const message = clean(event.message || event.text, 1000) || null;
      if (!regex) missing.push('valid_message_pattern');
      else add('dialog_message', expected.messagePattern, message, regex.test(message || ''));
    }
  } else if ([EVENT_KINDS.NAVIGATION, EVENT_KINDS.PAGE_CHANGE].includes(kind)) {
    const beforeFp = fingerprintOf(context.baseline);
    const afterFp = fingerprintOf(after) || fingerprintOf(event);
    if (expected.fingerprint) {
      add('fingerprint', compactFingerprint(expected.fingerprint), compactFingerprint(afterFp),
        !!afterFp && pageFingerprint.equivalent(expected.fingerprint, afterFp));
    }
    if (expected.readiness) {
      const readiness = clean(event.readiness || event.readyState || after?.readiness, 80).toLowerCase() || null;
      add('readiness', expected.readiness, readiness, readiness === expected.readiness);
    }
    if (!expected.urlPattern && !expected.fingerprint && !expected.readiness) {
      let observed = null;
      let channels = [];
      if (event.changed === true || event.navigated === true) observed = true;
      else if (kind === EVENT_KINDS.NAVIGATION && url) observed = true;
      else if (beforeFp && afterFp) {
        const diff = pageFingerprint.diff(beforeFp, afterFp);
        observed = diff.changed;
        channels = diff.channels;
      }
      add(kind === EVENT_KINDS.NAVIGATION ? 'navigation_observed' : 'page_change_observed', true, observed, observed === true);
      if (channels.length) checks[checks.length - 1].channels = channels;
    }
  }

  if (missing.length) {
    return {
      checked: checks.length > 0, matched: null, qaaiEvidenceError: true,
      reason: 'qaai_typed_event_evidence_incomplete',
      missingEvidence: [...new Set(missing)], checks,
    };
  }
  if (checks.some((check) => check.matched === false)) {
    return { checked: true, matched: false, qaaiEvidenceError: false, reason: `${kind}_expected_evidence_not_matched`, checks };
  }
  return { checked: true, matched: true, qaaiEvidenceError: false, reason: `${kind}_event_confirmed`, checks };
}

function sanitizeEvent(event = {}, kind) {
  const fp = fingerprintOf(event);
  return {
    eventKind: normalizeEventKind(event.eventKind || event.kind || event.event || kind) || kind,
    observedAt: event.observedAt || null,
    pageId: clean(event.pageId || event.targetId, 160) || null,
    tabIndex: Number.isFinite(Number(event.tabIndex)) ? Number(event.tabIndex) : null,
    url: eventUrl(event, event.after),
    suggestedFilename: baseName(event.suggestedFilename || event.filename || event.fileName || event.path),
    sizeBytes: Number.isFinite(Number(event.sizeBytes ?? event.size)) ? Number(event.sizeBytes ?? event.size) : null,
    mimeType: clean(event.mimeType || event.mime, 160).toLowerCase() || null,
    complete: typeof event.complete === 'boolean' ? event.complete : null,
    multiple: typeof event.multiple === 'boolean' ? event.multiple : null,
    accepted: typeof event.accepted === 'boolean' ? event.accepted : (event.uploaded === true ? true : null),
    files: eventFiles(event),
    dialogType: clean(event.dialogType || event.subtype, 80).toLowerCase() || null,
    message: clean(event.message || event.text, 1000) || null,
    readiness: clean(event.readiness || event.readyState, 80).toLowerCase() || null,
    changed: typeof event.changed === 'boolean' ? event.changed : null,
    navigated: typeof event.navigated === 'boolean' ? event.navigated : null,
    fingerprint: compactFingerprint(fp),
  };
}

function sanitizeAdoption(value) {
  if (value === true) return { adopted: true };
  if (!value || typeof value !== 'object') return null;
  return {
    adopted: value.adopted === true,
    source: clean(value.source, 160) || null,
    pageId: clean(value.pageId || value.targetId, 160) || null,
    tabIndex: Number.isFinite(Number(value.tabIndex)) ? Number(value.tabIndex) : null,
    url: clean(value.url || value.pageUrl, 1000) || null,
    reason: clean(value.reason, 500) || null,
    error: clean(value.error, 700) || null,
  };
}

function eventAdapter(adapters, kind) {
  const source = adapters?.events && typeof adapters.events === 'object' ? adapters.events : adapters;
  const aliases = {
    popup: ['popup', 'newPage', 'new_page'], download: ['download'],
    file_chooser: ['fileChooser', 'file_chooser'], upload: ['upload'], dialog: ['dialog'],
    navigation: ['navigation'], page_change: ['pageChange', 'page_change'],
  }[kind] || [kind];
  for (const alias of aliases) if (source?.[alias]) return source[alias];
  return adapters?.arm ? { arm: adapters.arm } : null;
}

function triggerEvidence(result, error) {
  return {
    started: true, finished: true, threw: !!error,
    reportedError: !!error || result?.isError === true || result?.ok === false,
    error: error
      ? clean(error.message || error, 700)
      : result?.isError ? clean(result.error || result.message || 'trigger reported an error', 700) : null,
    toolName: typeof result?.toolName === 'string' && result.toolName.trim()
      ? clean(result.toolName.trim(), 120)
      : null,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class BrowserEventBroker {
  // Per-kind adapter shape:
  //   arm({ contract, emit, signal, baseline }) -> {
  //     cleanup?, wait?, eventFromTrigger?, captureAfter?,
  //     adoptActivePage?, authoritative?, source?
  //   }
  // Global seams: captureBaseline, captureAfter, adoptActivePage, and
  // recordEvidence. An adapter must install its listener inside `arm` and
  // return before the broker invokes the trigger.
  constructor({ adapters = {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.adapters = adapters;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.records = new Map();
    this.sequence = 0;
  }

  async arm(input = {}, options = {}) {
    const contract = input.schema === CONTRACT_SCHEMA ? input : buildEventContract(input);
    const actionId = clean(options.actionId || options.idempotencyKey || contract.idempotencyKey, 500);
    if (!actionId) return this._failureHandle(contract, 'qaai_idempotency_key_required');
    const existing = this.records.get(actionId);
    if (existing) {
      existing.duplicateAttempts += 1;
      await existing.ready.promise;
      return existing.handle;
    }

    const event = deferred();
    const controller = typeof AbortController === 'function'
      ? new AbortController()
      : { signal: undefined, abort() {} };
    const record = {
      id: `browser-event-${++this.sequence}`, actionId, actionIdHash: hash(actionId), contract,
      state: 'arming', ready: deferred(), event, controller,
      armedAt: null, triggerStartedAt: null, triggerFinishedAt: null, completedAt: null,
      baseline: options.baseline || null, after: null,
      events: [], preTriggerEvents: [], duplicateAttempts: 0, duplicateTriggerAttempts: 0, duplicateEventCount: 0,
      adapterMeta: null, authoritative: false, cleanup: null, wait: null,
      eventFromTrigger: null, captureAfter: null, adoptActivePage: null,
      armError: null, waitObservation: null, triggerResult: null, triggerError: null,
      triggerPromise: null, outcomePromise: null, handle: null,
    };
    const handle = { broker: this, recordId: record.id, actionIdHash: record.actionIdHash };
    Object.defineProperty(handle, HANDLE_RECORD, { value: record });
    record.handle = Object.freeze(handle);
    this.records.set(actionId, record);

    const adapter = eventAdapter(this.adapters, contract.eventKind);
    const armFn = typeof adapter === 'function' ? adapter : adapter?.arm;
    if (typeof armFn !== 'function') {
      record.state = 'arm_failed';
      record.armError = 'qaai_event_adapter_unavailable';
      record.ready.resolve();
      return record.handle;
    }

    try {
      const captureBaseline = adapter?.captureBaseline || this.adapters.captureBaseline;
      if (!record.baseline && typeof captureBaseline === 'function') {
        record.baseline = await captureBaseline({ contract, signal: controller.signal });
      }
      const armed = await armFn({
        contract, baseline: record.baseline, signal: controller.signal,
        actionIdHash: record.actionIdHash,
        emit: (value) => this._pushEvent(record, value),
      });
      const meta = typeof armed === 'function' ? { cleanup: armed } : (armed || {});
      record.cleanup = typeof meta.cleanup === 'function' ? meta.cleanup : null;
      record.wait = typeof meta.wait === 'function' ? meta.wait : null;
      record.eventFromTrigger = typeof meta.eventFromTrigger === 'function' ? meta.eventFromTrigger : null;
      record.captureAfter = meta.captureAfter || adapter?.captureAfter || this.adapters.captureAfter || null;
      record.adoptActivePage = meta.adoptActivePage || adapter?.adoptActivePage || this.adapters.adoptActivePage || null;
      record.authoritative = meta.authoritative === true;
      record.adapterMeta = {
        source: clean(meta.source || adapter?.source || `${contract.eventKind}_adapter`, 160),
        authoritative: record.authoritative,
      };
      record.armedAt = this.now();
      record.state = 'armed';
    } catch (error) {
      record.state = 'arm_failed';
      record.armError = clean(error?.message || error || 'qaai_event_arm_failed', 700);
      this._cleanup(record);
    } finally {
      record.ready.resolve();
    }
    return record.handle;
  }

  async trigger(handle, triggerFn) {
    const record = this._record(handle);
    if (!record) throw new TypeError('unknown browser event broker handle');
    if (record.state === 'arm_failed') return { dispatched: false, reason: record.armError };
    if (record.triggerPromise) {
      record.duplicateTriggerAttempts += 1;
      return record.triggerPromise;
    }
    if (record.state !== 'armed') return { dispatched: false, reason: `qaai_event_trigger_invalid_state:${record.state}` };
    if (typeof triggerFn !== 'function') throw new TypeError('triggerFn is required');

    record.triggerPromise = (async () => {
      record.state = 'triggering';
      record.triggerStartedAt = this.now();
      try { record.triggerResult = await triggerFn(); }
      catch (error) { record.triggerError = error; }
      record.triggerFinishedAt = this.now();
      record.state = 'triggered';
      if (record.eventFromTrigger) {
        try {
          const derived = await record.eventFromTrigger({
            contract: record.contract, baseline: record.baseline,
            result: record.triggerResult, error: record.triggerError,
            signal: record.controller.signal,
          });
          for (const value of list(derived)) this._pushEvent(record, value, true);
        } catch (error) {
          record.waitObservation = { reason: 'qaai_trigger_event_derivation_failed', error: clean(error?.message || error, 700) };
        }
      }
      return { dispatched: true, ...triggerEvidence(record.triggerResult, record.triggerError) };
    })();
    return record.triggerPromise;
  }

  async settle(handle) {
    const record = this._record(handle);
    if (!record) throw new TypeError('unknown browser event broker handle');
    if (!record.outcomePromise) record.outcomePromise = this._settle(record);
    return record.outcomePromise;
  }

  async execute({ contract, actionId, idempotencyKey, trigger, baseline = null } = {}) {
    const built = contract?.schema === CONTRACT_SCHEMA ? contract : buildEventContract(contract || {});
    const handle = await this.arm(built, { actionId: actionId || idempotencyKey || built.idempotencyKey, baseline });
    if (handle.evidence) return handle.evidence;
    const record = this._record(handle);
    if (record.state !== 'arm_failed') await this.trigger(handle, trigger);
    return this.settle(handle);
  }

  dispose() {
    for (const record of this.records.values()) this._cleanup(record);
    this.records.clear();
  }

  _record(handle) {
    return handle?.broker === this ? handle[HANDLE_RECORD] || null : null;
  }

  _pushEvent(record, value, derived = false) {
    if (record.state === 'completed' || record.state === 'arm_failed') return false;
    const envelope = value && typeof value === 'object' ? value : { observed: value === true };
    if (record.triggerStartedAt == null && !derived) {
      record.preTriggerEvents.push(envelope);
      return false;
    }
    const observed = { ...envelope, observedAt: envelope.observedAt || this.now() };
    record.events.push(observed);
    if (record.events.length === 1) record.event.resolve(observed);
    else record.duplicateEventCount += 1;
    return true;
  }

  _failureHandle(contract, reason) {
    const evidence = {
      schema: EVIDENCE_SCHEMA, eventKind: contract.eventKind,
      status: 'inconclusive', matched: null, qaaiEvidenceError: true,
      failureType: reason, reason,
      trigger: { started: false, finished: false, threw: false, reportedError: false, error: null },
      retry: { safe: true, recommendation: 'retry_after_successful_rearm', reason: 'trigger_not_started' },
      journal: { status: 'not_attempted', persisted: false, ref: null },
      certification: { runtimeStatus: 'inconclusive', evidenceStatus: 'capture_failed', certifiable: false },
    };
    return Object.freeze({ broker: this, recordId: null, actionIdHash: null, evidence });
  }

  async _settle(record) {
    if (record.state === 'arm_failed') {
      return this._finalize(record, {
        status: 'inconclusive', matched: null, qaaiEvidenceError: true,
        failureType: record.armError === 'qaai_event_adapter_unavailable'
          ? record.armError : 'qaai_event_arm_failed',
        reason: record.armError || 'qaai_event_arm_failed',
      });
    }
    if (record.triggerStartedAt == null) {
      return this._finalize(record, {
        status: 'inconclusive', matched: null, qaaiEvidenceError: true,
        failureType: 'qaai_trigger_not_started', reason: 'qaai_trigger_not_started',
      });
    }

    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.setTimer(() => resolve({ source: 'timeout' }), record.contract.timeoutMs);
      timer?.unref?.();
    });
    const races = [record.event.promise.then((event) => ({ source: 'event', event })), timeout];
    if (record.wait) {
      races.push(Promise.resolve().then(() => record.wait({
        contract: record.contract, baseline: record.baseline,
        triggerResult: record.triggerResult, triggerError: record.triggerError,
        signal: record.controller.signal,
      })).then((value) => value == null ? new Promise(() => {}) : { source: 'wait', value })
        .catch((error) => ({ source: 'wait_error', error })));
    }
    const raced = await Promise.race(races);
    if (timer != null) this.clearTimer(timer);
    if (raced.source === 'wait' && raced.value) {
      if (raced.value.status && !raced.value.event && !raced.value.kind && !raced.value.eventKind) {
        record.waitObservation = raced.value;
      } else {
        for (const value of list(raced.value.event || raced.value)) this._pushEvent(record, value, true);
      }
    } else if (raced.source === 'wait_error') {
      record.waitObservation = { reason: 'qaai_event_wait_adapter_failed', error: clean(raced.error?.message || raced.error, 700) };
    }
    await Promise.resolve(); // collect synchronous sibling events before choosing

    if (!record.events.length) {
      const triggerError = !!record.triggerError || record.triggerResult?.isError === true || record.triggerResult?.ok === false;
      const landingOracle = record.triggerResult?.qaaiLandingOracleEvidence || null;
      const landingOracleCanConfirm = [EVENT_KINDS.NAVIGATION, EVENT_KINDS.PAGE_CHANGE].includes(record.contract.eventKind)
        && !triggerError
        && landingOracle?.matched === true;
      if (landingOracleCanConfirm) {
        return this._finalize(record, {
          status: 'confirmed',
          matched: true,
          qaaiEvidenceError: false,
          failureType: null,
          reason: landingOracle.reason || 'authored_landing_oracle_confirmed',
          typedEvidence: {
            checked: true,
            matched: true,
            reason: landingOracle.reason || 'authored_landing_oracle_confirmed',
            checks: [{
              channel: 'authored_landing_oracle',
              expected: true,
              actual: true,
              matched: true,
            }],
          },
          landingOracle,
        });
      }
      if (triggerError || record.waitObservation || !record.authoritative) {
        const reason = record.waitObservation?.reason || 'qaai_event_evidence_inconclusive';
        return this._finalize(record, {
          status: 'inconclusive', matched: null, qaaiEvidenceError: true,
          failureType: reason, reason,
        });
      }
      return this._finalize(record, {
        status: 'not_observed', matched: false, qaaiEvidenceError: false,
        failureType: 'expected_event_not_observed',
        reason: `${record.contract.eventKind}_not_observed_before_timeout`,
        typedEvidence: { checked: true, matched: false, reason: 'expected_event_not_observed', checks: [] },
      });
    }

    const evaluated = [];
    for (const event of record.events) {
      let after = event.after || null;
      if (record.captureAfter) {
        try {
          after = await record.captureAfter({
            contract: record.contract, event, baseline: record.baseline,
            signal: record.controller.signal,
          }) || after;
        } catch (error) {
          record.waitObservation = { reason: 'qaai_after_event_capture_failed', error: clean(error?.message || error, 700) };
        }
      }
      evaluated.push({ event, after, typed: verifyTypedEvent(record.contract, event, { baseline: record.baseline, after }) });
    }
    const matches = evaluated.filter((item) => item.typed.matched === true);
    if (matches.length > 1 && !record.contract.expected.allowMultiple) {
      return this._finalize(record, {
        status: 'inconclusive', matched: null, qaaiEvidenceError: true,
        failureType: 'qaai_multiple_event_candidates', reason: 'qaai_multiple_event_candidates',
        typedEvidence: { checked: true, matched: null, reason: 'multiple_matching_event_candidates', candidateCount: matches.length, checks: [] },
      });
    }
    const selected = matches[0] || evaluated.find((item) => item.typed.matched === false) || evaluated[0];
    record.after = selected.after;
    if (selected.typed.matched == null) {
      return this._finalize(record, {
        status: 'inconclusive', matched: null, qaaiEvidenceError: true,
        failureType: selected.typed.reason, reason: selected.typed.reason,
        typedEvidence: selected.typed, selectedEvent: selected.event,
      });
    }
    if (selected.typed.matched === false) {
      return this._finalize(record, {
        status: 'not_matched', matched: false, qaaiEvidenceError: false,
        failureType: 'expected_event_evidence_not_matched', reason: selected.typed.reason,
        typedEvidence: selected.typed, selectedEvent: selected.event,
      });
    }

    let adoption = null;
    if (record.contract.expected.adoptActivePage) {
      if (selected.event.adopted === true) {
        adoption = { adopted: true, source: 'event_adapter', pageId: selected.event.pageId, url: eventUrl(selected.event, selected.after) };
      } else if (typeof record.adoptActivePage === 'function') {
        try {
          adoption = await record.adoptActivePage({
            contract: record.contract, event: selected.event,
            baseline: record.baseline, signal: record.controller.signal,
          });
        } catch (error) {
          adoption = { adopted: false, error: clean(error?.message || error, 700) };
        }
      }
      if (adoption === true) adoption = { adopted: true };
      if (adoption?.adopted !== true) {
        return this._finalize(record, {
          status: 'inconclusive', matched: null, qaaiEvidenceError: true,
          failureType: 'qaai_active_page_adoption_unconfirmed', reason: 'qaai_active_page_adoption_unconfirmed',
          typedEvidence: selected.typed, selectedEvent: selected.event,
          activePageAdoption: adoption || { adopted: false, reason: 'adapter_not_configured' },
        });
      }
    }
    const triggerError = !!record.triggerError || record.triggerResult?.isError === true;
    return this._finalize(record, {
      status: 'confirmed', matched: true, qaaiEvidenceError: false, failureType: null,
      reason: triggerError ? `${record.contract.eventKind}_confirmed_after_trigger_error` : selected.typed.reason,
      typedEvidence: selected.typed, selectedEvent: selected.event,
      activePageAdoption: adoption,
    });
  }

  async _finalize(record, decision) {
    this._cleanup(record);
    record.state = 'completed';
    record.completedAt = this.now();
    const trigger = record.triggerStartedAt == null
      ? { started: false, finished: false, threw: false, reportedError: false, error: null }
      : triggerEvidence(record.triggerResult, record.triggerError);
    const retrySafe = !trigger.started;
    const beforeFp = fingerprintOf(record.baseline);
    const afterFp = fingerprintOf(record.after);
    const evidence = {
      schema: EVIDENCE_SCHEMA, contractSchema: CONTRACT_SCHEMA,
      eventKind: record.contract.eventKind,
      status: decision.status, matched: decision.matched,
      qaaiEvidenceError: decision.qaaiEvidenceError === true,
      failureType: decision.failureType || null, reason: decision.reason,
      actionIdHash: record.actionIdHash,
      timing: {
        armedAt: record.armedAt, triggerStartedAt: record.triggerStartedAt,
        triggerFinishedAt: record.triggerFinishedAt, completedAt: record.completedAt,
        timeoutMs: record.contract.timeoutMs,
      },
      arming: {
        armBeforeTrigger: record.armedAt != null && record.triggerStartedAt != null && record.armedAt <= record.triggerStartedAt,
        adapter: record.adapterMeta, preTriggerNoiseCount: record.preTriggerEvents.length,
      },
      trigger, expected: record.contract.expected,
      typedEvidence: decision.typedEvidence || null,
      selectedEvent: decision.selectedEvent ? sanitizeEvent(decision.selectedEvent, record.contract.eventKind) : null,
      observedEvents: record.events.map((event) => sanitizeEvent(event, record.contract.eventKind)),
      activePageAdoption: sanitizeAdoption(decision.activePageAdoption),
      pageEvidence: {
        before: compactFingerprint(beforeFp), after: compactFingerprint(afterFp),
        diff: beforeFp && afterFp ? pageFingerprint.diff(beforeFp, afterFp) : null,
      },
      idempotency: {
        duplicatePolicy: record.contract.duplicatePolicy,
        duplicateAttempts: record.duplicateAttempts,
        duplicateTriggerAttempts: record.duplicateTriggerAttempts,
        duplicateEvents: record.duplicateEventCount,
        duplicateTriggerPrevented: record.duplicateAttempts > 0 || record.duplicateTriggerAttempts > 0,
      },
      retry: {
        safe: retrySafe,
        recommendation: retrySafe ? 'retry_after_successful_rearm' : 'do_not_retrigger_automatically',
        reason: retrySafe ? 'trigger_not_started' : 'trigger_may_have_produced_a_side_effect',
      },
      journal: { status: 'not_configured', persisted: false, ref: null },
      certification: { runtimeStatus: decision.status, evidenceStatus: 'capture_pending', certifiable: false },
    };

    if (typeof this.adapters.recordEvidence === 'function') {
      evidence.journal = { status: 'attempted', persisted: false, ref: null };
      try {
        const result = await this.adapters.recordEvidence(evidence);
        const persisted = result === true || result?.persisted === true || result?.journaled === true;
        evidence.journal = {
          status: persisted ? 'persisted' : 'not_confirmed', persisted,
          ref: clean(result?.ref || result?.id, 300) || null,
        };
      } catch (error) {
        evidence.journal = { status: 'capture_failed', persisted: false, ref: null, error: clean(error?.message || error, 700) };
      }
    }
    evidence.certification = {
      runtimeStatus: decision.status,
      evidenceStatus: evidence.journal.persisted ? 'complete' : 'capture_failed',
      certifiable: decision.matched === true && evidence.journal.persisted === true,
    };
    return evidence;
  }

  _cleanup(record) {
    try { record.controller?.abort?.(); } catch (_) {}
    try { record.cleanup?.(); } catch (_) {}
    record.cleanup = null;
  }
}

function createBrowserEventBroker(options) {
  return new BrowserEventBroker(options);
}

module.exports = {
  CONTRACT_SCHEMA,
  EVIDENCE_SCHEMA,
  EVENT_KINDS,
  MAX_TIMEOUT_MS,
  BrowserEventBroker,
  buildEventContract,
  createBrowserEventBroker,
  normalizeEventKind,
  verifyTypedEvent,
};
