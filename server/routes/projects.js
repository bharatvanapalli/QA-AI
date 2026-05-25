'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const vault = require('../services/vault');
const github = require('../services/git/github');
const codeDiffAnalyzer = require('../services/agents/codeDiffAnalyzer');
const cancelRegistry = require('../services/cancelRegistry');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
router.use(requireAuth);
// Phase E8 — every project route runs inside an org. requireOrg loads
// req.org = { id, name, slug, role } and rejects users with no active org.
router.use(requireOrg);

const VALID_GIT_PROVIDERS = ['github'];

// ── GET /api/projects ─────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const projects = await prisma.project.findMany({
      where: { orgId: req.org.id },
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
        orgId: req.org.id,
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
      where: { id: req.params.id, orgId: req.org.id },
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
      where: { id: req.params.id, orgId: req.org.id },
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
      where: { id: req.params.id, orgId: req.org.id },
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
      where: { id: req.params.id, orgId: req.org.id },
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

// ── PUT /api/projects/:id/credentials ─────────────────────
// Test users the agent is authorised to log in as for THIS project. Stored
// as a JSON-encoded array on Project.testCredentials. The Conductor injects
// them into its system prompt as "## Available test users" — if the array
// is empty and a case needs a logged-in user, the agent ends the turn with
// "BLOCKED: no credentials provided" instead of fabricating an account.
// Body: { testCredentials: [{ name?, email, password, notes? }] | [] | null }
router.put('/:id/credentials', requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.project.findFirst({
      where: { id: req.params.id, orgId: req.org.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { testCredentials } = req.body || {};
    let normalised = [];
    if (Array.isArray(testCredentials)) {
      if (testCredentials.length > 20) {
        return res.status(400).json({ success: false, code: 'TOO_MANY', message: 'Maximum 20 test users per project.' });
      }
      for (const raw of testCredentials) {
        if (!raw || typeof raw !== 'object') continue;
        const email = String(raw.email || '').trim();
        const password = String(raw.password || '');
        if (!email || !password) {
          return res.status(400).json({ success: false, code: 'INVALID_USER', message: 'Each test user needs at least email and password.' });
        }
        normalised.push({
          name: String(raw.name || '').slice(0, 100).trim() || null,
          email: email.slice(0, 200),
          password: password.slice(0, 200),
          notes: String(raw.notes || '').slice(0, 400).trim() || null,
        });
      }
    } else if (testCredentials !== null && testCredentials !== undefined) {
      return res.status(400).json({ success: false, code: 'INVALID_BODY', message: 'testCredentials must be an array or null.' });
    }

    const project = await prisma.project.update({
      where: { id: existing.id },
      data: { testCredentials: normalised.length ? JSON.stringify(normalised) : null },
      select: { id: true, testCredentials: true },
    });
    await audit.log({
      userId: req.user.id,
      action: 'project.credentials.update',
      target: project.id,
      metadata: { count: normalised.length },
      req,
    });
    res.json({ success: true, project: { id: project.id, testCredentials: normalised } });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/projects/:id/repo ────────────────────────────
// Git repository metadata for code-diff awareness (Phase E3). Stores the
// repoUrl / defaultBranch / gitProvider on Project. If `pat` is supplied
// (non-empty), the PAT is encrypted into the per-user vault under
// `<provider>.pat` so subsequent /diff-context calls can fetch privately.
// Sending pat:'' clears the stored PAT.
router.put('/:id/repo', requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.project.findFirst({
      where: { id: req.params.id, orgId: req.org.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { repoUrl, defaultBranch, gitProvider, pat } = req.body || {};
    const trimmedUrl = typeof repoUrl === 'string' ? repoUrl.trim() : '';
    const trimmedBranch = typeof defaultBranch === 'string' ? defaultBranch.trim() : '';
    const provider = typeof gitProvider === 'string' && gitProvider.trim() ? gitProvider.trim().toLowerCase() : null;

    if (trimmedUrl && !github.parseRepoUrl(trimmedUrl)) {
      return res.status(400).json({
        success: false, code: 'INVALID_REPO_URL',
        message: 'repoUrl must be a GitHub https:// or git@ URL.',
      });
    }
    if (provider && !VALID_GIT_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        success: false, code: 'INVALID_PROVIDER',
        message: `gitProvider must be one of: ${VALID_GIT_PROVIDERS.join(', ')}.`,
      });
    }

    const project = await prisma.project.update({
      where: { id: existing.id },
      data: {
        repoUrl: trimmedUrl || null,
        defaultBranch: trimmedBranch || null,
        gitProvider: provider,
      },
      select: { id: true, repoUrl: true, defaultBranch: true, gitProvider: true },
    });

    // Vault PAT — only touch when the body explicitly supplied `pat`.
    if (typeof pat === 'string') {
      const secretName = `${provider || 'github'}.pat`;
      if (pat.trim() === '') {
        await vault.remove(req.user.id, secretName);
      } else {
        await vault.put(req.user.id, secretName, pat.trim());
      }
    }
    const meta = await vault.meta(req.user.id, `${provider || 'github'}.pat`);

    await audit.log({
      userId: req.user.id,
      action: 'project.repo.update',
      target: project.id,
      metadata: { repoUrl: project.repoUrl, gitProvider: project.gitProvider, hasPat: !!meta },
      req,
    });
    res.json({
      success: true,
      project,
      pat: meta ? { lastFour: meta.lastFour, updatedAt: meta.updatedAt } : null,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:id/repo ────────────────────────────
router.get('/:id/repo', async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, orgId: req.org.id },
      select: { id: true, repoUrl: true, defaultBranch: true, gitProvider: true },
    });
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const secretName = `${project.gitProvider || 'github'}.pat`;
    const meta = await vault.meta(req.user.id, secretName);
    res.json({
      success: true,
      project,
      pat: meta ? { lastFour: meta.lastFour, updatedAt: meta.updatedAt } : null,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:id/browser-context ─────────────────
// Phase E10.5 — read-back of the browser-context configuration that
// drives the MCP session at run time. Sensitive bits (httpCredentials
// password, extraHeaders) are returned in full for the editor; the UI
// gates this section behind admin-only access in a future hardening.
router.get('/:id/browser-context', async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, orgId: req.org.id },
      select: {
        id: true,
        contextViewport: true, contextDevice: true, contextLocale: true,
        contextUserAgent: true, contextColorScheme: true, contextPermissions: true,
        contextGeolocation: true, contextHttpCredentials: true, contextExtraHeaders: true,
        contextIgnoreHttpsErrors: true, contextProxyServer: true, contextProxyBypass: true,
        autoAcceptDialogs: true,
      },
    });
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    res.json({ success: true, context: project });
  } catch (err) { next(err); }
});

// ── PUT /api/projects/:id/browser-context ─────────────────
// Replaces the browser-context configuration. All fields optional; passing
// null clears a field (back to MCP defaults). Validation is minimal — bad
// JSON in geolocation/credentials/headers is caught at MCP boot time and
// surfaced via the broadcast warn channel; we don't reject early because
// the editor stores user-supplied JSON strings and the strictest check is
// "does it run".
router.put('/:id/browser-context', requireCsrf, async (req, res, next) => {
  try {
    const b = req.body || {};
    const data = {};
    const FIELDS = [
      'contextViewport', 'contextDevice', 'contextLocale', 'contextUserAgent',
      'contextColorScheme', 'contextPermissions', 'contextGeolocation',
      'contextHttpCredentials', 'contextExtraHeaders', 'contextProxyServer',
      'contextProxyBypass',
    ];
    for (const k of FIELDS) {
      if (k in b) data[k] = b[k] === '' || b[k] === null ? null : String(b[k]);
    }
    if ('contextIgnoreHttpsErrors' in b) data.contextIgnoreHttpsErrors = !!b.contextIgnoreHttpsErrors;
    if ('autoAcceptDialogs' in b) data.autoAcceptDialogs = !!b.autoAcceptDialogs;

    const existing = await prisma.project.findFirst({
      where: { id: req.params.id, orgId: req.org.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const updated = await prisma.project.update({
      where: { id: req.params.id },
      data,
      select: {
        id: true,
        contextViewport: true, contextDevice: true, contextLocale: true,
        contextUserAgent: true, contextColorScheme: true, contextPermissions: true,
        contextGeolocation: true, contextHttpCredentials: true, contextExtraHeaders: true,
        contextIgnoreHttpsErrors: true, contextProxyServer: true, contextProxyBypass: true,
        autoAcceptDialogs: true,
      },
    });
    await audit.log({
      userId: req.user.id,
      orgId: req.org.id,
      action: 'project.browser_context.update',
      target: req.params.id,
      metadata: { fields: Object.keys(data) },
    });
    res.json({ success: true, context: updated });
  } catch (err) { next(err); }
});

// ── GET /api/projects/:id/downloads ──────────────────────
// List downloads captured for this project, newest first. Optional
// ?runResultId= filter for the Reports detail pane.
router.get('/:id/downloads', async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, orgId: req.org.id },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const where = { projectId: project.id };
    if (req.query.runResultId) where.runResultId = String(req.query.runResultId);
    const downloads = await prisma.download.findMany({
      where,
      orderBy: { capturedAt: 'desc' },
      take: 200,
      select: {
        id: true, suggestedFilename: true, sizeBytes: true, mimeType: true,
        capturedAt: true, runResultId: true,
      },
    });
    res.json({ success: true, downloads });
  } catch (err) { next(err); }
});

// ── POST /api/projects/:id/diff-context ───────────────────
// Fetch a diff (PR or branch comparison), run the codeDiffAnalyzer,
// persist a DiffContext row. Optionally tagged to a sprint via `sprintId`.
// Body: { prNumber? | branch?, baseBranch?, sprintId? }
router.post(
  '/:id/diff-context',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 8 }),
  async (req, res, next) => {
    try {
      const project = await prisma.project.findFirst({
        where: { id: req.params.id, orgId: req.org.id },
      });
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
      if (!project.repoUrl) {
        return res.status(400).json({
          success: false, code: 'NO_REPO_URL',
          message: 'Configure a Git repository under Project Setup first.',
        });
      }

      const { prNumber, branch, baseBranch, sprintId } = req.body || {};
      if (!prNumber && !branch) {
        return res.status(400).json({
          success: false, code: 'MISSING_REF',
          message: 'Provide either prNumber or branch.',
        });
      }
      if (sprintId) {
        const sprint = await prisma.sprint.findFirst({
          where: { id: sprintId, projectId: project.id },
          select: { id: true },
        });
        if (!sprint) {
          return res.status(400).json({ success: false, code: 'INVALID_SPRINT', message: 'Sprint not found in this project.' });
        }
      }

      const secretName = `${project.gitProvider || 'github'}.pat`;
      const token = await vault.get(req.user.id, secretName);
      // PAT is optional for public repos; the GitHub API just falls back to
      // unauthenticated rate limits. We don't reject when missing.

      let diff;
      try {
        diff = await github.fetchDiff({
          token,
          repoUrl: project.repoUrl,
          prNumber,
          branch,
          baseBranch: baseBranch || project.defaultBranch || 'main',
        });
      } catch (err) {
        return res.status(err.status || 502).json({
          success: false,
          code: err.code || 'GIT_API',
          message: err.message,
        });
      }

      // Resolve AI credentials so the analyzer has a provider to call.
      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured.`,
        });
      }

      const existingModuleRows = await prisma.testCase.findMany({
        where: { projectId: project.id, module: { not: null } },
        distinct: ['module'],
        select: { module: true },
      });
      const existingModules = existingModuleRows.map((r) => r.module).filter(Boolean);

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, msg);
      const onLog = async (level, message) => send({ type: 'agent.phase.log', phase: 'diff-analyzer', level, message });
      const onRateLimit = (info) => send({ type: 'claude.rate-limit', ...info });

      send({ type: 'agent.phase.start', phase: 'diff-analyzer', label: 'Diff Analyzer', projectId: project.id });
      const cancelToken = cancelRegistry.create(req.user.id);

      let analysis;
      try {
        analysis = await codeDiffAnalyzer.run({
          apiKey, model, provider,
          projectName: project.name,
          changedFiles: diff.changedFiles,
          existingModules,
          ref: diff.ref,
          baseRef: diff.baseRef,
          onLog, onRateLimit,
          signal: cancelToken.signal,
          extraGuidance: project.aiGuidance || null,
        });
      } catch (err) {
        cancelRegistry.clear(req.user.id);
        const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
        send({ type: 'agent.phase.complete', phase: 'diff-analyzer', projectId: project.id, error: cancelled ? 'cancelled' : err.message, cancelled });
        if (cancelled) return res.status(499).json({ success: false, code: 'CANCELLED' });
        return res.status(err.status || 502).json({ success: false, code: err.code, message: err.message });
      }
      cancelRegistry.clear(req.user.id);

      const ctx = await prisma.diffContext.create({
        data: {
          projectId: project.id,
          sprintId: sprintId || null,
          ref: diff.ref,
          baseRef: diff.baseRef,
          changedFiles: JSON.stringify(diff.changedFiles),
          changedModules: JSON.stringify(analysis.impactedModules || []),
          summary: analysis.summary || null,
        },
      });

      send({
        type: 'agent.phase.complete',
        phase: 'diff-analyzer',
        projectId: project.id,
        diffContextId: ctx.id,
      });

      await audit.log({
        userId: req.user.id,
        action: 'project.diff-context.create',
        target: project.id,
        metadata: {
          diffContextId: ctx.id,
          ref: diff.ref,
          baseRef: diff.baseRef,
          fileCount: diff.changedFiles.length,
          impactedModules: analysis.impactedModules?.length || 0,
          suggestedScenarios: analysis.suggestedScenarios?.length || 0,
        },
        req,
      });

      res.status(201).json({
        success: true,
        diffContext: {
          id: ctx.id,
          ref: ctx.ref,
          baseRef: ctx.baseRef,
          summary: ctx.summary,
          fetchedAt: ctx.fetchedAt,
          sprintId: ctx.sprintId,
          changedFiles: diff.changedFiles,
          changedModules: analysis.impactedModules || [],
          suggestedScenarios: analysis.suggestedScenarios || [],
          headRef: diff.headRef || null,
          title: diff.title || null,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/projects/:id/diff-context ────────────────────
// List recent DiffContext entries (most recent first). Optional ?sprintId=.
router.get('/:id/diff-context', async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, orgId: req.org.id },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const where = { projectId: project.id };
    if (req.query.sprintId) where.sprintId = String(req.query.sprintId);

    const rows = await prisma.diffContext.findMany({
      where,
      orderBy: { fetchedAt: 'desc' },
      take: 20,
    });
    const items = rows.map((r) => ({
      id: r.id,
      sprintId: r.sprintId,
      ref: r.ref,
      baseRef: r.baseRef,
      summary: r.summary,
      fetchedAt: r.fetchedAt,
      changedFiles: safeJsonParse(r.changedFiles, []),
      changedModules: safeJsonParse(r.changedModules, []),
    }));
    res.json({ success: true, diffContexts: items });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/projects/:projectId/diff-context/:id ──────
router.delete('/:projectId/diff-context/:id', requireCsrf, async (req, res, next) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.projectId, orgId: req.org.id },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const result = await prisma.diffContext.deleteMany({
      where: { id: req.params.id, projectId: project.id },
    });
    if (result.count === 0) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await audit.log({
      userId: req.user.id,
      action: 'project.diff-context.delete',
      target: req.params.id,
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

function safeJsonParse(raw, fallback) {
  try { return JSON.parse(raw || ''); } catch (_) { return fallback; }
}

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
      where: { id: req.params.id, orgId: req.org.id },
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
