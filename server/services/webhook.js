'use strict';

const crypto = require('crypto');
const prisma = require('../prisma');
const vault = require('./vault');
const { decodeArray, encodeJson } = require('./jsonField');

const SECRET_PREFIX = 'whsec_';

function generateSecret() {
  return SECRET_PREFIX + crypto.randomBytes(32).toString('hex');
}

function sign(body, secret) {
  return (
    'sha256=' +
    crypto.createHmac('sha256', secret).update(body).digest('hex')
  );
}

function validateUrl(url) {
  if (!url) throw Object.assign(new Error('url required'), { code: 'INVALID_URL' });
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    throw Object.assign(new Error('Webhook URL is invalid'), { code: 'INVALID_URL' });
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw Object.assign(new Error('URL must be http or https'), { code: 'INVALID_URL' });
  }
  if (process.env.NODE_ENV === 'production' && u.protocol !== 'https:') {
    throw Object.assign(new Error('Production webhooks must use https'), { code: 'INVALID_URL' });
  }
  return u.toString();
}

/**
 * Send a signed POST to the target URL. Returns delivery result.
 */
async function deliver({ url, secret, event, payload, deliveryId, timeoutMs = 5000 }) {
  const body = JSON.stringify({ event, deliveryId, sentAt: new Date().toISOString(), data: payload });
  const signature = sign(body, secret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'QAAI-Webhook/1.0',
        'X-QAAI-Event': event,
        'X-QAAI-Delivery-Id': deliveryId,
        'X-QAAI-Signature': signature,
      },
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
    const latencyMs = Date.now() - start;
    const responseBody = await resp.text().catch(() => '').then((t) => t.slice(0, 500));
    return {
      ok: resp.ok,
      statusCode: resp.status,
      latencyMs,
      responseBody,
      error: resp.ok ? null : `HTTP ${resp.status}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    if (err.name === 'AbortError') {
      return { ok: false, statusCode: 0, latencyMs, responseBody: '', error: 'TIMEOUT' };
    }
    return { ok: false, statusCode: 0, latencyMs, responseBody: '', error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function validateEndpoint({ url, secret }) {
  try {
    validateUrl(url);
  } catch (e) {
    return { valid: false, code: e.code, message: e.message };
  }
  const deliveryId = 'wh_test_' + crypto.randomBytes(8).toString('hex');
  const result = await deliver({
    url,
    secret,
    event: 'ping',
    payload: { hello: 'qaai', purpose: 'endpoint validation' },
    deliveryId,
  });
  if (!result.ok) {
    if (result.error === 'TIMEOUT') {
      return { valid: false, code: 'TIMEOUT', message: 'Endpoint did not respond in 5s.' };
    }
    if (result.statusCode === 0) {
      return { valid: false, code: 'NETWORK', message: result.error || 'Network error.' };
    }
    return {
      valid: false,
      code: 'NON_2XX',
      message: `Endpoint returned HTTP ${result.statusCode}`,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
    };
  }
  return {
    valid: true,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
  };
}

/**
 * Send an event to all enabled webhooks for a user, with retry on failure.
 * Persists every attempt to WebhookDelivery for the deliveries panel.
 */
async function fanout({ userId, event, payload }) {
  // SQLite cannot filter inside a JSON-encoded array column, so we fetch all
  // enabled webhooks for the user and filter in memory. Cardinality is small.
  const allEnabled = await prisma.webhookConfig.findMany({
    where: { userId, enabled: true },
  });
  const webhooks = allEnabled.filter((w) => decodeArray(w.events).includes(event));
  if (!webhooks.length) return [];

  const results = [];
  for (const wh of webhooks) {
    const secret = await vault.get(userId, `webhook.secret.${wh.id}`);
    if (!secret) continue;

    let attempt = 0;
    const maxAttempts = 3;
    const deliveryId = 'wh_' + crypto.randomBytes(10).toString('hex');
    let lastResult = null;

    while (attempt < maxAttempts) {
      attempt++;
      lastResult = await deliver({ url: wh.url, secret, event, payload, deliveryId });
      if (lastResult.ok) break;
      // exponential backoff 1s, 2s
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }

    await prisma.webhookDelivery.create({
      data: {
        webhookId: wh.id,
        event,
        payload: encodeJson(payload),
        statusCode: lastResult.statusCode || null,
        responseBody: lastResult.responseBody || null,
        latencyMs: lastResult.latencyMs || null,
        attempts: attempt,
        succeeded: lastResult.ok,
        error: lastResult.error || null,
      },
    });

    results.push({ webhookId: wh.id, ...lastResult, attempts: attempt });
  }
  return results;
}

module.exports = { generateSecret, validateEndpoint, deliver, fanout, validateUrl, sign };
