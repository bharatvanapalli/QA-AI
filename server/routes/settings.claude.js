'use strict';

const express = require('express');
const prisma = require('../prisma');
const vault = require('../services/vault');
const audit = require('../services/audit');
const integrations = require('../services/integrations');
const { validateApiKey, DEFAULT_MODELS } = require('../services/claude');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
router.use(requireAuth);

const SECRET_NAME = 'claude.apiKey';
const INT_TYPE = 'claude';

// ── GET /api/settings/claude ───────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const [integration, meta] = await Promise.all([
      integrations.get(req.user.id, INT_TYPE),
      vault.meta(req.user.id, SECRET_NAME),
    ]);
    res.json({
      success: true,
      configured: !!meta,
      lastFour: meta?.lastFour || null,
      model: integration?.config?.model || 'claude-sonnet-4-6',
      status: integration?.status || 'unconfigured',
      lastValidatedAt: integration?.lastValidatedAt || null,
      lastError: integration?.lastError || null,
      modelsAvailable: integration?.config?.modelsAvailable || DEFAULT_MODELS,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/settings/claude/validate ─────────────────────
router.post(
  '/validate',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res, next) => {
    try {
      const { apiKey } = req.body || {};
      if (!apiKey || typeof apiKey !== 'string') {
        return res.status(400).json({
          success: false,
          valid: false,
          code: 'MISSING_KEY',
          message: 'apiKey is required',
        });
      }

      const result = await validateApiKey(apiKey.trim());

      await audit.log({
        userId: req.user.id,
        action: 'settings.claude.validate',
        metadata: { valid: result.valid, code: result.code || null },
        req,
      });

      if (!result.valid) {
        return res.status(400).json({ success: false, ...result });
      }
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/settings/claude/save ─────────────────────────
router.post('/save', requireCsrf, async (req, res, next) => {
  try {
    const { apiKey, model } = req.body || {};
    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(400).json({ success: false, code: 'MISSING_KEY', message: 'apiKey is required' });
    }
    const finalModel = typeof model === 'string' && model.startsWith('claude-')
      ? model
      : 'claude-sonnet-4-6';

    // Re-validate before saving (defense in depth — frontend may have skipped)
    const result = await validateApiKey(apiKey.trim());
    if (!result.valid) {
      return res.status(400).json({ success: false, ...result });
    }

    await vault.put(req.user.id, SECRET_NAME, apiKey.trim());
    const integration = await integrations.upsert(req.user.id, INT_TYPE, {
      config: { model: finalModel, modelsAvailable: result.modelsAvailable },
      status: 'valid',
      lastValidatedAt: new Date(),
    });

    await audit.log({
      userId: req.user.id,
      action: 'settings.claude.save',
      metadata: { model: finalModel },
      req,
    });

    const meta = await vault.meta(req.user.id, SECRET_NAME);
    res.json({
      success: true,
      configured: true,
      lastFour: meta.lastFour,
      model: integration.config.model,
      status: 'valid',
      lastValidatedAt: integration.lastValidatedAt,
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/settings/claude ────────────────────────────
router.delete('/', requireCsrf, async (req, res, next) => {
  try {
    await vault.remove(req.user.id, SECRET_NAME);
    await prisma.integration.deleteMany({
      where: { userId: req.user.id, type: INT_TYPE },
    });
    await audit.log({ userId: req.user.id, action: 'settings.claude.delete', req });
    res.json({ success: true, configured: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
