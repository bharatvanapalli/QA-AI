'use strict';
const path = require('path'); process.chdir(path.join(__dirname, '..'));
const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();
const ctx = require('../server/services/testDataContext');
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
(async () => {
  const g = await p.scenarioGeneration.findFirst({ where: { projectId: PID, isCurrent: true }, orderBy: { version: 'desc' } });
  const t = await ctx.loadTestDataContext(PID);
  // collect every sheet cell value into a set
  const cellValues = new Set();
  for (const sh of (t.sheets || [])) for (const row of (sh.rows || [])) for (const k of Object.keys(row)) {
    const v = String(row[k] == null ? '' : row[k]).trim();
    if (v && v.length >= 3) cellValues.add(v);
  }
  const cs = await p.testCase.findMany({ where: { generationId: g.id }, select: { name: true, steps: true } });
  let fillVals = [], matched = 0, invented = 0;
  for (const c of cs) {
    for (const s of (J(c.steps, []) || [])) {
      if (/fill|type|enter/i.test(String(s.action || '')) && s.value && typeof s.value === 'string') {
        const v = s.value.trim();
        if (!v || v.startsWith('{{')) continue;
        fillVals.push(v);
        if (cellValues.has(v)) matched++; else invented++;
      }
    }
  }
  console.log(`gen v${g.version} | sheet cell values: ${cellValues.size}`);
  console.log(`fill literals in cases: ${fillVals.length} | EXACT-match a sheet cell: ${matched} | NOT in any sheet (LLM-invented/general-knowledge): ${invented}`);
  console.log('sample fill literals:', [...new Set(fillVals)].slice(0, 18).map(v => JSON.stringify(v.slice(0,40))).join(', '));
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
