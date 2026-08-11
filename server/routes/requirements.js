'use strict';

const express = require('express');
const prisma = require('../prisma');
const vault = require('../services/vault');
const audit = require('../services/audit');
const ado = require('../services/ado');
const jira = require('../services/jira');
const integrations = require('../services/integrations');
const { extractText } = require('../services/docs');
const { normalizeRequirementDocument } = require('../services/requirementDocNormalizer');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const { buildDocumentUnderstanding } = require('../services/documentUnderstanding');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { sanitizeWarningList, sanitizeDegradations } = require('../lib/userFacingErrors');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

/**
 * Heuristic — guess document category from filename + first chunk of content.
 * The user can override in the UI.
 */
function guessCategory(name, text) {
  const fname = String(name || '').toLowerCase();
  const bodyRaw = String(text || '').slice(0, 3000);
  const body = bodyRaw.toLowerCase();

  // 1) FILENAME is the strongest signal — trust an explicit name before any
  //    content scan. A user-stories / API / release doc routinely QUOTES its
  //    parent BRD (e.g. "as per BRD-SD-2025-001"), so a content-first scan with
  //    a broad /brd/ net mislabels them as BRD. Filename-first kills that class.
  //    Order within filename: specific types before the broad BRD catch-all.
  if (/user[\s_-]?stor|userstor|\bus[\s_-]?\d/i.test(fname)) return 'user-stories';
  if (/release[\s_-]?note|changelog|whats[\s_-]?new/i.test(fname)) return 'release-notes';
  if (/openapi|swagger|\bapi\b|api[\s_-]?spec|endpoint/i.test(fname)) return 'api-spec';
  if (/\bbrd\b|business[\s_-]?req|business[\s_-]?spec/i.test(fname)) return 'brd';

  // 2) CONTENT fallback — again SPECIFIC types before BRD. The BRD pattern is
  //    tightened to require explicit BRD phrasing (a bare "brd" substring, as
  //    in a quoted doc-ID, no longer wins) and runs LAST so a real user-story /
  //    API / release body is classified by its own strong markers first.
  if (/release[\s_-]?notes?|changelog|whats[\s_-]?new|version\s+history/i.test(body)) return 'release-notes';
  if (/openapi|swagger|api[\s_-]?spec(ification)?|\bendpoint\b|paths:\s|\/api\/v\d/i.test(body)) return 'api-spec';
  if (looksLikeProceduralTestFlow(bodyRaw)) return 'user-stories';
  if (/user[\s_-]?stor|\bus-\d|acceptance criteria|\bas a\b.+\bi want\b|\bgiven\b.+\bwhen\b.+\bthen\b/is.test(body)) return 'user-stories';
  if (/business[\s_-]?requirements?[\s_-]?document|\bbrd[\s_-]?(document|spec)\b|business[\s_-]?requirement|business[\s_-]?spec/i.test(body)) return 'brd';
  return 'other';
}

function looksLikeProceduralTestFlow(text) {
  const body = String(text || '');
  const hasScenario = /^\s*scenario\s*:/im.test(body);
  const hasTestCase = /^\s*test\s*case\s*:/im.test(body);
  const hasSteps = /^\s*steps\s*:/im.test(body) && /^\s*\d+[.)]\s+\S+/m.test(body);
  const hasOracle = /^\s*(final|preferred)\s+validation\s*:/im.test(body)
    || /^\s*preferred\s+final\s+assertion\s*:/im.test(body);
  const hasExplicitShape = /^\s*expected\s+scenario\/test\s+case\s+shape\s*:/im.test(body)
    || /\bexpected\s+(scenario|test\s*case)\s+count\s*:/i.test(body);
  return (hasScenario && hasTestCase && hasSteps) || (hasSteps && hasOracle && hasExplicitShape);
}

async function getProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
  });
}

async function safeFindMany(modelName, args, fallback = []) {
  try {
    const model = prisma[modelName];
    if (!model || typeof model.findMany !== 'function') return fallback;
    return await model.findMany(args);
  } catch (_) {
    return fallback;
  }
}

