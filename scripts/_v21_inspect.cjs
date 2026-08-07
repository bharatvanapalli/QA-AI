'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse = (v) => { if (!v) return null; if (typeof v==='object') return v; try { return JSON.parse(v); } catch { return null; } };
(async () => {
  const gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PID, isCurrent: true }, orderBy: { version: 'desc' } });
  const scns = await prisma.testScenario.findMany({ where: { projectId: PID, generationId: gen.id }, orderBy: { createdAt: 'asc' } });
  const cases = await prisma.testCase.findMany({ where: { projectId: PID, generationId: gen.id }, orderBy: { createdAt: 'asc' } });
  console.log(`v${gen.version}: ${scns.length} scenarios, ${cases.length} cases\n`);
  for (const s of scns) {
    const rat = (s.rationale||'').slice(0,140);
    console.log(`SCENARIO: ${s.name}`);
    if (rat) console.log(`   rationale: ${rat}`);
    const mine = cases.filter(c => c.scenarioId === s.id);
    for (const c of mine) {
      const steps = parse(c.steps)||[]; const da = parse(c.declaredAssertions)||[]; const db = parse(c.dataBindingJson)||{};
      const refs = parse(c.requirementRefsJson) || c.requirementRefs || [];
      console.log(`   • ${c.name}`);
      console.log(`       steps=${steps.length} assertions=${da.length} sheet=${db.sheet||'-'} bindStatus=${db.status||'-'} refs=${Array.isArray(refs)?refs.length:0}`);
    }
    console.log('');
  }
  // token distribution across all cases
  const TOKEN_RE=/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  const dist = {};
  for (const c of cases) {
    const blob = JSON.stringify({s:parse(c.steps)||[],d:parse(c.declaredAssertions)||[]});
    let m; TOKEN_RE.lastIndex=0; const seen=new Set();
    while((m=TOKEN_RE.exec(blob))){ seen.add(m[1]); }
    for (const t of seen) dist[t]=(dist[t]||0)+1;
  }
  console.log('=== TOKEN USAGE (distinct cases using each token) ===');
  Object.entries(dist).sort((a,b)=>b[1]-a[1]).forEach(([t,n])=>console.log(`   {{${t}}} → ${n} case(s)`));
  await prisma.$disconnect();
})().catch(e=>{console.error(e); prisma.$disconnect(); process.exit(1);});
