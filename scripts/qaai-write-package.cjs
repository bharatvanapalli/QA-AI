'use strict';
/**
 * Generate the live-replay Playwright package and write all files to disk.
 *
 * Usage:
 *   node scripts/qaai-write-package.cjs --run <runId> --framework <framework> --out-dir <outDir> [--project <projectId>]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const gen = require('../server/services/codegen/liveReplayCodegen');
const prisma = require('../server/prisma');
const fs = require('fs');
const path = require('path');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const RUN_ID = argValue('--run', null);
const PROJECT_ID = argValue('--project', '1582559f-364f-4d0e-bfde-fd18832fdaa7');
const FRAMEWORK = argValue('--framework', 'playwright-pom');
const OUT_DIR = argValue('--out-dir', null);

(async () => {
  if (!RUN_ID) throw new Error('Pass --run <runId>.');
  if (!OUT_DIR) throw new Error('Pass --out-dir <outDir>.');

  console.log(`Generating files for run ${RUN_ID} (framework: ${FRAMEWORK})...`);
  const result = await gen.buildLiveReplayPackage({ projectId: PROJECT_ID, runId: RUN_ID, framework: FRAMEWORK });

  console.log(`Writing files to ${OUT_DIR}...`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const [relPath, content] of Object.entries(result.files)) {
    const fullPath = path.join(OUT_DIR, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log(`  - Wrote ${relPath}`);
  }

  console.log('Done!');
})().catch((err) => {
  console.error('WRITE_FAILED:', err);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
