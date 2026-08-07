'use strict';

/**
 * Reporter — root-cause analysis + ticket creation for a Run.
 *
 * Endpoints:
 *   POST /api/runs/:runId/analyze           Run Reporter agent on all failed RunResults, persist analyses.
 *   POST /api/runs/:runId/results/:resultId/ticket   Create a real Jira/ADO ticket for one failure.
 */

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const reporter = require('../services/agents/reporter');
const rcaChat = require('../services/agents/rcaChat');
const postMortem = require('../services/agents/postMortem');
const failurePatterns = require('../services/failurePatterns');
const issueCreator = require('../services/issueCreator');
const { decodeJson, encodeJson } = require('../services/jsonField');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
router.use(requireAuth);
router.use(requireOrg);

// Phase E8 — Run rows don't have their own orgId; they're scoped via the
// parent Project. Any org member who can see the project can act on its
// runs (matches the "Push to Git" / "Approve PR" pattern from E7).
async function ownRun(req) {
  return prisma.run.findFirst({
    where: { id: req.params.runId, project: { orgId: req.org.id } },
  });
}

// ── POST /api/runs/:runId/analyze ─────────────────────────
router.post(
  '/:runId/analyze',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 5 }),
  async (req, res, next) => {
    try {
      const run = await ownRun(req);
      if (!run) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      // Load project FIRST so resolveAiCredentials can read `aiProvider`.
      // Without this, the route would always default to Claude even when the
      // project is configured for Gemini.
      const projectRow = await prisma.project.findUnique({
        where: { id: run.projectId },
        select: { id: true, aiProvider: true, aiGuidance: true },
      });
      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, projectRow);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }

      // Load failures (status fail | blocked) that haven't been analyzed yet,
      // OR re-analyze all if ?force=1
      const force = req.query.force === '1';
      const where = {
        runId: run.id,
        status: { in: ['fail', 'blocked'] },
        ...(force ? {} : { rcaWhat: null }),
      };
      const failures = await prisma.runResult.findMany({
        where,
        include: { testCase: { select: { id: true, name: true, module: true, type: true } } },
      });

      if (!failures.length) {
        return res.json({ success: true, analyzed: 0, message: 'No failures to analyze.' });
      }

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, msg);

      const preparedFailures = failures.map((f) => ({
        id: f.id,
        testCase: f.testCase,
        status: f.status,
        error: f.error,
        trace: f.trace,
        networkLog: decodeJson(f.networkLog, []),
      }));

      let result;
      try {
        result = await reporter.run({
          apiKey,
          model,
          provider,
          failures: preparedFailures,
          onLog: async (level, message) =>
            send({ type: 'agent.phase.log', phase: 'reporter', level, message }),
          onRateLimit: (info) => send({ type: 'claude.rate-limit', ...info }),
          extraGuidance: projectRow?.aiGuidance || null,
        });
      } catch (err) {
        return res.status(err.status || 502).json({
          success: false, code: err.code || 'REPORTER_FAILED', message: err.message,
        });
      }

      // Persist analyses
      const idToAnalysis = new Map(result.analyses.map((a) => [a.id, a]));
      let updated = 0;
      for (const f of failures) {
        const a = idToAnalysis.get(f.id);
        if (!a) continue;
        await prisma.runResult.update({
          where: { id: f.id },
          data: {
            rcaWhat: a.what,
            rcaWhy: a.why,
            rcaFix: a.fix,
            rcaClass: a.classification,
            rcaConfidence: a.confidence,
          },
        });
        updated++;
      }

      // Phase G — Cross-run learning. Now that the Reporter has produced
      // per-failure RCA, hand the freshly-classified failures to the
      // postMortem agent which extracts REUSABLE patterns and upserts them
      // into the project's FailurePattern store. The next conductor run
      // for this project will read those patterns out of the store and
      // inject them into its system prompt — so traps caught here don't
      // catch the agent again. Best-effort: failure here never fails the
      // analyze endpoint, since the RCAs are already persisted.
      let patternStats = { created: 0, updated: 0 };
      try {
        const enriched = failures.map((f) => {
          const a = idToAnalysis.get(f.id) || {};
          return {
            id: f.id,
            testCaseName: f.testCase?.name || null,
            status: f.status,
            error: f.error,
            trace: f.trace,
            rcaWhat: a.what || null,
            rcaWhy: a.why || null,
            rcaFix: a.fix || null,
            rcaClass: a.classification || null,
          };
        }).filter((f) => f.rcaWhat); // only classify ones the Reporter spoke to

        if (enriched.length) {
          const existing = await failurePatterns.loadProjectPatterns(run.projectId, { limit: 40 });
          const pm = await postMortem.run({
            apiKey, model, provider,
            failures: enriched,
            existingPatterns: existing,
            onLog: async (level, message) =>
              send({ type: 'agent.phase.log', phase: 'post-mortem', level, message }),
            onRateLimit: (info) => send({ type: 'claude.rate-limit', ...info }),
            extraGuidance: projectRow?.aiGuidance || null,
          });
          patternStats = await failurePatterns.upsertPatterns(run.projectId, pm.patterns || []);
          send({
            type: 'agent.phase.log', phase: 'post-mortem', level: 'info',
            message: `Patterns: ${patternStats.created} new, ${patternStats.updated} reinforced. Next run on this project will see them in the conductor prompt.`,
          });
        }
      } catch (pmErr) {
        send({
          type: 'agent.phase.log', phase: 'post-mortem', level: 'warn',
          message: `Post-mortem skipped: ${pmErr.message}`,
        });
      }

      await audit.log({
        userId: req.user.id,
        action: 'reporter.analyze',
        target: run.id,
        metadata: { analyzed: updated, total: failures.length, patternsCreated: patternStats.created, patternsUpdated: patternStats.updated },
        req,
      });

      res.json({
        success: true,
        analyzed: updated,
        total: failures.length,
        analyses: result.analyses,
        patterns: patternStats,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/runs/:runId/results/:resultId/ticket ────────
router.post(
  '/:runId/results/:resultId/ticket',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 20 }),
  async (req, res, next) => {
    try {
      const run = await ownRun(req);
      if (!run) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const result = await prisma.runResult.findFirst({
        where: { id: req.params.resultId, runId: run.id },
        include: { testCase: true },
      });
      if (!result) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const { target } = req.body || {};
      if (!['jira', 'ado'].includes(target)) {
        return res.status(400).json({ success: false, code: 'INVALID_TARGET', message: 'target must be "jira" or "ado".' });
      }

      if (result.ticketId) {
        return res.status(409).json({
          success: false, code: 'ALREADY_FILED',
          message: `Ticket ${result.ticketId} already created.`,
          ticketId: result.ticketId, ticketUrl: result.ticketUrl,
        });
      }

      const summary = `[QAAI] ${result.testCase?.name || 'Test failure'} — ${(result.rcaWhat || result.error || 'failed').slice(0, 120)}`;
      const description = [
        '*Auto-filed by QAAI Reporter*',
        '',
        `**Test:** ${result.testCase?.name || result.testCaseId}`,
        `**Module:** ${result.testCase?.module || '—'}`,
        `**Status:** ${result.status}`,
        `**Run:** ${run.sprintName} (${run.id})`,
        '',
        '**What:**',
        result.rcaWhat || '(no analysis yet — run /analyze first)',
        '',
        '**Why:**',
        result.rcaWhy || '—',
        '',
        '**Suggested Fix:**',
        result.rcaFix || '—',
        '',
        `**Confidence:** ${result.rcaConfidence ?? '—'}%`,
        `**Classification:** ${result.rcaClass || '—'}`,
        '',
        '**Error:**',
        '```',
        (result.error || '').slice(0, 2000),
        '```',
      ].join('\n');

      const out = await issueCreator.create({
        userId: req.user.id,
        target,
        summary,
        description,
      });
      if (!out.ok) {
        return res.status(400).json({ success: false, ...out });
      }

      await prisma.runResult.update({
        where: { id: result.id },
        data: { ticketId: out.id, ticketUrl: out.url },
      });

      await audit.log({
        userId: req.user.id,
        action: 'reporter.ticket',
        target: result.id,
        metadata: { target, ticketId: out.id },
        req,
      });

      res.json({ success: true, ticketId: out.id, ticketUrl: out.url });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/runs/:runId/results/:resultId/chat ──────────
// Conversational follow-up on a specific failure. Adds the user message to
// the persisted chatHistory on the RunResult, calls Claude with the failure
// context + history + new message, persists the assistant reply, and
// returns the updated history. Rate-limited to 20/min so a stuck client
// loop can't drain the user's token quota.
router.post(
  '/:runId/results/:resultId/chat',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 20 }),
  async (req, res, next) => {
    try {
      const run = await ownRun(req);
      if (!run) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const result = await prisma.runResult.findFirst({
        where: { id: req.params.resultId, runId: run.id },
        include: { testCase: true },
      });
      if (!result) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const { message } = req.body || {};
      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ success: false, code: 'EMPTY_MESSAGE', message: 'Message is required.' });
      }
      if (message.length > 4000) {
        return res.status(400).json({ success: false, code: 'MESSAGE_TOO_LONG', message: 'Limit messages to 4,000 characters.' });
      }

      // Load project FIRST so resolveAiCredentials can read `aiProvider`.
      const project = await prisma.project.findUnique({
        where: { id: run.projectId },
        select: { id: true, aiProvider: true, aiGuidance: true },
      });
      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }
      const tcGuidance = result.testCase?.userGuidance || null;

      const history = decodeJson(result.chatHistory, []);
      const networkLog = decodeJson(result.networkLog, []);

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, msg);

      // Phase G — Surface project-history pattern matches in the chat
      // primer so user questions like "why did this fail" get answered
      // against THIS project's accumulated learnings, not generic advice.
      // Best-effort: an empty/failed match just means the user gets the
      // original primer back, never a 500.
      let learnedPatterns = [];
      try {
        learnedPatterns = await failurePatterns.matchPatternsForResult(run.projectId, {
          error: result.error,
          rcaWhy: result.rcaWhy,
          rcaFix: result.rcaFix,
          rcaClass: result.rcaClass,
        });
      } catch (_) {
        learnedPatterns = [];
      }

      let reply;
      try {
        const out = await rcaChat.chat({
          apiKey,
          model,
          provider,
          context: {
            testCase: result.testCase,
            result: {
              status: result.status,
              durationMs: result.durationMs,
              error: result.error,
              trace: result.trace,
              networkLog,
              rcaWhat: result.rcaWhat,
              rcaWhy: result.rcaWhy,
              rcaFix: result.rcaFix,
              rcaClass: result.rcaClass,
              rcaConfidence: result.rcaConfidence,
            },
            learnedPatterns,
          },
          history,
          userMessage: message,
          projectGuidance: project?.aiGuidance || null,
          caseGuidance: tcGuidance,
          onRateLimit: (info) => send({ type: 'claude.rate-limit', ...info }),
        });
        reply = out.reply;
      } catch (err) {
        return res.status(err.status || 502).json({
          success: false, code: err.code || 'CHAT_FAILED', message: err.message,
        });
      }

      const nowIso = new Date().toISOString();
      const nextHistory = [
        ...history,
        { role: 'user', content: message.trim(), ts: nowIso },
        { role: 'assistant', content: reply, ts: new Date().toISOString() },
      ];
      // Cap at 40 turns (20 round-trips) so a long thread doesn't blow the
      // model context. Older turns drop off the front — the primer always
      // re-injects the failure context per request so the agent never loses
      // the core facts.
      const trimmed = nextHistory.length > 40
        ? nextHistory.slice(nextHistory.length - 40)
        : nextHistory;

      await prisma.runResult.update({
        where: { id: result.id },
        data: { chatHistory: encodeJson(trimmed) },
      });

      await audit.log({
        userId: req.user.id,
        action: 'reporter.chat',
        target: result.id,
        metadata: { messageChars: message.length, replyChars: reply.length, historyLen: trimmed.length },
        req,
      });

      res.json({ success: true, reply, history: trimmed });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
