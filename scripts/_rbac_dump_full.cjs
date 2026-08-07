'use strict';
// Dump the FULL latest generation (untruncated) to _rbac_gen_full.json for adversarial QA review.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
function parse(v) { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }
(async () => {
  const gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' } });
  const scenarios = await prisma.testScenario.findMany({ where: { projectId: PROJECT_ID, generationId: gen.id }, orderBy: { createdAt: 'asc' } });
  const cases = await prisma.testCase.findMany({ where: { projectId: PROJECT_ID, generationId: gen.id }, orderBy: { createdAt: 'asc' } });
  const out = { generation: `v${gen.version}`, scenarios: scenarios.map((s) => ({
    name: s.name, module: s.module, priority: s.priority, category: s.category, rationale: s.rationale,
    cases: cases.filter((c) => c.scenarioId === s.id).map((c) => ({
      name: c.name, automatability: c.automatability, automatabilityReason: c.automatabilityReason,
      dataBinding: parse(c.dataBindingJson),
      declaredAssertions: parse(c.declaredAssertions),
      steps: parse(c.steps),
    })),
  })) };
  fs.writeFileSync(path.join(ROOT, '_rbac_gen_full.json'), JSON.stringify(out, null, 2));
  console.log('wrote _rbac_gen_full.json', JSON.stringify(out).length, 'bytes');
  await prisma.$disconnect();
})().catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
