'use strict';
/**
 * P4a ACCEPTANCE smoke (not a guard). The full P4a product, BOTH lanes, end-to-end
 * at the API+export level — the deterministic equivalent of the browser smoke:
 *
 *   SERVER (approval workflow, real testDataApproval + transaction):
 *     upload → map → set a field 'restricted' (UI sensitivity control) → verify →
 *     approve-WITHOUT-note BLOCKS (warning needs a note) → approve-WITH-note → v1.
 *   BRIDGE (the locked P4↔P6 rule):
 *     assemble a ROLE-keyed dataRow from the approved mapping (fields + sensitivity
 *     keyed by columnToField roles, NOT raw headers).
 *   EXPORT (real codegen bddCompiler — the friend's adapter, read-only):
 *     compile a BDD feature from that row → masked→env:, restricted→vault:,
 *     synthetic→literal, and NO literal secret/PII value appears in the .feature.
 *
 * Additive — one synthetic TestDataSet, DELETED in finally. Run AFTER migrate
 * deploy + generate (client must know TestDataMapping):
 *
 *   node scripts/_smoke_p4a_acceptance.cjs [projectId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const dataMapper = require('../server/services/agents/dataMapper');
const tda = require('../server/services/testDataApproval');
const bddCompiler = require('../server/services/codegen/adapters/bddCompiler');

const PID = process.argv.slice(2).find((a) => !a.startsWith('--')) || '9675bfde-acb2-4eda-aaed-b6694b88f920';
const SHEET = {
  name: 'P4aLogin',
  headers: ['Username', 'Password', 'Email Address', 'Mystery'],
  rows: [
    { Username: 'Admin', Password: 'admin123', 'Email Address': 'admin@corp.com', Mystery: 'x' },
    { Username: 'u2', Password: 'pw2', 'Email Address': 'u2@corp.com', Mystery: 'y' },
  ],
};
const SECRET_VALUES = ['admin123', 'pw2'];      // masked → must NOT appear literally
const RESTRICTED_VALUES = ['admin@corp.com', 'u2@corp.com']; // restricted → must NOT appear literally

const results = [];
function check(label, cond, detail) {
  const ok = !!cond;
  results.push({ ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail || ''}`}`);
}
function enrich(mapping) {
  const bindings = (mapping.bindings || []).map((b) => {
    const c2f = (b.columnToField && typeof b.columnToField === 'object') ? b.columnToField : {};
    const sensitivity = (b.sensitivity && typeof b.sensitivity === 'object') ? { ...b.sensitivity } : {};
    for (const role of Object.keys(c2f)) if (!sensitivity[role]) sensitivity[role] = tda.defaultSensitivity(role);
    return { ...b, sensitivity };
  });
  return { ...mapping, bindings };
}
// The locked P4↔P6 bridge: role-keyed fields + sensitivity from the approved mapping.
function assembleRoleKeyedRow(approvedMapping, sheet, rowIndex) {
  const fields = {};
  const sensitivity = {};
  const row = sheet.rows[rowIndex] || {};
  for (const b of approvedMapping.bindings || []) {
    if (b.sheet !== sheet.name) continue;
    for (const [role, header] of Object.entries(b.columnToField || {})) {
      fields[role] = row[header];
      sensitivity[role] = (b.sensitivity || {})[role] || tda.defaultSensitivity(role);
    }
  }
  return { index: rowIndex, label: `Row ${rowIndex + 1}`, fields, sensitivity };
}

(async () => {
  const project = await prisma.project.findUnique({ where: { id: PID } }) || await prisma.project.findFirst();
  const userId = (await prisma.user.findFirst({ select: { id: true } }))?.id;
  console.log(`\n=== P4a ACCEPTANCE smoke · ${project.name} ===\n`);
  let tdId = null;
  try {
    const td = await prisma.testDataSet.create({ data: { projectId: project.id, name: '_P4A_ACCEPT', sheetsJson: JSON.stringify({ sheets: [SHEET], rowCount: 2, warnings: [] }), mappingJson: null, rowCount: 2 } });
    tdId = td.id;

    // ── SERVER: map → set restricted → verify → note-gate → approve ──
    console.log('[server] map → set email=restricted → approve');
    const draft = await dataMapper.mapTestData({ sheets: [SHEET], scenarios: [] });
    // UI sensitivity control: bump email → restricted (password auto-masked; username synthetic).
    for (const b of draft.bindings) { if (b.columnToField && b.columnToField.email) { b.sensitivity = { ...(b.sensitivity || {}), email: 'restricted' }; } }
    await prisma.testDataSet.update({ where: { id: tdId }, data: { mappingJson: JSON.stringify(draft) } });

    const verification = tda.verifyMapping({ mapping: draft, sheets: [SHEET] });
    check('verify ok (no exists-error) with a mapping_unclear warning for the unmapped "Mystery" column',
      verification.ok === true && verification.findings.some((f) => f.code === 'mapping_unclear'),
      JSON.stringify(verification.findings));

    // Note-gate (routes/testData.js POST /approve decision): warnings + no note → blocked.
    const warnings = verification.findings.filter((f) => f.severity === 'warning');
    const blockedNoNote = warnings.length > 0; // route returns 422 APPROVAL_NOTE_REQUIRED
    check('approve WITHOUT a note is blocked when warnings exist (APPROVAL_NOTE_REQUIRED)', blockedNoNote === true);

    // Approve WITH note (transactional version bump).
    const enriched = enrich(draft);
    const approved = await prisma.$transaction(async (tx) => {
      const top = await tx.testDataMapping.findFirst({ where: { testDataSetId: tdId }, orderBy: { version: 'desc' }, select: { version: true } });
      const nextVersion = (top && top.version ? top.version : 0) + 1;
      await tx.testDataMapping.updateMany({ where: { testDataSetId: tdId, status: 'approved' }, data: { status: 'superseded' } });
      return tx.testDataMapping.create({ data: { testDataSetId: tdId, projectId: project.id, version: nextVersion, status: 'approved', mappingJson: JSON.stringify({ ...enriched, version: nextVersion }), verificationJson: JSON.stringify(verification), approvalNote: 'reviewed: Mystery column is not an input', approvedBy: userId, approvedAt: new Date() } });
    });
    const approvedMapping = JSON.parse(approved.mappingJson);
    const sens = (approvedMapping.bindings[0].sensitivity) || {};
    check('approved v1 with note; sensitivity: password=masked, email=restricted, username=synthetic',
      approved.version === 1 && approved.approvalNote && sens.password === 'masked' && sens.email === 'restricted' && sens.username === 'synthetic',
      JSON.stringify(sens));

    // ── BRIDGE: role-keyed dataRows from the approved mapping ──
    console.log('\n[bridge] role-keyed dataRows (fields + sensitivity keyed by role, not header)');
    const dataRows = [assembleRoleKeyedRow(approvedMapping, SHEET, 0), assembleRoleKeyedRow(approvedMapping, SHEET, 1)];
    check('dataRow keyed by ROLE (username/password/email), values pulled from the sheet by header',
      dataRows[0].fields.password === 'admin123' && dataRows[0].sensitivity.password === 'masked' && dataRows[0].sensitivity.email === 'restricted' && dataRows[0].fields.username === 'Admin',
      JSON.stringify(dataRows[0]));

    // ── EXPORT: compile BDD feature; secrets must become safe refs, never literals ──
    console.log('\n[export] compile BDD → masked=env:, restricted=vault:, no literal secrets');
    const compiled = bddCompiler.compileFeature({
      featureName: 'Approved login', scenarioName: 'Login with approved data',
      operations: [
        { operation: 'fillField', params: { field: 'username', value: '<username>' } },
        { operation: 'fillField', params: { field: 'password', value: '<password>' } },
        { operation: 'fillField', params: { field: 'email', value: '<email>' } },
      ],
      dataRows,
    });
    check('feature compiles valid', compiled.valid === true, JSON.stringify(compiled.findings));
    check('masked password → env: ref in Examples', /env:QAAI_TD_PASSWORD_ROW_1/.test(compiled.feature), compiled.feature);
    check('restricted email → vault: ref in Examples', /vault:email:row-1/.test(compiled.feature), compiled.feature);
    check('synthetic username appears literally (Admin)', /\bAdmin\b/.test(compiled.feature));
    check('NO literal secret values leak into the .feature', SECRET_VALUES.every((v) => !compiled.feature.includes(v)), 'a masked value leaked');
    check('NO literal restricted values leak into the .feature', RESTRICTED_VALUES.every((v) => !compiled.feature.includes(v)), 'a restricted value leaked');

    // invalid sensitivity blocks compile (defense in depth)
    const badCompile = bddCompiler.compileFeature({ featureName: 'x', scenarioName: 'y', operations: [{ operation: 'fillField', params: { field: 'username', value: '<username>' } }], dataRows: [{ index: 0, fields: { username: 'a' }, sensitivity: { username: 'plaintext' } }] });
    check('invalid sensitivity ("plaintext") → compile error (bdd_data_row_bad_sensitivity)', badCompile.valid === false && badCompile.findings.some((f) => f.rule === 'bdd_data_row_bad_sensitivity'));

    const failed = results.filter((x) => !x.ok).length;
    console.log(`\n=== ${failed ? 'FAIL' : 'PASS'} — ${results.length - failed}/${results.length} checks passed ===\n`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (tdId) await prisma.testDataSet.delete({ where: { id: tdId } }).catch(() => {});
    console.log('(cleaned up synthetic TestDataSet)');
    await prisma.$disconnect();
  }
})().catch(async (e) => { console.error('\nP4a ACCEPTANCE SMOKE FAILED:', e.message, '\n', e.stack); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
