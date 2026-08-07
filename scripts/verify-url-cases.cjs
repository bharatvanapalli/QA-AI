'use strict';
/**
 * Loads Case B and Case C from the DB, prints declared URL assertions,
 * assertionCheckResults outcomes, and replays each against the new matchUrlPattern.
 *
 * For each URL assertion the script reports:
 *   - what pattern the architect declared
 *   - what currentUrl/visitedUrls were captured at run time
 *   - what the OLD matcher returned (re-derived from the stored assertionCheckResults[])
 *   - what the NEW matcher would say (live call)
 *
 * If new ≠ old AND new === matched, this case would be rescued by the fix.
 */

const { PrismaClient } = require('@prisma/client');
const { matchUrlPattern } = require('../server/services/mcp');

const TARGETS = [
  'Accessing /inventory.html after logout redirects to login',
  'Unauthenticated direct access to protected routes redirects to login',
];

(async () => {
  const p = new PrismaClient();

  for (const name of TARGETS) {
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('CASE:', name);
    console.log('══════════════════════════════════════════════════════════════');

    const tc = await p.testCase.findFirst({
      where: { name: { contains: name } },
      select: { id: true, name: true, declaredAssertions: true },
    });
    if (!tc) { console.log('  not found'); continue; }

    const decls = JSON.parse(tc.declaredAssertions || '[]');
    const urlDecls = decls.filter((d) => d.type === 'URL');
    console.log(`  declared URL assertions: ${urlDecls.length}`);
    for (const d of urlDecls) {
      console.log(`    ${d.id}  pattern=${JSON.stringify(d.payload.expectedUrlPattern)}  targetUrl=${JSON.stringify(d.targetUrl)}`);
    }

    // Find the most recent RunResult for this TC
    const rr = await p.runResult.findFirst({
      where: { testCaseId: tc.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, assertionCheckResults: true, trace: true, createdAt: true },
    });
    if (!rr) { console.log('  no RunResult'); continue; }
    console.log(`  RunResult: status=${rr.status}  createdAt=${rr.createdAt.toISOString()}`);

    let assertionCheckResults = [];
    try { assertionCheckResults = JSON.parse(rr.assertionCheckResults || '[]'); } catch (_) {}

    for (const d of urlDecls) {
      const rec = assertionCheckResults.find((r) => r.assertionId === d.id);
      console.log(`\n  ── ${d.id} ───────────────────────────────────────`);
      console.log(`     declared pattern: ${JSON.stringify(d.payload.expectedUrlPattern)}`);
      console.log(`     declared target : ${JSON.stringify(d.targetUrl)}`);
      if (!rec) {
        console.log('     RECORDED: (none — assertion never received an outcome)');
        continue;
      }
      console.log(`     assertionCheckResults outcome: ${rec.outcome}  reason=${rec.reason || ''}`);
      console.log(`     evidence: ${JSON.stringify(rec.evidence || '').slice(0, 220)}`);

      // Try to extract the URL the matcher saw, from the evidence string.
      const m = (rec.evidence || '').match(/current URL "([^"]+)"/);
      const evidenceUrl = m ? m[1] : null;
      if (evidenceUrl) {
        const replay = matchUrlPattern(d.payload.expectedUrlPattern, evidenceUrl);
        console.log(`     replay against captured currentUrl="${evidenceUrl}":`);
        console.log(`       NEW matcher: matched=${replay.matched} stage=${replay.stage}`);
      } else {
        console.log('     (no currentUrl in evidence string)');
      }

      // Also try the targetUrl as the URL — if pattern matches the
      // declared targetUrl literally, that proves the pattern is shaped
      // correctly even if the agent didn't navigate there at the right
      // moment.
      if (d.targetUrl) {
        const target = d.targetUrl.startsWith('http') ? d.targetUrl : 'https://www.saucedemo.com' + d.targetUrl;
        const r = matchUrlPattern(d.payload.expectedUrlPattern, target);
        console.log(`     against targetUrl ("${target}"): matched=${r.matched} stage=${r.stage}`);
      }
    }
  }

  await p.$disconnect();
})();
