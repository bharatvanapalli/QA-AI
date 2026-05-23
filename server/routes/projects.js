'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/projects ─────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const projects = await prisma.project.findMany({
      where: { userId: req.user.id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        environment: true,
        framework: true,
        targetUrl: true,
        aiProvider: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            requirements: true,
            testCases: true,
            runs: true,
            documents: true,
          },
        },
      },
    });
    res.json({ success: true, projects });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects ────────────────────────────────────
router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const { name, environment, framework, targetUrl } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res
        .status(400)
        .json({ success: false, code: 'INVALID_NAME', message: 'Name must be at least 2 chars' });
    }
    if (targetUrl && !/^https?:\/\/.+/.test(targetUrl)) {
      return res
        .status(400)
        .json({ success: false, code: 'INVALID_URL', message: 'targetUrl must be http(s)' });
    }
    const project = await prisma.project.create({
      data: {
        userId: req.user.id,
        name: name.trim(),
        environment: environment || 'staging',
        framework: framework || 'playwright-pom',
        targetUrl: targetUrl || null,
      },
    });
    await audit.log({
      userId: req.user.id,
      action: 'project.create',
      target: project.id,
      metadata: { name },
      req,
    });
    res.status(201).json({ success: true, project });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:id ─────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        _count: {
          select: {
            requirements: true,
            testCases: true,
            runs: true,
            documents: true,
            locators: true,
          },
        },
      },
    });
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    res.json({ success: true, project });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/projects/:id ─────────────────────────────────
router.put('/:id', requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { name, environment, framework, targetUrl } = req.body || {};
    if (targetUrl !== undefined && targetUrl !== null && targetUrl !== '' && !/^https?:\/\/.+/.test(targetUrl)) {
      return res
        .status(400)
        .json({ success: false, code: 'INVALID_URL', message: 'targetUrl must be http(s)' });
    }

    const project = await prisma.project.update({
      where: { id: existing.id },
      data: {
        name: typeof name === 'string' && name.trim() ? name.trim() : existing.name,
        environment: environment || existing.environment,
        framework: framework || existing.framework,
        targetUrl: targetUrl === '' ? null : targetUrl ?? existing.targetUrl,
      },
    });
    await audit.log({
      userId: req.user.id,
      action: 'project.update',
      target: project.id,
      req,
    });
    res.json({ success: true, project });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/projects/:id/guidance ────────────────────────
// Project-wide AI guidance: free-form text prepended to every agent's
// system prompt for this project. Stored on Project.aiGuidance. POSTing
// an empty string clears the guidance.
router.put('/:id/guidance', requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { aiGuidance } = req.body || {};
    if (typeof aiGuidance !== 'string') {
      return res.status(400).json({ success: false, code: 'INVALID_BODY', message: 'aiGuidance must be a string.' });
    }
    if (aiGuidance.length > 8000) {
      return res.status(400).json({ success: false, code: 'TOO_LONG', message: 'Guidance is capped at 8,000 characters.' });
    }
    const trimmed = aiGuidance.trim();
    const project = await prisma.project.update({
      where: { id: existing.id },
      data: { aiGuidance: trimmed || null },
      select: { id: true, aiGuidance: true },
    });
    await audit.log({
      userId: req.user.id,
      action: 'project.guidance.update',
      target: project.id,
      metadata: { length: trimmed.length },
      req,
    });
    res.json({ success: true, project });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/projects/:id/provider ────────────────────────
// Which LLM provider this project should use for its agents. Stored on
// Project.aiProvider. Accepts 'claude' or 'gemini'. The provider must be
// configured (Settings → Claude/Gemini) before any agent run will succeed —
// this endpoint just records the preference.
router.put('/:id/provider', requireCsrf, async (req, res, next) => {
  try {
    const { isValidProvider } = require('../lib/llmProvider');
    const existing = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { aiProvider } = req.body || {};
    if (!isValidProvider(aiProvider)) {
      return res.status(400).json({
        success: false, code: 'INVALID_PROVIDER',
        message: 'aiProvider must be one of: claude, gemini.',
      });
    }
    const project = await prisma.project.update({
      where: { id: existing.id },
      data: { aiProvider: String(aiProvider).toLowerCase() },
      select: { id: true, aiProvider: true },
    });
    await audit.log({
      userId: req.user.id,
      action: 'project.provider.update',
      target: project.id,
      metadata: { aiProvider: project.aiProvider },
      req,
    });
    res.json({ success: true, project });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/projects/:id ──────────────────────────────
//
// Filesystem cleanup:
//   Prisma cascades the rows (TestCase, RunResult, GovernancePR, etc.) but
//   the *files those rows reference on disk* are orphaned by default. Before
//   running prisma.project.delete() we collect every disk path this project
//   wrote — GovernancePR.filename for specs/page objects, RunResult.screenshots
//   /video/trace for execution artifacts — and unlink them after the DB
//   delete succeeds.
//
//   "After" so a failed DB delete never wipes disk; "best-effort" because an
//   already-missing file (e.g. manually cleared) shouldn't fail the request.
//
//   Empty per-module subdirectories under tests/ and pages/ are reaped
//   afterward so the file tree doesn't grow stale module folders forever.
const fs = require('fs');
const path = require('path');
const PLAYWRIGHT_DIR = path.join(__dirname, '..', '..', 'playwright');

function safeUnlink(absPath) {
  try { fs.unlinkSync(absPath); return true; }
  catch (err) { if (err.code !== 'ENOENT') console.warn(`[project.delete] unlink failed: ${absPath} — ${err.message}`); return false; }
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

router.delete('/:id', requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    // Collect every on-disk path this project wrote BEFORE the cascade
    // wipes the rows that reference them.
    const [prs, results] = await Promise.all([
      prisma.governancePR.findMany({
        where: { projectId: existing.id },
        select: { filename: true },
      }),
      prisma.runResult.findMany({
        where: { run: { projectId: existing.id } },
        select: { screenshots: true, video: true, trace: true },
      }),
    ]);

    const filesToDelete = new Set();
    for (const pr of prs) {
      if (pr.filename) filesToDelete.add(path.join(PLAYWRIGHT_DIR, pr.filename));
    }
    for (const r of results) {
      if (r.video) filesToDelete.add(path.join(PLAYWRIGHT_DIR, r.video));
      if (r.trace) filesToDelete.add(path.join(PLAYWRIGHT_DIR, r.trace));
      try {
        const shots = JSON.parse(r.screenshots || '[]');
        if (Array.isArray(shots)) {
          for (const url of shots) {
            // screenshot URLs are served as `/artifacts/<rel>` — translate to
            // `playwright/test-results/<rel>` on disk.
            if (typeof url === 'string' && url.startsWith('/artifacts/')) {
              filesToDelete.add(path.join(PLAYWRIGHT_DIR, 'test-results', url.slice('/artifacts/'.length)));
            }
          }
        }
      } catch (_) {}
    }
    await prisma.project.delete({ where: { id: existing.id } });

    // DB is gone — now drop the files on disk. Best-effort; failures here
    // are logged but don't bubble up (the project IS already deleted).
    let unlinked = 0;
    for (const abs of filesToDelete) {
      if (safeUnlink(abs)) unlinked++;
    }
    removeEmptyChildDirs(path.join(PLAYWRIGHT_DIR, 'tests'));
    removeEmptyChildDirs(path.join(PLAYWRIGHT_DIR, 'pages'));
    removeEmptyChildDirs(path.join(PLAYWRIGHT_DIR, 'test-results'));

    await audit.log({
      userId: req.user.id,
      action: 'project.delete',
      target: existing.id,
      metadata: { filesDeleted: unlinked, filesAttempted: filesToDelete.size },
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
