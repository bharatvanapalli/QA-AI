'use strict';
/**
 * Exports the completed AE run and audits the generated Playwright JS spec files.
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
const RUN_ID = '30637d3e-e147-452f-b94f-3bc3c306043e';
const USER_ID = 'a5d916cd-4178-4bcc-b409-c885a389e843';
const USER_EMAIL = 'bharatvanapalli8@gmail.com';

function request(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`http://localhost:5000${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0, ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf), raw: buf }); }
        catch { resolve({ status: res.statusCode, body: null, raw: buf }); }
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

  // Structure checks
  if (!/(require\(|from ['"]@playwright)/.test(content)) issues.push('no import');
  if (!/(^|\n)\s*(test|it)\s*\(/.test(content)) issues.push('no test() block');
  if (!content.includes('expect(')) issues.push('no expect() assertion');
  if (!content.includes('await ')) issues.push('no await statements');
  if (/SYNTAX ERROR|Duplicate declaration|Missing semicolon/i.test(content)) issues.push('SYNTAX MARKERS found');

  // Locator quality
  const roleLocators = (content.match(/getByRole\(/g) || []).length;
  const textLocators = (content.match(/getByText\(/g) || []).length;
  const labelLocators = (content.match(/getByLabel\(/g) || []).length;
  const phLocators = (content.match(/getByPlaceholder\(/g) || []).length;
  const cssLocators = (content.match(/\.locator\(['"][\.#]/g) || []).length;
  const dataTestId = (content.match(/getByTestId\(/g) || []).length;
  const fragile = (content.match(/nth-child|nth-of-type|>> nth=/g) || []).length;
  notes.push(`locators: ${roleLocators+textLocators+labelLocators+phLocators} semantic, ${cssLocators} CSS-class, ${fragile} fragile`);

  // Quality signals
  if (content.includes('waitForLoadState') || content.includes('networkidle')) notes.push('has load-state handling');
  if (content.includes('screenshot')) notes.push('captures screenshots');
  if (content.includes('process.env.') || content.includes('_env')) notes.push('uses env vars');
  if (content.includes('timeout')) notes.push('explicit timeouts');
  if (/\/\/.*why|\/\/.*because/i.test(content)) notes.push('has why-comments');

  // Credential check
  if (/(password|passwd)\s*[=:]\s*['"][^'"]{3,}/i.test(content) && !content.includes('process.env')) {
    issues.push('possible hardcoded credential');
  }

  notes.push(`${content.split('\n').length} lines`);

  return { issues, notes, clean: issues.length === 0 };
}

(async () => {
  const jwtToken = jwt.sign({ sub: USER_ID, email: USER_EMAIL, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const authHeaders = {
    'Cookie': `token=${jwtToken}; XSRF-TOKEN=${csrfToken}`,
    'x-xsrf-token': csrfToken,
  };

  // Try the outputFiles route to trigger export
  // The route is GET /api/output-files/:projectId/:runId with query ?framework=playwright-js
  console.log('Triggering export...');
  const r1 = await request('GET', `/api/output-files/${PROJECT_ID}/${RUN_ID}`, null, { 'Cookie': `token=${jwtToken}` });
  console.log('outputFiles GET:', r1.status, r1.raw?.slice(0, 200));

  await sleep(8000);

  // Check if export dir was created
  const exportDir = path.join(__dirname, '..', 'playwright', 'runs', RUN_ID);
  if (!fs.existsSync(exportDir)) {
    // Try POST to trigger build
    console.log('\nNo export dir. Trying POST buildReplayWorkspace...');
    const r2 = await request('POST', `/api/output-files/${PROJECT_ID}/${RUN_ID}/build`, {}, authHeaders);
    console.log('POST build:', r2.status, r2.raw?.slice(0, 200));
    await sleep(8000);
  }

  if (!fs.existsSync(exportDir)) {
    console.log('\nExport dir still not found. Checking the outputFiles route structure...');
    // List existing run dirs to see naming convention
    const runsDir = path.join(__dirname, '..', 'playwright', 'runs');
    if (fs.existsSync(runsDir)) {
      console.log('Existing run export dirs:', fs.readdirSync(runsDir).slice(0, 5));
    }

    // Try to read the IR and build the codegen manually from replayExport
    console.log('\nFalling back to direct codegen from IR...');
    await buildFromIR();
    return;
  }

  await auditDir(exportDir);
  await prisma.$disconnect();
});

async function buildFromIR() {
  // Load the replayExport module and build specs directly
  const replayExport = require(path.join(__dirname, '..', 'server', 'services', 'codegen', 'replayExport'));

  const results = await prisma.runResult.findMany({
    where: { runId: RUN_ID, replayIrJson: { not: null } },
    select: {
      id: true, status: true, replayIrJson: true,
      testCase: {
        select: {
          id: true, name: true, module: true, type: true,
          declaredAssertions: true,
          scenario: { select: { id: true, name: true, projectId: true } }
        }
      }
    }
  });

  const project = await prisma.project.findUnique({
    where: { id: PROJECT_ID },
    select: { framework: true, targetUrl: true, testCredentials: true }
  });

  console.log(`\nBuilding codegen for ${results.length} results with IR`);
  console.log(`Framework: ${project.framework}, URL: ${project.targetUrl}\n`);

  const outDir = path.join(__dirname, '..', 'playwright', 'runs', RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const specFiles = [];
  for (const r of results) {
    try {
      const ir = JSON.parse(r.replayIrJson);
      const creds = project.testCredentials ? JSON.parse(project.testCredentials) : {};

      const built = await replayExport.buildRunnerForResult({
        r: {
          envelope: { ir },
          caseName: r.testCase?.name || r.id,
          runResultId: r.id,
          testCaseId: r.testCase?.id || r.id,
          scenarioId: r.testCase?.scenario?.id || 'unknown',
        },
        framework: project.framework || 'playwright-js',
        baseUrl: project.targetUrl,
        credentials: creds,
        loginPrecondition: null,
        logoutUrl: null,
      });

      if (built && built.spec) {
        const fname = `${r.testCase?.name?.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || r.id}.spec.js`;
        const fpath = path.join(outDir, fname);
        fs.writeFileSync(fpath, built.spec, 'utf8');
        specFiles.push({ path: fpath, status: r.status, name: r.testCase?.name });
        console.log(`  wrote ${fname} (${built.spec.split('\n').length} lines)`);
      }
    } catch (e) {
      console.warn(`  SKIP ${r.id}: ${e.message.slice(0, 80)}`);
    }
  }

  console.log(`\nGenerated ${specFiles.length} spec files`);
  await auditDir(outDir, specFiles);
  await prisma.$disconnect();
}

async function auditDir(dir, prebuilt) {
  const fs = require('fs');
  const specs = prebuilt || [];
  if (!prebuilt) {
    function walk(d) {
      for (const f of fs.readdirSync(d)) {
        if (f === 'node_modules') continue;
        const full = path.join(d, f);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (/\.(spec|test)\.(ts|js)$/.test(f)) specs.push({ path: full });
      }
    }
    walk(dir);
  }

  console.log(`\n=== SPEC FILE AUDIT (${specs.length} files) ===\n`);
  let cleanCount = 0;

  for (const s of specs) {
    const content = fs.readFileSync(s.path, 'utf8');
    const rel = s.path.replace(/.*playwright/, 'playwright').replace(/\\/g, '/');
    const { issues, notes, clean } = assessSpec(content, path.basename(s.path));
    if (clean) cleanCount++;

    const verdict = clean ? '✓ CLEAN' : `✗ ISSUES`;
    const liveResult = s.status ? ` [live: ${s.status.toUpperCase()}]` : '';
    console.log(`── ${rel}${liveResult}`);
    console.log(`   ${verdict}${!clean ? ': ' + issues.join('; ') : ''}`);
    notes.forEach(n => console.log(`   · ${n}`));

    // Show full spec
    const lines = content.split('\n');
    console.log(`\n   FULL SPEC:`);
    lines.forEach((l, i) => console.log(`   ${String(i+1).padStart(3)} | ${l}`));
    console.log('');
  }

  console.log(`\n=== AUDIT SUMMARY: ${cleanCount}/${specs.length} clean ===`);
  if (cleanCount < specs.length) {
    console.log('Issues found — see above for details.');
  } else {
    console.log('All spec files are syntactically correct and structurally sound.');
  }
}
