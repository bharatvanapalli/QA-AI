'use strict';

/**
 * Vault service — AES-256-GCM encryption keyed by VAULT_MASTER_KEY.
 * Secrets are persisted in the Prisma `Secret` table.
 *
 * Plaintext NEVER leaves the backend. The frontend only receives `lastFour`.
 */

const crypto = require('crypto');
const prisma = require('../prisma');

const MASTER = process.env.VAULT_MASTER_KEY;
if (!MASTER || MASTER.length < 16) {
  throw new Error(
    '[vault] VAULT_MASTER_KEY must be set and at least 16 chars. Edit .env.'
  );
}

const KEY = crypto.scryptSync(MASTER, 'qaai-vault-salt-v2', 32);

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ct.toString('hex'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

function decrypt({ ciphertext, iv, authTag }) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    KEY,
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}

function lastFour(plaintext) {
  if (!plaintext) return null;
  const s = String(plaintext);
  return s.length <= 4 ? '*'.repeat(s.length) : s.slice(-4);
}

async function put(userId, name, plaintext) {
  const enc = encrypt(plaintext);
  const lf = lastFour(plaintext);
  return prisma.secret.upsert({
    where: { userId_name: { userId, name } },
    update: { ...enc, lastFour: lf },
    create: { userId, name, ...enc, lastFour: lf },
  });
}

async function get(userId, name) {
  const row = await prisma.secret.findUnique({
    where: { userId_name: { userId, name } },
  });
  if (!row) return null;
  try {
    return decrypt(row);
  } catch (err) {
    console.error('[vault] decrypt failed for', name, err.message);
    return null;
  }
}

async function meta(userId, name) {
  const row = await prisma.secret.findUnique({
    where: { userId_name: { userId, name } },
    select: { lastFour: true, updatedAt: true },
  });
  return row;
}

async function remove(userId, name) {
  await prisma.secret.deleteMany({ where: { userId, name } });
}

async function exists(userId, name) {
  const row = await prisma.secret.findUnique({
    where: { userId_name: { userId, name } },
    select: { id: true },
  });
  return !!row;
}

module.exports = { put, get, meta, remove, exists, lastFour };
