'use strict';
/**
 * READ-ONLY probe for the P6 live-activation run. Answers acceptance step 1
 * ("confirm approved cases exist for the target module"), picks the SMALLEST
 * approved slice so the live run stays 1-3 cases, and confirms a VALID provider
 * key exists for the run-user (the Gemini-429 lesson — diagnose creds FIRST).
 * No mutation. [[preserve-trial-data]]
 *
 *   node scripts/_probe_p6_activation.cjs
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, targetUrl: true, orgId: true, userId: true, aiProvider: true, execMode: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log('=== PROJECTS ===');
  for (const p of projects) console.log(`  ${p.name}  [${p.id}]  url=${p.targetUrl || '-'}  provider=${p.aiProvider}  execMode=${p.execMode}`);

  const orange = projects.find((p) => /orange/i.test(p.name || '') || /orangehrm/i.test(p.targetUrl || ''));
  const target = orange || projects[0];
  if (!target) { console.log('NO PROJECTS'); await prisma.$disconnect(); return; }
  console.log(`\n=== TARGET: ${target.name} [${target.id}] ===`);
  console.log(`  targetUrl=${target.targetUrl}  aiProvider=${target.aiProvider}  execMode=${target.execMode}  ownerUserId=${target.userId}  orgId=${target.orgId}`);

  // --- Provider key for the run-user (project creator). The execute route uses req.user.id. ---
  const secret = await prisma.secret.findFirst({
    where: { userId: target.userId, name: `${target.aiProvider}.apiKey` },
    select: { lastFour: true, updatedAt: true },
  }).catch(() => null);
  const integ = await prisma.integration.findFirst({
    where: { userId: target.userId, type: target.aiProvider },
    select: { status: true, lastValidatedAt: true, lastError: true, config: true },
  }).catch(() => null);
  console.log(`\n  [creds for owner ${target.userId}]`);
  console.log(`    ${target.aiProvider}.apiKey secret: ${secret ? `present (•••${secret.lastFour})` : 'MISSING'}`);
  console.log(`    ${target.aiProvider} integration: ${integ ? `status=${integ.status}${integ.lastError ? ' err=' + integ.lastError : ''}` : 'MISSING'}`);
  let model = null;
  try { model = integ?.config ? (JSON.parse(integ.config).model || null) : null; } catch (_) {}
  console.log(`    model: ${model || '(provider default)'}`);

  // --- Current generation + approved+automatable per scenario/module ---
  const gen = await prisma.scenarioGeneration.findFirst({
    where: { projectId: target.id, isCurrent: true },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, label: true, scenarioCount: true, caseCount: true },
  });
  console.log(`\n  current generation: ${gen ? `v${gen.version} "${gen.label || ''}" [${gen.id}] (scn=${gen.scenarioCount}, cases=${gen.caseCount})` : '(none — legacy project-wide)'}`);

  const scenarios = await prisma.testScenario.findMany({
    where: { projectId: target.id, ...(gen ? { generationId: gen.id } : {}) },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, name: true, module: true,
      cases: { select: { id: true, name: true, status: true, automatability: true, authProfile: true, dependsOnIds: true } },
    },
  });
  console.log(`\n  scenarios in current gen: ${scenarios.length}`);
  let totalApprovedAuto = 0;
  const moduleAgg = new Map();
  for (const s of scenarios) {
    const approvedAuto = s.cases.filter((c) => c.status === 'approved' && c.automatability === 'automatable');
    totalApprovedAuto += approvedAuto.length;
    const statuses = {};
    for (const c of s.cases) statuses[c.status] = (statuses[c.status] || 0) + 1;
    const key = s.module || '(no module)';
    moduleAgg.set(key, (moduleAgg.get(key) || 0) + approvedAuto.length);
    console.log(`    - [${s.module || 'no-module'}] "${s.name}"  cases=${s.cases.length}  approved+auto=${approvedAuto.length}  byStatus=${JSON.stringify(statuses)}`);
    for (const c of approvedAuto) console.log(`         · [${c.id}] ${c.name}  auth=${c.authProfile || '-'}  deps=${c.dependsOnIds || '-'}`);
  }
  console.log(`\n  >>> TOTAL approved+automatable in current gen (this is exactly what /execute runs): ${totalApprovedAuto}`);
  console.log('  per-module approved+auto:');
  for (const [m, n] of moduleAgg) console.log(`    ${m}: ${n}`);

  const profiles = await prisma.authProfile.findMany({
    where: { projectId: target.id }, select: { name: true, strategy: true, disposition: true },
  }).catch(() => []);
  console.log(`\n  authProfiles: ${profiles.length ? profiles.map((p) => `${p.name}(${p.strategy}/${p.disposition})`).join(', ') : '(none)'}`);

  const running = await prisma.run.findFirst({
    where: { projectId: target.id, status: 'running' },
    select: { id: true, startedAt: true },
  }).catch(() => null);
  console.log(`\n  run in progress? ${running ? `YES [${running.id}] since ${running.startedAt.toISOString()}` : 'no'}`);

  const recent = await prisma.run.findMany({
    where: { projectId: target.id }, orderBy: { startedAt: 'desc' }, take: 3,
    select: { id: true, status: true, passed: true, failed: true, blocked: true, startedAt: true },
  }).catch(() => []);
  console.log('\n  recent runs:');
  for (const r of recent) console.log(`    ${r.startedAt.toISOString()}  ${r.status}  P${r.passed}/F${r.failed}/B${r.blocked}  [${r.id}]`);

  await prisma.$disconnect();
})().catch(async (e) => { console.error('PROBE ERROR', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
