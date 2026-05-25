'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const vault = require('../services/vault');
const github = require('../services/git/github');
const lintGates = require('../services/lintGates');
const { encodeJson, decodeJson } = require('../services/jsonField');
const { diffLines, summarise } = require('../lib/lineDiff');
const { rateLimit } = require('../middleware/rateLimit');

function inflate(pr) {
  if (!pr) return pr;
  return { ...pr, lintFindings: decodeJson(pr.lintFindings, []) || [] };
}
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
  });
}

// `?sprintId=<id>` narrows to PRs created in a sprint container (Phase B / B3).
router.get('/', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const prs = await prisma.governancePR.findMany({
      where: {
        projectId: project.id,
        ...(req.query.sprintId ? { sprintId: String(req.query.sprintId) } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        // Pull test-case name for context
      },
    });
    res.json({ success: true, prs: prs.map(inflate) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!pr) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    res.json({ success: true, pr: inflate(pr) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/approve', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.update({
      where: { id: req.params.id },
      data: { status: 'approved', reviewer: req.user.email, reviewedAt: new Date() },
    });
    await audit.log({
      userId: req.user.id,
      action: 'governance.approve',
      target: pr.id,
      req,
    });
    res.json({ success: true, pr: inflate(pr) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/merge', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    if (existing.status !== 'approved') {
      return res.status(400).json({
        success: false,
        code: 'NOT_APPROVED',
        message: 'PR must be approved before merging.',
      });
    }
    if (!existing.lintPassed) {
      return res.status(400).json({
        success: false,
        code: 'LINT_FAILED',
        message: 'Cannot merge a PR with lint errors. Re-generate the test or fix the spec.',
      });
    }
    const pr = await prisma.governancePR.update({
      where: { id: existing.id },
      data: { status: 'merged', reviewedAt: new Date() },
    });
    await audit.log({
      userId: req.user.id,
      action: 'governance.merge',
      target: pr.id,
      req,
    });
    res.json({ success: true, pr: inflate(pr) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/lint', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const lint = lintGates.lint(existing.specCode || '');
    const pr = await prisma.governancePR.update({
      where: { id: existing.id },
      data: { lintPassed: lint.lintPassed, lintFindings: encodeJson(lint.findings) },
    });
    res.json({
      success: true,
      pr: inflate(pr),
      lint: {
        passed: lint.lintPassed,
        errorCount: lint.errorCount,
        warningCount: lint.warningCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reject', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.update({
      where: { id: req.params.id },
      data: { status: 'rejected', reviewer: req.user.email, reviewedAt: new Date() },
    });
    await audit.log({
      userId: req.user.id,
      action: 'governance.reject',
      target: pr.id,
      req,
    });
    res.json({ success: true, pr: inflate(pr) });
  } catch (err) {
    next(err);
  }
});

// ── GET /:id/diff ────────────────────────────────────────
// Phase 8 side-by-side diff. Computes the line-level diff between THIS PR's
// specCode and the "base" version — the most recent MERGED PR for the same
// testCaseId on the same project. When no prior merge exists (greenfield
// case), the base is treated as an empty file so the entire current code
// renders as additions.
//
// Response:
//   { baseRef: { id, number, createdAt } | null,
//     rows:    Array<DiffRow>,
//     summary: { added, removed, equal, total } }
router.get('/:id/diff', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!pr) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    // Pick the base: most recent MERGED PR for the same testCaseId, that
    // isn't this PR itself. Falls back to null (greenfield → empty base).
    let base = null;
    if (pr.testCaseId) {
      base = await prisma.governancePR.findFirst({
        where: {
          projectId: project.id,
          testCaseId: pr.testCaseId,
          status: 'merged',
          NOT: { id: pr.id },
        },
        orderBy: { reviewedAt: 'desc' },
        select: { id: true, number: true, createdAt: true, reviewedAt: true, specCode: true },
      });
    }

    const rows = diffLines(base?.specCode || '', pr.specCode || '');
    const summary = summarise(rows);

    res.json({
      success: true,
      baseRef: base ? { id: base.id, number: base.number, mergedAt: base.reviewedAt } : null,
      rows,
      summary,
    });
  } catch (err) {
    next(err);
  }
});

// ── Comments thread (Phase 8) ────────────────────────────
// Free-form review comments per PR. Newest first. The author identifier is
// the requester's email — comments are display-only context, no FK to User.
router.get('/:id/comments', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
      select: { id: true },
    });
    if (!pr) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const comments = await prisma.pRComment.findMany({
      where: { prId: pr.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, comments });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/comments', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
      select: { id: true },
    });
    if (!pr) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ success: false, code: 'EMPTY_BODY', message: 'Comment body is required.' });
    }
    if (body.length > 4000) {
      return res.status(400).json({ success: false, code: 'TOO_LONG', message: 'Comment is capped at 4,000 characters.' });
    }

    const comment = await prisma.pRComment.create({
      data: { prId: pr.id, author: req.user.email, body },
    });
    await audit.log({
      userId: req.user.id,
      action: 'governance.comment',
      target: pr.id,
      metadata: { length: body.length },
      req,
    });
    res.status(201).json({ success: true, comment });
  } catch (err) {
    next(err);
  }
});

