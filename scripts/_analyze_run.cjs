'use strict';
// Post-run analyzer: (1) reuse-vs-snapshot-ref tally from the observe log,
// (2) per-step locator source + gaps + checkpoint statuses/flips from the persisted IR
// + WS log, (3) materializes the generated output files to _run_output/ for the audit
// agents. Writes _run_analysis.md + _run_analysis.json.
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const replayExport = require('../server/services/codegen/replayExport');

const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const LOG = path.join(ROOT, '_run_observe.log');
const OUTDIR = path.join(ROOT, '_run_output');
const FRAMEWORK = 'playwright-pom-js';

function readLog() { try { return fs.readFileSync(LOG, 'utf8').split(/\r?\n/); } catch { return []; } }

(async () => {
  const lines = readLog();
  // run id from log
  const runIdMatch = lines.map((l) => (l.match(/runId=([0-9a-f-]{36})/) || [])[1]).find(Boolean)
    || (lines.map((l) => (l.match(/run=([0-9a-f-]{36})/) || [])[1]).find(Boolean));
  const run = await prisma.run.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { startedAt: 'desc' } });
  const RUN_ID = run.id;

  // ── (1) reuse vs snapshot-ref tally ──
  const tally = {
    memoryReused: lines.filter((l) => /Project memory reused/.test(l)).length,
    liveRefDispatch: lines.filter((l) => /Live-ref fast path: ref .* is present/.test(l)).length,
    verifiedSnapshot: lines.filter((l) => /with verified (pre-action snapshot|KB) locator/.test(l)).length,
    codegenExcavated: lines.filter((l) => /codegen locator excavated separately/.test(l)).length,
    quarantined: lines.filter((l) => /quarantined \(health 0\)/.test(l)).length,
  };
  const reusedElements = [...new Set(lines.map((l) => (l.match(/Project memory reused (.+?)\./) || [])[1]).filter(Boolean))];

  // ── checkpoint statuses + flips from WS log ──
  const checks = {}; // stepIndex → [statuses in order]
  for (const l of lines) {
    const m = l.match(/step\.operationCheck .*stepIndex=(\d+) kind=(\w+) matched=(\w+)/);
    const s = l.match(/status=(\w+) stepIndex=(\d+)/);
    if (m) {
      const idx = m[1];
      (checks[idx] = checks[idx] || { kinds: new Set(), statuses: [] }).kinds.add(m[2]);
    }
    const oc = l.match(/step\.operationCheck .*status=(\w+) stepIndex=(\d+)/);
    if (oc) (checks[oc[2]] = checks[oc[2]] || { kinds: new Set(), statuses: [] }).statuses.push(oc[1]);
  }
  const completeStatus = {}; // stepIndex → final step.complete status
  for (const l of lines) {
    const c = l.match(/step\.complete .*status=(\w+) stepIndex=(\d+)/);
    if (c) (completeStatus[c[2]] = completeStatus[c[2]] || []).push(c[1]);
  }
  const flips = Object.entries(completeStatus)
    .filter(([, arr]) => arr.some((s) => s === 'fail' || s === 'blocked') && arr[arr.length - 1] === 'pass')
    .map(([idx, arr]) => ({ stepIndex: Number(idx), sequence: arr }));

  // ── (2) IR per-step locator source + gaps ──
  const results = await prisma.runResult.findMany({ where: { runId: RUN_ID }, select: { id: true, status: true, replayIrJson: true } });
  const irReport = [];
  for (const r of results) {
    let env = null; try { env = JSON.parse(r.replayIrJson); } catch {}
    const ir = env && (env.ir || env);
    const steps = (ir && ir.steps) || [];
    const gaps = (env && env.gaps) || [];
    const sources = { gold: 0, exportSafeUnverified: 0, none: 0 };
    const stepDetail = [];
    for (const s of steps) {
      if (s.op !== 'resolve' && s.op !== 'act') continue;
      const al = s.actionLocator;
      const conf = s.locatorConfidence;
      const expr = al && (al.frameworkExpressions && al.frameworkExpressions.playwright || al.expression);
      let src = 'none';
      if (al && conf !== 'unverified') src = 'gold';
      else if (conf === 'unverified' || expr) src = 'exportSafeUnverified';
      if (s.op === 'resolve') { sources[src] = (sources[src] || 0) + 1; stepDetail.push({ as: s.as, label: s.elementLabel, src, expr: expr || (s.candidates && s.candidates[0] && (s.candidates[0].expression || s.candidates[0].selector)) || null }); }
    }
    irReport.push({ runResultId: r.id, status: r.status, complete: env && env.complete, stepCount: steps.length, resolveCount: stepDetail.length, gapCount: gaps.length, gapCodes: gaps.map((g) => g.code), sources, stepDetail });
  }

  // ── (3) materialize output files ──
  let exportInfo = { ok: false };
  try {
    const res = await replayExport.buildReplayExport({ projectId: PROJECT_ID, runId: RUN_ID, framework: FRAMEWORK, validate: false, allowIncompletePreview: true });
    const files = res.files || {};
    fs.rmSync(OUTDIR, { recursive: true, force: true });
    for (const [rel, content] of Object.entries(files)) {
      const fp = path.join(OUTDIR, rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
    exportInfo = { ok: true, fileCount: Object.keys(files).length, allBlocked: res.allBlocked, files: Object.keys(files), specFiles: Object.keys(files).filter((f) => /\.spec\.(js|ts)$/.test(f)), pageFiles: Object.keys(files).filter((f) => /^pages\//.test(f)) };
  } catch (e) { exportInfo = { ok: false, error: String(e && e.message) }; }

  const out = { RUN_ID, runStatus: run.status, tally, reusedElements, checkpointFlips: flips, completeStatusByStep: completeStatus, irReport, exportInfo, outputDir: OUTDIR };
  fs.writeFileSync(path.join(ROOT, '_run_analysis.json'), JSON.stringify(out, null, 2));

  // human summary
  const md = [];
  md.push(`# Run analysis — ${RUN_ID} (status: ${run.status})`);
  md.push(`\n## Stored-locator reuse vs fresh resolution`);
  md.push(`- Project-memory REUSED: ${tally.memoryReused} interactions → ${reusedElements.join(', ')}`);
  md.push(`- Live-ref dispatch (no gold, ref in snapshot): ${tally.liveRefDispatch}`);
  md.push(`- Codegen locator excavated at dispatch: ${tally.codegenExcavated}`);
  md.push(`- Locators quarantined (forced recovery): ${tally.quarantined}`);
  md.push(`\n## Checkpoint flips (marked fail/blocked AT step → recovered → pass)`);
  if (flips.length) for (const f of flips) md.push(`- step ${f.stepIndex}: ${f.sequence.join(' → ')}`);
  else md.push(`- none (every step passed first attempt)`);
  md.push(`\n## Per-case IR locator sources`);
  for (const c of irReport) {
    md.push(`- result ${c.runResultId} status=${c.status} complete=${c.complete} | resolves=${c.resolveCount} gold=${c.sources.gold} exportSafe=${c.sources.exportSafeUnverified} none=${c.sources.none} | gaps=${c.gapCount} [${[...new Set(c.gapCodes)].join(',')}]`);
    for (const sd of c.stepDetail) md.push(`    · ${sd.label} → ${sd.src} :: ${sd.expr || '(no expr)'}`);
  }
  md.push(`\n## Output files`);
  md.push(JSON.stringify(exportInfo, null, 2));
  fs.writeFileSync(path.join(ROOT, '_run_analysis.md'), md.join('\n'));
  console.log('ANALYSIS_DONE RUN_ID=' + RUN_ID + ' files=' + (exportInfo.fileCount || 0) + ' flips=' + flips.length + ' reused=' + tally.memoryReused);
  await prisma.$disconnect();
})().catch((e) => { console.error('ANALYZE_FATAL', e); process.exit(1); });
