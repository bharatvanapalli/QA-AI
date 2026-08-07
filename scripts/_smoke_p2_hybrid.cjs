'use strict';
/**
 * ONE-OFF P2-integration smoke (not a guard). Drives a real Hybrid generation
 * in-process by calling the SAME service functions the /generate route calls —
 * so it exercises the actual oracle pipeline without needing a browser session.
 *
 * Makes a real (paid) LLM call and writes an ADDITIVE new ScenarioGeneration
 * (prior generations preserved — same versioning the route uses; nothing wiped).
 *
 * Run with the backend DOWN and AFTER `npx prisma generate`, so this process's
 * Prisma client knows RequirementClause (else persistClauses degrades silently).
 *
 *   node scripts/_smoke_p2_hybrid.cjs [projectId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const architect = require('../server/services/agents/architect');
const { resolveAiCredentials } = require('../server/lib/resolveAiCredentials');
const oracle = require('../server/services/requirementOracle');
const tcc = require('../server/services/testCaseContract');

const enc = (v) => (v == null ? null : JSON.stringify(v));
const PID = process.argv[2] || '9675bfde-acb2-4eda-aaed-b6694b88f920'; // Orange HRM

(async () => {
  const t0 = Date.now();
  const project = await prisma.project.findUnique({ where: { id: PID } });
  if (!project) throw new Error('project not found: ' + PID);

  let userId = null;
  if (project.orgId) { const org = await prisma.organization.findUnique({ where: { id: project.orgId } }); userId = org && org.ownerId; }
  if (!userId) { const u = await prisma.user.findFirst({ select: { id: true } }); userId = u && u.id; }
  const { provider, apiKey, model } = await resolveAiCredentials(userId, project);
  if (!apiKey) throw new Error('no API key resolved for project owner');
  console.log(`\n=== P2 Hybrid smoke · ${project.name} · provider=${provider} model=${model} ===`);

  const requirements = await prisma.requirement.findMany({ where: { projectId: PID } });
  if (!requirements.length) throw new Error('no Requirement rows for project');

  let calibrationContext = null, calibrationAtlas = null;
  try { const cal = require('../server/services/agents/calibrator'); calibrationContext = await cal.getCalibrationContext(PID); calibrationAtlas = await cal.getCalibrationAtlas(PID); } catch (_) {}

  // ── P2: extract + persist clauses, decide context mode (the route's prep) ──
  const priorModules = await prisma.testScenario.findMany({ where: { projectId: PID }, select: { module: true }, distinct: ['module'], take: 50 });
  const knownModules = Array.from(new Set(priorModules.map((s) => s.module).filter(Boolean)));
  const clausePrep = await oracle.prepareArchitectClauses({
    prisma, projectId: PID, providerName: provider, apiKey, model, knownModules,
    send: (e) => console.log(`  [oracle] ${e.level || 'info'}: ${e.message || ''}`), log: console,
  });
  console.log(`\n>>> clausePrep: mode=${clausePrep.contextMode} clauses=${clausePrep.stats.clauseCount} stats=${JSON.stringify(clausePrep.stats)}\n`);

  // ── Architect (Hybrid context when clauses exist) ──
  const testData = await require('../server/services/testDataContext').loadTestDataContext(PID);
  const result = await architect.run({
    apiKey, model, provider, requirements,
    onLog: async (lvl, msg) => console.log(`  [architect:${lvl}] ${msg}`),
    extraGuidance: project.aiGuidance || null,
    siteContext: calibrationContext, testData,
    requirementClauses: clausePrep.requirementClauses,
    contextMode: clausePrep.contextMode,
    knownModules: clausePrep.knownModules,
  });
  console.log(`\n>>> architect returned ${result.scenarios.length} scenario(s)\n`);

  // ── Persist (additive versioning — same as the route; prior gens kept) ──
  const prevGen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PID }, orderBy: { version: 'desc' }, select: { version: true } });
  const nextVersion = (prevGen?.version || 0) + 1;
  await prisma.scenarioGeneration.updateMany({ where: { projectId: PID, isCurrent: true }, data: { isCurrent: false } });
  const generation = await prisma.scenarioGeneration.create({ data: { projectId: PID, version: nextVersion, label: `P2 Hybrid smoke ${new Date().toISOString()}`, isCurrent: true } });

  const allCasesWithRefs = [];
  let scnCount = 0, caseCount = 0;
  for (const s of result.scenarios) {
    const scenario = await prisma.testScenario.create({ data: { projectId: PID, generationId: generation.id, name: s.name, module: s.module, priority: s.priority, category: s.category, rationale: s.rationale, dependencyOn: enc(s.dependencyOn), source: 'agent' } });
    const persisted = await tcc.persistCases({ prisma, projectId: PID, scenarioId: scenario.id, generationId: generation.id, moduleName: s.module, cases: s.cases, calibrationAtlas, log: console });
    for (const p of persisted) allCasesWithRefs.push({ caseId: p.tc.id, requirementRefs: Array.isArray(p.source.requirementRefs) ? p.source.requirementRefs : [] });
    scnCount++; caseCount += persisted.length;
  }
  await prisma.scenarioGeneration.update({ where: { id: generation.id }, data: { scenarioCount: scnCount, caseCount } });

  if (clausePrep.requirementClauses.length) {
    const rtm = await oracle.persistRtmFindings({ prisma, projectId: PID, requirements: clausePrep.requirementClauses, casesWithRefs: allCasesWithRefs, log: console });
    console.log(`\n>>> RTM: uncovered=${rtm.uncovered.length} findingsWritten=${rtm.written}`);
  }
  console.log(`\n=== DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s — generation v${nextVersion} (${generation.id}): ${scnCount} scenarios, ${caseCount} cases ===\n`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error('\nSMOKE FAILED:', e.message, '\n', e.stack); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
