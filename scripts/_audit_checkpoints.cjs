'use strict';
/**
 * Full T1–T5 checkpoint audit against a completed run's exported specs.
 * Usage: node scripts/_audit_checkpoints.cjs [RUN_ID]
 * Defaults to the most-recent completed OrangeHRM run.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
const RUN_ID = process.argv[2] || null;

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}

function walkTree(node, out = []) {
  if (!node) return out;
  if (node.type === 'file' && String(node.path || '').endsWith('.spec.js')) out.push(node.path);
  (node.children || []).forEach(c => walkTree(c, out));
  return out;
}

// ── Per-spec checkpoint checks ───────────────────────────────────────────────

function checkT1_1(content) {
  // Zero inline page.locator/getByRole/getByLabel/click/fill in spec body
  const matches = content.match(/\bpage\.(locator|getByRole|getByLabel|getByPlaceholder|getByText|click|fill)\s*\(/g) || [];
  return { pass: matches.length === 0, detail: matches.slice(0, 3) };
}

function checkT1_3(content) {
  const matches = content.match(/\bconst el\d+\s*=/g) || [];
  return { pass: matches.length === 0, detail: matches.slice(0, 3) };
}

function checkT1_4(content) {
  const matches = content.match(/ASN-[a-f0-9]+/gi) || [];
  return { pass: matches.length === 0, detail: matches.slice(0, 3) };
}

function checkT1_5(content) {
  // No ad-hoc `for (const row of ...)` inside a test.step body
  // (test.each() at describe scope is fine; for-loop inside step is not)
  const stepBodies = [];
  const re = /await test\.step\([^,]+,\s*async\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*\)/g;
  let m;
  while ((m = re.exec(content)) !== null) stepBodies.push(m[1]);
  const badLoops = stepBodies.filter(b => /\bfor\s*\(const\b/.test(b));
  return { pass: badLoops.length === 0, detail: badLoops.length > 0 ? ['for-loop inside test.step'] : [] };
}

function checkT2_2(content) {
  // evaluateSettled IIFEs must use expression body () => (expr), not block body without return
  const re = /evaluateSettled\s*\(\s*page\s*,\s*async\s*\(\s*\)\s*=>\s*\{([^}]*)\}\s*[,)]/g;
  let m;
  const bad = [];
  while ((m = re.exec(content)) !== null) {
    const body = m[1].trim();
    if (body.length > 0 && !/^\s*return\s/.test(body)) bad.push(body.slice(0, 60));
  }
  return { pass: bad.length === 0, detail: bad };
}

function checkT2_3(content) {
  const matches = content.match(/waitForLoadState\s*\(\s*['"`]networkidle['"`]/g) || [];
  return { pass: matches.length === 0, detail: matches };
}

function checkT4_1_noEnvCreds(content) {
  // Negative/invalid-credential specs must NOT have readEnv('QAAI_PASSWORD') or QAAI_USERNAME
  // (This check only applies to specs with "invalid" or "negative" in the name)
  return null; // evaluated per-spec based on filename below
}

function checkT4_2_ast(content, filePath) {
  // Check that acorn can parse the content (AST gate)
  // We do a simple brace-balance check as a proxy (acorn not available in this script env)
  let depth = 0;
  let inStr = false;
  let strChar = '';
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inStr) {
      if (c === strChar && content[i-1] !== '\\') inStr = false;
    } else {
      if (c === '"' || c === "'" || c === '`') { inStr = true; strChar = c; }
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
  }
  return { pass: depth === 0, detail: depth !== 0 ? [`Unbalanced braces: depth=${depth}`] : [] };
}

function checkT5_3_envCreds(content) {
  // Valid credentials must use readEnv(), not plaintext literals like 'Admin'/'admin123'
  // Heuristic: fill("Admin") or fill("admin") are suspicious
  const suspicious = content.match(/\.fill\(\s*["'](?:Admin|admin|password|Password|123456|admin123)["']\s*\)/g) || [];
  return { pass: suspicious.length === 0, detail: suspicious };
}

function checkT5_4_urlEnvVar(content) {
  // page.goto() must NOT have hardcoded https:// URLs — must use readEnv('QAAI_TARGET_URL')
  const hardcoded = content.match(/page\.goto\s*\(\s*["']https?:\/\/[^"']+["']/g) || [];
  return { pass: hardcoded.length === 0, detail: hardcoded.slice(0, 2) };
}

function checkT5_5_payloadPreserved(content, isNegative) {
  // For negative specs, check that we have literal fill values (not just env refs)
  if (!isNegative) return { pass: true, detail: [] };
  const fills = content.match(/\.fill\(([^)]+)\)/g) || [];
  const allEnvRef = fills.every(f => /readEnv\(/.test(f));
  if (allEnvRef && fills.length > 0) {
    return { pass: false, detail: ['All fills use readEnv() — expected literal invalid credentials'] };
  }
  return { pass: true, detail: [] };
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const headers = makeHeaders();

  // Resolve run ID
  let runId = RUN_ID;
  if (!runId) {
    const runsRes = await fetch(`${BASE}/api/runs?projectId=${PROJECT_ID}&limit=10`, { headers });
    const runsData = await runsRes.json().catch(() => ({}));
    const runs = runsData.runs || runsData || [];
    const completed = Array.isArray(runs) ? runs.find(r => r.status === 'completed') : null;
    if (!completed) { console.log('No completed run found. Pass RUN_ID as argument.'); process.exit(1); }
    runId = completed.id;
    console.log(`Using most recent completed run: ${runId} (pass=${completed.passed} fail=${completed.failed})`);
  }

  // Manifest
  const mRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/file/EXPORT_MANIFEST.json?source=replayir&runId=${runId}`,
    { headers }
  );
  const mBody = await mRes.json().catch(() => ({}));
  const mContent = mBody.content ? JSON.parse(mBody.content) : mBody;
  const entries = mContent?.entries || [];
  const blocked = entries.filter(e => e.blockReason);
  const exported = entries.filter(e => !e.blockReason && e.files && e.files.length > 0);

  console.log(`\n=== MANIFEST ===`);
  console.log(`Total: ${entries.length}  Exported: ${exported.length}  Blocked: ${blocked.length}`);
  if (blocked.length > 0) {
    const groups = {};
    blocked.forEach(e => { groups[e.blockReason] = (groups[e.blockReason]||0)+1; });
    console.log(`Block reasons: ${JSON.stringify(groups)}`);
    blocked.forEach(e => console.log(`  [${e.blockReason}] "${e.caseName || e.scenarioName || 'n/a'}"`));
  } else {
    console.log('✓ Zero blocked entries');
  }

  // Collect spec files
  const treeRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/?source=replayir&runId=${runId}`,
    { headers }
  );
  const treeData = await treeRes.json().catch(() => ({}));
  const specFiles = walkTree(treeData?.tree);
  console.log(`\nSpec files: ${specFiles.length}`);
  specFiles.forEach(f => console.log('  ' + f));

  // Per-spec audit
  const results = [];
  for (const specPath of specFiles) {
    const fRes = await fetch(
      `${BASE}/api/projects/${PROJECT_ID}/output-files/file/${encodeURIComponent(specPath)}?source=replayir&runId=${runId}`,
      { headers }
    );
    if (!fRes.ok) { console.log(`\n[SKIP] ${specPath} — HTTP ${fRes.status}`); continue; }
    const fBody = await fRes.json().catch(() => ({}));
    const content = fBody.content || '';
    if (!content) { console.log(`\n[SKIP] ${specPath} — empty`); continue; }

    const name = path.basename(specPath);
    // "security" alone is too broad — a case like "login-form-security-no-sensitive-info"
    // tests information exposure using VALID credentials, not wrong ones. Only treat as
    // negative when the name specifically signals credential rejection or injection payloads.
    const isNegative = /invalid|negative|wrong.?cred|wrong.?pass|empty.?pass|xss|sqli|injection/i.test(name);

    const t1_1 = checkT1_1(content);
    const t1_3 = checkT1_3(content);
    const t1_4 = checkT1_4(content);
    const t1_5 = checkT1_5(content);
    const t2_2 = checkT2_2(content);
    const t2_3 = checkT2_3(content);
    const t4_2 = checkT4_2_ast(content, specPath);
    const t5_3 = checkT5_3_envCreds(content);
    const t5_4 = checkT5_4_urlEnvVar(content);
    const t5_5 = checkT5_5_payloadPreserved(content, isNegative);

    // Q8 check: negative specs must have literal credential fills
    const envCredRefs = content.match(/readEnv\s*\(\s*['"]QAAI_(USERNAME|PASSWORD)['"]\s*\)/g) || [];
    const literalFills = content.match(/\.fill\s*\(\s*"[^"]{3,}"\s*\)/g) || [];
    const resolveCount = (content.match(/await resolveLocator\s*\(/g) || []).length;

    // Collect variable names
    const varNames = [...new Set((content.match(/const\s+(\w+)\s*=\s*await resolveLocator/g) || []).map(m => m.match(/const\s+(\w+)/)[1]))];

    const allPass = t1_1.pass && t1_3.pass && t1_4.pass && t1_5.pass && t2_2.pass && t2_3.pass && t4_2.pass && t5_3.pass && t5_4.pass && t5_5.pass;
    results.push({ specPath, name, isNegative, t1_1, t1_3, t1_4, t1_5, t2_2, t2_3, t4_2, t5_3, t5_4, t5_5, allPass, resolveCount, varNames, envCredRefs, literalFills });
  }

  // Print per-spec results
  console.log('\n=== T1–T5 CHECKPOINT AUDIT ===\n');
  for (const r of results) {
    const icon = r.allPass ? '✓' : '✗';
    console.log(`${icon} ${r.name}${r.isNegative ? ' [negative]' : ''}`);
    const checks = [
      ['T1.1 No inline selectors', r.t1_1],
      ['T1.3 No el1/el2 vars',     r.t1_3],
      ['T1.4 No ASN hashes',       r.t1_4],
      ['T1.5 No for-loop in step', r.t1_5],
      ['T2.2 IIFE expr-body',      r.t2_2],
      ['T2.3 No networkidle',      r.t2_3],
      ['T4.2 AST balance',         r.t4_2],
      ['T5.3 No plaintext creds',  r.t5_3],
      ['T5.4 URL via env var',     r.t5_4],
      ['T5.5 Payload preserved',   r.t5_5],
    ];
    checks.forEach(([label, result]) => {
      const s = result.pass ? '✓' : `FAIL: ${result.detail.join(' | ').slice(0, 80)}`;
      console.log(`  ${label.padEnd(28)}: ${s}`);
    });
    console.log(`  resolveLocator calls: ${r.resolveCount}  vars: ${r.varNames.join(', ') || '(none)'}`);
    if (r.isNegative) {
      console.log(`  Literal fills: ${r.literalFills.length}  EnvCred refs: ${r.envCredRefs.length}`);
    }
    console.log('');
  }

  // Summary table
  const totals = {};
  const checks = ['t1_1','t1_3','t1_4','t1_5','t2_2','t2_3','t4_2','t5_3','t5_4','t5_5'];
  checks.forEach(k => { totals[k] = results.every(r => r[k].pass) ? 'ALL PASS' : `FAIL (${results.filter(r=>!r[k].pass).length} spec(s))`; });

  console.log('=== SUMMARY ===');
  console.log(`Specs: ${results.length}  All-pass: ${results.filter(r=>r.allPass).length}/${results.length}`);
  console.log(`Blocked manifest entries: ${blocked.length} (want 0)`);
  console.log('');
  console.log(`T1.1 No inline selectors     : ${totals.t1_1}`);
  console.log(`T1.3 No el1/el2 names        : ${totals.t1_3}`);
  console.log(`T1.4 No ASN hashes           : ${totals.t1_4}`);
  console.log(`T1.5 No for-loop in step     : ${totals.t1_5}`);
  console.log(`T2.2 IIFE expr-body          : ${totals.t2_2}`);
  console.log(`T2.3 No networkidle          : ${totals.t2_3}`);
  console.log(`T4.2 AST brace balance       : ${totals.t4_2}`);
  console.log(`T5.3 No plaintext creds      : ${totals.t5_3}`);
  console.log(`T5.4 URL via QAAI_TARGET_URL : ${totals.t5_4}`);
  console.log(`T5.5 Payload preserved       : ${totals.t5_5}`);

  // T1.2 note (POM adapter — applies to playwright-pom, not replayir flat export)
  console.log('');
  console.log('NOTE T1.2 (Pure POM): The replayir flat export uses resolveLocator() directly');
  console.log('  by design — faithful step-by-step replay. POM encapsulation applies to the');
  console.log('  playwright-pom adapter output (separate export format).');
})().catch(e => { console.error(String(e)); process.exit(1); });
