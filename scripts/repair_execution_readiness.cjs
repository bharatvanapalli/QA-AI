'use strict';
/*
 * ONE-TIME repair: apply the ExecutionReadinessCompiler to an ALREADY-PERSISTED
 * generation so an existing suite becomes executable without regenerating (no LLM
 * cost). Injects the compiled login prelude + credential binding into every
 * authenticated case that does not self-authenticate. Idempotent — an injected case
 * then self-authenticates, so re-running is a no-op.
 *
 * Usage: node scripts/repair_execution_readiness.cjs <generationId> [--apply]
 *   without --apply → DRY RUN (prints what would change, writes nothing).
 */
const path = require('path');
const root = path.join(__dirname, '..');
process.env.DATABASE_URL = process.env.DATABASE_URL || `file:${path.join(root, 'prisma', 'dev.db')}`;
const { PrismaClient } = require(path.join(root, 'server', 'node_modules', '@prisma', 'client'));
const erc = require(path.join(root, 'server', 'services', 'executionReadinessCompiler.js'));

const genId = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!genId) { console.error('usage: node scripts/repair_execution_readiness.cjs <generationId> [--apply]'); process.exit(2); }

(async () => {
  const p = new PrismaClient();
  const rows = await p.testCase.findMany({ where: { generationId: genId },
    select: { id: true, name: true, steps: true, assertions: true, module: true, automatability: true, dataBindingJson: true, scenarioId: true } });
  if (!rows.length) { console.error(`no cases for generation ${genId}`); await p.$disconnect(); process.exit(1); }

  const byScn = new Map();
  for (const c of rows) {
    const arr = byScn.get(c.scenarioId) || [];
    arr.push({ ...c, dataBinding: (() => { try { return JSON.parse(c.dataBindingJson || 'null'); } catch { return null; } })() });
    byScn.set(c.scenarioId, arr);
  }
  const scenarios = [...byScn.entries()].map(([id, cs]) => ({ id, cases: cs }));

  const tmpl = erc.harvestLoginTemplate(scenarios);
  console.log(`login template: ${tmpl ? `"${tmpl.sourceCase}" (${tmpl.prelude.length} steps, creds=${tmpl.credSheet})` : 'NONE — cannot repair authenticated cases'}`);
  const { report } = erc.compileExecutionReadiness({ scenarios });
  console.log(`report: total=${report.total} injected=${report.injected} selfAuth=${report.selfAuth} noSetupNeeded=${report.noSetupNeeded} dropped=${report.dropped.length}`);
  if (report.dropped.length) console.log('  dropped (would NOT persist):', JSON.stringify(report.dropped));

  const toUpdate = [];
  for (const s of scenarios) for (const c of s.cases) {
    if (c._execReadiness === 'login_setup_injected') {
      toUpdate.push({ id: c.id, name: c.name, steps: c.steps, dataBindingJson: JSON.stringify(c.dataBinding) });
    }
  }
  console.log(`\n${toUpdate.length} case(s) to repair:`);
  for (const u of toUpdate) console.log(`  - ${u.name}`);

  if (!APPLY) { console.log('\nDRY RUN (no --apply) — nothing written.'); await p.$disconnect(); return; }
  let n = 0;
  for (const u of toUpdate) {
    await p.testCase.update({ where: { id: u.id }, data: { steps: u.steps, dataBindingJson: u.dataBindingJson } });
    n += 1;
  }
  console.log(`\nAPPLIED: updated ${n} case(s) with injected login setup + credential binding.`);
  await p.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
