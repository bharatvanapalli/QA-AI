'use strict';
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client'));
const p = new PrismaClient();
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';

(async () => {
  const run = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const { buildReplayExport } = require(path.join(ROOT, 'server', 'services', 'codegen', 'replayExport'));
  const out = await buildReplayExport({ projectId: PID, runId: run.id, validate: false });
  const specPath = Object.keys(out.files).find((f) => /authentication\/.*\.spec\.(ts|js)$/.test(f));
  console.log('=== SPEC:', specPath, '===\n');
  console.log(out.files[specPath]);
  // Also print the replayir support locator block (where the per-step locators live)
  const support = Object.keys(out.files).find((f) => /replayir\.(ts|js)$/.test(f));
  if (support) {
    const body = out.files[support];
    // print just the resolve/locator lines to see the strategies used
    const loc = body.split(/\r?\n/).filter((l) => /getBy|locator\(|resolve|placeholder|getByRole|getByLabel|getByTestId|name=|#/.test(l)).slice(0, 40);
    console.log('\n=== replayir support — locator lines (strategy sample) ===');
    console.log(loc.join('\n'));
  }
  await p.$disconnect();
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
