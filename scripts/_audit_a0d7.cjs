'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const RUN_ID = 'a0d7891d-dc96-424e-b1b2-15856d19dae5';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}

function walkTree(node, out = []) {
  if (!node) return out;
  if (node.type === 'file' && (node.kind === 'spec' || String(node.path || '').endsWith('.spec.js')))
    out.push(node.path);
  (node.children || []).forEach(c => walkTree(c, out));
  return out;
}

(async () => {
  const headers = makeHeaders();

  // 1. Manifest
  const mRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/file/EXPORT_MANIFEST.json?source=replayir&runId=${RUN_ID}`,
    { headers }
  );
  const mBody = await mRes.json().catch(() => ({}));
  const mContent = mBody.content ? JSON.parse(mBody.content) : mBody;
  const entries = mContent?.entries || [];

  const blocked = entries.filter(e => e.blockReason);
  const exported = entries.filter(e => !e.blockReason && e.files && e.files.length > 0);

  console.log(`=== MANIFEST for run a0d7 ===`);
  console.log(`Total entries: ${entries.length}  Exported: ${exported.length}  Blocked: ${blocked.length}`);
  if (blocked.length) {
    console.log('\nBlocked:');
    blocked.forEach(e => console.log(`  [${e.blockReason}] "${e.caseName || e.scenarioName || 'n/a'}"`));
  }
  console.log('\nExported scenarios:');
  const seen = new Set();
  exported.forEach(e => { if (!seen.has(e.scenarioName)) { seen.add(e.scenarioName); console.log(`  ✓ ${e.scenarioName}`); } });

  // 2. Collect spec files via tree
  const treeRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/?source=replayir&runId=${RUN_ID}`,
    { headers }
  );
  const treeData = await treeRes.json().catch(() => ({}));
  const specFiles = walkTree(treeData?.tree);
  console.log(`\nSpec files in tree: ${specFiles.length}`);
  specFiles.forEach(f => console.log('  ' + f));

  // 3. Per-spec quality audit
  const results = [];
  for (const specPath of specFiles) {
    const fRes = await fetch(
      `${BASE}/api/projects/${PROJECT_ID}/output-files/file/${encodeURIComponent(specPath)}?source=replayir&runId=${RUN_ID}`,
      { headers }
    );
    if (!fRes.ok) { console.log(`\n[SKIP] ${specPath} — HTTP ${fRes.status}`); continue; }
    const fBody = await fRes.json().catch(() => ({}));
    const content = fBody.content || (typeof fBody === 'string' ? fBody : '');
    if (!content) { console.log(`\n[SKIP] ${specPath} — empty`); continue; }

    const lines = content.split('\n');
    const elVars         = content.match(/\bconst el\d+\s*=/g) || [];
    const inlineLocators = content.match(/\bpage\.(getByRole|getByText|getByLabel|getByPlaceholder|locator)\s*\(/g) || [];
    const asnHashes      = content.match(/ASN-[a-f0-9]+/g) || [];
    const resolveCount   = (content.match(/await resolveLocator\s*\(/g) || []).length;
    const envCreds       = content.match(/process\.env\.(QAAI_USERNAME|QAAI_PASSWORD)/g) || [];

    // Q4 IIFE check: evaluateSettled calls should return expression values, not undefined
    // Pattern: async () => { ... } without explicit return is the bug; () => expr is the fix
    const iifeBug = content.match(/evaluateSettled\s*\(page,\s*async\s*\(\)\s*=>\s*\{[^}]*\}[^,)]/g) || [];

    // Q11: count repeated identical resolveLocator candidate arrays (dedup check)
    const locatorBlocks = [];
    let m;
    const lcRe = /await resolveLocator\(page,\s*(\[[\s\S]*?\])/g;
    while ((m = lcRe.exec(content)) !== null) locatorBlocks.push(m[1].replace(/\s+/g, ' '));
    const dupLocators = locatorBlocks.filter((b, i) => locatorBlocks.indexOf(b) !== i);

    const q1 = inlineLocators.length === 0;
    const q2 = elVars.length === 0;
    const q3 = asnHashes.length === 0;
    const q4 = iifeBug.length === 0;
    const q8 = envCreds.length === 0;
    const q11 = dupLocators.length === 0;

    const pass = q1 && q2 && q3 && q4 && q8 && q11;
    results.push({ specPath, q1, q2, q3, q4, q8, q11, pass, resolveCount, elVars, inlineLocators, asnHashes, iifeBug, dupLocators, envCreds });
  }

  console.log('\n=== PER-SPEC QUALITY AUDIT ===');
  for (const r of results) {
    const icon = r.pass ? '✓' : '✗';
    const name = path.basename(r.specPath);
    console.log(`\n${icon} ${name}`);
    console.log(`  Q1 inline locators : ${r.q1 ? 'PASS' : 'FAIL ('+r.inlineLocators.length+')'}`);
    console.log(`  Q2 el1/el2 names   : ${r.q2 ? 'PASS' : 'FAIL: '+r.elVars.join(',')}`);
    console.log(`  Q3 ASN hashes      : ${r.q3 ? 'PASS' : 'FAIL ('+r.asnHashes.length+')'}`);
    console.log(`  Q4 IIFE returns    : ${r.q4 ? 'PASS' : 'FAIL ('+r.iifeBug.length+' block-body IIFE)'}`);
    console.log(`  Q8 env creds       : ${r.q8 ? 'PASS' : 'WARN: '+r.envCreds.join(',')}`);
    console.log(`  Q11 dup elements   : ${r.q11 ? 'PASS' : 'FAIL ('+r.dupLocators.length+' reused candidate arrays)'}`);
    console.log(`  resolveLocator calls: ${r.resolveCount}`);
  }

  const allPass = results.every(r => r.pass);
  const failCount = results.filter(r => !r.pass).length;
  console.log(`\n=== SUMMARY ===`);
  console.log(`Specs audited: ${results.length}`);
  console.log(`All pass: ${allPass ? 'YES' : 'NO — '+failCount+' spec(s) failed'}`);
  console.log(`Blocked entries: ${blocked.length} (want 0 for clean Q1-Q13 pass)`);

  // Show one full spec for manual review of semantic names and IIFE pattern
  if (results.length > 0) {
    const sample = results.find(r => r.resolveCount > 1) || results[0];
    const fRes2 = await fetch(
      `${BASE}/api/projects/${PROJECT_ID}/output-files/file/${encodeURIComponent(sample.specPath)}?source=replayir&runId=${RUN_ID}`,
      { headers }
    );
    const fBody2 = await fRes2.json().catch(() => ({}));
    const content2 = fBody2.content || '';
    console.log(`\n=== SAMPLE SPEC (${path.basename(sample.specPath)}) ===`);
    content2.split('\n').slice(0, 80).forEach((l, i) => console.log(`${String(i+1).padStart(3)}: ${l}`));
  }
})().catch(e => { console.error(String(e)); process.exit(1); });
