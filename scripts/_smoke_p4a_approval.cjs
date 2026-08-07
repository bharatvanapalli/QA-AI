'use strict';
/**
 * P4a live smoke (not a guard). Proves the TestData approval gate end-to-end on
 * the real DB, using the SAME modules the route + canonical writer use:
 *
 *   1. verifyMapping blocks an EXISTS error (a bound column not in the sheet) —
 *      the thing /approve would 422 on.
 *   2. transactional approve (max+1 → supersede → create) creates an IMMUTABLE
 *      v1 approved row; sensitivity defaulted (password→masked).
 *   3. edit the draft → mappingState 'draft_unapproved_changes' (canonical diff).
 *   4. re-approve → v2 approved, v1 → superseded, and v1's mappingJson is
 *      UNCHANGED (immutability).
 *   5. A1 provenance: loadTestDataContext({approvedOnly:true}) returns the
 *      consumed {mappingId, version} + stamps bindings; persistCases PINS a
 *      case's dataBindingJson to {mappingId, mappingVersion} (never "latest").
 *   6. resolvePlaceholders against the approved mapping resolves {{username}}/
 *      {{password}} and flags an unmapped {{ssn}}.
 *
 * Additive — creates ONE synthetic TestDataSet + ONE synthetic generation, then
 * DELETES both in finally (cascade removes their mappings/scenarios/cases).
 * Nothing existing is wiped. Run AFTER `prisma migrate deploy` + `prisma generate`
 * (the client must know TestDataMapping):
 *
 *   node scripts/_smoke_p4a_approval.cjs [projectId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const dataMapper = require('../server/services/agents/dataMapper');
const tda = require('../server/services/testDataApproval');
const { loadTestDataContext } = require('../server/services/testDataContext');
const tcc = require('../server/services/testCaseContract');

const PID = process.argv.slice(2).find((a) => !a.startsWith('--')) || '9675bfde-acb2-4eda-aaed-b6694b88f920';
const SHEET = {
  name: 'P4aLogin',
  headers: ['Username', 'Password', 'Expected Result'],
  rows: [
    { Username: 'Admin', Password: 'admin123', 'Expected Result': 'Dashboard' },
    { Username: '', Password: 'x', 'Expected Result': 'Required' },
  ],
};

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

// Mirror routes/testData.js POST /approve transaction (max+1 → supersede → create), with P2002 retry.
async function approveDraft({ tdId, projectId, draft, verification, userId, note }) {
  const enriched = enrich(draft);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const top = await tx.testDataMapping.findFirst({ where: { testDataSetId: tdId }, orderBy: { version: 'desc' }, select: { version: true } });
        const nextVersion = (top && top.version ? top.version : 0) + 1;
        await tx.testDataMapping.updateMany({ where: { testDataSetId: tdId, status: 'approved' }, data: { status: 'superseded' } });
        const row = await tx.testDataMapping.create({
          data: {
            testDataSetId: tdId, projectId, version: nextVersion, status: 'approved',
            mappingJson: JSON.stringify({ ...enriched, version: nextVersion }),
            verificationJson: JSON.stringify(verification), approvalNote: note || null,
            approvedBy: userId, approvedAt: new Date(),
          },
        });
        return row;
      });
    } catch (e) {
      if (e && e.code === 'P2002' && attempt < 5) continue;
      throw e;
    }
  }
}

(async () => {
  const project = await prisma.project.findUnique({ where: { id: PID } }) || await prisma.project.findFirst();
  if (!project) throw new Error('no project');
  const u = await prisma.user.findFirst({ select: { id: true } });
  const userId = u && u.id;
  console.log(`\n=== P4a approval smoke · ${project.name} ===\n`);

  let tdId = null;
  let genId = null;
  try {
    // ── setup: synthetic TestDataSet + a deterministic draft mapping ──
    const td = await prisma.testDataSet.create({
      data: { projectId: project.id, name: '_P4A_SMOKE', sheetsJson: JSON.stringify({ sheets: [SHEET], rowCount: 2, warnings: [] }), mappingJson: null, rowCount: 2 },
    });
    tdId = td.id;
    const draft = await dataMapper.mapTestData({ sheets: [SHEET], scenarios: [] });
    await prisma.testDataSet.update({ where: { id: tdId }, data: { mappingJson: JSON.stringify(draft) } });
    console.log(`[setup] TestDataSet ${tdId.slice(0, 8)} · draft binds ${Object.keys((draft.bindings[0] || {}).columnToField || {}).join('+') || '(none)'}`);

    // ── 1) verifyMapping blocks an EXISTS error ──
    console.log('\n[1] verifyMapping — exists gate');
    const clean = tda.verifyMapping({ mapping: draft, sheets: [SHEET] });
    check('clean draft verifies ok', clean.ok === true, JSON.stringify(clean.findings));
    const bad = tda.verifyMapping({ mapping: { bindings: [{ sheet: 'P4aLogin', columnToField: { username: 'Nope' } }], unmapped: [] }, sheets: [SHEET] });
    check('a column not in the sheet → blocked (column_not_in_sheet error)', bad.ok === false && bad.findings.some((f) => f.code === 'column_not_in_sheet'), JSON.stringify(bad.findings));

    // ── 2) transactional approve → immutable v1 ──
    console.log('\n[2] approve → immutable v1');
    const v1 = await approveDraft({ tdId, projectId: project.id, draft, verification: clean, userId, note: null });
    check('v1 created, status approved', v1.version === 1 && v1.status === 'approved', `v=${v1.version} status=${v1.status}`);
    const v1mapping = JSON.parse(v1.mappingJson);
    check('sensitivity defaulted (password→masked)', (v1mapping.bindings[0].sensitivity || {}).password === 'masked', JSON.stringify(v1mapping.bindings[0].sensitivity));
    const v1snapshot = v1.mappingJson;

    // ── 3) edit draft → draft_unapproved_changes (canonical diff) ──
    console.log('\n[3] edit draft → unapproved-changes state');
    const edited = { ...draft, bindings: [{ ...draft.bindings[0], note: 'tweaked' }] };
    await prisma.testDataSet.update({ where: { id: tdId }, data: { mappingJson: JSON.stringify(edited) } });
    const stateAfterEdit = tda.canonicalJson(edited) === tda.canonicalJson(v1mapping) ? 'approved' : 'draft_unapproved_changes';
    check('edited draft diverges from approved → draft_unapproved_changes', stateAfterEdit === 'draft_unapproved_changes', stateAfterEdit);

    // ── 4) re-approve → v2; v1 superseded + IMMUTABLE ──
    console.log('\n[4] re-approve → v2; v1 superseded + unchanged');
    const reVerify = tda.verifyMapping({ mapping: edited, sheets: [SHEET] });
    const v2 = await approveDraft({ tdId, projectId: project.id, draft: edited, verification: reVerify, userId, note: null });
    check('v2 created, status approved', v2.version === 2 && v2.status === 'approved', `v=${v2.version}`);
    const v1after = await prisma.testDataMapping.findUnique({ where: { id: v1.id } });
    check('v1 → superseded', v1after.status === 'superseded', v1after.status);
    check('v1.mappingJson UNCHANGED (immutable)', v1after.mappingJson === v1snapshot, 'v1 content changed!');

    // ── 5) A1 provenance pin ──
    console.log('\n[5] A1 — approved-only context + case pin');
    const ctx = await loadTestDataContext(project.id, null, { approvedOnly: true });
    const ourSource = (ctx && ctx.mapping && Array.isArray(ctx.mapping.sources)) ? ctx.mapping.sources.find((s) => s.testDataSetId === tdId) : null;
    check('loadTestDataContext({approvedOnly}) returns our consumed mapping', !!ourSource && ourSource.mappingId === v2.id && ourSource.version === 2, JSON.stringify(ourSource));
    const ourBinding = (ctx && ctx.mapping && Array.isArray(ctx.mapping.bindings)) ? ctx.mapping.bindings.find((b) => b.sheet === 'P4aLogin' && b.mappingId === v2.id) : null;
    check('approved bindings are stamped with the source mappingId/version', !!ourBinding && ourBinding.mappingVersion === 2, JSON.stringify(ourBinding));

    const gen = await prisma.scenarioGeneration.create({ data: { projectId: project.id, version: 999000, label: '_P4A_SMOKE', isCurrent: false } });
    genId = gen.id;
    const scn = await prisma.testScenario.create({ data: { projectId: project.id, generationId: genId, name: '_P4A pin', module: 'p4a', priority: 'high', category: 'functional', rationale: 'p4a smoke', source: 'agent' } });
    const persisted = await tcc.persistCases({
      prisma, projectId: project.id, scenarioId: scn.id, generationId: genId, moduleName: 'p4a',
      cases: [{ name: 'P4a pin case', type: 'positive', confidence: 90, assertions: 'User logs in with {{username}}', automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'must', provenance: 'BRD', payload: { expectedText: 'Dashboard' } }], steps: [{ order: 1, action: 'Type', element: 'Username', value: '{{username}}' }], dataBinding: { sheet: 'P4aLogin' } }],
      approvedTestData: ctx, log: { warn() {}, info() {} },
    });
    const pinned = JSON.parse(persisted[0].tc.dataBindingJson || '{}');
    check('persistCases PINS dataBindingJson to the approved mappingId/version (never latest)', pinned.mappingId === v2.id && pinned.mappingVersion === 2 && pinned.sheet === 'P4aLogin', JSON.stringify(pinned));

    // ── 6) placeholder resolution against the approved mapping ──
    console.log('\n[6] resolvePlaceholders against the approved mapping');
    const r = tda.resolvePlaceholders({
      cases: [
        { id: 'ok', steps: JSON.stringify([{ value: '{{username}}' }, { value: '{{password}}' }]), assertions: '{{expected}}', declaredAssertions: '[]' },
        { id: 'bad', steps: JSON.stringify([{ value: '{{ssn}}' }]), assertions: '', declaredAssertions: '[]' },
      ],
      approvedMapping: JSON.parse(v2.mappingJson),
    });
    check('{{username}}/{{password}}/{{expected}} resolve; {{ssn}} does not', r.ok === false && r.unresolved.length === 1 && r.unresolved[0].token === 'ssn', JSON.stringify(r.unresolved));

    const failed = results.filter((x) => !x.ok).length;
    console.log(`\n=== ${failed ? 'FAIL' : 'PASS'} — ${results.length - failed}/${results.length} checks passed ===\n`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    // cleanup — delete synthetic rows (cascades to mappings / scenarios / cases).
    if (genId) await prisma.scenarioGeneration.delete({ where: { id: genId } }).catch(() => {});
    if (tdId) await prisma.testDataSet.delete({ where: { id: tdId } }).catch(() => {});
    console.log('(cleaned up synthetic TestDataSet + generation)');
    await prisma.$disconnect();
  }
})().catch(async (e) => { console.error('\nP4a SMOKE FAILED:', e.message, '\n', e.stack); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
