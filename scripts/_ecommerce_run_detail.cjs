'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();

const PROJECT_ID = '4cc6772c-ea93-4c26-b478-48d779d1fccb';
const USER_ID = 'a5d916cd-4178-4bcc-b409-c885a389e843';
const USER_EMAIL = 'bharatvanapalli8@gmail.com';

(async () => {
  const token = jwt.sign({ sub: USER_ID, email: USER_EMAIL, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  console.log('TOKEN=' + token + '\n');

  // All runs for this project
  const runs = await prisma.run.findMany({
    where: { projectId: PROJECT_ID },
    orderBy: { startedAt: 'desc' },
    select: { id: true, status: true, startedAt: true, passed: true, failed: true, blocked: true, generationId: true }
  });
  console.log('ALL RUNS:');
  runs.forEach(r => console.log(` ${r.id} | ${r.status} | pass=${r.passed} fail=${r.failed} blocked=${r.blocked} | ${r.startedAt}`));

  // Latest run results detail
  if (runs.length > 0) {
    const run = runs[0];
    console.log('\nLATEST RUN:', run.id, 'genId:', run.generationId);
    const results = await prisma.runResult.findMany({
      where: { runId: run.id },
      select: {
        id: true, status: true, durationMs: true, error: true,
        replayIrJson: true,
        testCase: { select: { id: true, name: true, scenario: { select: { name: true, module: true } } } }
      }
    });
    results.forEach(r => {
      console.log(`\n  [${r.status}] ${r.testCase?.scenario?.module || '?'}/${r.testCase?.name || r.id}`);
      console.log(`    error: ${r.error ? r.error.slice(0, 120) : 'none'}`);
      console.log(`    hasReplayIr: ${!!r.replayIrJson}`);
    });
  }

  // Check for export files in playwright/
  const fs = require('fs');
  const playwrightDir = path.join(__dirname, '..', 'playwright');
  if (fs.existsSync(playwrightDir)) {
    const walk = (dir, prefix = '') => {
      const items = fs.readdirSync(dir);
      items.forEach(item => {
        const full = path.join(dir, item);
        const rel = path.join(prefix, item);
        if (fs.statSync(full).isDirectory()) {
          walk(full, rel);
        } else if (item.endsWith('.ts') || item.endsWith('.js')) {
          const size = fs.statSync(full).size;
          console.log(`  ${rel} (${size}b)`);
        }
      });
    };
    console.log('\nGENERATED SPEC/POM FILES in playwright/:');
    try { walk(playwrightDir); } catch (e) { console.log('  (read error:', e.message, ')'); }
  } else {
    console.log('\nplaywright/ dir does not exist');
  }

  await prisma.$disconnect();
})().catch(async e => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
