const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Find the most recent run
  const runs = await p.run.findMany({
    orderBy: { startedAt: 'desc' },
    take: 3,
    select: { id: true, status: true, startedAt: true, completedAt: true }
  });

  for (const run of runs) {
    console.log('\n====== RUN', run.id, '| status:', run.status, '| started:', run.startedAt);
  }

  // Use the most recent
  const runId = runs[0].id;

  // Get a failing/interesting result to read its full chatHistory
  const results = await p.runResult.findMany({
    where: { runId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, testCaseId: true, status: true, error: true,
      mechanicalVerdictReason: true, agentClaimedVerdict: true, flipDirection: true,
      assertionCheckResults: true, chatHistory: true
    }
  });

  // Print summary first
  console.log('\n--- SUMMARY ---');
  const counts = {};
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
  }
  console.log('Status counts:', JSON.stringify(counts));

  const flips = results.filter(r => r.flipDirection && r.flipDirection !== 'none');
  console.log('Flip cases:', flips.length);
  flips.forEach(f => console.log(' flip:', f.flipDirection, '| id:', f.id.substring(0,8), '| agent:', f.agentClaimedVerdict, '| status:', f.status));

  // Show the full chatHistory of one failing case
  const failCase = results.find(r => r.status === 'fail');
  if (failCase) {
    console.log('\n\n=== FULL TRANSCRIPT for FAIL case', failCase.id, '===');
    console.log('error:', failCase.error);
    console.log('mechanicalVerdictReason:', failCase.mechanicalVerdictReason);
    console.log('agentClaimedVerdict:', failCase.agentClaimedVerdict);

    const acr = failCase.assertionCheckResults ?
      (typeof failCase.assertionCheckResults === 'string' ? JSON.parse(failCase.assertionCheckResults) : failCase.assertionCheckResults) : [];
    console.log('\n-- Assertion checks:');
    acr.forEach(a => {
      console.log('  ', a.assertionId, '| outcome:', a.outcome, '| criticality:', a.criticality, '| reason:', a.reason, '| source:', a.source);
      if (a.type) console.log('    type:', a.type, '| payload:', JSON.stringify(a.payload || {}).substring(0, 150));
    });

    const ch = failCase.chatHistory ?
      (Array.isArray(failCase.chatHistory) ? failCase.chatHistory : JSON.parse(failCase.chatHistory)) : [];
    console.log('\n-- Chat transcript (' + ch.length + ' messages):');
    ch.forEach((msg, i) => {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        msg.content.forEach(c => {
          if (c.type === 'text' && c.text) {
            console.log('['+i+'] assistant TEXT:', c.text.substring(0, 200));
          }
          if (c.type === 'tool_use') {
            console.log('['+i+'] assistant CALL', c.name, ':', JSON.stringify(c.input || {}).substring(0, 200));
          }
        });
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content.forEach(c => {
          if (c.type === 'tool_result') {
            const content = Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : (c.content || '');
            console.log('['+i+'] tool_result for', c.tool_use_id?.substring(0,8), ':', content.substring(0, 300));
          }
        });
      }
    });
  }

  // Show the flip case chatHistory
  if (flips.length > 0) {
    const flipCase = results.find(r => r.flipDirection && r.flipDirection !== 'none');
    console.log('\n\n=== FLIP case', flipCase.id, '| flip:', flipCase.flipDirection, '===');
    console.log('error:', flipCase.error);
    console.log('agent:', flipCase.agentClaimedVerdict, '| status:', flipCase.status);

    const acr2 = flipCase.assertionCheckResults ?
      (typeof flipCase.assertionCheckResults === 'string' ? JSON.parse(flipCase.assertionCheckResults) : flipCase.assertionCheckResults) : [];
    console.log('\n-- Assertion checks:');
    acr2.forEach(a => {
      console.log('  ', a.assertionId, '| outcome:', a.outcome, '| criticality:', a.criticality, '| reason:', a.reason, '| type:', a.type);
      if (a.payload) console.log('    payload:', JSON.stringify(a.payload).substring(0, 200));
    });

    const ch2 = flipCase.chatHistory ?
      (Array.isArray(flipCase.chatHistory) ? flipCase.chatHistory : JSON.parse(flipCase.chatHistory)) : [];
    console.log('\n-- Chat transcript (' + ch2.length + ' messages):');
    ch2.forEach((msg, i) => {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        msg.content.forEach(c => {
          if (c.type === 'text' && c.text) {
            console.log('['+i+'] assistant TEXT:', c.text.substring(0, 300));
          }
          if (c.type === 'tool_use') {
            console.log('['+i+'] assistant CALL', c.name, ':', JSON.stringify(c.input || {}).substring(0, 250));
          }
        });
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content.forEach(c => {
          if (c.type === 'tool_result') {
            const content = Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : (c.content || '');
            console.log('['+i+'] tool_result:', content.substring(0, 400));
          }
        });
      }
    });
  }
}

main().catch(console.error).finally(() => p.$disconnect());