// ── GET /api/projects/:projectId/requirements ─────────────
// `?sprintId=<id>` narrows to a sprint container (Phase B / B3). Absent =
// every requirement for the project (legacy behaviour).
router.get('/', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const requirements = await prisma.requirement.findMany({
      where: {
        projectId: project.id,
        ...(req.query.sprintId ? { sprintId: String(req.query.sprintId) } : {}),
      },
      orderBy: { pulledAt: 'desc' },
    });
    res.json({ success: true, requirements });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/requirements/upload ──────
// Phase 1: understand uploaded BRD/User Stories/Release Notes before test-case
// generation. Read-only, deterministic, and no-egress: this produces the
// planning artifact that later asks for module-specific TestData.
router.get('/understanding', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const sprintId = req.query.sprintId ? String(req.query.sprintId) : null;
    const scoped = { projectId: project.id, ...(sprintId ? { sprintId } : {}) };

    const [documents, requirementClauses, testDataSets, scenarios, calibrations] = await Promise.all([
      safeFindMany('document', {
        where: scoped,
        orderBy: { uploadedAt: 'desc' },
        select: { id: true, name: true, category: true, content: true, uploadedAt: true },
      }),
      safeFindMany('requirementClause', {
        where: scoped,
        orderBy: { createdAt: 'asc' },
        select: { id: true, sourceType: true, behaviourText: true, excerpt: true, sourceDocId: true },
      }),
      safeFindMany('testDataSet', {
        where: scoped,
        orderBy: { uploadedAt: 'desc' },
        select: { id: true, name: true, rowCount: true, sheetsJson: true, mappingJson: true, uploadedAt: true },
      }),
      safeFindMany('testScenario', {
        where: { projectId: project.id },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, module: true },
      }),
      safeFindMany('calibration', {
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          module: true,
          authProfileId: true,
          version: true,
          isCurrent: true,
          pagesCount: true,
          startUrl: true,
          status: true,
          staleAt: true,
        },
      }),
    ]);

    const understanding = buildDocumentUnderstanding({
      project,
      documents,
      requirementClauses,
      testDataSets,
      scenarios,
      calibrations,
    });
    res.json({ success: true, understanding });
  } catch (err) {
    next(err);
  }
});

router.post('/upload', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const docs = Array.isArray(req.body?.documents) ? req.body.documents : [];
    if (!docs.length)
      return res.status(400).json({ success: false, code: 'NO_DOCS', message: 'No documents provided' });

    // Sprint tag: if the caller passed sprintId in the body, every doc + its
    // synthesised requirement gets stamped with it. NULL stays NULL for
    // legacy clients that don't send the field.
    const sprintId = req.body?.sprintId ? String(req.body.sprintId) : null;

    // Resolve the project's AI credentials ONCE (best-effort). Only IMAGE
    // uploads need them — for vision extraction (Phase M0). Text/PDF/DOCX paths
    // are unaffected, so a missing key never blocks a normal upload; an image
    // upload without a key is rejected with a clear degradation inside extractText.
    let aiCreds = null;
    try {
      const { provider, apiKey, model } = await resolveAiCredentials(req.user.id, project);
      if (apiKey && provider) aiCreds = { provider, apiKey, model };
    } catch (_) { aiCreds = null; }

    const created = [];
    const warnings = [];
    const degradations = []; // structured honest-signal records surfaced to the UI
    for (const d of docs) {
      const { text, parser, warning, rejected } = await extractText(d, { collector: degradations, ai: aiCreds });
      if (warning) warnings.push(`${d.name}: ${warning}`);
      // Rejected formats / scanned PDFs already emitted a structured degradation
      // with a clear reason; skip the generic "no extractable text" duplicate.
      if (rejected) continue;
      if (!text || text.trim().length < 20) {
        warnings.push(`${d.name}: no extractable text`);
        continue;
      }
      // Vision-transcribed images are tagged 'visual' so the requirementOracle
      // includes them (sourceTypeForCategory → 'VISUAL') and preserves their
      // provenance; text docs keep the heuristic category.
      const category = parser === 'vision' ? 'visual' : guessCategory(d.name || '', text);
      const normalizedText = await normalizeRequirementDocument(text, {
        project,
        userId: req.user.id,
        ai: aiCreds,
      });

      const doc = await prisma.document.create({
        data: {
          projectId: project.id,
          sprintId,
          name: d.name || 'untitled',
          mimeType: d.mimeType || d.type || null,
          sizeBytes: typeof d.sizeBytes === 'number' ? d.sizeBytes : Buffer.byteLength(normalizedText, 'utf8'),
          content: normalizedText,
          category,
        },
      });
      const req_ = await prisma.requirement.create({
        data: {
          projectId: project.id,
          sprintId,
          sourceType: 'upload',
          sourceIdentifier: doc.id,
          title: d.name || null,
          content: normalizedText.slice(0, 32000),
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

    const safeWarnings = sanitizeWarningList(warnings, { area: 'document' });
    const safeDegradations = sanitizeDegradations(degradations, { area: 'document' });

    await audit.log({
      userId: req.user.id,
      action: 'requirements.upload',
      target: project.id,
      metadata: { count: created.length, warnings: safeWarnings.length, degradations: safeDegradations.length, clearedStaleAnalysis: touchedReleaseNotes },
      req,
    });
    res.json({
      success: true,
      created,
      warnings: safeWarnings,
      degradations: safeDegradations,
      message:
        `${created.length} document(s) indexed.` +
        (safeWarnings.length ? ` ${safeWarnings.length} warning(s).` : ''),
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

    const sprintId = req.body?.sprintId ? String(req.body.sprintId) : null;
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
            // Re-pull DOES re-tag with the current sprint (if any) — the
            // user's intent in re-pulling is "this is the latest state of
            // this requirement for THIS release", which lines up with the
            // currently-selected sprint.
            data: { content: i.content, title: i.title, pulledAt: new Date(), sprintId },
          })
        : await prisma.requirement.create({
            data: {
              projectId: project.id,
              sprintId,
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
module.exports._private = { guessCategory, looksLikeProceduralTestFlow };
