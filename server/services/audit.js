'use strict';

const prisma = require('../prisma');
const { encodeJson } = require('./jsonField');

// Phase E8 — orgId is resolved from `req.org?.id` when the caller doesn't
// supply one explicitly. Routes that run before requireOrg (signup, login)
// pass orgId directly; routes mounted behind requireOrg pick it up via req.
async function log({ userId, orgId, action, target, metadata, req }) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: userId || null,
        orgId: orgId || req?.org?.id || null,
        action,
        target: target || null,
        metadata: encodeJson(metadata),
        ipAddress: req?.ip || req?.headers?.['x-forwarded-for']?.split(',')[0] || null,
        userAgent: req?.headers?.['user-agent'] || null,
      },
    });
  } catch (err) {
    console.error('[audit] failed to log', action, err.message);
  }
}

module.exports = { log };
