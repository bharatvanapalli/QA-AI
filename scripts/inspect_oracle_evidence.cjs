'use strict';
/**
 * Read-only inspection of the P2-integration oracle evidence, for the post-
 * restart Hybrid smoke generation. Prints the trust-critical WHAT-layer checks
 * straight from the DB so you can eyeball them without hand-writing SQL:
 *
 *   [1] clauses extracted for the project (RequirementClause rows)
 *   [2] every case's requirementRefs cite a REAL clause (no invented id reached the DB)
 *   [3] no `must` assertion carries app-origin provenance (the anti-circular rule)
 *   [4] RTM uncovered-requirement findings (Discrepancy rows)
 *
 * Usage:  node scripts/inspect_oracle_evidence.cjs [projectId]
 *   no projectId → inspects the most recent ScenarioGeneration's project.
 *
 * READ-ONLY: only SELECTs, never writes — safe against the live dev.db. Uses raw
 * SQL for the P2 columns so it works even if the Prisma client predates the
 * RequirementClause regen.
 *
 * Server-log evidence (run during generation, not in the DB):
 *   [1'] "Requirement context: HYBRID (data-minimized) … source bodies NOT sent"
 *   [3'] "traceability: stripped N requirementRef(s) that cite no real clause"
 *   [6 ] legacy fallback: generate on a project with NO BRD/US/RN docs → the log
 *        shows NO "HYBRID" line and cases still generate (additive path).
 */
// Load DATABASE_URL the same way the server does, so this runs standalone from
// any shell (matches server/index.js). Without this, PrismaClient throws
// "Environment variable not found: DATABASE_URL".
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APP_ORIGIN = new Set(['website', 'atlas', 'app', 'live_site']);
const parse = (j, fb) => { try { return JSON.parse(j); } catch (_) { return fb; } };

(async () => {
  let issues = 0;
  const args = process.argv.slice(2);
  const countMode = args.includes('--count');
  const argId = args.find((a) => !a.startsWith('--')) || null;

  // --count: print the current RequirementClause count for a project and exit.
  // Runnable BEFORE a generation (no generation required) to capture a baseline,
  // so you can confirm the count increased/refreshed after the smoke.
  if (countMode) {
    if (!argId) { console.log('\nUsage: node scripts/inspect_oracle_evidence.cjs --count <projectId>\n'); await prisma.$disconnect(); return; }
    let n = 0;
    try { const r = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "RequirementClause" WHERE "projectId" = ?', argId); n = Number((r[0] && r[0].n) || 0); }
    catch (e) { console.log(`(RequirementClause count failed: ${e.message})`); }
    console.log(`\n[baseline ${new Date().toISOString()}] project ${argId}: RequirementClause count = ${n}\n`);
    await prisma.$disconnect();
    return;
  }

  // Target the CURRENT generation (what the UI shows + what /generate marks),
  // falling back to the highest version. NOT createdAt — a legacy "Initial
  // generation" row can carry an odd timestamp that sorts ahead of real ones.
  const where = argId ? { projectId: argId } : {};
  let gen = await prisma.scenarioGeneration.findFirst({ where: { ...where, isCurrent: true }, orderBy: { version: 'desc' } });
  if (!gen) gen = await prisma.scenarioGeneration.findFirst({ where, orderBy: { version: 'desc' } });
  if (!gen) { console.log('\nNo ScenarioGeneration found — run a generation first.\n'); await prisma.$disconnect(); return; }
  const projectId = gen.projectId;
  let projName = '';
  try { const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }); projName = (p && p.name) ? p.name : ''; } catch (_) { /* old client */ }
  console.log(`\n=== P2-integration acceptance evidence · ${new Date().toISOString()} ===`);
  console.log(`Project ${projectId}${projName ? ` "${projName}"` : ''} · generation v${gen.version} (${gen.id})  ${gen.label || ''}`);

  // [1] Clause set — raw SQL (regen-independent).
  let clauseRows = [];
  try {
    clauseRows = await prisma.$queryRawUnsafe('SELECT "id", "sourceType" FROM "RequirementClause" WHERE "projectId" = ?', projectId);
  } catch (e) { console.log(`  (RequirementClause read failed: ${e.message})`); }
  const clauseIds = new Set(clauseRows.map((r) => r.id));
  console.log(`\n[1] Clauses extracted for project: ${clauseIds.size}`);
  if (!clauseIds.size) console.log('    ⚠ none yet — confirm the project has BRD/US/RN docs and you ran a Hybrid generation AFTER the restart.');
  else console.log('    (acceptance: nonzero + consistent with the uploaded docs. A STABLE count across re-runs is EXPECTED — content-hash dedupe reuses existing clauses, so it need not increase.)');

  // Cases in this generation — raw SQL (requirementRefs column is regen-independent this way).
  let cases = [];
  try {
    cases = await prisma.$queryRawUnsafe('SELECT "id", "name", "requirementRefs", "declaredAssertions", "automatability" FROM "TestCase" WHERE "generationId" = ?', gen.id);
  } catch (e) { console.log(`  (TestCase read failed: ${e.message})`); }
  console.log(`Cases in generation: ${cases.length}`);

  // [2] requirementRefs validity — invented ids must have been stripped by Node.
  let traced = 0, invalid = 0;
  for (const c of cases) {
    const refs = parse(c.requirementRefs, []) || [];
    if (Array.isArray(refs) && refs.length) {
      traced++;
      for (const r of refs) if (!clauseIds.has(r)) { invalid++; console.log(`    ✗ case "${c.name}" cites unknown clause ${r}`); }
    }
  }
  console.log(`\n[2] Cases traced to clauses: ${traced}/${cases.length}; invalid refs stored: ${invalid}`);
  if (invalid > 0) { issues++; console.log('    ✗ invented ids reached the DB — markRequirementRefs should have stripped them.'); }
  else console.log('    ✓ every stored requirementRef cites a real clause (Node disposed correctly)');

  // [3] anti-circular — no must with app-origin provenance.
  let mustTotal = 0, mustAppOrigin = 0;
  for (const c of cases) {
    if (c.automatability === 'manual') continue;
    for (const a of (parse(c.declaredAssertions, []) || [])) {
      if (!a || a.parseFailed) continue;
      if ((a.criticality || 'must') === 'must') {
        mustTotal++;
        if (APP_ORIGIN.has(String(a.provenance || '').toLowerCase())) { mustAppOrigin++; console.log(`    ✗ case "${c.name}" — must with provenance=${a.provenance}`); }
      }
    }
  }
  console.log(`\n[3] must assertions: ${mustTotal}; with app-origin provenance: ${mustAppOrigin}`);
  if (mustAppOrigin > 0) { issues++; console.log('    ✗ anti-circular violation — a must must not source its expected value from the live app/atlas.'); }
  else console.log('    ✓ no must carries website/atlas/app provenance');

  // [4] RTM uncovered findings.
  let findings = [];
  try {
    findings = await prisma.discrepancy.findMany({ where: { projectId, kind: 'requirement_uncovered' }, orderBy: { createdAt: 'desc' }, take: 100 });
  } catch (e) { console.log(`  (Discrepancy read failed: ${e.message})`); }
  console.log(`\n[4] RTM uncovered-requirement findings: ${findings.length}`);
  findings.slice(0, 5).forEach((f) => console.log(`    • ${f.summary}`));
  if (findings.length > 5) console.log(`    … and ${findings.length - 5} more`);

  console.log(`\n${issues === 0 ? 'OK — oracle evidence consistent' : 'CHECK — ' + issues + ' issue(s); see ✗ lines'}\n`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error('inspect failed:', e.message); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
