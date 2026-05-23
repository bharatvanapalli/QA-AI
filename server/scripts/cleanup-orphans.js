'use strict';

/**
 * One-shot scanner / cleaner for orphaned files in `playwright/`.
 *
 * Walks three directories:
 *   - playwright/tests/<module>/<tcId>.spec.ts     (per-testcase spec files)
 *   - playwright/pages/<module>/<Class>Page.ts     (page object files)
 *   - playwright/test-results/live/<file>          (screenshots / traces)
 *
 * A file is an ORPHAN if it has NO live DB reference:
 *   - For .spec.ts files: the embedded tcId must exist in TestCase
 *   - For Page.ts files:  the relative path must exist in GovernancePR.filename
 *   - For artifact files: a leading "<uuid>-…" portion must match a TestCase id
 *
 * Usage:
 *   node server/scripts/cleanup-orphans.js          # dry-run, prints orphans
 *   node server/scripts/cleanup-orphans.js --apply  # actually delete them
 *
 * Files in fixtures/, utils/, and playwright.config.ts are NEVER touched
 * (they're project scaffolding, not per-test artifacts).
 */

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');

const ROOT = path.join(__dirname, '..', '..');
const PW_ROOT = path.join(ROOT, 'playwright');
const TESTS_DIR = path.join(PW_ROOT, 'tests');
const PAGES_DIR = path.join(PW_ROOT, 'pages');
const ARTIFACTS_DIR = path.join(PW_ROOT, 'test-results', 'live');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function relFromPlaywright(absPath) {
  // Normalise to forward slashes so it matches GovernancePR.filename which
  // codegen writes as posix-style (`tests/auth/...spec.ts`).
  return path.relative(PW_ROOT, absPath).split(path.sep).join('/');
}

function removeEmptyDirs(rootDir) {
  if (!fs.existsSync(rootDir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const full = path.join(rootDir, entry.name);
      removed += removeEmptyDirs(full);
      try {
        if (fs.readdirSync(full).length === 0) {
          fs.rmdirSync(full);
          removed++;
        }
      } catch (_) {}
    }
  }
  return removed;
}

async function main() {
  const prisma = require('../prisma');

  console.log(`Scanning ${PW_ROOT} (${APPLY ? 'APPLY MODE — files will be deleted' : 'dry-run'})`);

  const [allTcIds, allPrFilenames] = await Promise.all([
    prisma.testCase.findMany({ select: { id: true } }).then((rs) => new Set(rs.map((r) => r.id))),
    prisma.governancePR.findMany({ select: { filename: true } }).then((rs) => new Set(rs.map((r) => r.filename))),
  ]);

  console.log(`DB references: ${allTcIds.size} test case(s), ${allPrFilenames.size} PR filename(s).`);

  const orphans = [];

  // ── tests/<module>/<tcId>.spec.ts ──
  for (const abs of walk(TESTS_DIR)) {
    const base = path.basename(abs);
    const m = base.match(UUID_RE);
    if (!m) continue;
    if (!allTcIds.has(m[0])) orphans.push({ kind: 'spec', path: abs, reason: `tcId ${m[0]} not in DB` });
  }

  // ── pages/<module>/<Class>Page.ts ──
  for (const abs of walk(PAGES_DIR)) {
    const rel = relFromPlaywright(abs);
    if (!allPrFilenames.has(rel)) {
      orphans.push({ kind: 'page', path: abs, reason: `path ${rel} not in any GovernancePR` });
    }
  }

  // ── test-results/live/<tcId>-…  artifacts ──
  for (const abs of walk(ARTIFACTS_DIR)) {
    const base = path.basename(abs);
    const m = base.match(UUID_RE);
    if (!m) continue;  // not a per-tc artifact (could be a one-off file, leave it)
    if (!allTcIds.has(m[0])) orphans.push({ kind: 'artifact', path: abs, reason: `tcId ${m[0]} not in DB` });
  }

  console.log(`\nFound ${orphans.length} orphan file(s):`);
  const byKind = { spec: 0, page: 0, artifact: 0 };
  for (const o of orphans) {
    byKind[o.kind]++;
    console.log(`  [${o.kind.padEnd(8)}] ${relFromPlaywright(o.path)}  (${o.reason})`);
  }
  console.log(`\nBreakdown: specs=${byKind.spec}, pages=${byKind.page}, artifacts=${byKind.artifact}`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to delete these files.');
    await prisma.$disconnect();
    return;
  }

  let deleted = 0;
  for (const o of orphans) {
    try {
      fs.unlinkSync(o.path);
      deleted++;
    } catch (err) {
      console.error(`  FAILED to delete ${o.path}: ${err.message}`);
    }
  }
  console.log(`\nDeleted ${deleted}/${orphans.length} file(s).`);

  // Sweep empty per-module directories (tests/<module>/, pages/<module>/).
  const emptiedT = removeEmptyDirs(TESTS_DIR);
  const emptiedP = removeEmptyDirs(PAGES_DIR);
  const emptiedA = removeEmptyDirs(ARTIFACTS_DIR);
  console.log(`Removed empty subdirs: tests=${emptiedT}, pages=${emptiedP}, test-results/live=${emptiedA}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('cleanup-orphans failed:', err);
  process.exit(1);
});
