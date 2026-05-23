'use strict';

const express = require('express');
const prisma = require('../prisma');
const vault = require('../services/vault');
const audit = require('../services/audit');
const integrations = require('../services/integrations');
const ado = require('../services/ado');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
router.use(requireAuth);

const SECRET_NAME = 'ado.pat';
const INT_TYPE = 'ado';

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
      orgUrl: integration?.config?.orgUrl || '',
      projectName: integration?.config?.projectName || '',
      status: integration?.status || 'unconfigured',
      lastValidatedAt: integration?.lastValidatedAt || null,
      lastError: integration?.lastError || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/test-connection',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 15 }),
  async (req, res, next) => {
    try {
      let { orgUrl, pat } = req.body || {};
      if (!orgUrl) {
        return res
          .status(400)
          .json({ success: false, valid: false, code: 'MISSING_URL', message: 'orgUrl required' });
      }
      // If PAT not provided, try stored PAT
      if (!pat) {
        pat = await vault.get(req.user.id, SECRET_NAME);
        if (!pat) {
          return res
            .status(400)
            .json({ success: false, valid: false, code: 'MISSING_PAT', message: 'PAT required' });
        }
      }
      const result = await ado.testConnection({ orgUrl, pat });

      await audit.log({
        userId: req.user.id,
        action: 'settings.ado.test',
        metadata: { valid: result.valid, code: result.code || null },
        req,
      });

      if (!result.valid) return res.status(400).json({ success: false, ...result });
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/save', requireCsrf, async (req, res, next) => {
  try {
    const { orgUrl, pat, projectName } = req.body || {};
    if (!orgUrl || !pat || !projectName) {
      return res
        .status(400)
        .json({ success: false, code: 'MISSING_FIELDS', message: 'orgUrl, pat and projectName are required' });
    }

    const result = await ado.testConnection({ orgUrl, pat });
    if (!result.valid) return res.status(400).json({ success: false, ...result });

    const projectExists = result.projects.some(
      (p) => p.name === projectName || p.id === projectName
    );
    if (!projectExists) {
      return res.status(400).json({
        success: false,
        code: 'PROJECT_NOT_FOUND',
        message: `Project "${projectName}" not in org.`,
      });
    }

    await vault.put(req.user.id, SECRET_NAME, pat);
    const integration = await integrations.upsert(req.user.id, INT_TYPE, {
      config: { orgUrl: result.orgUrl, projectName },
      status: 'valid',
      lastValidatedAt: new Date(),
    });
    const meta = await vault.meta(req.user.id, SECRET_NAME);
    await audit.log({ userId: req.user.id, action: 'settings.ado.save', metadata: { projectName }, req });

    res.json({
      success: true,
      configured: true,
      lastFour: meta.lastFour,
      orgUrl: integration.config.orgUrl,
      projectName: integration.config.projectName,
      status: 'valid',
      lastValidatedAt: integration.lastValidatedAt,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/projects', async (req, res, next) => {
  try {
    const pat = await vault.get(req.user.id, SECRET_NAME);
    const integration = await integrations.get(req.user.id, INT_TYPE);
    if (!pat || !integration?.config?.orgUrl) {
      return res
        .status(400)
        .json({ success: false, code: 'NOT_CONFIGURED', message: 'ADO not configured' });
    }
    const projects = await ado.listProjects({ orgUrl: integration.config.orgUrl, pat });
    res.json({ success: true, projects });
  } catch (err) {
    if (err.status === 401) {
      return res.status(401).json({ success: false, code: err.code, message: 'PAT rejected' });
    }
    next(err);
  }
});

router.delete('/', requireCsrf, async (req, res, next) => {
  try {
    await vault.remove(req.user.id, SECRET_NAME);
    await prisma.integration.deleteMany({ where: { userId: req.user.id, type: INT_TYPE } });
    await audit.log({ userId: req.user.id, action: 'settings.ado.delete', req });
    res.json({ success: true, configured: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
