'use strict';

/**
 * Lightweight in-memory rate limiter (per-user + per-route).
 * For production, replace with Redis-backed limiter.
 */

const buckets = new Map();

function rateLimit({ windowMs = 60_000, max = 30, keyFn } = {}) {
  return (req, res, next) => {
    const key = (keyFn ? keyFn(req) : req.user?.id || req.ip) + ':' + req.path;
    const now = Date.now();
    const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count++;
    buckets.set(key, bucket);
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        message: `Too many requests. Retry in ${retryAfter}s.`,
      });
    }
    next();
  };
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets.entries()) {
    if (now > b.resetAt + 60_000) buckets.delete(k);
  }
}, 60_000).unref();

module.exports = { rateLimit };
