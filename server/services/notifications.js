'use strict';

const nodemailer = require('nodemailer');
const prisma = require('../prisma');

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: Number(process.env.SMTP_PORT || 1025),
    secure: false,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    pool: true,
    maxConnections: 3,
  });
  return _transporter;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/;

function validateTarget(type, target) {
  if (!target || typeof target !== 'string') {
    return { ok: false, code: 'MISSING_TARGET', message: 'target required' };
  }
  if (type === 'email') {
    if (!EMAIL_RE.test(target))
      return { ok: false, code: 'INVALID_EMAIL', message: 'target is not a valid email' };
    return { ok: true };
  }
  if (type === 'slack') {
    if (!/^https:\/\/hooks\.slack\.com\//.test(target))
      return {
        ok: false,
        code: 'INVALID_SLACK_URL',
        message: 'Slack target must be a hooks.slack.com URL',
      };
    return { ok: true };
  }
  if (type === 'webhook') {
    if (!URL_RE.test(target))
      return { ok: false, code: 'INVALID_URL', message: 'webhook target must be http(s)' };
    return { ok: true };
  }
  return { ok: false, code: 'UNSUPPORTED_TYPE', message: 'type must be email|slack|webhook' };
}

async function deliverEmail({ to, subject, text, html }) {
  const t = getTransporter();
  const start = Date.now();
  const info = await t.sendMail({
    from: process.env.SMTP_FROM || 'QAAI <no-reply@qaai.local>',
    to,
    subject,
    text,
    html,
  });
  return { ok: true, latencyMs: Date.now() - start, messageId: info.messageId };
}

async function deliverSlack({ url, text, blocks }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks }),
      signal: controller.signal,
    });
    return {
      ok: resp.ok,
      statusCode: resp.status,
      latencyMs: Date.now() - start,
      error: resp.ok ? null : `HTTP ${resp.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err.name === 'AbortError' ? 'TIMEOUT' : err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverWebhook({ url, event, payload }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, sentAt: new Date().toISOString(), data: payload }),
      signal: controller.signal,
    });
    return {
      ok: resp.ok,
      statusCode: resp.status,
      latencyMs: Date.now() - start,
      error: resp.ok ? null : `HTTP ${resp.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err.name === 'AbortError' ? 'TIMEOUT' : err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTo(channel, { event = 'test', subject, text, payload }) {
  try {
    if (channel.type === 'email') {
      return await deliverEmail({
        to: channel.target,
        subject: subject || `[QAAI] ${event}`,
        text: text || `Test notification from QAAI — event: ${event}`,
        html: `<p>${text || `Test notification from QAAI — event: <code>${event}</code>`}</p>`,
      });
    }
    if (channel.type === 'slack') {
      return await deliverSlack({
        url: channel.target,
        text: text || `*QAAI* — event \`${event}\``,
      });
    }
    if (channel.type === 'webhook') {
      return await deliverWebhook({
        url: channel.target,
        event,
        payload: payload || { test: true },
      });
    }
    return { ok: false, error: 'UNSUPPORTED_TYPE' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Dispatch a real event to all channels routed for it.
 */
async function dispatch(userId, event, payload) {
  const routes = await prisma.notificationRoute.findMany({
    where: { event, channel: { userId } },
    include: { channel: true },
  });
  if (!routes.length) return [];

  const results = [];
  for (const r of routes) {
    const ch = r.channel;
    if (!ch.verified) continue;
    const result = await sendTo(ch, { event, payload });
    await prisma.notificationChannel.update({
      where: { id: ch.id },
      data: { lastTestAt: new Date(), lastTestSuccess: result.ok },
    });
    results.push({ channelId: ch.id, ...result });
  }
  return results;
}

module.exports = { sendTo, validateTarget, dispatch };
