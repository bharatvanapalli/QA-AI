'use strict';

/**
 * Shared on-disk cleanup for a project's generated test artifacts.
 *
 * Two call sites use this:
 *   1. DELETE /api/projects/:id/output-files (Phase 6: explicit user action)
 *   2. POST /scenarios (regenerate with replace:true — auto-clear so disk
 *      doesn't drift out of sync with the wiped DB)
 *
 * Collects paths from GovernancePR.filename and RunResult.screenshots/video/
 * trace BEFORE you wipe those rows, unlinks them after, then reaps empty
 * subdirectories. Best-effort: missing files are ignored.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../prisma');

const PLAYWRIGHT_DIR = path.join(__dirname, '..', '..', 'playwright');

function safeUnlink(absPath) {
  try { fs.unlinkSync(absPath); return true; }
  catch (err) { if (err.code !== 'ENOENT') console.warn(`[output-files] unlink failed: ${absPath} — ${err.message}`); return false; }
}

function removeEmptyChildDirs(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(rootDir, entry.name);
    removeEmptyChildDirs(full);
    try {
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    } catch (_) {}
  }
}

/**
 * Returns the set of absolute paths owned by `projectId` (PR specs +
 * RunResult artifacts). Call this BEFORE deleting the source rows.
 */
async function collectProjectFiles(projectId) {
  const [prs, results] = await Promise.all([
    prisma.governancePR.findMany({
      where: { projectId },
      select: { filename: true },
    }),
    prisma.runResult.findMany({
      where: { run: { projectId } },
      select: { screenshots: true, video: true, trace: true },
    }),
  ]);
  const files = new Set();
  for (const pr of prs) {
    if (pr.filename) files.add(path.join(PLAYWRIGHT_DIR, pr.filename));
  }
  for (const r of results) {
    if (r.video) files.add(path.join(PLAYWRIGHT_DIR, r.video));
    if (r.trace) files.add(path.join(PLAYWRIGHT_DIR, r.trace));
    try {
      const shots = JSON.parse(r.screenshots || '[]');
      if (Array.isArray(shots)) {
        for (const url of shots) {
          if (typeof url === 'string' && url.startsWith('/artifacts/')) {
            files.add(path.join(PLAYWRIGHT_DIR, 'test-results', url.slice('/artifacts/'.length)));
          }
        }
      }
    } catch (_) {}
  }
  return files;
}

/**
 * Unlink every path in `files`, then reap empty subdirs under tests/ pages/
 * test-results/. Returns counts so callers can audit-log them.
 */
function unlinkAndReap(files) {
  let unlinked = 0;
  for (const abs of files) {
    if (safeUnlink(abs)) unlinked++;
  }
  removeEmptyChildDirs(path.join(PLAYWRIGHT_DIR, 'tests'));
  removeEmptyChildDirs(path.join(PLAYWRIGHT_DIR, 'pages'));
  removeEmptyChildDirs(path.join(PLAYWRIGHT_DIR, 'test-results'));
  return { unlinked, attempted: files.size };
}

/**
 * One-call helper that does "collect → unlink → reap" for a project.
 * Useful when you want to clear disk WITHOUT wiping DB rows (e.g. the
 * DELETE /output-files endpoint).
 */
async function clearProjectFiles(projectId) {
  const files = await collectProjectFiles(projectId);
  return unlinkAndReap(files);
}

module.exports = { collectProjectFiles, unlinkAndReap, clearProjectFiles, PLAYWRIGHT_DIR };
