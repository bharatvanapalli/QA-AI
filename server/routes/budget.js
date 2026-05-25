'use strict';

/**
 * Per-user daily budget routes (Phase E10.3).
 *
 *   GET  /api/budget/status  → today's usage + limit + reset time
 *   PUT  /api/budget/limit   → operator updates their own ceiling
 *   GET  /api/budget/breaker → circuit-breaker state per provider
 *
 * Note: no org-scoping middleware on this router. Budget is per USER,
 * not per ORG, because BYOK API keys are per-user — a heavy day on
 * org A's project still bills the individual user's Anthropic account.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const budget = require('../services/budget');
const breaker = require('../lib/circuitBreaker');

const router = express.Router();
router.use(requireAuth);

router.get('/status', async (req, res, next) => {
  try {
    const status = await budget.getStatus(req.user.id);
    res.json({ success: true, ...status });
  } catch (err) {
    next(err);
  }
});

router.put('/limit', requireCsrf, async (req, res, next) => {
  try {
    const { dailyTokenLimit } = req.body || {};
    if (dailyTokenLimit != null && typeof dailyTokenLimit !== 'number') {
      return res.status(400).json({ success: false, code: 'BAD_REQUEST', message: 'dailyTokenLimit must be a number or null.' });
    }
    const value = dailyTokenLimit === null ? null : Math.max(0, Math.floor(Number(dailyTokenLimit)));
    const prisma = require('../prisma');
    await prisma.user.update({
      where: { id: req.user.id },
      data: { dailyTokenLimit: value },
    });
    const status = await budget.getStatus(req.user.id);
    res.json({ success: true, ...status });
  } catch (err) {
    next(err);
  }
});

router.get('/breaker', async (req, res) => {
  res.json({ success: true, providers: breaker.getAllStates() });
});

module.exports = router;