// Only the original author may delete their own comment. We don't expose a
// generic "delete any comment" path — protects history integrity.
router.delete('/:id/comments/:cid', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
      select: { id: true },
    });
    if (!pr) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.pRComment.findFirst({
      where: { id: req.params.cid, prId: pr.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    if (existing.author !== req.user.email) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'You can only delete your own comments.' });
    }
    await prisma.pRComment.delete({ where: { id: existing.id } });
    await audit.log({
      userId: req.user.id,
      action: 'governance.comment.delete',
      target: pr.id,
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Phase E7 — push generated spec to a real Git provider ──
// POST /api/projects/:projectId/governance/:id/push-to-git
//
// Creates a branch off Project.defaultBranch, commits the spec onto it,
// opens a PR. Updates the GovernancePR row with provider state on success.
// QAAI's internal `status` is independent — operators can also "Merge"
// the PR in QAAI to checkpoint it as the diff baseline; the two state
// machines don't override each other.
//
// Requirements (route refuses with a tagged 400 otherwise):
//   - PR.status === 'approved'
//   - PR.lintPassed === true
//   - Project has a repoUrl configured (PUT /:id/repo)
//   - A PAT is stored for the project's provider in the user's vault
//   - PR has not been pushed already (providerPrUrl null)
//
// Idempotency: if branch creation hits "Reference already exists" (422),
// the route still tries to commit + open PR. That handles re-pushes
// after a flaky network mid-flow without doubling up state.
router.post(
  '/:id/push-to-git',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 6 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
      const pr = await prisma.governancePR.findFirst({
        where: { id: req.params.id, projectId: project.id },
      });
      if (!pr) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      if (pr.status !== 'approved') {
        return res.status(400).json({
          success: false, code: 'NOT_APPROVED',
          message: 'Push to Git requires the QAAI PR to be approved first.',
        });
      }
      if (!pr.lintPassed) {
        return res.status(400).json({
          success: false, code: 'LINT_FAILED',
          message: 'Lint must pass before pushing the spec to Git.',
        });
      }
      if (pr.providerPrUrl) {
        return res.status(400).json({
          success: false, code: 'ALREADY_PUSHED',
          message: 'This PR has already been pushed.',
          providerPrUrl: pr.providerPrUrl,
        });
      }
      if (!project.repoUrl) {
        return res.status(400).json({
          success: false, code: 'NO_REPO_URL',
          message: 'Configure a Git repository under Project Setup → Git repository first.',
        });
      }

      const providerName = project.gitProvider || 'github';
      if (providerName !== 'github') {
        return res.status(400).json({
          success: false, code: 'PROVIDER_UNSUPPORTED',
          message: `Push to Git only supports GitHub in v1. Got: ${providerName}.`,
        });
      }

      const token = await vault.get(req.user.id, `${providerName}.pat`);
      if (!token) {
        return res.status(400).json({
          success: false, code: 'NO_PAT',
          message: 'Add a Personal Access Token under Project Setup → Git repository (needs `repo` scope).',
        });
      }

      // Compose the branch + commit + PR payloads. The frontend can
      // override these via the request body for the confirm-modal preview,
      // but we apply server-side defaults + sanity caps.
      const overrides = req.body || {};
      const slug = (str) => String(str || '').toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);

      const branchName = overrides.branchName
        ? String(overrides.branchName).trim().slice(0, 120)
        : `qaai/${slug(pr.number || pr.id.slice(0, 8))}-${slug(pr.requirement || 'test')}`;

      const commitMessage = overrides.commitMessage
        ? String(overrides.commitMessage).slice(0, 400)
        : `QAAI ${pr.number}: ${pr.requirement || 'add generated test'}`;

      const prTitle = overrides.prTitle
        ? String(overrides.prTitle).slice(0, 240)
        : `[QAAI ${pr.number}] ${pr.requirement || pr.filename}`;

      // The PR description is fully derived from QAAI state so reviewers
      // see the run link, lint result, and requirement text without
      // hopping between systems. Lint findings list rendered as a
      // markdown checklist.
      const lintFindings = decodeJson(pr.lintFindings, []) || [];
      const findingsSection = lintFindings.length === 0
        ? '✓ Lint clean — no findings.'
        : `Lint findings (${lintFindings.length}):\n` +
          lintFindings.slice(0, 20).map((f) =>
            `- **${f.severity}** \`${f.rule}\` (L${f.line || '?'}) — ${String(f.message || '').slice(0, 200)}`,
          ).join('\n');

      const prBody = overrides.prBody ? String(overrides.prBody).slice(0, 60_000) : [
        `> Generated by QAAI Portal · Project **${project.name}**`,
        '',
        `**QAAI PR:** ${pr.number}`,
        `**Test case:** ${pr.testCaseId || '—'}`,
        `**Requirement:** ${pr.requirement || '—'}`,
        '',
        '## Lint',
        findingsSection,
        '',
        '## Spec',
        '```ts',
        (pr.specCode || '').slice(0, 50_000),
        '```',
      ].join('\n');

      // Filename: existing rows wrote `<tcId>.spec.ts`. Place generated
      // specs under `tests/qaai/` so they don't collide with the team's
      // own suite. Operators can override via overrides.specPath.
      const specPath = overrides.specPath
        ? String(overrides.specPath).trim().slice(0, 200)
        : `tests/qaai/${pr.filename || `${pr.testCaseId || pr.id}.spec.ts`}`;

      const baseBranch = (project.defaultBranch || 'main').trim();

      let pushed;
      try {
        pushed = await github.pushSpec({
          token,
          repoUrl: project.repoUrl,
          branchName,
          baseBranch,
          specPath,
          specContent: pr.specCode || '',
          commitMessage,
          prTitle,
          prBody,
        });
      } catch (err) {
        // Record failure on the PR row so the UI can surface it without
        // a re-push loop. providerStatus='error' is the signal the chip
        // uses for the red-tone treatment.
        await prisma.governancePR.update({
          where: { id: pr.id },
          data: {
            providerStatus: 'error',
            // Leave providerPrUrl null so the user can retry.
          },
        });
        return res.status(err.status || 502).json({
          success: false,
          code: err.code || 'GIT_API',
          message: err.message,
          providerBody: err.providerBody || null,
        });
      }

      const updated = await prisma.governancePR.update({
        where: { id: pr.id },
        data: {
          providerPrNumber: pushed.prNumber != null ? String(pushed.prNumber) : null,
          providerPrUrl: pushed.prUrl,
          providerStatus: 'open',
          providerBranch: pushed.branch,
          pushedAt: new Date(),
          pushedBy: req.user.email || null,
        },
      });

      await audit.log({
        userId: req.user.id,
        action: 'governance.push-to-git',
        target: pr.id,
        metadata: {
          branch: pushed.branch,
          prNumber: pushed.prNumber,
          prUrl: pushed.prUrl,
          alreadyExisted: pushed.alreadyExisted || false,
        },
        req,
      });

      res.json({ success: true, pr: inflate(updated), pushed });
    } catch (err) {
      next(err);
    }
  },
);

