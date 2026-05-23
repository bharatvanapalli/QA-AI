'use strict';

const express = require('express');
const prisma = require('../prisma');
const vault = require('../services/vault');
const audit = require('../services/audit');
const webhook = require('../services/webhook');
const { encodeArray, decodeArray, encodeJson, decodeJson } = require('../services/jsonField');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
router.use(requireAuth);

const SUPPORTED_EVENTS = [
  'run.started',
  'run.completed',
  'run.failed',
  'pr.opened',
  'pr.merged',
  'locator.blocked',
  'governance.pr_ready',
];

router.get('/events', (req, res) => {
  res.json({ success: true, events: SUPPORTED_EVENTS });
});

router.get('/', async (req, res, next) => {
  try {
    const configs = await prisma.webhookConfig.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      success: true,
      webhooks: configs.map((c) => ({
        id: c.id,
        url: c.url,
        events: decodeArray(c.events),
        enabled: c.enabled,
        lastFourSecret: c.lastFourSecret,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/generate-secret', requireCsrf, async (req, res) => {
  // Generated only — saved later when the webhook is saved.
  const secret = webhook.generateSecret();
  res.json({
    success: true,
    secret, // Returned ONCE. Subsequent reads will only show lastFour.
    generatedAt: new Date().toISOString(),
  });
});

router.post(
  '/validate',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 15 }),
  async (req, res, next) => {
    try {
      const { url, secret } = req.body || {};
      if (!url || !secret) {
        return res.status(400).json({
          success: false,
          valid: false,
          code: 'MISSING_FIELDS',
          message: 'url and secret are required',
        });
      }
      const result = await webhook.validateEndpoint({ url, secret });
      await audit.log({
        userId: req.user.id,
        action: 'settings.webhook.validate',
        metadata: { valid: result.valid, code: result.code || null, url },
        req,
      });
      if (!result.valid) return res.status(400).json({ success: false, ...result });
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const { url, events, secret } = req.body || {};
    if (!url || !secret) {
      return res
        .status(400)
        .json({ success: false, code: 'MISSING_FIELDS', message: 'url and secret are required' });
    }
    try {
      webhook.validateUrl(url);
    } catch (e) {
      return res.status(400).json({ success: false, code: e.code, message: e.message });
    }
    const evs = Array.isArray(events) ? events.filter((e) => SUPPORTED_EVENTS.includes(e)) : [];
    if (!evs.length) {
      return res
        .status(400)
        .json({ success: false, code: 'NO_EVENTS', message: 'At least one event is required' });
    }

    // Validate live before saving
    const v = await webhook.validateEndpoint({ url, secret });
    if (!v.valid) {
      return res.status(400).json({ success: false, ...v });
    }

    const lastFour = secret.slice(-4);
    const created = await prisma.webhookConfig.create({
      data: {
        userId: req.user.id,
        url,
        events: encodeArray(evs),
        enabled: true,
        lastFourSecret: lastFour,
      },
    });
    await vault.put(req.user.id, `webhook.secret.${created.id}`, secret);
    await audit.log({
      userId: req.user.id,
      action: 'settings.webhook.create',
      target: created.id,
      metadata: { url, events: evs },
      req,
    });
    res.status(201).json({
      success: true,
      webhook: {
        id: created.id,
        url: created.url,
        events: decodeArray(created.events),
        enabled: created.enabled,
        lastFourSecret: created.lastFourSecret,
        createdAt: created.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireCsrf, async (req, res, next) => {
  try {
    const { url, events, enabled } = req.body || {};
    const existing = await prisma.webhookConfig.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing)
      return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const updated = await prisma.webhookConfig.update({
      where: { id: existing.id },
      data: {
        url: typeof url === 'string' ? url : existing.url,
        events: Array.isArray(events)
          ? encodeArray(events.filter((e) => SUPPORTED_EVENTS.includes(e)))
          : existing.events,
        enabled: typeof enabled === 'boolean' ? enabled : existing.enabled,
      },
    });
    await audit.log({
      userId: req.user.id,
      action: 'settings.webhook.update',
      target: updated.id,
      req,
    });
    res.json({
      success: true,
      webhook: { ...updated, events: decodeArray(updated.events) },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/rotate-secret', requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.webhookConfig.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const newSecret = webhook.generateSecret();
    await vault.put(req.user.id, `webhook.secret.${existing.id}`, newSecret);
    await prisma.webhookConfig.update({
      where: { id: existing.id },
      data: { lastFourSecret: newSecret.slice(-4) },
    });
    await audit.log({
      userId: req.user.id,
      action: 'settings.webhook.rotate',
      target: existing.id,
      req,
    });
    res.json({ success: true, secret: newSecret });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/test', requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.webhookConfig.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const secret = await vault.get(req.user.id, `webhook.secret.${existing.id}`);
    if (!secret)
      return res
        .status(400)
        .json({ success: false, code: 'NO_SECRET', message: 'Secret missing — regenerate.' });

    const result = await webhook.deliver({
      url: existing.url,
      secret,
      event: 'test',
      payload: { hello: 'this is a test from QAAI' },
      deliveryId: 'wh_test_' + Date.now(),
    });
    await prisma.webhookDelivery.create({
      data: {
        webhookId: existing.id,
        event: 'test',
        payload: encodeJson({ manual: true }),
        statusCode: result.statusCode || null,
        responseBody: result.responseBody,
        latencyMs: result.latencyMs,
        attempts: 1,
        succeeded: result.ok,
        error: result.error,
      },
    });
    res.json({ success: result.ok, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/deliveries', async (req, res, next) => {
  try {
    const existing = await prisma.webhookConfig.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { webhookId: existing.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({
      success: true,
      deliveries: deliveries.map((d) => ({ ...d, payload: decodeJson(d.payload, {}) })),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCsrf, async (req, res, next) => {
  try {
    const existing = await prisma.webhookConfig.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await vault.remove(req.user.id, `webhook.secret.${existing.id}`);
    await prisma.webhookConfig.delete({ where: { id: existing.id } });
    await audit.log({
      userId: req.user.id,
      action: 'settings.webhook.delete',
      target: existing.id,
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
