'use strict';

const express = require('express');
const prisma = require('../prisma');
const vault = require('../services/vault');
const audit = require('../services/audit');
const ado = require('../services/ado');
const jira = require('../services/jira');
const integrations = require('../services/integrations');
const { extractText } = require('../services/docs');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

/**
 * Heuristic — guess document category from filename + first chunk of content.
 * The user can override in the UI.
 */
function guessCategory(name, text) {
  const lower = `${name}\n${(text || '').slice(0, 500)}`.toLowerCase();
  if (/release[\s_-]?notes?|changelog|whats[\s_-]?new|release[\s_-]?\d/i.test(lower)) return 'release-notes';
  if (/brd|business[\s_-]?requirement|business[\s_-]?spec/i.test(lower)) return 'brd';
  if (/user[\s_-]?stor|us-\d|acceptance criteria|\bgiven\b.+\bwhen\b.+\bthen\b/is.test(lower)) return 'user-stories';
  if (/openapi|swagger|api[\s_-]?spec|endpoint|paths:|\/api\/v\d/i.test(lower)) return 'api-spec';
  return 'other';
}

async function getProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, userId: req.user.id },
  });
}

// ── GET /api/projects/:projectId/requirements ─────────────
router.get('/', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const requirements = await prisma.requirement.findMany({
      where: { projectId: project.id },
      orderBy: { pulledAt: 'desc' },
    });
    res.json({ success: true, requirements });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/requirements/upload ──────
router.post('/upload', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const docs = Array.isArray(req.body?.documents) ? req.body.documents : [];
    if (!docs.length)
      return res.status(400).json({ success: false, code: 'NO_DOCS', message: 'No documents provided' });

    const created = [];
    const warnings = [];
    for (const d of docs) {
      const { text, parser, warning } = await extractText(d);
      if (warning) warnings.push(`${d.name}: ${warning}`);
      if (!text || text.trim().length < 20) {
        warnings.push(`${d.name}: no extractable text`);
        continue;
      }
      const category = guessCategory(d.name || '', text);
      const doc = await prisma.document.create({
        data: {
          projectId: project.id,
          name: d.name || 'untitled',
          mimeType: d.mimeType || d.type || null,
          sizeBytes: typeof d.sizeBytes === 'number' ? d.sizeBytes : Buffer.byteLength(text, 'utf8'),
          content: text,
          category,
        },
      });
      const req_ = await prisma.requirement.create({
        data: {
          projectId: project.id,
          sourceType: 'upload',
          sourceIdentifier: doc.id,
          title: d.name || null,
          content: text.slice(0, 8000),
          category,
        },
      });
      created.push({ document: doc, requirement: req_, parser, category });
    }

    // INT-15 / INT-16: a fresh upload (especially release notes) invalidates
    // prior Discrepancy rows and prior Scenario.impacted flags — both are
    // computed against a snapshot of the documents and become stale the
    // moment a new doc lands. Clear them so the UI doesn't show old
    // analysis next to new requirements; the user re-runs detect /
    // select-impacted on demand.
    const touchedReleaseNotes = created.some(
      (c) => c.category === 'release-notes' || c.category === 'brd'
    );
    if (touchedReleaseNotes) {
      await prisma.discrepancy.deleteMany({
        where: { projectId: project.id, resolved: false },
      });
      await prisma.testScenario.updateMany({
        where: { projectId: project.id, impacted: true },
        data: { impacted: false, impactReason: null },
      });
    }

    await audit.log({
      userId: req.user.id,
      action: 'requirements.upload',
      target: project.id,
      metadata: { count: created.length, warnings: warnings.length, clearedStaleAnalysis: touchedReleaseNotes },
      req,
    });
    res.json({
      success: true,
      created,
      warnings,
      message:
        `${created.length} document(s) indexed.` +
        (warnings.length ? ` ${warnings.length} warning(s).` : ''),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/requirements/pull/:source ──
router.post('/pull/:source', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const source = req.params.source;
    if (!['ado', 'jira'].includes(source))
      return res.status(400).json({ success: false, code: 'INVALID_SOURCE' });

    const integration = await integrations.get(req.user.id, source);
    if (!integration || integration.status !== 'valid') {
      return res.status(400).json({
        success: false,
        code: 'INTEGRATION_NOT_CONFIGURED',
        message: `${source.toUpperCase()} is not configured. Visit Settings → ${source.toUpperCase()}.`,
      });
    }

    let items = [];
    try {
      if (source === 'ado') {
        const pat = await vault.get(req.user.id, 'ado.pat');
        if (!pat) return res.status(400).json({ success: false, code: 'NO_PAT' });
        items = await ado.pullWorkItems({
          orgUrl: integration.config.orgUrl,
          pat,
          projectName: integration.config.projectName,
          limit: 50,
        });
      } else {
        const token = await vault.get(req.user.id, 'jira.token');
        if (!token) return res.status(400).json({ success: false, code: 'NO_TOKEN' });
        items = await jira.pullIssues({
          url: integration.config.url,
          email: integration.config.email,
          token,
          projectKey: integration.config.projectKey,
          limit: 50,
        });
      }
    } catch (err) {
      return res.status(502).json({
        success: false,
        code: err.code || 'UPSTREAM_ERROR',
        message: err.message,
      });
    }

    const created = [];
    for (const i of items) {
      const existing = await prisma.requirement.findFirst({
        where: {
          projectId: project.id,
          sourceType: source,
          sourceIdentifier: i.sourceIdentifier,
        },
        select: { id: true },
      });
      const r = existing
        ? await prisma.requirement.update({
            where: { id: existing.id },
            data: { content: i.content, title: i.title, pulledAt: new Date() },
          })
        : await prisma.requirement.create({
            data: {
              projectId: project.id,
              sourceType: source,
              sourceIdentifier: i.sourceIdentifier,
              title: i.title,
              content: i.content,
            },
          });
      created.push(r);
    }
    await audit.log({
      userId: req.user.id,
      action: 'requirements.pull',
      target: project.id,
      metadata: { source, count: created.length },
      req,
    });
    res.json({
      success: true,
      created,
      message: `Pulled ${created.length} item(s) from ${source.toUpperCase()}.`,
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/projects/:projectId/requirements/:rid ──────
router.delete('/:rid', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await prisma.requirement.deleteMany({
      where: { id: req.params.rid, projectId: project.id },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:projectId/documents ────────────────
router.get('/documents/list', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const documents = await prisma.document.findMany({
      where: { projectId: project.id },
      orderBy: { uploadedAt: 'desc' },
      select: { id: true, name: true, mimeType: true, sizeBytes: true, uploadedAt: true },
    });
    res.json({ success: true, documents });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