// GET /:id/push-preview — returns the strings the modal renders so the
// operator can see the branch / commit / PR title BEFORE confirming. No
// side effects, no external calls. Cheap, no rate limit.
router.get('/:id/push-preview', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!pr) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const providerName = project.gitProvider || 'github';
    const patMeta = await vault.meta(req.user.id, `${providerName}.pat`);
    const repoParsed = project.repoUrl ? github.parseRepoUrl(project.repoUrl) : null;

    const slug = (str) => String(str || '').toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

    const branchName = `qaai/${slug(pr.number || pr.id.slice(0, 8))}-${slug(pr.requirement || 'test')}`;
    const commitMessage = `QAAI ${pr.number}: ${pr.requirement || 'add generated test'}`;
    const prTitle = `[QAAI ${pr.number}] ${pr.requirement || pr.filename}`;
    const specPath = `tests/qaai/${pr.filename || `${pr.testCaseId || pr.id}.spec.ts`}`;

    res.json({
      success: true,
      ready: !!(project.repoUrl && patMeta && pr.status === 'approved' && pr.lintPassed && !pr.providerPrUrl),
      blockers: [
        !project.repoUrl ? 'No repo configured under Project Setup.' : null,
        !patMeta ? 'No GitHub PAT stored for this user.' : null,
        pr.status !== 'approved' ? 'PR is not approved.' : null,
        !pr.lintPassed ? 'Lint has not passed.' : null,
        pr.providerPrUrl ? 'PR was already pushed.' : null,
      ].filter(Boolean),
      preview: {
        provider: providerName,
        repo: repoParsed ? `${repoParsed.owner}/${repoParsed.repo}` : null,
        baseBranch: project.defaultBranch || 'main',
        branchName,
        commitMessage,
        prTitle,
        specPath,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
