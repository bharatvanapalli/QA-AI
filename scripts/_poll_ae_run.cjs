'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();

const RUN_ID = '30637d3e-e147-452f-b94f-3bc3c306043e';
const PROJECT_ID = '4cc6772c-ea93-4c26-b478-48d779d1fccb';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assessSpec(content) {
  const issues = [];
  const notes = [];
  if (/SYNTAX ERROR|Duplicate declaration|Missing semicolon/i.test(content)) issues.push('SYNTAX MARKERS');
  if (!/(require\(|from ['"]@playwright)/.test(content)) issues.push('no import');
  if (!/(^|\n)\s*(test|it)\s*\(/.test(content)) issues.push('no test() block');
  if (!content.includes('expect(')) issues.push('no expect()');
  if (!content.includes('await ')) issues.push('no await');
  const goodLocators = (content.match(/getByRole\(|getByText\(|getByLabel\(|getByPlaceholder\(/g) || []).length;
  const cssLocators = (content.match(/\.locator\(['"][\.\#]/g) || []).length;
  notes.push(`${goodLocators} role/text/label locators, ${cssLocators} CSS-class locators`);
  notes.push(`${content.split('\n').length} lines`);
  if (content.includes('process.env.')) notes.push('uses env vars');
  if (/networkidle|waitForLoadState|waitForSelector/i.test(content)) notes.push('has load-state handling');
  return { issues, notes, clean: issues.length === 0 };
}

(async () => {
  console.log('Polling run ' + RUN_ID + '\n');
  const maxWait = 50 * 60 * 1000;
  const start = Date.now();
  let lastCount = 0;

  while (Date.now() - start < maxWait) {
    const run = await prisma.run.findUnique({
      where: { id: RUN_ID },
      select: {
        status: true, passed: true, failed: true, blocked: true, needsHuman: true,
        results: {
          select: {
            id: true, status: true, error: true, durationMs: true, replayIrJson: true,
            testCase: { select: { name: true, scenario: { select: { name: true, module: true } } } }
          },
          orderBy: { createdAt: 'asc' }
        }
      }
    });
    if (!run) { await sleep(5000); continue; }

    if (run.results.length > lastCount) {
      for (let i = lastCount; i < run.results.length; i++) {
        const r = run.results[i];
        const verdict = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : r.status === 'blocked' ? 'BLOCKED' : r.status.toUpperCase();
        const hasCode = r.replayIrJson ? '[IR]' : '[no-IR]';
        const dur = r.durationMs ? ` ${(r.durationMs/1000).toFixed(1)}s` : '';
        const det = (r.status !== 'pass' && r.error) ? '\n    ' + r.error.slice(0, 120) : '';
        console.log(`  ${verdict} ${hasCode}${dur}  ${r.testCase?.name || r.id}${det}`);
      }
      lastCount = run.results.length;
    }

    if (['completed', 'cancelled', 'failed'].includes(run.status)) {
      console.log(`\n=== Run ${run.status.toUpperCase()} ===`);
      console.log(`pass=${run.passed} fail=${run.failed} blocked=${run.blocked} needsHuman=${run.needsHuman}`);

      const withIR = run.results.filter(r => r.replayIrJson);
      console.log(`Results with replayIrJson: ${withIR.length}/${run.results.length}\n`);
      break;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r  [${run.status}] ${run.results.length} results so far, ${elapsed}s elapsed...`);
    await sleep(8000);
  }

  // After run: check output files dir
  const fs = require('fs');
  const exportDir = require('path').join(__dirname, '..', 'playwright', 'runs', RUN_ID);
  console.log('\nChecking export dir:', exportDir);

  if (fs.existsSync(exportDir)) {
    const specs = [];
    function walk(d) {
      for (const f of fs.readdirSync(d)) {
        if (f === 'node_modules') continue;
        const full = require('path').join(d, f);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (/\.(spec|test)\.(ts|js)$/.test(f)) specs.push(full);
      }
    }
    walk(exportDir);
    console.log(`\nFound ${specs.length} spec files\n`);

    let cleanCount = 0;
    for (const f of specs) {
      const content = fs.readFileSync(f, 'utf8');
      const rel = f.replace(/.*playwright.runs/, 'playwright/runs').replace(/\\/g, '/');
      const { issues, notes, clean } = assessSpec(content);
      if (clean) cleanCount++;

      console.log(`── ${rel}`);
      console.log(`   ${clean ? 'CLEAN' : 'ISSUES: ' + issues.join('; ')}`);
      notes.forEach(n => console.log(`   · ${n}`));
      console.log('\n   SPEC PREVIEW (first 60 lines):');
      content.split('\n').slice(0, 60).forEach((l, i) => console.log(`   ${String(i+1).padStart(3)} | ${l}`));
      console.log('');
    }
    console.log(`AUDIT: ${cleanCount}/${specs.length} clean`);
  } else {
    console.log('Export dir not found — run the export from the UI first, or check outputFiles route');
    // Show raw IR step counts from DB
    const results = await prisma.runResult.findMany({
      where: { runId: RUN_ID, replayIrJson: { not: null } },
      select: { status: true, replayIrJson: true, testCase: { select: { name: true } } }
    });
    console.log(`\n${results.length} results have IR. First 3 IR step counts:`);
    results.slice(0, 3).forEach(r => {
      try {
        const ir = JSON.parse(r.replayIrJson);
        console.log(`  [${r.status}] ${r.testCase?.name} — ${ir?.steps?.length || '?'} IR steps`);
      } catch { console.log(`  [${r.status}] ${r.testCase?.name} — IR parse error`); }
    });
  }

  await prisma.$disconnect();
})().catch(async e => { console.error('\nFATAL:', e.message); await prisma.$disconnect(); process.exit(1); });
