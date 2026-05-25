'use strict';

/**
 * Downloads watcher (Phase E10.5).
 *
 * @playwright/mcp writes browser-initiated downloads into the directory
 * passed via --output-dir. We poll that directory and translate every
 * new file we see into a Download row, linked to the active run-result
 * when known.
 *
 * Why a poller and not fs.watch? On Windows fs.watch fires on rename/
 * change events that don't always correlate with "file fully written",
 * and we'd need debouncing anyway. A 1.5s readdir poll is simpler,
 * survives Chromium write-rename patterns cleanly, and is cheap (the
 * dir contains at most a few files per session).
 *
 * Lifecycle:
 *   startWatcher(session, projectId)  — begins polling
 *   setRunResult(session, runResultId) — Conductor calls this when it
 *                                        enters a new case so downloads
 *                                        attach to the right RunResult
 *   stopWatcher(session)              — stops polling (call at session close)
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../prisma');

const POLL_MS = 1500;
// Files smaller than this are usually still being written. Skip recording
// until they stabilise across two polls.
const MIN_STABLE_SIZE = 16;

function startWatcher(session, projectId) {
  if (!session?.downloadsDir) return; // mcpContextConfig always sets this; defensive.
  if (session._dlWatcher) return;     // already running

  const state = {
    projectId,
    activeRunResultId: null,
    knownFiles: new Map(), // filename -> { size, mtimeMs, recorded }
    timer: null,
  };

  const tick = async () => {
    if (session.closed) return;
    let entries = [];
    try { entries = fs.readdirSync(session.downloadsDir); } catch (_) { return; }

    for (const name of entries) {
      const full = path.join(session.downloadsDir, name);
      let stat = null;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (!stat || !stat.isFile()) continue;

      const prev = state.knownFiles.get(name);
      const current = { size: stat.size, mtimeMs: stat.mtimeMs };

      if (!prev) {
        state.knownFiles.set(name, { ...current, recorded: false });
        continue;
      }

      // Wait for file to stabilise — same size + mtime across two polls
      // AND size above the no-op threshold — before recording. Avoids
      // capturing a half-written download.
      const stable = prev.size === current.size
        && prev.mtimeMs === current.mtimeMs
        && current.size >= MIN_STABLE_SIZE;

      if (stable && !prev.recorded) {
        try {
          await recordDownload(session, state, name, full, stat);
          state.knownFiles.set(name, { ...current, recorded: true });
          try {
            session.broadcast?.({
              type: 'agent.phase.log', phase: 'conductor', level: 'info',
              message: `📥 Download captured: ${name} (${formatBytes(stat.size)})`,
            });
          } catch (_) {}
        } catch (err) {
          // Don't loop on the same file. Mark recorded so we move on.
          state.knownFiles.set(name, { ...current, recorded: true });
          console.warn('[downloadWatcher] record failed for', name, err.message);
        }
      } else {
        state.knownFiles.set(name, { ...current, recorded: prev.recorded });
      }
    }
  };

  state.timer = setInterval(tick, POLL_MS);
  state.timer.unref?.();
  session._dlWatcher = state;
}

function setRunResult(session, runResultId) {
  if (session?._dlWatcher) {
    session._dlWatcher.activeRunResultId = runResultId || null;
  }
}

/**
 * Capture the "case started" timestamp so attributeRecentDownloads has
 * a tight time window. Called by the Conductor at the top of each case.
 */
function setCaseStart(session) {
  if (session?._dlWatcher) {
    session._dlWatcher.caseStartTs = new Date();
    session._dlWatcher.activeRunResultId = null;
  }
}

/**
 * After the Conductor creates the RunResult row for a finished case,
 * back-fill the runResultId on any Download rows captured during this
 * case window (caseStartTs → now) that have no runResultId yet. Also
 * updates the watcher's activeRunResultId so any further assertion_check
 * with expectedDownload (rare — usually the agent is done by now) still
 * works.
 *
 * Returns the number of rows attributed (useful for logging / smoke).
 */
async function attributeRecentDownloads(session, runResultId, projectId) {
  if (!runResultId || !projectId) return 0;
  const state = session?._dlWatcher;
  const since = state?.caseStartTs || new Date(Date.now() - 5 * 60_000); // 5-min fallback
  const result = await prisma.download.updateMany({
    where: {
      projectId,
      runResultId: null,
      capturedAt: { gte: since },
    },
    data: { runResultId },
  });
  if (state) state.activeRunResultId = runResultId;
  return result.count;
}

function stopWatcher(session) {
  const state = session?._dlWatcher;
  if (!state) return;
  if (state.timer) clearInterval(state.timer);
  session._dlWatcher = null;
}

async function recordDownload(session, state, suggestedFilename, fullPath, stat) {
  const mime = guessMime(suggestedFilename);
  await prisma.download.create({
    data: {
      projectId: state.projectId,
      runResultId: state.activeRunResultId || null,
      suggestedFilename,
      storedFilename: suggestedFilename, // MCP writes with the suggested name; we don't rename
      path: fullPath,
      sizeBytes: stat.size,
      mimeType: mime,
    },
  });
}

function guessMime(name) {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.pdf':  return 'application/pdf';
    case '.csv':  return 'text/csv';
    case '.json': return 'application/json';
    case '.txt':  return 'text/plain';
    case '.zip':  return 'application/zip';
    case '.png':  return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.xml':  return 'application/xml';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:      return null;
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Read the captured downloads for a RunResult. Used by assertion_check
 * when the Conductor wants to verify "a file matching X was downloaded".
 */
async function listForRunResult(runResultId) {
  return await prisma.download.findMany({
    where: { runResultId },
    orderBy: { capturedAt: 'asc' },
    select: { id: true, suggestedFilename: true, sizeBytes: true, mimeType: true, capturedAt: true },
  });
}

/**
 * Predicate: does this run-result have a download matching the spec?
 *   spec = { filenamePattern?: string, minSize?: number, mimeType?: string }
 * Returns { matched, evidence } in the same shape assertion_check uses.
 */
async function checkDownloadExpectation(runResultId, spec) {
  const dls = await listForRunResult(runResultId);
  if (!dls.length) {
    return { matched: false, evidence: 'no downloads captured during this case' };
  }
  const re = spec?.filenamePattern ? safeRegex(spec.filenamePattern) : null;
  for (const d of dls) {
    if (re && !re.test(d.suggestedFilename)) continue;
    if (typeof spec?.minSize === 'number' && d.sizeBytes < spec.minSize) continue;
    if (spec?.mimeType && d.mimeType && d.mimeType !== spec.mimeType) continue;
    return {
      matched: true,
      evidence: `download "${d.suggestedFilename}" (${formatBytes(d.sizeBytes)}, ${d.mimeType || 'unknown mime'}) captured at ${d.capturedAt.toISOString()}`,
    };
  }
  return {
    matched: false,
    evidence: `${dls.length} download(s) captured but none matched the spec (${dls.map((d) => d.suggestedFilename).join(', ')})`,
  };
}

function safeRegex(pattern) {
  try { return new RegExp(pattern, 'i'); } catch (_) { return null; }
}

module.exports = {
  startWatcher,
  setRunResult,
  setCaseStart,
  attributeRecentDownloads,
  stopWatcher,
  listForRunResult,
  checkDownloadExpectation,
};
