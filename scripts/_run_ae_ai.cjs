'use strict';
/**
 * Triggers an AI conductor run for the Automation Exercise project via
 * POST /api/projects/:projectId/agents/execute (the real AI path, not runs.js).
 * Polls until complete then exports and audits generated spec files.
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

function request(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${API}${urlPath}`, {
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

  if (/\/\/\s*SYNTAX ERROR|Duplicate declaration|Missing semicolon/i.test(content)) issues.push('SYNTAX MARKERS in file');
  if (!/(require\(|from ['"]@playwright)/.test(content)) issues.push('no import/require');
  if (!/(^|\n)\s*(test|it)\s*\(/.test(content)) issues.push('no test() or it() block');
  if (!content.includes('expect(')) issues.push('no expect() assertion');
  if (!content.includes('await ')) issues.push('no await — synchronous code');

  const goodLocators = (content.match(/getByRole\(|getByText\(|getByLabel\(|getByPlaceholder\(|getByTestId\(/g) || []).length;
  const cssLocators = (content.match(/\.locator\(['"][\.\#]/g) || []).length;
  const fragile = (content.match(/nth-child|nth-of-type|>> nth=/g) || []).length;
  notes.push(`locators: ${goodLocators} role/text/label, ${cssLocators} CSS-class, ${fragile} fragile`);

  const lines = content.split('\n').length;
  notes.push(`${lines} lines`);

  // Check for env vars (good sign — credentials not hardcoded)
  const hasEnvVars = content.includes('process.env.') || content.includes('env.');
  if (hasEnvVars) notes.push('uses env vars (credentials not hardcoded)');

  // Check for timeouts
  if (content.includes('timeout')) notes.push('has timeout handling');

  return { issues, notes, clean: issues.length === 0 };
}

(async () => {
  console.log('=== AI CONDUCTOR RUN — automationexercise.com ===\n');

  // ── Mint auth + CSRF
  const jwtToken = jwt.sign(
    { sub: USER_ID, email: USER_EMAIL, role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '4h' }
  );
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const authHeaders = {
    'Cookie': `token=${jwtToken}; XSRF-TOKEN=${csrfToken}`,
    'x-xsrf-token': csrfToken,
  };

  // ── Verify org resolves correctly (check GET runs first)
  const checkRes = await request('GET', `/api/projects/${PROJECT_ID}/agents/status`, null, { 'Cookie': `token=${jwtToken}` });
  console.log(`Agent status check: ${checkRes.status} — ${JSON.stringify(checkRes.body).slice(0, 100)}`);

  // ── Fire execute
  console.log(`\nFiring POST /api/projects/${PROJECT_ID}/agents/execute ...`);
  const execRes = await request('POST', `/api/projects/${PROJECT_ID}/agents/execute`, {}, authHeaders);
  console.log(`Execute response: ${execRes.status}`);
  console.log(JSON.stringify(execRes.body, null, 2));

  if (execRes.status !== 202) {
    console.error('Execute failed. Aborting.');
    await prisma.$disconnect();
    process.exit(1);
  }

  const runId = execRes.body.runId;
  console.log(`\nRun started: ${runId}`);
  console.log('Polling every 10s...\n');

  // ── Poll
  const maxWaitMs = 45 * 60 * 1000;
  const startMs = Date.now();
  let lastCount = 0;

  while (Date.now() - startMs < maxWaitMs) {
    await sleep(10000);

    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: {
        status: true, passed: true, failed: true, blocked: true, needsHuman: true,
        results: {
          select: {
            status: true, error: true, durationMs: true,
            replayIrJson: true,
            testCase: { select: { name: true, scenario: { select: { name: true, module: true } } } }
          },
          orderBy: { createdAt: 'asc' }
        }
      }
    });
    if (!run) { process.stdout.write('.'); continue; }

    // Print new completions
    if (run.results.length > lastCount) {
      for (let i = lastCount; i < run.results.length; i++) {
        const r = run.results[i];
        const verdict = r.status === 'pass' ? '✓ PASS' : r.status === 'fail' ? '✗ FAIL' : r.status === 'blocked' ? '⊘ BLOCKED' : r.status.toUpperCase();
        const name = r.testCase?.name || '?';
        const dur = r.durationMs ? ` (${(r.durationMs/1000).toFixed(1)}s)` : '';
        const detail = r.error && r.status !== 'pass' ? `\n      ${r.error.slice(0, 100)}` : '';
        const hasCode = r.replayIrJson ? ' [has-IR]' : ' [no-IR]';
        console.log(`  ${verdict}${hasCode}  ${name}${dur}${detail}`);
      }
      lastCount = run.results.length;
    }

    if (['completed', 'cancelled', 'failed'].includes(run.status)) {
      console.log(`\n── Run ${run.status.toUpperCase()} ──`);
      console.log(`pass=${run.passed} fail=${run.failed} blocked=${run.blocked} needsHuman=${run.needsHuman}`);
      break;
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
    process.stdout.write(`\r  [${run.status}] ${run.results.length}/${lastCount || '?'} cases done, ${elapsed}s elapsed...`);
  }

  console.log('\n');

  // ── Get run results from DB for spec audit
  const finalResults = await prisma.runResult.findMany({
    where: { runId },
    select: {
      id: true, status: true, replayIrJson: true, durationMs: true,
      testCase: { select: { name: true, scenario: { select: { name: true, module: true } } } }
    }
  });

  console.log(`\nRun results with replayIrJson: ${finalResults.filter(r => r.replayIrJson).length}/${finalResults.length}`);

  // ── Try to trigger export and find spec files
  console.log('\nTriggering export...');
  // First try the output-files route
  const exportRes = await request('GET', `/api/output-files/${PROJECT_ID}/${runId}?action=build`, null, { 'Cookie': `token=${jwtToken}` });
  console.log(`Export response: ${exportRes.status}`);

  await sleep(5000);

  // Check for generated files
  const exportDir = path.join(__dirname, '..', 'playwright', 'runs', runId);
  const exists = fs.existsSync(exportDir);
  console.log(`Export dir exists: ${exists} (${exportDir})`);

  if (exists) {
    const specFiles = [];
    function findSpecs(dir) {
      for (const item of fs.readdirSync(dir)) {
        if (item === 'node_modules') continue;
        const full = path.join(dir, item);
        if (fs.statSync(full).isDirectory()) { findSpecs(full); continue; }
        if (/\.(spec|test)\.(ts|js)$/.test(item)) specFiles.push(full);
      }
    }
    findSpecs(exportDir);

    console.log(`\nFound ${specFiles.length} spec files:\n`);
    let cleanCount = 0;

    for (const f of specFiles) {
      const content = fs.readFileSync(f, 'utf8');
      const rel = path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/');
      const { issues, notes, clean } = assessSpec(content, path.basename(f));
      if (clean) cleanCount++;

      console.log(`── ${rel}`);
      console.log(`   ${clean ? 'CLEAN' : 'ISSUES: ' + issues.join('; ')}`);
      notes.forEach(n => console.log(`   · ${n}`));

      // Show first 50 lines
      const lines = content.split('\n');
      console.log(`\n   FIRST 50 LINES:`);
      lines.slice(0, 50).forEach((l, i) => console.log(`   ${String(i+1).padStart(3)}: ${l}`));
      console.log('');
    }

    console.log(`\nSPEC AUDIT SUMMARY: ${cleanCount}/${specFiles.length} clean`);
  } else {
    // No export dir — show the raw spec code from DB instead
    console.log('\n--- No export dir. Showing spec code from DB results ---\n');
    let shown = 0;
    for (const r of finalResults.filter(r => r.replayIrJson)) {
      if (shown >= 3) { console.log(`... (and ${finalResults.filter(x => x.replayIrJson).length - 3} more)`); break; }
      shown++;
      console.log(`── [${r.status}] ${r.testCase?.name}`);
      // replayIrJson is the IR, not the spec. The spec is generated at export time.
      const ir = JSON.parse(r.replayIrJson || '{}');
      console.log(`   IR steps: ${ir?.steps?.length || '?'}`);
      console.log('');
    }
  }

  await prisma.$disconnect();
})().catch(async e => {
  console.error('\nFATAL:', e.message);
  console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
  await prisma.$disconnect();
  process.exit(1);
});
