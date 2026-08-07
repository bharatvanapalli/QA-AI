// DRY-RUN proof (no DB writes, no credits): take the assertions the Architect
// already produced for the PIM generation — persisted in their BROKEN form —
// and re-run them through the NOW-FIXED contract layer to show what the verdict
// pipeline would see after the fix. The original PAGE payloads survive inside
// the double-wrapped record.payload; FORBIDDEN_TEXT records kept their intact
// unexpectedText. So we can reconstruct the Architect's real output and validate.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { buildCaseNumbering } = require('../server/lib/caseNumbering');
const { validateRecord } = require('../server/lib/declaredAssertions');
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const GEN = process.argv[2] || 'bd055b74-c9de-448b-b2b4-4f88927f1b9a';
const J = (s, d = []) => { try { return JSON.parse(s || JSON.stringify(d)); } catch { return d; } };

// Reconstruct the Architect's raw assertion from a persisted (possibly broken)
// normalized record, then validate it through the fixed validateRecord.
function recover(rec) {
  // unknown_type:* → the original raw assertion was stuffed verbatim into .payload
  if (rec.parseFailed && /^unknown_type:/.test(rec.parseIssue || '') && rec.payload && rec.payload.type) {
    return validateRecord(rec.payload);
  }
  // missing_required_payload_field / text_ungrounded → the record itself is the
  // raw; strip the demotion flags and re-validate against the fixed contract.
  const clean = { ...rec };
  delete clean.parseFailed; delete clean.parseFailedReason; delete clean.parseIssue;
  return validateRecord(clean);
}

(async () => {
  try {
    const scns = await prisma.testScenario.findMany({ where: { projectId: PROJECT, generationId: GEN }, include: { cases: true }, orderBy: { createdAt: 'asc' } });
    const num = buildCaseNumbering(scns);
    const before = { must: 0, mustParseFailed: 0, page: 0, pageParseFailed: 0, forbidden: 0, forbiddenParseFailed: 0 };
    const after  = { must: 0, mustParseFailed: 0, page: 0, pageParseFailed: 0, forbidden: 0, forbiddenParseFailed: 0, stillBad: [] };
    let casesNeedsHumanBefore = 0, casesProvableAfter = 0;

    for (const s of scns) {
      const sLabel = num.scenarioLabelById.get(s.id) || '?';
      for (const tc of s.cases) {
        const label = num.caseLabelById.get(tc.id) || '?';
        const decl = J(tc.declaredAssertions);
        let validMustAfter = 0, validMustBefore = 0;
        const lines = [];
        for (const d of decl) {
          // realType: read through the double-wrap if present
          const realType = (d.parseFailed && d.payload && d.payload.type) ? d.payload.type : d.type;
          const realCrit = (d.parseFailed && d.payload && d.payload.criticality) ? d.payload.criticality : d.criticality;
          const cBefore = String(d.criticality || 'must').toLowerCase();
          // BEFORE
          if (realType === 'PAGE') { before.page++; if (d.parseFailed) before.pageParseFailed++; }
          if (realType === 'FORBIDDEN_TEXT') { before.forbidden++; if (d.parseFailed) before.forbiddenParseFailed++; }
          if (cBefore === 'must') { before.must++; if (d.parseFailed) before.mustParseFailed++; else validMustBefore++; }
          // AFTER (recovered)
          const rec = recover(d);
          const okAfter = rec.ok && !rec.normalized.parseFailed;
          const tAfter = rec.ok ? rec.normalized.type : realType;
          const cAfter = String((rec.ok ? rec.normalized.criticality : realCrit) || 'must').toLowerCase();
          if (tAfter === 'PAGE') { after.page++; if (!okAfter) after.pageParseFailed++; }
          if (tAfter === 'FORBIDDEN_TEXT') { after.forbidden++; if (!okAfter) after.forbiddenParseFailed++; }
          if (cAfter === 'must') { after.must++; if (!okAfter) after.mustParseFailed++; else validMustAfter++; }
          if (!okAfter && !/text_ungrounded/.test(d.parseFailedReason || '')) after.stillBad.push(`${label} ${tAfter}: ${rec.issue || 'still parseFailed'}`);
          const change = (d.parseFailed && okAfter) ? '  ✅ RECOVERED' : (d.parseFailed ? '  (still demoted)' : '');
          lines.push(`     [${cAfter}] ${tAfter}${change}`);
        }
        // would this case route to needs_human(no_assertions_declared) for lack of any valid must/any?
        if (validMustBefore === 0) casesNeedsHumanBefore++;
        if (validMustAfter > 0) casesProvableAfter++;
        if (validMustBefore === 0 && validMustAfter > 0) {
          console.log(`${label} "${tc.name.slice(0,54)}"  — was UNPROVABLE (0 valid must) → now ${validMustAfter} valid must`);
          lines.forEach((l) => console.log(l));
        }
      }
    }

    console.log(`\n════════════ BEFORE → AFTER (fixed contract, recovered from real authored data) ════════════`);
    console.log(`PAGE assertions:        ${before.page} total · ${before.pageParseFailed} discarded  →  ${after.page} total · ${after.pageParseFailed} discarded`);
    console.log(`FORBIDDEN_TEXT:         ${before.forbidden} total · ${before.forbiddenParseFailed} discarded  →  ${after.forbidden} total · ${after.forbiddenParseFailed} discarded`);
    console.log(`MUST-tier assertions:   ${before.must} total · ${before.mustParseFailed} excluded  →  ${after.must} total · ${after.mustParseFailed} excluded`);
    console.log(`Cases with 0 valid must (→ needs_human): ${casesNeedsHumanBefore}  →  cases now provable (≥1 valid must): ${casesProvableAfter}`);
    if (after.stillBad.length) { console.log(`\nstill-bad (non-grounding) after fix:`); after.stillBad.forEach((x) => console.log(`  ✗ ${x}`)); }
    else console.log(`\n✓ no residual structural parseFailures (remaining demotions are intentional text_ungrounded soft-tier only)`);
  } catch (e) { console.error('ERR', e.message, e.stack); } finally { await prisma.$disconnect(); process.exit(0); }
})();
