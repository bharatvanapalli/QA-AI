import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const pageFingerprint = require('../../server/services/pageFingerprint');
const {
  CONTRACT_SCHEMA,
  EVENT_KINDS,
  MAX_TIMEOUT_MS,
  buildEventContract,
  createBrowserEventBroker,
  verifyTypedEvent,
} = require('../../server/services/browserEventBroker');

function monotonicClock() {
  let value = 0;
  return () => ++value;
}

function immediateTimer() {
  return {
    setTimer(fn) {
      const token = { cancelled: false, unref() {} };
      queueMicrotask(() => { if (!token.cancelled) fn(); });
      return token;
    },
    clearTimer(token) { token.cancelled = true; },
  };
}

function journalAdapter(rows = []) {
  return async (evidence) => {
    rows.push(JSON.parse(JSON.stringify(evidence)));
    return { persisted: true, ref: `journal-${rows.length}` };
  };
}

describe('website-neutral browser event broker', () => {
  it.each([
    [{ action: 'Popup' }, EVENT_KINDS.POPUP],
    [{ action: 'Open new page' }, EVENT_KINDS.POPUP],
    [{ action: 'Download' }, EVENT_KINDS.DOWNLOAD],
    [{ eventKind: 'file chooser' }, EVENT_KINDS.FILE_CHOOSER],
    [{ action: 'Upload' }, EVENT_KINDS.UPLOAD],
    [{ eventKind: 'dialog' }, EVENT_KINDS.DIALOG],
    [{ action: 'Navigate', value: 'https://destination.example/home' }, EVENT_KINDS.NAVIGATION],
    [{ eventKind: 'page change' }, EVENT_KINDS.PAGE_CHANGE],
  ])('builds a bounded arm-before-trigger contract for %#', (input, eventKind) => {
    const contract = buildEventContract({ ...input, timeoutMs: MAX_TIMEOUT_MS + 50_000 });
    expect(contract).toMatchObject({
      schema: CONTRACT_SCHEMA,
      eventKind,
      armBeforeTrigger: true,
      timeoutMs: MAX_TIMEOUT_MS,
      duplicatePolicy: 'reuse_result_never_retrigger_automatically',
    });
  });

  it('arms a popup listener before dispatch, adopts the page, and journals typed evidence', async () => {
    const order = [];
    const journal = [];
    let emitPopup;
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      adapters: {
        events: {
          popup: {
            arm({ emit }) {
              order.push('arm');
              emitPopup = emit;
              return {
                authoritative: true,
                source: 'fake_context_page_event',
                cleanup: () => order.push('cleanup'),
              };
            },
            adoptActivePage({ event }) {
              order.push('adopt');
              return { adopted: true, pageId: event.pageId, url: event.url, page: { mustNotPersist: true } };
            },
          },
        },
        recordEvidence: journalAdapter(journal),
      },
    });

    const evidence = await broker.execute({
      actionId: 'case-1:step-2:attempt-1',
      contract: buildEventContract({ eventKind: 'popup', expected: { urlPattern: '/workspace' } }),
      trigger: async () => {
        order.push('trigger');
        emitPopup({ kind: 'new_page', pageId: 'page-2', url: 'https://destination.example/workspace' });
        return { isError: false };
      },
    });

    expect(order).toEqual(['arm', 'trigger', 'adopt', 'cleanup']);
    expect(evidence).toMatchObject({
      eventKind: 'popup',
      status: 'confirmed',
      matched: true,
      qaaiEvidenceError: false,
      arming: { armBeforeTrigger: true, adapter: { authoritative: true } },
      activePageAdoption: { adopted: true, pageId: 'page-2' },
      journal: { status: 'persisted', persisted: true, ref: 'journal-1' },
      certification: { runtimeStatus: 'confirmed', evidenceStatus: 'complete', certifiable: true },
    });
    expect(evidence.activePageAdoption).not.toHaveProperty('page');
    expect(journal).toHaveLength(1);
  });

  it('ignores pre-trigger event noise and accepts only an event inside the trigger window', async () => {
    let emitDialog;
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      adapters: {
        events: {
          dialog: {
            arm({ emit }) {
              emitDialog = emit;
              emit({ kind: 'dialog', dialogType: 'alert', message: 'stale dialog' });
              return { authoritative: true };
            },
          },
        },
        recordEvidence: journalAdapter(),
      },
    });

    const evidence = await broker.execute({
      actionId: 'dialog-attempt-1',
      contract: buildEventContract({ eventKind: 'dialog', expected: { dialogType: 'confirm', messagePattern: 'continue' } }),
      trigger: async () => {
        emitDialog({ kind: 'dialog', dialogType: 'confirm', message: 'Continue with this operation?' });
        return { ok: true };
      },
    });

    expect(evidence.status).toBe('confirmed');
    expect(evidence.arming.preTriggerNoiseCount).toBe(1);
    expect(evidence.observedEvents).toHaveLength(1);
    expect(evidence.selectedEvent.message).toContain('Continue');
  });

  it('deduplicates concurrent callers and never dispatches the same action twice', async () => {
    let releaseArm;
    const armGate = new Promise((resolve) => { releaseArm = resolve; });
    let emitDownload;
    let triggers = 0;
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      adapters: {
        events: {
          download: {
            async arm({ emit }) {
              emitDownload = emit;
              await armGate;
              return { authoritative: true };
            },
          },
        },
        recordEvidence: journalAdapter(),
      },
    });
    const contract = buildEventContract({ eventKind: 'download', expected: { filenamePattern: '\\.csv$', minSize: 10 } });
    const invoke = () => broker.execute({
      actionId: 'case-2:download:attempt-1',
      contract,
      trigger: async () => {
        triggers += 1;
        emitDownload({ kind: 'download', suggestedFilename: 'report.csv', sizeBytes: 42, complete: true });
        return { ok: true };
      },
    });

    const first = invoke();
    const second = invoke();
    releaseArm();
    const [left, right] = await Promise.all([first, second]);

    expect(triggers).toBe(1);
    expect(left).toBe(right);
    expect(left.idempotency).toMatchObject({ duplicateAttempts: 1, duplicateTriggerPrevented: true });
  });

  it('confirms a download even when dispatch reports an error, without recommending a retry', async () => {
    let emitDownload;
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      adapters: {
        events: {
          download: {
            arm({ emit }) { emitDownload = emit; return { authoritative: true }; },
          },
        },
        recordEvidence: journalAdapter(),
      },
    });

    const evidence = await broker.execute({
      actionId: 'case-3:download:attempt-1',
      contract: buildEventContract({
        eventKind: 'download',
        expected: { filenamePattern: '^ledger\\.csv$', minSize: 16, mimeType: 'text/csv' },
      }),
      trigger: async () => {
        emitDownload({
          kind: 'download', suggestedFilename: 'ledger.csv', sizeBytes: 120,
          mimeType: 'text/csv', complete: true,
        });
        return { isError: true, message: 'browser call timed out after the file was saved' };
      },
    });

    expect(evidence).toMatchObject({
      status: 'confirmed',
      matched: true,
      reason: 'download_confirmed_after_trigger_error',
      trigger: { reportedError: true },
      retry: { safe: false, recommendation: 'do_not_retrigger_automatically' },
    });
  });

  it('derives typed upload evidence from the trigger result and strips local paths', async () => {
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      adapters: {
        events: {
          upload: {
            arm() {
              return {
                authoritative: true,
                eventFromTrigger: ({ result }) => ({
                  kind: 'upload', accepted: result.ok, files: result.files,
                }),
              };
            },
          },
        },
        recordEvidence: journalAdapter(),
      },
    });

    const evidence = await broker.execute({
      actionId: 'case-4:upload:attempt-1',
      contract: buildEventContract({
        eventKind: 'upload',
        expected: { fileCount: 1, fileNames: 'invoice.csv' },
      }),
      trigger: async () => ({ ok: true, files: ['C:\\private\\fixtures\\invoice.csv'] }),
    });

    expect(evidence).toMatchObject({ status: 'confirmed', matched: true });
    expect(evidence.selectedEvent.files).toEqual(['invoice.csv']);
    expect(JSON.stringify(evidence)).not.toContain('private');
  });

  it('uses page fingerprints for a typed page-change outcome', async () => {
    const before = pageFingerprint.buildPageFingerprint({
      url: 'https://app.example/start', title: 'Start', primaryHeading: 'Start',
      controls: [{ role: 'button', name: 'Continue' }],
    });
    const after = pageFingerprint.buildPageFingerprint({
      url: 'https://app.example/workspace', title: 'Workspace', primaryHeading: 'Workspace',
      controls: [{ role: 'button', name: 'Create' }],
    });
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      adapters: {
        events: {
          pageChange: {
            arm() {
              return {
                authoritative: true,
                eventFromTrigger: () => ({ kind: 'page_change' }),
                captureAfter: () => ({ fingerprint: after }),
              };
            },
          },
        },
        recordEvidence: journalAdapter(),
      },
    });

    const evidence = await broker.execute({
      actionId: 'case-5:page-change:attempt-1',
      baseline: { fingerprint: before },
      contract: buildEventContract({ eventKind: 'page change' }),
      trigger: async () => ({ ok: true }),
    });

    expect(evidence).toMatchObject({
      status: 'confirmed',
      matched: true,
      pageEvidence: { diff: { changed: true } },
    });
    expect(evidence.pageEvidence.diff.channels).toContain('url');
  });

  it('fails closed when a popup is observed but active-page adoption is unconfirmed', async () => {
    let emitPopup;
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      adapters: {
        events: {
          popup: { arm({ emit }) { emitPopup = emit; return { authoritative: true }; } },
        },
        recordEvidence: journalAdapter(),
      },
    });
    const evidence = await broker.execute({
      actionId: 'case-6:popup:attempt-1',
      contract: buildEventContract({ eventKind: 'popup' }),
      trigger: async () => {
        emitPopup({ kind: 'popup', pageId: 'unadopted-page', url: 'https://destination.example/' });
        return { ok: true };
      },
    });

    expect(evidence).toMatchObject({
      status: 'inconclusive', matched: null, qaaiEvidenceError: true,
      failureType: 'qaai_active_page_adoption_unconfirmed',
      activePageAdoption: { adopted: false },
      retry: { recommendation: 'do_not_retrigger_automatically' },
    });
  });

  it('does not guess when one trigger opens multiple matching pages', async () => {
    let emitPopup;
    let adoptions = 0;
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      adapters: {
        events: {
          popup: {
            arm({ emit }) { emitPopup = emit; return { authoritative: true }; },
            adoptActivePage() { adoptions += 1; return { adopted: true }; },
          },
        },
        recordEvidence: journalAdapter(),
      },
    });
    const evidence = await broker.execute({
      actionId: 'case-7:popup:attempt-1',
      contract: buildEventContract({ eventKind: 'popup' }),
      trigger: async () => {
        emitPopup({ kind: 'popup', pageId: 'page-a', url: 'https://one.example/' });
        emitPopup({ kind: 'popup', pageId: 'page-b', url: 'https://two.example/' });
        return { ok: true };
      },
    });

    expect(evidence).toMatchObject({
      status: 'inconclusive', matched: null,
      failureType: 'qaai_multiple_event_candidates',
    });
    expect(adoptions).toBe(0);
  });

  it.each([
    [true, 'not_observed', false, false],
    [false, 'inconclusive', null, true],
  ])('reports timeout truthfully when adapter authoritative=%s', async (authoritative, status, matched, qaaiEvidenceError) => {
    const timer = immediateTimer();
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      ...timer,
      adapters: {
        events: {
          download: { arm() { return { authoritative }; } },
        },
        recordEvidence: journalAdapter(),
      },
    });
    const evidence = await broker.execute({
      actionId: `timeout-${authoritative}`,
      contract: buildEventContract({ eventKind: 'download', timeoutMs: 5 }),
      trigger: async () => ({ ok: true }),
    });

    expect(evidence).toMatchObject({
      status, matched, qaaiEvidenceError,
      retry: { safe: false, recommendation: 'do_not_retrigger_automatically' },
    });
  });

  it('accepts an authoritative authored landing oracle when an SPA emits no navigation event', async () => {
    const timer = immediateTimer();
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      ...timer,
      adapters: {
        events: {
          navigation: { arm() { return { authoritative: true }; } },
        },
        recordEvidence: journalAdapter(),
      },
    });

    const evidence = await broker.execute({
      actionId: 'spa-navigation-with-landing-oracle',
      contract: buildEventContract({ eventKind: 'navigation', timeoutMs: 5 }),
      trigger: async () => ({
        ok: true,
        qaaiLandingOracleEvidence: {
          schema: 'qaai-authored-landing-oracle-v1',
          matched: true,
          kind: 'control_actionable',
          reason: 'authored_next_control_actionable',
        },
      }),
    });

    expect(evidence).toMatchObject({
      status: 'confirmed',
      matched: true,
      reason: 'authored_next_control_actionable',
      typedEvidence: {
        matched: true,
        checks: [{ channel: 'authored_landing_oracle', matched: true }],
      },
    });
    expect(evidence.observedEvents).toEqual([]);
  });

  it('returns QAAI uncertainty when expected download evidence is incomplete', async () => {
    let emitDownload;
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      adapters: {
        events: {
          download: { arm({ emit }) { emitDownload = emit; return { authoritative: true }; } },
        },
        recordEvidence: journalAdapter(),
      },
    });
    const evidence = await broker.execute({
      actionId: 'case-8:download:attempt-1',
      contract: buildEventContract({ eventKind: 'download', expected: { minSize: 100 } }),
      trigger: async () => {
        emitDownload({ kind: 'download', suggestedFilename: 'unknown.bin', complete: true });
        return { ok: true };
      },
    });

    expect(evidence).toMatchObject({
      status: 'inconclusive', matched: null, qaaiEvidenceError: true,
      failureType: 'qaai_typed_event_evidence_incomplete',
      typedEvidence: { missingEvidence: ['minimum_size'] },
    });
  });

  it('blocks dispatch when no stable idempotency key is supplied', async () => {
    let triggers = 0;
    const broker = createBrowserEventBroker({
      adapters: {
        events: { dialog: { arm() { return { authoritative: true }; } } },
      },
    });
    const evidence = await broker.execute({
      contract: buildEventContract({ eventKind: 'dialog' }),
      trigger: async () => { triggers += 1; return { ok: true }; },
    });

    expect(triggers).toBe(0);
    expect(evidence).toMatchObject({
      status: 'inconclusive', matched: null,
      failureType: 'qaai_idempotency_key_required',
      trigger: { started: false },
      retry: { safe: true, recommendation: 'retry_after_successful_rearm' },
    });
  });

  it('does not dispatch when the required event adapter cannot be armed', async () => {
    let triggers = 0;
    const broker = createBrowserEventBroker();
    const evidence = await broker.execute({
      actionId: 'case-9:file-chooser:attempt-1',
      contract: buildEventContract({ eventKind: 'file chooser' }),
      trigger: async () => { triggers += 1; return { ok: true }; },
    });

    expect(triggers).toBe(0);
    expect(evidence).toMatchObject({
      status: 'inconclusive', matched: null, qaaiEvidenceError: true,
      failureType: 'qaai_event_adapter_unavailable',
      trigger: { started: false },
      retry: { safe: true, recommendation: 'retry_after_successful_rearm' },
    });
  });

  it('keeps typed dialog, file-chooser, and navigation checks website-neutral', () => {
    expect(verifyTypedEvent(
      buildEventContract({ eventKind: 'dialog', expected: { dialogType: 'prompt', messagePattern: 'reference' } }),
      { kind: 'dialog', dialogType: 'prompt', message: 'Enter a reference number' },
    )).toMatchObject({ matched: true, qaaiEvidenceError: false });

    expect(verifyTypedEvent(
      buildEventContract({ eventKind: 'file chooser', expected: { multiple: false } }),
      { kind: 'file_chooser', multiple: true },
    )).toMatchObject({ matched: false, reason: 'file_chooser_expected_evidence_not_matched' });

    expect(verifyTypedEvent(
      buildEventContract({ eventKind: 'navigation', expected: { urlPattern: '/orders/*' } }),
      { kind: 'navigation', url: 'https://app.example/orders/42', readiness: 'domcontentloaded' },
    )).toMatchObject({ matched: true });
  });

  it('keeps runtime confirmation separate from missing durable journal proof', async () => {
    let emitDialog;
    const broker = createBrowserEventBroker({
      now: monotonicClock(),
      adapters: {
        events: {
          dialog: { arm({ emit }) { emitDialog = emit; return { authoritative: true }; } },
        },
      },
    });
    const evidence = await broker.execute({
      actionId: 'case-9:dialog:attempt-1',
      contract: buildEventContract({ eventKind: 'dialog' }),
      trigger: async () => { emitDialog({ kind: 'dialog' }); return { ok: true }; },
    });

    expect(evidence).toMatchObject({
      status: 'confirmed', matched: true,
      journal: { status: 'not_configured', persisted: false },
      certification: { runtimeStatus: 'confirmed', evidenceStatus: 'capture_failed', certifiable: false },
    });
  });
});
