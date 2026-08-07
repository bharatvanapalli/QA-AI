'use strict';

const { PrismaClient } = require('@prisma/client');
const { sanitizeDeep, sanitizeTokenCorruptions } = require('../server/lib/tokenHygiene');

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normSheet(value) {
  return String(value == null ? '' : value)
    .replace(/\{\{[^}]+\}\}/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function editDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const prev = Array.from({ length: right.length + 1 }, (_, i) => i);
  const cur = Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      cur[j] = left[i - 1] === right[j - 1]
        ? prev[j - 1]
        : Math.min(prev[j - 1], prev[j], cur[j - 1]) + 1;
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = cur[j];
  }
  return prev[right.length];
}

function findBinding(mapping, sheetName) {
  const bindings = Array.isArray(mapping && mapping.bindings) ? mapping.bindings : [];
  if (!bindings.length || !sheetName) return null;
  const wanted = normSheet(sheetName);
  const exact = bindings.find((b) => normSheet(b && b.sheet) === wanted);
  if (exact) return exact;
  let best = null;
  for (const binding of bindings) {
    if (!binding || !binding.sheet) continue;
    const candidate = normSheet(binding.sheet);
    const distance = editDistance(wanted, candidate);
    const maxAllowed = Math.max(3, Math.ceil(Math.max(wanted.length, candidate.length) * 0.25));
    if (distance <= maxAllowed && (!best || distance < best.distance)) {
      best = { binding, distance };
    }
  }
  return best && best.binding;
}

function fieldCorrupt(value) {
  return /\{\{[^}]+\}\}/.test(String(value == null ? '' : value));
}

function bindingHasCorruptFields(binding) {
  if (!binding || typeof binding !== 'object') return false;
  if (fieldCorrupt(binding.sheet)) return true;
  for (const value of Object.values(binding.columnToField || {})) {
    if (fieldCorrupt(value)) return true;
  }
  return fieldCorrupt(binding.expectedColumn) || fieldCorrupt(binding.rowClassColumn);
}

function normalizePlaceholder(value) {
  return String(value == null ? '' : value)
    .replace(/^\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .trim();
}

function repairedBinding(existing, source) {
  const placeholders = Array.isArray(existing.placeholders)
    ? existing.placeholders.map(normalizePlaceholder).filter(Boolean)
    : [];
  const out = {
    ...existing,
    sheet: source.sheet,
    columnToField: source.columnToField && typeof source.columnToField === 'object'
      ? source.columnToField
      : (existing.columnToField || {}),
    expectedColumn: source.expectedColumn || existing.expectedColumn || undefined,
    rowClassColumn: source.rowClassColumn || existing.rowClassColumn || undefined,
    status: existing.status === 'incomplete' ? 'complete' : (existing.status || 'complete'),
    placeholders: Array.from(new Set(placeholders)),
    repairedBy: 'repair_corrupted_data_bindings',
    repairedAt: new Date().toISOString(),
  };
  if (Array.isArray(existing.findings)) {
    const kept = existing.findings.filter((finding) => !/\{\{[^}]+\}\}/.test(JSON.stringify(finding || {})));
    if (kept.length) out.findings = kept;
    else delete out.findings;
  }
  for (const key of ['expectedColumn', 'rowClassColumn']) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

async function main() {
  const dataSets = await prisma.testDataSet.findMany({
    orderBy: { uploadedAt: 'desc' },
    select: { projectId: true, mappingJson: true, uploadedAt: true, name: true },
  });
  const mappingByProject = new Map();
  for (const ds of dataSets) {
    if (mappingByProject.has(ds.projectId)) continue;
    const mapping = parseJson(ds.mappingJson, null);
    if (mapping && Array.isArray(mapping.bindings)) mappingByProject.set(ds.projectId, mapping);
  }

  const cases = await prisma.testCase.findMany({
    where: { dataBindingJson: { not: null } },
    select: {
      id: true,
      projectId: true,
      name: true,
      dataBindingJson: true,
      steps: true,
      declaredAssertions: true,
      assertions: true,
    },
  });

  const repairs = [];
  const skipped = [];
  for (const tc of cases) {
    const binding = parseJson(tc.dataBindingJson, null);
    if (!bindingHasCorruptFields(binding)) continue;
    const mapping = mappingByProject.get(tc.projectId);
    const source = findBinding(mapping, binding && binding.sheet);
    if (!source) {
      skipped.push({ id: tc.id, name: tc.name, sheet: binding && binding.sheet });
      continue;
    }
    const nextBinding = repairedBinding(binding, source);
    repairs.push({
      id: tc.id,
      name: tc.name,
      fromSheet: binding.sheet,
      toSheet: nextBinding.sheet,
      data: {
        name: sanitizeTokenCorruptions(tc.name),
        assertions: sanitizeTokenCorruptions(tc.assertions),
        steps: tc.steps ? JSON.stringify(sanitizeDeep(parseJson(tc.steps, []))) : tc.steps,
        declaredAssertions: tc.declaredAssertions ? JSON.stringify(sanitizeDeep(parseJson(tc.declaredAssertions, []))) : tc.declaredAssertions,
        dataBindingJson: JSON.stringify(nextBinding),
      },
    });
  }

  console.log(JSON.stringify({
    mode: APPLY ? 'apply' : 'dry-run',
    repairCount: repairs.length,
    skippedCount: skipped.length,
    samples: repairs.slice(0, 12).map((r) => ({ id: r.id, name: r.name, fromSheet: r.fromSheet, toSheet: r.toSheet })),
    skipped: skipped.slice(0, 12),
  }, null, 2));

  if (APPLY) {
    for (const repair of repairs) {
      await prisma.testCase.update({ where: { id: repair.id }, data: repair.data });
    }
    console.log(`Applied ${repairs.length} data-binding repair(s).`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
