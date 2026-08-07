// Read-only audit of a whole GENERATION's authoring + grounding quality.
// For each case: S#·C# label, automatability, step count, and every declared
// assertion with its type / criticality / provenance / grounding verdict
// (parseFailed + reason) / targetUrl. Then a roll-up: how many TEXT assertions
// got demoted by the gate, how the criticality tiers landed, and whether any
// `must` slipped through demotion (the masking guard must hold).
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { buildCaseNumbering } = require('../server/lib/caseNumbering');
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const GEN = process.argv[2] || 'bd055b74-c9de-448b-b2b4-4f88927f1b9a';

const J = (s, d = []) => { try { return JSON.parse(s || JSON.stringify(d)); } catch { return d; } };
const crit = (c) => String(c || 'must').toLowerCase();
const payloadOf = (d) => d.expectedText || d.expectedUrlPattern || d.expectedRole || d.payload || d.value || (d.indicators ? `[${d.indicators.length} indicators]` : '');

(async () => {
  try {
    const scns = await prisma.testScenario.findMany({
      where: { projectId: PROJECT, generationId: GEN },
      include: { cases: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!scns.length) { console.log(`No scenarios for generation ${GEN}`); return; }
    const num = buildCaseNumbering(scns);

    const roll = { cases: 0, assertions: 0, byType: {}, byCrit: {}, byProv: {}, demoted: 0, demotedMust: 0, withTarget: 0, textTotal: 0, textGrounded: 0 };

    for (const s of scns) {
      const sLabel = num.scenarioLabelById.get(s.id) || '?';
      console.log(`\n══════════ ${sLabel}  ${s.title || s.name} ══════════`);
      const ordered = [...s.cases].sort((a, b) => {
        const la = num.caseLabelById.get(a.id) || '', lb = num.caseLabelById.get(b.id) || '';
        return la.localeCompare(lb, undefined, { numeric: true });
      });
      for (const tc of ordered) {
        const label = num.caseLabelById.get(tc.id) || '?';
        const steps = J(tc.steps);
        const decl = J(tc.declaredAssertions);
        roll.cases++;
        console.log(`\n  ${label}  "${tc.name}"   [${tc.automatability || 'automatable'}]  · ${steps.length} steps · ${decl.length} assertions`);
        decl.forEach((d) => {
          roll.assertions++;
          const c = crit(d.criticality);
          const prov = String(d.provenance || 'inferred').toLowerCase();
          const t = String(d.type || '?');
          roll.byType[t] = (roll.byType[t] || 0) + 1;
          roll.byCrit[c] = (roll.byCrit[c] || 0) + 1;
          roll.byProv[prov] = (roll.byProv[prov] || 0) + 1;
          if (d.targetUrl) roll.withTarget++;
          const isText = /text/i.test(t);
          if (isText) { roll.textTotal++; if (!d.parseFailed) roll.textGrounded++; }
          if (d.parseFailed) { roll.demoted++; if (c === 'must') roll.demotedMust++; }
          const flag = d.parseFailed ? ` ✂DEMOTED(${d.parseFailedReason || '?'})` : '';
          const tgt = d.targetUrl ? `  @${d.targetUrl}` : '';
          console.log(`       - [${c}/${prov}] ${t}: ${JSON.stringify(String(payloadOf(d)).slice(0, 70))}${tgt}${flag}`);
        });
      }
    }

    console.log(`\n\n════════════ ROLL-UP (generation ${GEN.slice(0, 8)}) ════════════`);
    console.log(`cases=${roll.cases}  assertions=${roll.assertions}  with targetUrl=${roll.withTarget}`);
    console.log(`by type:        ${JSON.stringify(roll.byType)}`);
    console.log(`by criticality: ${JSON.stringify(roll.byCrit)}`);
    console.log(`by provenance:  ${JSON.stringify(roll.byProv)}`);
    console.log(`TEXT assertions: ${roll.textTotal} total · ${roll.textGrounded} grounded · ${roll.textTotal - roll.textGrounded} ungrounded`);
    console.log(`gate demotions (parseFailed): ${roll.demoted}   ← excluded from verdict math`);
    console.log(`MASKING-GUARD CHECK — must-tier assertions demoted: ${roll.demotedMust}  ${roll.demotedMust === 0 ? '✓ (guard holds)' : '✗✗ MUST WAS DEMOTED — BUG'}`);
  } catch (e) { console.error('ERR', e.message, e.stack); } finally { await prisma.$disconnect(); process.exit(0); }
})();
