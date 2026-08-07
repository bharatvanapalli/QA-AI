'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const { decodeJson } = require('../server/services/jsonField');
const prisma = new PrismaClient();
const IDS = ['e3183ae3-b4fe-43ae-a796-7354e20745f6', '148a9de6-4db3-4883-8cdd-c035166e088d'];
(async () => {
  for (const id of IDS) {
    const c = await prisma.testCase.findUnique({ where: { id }, select: { name: true, operationsJson: true, dataBindingJson: true } });
    const ops = decodeJson(c.operationsJson, null);
    console.log(`\n${c.name}`);
    console.log(`  operationsJson: ${ops ? `status=${ops.status} ops=${(ops.operations || []).length} dropped=${(ops.dropped || []).length}` : 'NULL'}`);
    if (ops && ops.operations) console.log(`  op names: ${ops.operations.map((o) => o.operation).join(', ')}`);
    console.log(`  dataBindingJson: ${c.dataBindingJson ? c.dataBindingJson.slice(0, 120) : 'NULL'}`);
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
