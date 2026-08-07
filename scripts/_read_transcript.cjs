const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Get the most recent run
  const recent = await p.run.findFirst({ orderBy: { startedAt: 'desc' }, select: { id: true, status: true, startedAt: true } });
  if (!recent) { console.log('no runs'); return; }
  console.log('Most recent run:', recent.id, 'status:', recent.status, 'at:', recent.startedAt);

  // Get all results for that run
  const results = await p.runResult.findMany({
    where: { runId: recent.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, testCaseId: true, status: true, error: true, mechanicalVerdictReason: true, agentClaimedVerdict: true, chatHistory: true, assertionCheckResults: true }
  });
  console.log('Results count:', results.length);

  for (const r of results) {
    console.log('\n=== Result', r.id.substring(0,8), '| TC:', r.testCaseId.substring(0,8), '| status:', r.status, '| agent:', r.agentClaimedVerdict, '| mech:', r.mechanicalVerdictReason);
    if (r.error) console.log('  error:', r.error.substring(0, 150));

    const ch = r.chatHistory ? (Array.isArray(r.chatHistory) ? r.chatHistory : JSON.parse(r.chatHistory)) : null;
    if (ch && Array.isArray(ch)) {
      console.log('  chat turns:', ch.length);
      // Print tool_use calls (what the agent did)
      ch.forEach((msg, i) => {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          msg.content.filter(c => c.type === 'tool_use').forEach(tu => {
            const inp = JSON.stringify(tu.input || {}).substring(0, 120);
            console.log('  [turn ' + i + '] CALL ' + tu.name + ': ' + inp);
          });
        }
      });
    }

    const acr = r.assertionCheckResults ? (typeof r.assertionCheckResults === 'string' ? JSON.parse(r.assertionCheckResults) : r.assertionCheckResults) : null;
    if (acr && Array.isArray(acr)) {
      console.log('  assertion checks:', acr.length);
      acr.forEach(a => {
        console.log('    assertionId:', a.assertionId, '| outcome:', a.outcome, '| reason:', a.reason);
      });
    }
  }
}

main().catch(console.error).finally(() => p.$disconnect());
