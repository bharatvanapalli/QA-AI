'use strict';
/*
 * STEP 3B/3C ACCEPTANCE (req 7) — storyId-mismatched data binding must disappear.
 * For each case that HAS a storyId AND a data-bound sheet, the bound sheet MUST
 * carry that storyId in the WorkbookContract. A case for US-OHRM-005 bound to
 * Admin_UserSearch (which carries no US-OHRM-005 row) is the exact misbinding 3B
 * fixes. Standalone diagnostic (DB-dependent; NOT in the code bundle).
 *
 *   node scripts/verify_storyid_binding_acceptance.cjs [projectId]
 *
 * Currently EXPECTED TO FAIL on stale pre-3B generations (proving it detects the
 * bug); rerun after a REGEN (or re-resolve) — it then passes. Skips if no DB/data.
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
  const arg = process.argv[2] || null;
  // Pick the project with the richest workbook if none given.
  let projectId = arg;
  if (!projectId) {
    const sets = await prisma.testDataSet.findMany({ select: { projectId: true, sheetsJson: true } });
    let best = null;
    for (const s of sets) { let n = 0; try { n = (JSON.parse(s.sheetsJson || '{}').sheets || []).length; } catch (_) { n = 0; } if (!best || n > best.n) best = { projectId: s.projectId, n }; }
    projectId = best && best.projectId;
  }
  if (!projectId) { console.log('SKIP — no project with test data.'); await prisma.$disconnect(); process.exit(0); }

  const set = await prisma.testDataSet.findFirst({ where: { projectId }, select: { name: true, sheetsJson: true } });
  if (!set) { console.log('SKIP — no TestDataSet for the project.'); await prisma.$disconnect(); process.exit(0); }
  let sheets = []; try { sheets = JSON.parse(set.sheetsJson || '{}').sheets || []; } catch (_) { sheets = []; }
  const contract = W.buildWorkbookContract({ sheets });
  // storyId → set of sheets that carry it
  const sheetsForStory = new Map();
  for (const s of contract.sheets) for (const r of s.rows) {
    const sid = normalizeStoryId(r.storyId); if (!sid) continue;
    if (!sheetsForStory.has(sid)) sheetsForStory.set(sid, new Set());
    sheetsForStory.get(sid).add(s.name);
  }

  const cases = await prisma.testCase.findMany({ where: { projectId }, select: { name: true, storyId: true, dataBindingJson: true } });
  let checked = 0; const mismatches = [];
  for (const tc of cases) {
    const sid = normalizeStoryId(tc.storyId); if (!sid) continue;
    let b = null; try { b = tc.dataBindingJson ? JSON.parse(tc.dataBindingJson) : null; } catch (_) { b = null; }
    if (!b || !b.sheet) continue;            // not data-bound to a sheet → nothing to check
    checked++;
    const ownerSheets = sheetsForStory.get(sid);
    if (ownerSheets && !ownerSheets.has(b.sheet)) {
      mismatches.push({ name: tc.name, storyId: sid, boundSheet: b.sheet, shouldBe: [...ownerSheets].join('/') });
    }
  }

  console.log(`project ${projectId.slice(0, 8)} · workbook "${set.name}" · ${cases.length} cases`);
  console.log(`data-bound cases with a storyId checked: ${checked}; storyId-MISMATCHED bindings: ${mismatches.length}`);
  for (const m of mismatches.slice(0, 15)) console.log(`  ✗ "${m.name}" [${m.storyId}] bound to "${m.boundSheet}" but that storyId lives in "${m.shouldBe}"`);
  await prisma.$disconnect();
  if (mismatches.length) {
    console.log(`\nFAILED — ${mismatches.length} storyId-mismatched binding(s). REGENERATE (or re-resolve) so storyId-first binding takes effect; these are stale pre-3B bindings.`);
    process.exit(1);
  }
  console.log('\nOK — every data-bound case with a storyId is bound to a sheet that actually carries that storyId (no storyId-mismatched binding).');
  process.exit(0);
})().catch((e) => { console.error('ERR', (e && e.message) || e); process.exit(1); });
