const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const runId = '6069f97b-7f15-4745-ab8f-d90fa206b7cc'; // completed run at 8:46

  const results = await p.runResult.findMany({
    where: { runId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, testCaseId: true, status: true, error: true,
      mechanicalVerdictReason: true, agentClaimedVerdict: true, flipDirection: true,
      assertionCheckResults: true, chatHistory: true
    }
  });

  console.log('Results:', results.length);

  const counts = {};
  results.forEach(r => counts[r.status] = (counts[r.status]||0)+1);
  console.log('Counts:', JSON.stringify(counts));

  const flips = results.filter(r => r.flipDirection && r.flipDirection !== 'none');
  console.log('Flips:', flips.length);

  const fails = results.filter(r => r.status === 'fail');
  console.log('Fails:', fails.length);

  // Print ALL results summary
  console.log('\n--- ALL RESULTS ---');
  results.forEach(r => {
    const hasCh = r.chatHistory && (Array.isArray(r.chatHistory) ? r.chatHistory.length : JSON.parse(r.chatHistory||'[]').length);
    console.log(r.id.substring(0,8), '| TC:', r.testCaseId.substring(0,8), '| status:', r.status.padEnd(8), '| agent:', (r.agentClaimedVerdict||'null').padEnd(6), '| mech:', (r.mechanicalVerdictReason||'').substring(0,30).padEnd(30), '| flip:', (r.flipDirection||'').padEnd(12), '| chat:', hasCh||0);
  });

  // Full transcript of first fail case with chatHistory
  const failWithChat = results.find(r => r.status === 'fail' && r.chatHistory &&
    (Array.isArray(r.chatHistory) ? r.chatHistory.length > 0 : JSON.parse(r.chatHistory||'[]').length > 0));

  if (failWithChat) {
    console.log('\n\n=== FAIL case with chat:', failWithChat.id, '===');
    console.log('mech:', failWithChat.mechanicalVerdictReason);
    console.log('agent:', failWithChat.agentClaimedVerdict);

    const acr = failWithChat.assertionCheckResults ?
      (typeof failWithChat.assertionCheckResults === 'string' ? JSON.parse(failWithChat.assertionCheckResults) : failWithChat.assertionCheckResults) : [];
    console.log('\n-- Assertions (', acr.length, '):');
    acr.forEach(a => {
      console.log('  id:', a.assertionId?.substring(0,12), '| outcome:', a.outcome, '| crit:', a.criticality, '| reason:', a.reason, '| source:', a.source, '| type:', a.type);
      if (a.payload) console.log('    payload:', JSON.stringify(a.payload).substring(0,200));
    });

    const ch = Array.isArray(failWithChat.chatHistory) ? failWithChat.chatHistory : JSON.parse(failWithChat.chatHistory);
    console.log('\n-- Chat (' + ch.length + ' msgs):');
    ch.forEach((msg, i) => {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        msg.content.forEach(c => {
          if (c.type === 'text' && c.text) console.log('['+i+'] THINK:', c.text.substring(0,300));
          if (c.type === 'tool_use') console.log('['+i+'] CALL', c.name+':', JSON.stringify(c.input||{}).substring(0,250));
        });
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content.forEach(c => {
          if (c.type === 'tool_result') {
            const content = Array.isArray(c.content) ? c.content.map(x=>x.text||'').join('') : (c.content||'');
            console.log('['+i+'] RESULT:', content.substring(0,400));
          }
        });
      }
    });
  }

  // Full transcript of a flip case
  const flipWithChat = results.find(r => r.flipDirection && r.flipDirection !== 'none' && r.chatHistory &&
    (Array.isArray(r.chatHistory) ? r.chatHistory.length > 0 : JSON.parse(r.chatHistory||'[]').length > 0));

  if (flipWithChat) {
    console.log('\n\n=== FLIP case:', flipWithChat.id, '| flip:', flipWithChat.flipDirection, '===');
    console.log('agent:', flipWithChat.agentClaimedVerdict, '| status:', flipWithChat.status);

    const acr2 = flipWithChat.assertionCheckResults ?
      (typeof flipWithChat.assertionCheckResults === 'string' ? JSON.parse(flipWithChat.assertionCheckResults) : flipWithChat.assertionCheckResults) : [];
    console.log('\n-- Assertions:');
    acr2.forEach(a => {
      console.log('  id:', a.assertionId?.substring(0,12), '| outcome:', a.outcome, '| crit:', a.criticality, '| reason:', a.reason);
      if (a.payload) console.log('    payload:', JSON.stringify(a.payload).substring(0,200));
    });

    const ch2 = Array.isArray(flipWithChat.chatHistory) ? flipWithChat.chatHistory : JSON.parse(flipWithChat.chatHistory);
    console.log('\n-- Chat (' + ch2.length + ' msgs):');
    ch2.forEach((msg, i) => {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        msg.content.forEach(c => {
          if (c.type === 'text' && c.text) console.log('['+i+'] THINK:', c.text.substring(0,400));
          if (c.type === 'tool_use') console.log('['+i+'] CALL', c.name+':', JSON.stringify(c.input||{}).substring(0,250));
        });
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content.forEach(c => {
          if (c.type === 'tool_result') {
            const content = Array.isArray(c.content) ? c.content.map(x=>x.text||'').join('') : (c.content||'');
            console.log('['+i+'] RESULT:', content.substring(0,500));
          }
        });
      }
    });
  }
}

main().catch(console.error).finally(() => p.$disconnect());
