'use strict';
// QA grader for the latest generation: dumps full per-case detail and runs the symptom checks
// (status complete? errorCount 0? manual? token corruption? bound to a data sheet?). Read-only.
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
function parse(v) { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }
const CORRUPT_RE = /([a-z0-9])\{\{[^}]+\}\}|\}\}[a-z0-9]|\{\{\{|\}\}\}/i; // mid-word / fused / over-wrapped

(async () => {
  const gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' } });
  console.log(`GENERATION v${gen.version} (${gen.id}) label="${gen.label || ''}"`);
  const scenarios = await prisma.testScenario.findMany({ where: { projectId: PROJECT_ID, generationId: gen.id }, orderBy: { createdAt: 'asc' } });
  const cases = await prisma.testCase.findMany({ where: { projectId: PROJECT_ID, generationId: gen.id }, orderBy: { createdAt: 'asc' } });
  const byScenario = new Map();
  for (const c of cases) { const k = c.scenarioId; if (!byScenario.has(k)) byScenario.set(k, []); byScenario.get(k).push(c); }

  let manual = 0, incomplete = 0, errFinding = 0, corrupt = 0, bound = 0, noAssert = 0;
  const corruptSamples = [];

  for (const s of scenarios) {
    console.log(`\n━━ SCENARIO: ${s.name}  [module=${s.module} priority=${s.priority} cat=${s.category}]`);
    for (const c of (byScenario.get(s.id) || [])) {
      const db = parse(c.dataBindingJson);
      const da = parse(c.declaredAssertions) || [];
      const steps = parse(c.steps) || [];
      const findings = (db && Array.isArray(db.findings)) ? db.findings : [];
      const errs = findings.filter(f => f.severity === 'error');
      if (c.automatability === 'manual') manual++;
      if (db && db.status === 'incomplete') incomplete++;
      if (errs.length) errFinding++;
      if (db && db.sheet) bound++;
      if (!da.length && c.automatability !== 'manual') noAssert++;
      const blob = JSON.stringify({ n: c.name, da, steps });
      if (CORRUPT_RE.test(blob)) { corrupt++; if (corruptSamples.length < 6) corruptSamples.push(c.name); }

      console.log(`\n  • CASE: ${c.name}`);
      console.log(`    automatability=${c.automatability}${c.automatabilityReason ? ' reason="' + c.automatabilityReason + '"' : ''}`);
      console.log(`    dataBinding: sheet=${db?.sheet || '-'} status=${db?.status || '-'} rowSelector=${db?.rowSelector || '-'} findings=[${findings.map(f => f.code + ':' + f.severity).join(', ')}]`);
      console.log(`    declaredAssertions (${da.length}): ${da.map(a => `${a.type}/${a.criticality || 'must'}${a.expectedText ? ' "' + String(a.expectedText).slice(0, 50) + '"' : ''}${a.pageName ? ' page=' + a.pageName : ''}`).join(' | ')}`);
      console.log(`    steps (${steps.length}):`);
      steps.forEach((st, i) => console.log(`      ${i + 1}. [${st.action || st.kind || '?'}] ${(st.description || '').slice(0, 50)} | el="${(st.element || '').slice(0, 50)}" val="${String(st.value ?? '').slice(0, 50)}"${st.verify ? ' verify=' + (typeof st.verify === 'object' ? JSON.stringify(st.verify).slice(0, 60) : String(st.verify).slice(0, 50)) : ''}`));
    }
  }

  console.log(`\n\n════════ QA SUMMARY ════════`);
  console.log(`scenarios=${scenarios.length} cases=${cases.length}`);
  console.log(`manual=${manual} | status:incomplete=${incomplete} | cases-with-error-finding=${errFinding} | data-bound=${bound}/${cases.length} | token-corrupt=${corrupt} | automatable-without-assertion=${noAssert}`);
  if (corruptSamples.length) console.log(`token-corrupt samples: ${corruptSamples.join(' || ')}`);
  console.log(`\nVERDICT GATES:`);
  console.log(`  [${incomplete === 0 ? 'PASS' : 'FAIL'}] no "Data incomplete" (status incomplete=${incomplete})`);
  console.log(`  [${errFinding === 0 ? 'PASS' : 'FAIL'}] no error-severity findings (badge clear) (=${errFinding})`);
  console.log(`  [${corrupt === 0 ? 'PASS' : 'FAIL'}] no token corruption (=${corrupt})`);
  console.log(`  [${bound === cases.length ? 'PASS' : 'WARN'}] every case data-bound (=${bound}/${cases.length})`);
  console.log(`  [${noAssert === 0 ? 'PASS' : 'WARN'}] every automatable case has an assertion (without=${noAssert})`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
