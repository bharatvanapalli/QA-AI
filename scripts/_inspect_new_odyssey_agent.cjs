'use strict';

const { PrismaClient } = require('../server/node_modules/@prisma/client');
const db = new PrismaClient();
const PROJECT_ID = '1582559f-364f-4d0e-bfde-fd18832fdaa7';

function decode(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

(async () => {
  const rows = await db.agentRun.findMany({
    where: { projectId: PROJECT_ID, phase: 'conductor' },
    orderBy: { startedAt: 'desc' },
    take: 5,
  });
  console.log(JSON.stringify(rows.map((row) => {
    const log = decode(row.log, []);
    return {
      id: row.id,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      error: row.error,
      input: decode(row.input),
      output: decode(row.output),
      logTail: Array.isArray(log) ? log.slice(-30) : log,
    };
  }), null, 2));
})().finally(() => db.$disconnect());
