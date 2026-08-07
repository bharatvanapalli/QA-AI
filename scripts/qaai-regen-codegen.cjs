'use strict';
/**
 * Regenerate the live-replay Playwright spec for a run and print it to
 * stdout, exactly as liveReplayCodegen.js would produce for
 * GET /output-files/live-replay.zip or the replayExport.js bridge. Use this
 * to eyeball generated code after a fix, before trusting the UI.
 *
 * Usage:
 *   node scripts/qaai-regen-codegen.js --run <runId> [--project <projectId>]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const gen = require('../server/services/codegen/liveReplayCodegen');
const prisma = require('../server/prisma');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const RUN_ID = argValue('--run', null);
const PROJECT_ID = argValue('--project', '1582559f-364f-4d0e-bfde-fd18832fdaa7');
const FRAMEWORK = argValue('--framework', 'playwright-reference');

(async () => {
  if (!RUN_ID) throw new Error('Pass --run <runId>.');
  const result = await gen.buildLiveReplayPackage({ projectId: PROJECT_ID, runId: RUN_ID, framework: FRAMEWORK });
  console.log('admitted:', JSON.stringify(result.admitted, null, 2));
  console.log('blocked:', JSON.stringify(result.blocked, null, 2));
  for (const [path, body] of Object.entries(result.files)) {
    console.log(`\n=== ${path} ===`);
    console.log(body);
  }
})().catch((err) => {
  console.error('REGEN_FAILED:', err.message);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());

