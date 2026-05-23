'use strict';

/**
 * Thin wrapper over the Integration table.
 * Hides the JSON-encoded `config` column so callers see a plain object.
 * On Postgres, the column type is native Json and this file is mostly a no-op.
 */

const prisma = require('../prisma');
const { encodeJson, decodeJson } = require('./jsonField');

function inflate(row) {
  if (!row) return row;
  return { ...row, config: decodeJson(row.config, {}) || {} };
}

async function get(userId, type) {
  const row = await prisma.integration.findUnique({
    where: { userId_type: { userId, type } },
  });
  return inflate(row);
}

async function upsert(userId, type, { config, status, lastValidatedAt, lastError }) {
  const data = {
    config: encodeJson(config || {}),
    status: status || 'valid',
    lastValidatedAt: lastValidatedAt || new Date(),
    lastError: lastError || null,
  };
  const row = await prisma.integration.upsert({
    where: { userId_type: { userId, type } },
    create: { userId, type, ...data },
    update: data,
  });
  return inflate(row);
}

async function remove(userId, type) {
  await prisma.integration.deleteMany({ where: { userId, type } });
}

module.exports = { get, upsert, remove, inflate };
