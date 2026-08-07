'use strict';
/**
 * Read all output files for run cb2836e8 using the replayir source.
 * Gets tree from /, then reads each file via /file/*.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');

const BASE = 'http://localhost:5000';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const RUN_ID = 'cb2836e8-5b06-4044-8328-a4a506d9b98c';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
const OUT_DIR = path.resolve(__dirname, '_audit_specs_cb2836e8');

function makeHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return {
    'Content-Type': 'application/json',
    Cookie: `token=${token}; XSRF-TOKEN=${csrf}`,
    'x-xsrf-token': csrf,
  };
}

function collectPaths(node, acc = []) {
  if (!node) return acc;
  if (node.type === 'file') { acc.push(node.path); return acc; }
  for (const child of (node.children || [])) collectPaths(child, acc);
  return acc;
}

async function main() {
  // 1. Get file tree via replayir source
  const treeRes = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/output-files/?source=replayir&runId=${RUN_ID}`,
    { headers: makeHeaders() }
  );
  if (!treeRes.ok) {
    const txt = await treeRes.text();
    console.error('tree fetch failed:', treeRes.status, txt.slice(0, 500));
    return;
  }
  const treeData = await treeRes.json();
  console.log('Stats:', JSON.stringify(treeData.stats));
  console.log('Run:', JSON.stringify(treeData.run));
  if (treeData.exportBlocked) console.warn('EXPORT BLOCKED:', treeData.exportBlockReason, treeData.exportBlockDetail);

  const allPaths = collectPaths(treeData.tree);
  console.log(`\nTotal files in tree: ${allPaths.length}`);
  const specPaths = allPaths.filter(p => p && (p.endsWith('.spec.ts') || p.endsWith('.spec.js') || p.endsWith('.ts') || p.endsWith('.js') || p.endsWith('.feature')));
  console.log(`Spec-like files: ${specPaths.length}\n`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const filePath of allPaths) {
    const fileRes = await fetch(
      `${BASE}/api/projects/${PROJECT_ID}/output-files/file/${filePath}?source=replayir&runId=${RUN_ID}`,
      { headers: makeHeaders() }
    );
    if (!fileRes.ok) {
      console.log(`[SKIP] ${filePath} — ${fileRes.status}`);
      continue;
    }
    const data = await fileRes.json().catch(() => null);
    const content = data?.content ?? '';

    // Write to disk
    const dest = path.join(OUT_DIR, filePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }

  console.log('\nAll files written to:', OUT_DIR);
  const diskFiles = listFiles(OUT_DIR);
  diskFiles.forEach(f => console.log(' ', f.replace(OUT_DIR + path.sep, '')));
}

function listFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(full));
    else result.push(full);
  }
  return result;
}

main().catch(e => { console.error(e); process.exit(1); });
