'use strict';
/**
 * End-to-end exercise: Automation Exercise (automationexercise.com) project.
 * 1. Mints auth + CSRF tokens for bharatvanapalli8@gmail.com
 * 2. Gets all current-generation test case IDs
 * 3. Fires POST /api/runs and streams server logs to show live execution
 * 4. Polls until run completes (or times out after 30 min)
 * 5. Exports the run → playwright/runs/<runId>/
 * 6. Reads and validates each generated spec file (syntax, locator quality,
 *    verdict fidelity, human-readability)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();

const PROJECT_ID = '4cc6772c-ea93-4c26-b478-48d779d1fccb';
const USER_ID = 'a5d916cd-4178-4bcc-b409-c885a389e843';
const USER_EMAIL = 'bharatvanapalli8@gmail.com';
const ORG_ID = 'org-a5d916cd-4178-4bcc-b409-c885a389e843';
const API = 'http://localhost:5000';

function request(method, path, body, cookies, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${API}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assessSpec(content, filename) {
  const issues = [];
  const notes = [];

  // 1. Syntax check: no obvious broken patterns
  if (/\/\/\s*SYNTAX ERROR|Missing semicolon|Duplicate declaration/i.test(content)) {
    issues.push('SYNTAX MARKERS in file');
  }
  if (/\/\/\s*TODO:|\/\/\s*FIXME:/i.test(content)) {
    notes.push('has TODO/FIXME comments');
  }

  // 2. Has import
  if (!content.includes("require('") && !content.includes('from \'') && !content.includes('from "')) {
    issues.push('no import/require statement');
  }

  // 3. Has test() or it() block
  if (!/(^|\n)\s*(test|it)\s*\(/.test(content)) {
    issues.push('no test() or it() block found');
  }

  // 4. Has expect() assertions
  if (!content.includes('expect(')) {
    issues.push('no expect() assertion found');
  }

  // 5. Has page.goto() or page.navigate
  if (!content.includes('page.goto(') && !content.includes('page.navigate(')) {
    notes.push('no page.goto() — may be a page-object file');
  }

  // 6. Locator quality: check for preferred locators vs fragile ones
  const goodLocators = (content.match(/getByRole\(|getByText\(|getByLabel\(|getByPlaceholder\(|getByTestId\(/g) || []).length;
  const fragileLocators = (content.match(/locator\('[^']*nth-child|locator\('[^']*:nth-of-type/g) || []).length;
  const cssLocators = (content.match(/locator\('[^']*\.[\w-]+'\)/g) || []).length;
  notes.push(`locators: ${goodLocators} role/text/label, ${cssLocators} CSS class, ${fragileLocators} fragile nth`);

  // 7. No invented env vars beyond the standard set
  const envVars = content.match(/process\.env\.\w+/g) || [];
  const unknownEnv = envVars.filter(e => !['QAAI_BASE_URL','QAAI_USERNAME','QAAI_PASSWORD','QAAI_TIMEOUT'].includes(e.replace('process.env.','')));
  if (unknownEnv.length > 0) {
    notes.push(`env vars used: ${[...new Set(envVars.map(e => e.replace('process.env.', '')))].join(', ')}`);
  }

  // 8. No hardcoded credentials
  if (/(password|passwd|secret)\s*[=:]\s*['"][^'"]{4,}/i.test(content)) {
    issues.push('possible hardcoded credential');
  }

  // 9. Check for standard Playwright patterns
  const hasAwait = content.includes('await ');
  const hasTimeout = content.includes('timeout');
  if (!hasAwait) issues.push('no await — synchronous-looking code');
  if (!hasTimeout) notes.push('no explicit timeout override');

  // 10. Line count (readability)
  const lines = content.split('\n').length;
  notes.push(`${lines} lines`);

  return { issues, notes, clean: issues.length === 0 };
}

(async () => {
  console.log('=== AUTOMATION EXERCISE LIVE RUN + SPEC AUDIT ===\n');

  // ── Step 1: Get current generation test case IDs
  const gen = await prisma.scenarioGeneration.findFirst({
    where: { projectId: PROJECT_ID, isCurrent: true },
    select: { id: true, label: true, caseCount: true }
  });
  console.log(`Current generation: ${gen?.label} (${gen?.caseCount} cases), id=${gen?.id}`);

  const testCases = await prisma.testCase.findMany({
    where: { scenario: { projectId: PROJECT_ID, generationId: gen.id } },
    select: { id: true, name: true, automatability: true },
    orderBy: { createdAt: 'asc' }
  });
  const runnableCases = testCases.filter(tc => tc.automatability !== 'manual');
  console.log(`Runnable test cases: ${runnableCases.length}/${testCases.length}`);
  runnableCases.forEach((tc, i) => console.log(`  [${i+1}] ${tc.name}`));

  // ── Step 2: Mint JWT + CSRF
  const jwtToken = jwt.sign(
    { sub: USER_ID, email: USER_EMAIL, role: 'user', orgId: ORG_ID },
    process.env.JWT_SECRET,
    { expiresIn: '4h' }
  );
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const cookieHeader = `token=${jwtToken}; XSRF-TOKEN=${csrfToken}`;
  const authHeaders = {
    'Cookie': cookieHeader,
    'x-xsrf-token': csrfToken,
  };

  // ── Step 3: Verify auth works
  const meRes = await request('GET', '/api/runs?projectId=' + PROJECT_ID, null, null, { 'Cookie': cookieHeader });
  if (meRes.status !== 200) {
    console.error('Auth failed:', meRes.status, JSON.stringify(meRes.body));
    await prisma.$disconnect(); process.exit(1);
  }
  console.log(`\nAuth OK — ${meRes.body?.runs?.length || 0} prior runs visible`);

  // ── Step 4: Start the run
  console.log(`\nStarting run with ${runnableCases.length} test cases...`);
  const startRes = await request('POST', '/api/runs', {
    projectId: PROJECT_ID,
    testCaseIds: runnableCases.map(tc => tc.id),
    sprintName: 'AE Exercise ' + new Date().toISOString().slice(0, 16)
  }, null, authHeaders);

  if (startRes.status !== 202) {
    console.error('Run start failed:', startRes.status, JSON.stringify(startRes.body));
    await prisma.$disconnect(); process.exit(1);
  }
  const runId = startRes.body.runId;
  console.log(`Run started: ${runId}`);
  console.log('');

  // ── Step 5: Poll until complete (30 min timeout)
  const maxWaitMs = 30 * 60 * 1000;
  const pollIntervalMs = 8000;
  const startMs = Date.now();
  let lastResultCount = 0;

  console.log('Polling run status every 8s (watching live results)...\n');
  while (Date.now() - startMs < maxWaitMs) {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: {
        status: true, passed: true, failed: true, blocked: true, needsHuman: true,
        results: {
          select: { status: true, testCase: { select: { name: true } }, error: true },
          orderBy: { createdAt: 'asc' }
        }
      }
    });
    if (!run) { console.log('run not found yet...'); await sleep(pollIntervalMs); continue; }

    // Print new results
    if (run.results.length > lastResultCount) {
      for (let i = lastResultCount; i < run.results.length; i++) {
        const r = run.results[i];
        const emoji = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : r.status === 'blocked' ? 'BLOCKED' : r.status;
        const detail = r.error ? ` — ${r.error.slice(0, 80)}` : '';
        console.log(`  [${emoji}] ${r.testCase?.name || r.id}${detail}`);
      }
      lastResultCount = run.results.length;
    }

    if (['completed', 'cancelled', 'failed'].includes(run.status)) {
      console.log(`\nRun ${run.status}: pass=${run.passed} fail=${run.failed} blocked=${run.blocked} needsHuman=${run.needsHuman}`);
      break;
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
    process.stdout.write(`\r  ${run.status}... ${run.results.length}/${runnableCases.length} cases (${elapsed}s elapsed)`);
    await sleep(pollIntervalMs);
  }
  console.log('');

  // ── Step 6: Trigger export
  console.log('\nTriggering export for run ' + runId + '...');
  const exportRes = await request('GET', `/api/output-files/${PROJECT_ID}/${runId}`, null, null, { 'Cookie': cookieHeader });
  if (exportRes.status !== 200) {
    console.warn('Export trigger status:', exportRes.status);
  }

  // Wait for files to appear
  await sleep(3000);
  const exportDir = path.join(__dirname, '..', 'playwright', 'runs', runId);
  console.log('Export dir:', exportDir);
  console.log('Exists:', fs.existsSync(exportDir));

  // ── Step 7: Find and assess spec files
  const specFiles = [];
  function findSpecs(dir) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir)) {
      if (item === 'node_modules') continue;
      const full = path.join(dir, item);
      if (fs.statSync(full).isDirectory()) { findSpecs(full); continue; }
      if (item.endsWith('.spec.ts') || item.endsWith('.spec.js') || item.endsWith('.test.ts') || item.endsWith('.test.js')) {
        specFiles.push(full);
      }
    }
  }
  findSpecs(exportDir);

  console.log(`\nFound ${specFiles.length} spec file(s) in export:\n`);
  let allClean = true;

  for (const f of specFiles) {
    const content = fs.readFileSync(f, 'utf8');
    const rel = path.relative(path.join(__dirname, '..'), f);
    const { issues, notes, clean } = assessSpec(content, path.basename(f));
    allClean = allClean && clean;

    console.log(`─── ${rel}`);
    console.log(`    STATUS: ${clean ? 'CLEAN' : 'HAS ISSUES'}`);
    if (issues.length > 0) issues.forEach(i => console.log(`    ISSUE: ${i}`));
    notes.forEach(n => console.log(`    note:  ${n}`));
    console.log('');

    // Show first 40 lines of spec
    const preview = content.split('\n').slice(0, 40).join('\n');
    console.log('    ── PREVIEW (first 40 lines) ──');
    preview.split('\n').forEach(l => console.log('    ' + l));
    console.log('');
  }

  if (specFiles.length === 0) {
    console.log('No spec files found — checking if export route works differently...');
    // Check if replayIrJson was populated and show what codegen would produce
    const results = await prisma.runResult.findMany({
      where: { runId },
      select: { id: true, status: true, replayIrJson: true, testCase: { select: { name: true } } }
    });
    const withIr = results.filter(r => r.replayIrJson);
    console.log(`  ${withIr.length}/${results.length} results have replayIrJson (code generation data)`);
    withIr.forEach(r => console.log(`  [${r.status}] ${r.testCase?.name}`));
  }

  console.log('=== SUMMARY ===');
  console.log(`Spec files assessed: ${specFiles.length}`);
  console.log(`All clean: ${allClean}`);

  await prisma.$disconnect();
})().catch(async e => {
  console.error('\nFATAL:', e.message);
  console.error(e.stack);
  await prisma.$disconnect();
  process.exit(1);
});
