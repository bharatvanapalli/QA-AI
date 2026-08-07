'use strict';
// Validate EVERY step/assertion token in the current generation against the actual test-data
// sheets/columns/rows. For each case: load its bound sheet, resolve every {{token}} against the
// binding's columnToField / expectedColumn / rowClassColumn / raw headers, and flag unresolved
// tokens (the data_placeholder_not_in_mapping class) + cases bound to a non-existent sheet.
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

(async () => {
  const gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT_ID, isCurrent: true }, orderBy: { version: 'desc' } });
  const tds = await prisma.testDataSet.findFirst({ where: { projectId: PROJECT_ID }, orderBy: { uploadedAt: 'desc' } });
  const sheetsRaw = parse(tds.sheetsJson);
  const sheetArr = Array.isArray(sheetsRaw?.sheets) ? sheetsRaw.sheets : Array.isArray(sheetsRaw) ? sheetsRaw : [];
  const sheetByNorm = new Map(sheetArr.map((s) => [norm(s.name), s]));

  // Companion-credential availability (mirrors testDataMatrix.buildCredentialJoin): any sheet that
  // provides username+password can supply credentials to a case bound to an expectations sheet that
  // has the identity but no password.
  const mapping = parse(tds.mappingJson);
  const mapBindings = Array.isArray(mapping?.bindings) ? mapping.bindings : [];
  const authSheetCreds = new Set();
  for (const b of mapBindings) {
    const bc = b && b.columnToField ? b.columnToField : {};
    const hasUser = bc.username || bc.user || bc.login || bc.email;
    if (hasUser && bc.password) { for (const r of ['password', 'otp', 'secret']) if (bc[r]) authSheetCreds.add(r); }
  }

  const cases = await prisma.testCase.findMany({ where: { projectId: PROJECT_ID, generationId: gen.id }, orderBy: { createdAt: 'asc' } });
  console.log(`GENERATION v${gen.version} — validating ${cases.length} cases against ${sheetArr.length} sheets\n`);

  let totalTokens = 0, totalUnresolved = 0, casesWithUnresolved = 0, casesSheetMissing = 0, casesOk = 0;
  const unresolvedDetail = [];

  for (const c of cases) {
    const db = parse(c.dataBindingJson) || {};
    const sheetName = db.sheet;
    const blob = JSON.stringify({ steps: parse(c.steps) || [], da: parse(c.declaredAssertions) || [] });
    const tokens = new Set();
    let m; TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(blob))) tokens.add(m[1]);
    const tokenList = Array.from(tokens);
    totalTokens += tokenList.length;

    if (!sheetName) { console.log(`  [NO-SHEET] "${c.name}" — tokens=[${tokenList.join(',')}]`); continue; }
    const sheet = sheetByNorm.get(norm(sheetName));
    if (!sheet) { casesSheetMissing++; console.log(`  [SHEET-MISSING] "${c.name}" bound sheet="${sheetName}" not in test data!`); continue; }

    // Build the set of resolvable token names for this binding.
    const c2f = db.columnToField && typeof db.columnToField === 'object' ? db.columnToField : {};
    const resolvable = new Set(Object.keys(c2f).map(norm));
    if (db.expectedColumn) resolvable.add('expected');
    if (db.rowClassColumn) resolvable.add('rowclass');
    const headers = sheet.headers || (sheet.rows && sheet.rows[0] ? Object.keys(sheet.rows[0]) : []);
    for (const h of headers) resolvable.add(norm(h));
    // Cross-sheet credential join (testDataMatrix.buildCredentialJoin): a companion auth sheet
    // supplies login credentials at runtime — by identity-VALUE join when the bound sheet has an
    // identity column, or by DEFAULT (first companion row) when it has none. Either way, if a
    // companion auth sheet exists, the credential tokens resolve.
    if (authSheetCreds.size) { resolvable.add('username'); for (const r of authSheetCreds) resolvable.add(r); }

    const unresolved = tokenList.filter((t) => !resolvable.has(norm(t)));
    if (unresolved.length) {
      casesWithUnresolved++;
      totalUnresolved += unresolved.length;
      unresolvedDetail.push(`  [UNRESOLVED] "${c.name}" sheet=${sheetName} → ${unresolved.map((t) => '{{' + t + '}}').join(', ')}  (sheet headers: ${headers.join(', ')})`);
    } else {
      casesOk++;
    }
  }

  console.log('=== UNRESOLVED-TOKEN CASES ===');
  if (unresolvedDetail.length) unresolvedDetail.forEach((l) => console.log(l)); else console.log('  (none — every token in every case resolves to a real column/header)');

  console.log('\n════════ DATA-VALIDATION SUMMARY ════════');
  console.log(`cases=${cases.length} | fully-resolved=${casesOk} | with-unresolved-token=${casesWithUnresolved} | bound-sheet-missing=${casesSheetMissing}`);
  console.log(`tokens total=${totalTokens} | unresolved=${totalUnresolved}`);
  console.log(`\n  [${totalUnresolved === 0 && casesSheetMissing === 0 ? 'PASS' : 'FAIL'}] every step/assertion token resolves to a real sheet column/header`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
