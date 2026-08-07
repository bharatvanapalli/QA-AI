'use strict';
/**
 * Emit spec files for run cb2836e8 to a local directory for Q1-Q13 audit.
 * Directly calls buildReplayExport from the server layer.
 */
process.chdir(require('path').resolve(__dirname, '..'));
process.env.DATABASE_URL = 'file:./server/prisma/dev.db';

const path = require('path');
const fs = require('fs');

// Need to patch require paths for the server context
const replayExport = require('../server/services/codegen/replayExport');

const RUN_ID = 'cb2836e8-5b06-4044-8328-a4a506d9b98c';
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const OUT_DIR = path.resolve(__dirname, '../scripts/_audit_specs_cb2836e8');

async function main() {
  console.log('Building replay export for run', RUN_ID, '...');
  const result = await replayExport.buildReplayExport({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    framework: 'playwright-reference',
    validate: false,
  });

  console.log('Admitted:', result.admitted?.length ?? '?');
  console.log('Blocked:', result.blocked?.length ?? '?');

  if (result.allBlocked) {
    console.error('All blocked — nothing to emit');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const [rel, content] of Object.entries(result.files || {})) {
    const dest = path.join(OUT_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(String(content || ''), 'utf8'));
  }

  console.log('Files written to:', OUT_DIR);
  const allFiles = listFiles(OUT_DIR);
  console.log('Total files:', allFiles.length);
  allFiles.forEach(f => console.log(' ', f.replace(OUT_DIR + path.sep, '')));
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
