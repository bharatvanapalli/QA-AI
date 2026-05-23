'use strict';

const prisma = require('../prisma');
const { encodeJson } = require('./jsonField');

async function log({ userId, action, target, metadata, req }) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: userId || null,
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
