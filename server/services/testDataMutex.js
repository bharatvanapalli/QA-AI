'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = Number(process.env.QAAI_TEST_DATA_MUTEX_TTL_MS) || 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = Number(process.env.QAAI_TEST_DATA_MUTEX_TIMEOUT_MS) || 30 * 1000;
const DEFAULT_POLL_MS = Number(process.env.QAAI_TEST_DATA_MUTEX_POLL_MS) || 500;

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function stableHash(value) {
  return crypto.createHash('sha256').update(clean(value).toLowerCase()).digest('hex').slice(0, 24);
}

function isProtectedField(name) {
  return /\b(user(name)?|login|email|mail|account|employee\s*id|employeeid|emp\s*id|id|credential|password|pwd|token|role)\b/i.test(clean(name));
}

function fieldsOf(row) {
  const merged = {
    ...(row && row.raw && typeof row.raw === 'object' ? row.raw : {}),
    ...(row && row.inputs && typeof row.inputs === 'object' ? row.inputs : {}),
    ...(row && row.fields && typeof row.fields === 'object' ? row.fields : {}),
  };
  return Object.entries(merged)
    .map(([key, value]) => [clean(key), clean(value)])
    .filter(([key, value]) => key && value);
}

function buildRowLockKeys({ projectId, testCaseId, row } = {}) {
  if (!projectId || !row) return [];
  const setName = clean(row.setName || row.sheet || row.dataSetName || 'default');
  const keys = new Set();
  const rowIndex = Number.isFinite(Number(row.index)) ? Number(row.index) : null;
  if (rowIndex != null) keys.add(`dataset:${setName.toLowerCase()}:row:${rowIndex}`);

  for (const [name, value] of fieldsOf(row)) {
    if (!isProtectedField(name)) continue;
    keys.add(`field:${name.toLowerCase()}:value:${stableHash(value)}`);
  }

  if (!keys.size && testCaseId && rowIndex != null) {
    keys.add(`case:${clean(testCaseId).toLowerCase()}:row:${rowIndex}`);
  }
  return Array.from(keys).sort();
}

function isUniqueConflict(err) {
  return err && err.code === 'P2002';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRowLeases({
  prisma,
  projectId,
  runId,
  testCaseId,
  row,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  onLog,
} = {}) {
  const keys = buildRowLockKeys({ projectId, testCaseId, row });
  if (!keys.length) return { acquired: false, keys: [], leaseIds: [], reason: 'no_lock_keys' };
  if (!prisma || !prisma.testDataLease) {
    return { acquired: false, keys, leaseIds: [], reason: 'lease_model_unavailable' };
  }

  const started = Date.now();
  let waits = 0;
  while (Date.now() - started <= timeoutMs) {
    const leaseIds = [];
    try {
      for (const key of keys) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlMs);
        try {
          const lease = await prisma.testDataLease.create({
            data: {
              projectId,
              runId,
              testCaseId: testCaseId || null,
              lockKey: key,
              dataSetName: row?.setName || row?.sheet || null,
              dataRowIndex: Number.isFinite(Number(row?.index)) ? Number(row.index) : null,
              expiresAt,
            },
            select: { id: true },
          });
          leaseIds.push(lease.id);
        } catch (err) {
          if (!isUniqueConflict(err)) throw err;
          const existing = await prisma.testDataLease.findUnique({
            where: { projectId_lockKey: { projectId, lockKey: key } },
            select: { id: true, expiresAt: true, runId: true },
          });
          let owningRun = null;
          let owningRunChecked = false;
          if (existing?.runId && prisma.run?.findUnique) {
            try {
              owningRun = await prisma.run.findUnique({
                where: { id: existing.runId },
                select: { status: true },
              });
              owningRunChecked = true;
            } catch (_) {
              owningRunChecked = false;
            }
          }
          const expired = !!(existing?.expiresAt && existing.expiresAt.getTime() <= Date.now());
          const sameRun = !!(existing?.runId && existing.runId === runId);
          const terminalOwner = owningRunChecked && (!owningRun || owningRun.status !== 'running');
          if (existing && (expired || sameRun || terminalOwner)) {
            await prisma.testDataLease.deleteMany({ where: { id: existing.id } });
            const retry = new Error('Retry test-data lease acquisition after reclaiming a stale owner.');
            retry.code = 'P2002';
            retry.qaaiRetryImmediately = true;
            retry.qaaiReclaimedRunId = existing.runId || null;
            throw retry;
          }
          throw err;
        }
      }
      if (waits > 0) {
        onLog?.('info', `Test-data mutex acquired after ${waits} wait cycle${waits === 1 ? '' : 's'} for ${row?.setName || row?.sheet || 'data row'} row ${(row?.index ?? 0) + 1}.`);
      }
      return { acquired: true, keys, leaseIds, waitedMs: Date.now() - started };
    } catch (err) {
      if (leaseIds.length) {
        await releaseRowLeases({ prisma, leaseIds }).catch(() => {});
      }
      if (!isUniqueConflict(err)) throw err;
      waits += 1;
      if (err.qaaiRetryImmediately) {
        onLog?.('info', `Test-data mutex reclaimed a lease from terminal run ${err.qaaiReclaimedRunId || 'unknown'}; retrying immediately.`);
        continue;
      }
      onLog?.('info', `Test-data mutex waiting: ${row?.setName || row?.sheet || 'data row'} row ${(row?.index ?? 0) + 1} is checked out by another run.`);
      await sleep(pollMs);
    }
  }

  const timeoutErr = new Error(`Timed out waiting for test-data mutex after ${timeoutMs}ms.`);
  timeoutErr.code = 'TEST_DATA_MUTEX_TIMEOUT';
  timeoutErr.keys = keys;
  throw timeoutErr;
}

async function releaseRowLeases({ prisma, leaseIds = [] } = {}) {
  const ids = Array.from(new Set((leaseIds || []).filter(Boolean)));
  if (!ids.length || !prisma || !prisma.testDataLease) return { released: 0 };
  const result = await prisma.testDataLease.deleteMany({ where: { id: { in: ids } } });
  return { released: result.count || 0 };
}

module.exports = {
  buildRowLockKeys,
  acquireRowLeases,
  releaseRowLeases,
  _private: { isProtectedField, stableHash },
};
