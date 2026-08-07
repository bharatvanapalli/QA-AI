'use strict';

const waitContract = require('./waitContract');
const downloadWatcherDefault = require('./downloadWatcher');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function transitionEvent(eventKind, evidence) {
  if (!evidence || evidence.status !== 'confirmed' || evidence.matched !== true) {
    return {
      status: 'inconclusive',
      reason: evidence?.reason || 'qaai_transition_evidence_inconclusive',
      qaaiEvidenceError: true,
    };
  }
  const signals = Array.isArray(evidence.signals) ? evidence.signals : [];
  const activePageChanged = signals.includes('active_page_changed');
  const newPage = signals.includes('new_page');
  if (eventKind === 'popup' && !newPage && !activePageChanged) {
    return { status: 'inconclusive', reason: 'qaai_popup_event_not_observed', qaaiEvidenceError: true };
  }
  return {
    eventKind,
    kind: eventKind,
    pageId: evidence.transitionId || null,
    url: evidence.currentUrl || null,
    changed: signals.length > 0,
    navigated: eventKind === 'navigation',
    adopted: eventKind === 'popup' ? activePageChanged : undefined,
    readiness: evidence.readiness || null,
    signals,
    observedAt: Date.now(),
  };
}

function transitionAdapter({ eventKind, mcp, session }) {
  return {
    async arm({ contract }) {
      if (!mcp || typeof mcp.armPageTransitionObservation !== 'function'
        || typeof mcp.awaitPageTransitionObservation !== 'function' || !session) {
        return { authoritative: false, source: 'transition_observer_unavailable' };
      }
      await mcp.armPageTransitionObservation(session, {
        toolName: `event_broker_${eventKind}`,
        waitContract: contract.sourceWaitContract || null,
      });
      return {
        authoritative: true,
        source: 'mcp_page_transition_observer',
        wait: async () => transitionEvent(eventKind, await mcp.awaitPageTransitionObservation(session, {
          waitContract: contract.sourceWaitContract || null,
          timeoutMs: contract.timeoutMs,
          pollIntervalMs: contract.pollIntervalMs,
          stableObservations: contract.stableObservations,
        })),
        adoptActivePage: ({ event }) => event?.adopted === true
          ? { adopted: true, source: 'mcp_transition_target_selection', pageId: event.pageId, url: event.url }
          : { adopted: false, source: 'mcp_transition_target_selection', reason: 'active_page_change_not_confirmed' },
      };
    },
  };
}

function downloadAdapter({ downloadWatcher, runResultId, session, now = Date.now, qaaiSleep = sleep }) {
  return {
    async arm({ contract }) {
      const listDownloads = runResultId && typeof downloadWatcher?.listForRunResult === 'function'
        ? () => downloadWatcher.listForRunResult(runResultId)
        : session && typeof downloadWatcher?.listLiveForSession === 'function'
          ? () => downloadWatcher.listLiveForSession(session)
          : null;
      if (!listDownloads) {
        return { authoritative: false, source: 'download_watcher_unavailable' };
      }
      const before = await listDownloads();
      const known = new Set((before || []).map((row) => row.id));
      return {
        authoritative: true,
        source: 'download_watcher',
        wait: async () => {
          const deadline = now() + contract.timeoutMs;
          do {
            const rows = await listDownloads();
            const added = (rows || []).filter((row) => !known.has(row.id));
            if (added.length) {
              return added.map((row) => ({
                eventKind: 'download', kind: 'download', suggestedFilename: row.suggestedFilename,
                sizeBytes: row.sizeBytes, mimeType: row.mimeType, complete: true,
                observedAt: row.capturedAt || now(),
              }));
            }
            if (now() >= deadline) break;
            await qaaiSleep(Math.min(contract.pollIntervalMs || waitContract.POLL_INTERVAL_MS, Math.max(1, deadline - now())));
          } while (now() <= deadline);
          return null;
        },
      };
    },
  };
}

function uploadAdapter() {
  return {
    arm() {
      return {
        authoritative: true,
        source: 'typed_upload_dispatch',
        eventFromTrigger: ({ result }) => ({
          eventKind: 'upload', kind: 'upload',
          accepted: result?.ok === true || (result?.isError !== true && Array.isArray(result?.files)),
          files: result?.files || result?.fileNames || [],
        }),
      };
    },
  };
}

function unavailableNativeAdapter(source) {
  return { arm() { return { authoritative: false, source }; } };
}

function createMcpBrowserEventAdapters({
  mcp,
  session,
  downloadWatcher = downloadWatcherDefault,
  runResultId = null,
  recordEvidence = null,
  nativeEvents = {},
  now = Date.now,
  qaaiSleep = sleep,
} = {}) {
  return {
    events: {
      popup: nativeEvents.popup || transitionAdapter({ eventKind: 'popup', mcp, session }),
      navigation: transitionAdapter({ eventKind: 'navigation', mcp, session }),
      page_change: transitionAdapter({ eventKind: 'page_change', mcp, session }),
      download: nativeEvents.download || downloadAdapter({ downloadWatcher, runResultId, session, now, qaaiSleep }),
      upload: nativeEvents.upload || uploadAdapter(),
      file_chooser: nativeEvents.file_chooser || nativeEvents.fileChooser || unavailableNativeAdapter('native_file_chooser_listener_unavailable'),
      dialog: nativeEvents.dialog || unavailableNativeAdapter('native_dialog_listener_unavailable'),
    },
    ...(typeof recordEvidence === 'function' ? { recordEvidence } : {}),
  };
}

module.exports = {
  transitionEvent,
  createMcpBrowserEventAdapters,
};
