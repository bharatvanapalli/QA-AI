'use strict';
/*
 * Read-only diagnostic for the AI failure-explanation flow.
 * Usage:
 *   node scripts/_diag_explain.cjs                  (read-only: data + schema-query check)
 *   node scripts/_diag_explain.cjs --live           (also performs the real explainFailure LLM call)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = require('../server/prisma');

const RUN_ID = 'ee29d8c8-f232-47c7-8834-b0eab639a3c3';
const RESULT_PREFIX = '8c886d1a';
const LIVE = process.argv.includes('--live');

function trunc(s, n = 160) {
  if (s == null) return s;
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

(async () => {
  // ── 1. Resolve the run + its failed results ──────────────────────────
  const run = await prisma.run.findFirst({ where: { id: RUN_ID } });
  console.log('=== RUN ===');
  console.log(run ? `id=${run.id} status=${run.status} projectId=${run.projectId}` : 'RUN NOT FOUND');
  if (!run) { await prisma.$disconnect(); return; }
  const projectId = run.projectId;

  const results = await prisma.runResult.findMany({
    where: { runId: RUN_ID },
    select: { id: true, status: true, testCaseId: true, assertionCheckResults: true, stepResults: true, failureExplanation: true },
  });
  console.log(`\n=== RUN RESULTS (${results.length}) ===`);
  for (const r of results) {
    console.log(`  ${r.id.slice(0,8)} status=${r.status} hasACR=${!!r.assertionCheckResults} hasSteps=${!!r.stepResults} hasExplanation=${!!r.failureExplanation}`);
  }

  // ── 2. Pick the target result (the one from the URL) ─────────────────
  const target = results.find((r) => r.id.startsWith(RESULT_PREFIX)) || results.find((r) => r.status === 'fail') || results[0];
  console.log(`\n=== TARGET RESULT: ${target.id} (status=${target.status}) ===`);

  // ── 3. Reproduce the EXACT query the fixed failureExplainer.js runs ──
  console.log('\n=== SCHEMA-QUERY CHECK (the part that was crashing) ===');
  try {
    const probe = await prisma.runResult.findFirst({
      where: { id: target.id },
      include: {
        testCase: {
          select: { id: true, name: true, module: true, type: true, assertions: true, declaredAssertions: true, userGuidance: true },
        },
      },
    });
    console.log('  ✓ include/select query SUCCEEDED — schema fields are valid');
    console.log(`    testCase.name   = ${probe.testCase?.name}`);
    console.log(`    testCase.module = ${probe.testCase?.module}`);
    console.log(`    testCase.type   = ${probe.testCase?.type}`);
  } catch (e) {
    console.log('  ✗ include/select query FAILED:', e.message);
  }

  // ── 4. Inspect the document-linking DATA for this project ────────────
  const [docCount, reqCount, clauseCount] = await Promise.all([
    prisma.document.count({ where: { projectId } }),
    prisma.requirement.count({ where: { projectId } }).catch(() => 'n/a'),
    prisma.requirementClause.count({ where: { projectId } }).catch(() => 'n/a'),
  ]);
  console.log('\n=== PROJECT KNOWLEDGE SOURCES ===');
  console.log(`  documents=${docCount}  requirements=${reqCount}  requirementClauses=${clauseCount}`);

  const docs = await prisma.document.findMany({
    where: { projectId },
    select: { id: true, name: true, category: true, content: true },
    take: 20,
  });
  for (const d of docs) {
    console.log(`  • [${d.category || 'uncategorized'}] ${d.name}  (${(d.content || '').length} chars)`);
  }

  // ── 5. Inspect the assertion → requirement linkage on the target case ─
  const tc = await prisma.testCase.findFirst({
    where: { id: target.testCaseId },
    select: { id: true, name: true, declaredAssertions: true },
  });
  let declared = [];
  try { declared = tc?.declaredAssertions ? JSON.parse(tc.declaredAssertions) : []; } catch (_) {}
  let acr = [];
  try { acr = target.assertionCheckResults ? JSON.parse(target.assertionCheckResults) : []; } catch (_) {}
  const acrMap = new Map(acr.map((o) => [o.assertionId, o]));

  console.log(`\n=== DECLARED ASSERTIONS on "${tc?.name}" (${declared.length}) ===`);
  for (const d of declared) {
    const oc = acrMap.get(d.id);
    console.log(`  • id=${(d.id||'?').slice(0,8)} type=${d.type} crit=${d.criticality || '-'} parseFailed=${!!d.parseFailed}`);
    console.log(`      requirementRefs = ${JSON.stringify(d.requirementRefs || [])}`);
    console.log(`      note            = ${trunc(d.note, 120)}`);
    console.log(`      payload         = ${trunc(JSON.stringify(d.payload || {}), 160)}`);
    console.log(`      outcome         = ${oc ? oc.outcome : '(no check result recorded)'}`);
    console.log(`      evidence        = ${trunc(oc?.evidence, 160)}`);
  }

  // ── 5b. Can the document-linkage fallback actually resolve a source? ──
  // The assertions carry no requirementRefs, only an inline "BR-AUTH-02" in
  // the note. failureExplainer's only path to requirement text is to regex
  // that token out and substring-match it in raw Requirement/Document content.
  const INLINE_RE = /\b([A-Z]{2,}[-_][A-Z0-9]{1,}[-_][A-Z0-9]+)\b/g;
  const inlineRefs = [...new Set(declared.flatMap((d) => (String(d.note || '').match(INLINE_RE) || [])))];
  console.log(`\n=== DOCUMENT-LINKAGE PROBE (inline refs found in notes: ${JSON.stringify(inlineRefs)}) ===`);
  for (const ref of inlineRefs) {
    const reqHit = await prisma.requirement.findFirst({ where: { projectId, content: { contains: ref } }, select: { title: true } });
    const docHit = await prisma.document.findFirst({ where: { projectId, content: { contains: ref } }, select: { name: true, content: true } });
    console.log(`  ref "${ref}": requirementMatch=${reqHit ? `"${reqHit.title}"` : 'NONE'}  documentMatch=${docHit ? `"${docHit.name}"` : 'NONE'}`);
    if (docHit) {
      const i = docHit.content.indexOf(ref);
      console.log(`     window: …${trunc(docHit.content.slice(Math.max(0, i - 80), i + 160), 240)}…`);
    }
  }

  // ── 6. (optional) the real LLM call ──────────────────────────────────
  if (LIVE) {
    console.log('\n=== LIVE explainFailure() CALL ===');
    try {
      const { explainFailure } = require('../server/services/agents/failureExplainer');
      const out = await explainFailure({ runResultId: target.id, projectId });
      console.log('  ✓ SUCCEEDED. overallSummary:');
      console.log('   ', out.overallSummary);
      console.log(`  assertionExplanations: ${out.assertionExplanations?.length || 0}`);
      for (const ae of (out.assertionExplanations || [])) {
        console.log(`   - [${(ae.assertionId||'?').slice(0,8)}] requirementContext: ${trunc(ae.requirementContext, 140)}`);
        console.log(`       whatWasFound: ${trunc(ae.whatWasFound, 120)}`);
        console.log(`       whyItFailed:  ${trunc(ae.whyItFailed, 120)}`);
      }
    } catch (e) {
      console.log('  ✗ FAILED:', e.message);
      console.log(e.stack);
    }
  } else {
    console.log('\n(skipping live LLM call — pass --live to run it)');
  }

  await prisma.$disconnect();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
