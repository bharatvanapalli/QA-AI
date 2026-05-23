'use strict';

const express = require('express');
const prisma = require('../prisma');
const vault = require('../services/vault');
const audit = require('../services/audit');
const integrations = require('../services/integrations');
const jira = require('../services/jira');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
router.use(requireAuth);

const SECRET_NAME = 'jira.token';
const INT_TYPE = 'jira';

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
      url: integration?.config?.url || '',
      email: integration?.config?.email || '',
      projectKey: integration?.config?.projectKey || '',
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
      let { url, email, token } = req.body || {};
      if (!token) {
        token = await vault.get(req.user.id, SECRET_NAME);
      }
      const result = await jira.testConnection({ url, email, token });

      await audit.log({
        userId: req.user.id,
        action: 'settings.jira.test',
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
    const { url, email, token, projectKey } = req.body || {};
    if (!url || !email || !token || !projectKey) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_FIELDS',
        message: 'url, email, token and projectKey are required',
      });
    }
    const result = await jira.testConnection({ url, email, token });
    if (!result.valid) return res.status(400).json({ success: false, ...result });

    const projectExists = result.projects.some(
      (p) => p.key === projectKey || p.id === projectKey
    );
    if (!projectExists) {
      return res.status(400).json({
        success: false,
        code: 'PROJECT_NOT_FOUND',
        message: `Project key "${projectKey}" not found.`,
      });
    }

    await vault.put(req.user.id, SECRET_NAME, token);
    const integration = await integrations.upsert(req.user.id, INT_TYPE, {
      config: { url: result.url, email, projectKey },
      status: 'valid',
      lastValidatedAt: new Date(),
    });
    const meta = await vault.meta(req.user.id, SECRET_NAME);
    await audit.log({
      userId: req.user.id,
      action: 'settings.jira.save',
      metadata: { projectKey },
      req,
    });

    res.json({
      success: true,
      configured: true,
      lastFour: meta.lastFour,
      url: integration.config.url,
      email: integration.config.email,
      projectKey: integration.config.projectKey,
      status: 'valid',
      lastValidatedAt: integration.lastValidatedAt,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/projects', async (req, res, next) => {
  try {
    const token = await vault.get(req.user.id, SECRET_NAME);
    const integration = await integrations.get(req.user.id, INT_TYPE);
    if (!token || !integration?.config?.url || !integration?.config?.email) {
      return res
        .status(400)
        .json({ success: false, code: 'NOT_CONFIGURED', message: 'Jira not configured' });
    }
    const projects = await jira.listProjects({
      url: integration.config.url,
      email: integration.config.email,
      token,
    });
    res.json({ success: true, projects });
  } catch (err) {
    if (err.status === 401) {
      return res.status(401).json({ success: false, code: err.code, message: 'Token rejected' });
    }
    next(err);
  }
});

router.delete('/', requireCsrf, async (req, res, next) => {
  try {
    await vault.remove(req.user.id, SECRET_NAME);
    await prisma.integration.deleteMany({ where: { userId: req.user.id, type: INT_TYPE } });
    await audit.log({ userId: req.user.id, action: 'settings.jira.delete', req });
    res.json({ success: true, configured: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
