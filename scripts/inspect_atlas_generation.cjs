'use strict';
/**
 * Read-only live snapshot of atlas + generation shape for a project — the
 * "immediate visibility" pull (before the P3d/replay-harness measurement).
 * Prints, straight from dev.db:
 *   [1] atlas: pages crawled, elements/durable selectors, text labels, page roles
 *       (capabilities + slice = N/A until the P3 migration is applied at restart)
 *   [2] current generation: scenarios, cases, modules covered (breadth signal)
 *   [3] requirement coverage: clauses, cases traced, covered vs uncovered
 *   [4] assertion grounding: grounded vs ungrounded (text_ungrounded), provenance,
 *       must-count + app-origin musts (anti-circular, must be 0)
 *   [5] the module-scoping thesis check (is this project shaped too broad?)
 *
 * Usage: node scripts/inspect_atlas_generation.cjs [projectId|nameSubstring]
 *   default → a project whose name contains "orange", else the most-recent
 *   ScenarioGeneration's project.
 *
 * READ-ONLY — SELECTs only. Queries ONLY columns that exist pre-P3-migration
 * (the running client predates the P3 regen), so capabilities/slice are reported
 * as pending rather than queried.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APP_ORIGIN = new Set(['website', 'atlas', 'app', 'live_site']);
const parse = (j, fb) => { try { return JSON.parse(j); } catch (_) { return fb; } };
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');

(async () => {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

  // ── pick the project ────────────────────────────────────────────────────
  let project = null;
  if (arg) {
    project = await prisma.project.findFirst({ where: { OR: [{ id: arg }, { name: { contains: arg } }] }, select: { id: true, name: true, targetUrl: true } });
  }
  if (!project) {
    project = await prisma.project.findFirst({ where: { name: { contains: 'orange' } }, select: { id: true, name: true, targetUrl: true } })
      || await prisma.project.findFirst({ where: { name: { contains: 'Orange' } }, select: { id: true, name: true, targetUrl: true } });
  }
  if (!project) {
    const g = await prisma.scenarioGeneration.findFirst({ orderBy: { createdAt: 'desc' }, select: { projectId: true } });
    if (g) project = await prisma.project.findUnique({ where: { id: g.projectId }, select: { id: true, name: true, targetUrl: true } });
  }
  if (!project) { console.log('No project found.'); await prisma.$disconnect(); return; }
  console.log(`\nPROJECT  ${project.name}  (${project.id})\n  target: ${project.targetUrl || '—'}`);

  // ── [1] atlas ─────────────────────────────────────────────────────────────
  console.log('\n[1] ATLAS (latest complete calibration)');
  const cal = await prisma.calibration.findFirst({
    where: { projectId: project.id, status: 'complete' },
    orderBy: { createdAt: 'desc' },
    include: { pages: true },
  });
  if (!cal) {
    console.log('  — no complete calibration for this project (Architect authored from docs alone).');
  } else {
    let elemTotal = 0; let durableTotal = 0; let textTotal = 0; const roles = {};
    for (const p of cal.pages) {
      const els = parse(p.elementsJson, []);
      elemTotal += els.length;
      for (const e of els) {
        const chain = Array.isArray(e.selectorChain) ? e.selectorChain : [];
        if (chain.some((s) => s && s.selector && s.strategy !== 'mcp-ref')) durableTotal++;
      }
      textTotal += parse(p.textCorpus, []).length;
      const r = p.pageRole || 'unclassified'; roles[r] = (roles[r] || 0) + 1;
    }
    console.log(`  pages crawled:        ${cal.pages.length}  (calibration ${cal.id.slice(0, 8)}, ${new Date(cal.createdAt).toISOString().slice(0, 10)})`);
    console.log(`  interactive elements: ${elemTotal}  (${durableTotal} with a durable cross-session selector, ${pct(durableTotal, elemTotal)})`);
    console.log(`  visible-text labels:  ${textTotal}`);
    console.log(`  page roles:           ${Object.entries(roles).map(([k, v]) => `${k}×${v}`).join(', ')}`);
    console.log('  capabilities + slice: PENDING — P3 migration (capabilitiesJson, module/authProfile/version) applies at next restart; this calibration predates it.');
  }

  // ── [2] current generation ──────────────────────────────────────────────
  console.log('\n[2] CURRENT GENERATION');
  const gen = await prisma.scenarioGeneration.findFirst({
    where: { projectId: project.id, isCurrent: true },
    orderBy: { version: 'desc' },
  }) || await prisma.scenarioGeneration.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' } });
  let cases = [];
  if (!gen) {
    console.log('  — no generation for this project.');
  } else {
    const scenarios = await prisma.testScenario.findMany({ where: { generationId: gen.id }, select: { module: true } });
    cases = await prisma.testCase.findMany({ where: { generationId: gen.id }, select: { declaredAssertions: true, requirementRefs: true, module: true, businessRisk: true } });
    const modules = [...new Set(scenarios.map((s) => s.module).filter(Boolean))];
    console.log(`  generation v${gen.version}  (${gen.id.slice(0, 8)}, ${new Date(gen.createdAt).toISOString().slice(0, 10)})`);
    console.log(`  scenarios: ${scenarios.length}   cases: ${cases.length}`);
    console.log(`  modules in ONE generation: ${modules.length}  → ${modules.slice(0, 12).join(', ')}${modules.length > 12 ? ' …' : ''}`);
  }

  // ── [3] requirement coverage ────────────────────────────────────────────
  console.log('\n[3] REQUIREMENT COVERAGE (P2 oracle)');
  const clauseCount = await prisma.requirementClause.count({ where: { projectId: project.id } }).catch(() => null);
  if (clauseCount === null) {
    console.log('  — RequirementClause table not available (pre-P2 client).');
  } else {
    const uncovered = await prisma.discrepancy.count({ where: { projectId: project.id, kind: 'requirement_uncovered' } }).catch(() => 0);
    const traced = cases.filter((c) => (parse(c.requirementRefs, []) || []).length > 0).length;
    console.log(`  requirement clauses:  ${clauseCount}`);
    console.log(`  cases traced to ≥1 clause: ${traced}/${cases.length}  (${pct(traced, cases.length)})`);
    console.log(`  uncovered findings:   ${uncovered}  (≈ ${pct(uncovered, clauseCount)} of clauses had NO case)`);
  }

  // ── [4] assertion grounding ─────────────────────────────────────────────
  console.log('\n[4] ASSERTION GROUNDING (current generation)');
  let total = 0; let ungrounded = 0; let otherFailed = 0; let musts = 0; let appOriginMusts = 0;
  const prov = {};
  for (const c of cases) {
    for (const a of parse(c.declaredAssertions, []) || []) {
      if (!a || typeof a !== 'object') continue;
      total++;
      const p = String(a.provenance || 'unspecified'); prov[p] = (prov[p] || 0) + 1;
      if (a.parseFailed && a.parseFailedReason === 'text_ungrounded') ungrounded++;
      else if (a.parseFailed) otherFailed++;
      if (a.criticality === 'must') { musts++; if (APP_ORIGIN.has(String(a.provenance || '').toLowerCase())) appOriginMusts++; }
    }
  }
  const grounded = total - ungrounded - otherFailed;
  console.log(`  declared assertions:  ${total}`);
  console.log(`  grounded (usable):    ${grounded}  (${pct(grounded, total)})`);
  console.log(`  ungrounded (text_ungrounded, demoted by the gate): ${ungrounded}  (${pct(ungrounded, total)})`);
  console.log(`  other parseFailed:    ${otherFailed}`);
  console.log(`  provenance:           ${Object.entries(prov).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  console.log(`  must assertions:      ${musts}   app-origin musts (anti-circular, MUST be 0): ${appOriginMusts}`);

  // ── [5] module-scoping thesis ───────────────────────────────────────────
  console.log('\n[5] MODULE-SCOPING THESIS');
  if (gen && clauseCount) {
    const modules = [...new Set((await prisma.testScenario.findMany({ where: { generationId: gen.id }, select: { module: true } })).map((s) => s.module).filter(Boolean))];
    console.log(`  This generation tried to cover ${clauseCount} clauses across ${modules.length} module(s) in ONE pass.`);
    console.log(`  Real QA unit = ONE module (~12-15 scenarios / 50-60 cases). ${modules.length > 1 ? 'This is BROADER than one module' : 'This is module-shaped'}.`);
    console.log('  → P3d module-scoping ranks clauses + atlas to ONE (module, authProfile) per pass: less truncation, higher coverage per generation.');
  } else {
    console.log('  (insufficient data — need a generation + clauses to assess breadth)');
  }

  console.log('');
  await prisma.$disconnect();
})().catch(async (e) => { console.error('inspect failed:', e.message); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
