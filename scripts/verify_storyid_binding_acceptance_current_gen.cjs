'use strict';
/*
 * STEP 3B/3C ACCEPTANCE — CURRENT-GENERATION scope.
 *
 * Regeneration is NON-DESTRUCTIVE: each generate creates a new ScenarioGeneration and
 * KEEPS prior generations' cases as immutable history (so the user can browse/re-select
 * past versions). The project-wide check (verify_storyid_binding_acceptance.cjs) therefore
 * still counts the frozen pre-3B cases and cannot reach 0 without deleting history.
 *
 * The meaningful acceptance metric is the CURRENT generation — the set the platform
 * actually runs/approves/exports. This script scopes the storyId-mismatch check to the
 * isCurrent ScenarioGeneration, and ALSO prints the project-wide + per-generation
 * breakdown for full transparency.
 *
 *   node scripts/verify_storyid_binding_acceptance_current_gen.cjs [projectId]
 *
 * PASS iff the CURRENT generation has zero storyId-mismatched data bindings.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
let prisma, W, normalizeStoryId;
try {
  require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });
  const { PrismaClient } = require(path.join(ROOT, 'node_modules', '@prisma', 'client'));
  prisma = new PrismaClient();
  W = require(path.join(ROOT, 'server', 'services', 'workbookContract'));
  ({ normalizeStoryId } = require(path.join(ROOT, 'server', 'lib', 'storyId')));
} catch (e) { console.log(`SKIP — DB/env unavailable (${e.message.split('\n')[0]})`); process.exit(0); }

(async () => {
  const projectId = process.argv[2];
  if (!projectId) { console.log('usage: node scripts/verify_storyid_binding_acceptance_current_gen.cjs <projectId>'); process.exit(2); }

  const set = await prisma.testDataSet.findFirst({ where: { projectId }, select: { name: true, sheetsJson: true } });
  if (!set) { console.log('SKIP — no TestDataSet for the project.'); await prisma.$disconnect(); process.exit(0); }
  let sheets = []; try { sheets = JSON.parse(set.sheetsJson || '{}').sheets || []; } catch (_) { sheets = []; }
  const contract = W.buildWorkbookContract({ sheets });
  const sheetsForStory = new Map();
  for (const s of contract.sheets) for (const r of s.rows) {
    const sid = normalizeStoryId(r.storyId); if (!sid) continue;
    if (!sheetsForStory.has(sid)) sheetsForStory.set(sid, new Set());
    sheetsForStory.get(sid).add(s.name);
  }

  const currentGen = await prisma.scenarioGeneration.findFirst({ where: { projectId, isCurrent: true }, select: { id: true, version: true, label: true } });
  const cases = await prisma.testCase.findMany({ where: { projectId }, select: { name: true, storyId: true, dataBindingJson: true, generationId: true } });

  const evalCase = (tc) => {
    const sid = normalizeStoryId(tc.storyId); if (!sid) return { checked: false };
    let b = null; try { b = tc.dataBindingJson ? JSON.parse(tc.dataBindingJson) : null; } catch (_) { b = null; }
    if (!b || !b.sheet) return { checked: false };
    const ownerSheets = sheetsForStory.get(sid);
    const mismatch = ownerSheets && !ownerSheets.has(b.sheet);
    return { checked: true, mismatch, detail: mismatch ? { name: tc.name, storyId: sid, boundSheet: b.sheet, shouldBe: [...ownerSheets].join('/') } : null };
  };

  // Per-generation breakdown
  const byGen = new Map();
  for (const tc of cases) {
    const g = tc.generationId || '(none)';
    if (!byGen.has(g)) byGen.set(g, { total: 0, checked: 0, mismatches: [] });
    const b = byGen.get(g); b.total++;
    const r = evalCase(tc);
    if (r.checked) { b.checked++; if (r.mismatch) b.mismatches.push(r.detail); }
  }

  console.log(`project ${projectId.slice(0,8)} · workbook "${set.name}" · ${cases.length} total cases across ${byGen.size} generation(s)`);
  const genRows = await prisma.scenarioGeneration.findMany({ where: { projectId }, select: { id:true, version:true, isCurrent:true }, orderBy: { version: 'asc' } });
  const genMeta = new Map(genRows.map(g => [g.id, g]));
  for (const [gid, b] of [...byGen.entries()].sort((a,b)=>((genMeta.get(a[0])||{}).version||0)-((genMeta.get(b[0])||{}).version||0))) {
    const gm = genMeta.get(gid) || {};
    console.log(`  gen v${gm.version ?? '?'}${gm.isCurrent ? ' [CURRENT]' : ''} (${gid.slice(0,8)}): ${b.total} cases, ${b.checked} storyId+bound checked, ${b.mismatches.length} mismatched`);
  }

  const projectWideMismatches = [...byGen.values()].reduce((a,b)=>a+b.mismatches.length,0);
  console.log(`\nproject-wide storyId-mismatched bindings (incl. frozen history): ${projectWideMismatches}`);

  if (!currentGen) { console.log('SKIP — no current generation.'); await prisma.$disconnect(); process.exit(0); }
  const cur = byGen.get(currentGen.id) || { total:0, checked:0, mismatches:[] };
  console.log(`\n=== CURRENT generation v${currentGen.version} "${currentGen.label||''}" ===`);
  console.log(`cases: ${cur.total}; storyId+bound checked: ${cur.checked}; MISMATCHED: ${cur.mismatches.length}`);
  for (const m of cur.mismatches.slice(0, 20)) console.log(`  ✗ "${m.name}" [${m.storyId}] bound to "${m.boundSheet}" but that storyId lives in "${m.shouldBe}"`);

  await prisma.$disconnect();
  if (cur.mismatches.length) {
    console.log(`\nFAILED — CURRENT generation has ${cur.mismatches.length} storyId-mismatched binding(s).`);
    process.exit(1);
  }
  console.log('\nOK — the CURRENT generation has zero storyId-mismatched bindings (every data-bound case with a storyId is bound to a sheet that carries that storyId).');
  process.exit(0);
})().catch((e) => { console.error('ERR', (e && e.message) || e); process.exit(1); });
