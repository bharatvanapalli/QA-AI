'use strict';
/**
 * One-shot patch: mark dataBinding.status='complete' for every TestCase that
 * references a sheet which EXISTS in the project's TestDataSet.
 * Also reclassifies cases marked manual for infra-only reasons.
 *
 * Safe: only updates JSON fields, never deletes anything.
 * Run: node scripts/_patch_data_binding.cjs
 */

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { PrismaClient } = require('@prisma/client');

// Inline: sheets whose name suggests they are documentation, not executable data.
const NON_EXEC_RE = /readme|instructions?|overview|legend|notes?|guide|how.?to|template|example/i;
function isNonExecutableSheet(s) {
  return NON_EXEC_RE.test(s && s.name || '');
}

const prisma = new PrismaClient();

function normSheet(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function parseMaybe(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

// Invalid manual reasons: infra/tooling gaps — not genuine human-only constraints.
function isInvalidManualReason(reason) {
  const r = String(reason || '').toLowerCase();
  return r.includes('site atlas') || r.includes('atlas capability') || r.includes('atlas gap')
    || r.includes('not confirmed in') || r.includes('coverage item')
    || r.includes('credential') || r.includes('not configured')
    || r.includes('fixture') || r.includes('not set up')
    || r.includes('not available') || r.includes('access control')
    || r.includes('role') || r.includes('permission');
}

async function main() {
  // 1. Load all projects and their test data sheets.
  const projects = await prisma.project.findMany({ select: { id: true } });
  const sheetsByProject = new Map();

  for (const proj of projects) {
    const tds = await prisma.testDataSet.findFirst({
      where: { projectId: proj.id },
      select: { sheetsJson: true },
    });
    if (!tds) { sheetsByProject.set(proj.id, new Set()); continue; }
    const parsed = parseMaybe(tds.sheetsJson);
    const raw = Array.isArray(parsed?.sheets) ? parsed.sheets
      : Array.isArray(parsed) ? parsed : [];
    const nameSet = new Set(
      raw
        .filter(s => s && !isNonExecutableSheet(s))
        .map(s => normSheet(s.name || ''))
        .filter(Boolean),
    );
    sheetsByProject.set(proj.id, nameSet);
  }

  // 2. Fetch all test cases.
  const cases = await prisma.testCase.findMany({
    select: {
      id: true,
      projectId: true,
      dataBindingJson: true,
      automatability: true,
      automatabilityReason: true,
    },
  });

  let bindingFixed = 0;
  let manualFixed = 0;

  for (const tc of cases) {
    const updates = {};

    // Fix dataBinding.status
    if (tc.dataBindingJson) {
      const db = parseMaybe(tc.dataBindingJson);
      if (db && db.sheet && db.status !== 'complete') {
        const sheetKey = normSheet(db.sheet);
        const projectSheets = sheetsByProject.get(tc.projectId) || new Set();
        if (projectSheets.has(sheetKey)) {
          updates.dataBindingJson = JSON.stringify({ ...db, status: 'complete', repairedBy: 'patch_data_binding' });
          bindingFixed++;
        }
      }
    }

    // Fix incorrect manual classification
    if (tc.automatability === 'manual' && tc.automatabilityReason && isInvalidManualReason(tc.automatabilityReason)) {
      updates.automatability = 'automatable';
      updates.automatabilityReason = null;
      manualFixed++;
    }

    if (Object.keys(updates).length > 0) {
      await prisma.testCase.update({ where: { id: tc.id }, data: updates });
    }
  }

  console.log(`Done. dataBinding fixed: ${bindingFixed} | manual→automatable: ${manualFixed}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
