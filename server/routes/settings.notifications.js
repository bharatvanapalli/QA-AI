'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const notif = require('../services/notifications');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
router.use(requireAuth);

const SUPPORTED_EVENTS = [
  'run.started',
  'run.completed',
  'run.failed',
  'locator.blocked',
  'governance.pr_ready',
  'deduplication.ready',
  'entropy.exceeded',
  'kb.stale',
];

router.get('/events', (req, res) => {
  res.json({ success: true, events: SUPPORTED_EVENTS });
});

router.get('/', async (req, res, next) => {
  try {
    const channels = await prisma.notificationChannel.findMany({
      where: { userId: req.user.id },
      include: { routes: true },
      orderBy: { createdAt: 'desc' },
    });

    const routing = {};
    for (const ch of channels) {
      for (const r of ch.routes) {
        if (!routing[r.event]) routing[r.event] = [];
        routing[r.event].push(ch.id);
      }
    }

    res.json({
      success: true,
      channels: channels.map((c) => ({
        id: c.id,
        type: c.type,
        target: c.target,
        verified: c.verified,
        lastTestAt: c.lastTestAt,
        lastTestSuccess: c.lastTestSuccess,
      })),
      routing,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/channels', requireCsrf, async (req, res, next) => {
  try {
    const { type, target } = req.body || {};
    const validation = notif.validateTarget(type, target);
    if (!validation.ok)
      return res.status(400).json({ success: false, ...validation });

    const existing = await prisma.notificationChannel.findFirst({
      where: { userId: req.user.id, type, target },
    });
    if (existing)
      return res.status(409).json({
        success: false,
        code: 'CHANNEL_EXISTS',
        message: 'This channel is already configured.',
      });

    const created = await prisma.notificationChannel.create({
      data: { userId: req.user.id, type, target, verified: false },
    });
    await audit.log({
      userId: req.user.id,
      action: 'settings.notifications.channel.create',
      target: created.id,
      metadata: { type, target },
      req,
    });
    res.status(201).json({
      success: true,
      channel: {
        id: created.id,
        type: created.type,
        target: created.target,
        verified: created.verified,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/channels/:id/test',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res, next) => {
    try {
      const ch = await prisma.notificationChannel.findFirst({
        where: { id: req.params.id, userId: req.user.id },
      });
      if (!ch) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const result = await notif.sendTo(ch, {
        event: 'test',
        subject: '[QAAI] Test notification',
        text: 'This is a test message from QAAI. If you can read this, delivery works.',
      });
      await prisma.notificationChannel.update({
        where: { id: ch.id },
        data: {
          verified: result.ok ? true : ch.verified,
          lastTestAt: new Date(),
          lastTestSuccess: result.ok,
        },
      });
      await audit.log({
        userId: req.user.id,
        action: 'settings.notifications.channel.test',
        target: ch.id,
        metadata: { ok: result.ok, error: result.error || null },
        req,
      });
      if (!result.ok)
        return res.status(400).json({
          success: false,
          delivered: false,
          code: result.error === 'TIMEOUT' ? 'TIMEOUT' : 'DELIVERY_FAILED',
          message: result.error || 'Delivery failed',
          latencyMs: result.latencyMs,
        });
      res.json({ success: true, delivered: true, latencyMs: result.latencyMs });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/channels/:id', requireCsrf, async (req, res, next) => {
  try {
    const ch = await prisma.notificationChannel.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!ch) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await prisma.notificationChannel.delete({ where: { id: ch.id } });
    await audit.log({
      userId: req.user.id,
      action: 'settings.notifications.channel.delete',
      target: ch.id,
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.put('/routing', requireCsrf, async (req, res, next) => {
  try {
    const { routing } = req.body || {};
    if (!routing || typeof routing !== 'object')
      return res.status(400).json({ success: false, code: 'INVALID_ROUTING' });

    // Validate channels belong to user
    const allChannelIds = new Set();
    for (const ev of Object.keys(routing)) {
      if (!SUPPORTED_EVENTS.includes(ev)) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_EVENT',
          message: `Unsupported event: ${ev}`,
        });
      }
      const list = Array.isArray(routing[ev]) ? routing[ev] : [];
      for (const cid of list) allChannelIds.add(cid);
    }
    if (allChannelIds.size) {
      const ownedCount = await prisma.notificationChannel.count({
        where: { id: { in: [...allChannelIds] }, userId: req.user.id },
      });
      if (ownedCount !== allChannelIds.size)
        return res
          .status(400)
          .json({ success: false, code: 'INVALID_CHANNEL', message: 'Channel not owned by user' });
    }

    await prisma.$transaction(async (tx) => {
      // Wipe existing routes for this user's channels
      await tx.notificationRoute.deleteMany({
        where: { channel: { userId: req.user.id } },
      });
      // Recreate
      const rows = [];
      for (const ev of Object.keys(routing)) {
        for (const cid of routing[ev]) rows.push({ channelId: cid, event: ev });
      }
      if (rows.length) await tx.notificationRoute.createMany({ data: rows });
    });

    await audit.log({
      userId: req.user.id,
      action: 'settings.notifications.routing.update',
      metadata: { eventCount: Object.keys(routing).length },
      req,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
