'use strict';

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// ── SQLite concurrency hardening ─────────────────────────────────────────────
// Default SQLite (rollback-journal) mode serialises readers and writers with a
// database-level lock: while a long, synchronous generation persists ~30 cases,
// the UI's status polling (and any overlapping request) can hold/contend the
// lock and the persist BLOCKS indefinitely on an idle await — the "architect
// finished but nothing saved" hang. WAL lets readers and the single writer run
// concurrently without blocking; busy_timeout makes any residual contention
// RETRY (not hang/error); synchronous=NORMAL is safe under WAL. No-op on non-SQLite.
if (String(process.env.DATABASE_URL || '').startsWith('file:')) {
  (async () => {
    try {
      // Several of these PRAGMAs RETURN a row (journal_mode → "wal";
      // busy_timeout → the value), which makes $executeRawUnsafe throw
      // "Execute returned results, which is not allowed in SQLite" and emit a
      // prisma:error that leaked into subprocess JSON output. $queryRawUnsafe
      // tolerates BOTH row-returning and no-row PRAGMAs (no-row → []), so use it
      // for all three. Non-fatal regardless (caught below).
      await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
      await prisma.$queryRawUnsafe('PRAGMA busy_timeout=15000;');
      await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL;');
    } catch (err) {
      console.warn('[prisma] SQLite WAL pragma setup failed (non-fatal):', err.message);
    }
  })();
}

process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

module.exports = prisma;
