'use strict';
/**
 * ONE-OFF P3d PIM smoke (not a guard). Proves the module-scoped authoring chain
 * end-to-end on real OrangeHRM data:
 *   1. a bounded, module-scoped PIM calibration → capabilitiesJson + a 'pim' slice
 *   2. module-scoped generation (rankClauses→pim, slice atlas, capability menu)
 *   3. operations[] emitted, Node-disposed, persisted as operationsJson
 *   4. inspection of the bound plan (capabilityRef resolves, status, dropped)
 *
 * Run with the backend DOWN and AFTER `prisma migrate deploy` + `prisma generate`
 * (so this process's client knows capabilitiesJson / slice cols / operationsJson).
 * Additive — new Calibration + new ScenarioGeneration; nothing wiped.
 *
 *   node scripts/_smoke_p3d_pim.cjs
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const architect = require('../server/services/agents/architect');
const { resolveAiCredentials } = require('../server/lib/resolveAiCredentials');
const oracle = require('../server/services/requirementOracle');
const tcc = require('../server/services/testCaseContract');
const cal = require('../server/services/agents/calibrator');
const reqCtx = require('../server/services/requirementContext');

const enc = (v) => (v == null ? null : JSON.stringify(v));
const parse = (j, fb) => { try { return JSON.parse(j); } catch (_) { return fb; } };
const PID = process.argv.slice(2).find((a) => !a.startsWith('--')) || '9675bfde-acb2-4eda-aaed-b6694b88f920'; // Orange HRM
const MODULE = 'pim';
const PIM_URL = 'https://opensource-demo.orangehrmlive.com/web/index.php/pim/viewEmployeeList';

(async () => {
  const t0 = Date.now();
  const project = await prisma.project.findUnique({ where: { id: PID } });
  if (!project) throw new Error('project not found: ' + PID);
  let userId = null;
  if (project.orgId) { const org = await prisma.organization.findUnique({ where: { id: project.orgId } }); userId = org && org.ownerId; }
  if (!userId) { const u = await prisma.user.findFirst({ select: { id: true } }); userId = u && u.id; }
  const { provider, apiKey, model } = await resolveAiCredentials(userId, project);
  if (!apiKey) throw new Error('no API key resolved');
  console.log(`\n=== P3d PIM smoke · ${project.name} · provider=${provider} model=${model} ===`);

  // ── 1) bounded module-scoped PIM calibration (populates capabilitiesJson) ──
  // --skip-calibration reuses the existing pim slice (cheap re-run: generation only).
  const skipCal = process.argv.includes('--skip-calibration');
  if (skipCal) {
    console.log(`\n[1] SKIP calibration (--skip-calibration) — reusing the existing "${MODULE}" slice.`);
  } else {
    console.log(`\n[1] Calibrating module="${MODULE}" from ${PIM_URL} (maxPages 8)…`);
    try {
      const calRow = await prisma.calibration.create({ data: { projectId: PID, startUrl: PIM_URL, status: 'running', module: MODULE, authProfileId: null } });
      await cal.runCalibrator({
        projectId: PID, userId, calibrationId: calRow.id, startUrl: PIM_URL,
        module: MODULE, authProfileId: null, maxPages: 8,
        send: (e) => { if (e && e.message) console.log(`    [calib] ${e.message}`); },
      });
    } catch (e) { console.log(`    [calib] calibration error (continuing with whatever atlas exists): ${e.message}`); }
  }

  // ── 2) module-scoped atlas slice + capability inventory ──
  const atlas = await cal.getCalibrationAtlas(PID, { module: MODULE });
  const caps = (atlas && Array.isArray(atlas.capabilities)) ? atlas.capabilities : [];
  console.log(`\n[2] Atlas slice: ${atlas ? `${atlas.pages.length} pages, slice=${JSON.stringify(atlas.slice)}, degraded=${atlas.degraded || 'no'}` : 'NONE'}; capabilities=${caps.length}`);
  const byType = {}; for (const c of caps) byType[c.type] = (byType[c.type] || 0) + 1;
  console.log(`    capability types: ${Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(', ') || '(none)'}`);
  if (caps.length) console.log(`    sample: ${caps.slice(0, 5).map((c) => `[${c.capabilityId}] ${c.type} "${c.name}"`).join(' | ')}`);

  // ── 3) module-scoped clauses (the max_tokens fix) ──
  const clausePrep = await oracle.prepareArchitectClauses({ prisma, projectId: PID, providerName: provider, apiKey, model, knownModules: [MODULE], log: console });
  const scoped = (clausePrep.requirementClauses.length)
    ? reqCtx.rankClauses(clausePrep.requirementClauses, MODULE, { maxClauses: 40, knownModules: [MODULE] }).kept
    : [];
  console.log(`\n[3] Clauses: ${clausePrep.requirementClauses.length} total → ${scoped.length} module-scoped (cap 40), mode=${clausePrep.contextMode}`);

  // ── 4) module-scoped generation (capability menu + operations[]) ──
  const requirements = await prisma.requirement.findMany({ where: { projectId: PID } });
  const siteContext = await cal.getCalibrationContext(PID, { module: MODULE });
  const testData = await require('../server/services/testDataContext').loadTestDataContext(PID);
  console.log(`\n[4] Architect (module-scoped, ${caps.length} capabilities in menu)…`);
  const result = await architect.run({
    apiKey, model, provider, requirements,
    onLog: async (lvl, msg) => console.log(`    [architect:${lvl}] ${msg}`),
    extraGuidance: project.aiGuidance || null,
    siteContext, testData,
    requirementClauses: scoped, contextMode: clausePrep.contextMode, knownModules: [MODULE],
    capabilities: caps, module: MODULE,
  });
  console.log(`    architect returned ${result.scenarios.length} scenario(s)`);

  // ── 5) persist (additive new generation) ──
  const prevGen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PID }, orderBy: { version: 'desc' }, select: { version: true } });
  const nextVersion = (prevGen?.version || 0) + 1;
  await prisma.scenarioGeneration.updateMany({ where: { projectId: PID, isCurrent: true }, data: { isCurrent: false } });
  const generation = await prisma.scenarioGeneration.create({ data: { projectId: PID, version: nextVersion, label: `P3d PIM smoke ${new Date().toISOString()}`, isCurrent: true } });
  let scnCount = 0, caseCount = 0;
  for (const s of result.scenarios) {
    const scenario = await prisma.testScenario.create({ data: { projectId: PID, generationId: generation.id, name: s.name, module: s.module, priority: s.priority, category: s.category, rationale: s.rationale, dependencyOn: enc(s.dependencyOn), source: 'agent' } });
    const persisted = await tcc.persistCases({ prisma, projectId: PID, scenarioId: scenario.id, generationId: generation.id, moduleName: s.module, cases: s.cases, calibrationAtlas: atlas, log: console });
    scnCount++; caseCount += persisted.length;
  }
  await prisma.scenarioGeneration.update({ where: { id: generation.id }, data: { scenarioCount: scnCount, caseCount } });

  // ── 6) inspect the persisted operations[] (the P3d acceptance evidence) ──
  const capIds = new Set(caps.map((c) => String(c.capabilityId || c.name).toLowerCase()));
  const cases = await prisma.testCase.findMany({ where: { generationId: generation.id }, select: { name: true, operationsJson: true } });
  let withOps = 0, totalOps = 0, totalDropped = 0, incomplete = 0, refResolved = 0, refTotal = 0;
  const opCounts = {};
  for (const c of cases) {
    const plan = parse(c.operationsJson, null);
    if (!plan || !Array.isArray(plan.operations)) continue;
    withOps++;
    if (plan.status === 'incomplete') incomplete++;
    totalDropped += Array.isArray(plan.dropped) ? plan.dropped.length : 0;
    for (const op of plan.operations) {
      totalOps++; opCounts[op.operation] = (opCounts[op.operation] || 0) + 1;
      if (op.capabilityRef) { refTotal++; if (capIds.has(String(op.capabilityRef).toLowerCase())) refResolved++; }
    }
  }
  console.log(`\n=== P3d EVIDENCE — generation v${nextVersion} (${generation.id}) ===`);
  console.log(`  scenarios: ${scnCount}   cases: ${caseCount}`);
  console.log(`  cases with operations[]: ${withOps}/${caseCount}`);
  console.log(`  operations bound: ${totalOps}  (by op: ${Object.entries(opCounts).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'})`);
  console.log(`  capabilityRef → real capabilityId: ${refResolved}/${refTotal} resolved`);
  console.log(`  dropped operations: ${totalDropped}   cases marked incomplete: ${incomplete}`);
  console.log(`  (incomplete cases would be BLOCKED by the BDD export gate; complete cases are export-ready)`);
  console.log(`\n=== DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s ===\n`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error('\nSMOKE FAILED:', e.message, '\n', e.stack); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
