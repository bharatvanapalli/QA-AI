'use strict';
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.$queryRawUnsafe(`SELECT name FROM pragma_table_info('RunResult') WHERE name='failureExplanation'`)
  .then(r => { console.log('column exists:', r.length > 0, JSON.stringify(r)); })
  .catch(e => console.error('error:', e.message))
  .finally(() => p.$disconnect());
