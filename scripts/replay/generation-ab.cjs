'use strict';
/**
 * Generation A/B replay harness — authoring-layer candidate-vs-baseline.
 *
 * This is the *authoring* counterpart to the execution-replay checks under
 * scripts/replay/checks/ (which iterate a runId corpus and read RunResult rows).
 * Those measure what the CONDUCTOR produced; this measures what the ARCHITECT
 * produces — the layer P3d actually changed.
 *
 * It runs the Architect TWICE on one project, with identical model / provider /
 * requirements / shared clause corpus, differing ONLY in scope — faithfully
 * mirroring server/routes/scenarios.js POST /generate:
 *
 *   baseline  = whole-project   (no module, no capability menu, ALL clauses,
 *                                newest atlas)                       ← pre-P3d
 *   candidate = module-scoped   (module + verified capability menu +
 *                                clauses ranked to the module, slice atlas) ← P3d
 *
 * and reports the delta on the metrics the authoring change actually controls:
 *   - stop_reason          (max_tokens truncation is the P2 failure P3d fixes)
 *   - input / output tokens
 *   - scenarios / cases authored
 *   - operations[] bound + capabilityRef→atlas resolution rate  (grounding)
 *   - operations dropped / cases left incomplete  (Node-disposed hallucinations)
 *
 * It does NOT execute anything and does NOT persist — pure measurement, nothing
 * wiped. Two live Architect calls (one per arm) are made; on a BYOK key this is
 * ~two generations of cost. Run with the backend up or down; reads only.
 *
 * Execution pass/block rate is a *downstream* measure confounded by live-site
 * load + batch effects (a spec that passes solo fails in a parallel batch as the
 * demo degrades). It is NOT isolated by an authoring A/B and is deliberately NOT
 * claimed here — see the footer note.
 *
 *   node scripts/replay/generation-ab.cjs [projectId] [--module=pim] [--max-clauses=40] [--json]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const architect = require('../../server/services/agents/architect');
const { resolveAiCredentials } = require('../../server/lib/resolveAiCredentials');
const oracle = require('../../server/services/requirementOracle');
const cal = require('../../server/services/agents/calibrator');
const reqCtx = require('../../server/services/requirementContext');

const argv = process.argv.slice(2);
const PID = argv.find((a) => !a.startsWith('--')) || '9675bfde-acb2-4eda-aaed-b6694b88f920'; // Orange HRM
const MODULE = ((argv.find((a) => a.startsWith('--module=')) || '--module=pim').split('=')[1] || 'pim').trim();
const MAXC = parseInt((argv.find((a) => a.startsWith('--max-clauses=')) || '--max-clauses=40').split('=')[1], 10) || 40;
const JSON_OUT = argv.includes('--json');

// ── per-arm metric extraction (pure; tolerant of a null/threw result) ──
function measureArm(label, result, elapsedMs, caps, lastStop) {
  const capIds = new Set((caps || []).map((c) => String(c.capabilityId || c.name).toLowerCase()).filter(Boolean));
  const m = {
    label, ok: true, error: null,
    stopReason: (result && result.stopReason) || lastStop || 'unknown',
    tokensIn: (result && result.tokens && result.tokens.input_tokens) ?? null,
    tokensOut: (result && result.tokens && result.tokens.output_tokens) ?? null,
    elapsedMs,
    scenarios: 0, cases: 0,
    casesWithOps: 0, totalOps: 0, opCounts: {},
    refTotal: 0, refResolved: 0,
    dropped: 0, incomplete: 0,
  };
  const scns = (result && Array.isArray(result.scenarios)) ? result.scenarios : [];
  m.scenarios = scns.length;
  for (const s of scns) {
    const cases = Array.isArray(s.cases) ? s.cases : [];
    m.cases += cases.length;
    for (const c of cases) {
      const ops = Array.isArray(c.operations) ? c.operations : [];
      if (ops.length) m.casesWithOps++;
      if (c.operationStatus === 'incomplete') m.incomplete++;
      m.dropped += Array.isArray(c.operationsDropped) ? c.operationsDropped.length : 0;
      for (const op of ops) {
        m.totalOps++;
        const name = op && op.operation;
        if (name) m.opCounts[name] = (m.opCounts[name] || 0) + 1;
        if (op && op.capabilityRef) {
          m.refTotal++;
          if (capIds.has(String(op.capabilityRef).toLowerCase())) m.refResolved++;
        }
      }
    }
  }
  return m;
}

function stopWatcher() {
  let last = null;
  return {
    onLog: async (_lvl, msg) => { const mm = /stop=(\w+)/.exec(String(msg || '')); if (mm) last = mm[1]; },
    get: () => last,
  };
}

function opCountStr(counts) {
  const e = Object.entries(counts);
  return e.length ? e.map(([k, v]) => `${k}×${v}`).join(', ') : '(none)';
}
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function num(v) { return v == null ? '?' : String(v); }

(async () => {
  const t0 = Date.now();
  const project = await prisma.project.findUnique({ where: { id: PID } });
  if (!project) throw new Error('project not found: ' + PID);
  let userId = null;
  if (project.orgId) { const org = await prisma.organization.findUnique({ where: { id: project.orgId } }); userId = org && org.ownerId; }
  if (!userId) { const u = await prisma.user.findFirst({ select: { id: true } }); userId = u && u.id; }
  const { provider, apiKey, model } = await resolveAiCredentials(userId, project);
  if (!apiKey) throw new Error('no API key resolved');
  if (!JSON_OUT) console.log(`\n=== Generation A/B · ${project.name} · provider=${provider} model=${model} · module="${MODULE}" ===`);

  // ── shared inputs: one clause prep, same requirements + test data for both arms ──
  const priorModules = await prisma.testScenario.findMany({ where: { projectId: PID }, select: { module: true }, distinct: ['module'], take: 50 });
  const knownModulesAll = Array.from(new Set(priorModules.map((s) => s.module).filter(Boolean)));
  const clausePrep = await oracle.prepareArchitectClauses({
    prisma, projectId: PID, providerName: provider, apiKey, model, knownModules: knownModulesAll, log: console,
  });
  const requirements = await prisma.requirement.findMany({ where: { projectId: PID } });
  const testData = await require('../../server/services/testDataContext').loadTestDataContext(PID);
  if (!JSON_OUT) console.log(`  shared corpus: ${clausePrep.requirementClauses.length} clause(s), mode=${clausePrep.contextMode}, knownModules=[${knownModulesAll.join(', ')}]`);

  // ── BASELINE arm — whole-project (pre-P3d): all clauses, newest atlas, no menu ──
  if (!JSON_OUT) console.log(`\n[baseline] whole-project Architect (${clausePrep.requirementClauses.length} clauses, no capability menu)…`);
  const baseCtx = await cal.getCalibrationContext(PID).catch(() => null);
  const baseWatch = stopWatcher();
  let baseResult = null, baseErr = null;
  let tb = Date.now();
  try {
    baseResult = await architect.run({
      apiKey, model, provider, requirements,
      onLog: baseWatch.onLog,
      extraGuidance: project.aiGuidance || null,
      siteContext: baseCtx, testData,
      requirementClauses: clausePrep.requirementClauses,
      contextMode: clausePrep.contextMode,
      knownModules: clausePrep.knownModules,
      capabilities: [], module: null,
    });
  } catch (e) { baseErr = e; }
  const base = measureArm('baseline', baseResult, Date.now() - tb, [], baseWatch.get());
  if (baseErr) { base.ok = false; base.error = baseErr.message; }
  if (!JSON_OUT) console.log(`  → ${base.ok ? `${base.scenarios} scn / ${base.cases} cases` : `THREW: ${base.error}`}; stop=${base.stopReason}`);

  // ── CANDIDATE arm — module-scoped (P3d): ranked clauses, slice atlas, menu ──
  const sliceOpts = { module: MODULE, authProfileId: null };
  const candCtx = await cal.getCalibrationContext(PID, sliceOpts).catch(() => null);
  const candAtlas = await cal.getCalibrationAtlas(PID, sliceOpts).catch(() => null);
  const caps = (candAtlas && Array.isArray(candAtlas.capabilities)) ? candAtlas.capabilities : [];
  const scoped = clausePrep.requirementClauses.length
    ? reqCtx.rankClauses(clausePrep.requirementClauses, MODULE, { maxClauses: MAXC, knownModules: [MODULE] }).kept
    : [];
  if (!JSON_OUT) console.log(`\n[candidate] module-scoped Architect (${scoped.length} clauses ≤${MAXC}, ${caps.length} verified capabilities in menu, slice=${JSON.stringify(candAtlas && candAtlas.slice)})…`);
  const candWatch = stopWatcher();
  let candResult = null, candErr = null;
  let tc = Date.now();
  try {
    candResult = await architect.run({
      apiKey, model, provider, requirements,
      onLog: candWatch.onLog,
      extraGuidance: project.aiGuidance || null,
      siteContext: candCtx, testData,
      requirementClauses: scoped,
      contextMode: clausePrep.contextMode,
      knownModules: [MODULE],
      capabilities: caps, module: MODULE,
    });
  } catch (e) { candErr = e; }
  const cand = measureArm('candidate', candResult, Date.now() - tc, caps, candWatch.get());
  if (candErr) { cand.ok = false; cand.error = candErr.message; }
  if (!JSON_OUT) console.log(`  → ${cand.ok ? `${cand.scenarios} scn / ${cand.cases} cases` : `THREW: ${cand.error}`}; stop=${cand.stopReason}`);

  const report = {
    project: { id: PID, name: project.name, provider, model },
    module: MODULE, maxClauses: MAXC,
    sharedClauseCount: clausePrep.requirementClauses.length,
    scopedClauseCount: scoped.length,
    capabilitiesInMenu: caps.length,
    baseline: base, candidate: cand,
    note: 'Authoring-layer A/B only. Execution pass/block rate is downstream and confounded by live-site load + batch effects; not measured here.',
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    await prisma.$disconnect();
    return;
  }

  // ── delta table ──
  const W = 26, A = 26, B = 26;
  const row = (label, a, b) => console.log(`  ${pad(label, W)}${pad(a, A)}${pad(b, B)}`);
  console.log(`\n=== A/B DELTA — baseline (whole-project) vs candidate (module-scoped "${MODULE}") ===\n`);
  row('metric', 'baseline', 'candidate');
  row('─'.repeat(W - 2), '─'.repeat(A - 2), '─'.repeat(B - 2));
  row('stop_reason', base.stopReason + (base.ok ? '' : ' (threw)'), cand.stopReason);
  row('clauses fed', base.ok ? clausePrep.requirementClauses.length : clausePrep.requirementClauses.length, scoped.length);
  row('input tokens', num(base.tokensIn), num(cand.tokensIn));
  row('output tokens', num(base.tokensOut), num(cand.tokensOut));
  row('scenarios authored', base.scenarios, cand.scenarios);
  row('cases authored', base.cases, cand.cases);
  row('cases with operations[]', base.casesWithOps, cand.casesWithOps);
  row('operations bound', base.totalOps, cand.totalOps);
  row('  by operation', opCountStr(base.opCounts), opCountStr(cand.opCounts));
  row('capabilityRef resolved', `${base.refResolved}/${base.refTotal}`, `${cand.refResolved}/${cand.refTotal}`);
  row('operations dropped', base.dropped, cand.dropped);
  row('cases incomplete', base.incomplete, cand.incomplete);
  row('elapsed', (base.elapsedMs / 1000).toFixed(1) + 's', (cand.elapsedMs / 1000).toFixed(1) + 's');

  // ── verdict lines (derived, not asserted) ──
  console.log('\n## Read');
  if (base.stopReason === 'max_tokens' && cand.stopReason !== 'max_tokens') {
    console.log(`  • Truncation: baseline hit max_tokens (output truncated → recovery salvages a partial/garbled set); candidate finished cleanly (stop=${cand.stopReason}). P3d eliminates the whole-project truncation.`);
  } else if (base.stopReason === cand.stopReason) {
    console.log(`  • Truncation: both arms stopped on "${base.stopReason}" — no truncation delta on this corpus (scope is small enough that whole-project also fits). Token/grounding deltas below still hold.`);
  }
  if (base.tokensOut != null && cand.tokensOut != null) {
    const d = base.tokensOut - cand.tokensOut;
    console.log(`  • Output tokens: ${num(base.tokensOut)} → ${num(cand.tokensOut)} (${d >= 0 ? '−' : '+'}${Math.abs(d)} on the candidate).`);
  }
  console.log(`  • Grounding: candidate bound ${cand.totalOps} operation(s) to verified capabilities (${cand.refResolved}/${cand.refTotal} capabilityRef resolved, ${cand.dropped} dropped, ${cand.incomplete} cases incomplete); baseline bound ${base.totalOps} (whole-project emits prose steps only — nothing is bound to a verified capability, so element references are improvised at execution time).`);
  console.log(`\n## Not measured here`);
  console.log(`  Execution pass/block rate is downstream of authoring and confounded by live-site load + parallel batch degradation (same spec passes solo, fails in a batch). An authoring A/B cannot isolate it; this harness deliberately does not claim a pass/block delta.`);
  console.log(`\n=== DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s ===\n`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error('\nA/B HARNESS FAILED:', e.message, '\n', e.stack); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
